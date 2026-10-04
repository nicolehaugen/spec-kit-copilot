const escapeHtml = (value) => String(value).replace(/[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function phaseCard({ id, label, output }) {
    return `<header class="workflow-header">
        <div class="workflow-header-main"><div class="phase-heading"><h2>${escapeHtml(label)}</h2><span class="phase-notice">Not run</span></div>
        <p class="tagline">${escapeHtml(id.startsWith("speckit.") ? id : `speckit.${id}`)}</p></div>
    </header>
    <dl class="phase-facts"><dt>View target</dt><dd><button class="phase-artifact-link" id="browse-output-folder" type="button" title="Open the viewer target's folder"><code>${escapeHtml(output ?? "No declared output")}</code></button></dd></dl>
    <p id="phase-artifact-status" class="muted" role="status"></p>
    <p id="phase-other-outputs" class="muted" hidden></p>
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
            <button class="btn btn-secondary" id="view-artifact" type="button" aria-describedby="phase-artifact-status" hidden>View artifact</button>
        </div>
        <div class="phase-actions-right"><button class="btn btn-secondary" id="next-phase" type="button">Continue &#9654;</button></div>
    </footer>`;
}

export function mount({ root, phases, actions }) {
    if (!root || typeof root.replaceChildren !== "function" || !Array.isArray(phases)
        || !actions || ["select", "run", "view", "reveal", "draft", "error"].some((key) =>
            typeof actions[key] !== "function")) throw new Error("Invalid generated pipeline context");
    root.innerHTML = `<nav id="phase-navigation" class="phase-navigation" aria-label="Workflow phases">
        ${phases.length ? `<div class="phase-mobile-nav"><label class="visually-hidden" for="mobile-phase-select">Jump to phase</label><select id="mobile-phase-select" class="phase-input-control">${phases.map((phase, index) =>
            `<option value="${index}">Phase ${index + 1} of ${phases.length}: ${escapeHtml(phase.label)}</option>`).join("")}</select><span id="mobile-next-phase" class="muted"></span></div>` : ""}
        ${phases.length ? `<ol class="stepper">${phases.map((phase, index) => `
            ${index > 0 ? '<li class="step-sep" aria-hidden="true"></li>' : ""}
            <li><button class="step${index === 0 ? " active" : ""}" type="button" data-phase-index="${index}" data-phase-label="${escapeHtml(phase.label)}"${index === 0 ? ' aria-current="step"' : ""} aria-label="Phase ${index + 1} of ${phases.length}: ${escapeHtml(phase.label)}">
                <span class="step-order" aria-hidden="true">${index + 1}</span>
                <span class="step-label"><span class="step-name">${escapeHtml(phase.label)}</span></span>
            </button></li>`).join("")}</ol>` : ""}
    </nav>
    <section id="phase-card" class="phase-card" aria-label="Selected phase">${phases.length
        ? phaseCard(phases[0]) : '<div class="workflow-empty">No workflow phases are configured.</div>'}</section>
    ${phases.map((phase, index) => `<template id="phase-template-${index}">${phaseCard(phase)}</template>`).join("")}`;
    root.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button || !root.contains(button)) return;
        const current = Number(root.querySelector('[aria-current="step"]')?.dataset.phaseIndex ?? 0);
        try {
            let action;
            if (button.hasAttribute("data-phase-index")) action = actions.select(Number(button.dataset.phaseIndex));
            else if (button.id === "previous-phase") action = actions.select(current - 1, button.id);
            else if (button.id === "next-phase") action = actions.select(current + 1, button.id);
            else if (button.id === "run-phase") action = actions.run(root.querySelector("#phase-args").value);
            else if (button.id === "view-artifact") action = actions.view();
            else if (button.id === "browse-output-folder") action = actions.reveal();
            if (action) Promise.resolve(action).catch(actions.error);
        } catch (error) { actions.error(error); }
    });
    root.addEventListener("change", (event) => {
        if (event.target.id === "mobile-phase-select") {
            Promise.resolve(actions.select(Number(event.target.value), event.target.id))
                .catch((error) => { event.target.value = root.querySelector('[aria-current="step"]')?.dataset.phaseIndex ?? "0";
                    actions.error(error); });
        }
    });
    root.addEventListener("input", (event) => {
        if (event.target.id === "phase-args") actions.draft(event.target.value);
    });
    return { steps: [...root.querySelectorAll("[data-phase-index]")] };
}
