let selectedPhase;
const pendingPaths = new Map();

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

export function mountOutputs({ root, page, phases, draftOutputs, pipelineOutputs, onChange }) {
    const configurable = phases.filter((id) => id.replace(/^speckit\./, "") !== "constitution");
    if (!configurable.includes(selectedPhase)) selectedPhase = configurable[0];
    const header = element("div", undefined, "output-header");
    header.append(element("h1", page.title));
    if (configurable.length) {
        const label = element("label", "Phase: ");
        const select = element("select");
        select.setAttribute("aria-label", "Phase");
        for (const id of configurable) {
            const option = element("option", id.replace(/^speckit\./, "").replace(/[.-]/g, " ")
                .replace(/^./, (first) => first.toUpperCase()));
            option.value = id;
            select.append(option);
        }
        select.value = selectedPhase;
        select.addEventListener("change", () => {
            selectedPhase = select.value;
            mountOutputs({ root, page, phases, draftOutputs, pipelineOutputs, onChange });
        });
        label.append(select);
        header.append(label);
    }
    root.replaceChildren(header,
        element("p", "Choose which artifact opens when someone clicks View artifact."),
        element("p", "Add other artifacts to the canvas if needed."),
        element("p", "This list doesn’t change the artifacts that a pipeline creates."));
    const sections = element("div", undefined, "output-sections");
    root.append(sections);
    if (!configurable.length) {
        sections.append(element("p", "No phases have configurable artifacts. Constitution always opens its fixed artifact.", "settings-note"));
        return;
    }

    const id = selectedPhase;
    const entry = draftOutputs[id];
    const pipeline = pipelineOutputs[id].outputs;
    const originalView = pipelineOutputs[id].view;
    const section = element("section", undefined, "output-section");
    section.append(element("h2", "Opens with View artifact"),
        element("p", "Select one artifact to open by default.", "settings-note"),
        element("h3", "Pipeline artifacts"));
    const pipelineList = element("div", undefined, "output-list");
    const additionList = element("div", undefined, "output-list");
    const rowFor = (path, position, added) => {
        const row = element("div", undefined, "output-row");
        const label = element("label", undefined, "output-choice");
        const radio = element("input");
        radio.type = "radio";
        radio.name = `viewer-${id}`;
        radio.checked = entry.view === path;
        radio.setAttribute("aria-label", `Open ${path} by default`);
        radio.addEventListener("change", () => {
            entry.view = path;
            render();
            [...section.querySelectorAll("input[type=radio]")]
                .find((item) => item.getAttribute("aria-label") === `Open ${path} by default`)
                ?.focus();
            onChange();
        });
        label.append(radio, element("span", path));
        row.append(label);
        if (added) {
            const remove = element("button", "Remove");
            remove.type = "button";
            remove.setAttribute("aria-label", `Remove ${path}`);
            remove.addEventListener("click", () => {
                entry.outputs.splice(position, 1);
                if (entry.view === path) entry.view = originalView;
                render();
                onChange();
            });
            row.append(remove);
        } else if (entry.view === path) {
            row.append(element("span", "Opens by default", "settings-note"));
        }
        return row;
    };
    const render = () => {
        pipelineList.replaceChildren();
        additionList.replaceChildren();
        for (const [position, path] of pipeline.entries()) {
            pipelineList.append(rowFor(path, position, false));
        }
        if (!pipeline.length) {
            pipelineList.append(element("p", "No pipeline artifacts for this phase.", "settings-note"));
        }
        for (const [position, path] of entry.outputs.entries()) {
            if (position >= pipeline.length) additionList.append(rowFor(path, position, true));
        }
        if (entry.outputs.length === pipeline.length) {
            additionList.append(element("p", "No additional artifacts.", "settings-note"));
        }
        if (!entry.outputs.length) {
            additionList.append(element("p",
                "This phase will not have a View artifact button in the generated canvas.",
                "output-warning"));
        }
    };
    render();
    section.append(pipelineList, element("h3", "Additional artifacts"), additionList);
    const form = element("form", undefined, "output-add");
    const input = element("input");
    input.type = "text";
    input.maxLength = 1000;
    input.value = pendingPaths.get(id) ?? "";
    input.placeholder = "Artifact path";
    input.setAttribute("aria-label", "Artifact path");
    const add = element("button", "Add artifact");
    add.type = "submit";
    const hint = element("p", "Adding an artifact here doesn’t create the file.", "settings-note");
    const inputError = element("p", undefined, "output-warning");
    const validateInput = () => {
        const path = input.value.trim();
        const duplicate = entry.outputs.some((item) => item.toLowerCase() === path.toLowerCase());
        add.disabled = !path.endsWith(".md") || duplicate || entry.outputs.length >= 100;
        inputError.textContent = entry.outputs.length >= 100
            ? "A phase can list at most 100 artifacts."
            : duplicate ? "This artifact is already listed."
                : path && !path.endsWith(".md") ? "Enter a Markdown (.md) artifact path."
                    : "";
        inputError.hidden = !inputError.textContent;
    };
    input.addEventListener("input", () => {
        pendingPaths.set(id, input.value);
        validateInput();
    });
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (add.disabled) return;
        const path = input.value.trim();
        entry.outputs.push(path);
        if (!entry.view) entry.view = path;
        pendingPaths.delete(id);
        input.value = "";
        render();
        validateInput();
        onChange();
    });
    form.append(input, add);
    section.append(form, hint, inputError);
    sections.append(section);
    validateInput();
}
