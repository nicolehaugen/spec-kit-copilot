const token = new URL(location.href).searchParams.get("token");
const root = document.getElementById("settings-page");
const tabs = document.querySelector(".tabs");
const errorBox = document.getElementById("page-error");
const saveButton = document.getElementById("save-settings");
const messageBox = document.getElementById("action-message");
let model, currentPage, draft, saving = false;
const generate = document.getElementById("generate-canvas");
let generating = false;
let queued = false;
const required = ["canvas.id", "canvas.displayName"];

function updateGenerate() {
    const setup = model?.pages.find((page) => page.page === "canvas-settings-setup");
    const generationError = document.getElementById("generation-error");
    const failed = model?.pages.find((page) => page.error);
    const missingIdentity = model && !failed && (!setup || setup.enabled === false
        || !required.every((field) => setup.fields?.some((item) => item.id === field)));
    generationError.textContent = failed
        ? `Cannot generate: ${failed.page} could not load. ${failed.error.reason}`
        : missingIdentity ? "Cannot generate: Essentials must contain Canvas ID and Title."
            : model?.generationError ?? "";
    generationError.hidden = !generationError.textContent;
    generate.disabled = saving || generating || queued || !model?.handoffId
        || !model.generationAvailable || !setup || !!failed || setup.enabled === false
        || missingIdentity;
}

generate.addEventListener("click", async () => {
    if (generate.disabled || !validateDraft("generating")) return;
    for (const field of ["canvas.id", "canvas.displayName"]) {
        const value = draft[field];
        const rules = model.constraints[field];
        if (typeof value !== "string" || value.length < rules.minLength
            || value.length > rules.maxLength
            || (rules.pattern && !new RegExp(rules.pattern).test(value))
            || !value.trim()) {
            renderPage("canvas-settings-setup");
            const input = [...root.querySelectorAll("input")].find((item) => item.name === field);
            const hint = field === "canvas.id" ? model.pages
                .find((page) => page.page === "canvas-settings-setup")?.fields
                .find((item) => item.id === field)?.description : "";
            showError(`Enter a valid ${field === "canvas.id" ? "Canvas ID" : "Title"} before generating.${hint ? ` ${hint}` : ""}`);
            input?.focus();
            input?.reportValidity();
            return;
        }
        if (["speckit-canvas-designer", "speckit-wizard", "speckit-canvas-generator"]
            .includes(draft["canvas.id"])) {
            renderPage("canvas-settings-setup");
            showError("Canvas ID is reserved. Choose a different Canvas ID before generating.");
            root.querySelector('[name="canvas.id"]')?.focus();
            return;
        }
    }
    generating = true;
    updateGenerate();
    showError("");
    try {
        const values = draft;
        const response = await fetch(`/api/generate?token=${encodeURIComponent(token)}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ revision: model.revision, values }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Generation failed (${response.status})`);
        status.textContent = `Generation queued: ${result.target}`;
        queued = true;
    } catch (error) {
        showError(error.message);
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

function updateSave() {
    const noChanges = model?.persisted
        && JSON.stringify(draft) === JSON.stringify(model.values);
    saveButton.disabled = saving || !model || noChanges;
    document.getElementById("save-help").title = noChanges ? "No changes to save" : "";
    if (noChanges) saveButton.setAttribute("aria-description", "No changes to save");
    else saveButton.removeAttribute("aria-description");
    saveButton.textContent = saving ? "Saving..." : "Save";
    saveButton.setAttribute("aria-busy", String(saving));
    root.inert = saving;
    for (const tab of tabs.children) tab.disabled = saving;
    updateGenerate();
}

function validateDraft(action = "saving") {
    for (const [id, rules] of Object.entries(model.constraints)) {
        const value = draft[id];
        if (rules.type === "boolean" && typeof value === "boolean") continue;
        if (rules.type === "object" ? (!value || typeof value !== "object"
            || Array.isArray(value)
            || Object.keys(value).sort().join() !== Object.keys(rules.properties).sort().join()
            || Object.entries(rules.properties).some(([key, allowed]) => !allowed.includes(value[key])))
            : (typeof value !== "string" || value.length < (rules.minLength ?? 0) || value.length > rules.maxLength
            || (rules.pattern && !new RegExp(rules.pattern).test(value)))) {
            const page = model.pages.find((entry) => entry.fields?.some((field) => field.id === id));
            if (page) {
                renderPage(page.page);
                root.querySelectorAll("input").forEach((input) => {
                    if (input.name === id) { input.focus(); input.reportValidity(); }
                });
                if (rules.type === "object") {
                    root.querySelector(`[data-field-id="${CSS.escape(id)}"] [role="radio"]`)?.focus();
                }
            }
            const field = page?.fields.find((item) => item.id === id);
            showError(`Enter a valid ${field?.label ?? id} before ${action}.${id === "canvas.id" && field?.description ? ` ${field.description}` : ""}`);
            return false;
        }
    }
    return true;
}

saveButton.addEventListener("click", async () => {
    if (saving || !model || !validateDraft()) return;
    saving = true;
    messageBox.hidden = true;
    showError("");
    updateSave();
    try {
        const response = await fetch(`/api/save?token=${encodeURIComponent(token)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ modelRevision: model.revision,
                revision: model.settingsRevision, values: draft }),
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

function renderPage(pageId) {
    const page = model.pages.find((entry) => entry.page === pageId);
    if (!page) throw new Error("Unknown Designer page");
    currentPage = pageId;
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
        return;
    }
    root.replaceChildren(element("h1", page.title), element("p", page.description ?? "", "muted"));
    const form = element("form");
    form.noValidate = true;
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        saveButton.click();
    });
    if (!page.fields.length) form.append(element("p", "This template defines no fields.", "settings-note"));
    for (const [index, field] of page.fields.entries()) {
        const rules = model.constraints[field.id];
        if (rules.type === "object") {
            const wrapper = element("div", undefined, "settings-field");
            wrapper.append(element("p", field.label));
            const mount = element("div");
            mount.setAttribute("aria-label", field.label);
            mount.dataset.fieldId = field.id;
            wrapper.append(mount);
            form.append(wrapper);
            const adapter = model.adapters[field.control];
            if (!adapter) {
                mount.setAttribute("role", "alert");
                mount.textContent = `Could not load ${field.label}: missing Designer adapter`;
                continue;
            }
            import(`/adapters/${adapter}.mjs?token=${encodeURIComponent(token)}`)
                .then(({ mount: render, controlId, valueContract }) => {
                    if (typeof render !== "function") throw new Error("Missing mount export");
                    const expected = model.controls.find((item) => item.id === field.control)?.value;
                    if (controlId !== field.control || valueContract?.type !== expected?.type
                        || JSON.stringify(Object.entries(valueContract.properties ?? {}).sort())
                            !== JSON.stringify(Object.entries(expected.properties).sort())) {
                        throw new Error("Incompatible control ID or value contract");
                    }
                    if (!mount.isConnected) return;
                    return render({ root: mount, field, value: draft[field.id], onChange(value) {
                        draft[field.id] = value;
                        messageBox.hidden = true;
                        showError("");
                        updateSave();
                    } });
                }).catch((error) => {
                    if (!mount.isConnected) return;
                    mount.replaceChildren();
                    mount.setAttribute("role", "alert");
                    mount.textContent = `Could not load ${field.label}: ${error.message}`;
                });
            continue;
        }
        const checkbox = rules.type === "boolean";
        const wrapper = element("div", undefined, `settings-field${checkbox ? " settings-checkbox" : ""}`);
        const label = element("label", field.label);
        const input = element("input");
        input.id = `setting-field-${index}`;
        input.name = field.id;
        label.htmlFor = input.id;
        if (field.description) label.title = field.description;
        if (checkbox) {
            input.type = "checkbox";
            input.checked = draft[field.id];
        } else {
            input.type = "text";
            input.value = draft[field.id];
            input.required = rules.minLength > 0;
            input.maxLength = rules.maxLength;
            if (rules.pattern) input.pattern = rules.pattern;
            if (input.required) label.append(element("span", " (required)", "muted"));
        }
        if (field.description) {
            if (checkbox) input.setAttribute("aria-description", field.description);
            else input.setAttribute("aria-describedby", `${input.id}-hint`);
        }
        input.addEventListener("input", () => {
            draft[field.id] = checkbox ? input.checked : input.value;
            messageBox.hidden = true;
            showError("");
            updateSave();
            updateGenerate();
        });
        wrapper.append(...(checkbox ? [input, label] : [label, input]));
        if (field.description && !checkbox) {
            const hint = element("p", field.description, "settings-hint");
            hint.id = `${input.id}-hint`;
            wrapper.append(hint);
        }
        form.append(wrapper);
    }
    root.append(form);
    root.setAttribute("aria-busy", "false");
}

tabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-page]");
    if (tab) renderPage(tab.dataset.page);
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
    renderPage(buttons[next].dataset.page);
    buttons[next].focus();
});

function applyState(next) {
    if (!Array.isArray(next.pages) || !next.pages.length) {
        throw new Error("Designer returned no settings pages");
    }
    const changed = !model || next.revision !== model.revision;
    if (changed) {
        model = next;
        draft = structuredClone(model.values);
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
            ?? model.pages.find((page) => page.page === "canvas-settings-setup")
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
