const token = new URL(location.href).searchParams.get("token");
let mountIdentity, mountOutputs, mountBadges, adapterContract;
const root = document.getElementById("settings-page");
const tabs = document.querySelector(".tabs");
const errorBox = document.getElementById("page-error");
const saveButton = document.getElementById("save-settings");
const messageBox = document.getElementById("action-message");
let model, currentPage, draft, draftOutputs, draftBadges, saving = false;
let badgeView;
const generate = document.getElementById("generate-canvas");
let generating = false;
let queuedCanvasId = null;
const activeUploads = new Set();
const required = ["canvas.id", "canvas.displayName"];
const scalarAdapters = new Map();
const mounted = new Map();
const pageViews = new Map();
const themeKey = "speckit-designer.theme";
const colorPreference = window.matchMedia?.("(prefers-color-scheme: dark)");
let selectedTheme = null;

function currentTheme() {
    const explicit = document.documentElement.getAttribute("data-theme");
    if (explicit === "dark" || explicit === "light") return explicit;
    return colorPreference?.matches ? "dark" : "light";
}

function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const button = document.getElementById("theme-toggle");
    button.textContent = theme === "dark" ? "☾" : "☀";
    button.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    button.title = button.getAttribute("aria-label");
}

try { selectedTheme = localStorage.getItem(themeKey); } catch { /* storage may be unavailable */ }
if (selectedTheme !== "dark" && selectedTheme !== "light") selectedTheme = null;
applyTheme(selectedTheme ?? (colorPreference?.matches ? "dark" : "light"));
colorPreference?.addEventListener?.("change", (event) => {
    if (!selectedTheme) applyTheme(event.matches ? "dark" : "light");
});
document.getElementById("theme-toggle").addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    selectedTheme = next;
    applyTheme(next);
    try { localStorage.setItem(themeKey, next); } catch { /* storage may be unavailable */ }
});

function outputPathsReady() {
    return Object.values(draftOutputs ?? {}).every((entry) =>
        entry.outputs.every((path) => path.endsWith(".md")));
}

function updateGenerate() {
    const setup = model?.pages.find((page) => page.page === "designer-essentials");
    const generationError = document.getElementById("generation-error");
    const generationNote = document.getElementById("generation-note");
    const failed = model?.pages.find((page) => page.error);
    const missingIdentity = model && !failed && (!setup || setup.enabled === false
        || !required.every((field) => setup.fields?.some((item) => item.id === field)));
    const reason = model?.preview ? "" : model?.generationError
        ? model.generationError
        : failed
        ? `Cannot generate: ${failed.page} could not load. ${failed.error.reason}`
        : model?.generationBlockers?.length
            ? `Cannot generate: ${model.generationBlockers.join("; ")}`
        : missingIdentity ? "Cannot generate: Essentials must contain Canvas ID and Title."
            : model?.generationError ?? "";
    const expectedState = reason === "Generation is already queued for this Designer panel"
        || reason === "Canvas already exists; choose and save a different Canvas ID.";
    generationNote.textContent = queuedCanvasId
        ? reason === "Canvas already exists; choose and save a different Canvas ID."
            && model?.values?.["canvas.id"] === queuedCanvasId
            ? "Canvas generated. Restart the Copilot app to discover and open it. Close this Designer panel before restarting."
            : "Generation queued. After your agent confirms the canvas was generated, close this Designer panel and restart the Copilot app to discover and open it. If generation fails, inspect the output before reopening Designer."
        : expectedState ? reason : "";
    generationNote.hidden = !generationNote.textContent;
    generationError.textContent = expectedState ? "" : reason;
    generationError.hidden = !generationError.textContent;
    generate.disabled = model?.preview || saving || activeUploads.size > 0 || generating
        || !!queuedCanvasId || !outputPathsReady()
        || !model?.handoffId
        || !model.generationAvailable || !setup || !!failed || setup.enabled === false
        || missingIdentity || !!model?.generationBlockers?.length;
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
    if (model?.preview || generate.disabled || !checkReady()) return;
    const providers = model.templates.filter((item) => item.kind === "generated.computed-value-provider")
        .map(({ name, sourceId, hash }) => ({ name, sourceId, hash }));
    generating = true;
    updateSave();
    showError("");
    try {
        if (providers.length && !await confirmProviders(providers)) return;
        const values = structuredClone(draft);
        const outputs = structuredClone(draftOutputs);
        const badges = structuredClone(draftBadges);
        const submittedId = values["canvas.id"];
        let saved;
        try {
            saved = await persistSettings({ values, outputs, badges });
        } catch (error) {
            throw new Error(`Could not save settings: ${error.message}`, { cause: error });
        }
        model = saved;
        const response = await fetch(`/api/generate?token=${encodeURIComponent(token)}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ modelRevision: saved.revision,
                settingsRevision: saved.settingsRevision, values, outputs,
                badges,
                ...(providers.length ? { approvedProviders: providers } : {}) }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Generation failed (${response.status})`);
        if (result.warnings?.length) {
            messageBox.textContent = `Warning: ${result.warnings.join(" ")}`;
            messageBox.hidden = false;
        }
        queuedCanvasId = submittedId;
    } catch (error) {
        showFieldError(error.message);
    } finally {
        generating = false;
        updateSave();
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
    for (const page of model.pages) {
        if (page.page !== currentPage && !pageViews.has(page.page)) continue;
        for (const field of page.fields ?? []) {
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
    }
    return true;
}

function updateSave() {
    const noChanges = model?.persisted
        && JSON.stringify(draft) === JSON.stringify(model.values)
        && JSON.stringify(draftOutputs) === JSON.stringify(model.outputs)
        && JSON.stringify(draftBadges) === JSON.stringify(model.badges);
    saveButton.disabled = model?.preview || saving || generating || activeUploads.size > 0 || !model
        || !model.pages.length || noChanges || !outputPathsReady();
    document.getElementById("save-help").title = noChanges ? "No changes to save" : "";
    if (noChanges) saveButton.setAttribute("aria-description", "No changes to save");
    else saveButton.removeAttribute("aria-description");
    saveButton.textContent = saving ? "Saving..." : "Save";
    saveButton.setAttribute("aria-busy", String(saving));
    root.inert = saving || generating || activeUploads.size > 0;
    for (const tab of tabs.children) tab.disabled = saving || generating || activeUploads.size > 0;
    updateGenerate();
}

async function persistSettings({ values, outputs, badges }) {
    const response = await fetch(`/api/save?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelRevision: model.revision,
            revision: model.settingsRevision, values, outputs, badges }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `Designer save failed (${response.status})`);
    return result;
}

saveButton.addEventListener("click", async () => {
    if (model?.preview || saving || generating || !model || !checkReady()) return;
    saving = true;
    messageBox.hidden = true;
    showError("");
    updateSave();
    try {
        model = await persistSettings({ values: draft, outputs: draftOutputs, badges: draftBadges });
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
    const renderRevision = model.revision;
    if (currentPage && root.childNodes.length) {
        pageViews.set(currentPage, [...root.childNodes]);
    }
    currentPage = pageId;
    for (const tab of tabs.children) {
        const active = tab.dataset.page === pageId;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
    }
    root.setAttribute("aria-labelledby", `page-tab-${pageId}`);
    if (pageViews.has(pageId)) {
        root.replaceChildren(...pageViews.get(pageId));
        if (page.fixedControl === "designer.badges") badgeView.updateOutputs(draftOutputs);
        if (invalidFieldId) {
            const mount = [...root.querySelectorAll("[data-field-id]")]
                .find((item) => item.dataset.fieldId === invalidFieldId);
            if (mount) {
                mount.nextElementSibling.hidden = false;
                mount.parentElement.focus();
            }
        }
        root.setAttribute("aria-busy", "false");
        return true;
    }
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
    if (page.fixedControl === "designer.outputs") {
        mountOutputs({ root, page, phases: model.phases, draftOutputs,
            pipelineOutputs: model.pipelineOutputs, onChange: updateSave });
        root.setAttribute("aria-busy", "false");
        return true;
    }
    if (page.fixedControl === "designer.badges") {
        badgeView = mountBadges({ root, page, phases: model.phases, outputs: draftOutputs,
            badgeTypes: model.badgeTypes ?? [], badgeRules: model.badgeRules ?? [],
            draftBadges, onChange: updateSave });
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
    const identity = page.fixedControl === "designer.identity"
        ? page.fields.filter((field) => ["canvas.id", "canvas.displayName"].includes(field.id)) : [];
    if (identity.length) {
        const handles = mountIdentity({ root: form, fields: identity, values: draft,
            invalidFieldId, onChange(id, value) {
                draft[id] = value;
                messageBox.hidden = true;
                showError("");
                updateSave();
            } });
        for (const [id, handle] of handles) mounted.set(id, handle);
    }
    for (const field of page.fields.filter((item) => !identity.some((fixed) => fixed.id === item.id))) {
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
        const isRetained = () => mount.isConnected
            || pageViews.get(pageId)?.some((node) => node.contains(mount));
        const mountAdapter = (module) => {
                if (model.revision !== renderRevision) return;
                const expected = model.controls.find((item) => item.id === control)?.value;
                adapterContract.validateAdapterModule(module, control, expected, image, object);
                if (!isRetained()) return;
                const handle = module.mount({ root: mount, field, value: draft[field.id],
                    ...(image ? { context: { setBusy(busy) {
                            if (busy) activeUploads.add(field.id);
                            else activeUploads.delete(field.id);
                            updateSave();
                        } } } : {}),
                    onChange(value) {
                            if (model.revision !== renderRevision || !isRetained()) return;
                        adapterContract.validateAdapterChange(value, rules, field.id);
                        draft[field.id] = value;
                        fieldError.hidden = true;
                        messageBox.hidden = true;
                        showError("");
                        updateSave();
                        updateGenerate();
                    } });
                adapterContract.validateAdapterHandle(handle);
                mounted.set(field.id, handle);
        };
        const showAdapterError = (error) => {
            if (model.revision !== renderRevision) return;
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
    if (tab && tab.dataset.page !== currentPage) renderPage(tab.dataset.page);
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
    if (buttons[next].dataset.page !== currentPage) {
        renderPage(buttons[next].dataset.page);
        buttons[next].focus();
    }
});

function applyState(next) {
    if (!Array.isArray(next.pages)) throw new Error("Designer returned invalid settings pages");
    const changed = !model || next.revision !== model.revision;
    if (changed) {
        model = next;
        pageViews.clear();
        mounted.clear();
        badgeView = undefined;
        root.replaceChildren();
        document.getElementById("preview-banner").hidden = !model.preview;
        document.getElementById("save-help").hidden = !!model.preview;
        generate.hidden = !!model.preview;
        draft = structuredClone(model.values);
        draftOutputs = structuredClone(model.outputs ?? Object.fromEntries(
            (model.phases ?? []).map((id) => [id, { outputs: [], view: null }])));
        draftBadges = structuredClone(model.badges ?? []);
        tabs.replaceChildren();
        const compositionError = document.getElementById("composition-error");
        compositionError.textContent = (model.compositionErrors ?? []).join("; ");
        compositionError.hidden = !compositionError.textContent;
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
        if (selected) renderPage(selected.page);
        else {
            currentPage = null;
            root.setAttribute("aria-busy", "false");
            root.replaceChildren(element("h1", "No Designer pages registered"),
                element("p", "This preset composition contains no settings pages."));
        }
        updateSave();
        updateGenerate();
    }
}

const status = document.getElementById("conn-status");
let connectionError = "";
function connectionStatus(state) {
    status.className = `conn conn-${state}`;
    status.textContent = state === "live" ? "Live" : state === "connecting" ? "Connecting" : "Disconnected";
}
async function checkConnection() {
    try {
        const response = await fetch(`/api/state?token=${encodeURIComponent(token)}`,
            { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Designer connection check failed (${response.status})`);
        const latest = await response.json();
        if (typeof latest?.generationAvailable !== "boolean"
            || (latest.generationError !== null && typeof latest.generationError !== "string")) {
            throw new Error("Designer connection check returned invalid generation state");
        }
        if (model) {
            model.generationAvailable = latest.generationAvailable;
            model.generationError = latest.generationError;
            updateGenerate();
            connectionStatus("live");
            if (connectionError && errorBox.textContent === connectionError) showError("");
            connectionError = "";
        }
    } catch (error) {
        connectionStatus("lost");
        const next = `Designer connection interrupted: ${error.message}. Unsaved edits remain in this panel.`;
        if (connectionError !== next && !errorBox.textContent) showError(next);
        connectionError = next;
    }
}
const connectionTimer = setInterval(() => { void checkConnection(); }, 10000);
window.addEventListener("pagehide", () => clearInterval(connectionTimer));
try {
    [{ mountIdentity }, { mountOutputs }, { mountBadges }, adapterContract] = await Promise.all([
        import(`/ui/identity-control.js?token=${encodeURIComponent(token)}`),
        import(`/ui/outputs-control.js?token=${encodeURIComponent(token)}`),
        import(`/ui/badges-control.js?token=${encodeURIComponent(token)}`),
        import(`/ui/control-adapter-contract.js?token=${encodeURIComponent(token)}`),
    ]);
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
    connectionStatus("live");
} catch (error) {
    root.setAttribute("aria-busy", "false");
    root.replaceChildren(element("h1", "Settings unavailable"));
    connectionStatus("lost");
    showError(error.message);
}
