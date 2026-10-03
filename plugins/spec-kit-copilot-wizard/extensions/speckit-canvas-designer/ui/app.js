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
let uploading = false;
const required = ["canvas.id", "canvas.displayName"];
const scalarAdapters = new Map();

function validImage(value) {
    if (value === "") return true;
    const match = typeof value === "string"
        && /^data:(image\/(?:png|jpeg|gif|webp));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(value);
    if (!match || match[2].length > Math.ceil(32768 / 3) * 4) return false;
    const binary = atob(match[2]);
    const signatures = {
        "image/png": [137, 80, 78, 71, 13, 10, 26, 10],
        "image/jpeg": [255, 216, 255],
        "image/gif": [71, 73, 70, 56],
        "image/webp": [82, 73, 70, 70],
    };
    return binary.length > 0 && binary.length <= 32768
        && signatures[match[1]].every((byte, index) => binary.charCodeAt(index) === byte)
        && (match[1] !== "image/png" || binary.length >= 24 && binary.slice(12, 16) === "IHDR")
        && (match[1] !== "image/jpeg" || binary.length >= 5
            && binary.charCodeAt(binary.length - 2) === 255 && binary.charCodeAt(binary.length - 1) === 217)
        && (match[1] !== "image/gif" || binary.length >= 14
            && ["GIF87a", "GIF89a"].includes(binary.slice(0, 6)))
        && (match[1] !== "image/webp" || binary.length >= 16
            && binary.slice(8, 12) === "WEBP"
            && new DataView(new Uint8Array([...binary.slice(4, 8)]
                .map((character) => character.charCodeAt(0))).buffer).getUint32(0, true) + 8 === binary.length);
}

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
    generate.disabled = saving || uploading || generating || queued || !model?.handoffId
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
            body: JSON.stringify({ revision: model.revision, values,
                ...(providers.length ? { approvedProviders: providers } : {}) }),
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
    saveButton.disabled = saving || uploading || !model || noChanges;
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
        if (rules.type === "image" ? !validImage(value)
            : rules.type === "object" ? (!value || typeof value !== "object"
            || Array.isArray(value)
            || Object.keys(value).sort().join() !== Object.keys(rules.properties).sort().join()
            || Object.entries(rules.properties).some(([key, allowed]) => !allowed.includes(value[key])))
            : (typeof value !== "string" || value.length < (rules.minLength ?? 0) || value.length > rules.maxLength
            || (rules.pattern && !new RegExp(rules.pattern).test(value)))) {
            const page = model.pages.find((entry) => entry.fields?.some((field) => field.id === id));
            const field = page?.fields.find((item) => item.id === id);
            showError(`Enter a valid ${field?.label ?? id} before ${action}.${rules.type === "image" ? " Use a PNG, JPEG, GIF, or WebP under 32 KiB." : id === "canvas.id" && field?.description ? ` ${field.description}` : ""}`);
            if (page) {
                renderPage(page.page);
                root.querySelectorAll("input").forEach((input) => {
                    if (input.name === id) { input.focus(); input.reportValidity(); }
                });
                if (rules.type === "object") {
                    root.querySelector(`[data-field-id="${CSS.escape(id)}"] [role="radio"]`)?.focus();
                }
            }
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
    root.append(form);
    for (const [index, field] of page.fields.entries()) {
        const rules = model.constraints[field.id];
        const image = rules.type === "image";
        const object = rules.type === "object";
        const wrapper = element("div", undefined, `settings-field${image ? " settings-image"
            : rules.type === "boolean" ? " settings-checkbox" : ""}`);
        if (object) wrapper.append(element("p", field.label));
        const mount = element("div");
        if (object) mount.setAttribute("aria-label", field.label);
        mount.dataset.fieldId = field.id;
        wrapper.append(mount);
        form.append(wrapper);
        const control = field.control ?? (rules.type === "boolean" ? "stock.checkbox" : "stock.text");
        const adapter = model.adapters[control];
        if (!adapter) {
            mount.setAttribute("role", "alert");
            mount.textContent = `Could not load ${field.label}: missing Designer adapter`;
            continue;
        }
        const mountAdapter = ({ mount: render, controlId, valueContract }) => {
                if (typeof render !== "function") throw new Error("Missing mount export");
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
                return render({ root: mount, field, value: draft[field.id],
                    context: { constraints: rules, inputId: `setting-field-${index}`,
                        ...(image ? { validateImage: validImage, setBusy(busy) {
                            uploading = busy;
                            updateSave();
                        } } : {}) },
                    onChange(value) {
                        if (image ? !validImage(value)
                            : rules.type === "boolean" ? typeof value !== "boolean"
                                : rules.type === "string" ? typeof value !== "string"
                                    : false) {
                            throw new Error(`Invalid Designer setting: ${field.id}`);
                        }
                        draft[field.id] = value;
                        messageBox.hidden = true;
                        showError("");
                        updateSave();
                        updateGenerate();
                    } });
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
