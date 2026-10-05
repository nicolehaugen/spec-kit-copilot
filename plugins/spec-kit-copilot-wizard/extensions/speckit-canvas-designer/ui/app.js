const token = new URL(location.href).searchParams.get("token");
const root = document.getElementById("settings-page");
const tabs = document.querySelector(".tabs");
const errorBox = document.getElementById("page-error");
const saveButton = document.getElementById("save-settings");
const messageBox = document.getElementById("action-message");
let model, currentPage, draft, draftOutputs, saving = false;
let selectedOutputPhase;
const pendingArtifacts = new Map();
const generate = document.getElementById("generate-canvas");
let generating = false;
let queued = false;
const activeUploads = new Set();
const required = ["canvas.id", "canvas.displayName"];
const scalarAdapters = new Map();
const mounted = new Map();

function outputPathsReady() {
    return Object.values(draftOutputs ?? {}).every((entry) =>
        entry.outputs.every((path) => path.endsWith(".md")));
}

function updateGenerate() {
    const setup = model?.pages.find((page) => page.page === "designer-essentials");
    const generationError = document.getElementById("generation-error");
    const failed = model?.pages.find((page) => page.error);
    const missingIdentity = model && !failed && (!setup || setup.enabled === false
        || !required.every((field) => setup.fields?.some((item) => item.id === field)));
    generationError.textContent = failed
        ? `Cannot generate: ${failed.page} could not load. ${failed.error.reason}`
        : missingIdentity ? "Cannot generate: Essentials must contain Canvas ID and Title."
            : model?.generationError ?? "";
    generationError.hidden = !generationError.textContent;
    generate.disabled = saving || activeUploads.size > 0 || generating || queued || !outputPathsReady()
        || !model?.handoffId
        || !model.generationAvailable || !setup || !!failed || setup.enabled === false
        || missingIdentity;
}

function confirmProviders(providers) {
    const dialog = document.getElementById("provider-approval");
    const list = document.getElementById("provider-approval-list");
    list.replaceChildren();
    for (const { name, sourceId, hash } of providers) {
        list.append(element("dt", name), element("dd", `Source: ${sourceId}`),
            element("dd", `SHA-256: ${hash}`));
    }
    dialog.returnValue = "";
    dialog.showModal();
    return new Promise((resolve) => dialog.addEventListener("close",
        () => resolve(dialog.returnValue === "approve"), { once: true }));
}

generate.addEventListener("click", async () => {
    if (generate.disabled || !checkReady()) return;
    const providers = model.templates.filter((item) => item.kind === "generated.computed-value-provider")
        .map(({ name, sourceId, hash }) => ({ name, sourceId, hash }));
    generating = true;
    updateGenerate();
    showError("");
    try {
        if (providers.length && !await confirmProviders(providers)) return;
        const values = draft;
        const response = await fetch(`/api/generate?token=${encodeURIComponent(token)}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ modelRevision: model.revision,
                settingsRevision: model.settingsRevision, values, outputs: draftOutputs,
                ...(providers.length ? { approvedProviders: providers } : {}) }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Generation failed (${response.status})`);
        status.textContent = `Generation queued: ${result.target}`;
        queued = true;
    } catch (error) {
        showFieldError(error.message);
    } finally {
        generating = false;
        updateGenerate();
    }
});

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
    if (message) errorBox.focus();
}

function showFieldError(message) {
    showError(message);
    let id;
    const page = model.pages.find((entry) => entry.fields?.some((field) => {
        const labelAndId = `${field.label} (${field.id})`;
        if (!message.startsWith(labelAndId) && !message.startsWith(`Invalid ${labelAndId}`)
            && !message.startsWith(`Missing Designer adapter for ${labelAndId}`)) return false;
        id = field.id;
        return true;
    }));
    if (!page) return;
    if (page.page !== currentPage) renderPage(page.page, id);
    else {
        const mount = [...root.querySelectorAll("[data-field-id]")]
            .find((item) => item.dataset.fieldId === id);
        if (mount) {
            mount.nextElementSibling.hidden = false;
            mount.parentElement.focus();
        }
    }
}

function checkReady() {
    const page = model.pages.find((entry) => entry.page === currentPage);
    for (const field of page?.fields ?? []) {
        const handle = mounted.get(field.id);
        try {
            if (typeof handle?.isReady !== "function" || handle.isReady() !== true) {
                showFieldError(`${field.label} (${field.id}) is still processing or needs attention.`);
                return false;
            }
        } catch (error) {
            showFieldError(`${field.label} (${field.id}) readiness failed: ${error.message}`);
            return false;
        }
    }
    return true;
}

function updateSave() {
    const noChanges = model?.persisted
        && JSON.stringify(draft) === JSON.stringify(model.values)
        && JSON.stringify(draftOutputs) === JSON.stringify(model.outputs);
    saveButton.disabled = saving || activeUploads.size > 0 || !model || noChanges || !outputPathsReady();
    document.getElementById("save-help").title = noChanges ? "No changes to save" : "";
    if (noChanges) saveButton.setAttribute("aria-description", "No changes to save");
    else saveButton.removeAttribute("aria-description");
    saveButton.textContent = saving ? "Saving..." : "Save";
    saveButton.setAttribute("aria-busy", String(saving));
    root.inert = saving || activeUploads.size > 0;
    for (const tab of tabs.children) tab.disabled = saving || activeUploads.size > 0;
    updateGenerate();
}

saveButton.addEventListener("click", async () => {
    if (saving || !model || !checkReady()) return;
    saving = true;
    messageBox.hidden = true;
    showError("");
    updateSave();
    try {
        const response = await fetch(`/api/save?token=${encodeURIComponent(token)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ modelRevision: model.revision,
                revision: model.settingsRevision, values: draft, outputs: draftOutputs }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Designer save failed (${response.status})`);
        model = result;
        messageBox.textContent = "Settings saved.";
        messageBox.hidden = false;
    } catch (error) {
        showError(`Could not save settings: ${error.message}`);
    } finally {
        saving = false;
        updateSave();
    }
});

function renderPage(pageId, invalidFieldId) {
    const page = model.pages.find((entry) => entry.page === pageId);
    if (!page) throw new Error("Unknown Designer page");
    currentPage = pageId;
    mounted.clear();
    for (const tab of tabs.children) {
        const active = tab.dataset.page === pageId;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
    }
    root.setAttribute("aria-labelledby", `page-tab-${pageId}`);
    if (page.error) {
        const { name, path, reason } = page.error;
        const details = element("div", undefined, "page-diagnostic");
        details.append(element("h1", `Could not load ${name}`),
            element("p", "This settings page could not be loaded. Ask your agent to inspect the template and resolve the issue."),
            element("p", `Template: ${name}`), element("p", `Resolved path: ${path}`),
            element("p", `Reason: ${reason}`));
        root.replaceChildren(details);
        root.setAttribute("aria-busy", "false");
        return true;
    }
    if (pageId === "designer-artifacts") {
        const phases = model.phases.filter((id) => id.replace(/^speckit\./, "") !== "constitution");
        if (!phases.includes(selectedOutputPhase)) selectedOutputPhase = phases[0];
        const header = element("div", undefined, "output-header");
        header.append(element("h1", page.title));
        if (phases.length) {
            const label = element("label", "Phase: ");
            const select = element("select");
            select.setAttribute("aria-label", "Phase");
            for (const id of phases) {
                const option = element("option", id.replace(/^speckit\./, "").replace(/[.-]/g, " ")
                    .replace(/^./, (first) => first.toUpperCase()));
                option.value = id;
                select.append(option);
            }
            select.value = selectedOutputPhase;
            select.addEventListener("change", () => {
                selectedOutputPhase = select.value;
                renderPage(pageId);
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
        if (!phases.length) {
            sections.append(element("p", "No phases have configurable artifacts. Constitution always opens its fixed artifact.", "settings-note"));
        } else {
            const id = selectedOutputPhase;
            const entry = draftOutputs[id];
            const pipeline = model.pipelineOutputs?.[id]?.outputs ?? [];
            const originalView = model.pipelineOutputs?.[id]?.view ?? null;
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
                    updateSave();
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
                        updateSave();
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
            input.value = pendingArtifacts.get(id) ?? "";
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
                pendingArtifacts.set(id, input.value);
                validateInput();
            });
            form.addEventListener("submit", (event) => {
                event.preventDefault();
                if (add.disabled) return;
                const path = input.value.trim();
                entry.outputs.push(path);
                if (!entry.view) entry.view = path;
                pendingArtifacts.delete(id);
                input.value = "";
                render();
                validateInput();
                updateSave();
            });
            form.append(input, add);
            section.append(form, hint, inputError);
            sections.append(section);
            validateInput();
        }
        root.setAttribute("aria-busy", "false");
        return true;
    }
    root.replaceChildren(element("h1", page.title), element("p", page.description ?? "", "muted"));
    const form = element("form");
    form.noValidate = true;
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        saveButton.click();
    });
    if (!page.fields.length) form.append(element("p", "This template defines no fields.", "settings-note"));
    root.append(form);
    for (const field of page.fields) {
        const rules = model.constraints[field.id];
        const image = rules.type === "image";
        const object = rules.type === "object";
        const wrapper = element("div", undefined, `settings-field${image ? " settings-image"
            : rules.type === "boolean" ? " settings-checkbox" : ""}`);
        wrapper.tabIndex = -1;
        wrapper.setAttribute("role", "group");
        wrapper.setAttribute("aria-label", field.label);
        if (object) wrapper.append(element("p", field.label));
        const mount = element("div");
        if (object) mount.setAttribute("aria-label", field.label);
        mount.dataset.fieldId = field.id;
        wrapper.append(mount);
        const fieldError = element("p", `Invalid ${field.label} (${field.id}).`, "settings-field-error");
        fieldError.id = `setting-error-${field.id}`;
        fieldError.setAttribute("role", "alert");
        fieldError.hidden = field.id !== invalidFieldId;
        wrapper.setAttribute("aria-describedby", fieldError.id);
        wrapper.append(fieldError);
        form.append(wrapper);
        if (field.id === invalidFieldId) wrapper.focus();
        const control = field.control ?? (rules.type === "boolean" ? "stock.checkbox" : "stock.text");
        const adapter = model.adapters[control];
        if (!adapter) {
            mount.setAttribute("role", "alert");
            mount.textContent = `Could not load ${field.label}: missing Designer adapter`;
            continue;
        }
        const mountAdapter = ({ mount: render, validate, controlId, valueContract }) => {
                if (typeof render !== "function") throw new Error("Missing mount export");
                if (typeof validate !== "function") throw new Error("Missing validate export");
                const expected = model.controls.find((item) => item.id === control)?.value;
                if (controlId !== control || valueContract?.type !== expected?.type
                    || (image
                        ? valueContract.maxBytes !== expected.maxBytes
                            || JSON.stringify(valueContract.mimeTypes) !== JSON.stringify(expected.mimeTypes)
                        : object
                            ? JSON.stringify(Object.entries(valueContract.properties ?? {}).sort())
                                !== JSON.stringify(Object.entries(expected.properties).sort())
                            : Object.keys(valueContract).sort().join() !== "type")) {
                    throw new Error("Incompatible control ID or value contract");
                }
                if (!mount.isConnected) return;
                const handle = render({ root: mount, field, value: draft[field.id],
                    ...(image ? { context: { setBusy(busy) {
                            if (busy) activeUploads.add(field.id);
                            else activeUploads.delete(field.id);
                            updateSave();
                        } } } : {}),
                    onChange(value) {
                        if (!mount.isConnected) return;
                        if (rules.type === "image" ? typeof value !== "string"
                            || value.length > Math.ceil(rules.maxBytes / 3) * 4 + 64
                            : rules.type === "boolean" ? typeof value !== "boolean"
                                : rules.type === "string" ? typeof value !== "string"
                                    : value !== null && (typeof value !== "object" || Array.isArray(value))) {
                            throw new Error(`Invalid Designer setting: ${field.id}`);
                        }
                        draft[field.id] = value;
                        fieldError.hidden = true;
                        messageBox.hidden = true;
                        showError("");
                        updateSave();
                        updateGenerate();
                    } });
                if (typeof handle?.isReady !== "function") {
                    throw new Error("Missing isReady handle");
                }
                mounted.set(field.id, handle);
        };
        const showAdapterError = (error) => {
            if (!mount.isConnected) return;
            mount.replaceChildren();
            mount.setAttribute("role", "alert");
            mount.textContent = `Could not load ${field.label}: ${error.message}`;
        };
        if (rules.type === "string" || rules.type === "boolean") {
            try {
                const loaded = scalarAdapters.get(control);
                if (loaded instanceof Error) throw loaded;
                if (!loaded) throw new Error("Missing Designer adapter");
                Promise.resolve(mountAdapter(loaded)).catch(showAdapterError);
            } catch (error) {
                showAdapterError(error);
            }
        } else {
            import(`/adapters/${adapter}.mjs?token=${encodeURIComponent(token)}`)
                .then(mountAdapter).catch(showAdapterError);
        }
    }
    root.setAttribute("aria-busy", "false");
    return true;
}

tabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-page]");
    if (tab && tab.dataset.page !== currentPage && checkReady()) renderPage(tab.dataset.page);
});
tabs.addEventListener("keydown", (event) => {
    const buttons = [...tabs.children];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % buttons.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    if (buttons[next].dataset.page !== currentPage && checkReady()) {
        renderPage(buttons[next].dataset.page);
        buttons[next].focus();
    }
});

function applyState(next) {
    if (!Array.isArray(next.pages) || !next.pages.length) {
        throw new Error("Designer returned no settings pages");
    }
    const changed = !model || next.revision !== model.revision;
    if (changed) {
        model = next;
        draft = structuredClone(model.values);
        draftOutputs = structuredClone(model.outputs ?? Object.fromEntries(
            (model.phases ?? []).map((id) => [id, { outputs: [], view: null }])));
        tabs.replaceChildren();
        for (const page of model.pages) {
            const tab = element("button", page.error ? `${page.title} (error)` : page.title,
                `tab${page.error ? " tab-error" : ""}`);
            tab.type = "button";
            tab.dataset.page = page.page;
            tab.id = `page-tab-${page.page}`;
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-controls", "settings-page");
            tabs.append(tab);
        }
        const selected = model.pages.find((page) => page.page === currentPage)
            ?? model.pages.find((page) => page.page === "designer-essentials")
            ?? model.pages[0];
        renderPage(selected.page);
        updateSave();
        updateGenerate();
    }
}

const status = document.getElementById("conn-status");
try {
    const response = await fetch(`/api/state?token=${encodeURIComponent(token)}`);
    if (!response.ok) throw new Error(`Designer settings request failed (${response.status})`);
    const initial = await response.json();
    await Promise.all(["stock.text", "stock.checkbox"].filter((id) => initial.adapters?.[id])
        .map(async (id) => {
            try {
                scalarAdapters.set(id, await import(
                    `/adapters/${initial.adapters[id]}.mjs?token=${encodeURIComponent(token)}`));
            } catch (error) {
                scalarAdapters.set(id, error);
            }
        }));
    applyState(initial);
    const failures = initial.pages.filter((page) => page.error).length;
    status.className = failures ? "conn conn-connecting" : "conn conn-live";
    status.textContent = failures ? `Pages need attention (${failures})` : "Ready";
} catch (error) {
    root.setAttribute("aria-busy", "false");
    root.replaceChildren(element("h1", "Settings unavailable"));
    status.className = "conn conn-lost";
    status.textContent = "Unavailable";
    showError(error.message);
}
