const escapeHtml = (value) => String(value).replace(/[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

export const controlId = "workflow-phases";
export const contractVersion = 1;

function card(phase) {
    return `<header class="workflow-header">
        <div class="workflow-header-main"><div class="phase-heading"><h2>${escapeHtml(phase.label)}</h2><span class="phase-notice">Not run</span></div>
        <p class="tagline">${escapeHtml(phase.id.startsWith("speckit.") ? phase.id : `speckit.${phase.id}`)}</p></div>
    </header>
    <dl class="phase-facts"><dt>Output(s)</dt><dd><span id="phase-output-default" class="phase-output-label">DEFAULT:</span> <button class="phase-artifact-link" id="browse-output-folder" type="button" title="Open the viewer target's folder"><code></code></button><span id="phase-output-prompt" class="muted" hidden>Choose an artifact folder name to preview the output path.</span><button id="phase-output-toggle" class="phase-output-toggle" type="button" aria-controls="phase-other-outputs" aria-expanded="false" hidden></button></dd></dl>
    <p id="phase-artifact-status" class="muted" role="status"></p>
    <div id="phase-other-outputs" class="phase-output-list" aria-label="Additional phase outputs" hidden></div>
    <label class="field" for="phase-args">
        <span class="field-label" id="phase-input-label">Phase input</span>
        <span class="visually-hidden" id="phase-input-help">Add details or direction for this phase.</span>
        <textarea class="phase-input-control" id="phase-args" aria-labelledby="phase-input-label" aria-describedby="phase-input-help" placeholder="Add details or direction for this phase."></textarea>
    </label>
    <div id="phase-message" class="muted" role="status"></div>
    <footer class="phase-actions phase-actions-nav">
        <div class="phase-actions-left"><button class="btn btn-secondary" id="previous-phase" type="button">&#9664; Back</button></div>
        <div class="phase-actions-center">
            <button class="btn btn-primary" id="run-phase" type="button" aria-describedby="phase-message">Run phase</button>
            <button class="btn btn-secondary" id="view-artifact" type="button" aria-describedby="phase-artifact-status" hidden>View output</button>
        </div>
        <div class="phase-actions-right"><button class="btn btn-secondary" id="next-phase" type="button">Continue &#9654;</button></div>
    </footer>`;
}

export function mount({ root, state, actions }) {
    if (!root || typeof root.replaceChildren !== "function" || !actions
        || ["select", "draft", "run", "view", "reveal", "error"].some((key) =>
            typeof actions[key] !== "function")) throw new Error("Invalid phase control context");
    const listeners = new AbortController();
    let currentState;
    let previousKey;
    let outputsExpanded = false;
    let additionalCount = 0;
    const $ = (selector) => root.querySelector(selector);
    function update(next) {
        if (!next || !Array.isArray(next.phases) || !Number.isInteger(next.current)
            || next.current < -1 || next.current >= next.phases.length
            || typeof next.draft !== "string" || !Array.isArray(next.outputLinks)) {
            throw new Error("Invalid phase control state");
        }
        const key = `${next.workflow}:${next.current}`;
        const changed = !currentState || previousKey !== key
            || currentState.phases.length !== next.phases.length;
        if (changed) outputsExpanded = false;
        currentState = next;
        previousKey = key;
        if (changed) {
            root.innerHTML = `<nav id="phase-navigation" class="phase-navigation" aria-label="Workflow phases">
                ${next.phases.length ? `<div class="phase-mobile-nav"><label class="visually-hidden" for="mobile-phase-select">Jump to phase</label><select id="mobile-phase-select" class="phase-input-control">${next.phases.map((phase, index) =>
                    `<option value="${index}">Phase ${index + 1} of ${next.phases.length}: ${escapeHtml(phase.label)}</option>`).join("")}</select><span id="mobile-next-phase" class="muted"></span></div>` : ""}
                ${next.phases.length ? `<ol class="stepper">${next.phases.map((phase, index) => `
                    ${index > 0 ? '<li class="step-sep" aria-hidden="true"></li>' : ""}
                    <li><button class="step" type="button" data-phase-index="${index}" data-phase-label="${escapeHtml(phase.label)}" aria-label="Phase ${index + 1} of ${next.phases.length}: ${escapeHtml(phase.label)}">
                        <span class="step-order" aria-hidden="true">${index + 1}</span>
                        <span class="step-label"><span class="step-name">${escapeHtml(phase.label)}</span></span>
                    </button></li>`).join("")}</ol>` : ""}</nav>
                <section id="phase-card" class="phase-card" aria-label="Selected phase">${next.current >= 0
                    ? card(next.phases[next.current]) : '<div class="workflow-empty">No workflow phases are configured.</div>'}</section>`;
        }
        if (next.current < 0) return;
        const phase = next.phases[next.current];
        const status = next.status;
        const steps = [...root.querySelectorAll("[data-phase-index]")];
        for (const [index, button] of steps.entries()) {
            button.classList.toggle("active", index === next.current);
            if (index === next.current) button.setAttribute("aria-current", "step");
            else button.removeAttribute("aria-current");
        }
        const mobile = $("#mobile-phase-select");
        if (mobile) {
            mobile.value = String(next.current);
            $("#mobile-next-phase").textContent = next.current + 1 < steps.length
                ? `Next: ${next.phases[next.current + 1].label}` : "Final phase";
        }
        const back = $("#previous-phase"), forward = $("#next-phase");
        back.disabled = next.current === 0;
        forward.disabled = next.current === steps.length - 1;
        back.textContent = next.current ? `◀ ${next.phases[next.current - 1].label}` : "◀ Back";
        forward.textContent = next.current + 1 < steps.length
            ? `Next: ${next.phases[next.current + 1].label} ▶` : "Complete";
        const input = $("#phase-args");
        if (changed || document.activeElement !== input) input.value = next.draft;
        $(".phase-notice").textContent = status?.status ?? "Not run";
        const output = next.output ?? "No file output";
        const browse = $("#browse-output-folder");
        browse.querySelector("code").textContent = output;
        const needsSlug = next.workflow === "__new__" && next.slugEditable
            && next.output?.includes("<slug>");
        $("#phase-output-default").hidden = !next.output || needsSlug;
        $("#phase-output-prompt").hidden = !needsSlug;
        browse.hidden = needsSlug;
        const unresolved = !next.output || next.output.includes("<slug>");
        browse.disabled = unresolved;
        browse.title = unresolved
            ? (next.slugEditable ? "Enter an artifact folder name (slug) to resolve this path"
                : "Run the phase to resolve this path")
            : `Open ${output.slice(0, output.lastIndexOf("/")) || "."} in file explorer`;
        const artifact = $("#phase-artifact-status");
        const available = next.output === status?.output && status?.artifactAvailability === "available";
        $("#view-artifact").hidden = !available;
        artifact.textContent = next.workflow === "__new__" || available ? "" : (status?.artifactError
            ?? (next.output ? `${next.output} is not available yet. Run the phase, then refresh to check again.`
                : "No artifact is available for this phase yet. Run the phase, then refresh to check again."));
        artifact.hidden = !artifact.textContent;
        const others = $("#phase-other-outputs");
        others.replaceChildren();
        const additional = needsSlug ? [] : next.outputLinks.filter(({ template, label }) =>
            template !== phase.output && label !== next.output);
        additionalCount = additional.length;
        for (const output of additional) {
            const row = document.createElement("div");
            row.className = "phase-output-row";
            const button = document.createElement("button");
            button.type = "button";
            button.className = "phase-artifact-link";
            button.dataset.output = output.template;
            const path = document.createElement("code");
            path.textContent = output.label;
            button.append(path);
            row.append(button);
            others.append(row);
        }
        const toggle = $("#phase-output-toggle");
        toggle.hidden = !additional.length;
        toggle.textContent = outputsExpanded ? "− hide outputs" : `▸ +${additional.length} more`;
        toggle.setAttribute("aria-expanded", String(outputsExpanded));
        others.hidden = !additional.length || !outputsExpanded;
        $("#run-phase").textContent = next.runLabel
            ?? (next.workflow === "__new__" && next.current === 0
                ? `Create workflow and run ${phase.label}`
                : status?.status && status.status !== "Not run" ? "Run again" : "Run phase");
        $("#run-phase").disabled = Boolean(next.blocked);
        $("#run-phase").title = next.blocked ?? "";
        const notice = $("#phase-message");
        notice.textContent = status?.error ?? "";
        notice.classList.toggle("workflow-error", Boolean(status?.error));
    }
    root.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button || !root.contains(button)) return;
        const index = Number(button.dataset.phaseIndex);
        const destination = button.hasAttribute("data-phase-index") ? index
            : button.id === "previous-phase" ? currentState.current - 1
                : button.id === "next-phase" ? currentState.current + 1 : null;
        let action;
        try {
            if (destination !== null) {
                action = Promise.resolve(actions.select(destination)).then(() => {
                    if (button.id === "previous-phase" || button.id === "next-phase") {
                        root.querySelector(`#${button.id}`)?.focus({ preventScroll: true });
                    }
                });
            } else if (button.id === "run-phase") action = actions.run($("#phase-args").value);
            else if (button.id === "view-artifact") action = actions.view();
            else if (button.id === "phase-output-toggle") {
                outputsExpanded = !outputsExpanded;
                button.textContent = outputsExpanded ? "− hide outputs" : `▸ +${additionalCount} more`;
                button.setAttribute("aria-expanded", String(outputsExpanded));
                $("#phase-other-outputs").hidden = !outputsExpanded;
            }
            else if (button.hasAttribute("data-output")) action = actions.view(button.dataset.output);
            else if (button.id === "browse-output-folder") action = actions.reveal();
            if (action) Promise.resolve(action).catch(actions.error);
        } catch (error) { actions.error(error); }
    }, { signal: listeners.signal });
    root.addEventListener("change", (event) => {
        if (event.target.id === "mobile-phase-select") {
            Promise.resolve(actions.select(Number(event.target.value))).then(() =>
                $("#mobile-phase-select")?.focus({ preventScroll: true }))
                .catch((error) => { event.target.value = String(currentState.current); actions.error(error); });
        }
    }, { signal: listeners.signal });
    root.addEventListener("input", (event) => {
        if (event.target.id === "phase-args") actions.draft(event.target.value);
    }, { signal: listeners.signal });
    update(state);
    return { update, dispose: () => listeners.abort() };
}
