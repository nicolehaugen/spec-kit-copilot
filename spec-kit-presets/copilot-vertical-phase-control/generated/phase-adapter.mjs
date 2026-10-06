export const controlId = "workflow-phases";
export const contractVersion = 1;
export const requiredCapabilities = ["workflow.rows.v1", "workflow.managed-run.v1"];

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

const style = `<style>
.vertical-phase-intro { margin: 0 0 .75rem; color: var(--text-color-muted); }
.vertical-phase-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: .75rem; margin-bottom: 1rem; }
.vertical-phase-list { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--border-color-default); }
.vertical-phase-row { display: flex; align-items: center; gap: .75rem; padding: .85rem 0; border-bottom: 1px solid var(--border-color-default); }
.vertical-phase-summary { flex: 1 1 18rem; min-width: 0; }
.vertical-phase-select { display: block; width: 100%; text-align: left; padding: 0; border: 0; color: var(--text-color-default); background: transparent; font-weight: 600; cursor: pointer; }
.vertical-phase-select[aria-current="step"] { color: var(--accent-color); }
.vertical-phase-status { display: block; color: var(--text-color-muted); font-size: 12px; }
.vertical-phase-status[data-status="Completed"] { color: var(--success-color); }
.vertical-phase-status[data-status="Failed"], .vertical-phase-status[data-status="Blocked"] { color: var(--danger-color); }
.vertical-phase-actions { display: flex; flex-wrap: wrap; gap: .4rem; }
.vertical-phase-detail { margin-top: 1rem; }
@media (max-width: 640px) {
    .vertical-phase-row { flex-wrap: wrap; }
    .vertical-phase-actions { width: 100%; }
}
</style>`;

function validState(state) {
    return state && Array.isArray(state.phases) && Number.isInteger(state.current)
        && state.current >= -1 && state.current < state.phases.length
        && typeof state.workflow === "string"
        && (state.status == null || typeof state.status === "object")
        && typeof state.draft === "string"
        && (state.output === null || typeof state.output === "string")
        && Array.isArray(state.outputLinks)
        && state.outputLinks.every((link) => link && typeof link.template === "string"
            && typeof link.label === "string")
        && typeof state.sending === "boolean"
        && (state.runLabel == null || typeof state.runLabel === "string");
}

function render(state, definition) {
    const { phases, current } = state;
    const phase = phases[current];
    const status = state.status?.status ?? "Not run";
    const output = state.output;
    const available = output && output === state.status?.output
        && state.status?.artifactAvailability === "available";
    const autopilot = state.autopilot;
    return `${style}<nav class="phase-navigation vertical-phase-navigation" aria-label="Workflow phases">
        <p class="vertical-phase-intro">Review the workflow plan first. Each step produces its declared artifacts.
            Autopilot starts at the first step and stops at a blocker.</p>
        <div class="vertical-phase-toolbar">
            <button class="btn btn-primary" type="button" data-action="autopilot"
                ${!phases.length || ["Request sent", "Running", "Finishing"].includes(autopilot?.status) ? "disabled" : ""}>Autopilot</button>
            ${["Request sent", "Running", "Finishing", "Blocked"].includes(autopilot?.status)
                ? '<button class="btn btn-secondary" type="button" data-action="stop">Stop</button>' : ""}
            <span class="muted" role="status" aria-live="polite">${escapeHtml(autopilot?.message ?? "")}</span>
        </div>
        <ol class="vertical-phase-list">${phases.map((item, index) => {
            const result = state.statuses?.[item.id];
            const itemStatus = autopilot?.current === index && autopilot.status === "Running"
                ? "Running" : result?.status ?? "Not run";
            const ready = result?.artifactAvailability === "available";
            const label = Object.hasOwn(definition.viewLabels, item.id) ? definition.viewLabels[item.id]
                : item.id.replace(/^speckit\./, "").endsWith("plan") ? "View Plan" : "View artifact";
            return `<li class="vertical-phase-row">
                <div class="vertical-phase-summary">
                    <button class="vertical-phase-select" type="button" data-phase-index="${index}"
                        ${index === current ? 'aria-current="step"' : ""}
                        aria-label="Step ${index}: ${escapeHtml(item.label)}">Step ${index} · ${escapeHtml(item.label)}
                        ${item.output ? `→ ${escapeHtml(item.output)}` : ""}</button>
                    <span class="vertical-phase-status" data-status="${escapeHtml(itemStatus)}">${escapeHtml(itemStatus === "Completed" ? "done" : itemStatus === "Not run" ? "pending" : itemStatus.toLowerCase())}</span>
                    ${result?.error ? `<span class="workflow-error" role="alert">${escapeHtml(result.error)}</span>` : ""}
                </div>
                <div class="vertical-phase-actions">
                    <button class="btn btn-secondary" type="button" data-action="view-row" data-index="${index}"
                        ${ready ? "" : `disabled title="No verified artifact is available yet"`}>${label}</button>
                    <button class="btn btn-primary" type="button" data-action="start" data-index="${index}">Start Step ${index}</button>
                </div>
            </li>`;
        }).join("")}</ol>
    </nav>
    <section class="phase-card vertical-phase-detail" aria-label="Selected phase">${phase ? `
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
        ${state.outputLinks.length ? `<div class="phase-output-list" aria-label="Phase outputs">
            <strong>Outputs</strong>${state.outputLinks.map(({ template, label }) =>
                `<button class="phase-artifact-link" type="button" data-action="output"
                    data-output="${escapeHtml(template)}">${escapeHtml(label)}</button>`).join("")}
        </div>` : ""}
        <label class="field"><span class="field-label">Phase input</span>
            <textarea class="phase-input-control" data-phase-draft placeholder="Add details or direction for this phase."
                aria-label="Phase input">${escapeHtml(state.draft)}</textarea>
        </label>
        <div class="muted${state.status?.error ? " workflow-error" : ""}" role="status">${escapeHtml(state.status?.error)}</div>
        <footer class="phase-actions phase-actions-nav">
            <div class="phase-actions-left"><button class="btn btn-secondary" data-action="previous" type="button"
                ${current === 0 ? "disabled" : ""}>&#9664; Back</button></div>
            <div class="phase-actions-right"><button class="btn btn-secondary" data-action="next" type="button"
                ${current === phases.length - 1 ? "disabled" : ""}>Continue &#9654;</button></div>
        </footer>` : '<div class="workflow-empty">No workflow phases are configured.</div>'}</section>`;
}

export function mount({ root, definition, state, actions }) {
    if (!root || typeof root.replaceChildren !== "function" || !validState(state)
        || definition?.id !== controlId || !definition.viewLabels
        || typeof definition.viewLabels !== "object" || Array.isArray(definition.viewLabels)
        || !actions || ["select", "draft", "runAt", "viewAt", "reveal", "startManagedRun", "stopManagedRun", "error"]
            .some((key) => typeof actions[key] !== "function")) throw new Error("Invalid vertical phase control context");
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
        else if (action === "start") invoke(async () => {
            if (["Request sent", "Running", "Finishing"].includes(state.autopilot?.status)) {
                if (!root.ownerDocument.defaultView.confirm(
                    "Autopilot is running. Stop it before starting this step manually?")) return;
                await actions.stopManagedRun();
            }
            const index = Number(button.dataset.index);
            if (typeof actions.confirmRun === "function"
                && await actions.confirmRun(state.phases[index]) !== true) return;
            await actions.runAt(index);
        });
        else if (action === "view-row") invoke(() => actions.viewAt(Number(button.dataset.index)));
        else if (action === "output") invoke(() => actions.viewAt(state.current, button.dataset.output));
        else if (action === "autopilot") invoke(() => {
            if (state.autopilot?.status === "Blocked"
                && !root.ownerDocument.defaultView.confirm(
                    "The previous Autopilot outcome is unconfirmed. Check chat and artifacts before resuming. Resume?")) return;
            return actions.startManagedRun();
        });
        else if (action === "stop") invoke(() => actions.stopManagedRun());
        else if (action === "reveal") invoke(() => actions.reveal());
    };
    const onInput = (event) => {
        if (event.target.matches("[data-phase-draft]")) invoke(() => actions.draft(event.target.value));
    };
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    const update = (nextState) => {
        if (disposed) return;
        if (!validState(nextState)) throw new Error("Invalid vertical phase control state");
        state = nextState;
        const focused = root.contains(root.ownerDocument.activeElement) ? root.ownerDocument.activeElement : null;
        const selector = focused?.hasAttribute("data-phase-draft") ? "[data-phase-draft]"
            : focused?.hasAttribute("data-phase-index") ? `[data-phase-index="${focused.dataset.phaseIndex}"]`
                : focused?.dataset.action ? `[data-action="${focused.dataset.action}"]${focused.dataset.index === undefined
                    ? "" : `[data-index="${focused.dataset.index}"]`}` : null;
        const cursor = focused?.hasAttribute("data-phase-draft")
            ? [focused.selectionStart, focused.selectionEnd] : null;
        root.innerHTML = render(state, definition);
        if (selector) {
            const replacement = root.querySelector(selector);
            replacement?.focus({ preventScroll: true });
            if (cursor && replacement) replacement.setSelectionRange(...cursor);
        }
    };
    update(state);
    return { update, dispose() {
        if (disposed) return;
        disposed = true;
        root.removeEventListener("click", onClick);
        root.removeEventListener("input", onInput);
        root.replaceChildren();
    } };
}
