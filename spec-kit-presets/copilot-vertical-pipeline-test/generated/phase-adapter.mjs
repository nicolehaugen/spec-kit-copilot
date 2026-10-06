export const controlId = "workflow-phases";
export const contractVersion = 1;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function validState(state) {
    return state && Array.isArray(state.phases) && Number.isInteger(state.current)
        && state.current >= -1 && state.current < state.phases.length
        && typeof state.workflow === "string"
        && (state.status == null || typeof state.status === "object")
        && typeof state.draft === "string"
        && (state.output === null || typeof state.output === "string")
        && Array.isArray(state.outputLinks) && typeof state.sending === "boolean"
        && (state.runLabel == null || typeof state.runLabel === "string");
}

function render(state) {
    const phases = state.phases ?? [];
    const current = Math.max(-1, Math.min(phases.length - 1, state.current ?? -1));
    const phase = phases[current];
    const status = state.status?.status ?? "Not run";
    const output = state.output;
    const available = output && output === state.status?.output
        && state.status?.artifactAvailability === "available";
    return `<nav class="phase-navigation vertical-phase-navigation" aria-label="Workflow phases">
        ${phases.length ? `<div class="phase-mobile-nav"><label class="visually-hidden" for="mobile-phase-select">Jump to phase</label>
            <select id="mobile-phase-select" class="phase-input-control">${phases.map((item, index) =>
                `<option value="${index}" ${index === current ? "selected" : ""}>Phase ${index + 1} of ${phases.length}: ${escapeHtml(item.label)}</option>`).join("")}</select>
            <span id="mobile-next-phase" class="muted">${current + 1} of ${phases.length}</span></div>` : ""}
        <ol class="vertical-phase-list" style="display:grid;gap:.5rem;list-style:none;padding:0;margin:0">
            ${phases.map((item, index) => {
                return `<li><button class="step${index === current ? " active" : ""}" type="button"
                    style="width:100%;text-align:left;padding:.75rem 1rem;border:1px solid var(--border-color-default);border-radius:.5rem"
                    data-phase-index="${index}" ${index === current ? 'aria-current="step"' : ""}
                    aria-label="Phase ${index + 1} of ${phases.length}: ${escapeHtml(item.label)}">
                    <span class="step-order" aria-hidden="true">${index + 1}</span>
                    <span class="step-label"><span class="step-name">${escapeHtml(item.label)}</span></span>
                </button></li>`;
            }).join("")}</ol>
    </nav>
    <section class="phase-card" aria-label="Selected phase">${phase ? `
        <header class="workflow-header"><div class="workflow-header-main">
            <div class="phase-heading"><h2>${escapeHtml(phase.label)}</h2><span class="phase-notice">${escapeHtml(status)}</span></div>
            <p class="tagline">${escapeHtml(phase.id.startsWith("speckit.") ? phase.id : `speckit.${phase.id}`)}</p>
        </div></header>
        <dl class="phase-facts"><dt>View target</dt><dd><button class="phase-artifact-link" data-action="reveal" type="button"
            title="Open the viewer target's folder" ${!output || output.includes("<slug>") ? "disabled" : ""}><code>${escapeHtml(output || "No declared output")}</code></button></dd></dl>
        <p class="muted" role="status">${escapeHtml(state.status?.artifactError ??
            (available ? "" : output
                ? `${output} is not available yet. Run the phase, then refresh to check again.`
                : "No artifact is available for this phase yet. Run the phase, then refresh to check again."))}</p>
        ${state.outputLinks.length ? `<div class="phase-output-list" aria-label="Phase outputs"><strong>Outputs</strong>
            ${state.outputLinks.map(({ template, label }) => `<button class="phase-artifact-link" type="button"
                data-action="output" data-output="${escapeHtml(template)}">${escapeHtml(label)}</button>`).join("")}</div>` : ""}
        <label class="field"><span class="field-label">Phase input</span>
            <textarea class="phase-input-control" data-phase-draft placeholder="Add details or direction for this phase."
                aria-label="Phase input">${escapeHtml(state.draft)}</textarea>
        </label>
        <div class="muted${state.status?.error ? " workflow-error" : ""}" role="status">${escapeHtml(state.status?.error)}</div>
        <footer class="phase-actions phase-actions-nav">
            <div class="phase-actions-left"><button class="btn btn-secondary" data-action="previous" type="button"
                ${current === 0 ? "disabled" : ""}>&#9664; Back</button></div>
            <div class="phase-actions-center"><button class="btn btn-primary"
                data-action="run" type="button">${escapeHtml(state.runLabel
                    ?? (status === "Not run" ? "Run phase" : "Run again"))}</button>
                <button class="btn btn-secondary" data-action="view" type="button"
                    ${available ? "" : "hidden"}>View artifact</button></div>
            <div class="phase-actions-right"><button class="btn btn-secondary" data-action="next" type="button"
                ${current === phases.length - 1 ? "disabled" : ""}>Continue &#9654;</button></div>
        </footer>` : '<div class="workflow-empty">No workflow phases are configured.</div>'}</section>`;
}

export function mount({ root, state, actions }) {
    if (!root || typeof root.replaceChildren !== "function" || !validState(state)
        || !actions || ["select", "draft", "run", "view", "reveal", "error"].some((key) =>
            typeof actions[key] !== "function")) throw new Error("Invalid vertical phase control context");
    let disposed = false;
    const invoke = (callback) => {
        try { Promise.resolve(callback()).catch(actions.error); }
        catch (error) { actions.error(error); }
    };
    const onClick = (event) => {
        const button = event.target.closest("button");
        if (!button || !root.contains(button) || button.disabled) return;
        const action = button.dataset.action;
        if (button.hasAttribute("data-phase-index")) invoke(() => actions.select(Number(button.dataset.phaseIndex)));
        else if (action === "previous") invoke(() => actions.select(state.current - 1));
        else if (action === "next") invoke(() => actions.select(state.current + 1));
        else if (action === "run") invoke(() => actions.run(root.querySelector("[data-phase-draft]").value));
        else if (action === "view") invoke(() => actions.view());
        else if (action === "output") invoke(() => actions.view(button.dataset.output));
        else if (action === "reveal") invoke(() => actions.reveal());
    };
    const onChange = (event) => {
        if (event.target.id === "mobile-phase-select")
            invoke(() => actions.select(Number(event.target.value)));
    };
    const onInput = (event) => {
        if (event.target.matches("[data-phase-draft]")) invoke(() => actions.draft(event.target.value));
    };
    root.addEventListener("click", onClick);
    root.addEventListener("change", onChange);
    root.addEventListener("input", onInput);
    const update = (nextState) => {
        if (disposed) return;
        if (!validState(nextState))
            throw new Error("Invalid vertical phase control state");
        state = nextState;
        const active = root.ownerDocument.activeElement;
        const focused = root.contains(active) ? active : null;
        const focusSelector = focused?.hasAttribute("data-phase-draft") ? "[data-phase-draft]"
            : focused?.hasAttribute("data-phase-index")
                ? `[data-phase-index="${focused.dataset.phaseIndex}"]`
                : focused?.dataset.action ? `[data-action="${focused.dataset.action}"]`
                    : focused?.id === "mobile-phase-select" ? "#mobile-phase-select" : null;
        const cursor = focused?.hasAttribute("data-phase-draft")
            ? [focused.selectionStart, focused.selectionEnd] : null;
        root.innerHTML = render(state);
        if (focusSelector) {
            const replacement = root.querySelector(focusSelector);
            replacement?.focus({ preventScroll: true });
            if (cursor && replacement) replacement.setSelectionRange(...cursor);
        }
    };
    update(state);
    return { update, dispose() {
        if (disposed) return;
        disposed = true;
        root.removeEventListener("click", onClick);
        root.removeEventListener("change", onChange);
        root.removeEventListener("input", onInput);
        root.replaceChildren();
    } };
}
