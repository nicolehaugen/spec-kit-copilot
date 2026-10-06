const { renderMarkdown } = await import(`./markdown.mjs${new URL(import.meta.url).search}`);
const { mountPageAssets, createStockImageRenderer } = await import(
    `./page-assets.mjs${new URL(import.meta.url).search}`);
const token = new URL(location.href).searchParams.get("token");
const imageRegistration = document.getElementById("stock-image-registration");
const renderStockImage = createStockImageRenderer(imageRegistration, token);
for (const root of document.querySelectorAll("[data-stock-image]")) {
    void renderStockImage(root, { id: root.dataset.stockImage, label: root.dataset.imageAlt },
        { file: root.dataset.imageFile }, root.dataset.imageAlt, root.dataset.imageClass);
}
const textRegistration = document.getElementById("stock-text-registration");
if (textRegistration) {
    for (const root of document.querySelectorAll("[data-stock-text]")) {
        void (async () => {
            try {
                const { mount, controlId, valueContract } = await import(
                    `${textRegistration.dataset.module}?token=${encodeURIComponent(token)}`);
                if (controlId !== "stock.text" || JSON.stringify(valueContract) !== '{"type":"string"}'
                    || typeof mount !== "function") throw new Error("Incompatible stock.text adapter");
                const field = { id: root.dataset.fieldId, label: root.dataset.textLabel };
                const value = root.textContent;
                await mount({ root, field, value,
                    context: { slot: root.dataset.stockText, className: "" } });
            } catch (error) {
                root.setAttribute("role", "alert");
                root.textContent = `Generated text could not render: ${error.message}`;
            }
        })();
    }
}
async function mountGeneratedControl(root) {
    const field = { id: root.dataset.controlId, label: root.dataset.fieldLabel };
    try {
        const { mount, controlId, valueContract } = await import(`${root.dataset.module}?token=${encodeURIComponent(
            new URL(import.meta.url).searchParams.get("token"))}`);
        if (typeof mount !== "function") throw new Error("Missing mount export");
        const expected = JSON.parse(root.dataset.contract);
        if (controlId !== root.dataset.controlType || valueContract?.type !== expected.type
            || JSON.stringify(Object.entries(valueContract.properties ?? {}).sort())
                !== JSON.stringify(Object.entries(expected.properties).sort())) {
            throw new Error("Incompatible control ID or value contract");
        }
        await mount({ root, field, value: JSON.parse(root.dataset.value),
            values: model?.controlValues?.[field.id] ?? {},
            readValues: () => ({ ...(model?.controlValues?.[field.id] ?? {}) }) });
    } catch (error) {
        root.setAttribute("role", "alert");
        root.textContent = `Generated control could not render: ${error.message}`;
    }
}
const $ = (id) => document.getElementById(id);
const dialogContracts = $("generated-dialog-contracts");
const dialogs = JSON.parse(dialogContracts?.dataset.dialogs ?? "[]");
const phaseDialogs = JSON.parse(dialogContracts?.dataset.phaseDialogs ?? "[]");
const buttons = JSON.parse(dialogContracts?.dataset.buttons ?? "[]");
const buttonControls = JSON.parse(dialogContracts?.dataset.buttonControls ?? "[]");
const dialogCache = new Map();
let buttonMounts = [], setupBusy = false, activeSetupPlan = null;

async function showGeneratedDialog(name, context = {}) {
    const registration = dialogs.find((item) => item.id === name);
    if (!registration) throw new Error(`Unregistered generated dialog: ${name}`);
    let entry = dialogCache.get(name);
    if (!entry) {
        const response = await fetch(`/dialogs/${name}.json?token=${encodeURIComponent(token)}`);
        if (!response.ok) throw new Error(`Could not load generated dialog ${name} (${response.status})`);
        const definition = await response.json();
        const module = await import(`/dialogs/${registration.adapter}.mjs?token=${encodeURIComponent(token)}`);
        if (definition.id !== name || definition.adapter !== registration.adapter
            || module.dialogId !== "stock.dialog" || module.contractVersion !== 1
            || typeof module.mount !== "function") throw new Error(`Incompatible generated dialog: ${name}`);
        entry = { definition, mount: module.mount };
        dialogCache.set(name, entry);
    }
    if ($("generated-dialog-root").childElementCount) throw new Error("A generated dialog is already open");
    const instance = entry.mount({ root: $("generated-dialog-root"), definition: entry.definition,
        context, onDecision: () => {} });
    if (!instance || typeof instance.dispose !== "function" || !instance.result?.then) {
        throw new Error(`Invalid dialog adapter result: ${name}`);
    }
    try {
        const result = await instance.result;
        if (!["confirmed", "cancelled"].includes(result)) throw new Error("Invalid generated dialog decision");
        return result === "confirmed";
    } finally {
        instance.dispose();
    }
}

async function mountGeneratedButtons() {
    if (!buttons.length) return;
    for (const definition of [...buttons].sort((a, b) => a.order - b.order)) {
        const control = buttonControls.find((item) => item.id === definition.control);
        if (!control) throw new Error(`Missing button control: ${definition.control}`);
        const module = await import(`/buttons/${control.adapter}.mjs?token=${encodeURIComponent(token)}`);
        if (module.controlId !== control.id || module.contractVersion !== 1
            || typeof module.mount !== "function") throw new Error(`Incompatible button adapter: ${control.id}`);
        const root = definition.page === "setup" ? $("setup-actions")
            : document.querySelector(`[data-workflow-slot="${definition.slot}"]`);
        if (!root) throw new Error(`Missing generated button slot: ${definition.slot}`);
        const mountRoot = document.createElement("span");
        root.append(mountRoot);
        const activate = async () => {
            try {
                if (definition.control === "project.setup-button") {
                    if (setupBusy) return;
                    setupBusy = true;
                    try { await api("/api/setup/start", {}); await refresh(); }
                    finally {
                        setupBusy = false;
                        const button = $("setup-actions").querySelector("button");
                        if (button) button.disabled = ["initializing", "installing"]
                            .includes(model?.setup?.stage);
                    }
                } else if (definition.control === "dialog.trigger") {
                    if (await showGeneratedDialog(definition.dialog)) {
                        message(`${definition.label} confirmed.`, "canvas-message");
                    }
                } else throw new Error("Unknown generated button action");
            } catch (error) {
                message(error.message, definition.page === "setup" ? "setup-status" : "canvas-message", true);
            }
        };
        const instance = module.mount({ root: mountRoot, definition,
            ...(definition.control === "project.setup-button" ? { onSetup: activate } : { onTrigger: activate }) });
        if (typeof instance?.dispose !== "function") throw new Error("Invalid button instance");
        buttonMounts.push(instance);
    }
}

function renderSetup() {
    const setup = model?.setup;
    const visible = model?.showSetup && !setup?.ready;
    $("setup-surface").hidden = !visible;
    if (!visible) { activeSetupPlan = null; return; }
    const status = $("setup-status");
    status.textContent = setup.error ?? ({
        initializing: "Initializing Specify in Copilot skills mode. Check chat for progress.",
        "awaiting-confirmation": "Review the complete package batch before installation.",
        installing: "Installing confirmed packages. Check chat for progress.",
        failed: "Setup failed. Check chat, then retry.",
        cancelled: "Installation cancelled. No additional packages were installed. Select setup to try again.",
    }[setup.stage] ?? "");
    status.hidden = !status.textContent;
    status.classList.toggle("workflow-error", Boolean(setup.error));
    const button = $("setup-actions").querySelector("button");
    if (button) button.disabled = setupBusy || ["initializing", "installing"].includes(setup.stage);
    if (setup.stage === "awaiting-confirmation" && setup.planId
        && activeSetupPlan !== setup.planId) {
        activeSetupPlan = setup.planId;
        const setupButton = buttons.find((item) => item.id === "generated-setup-button");
        if (!setupButton) throw new Error("The setup button registration is missing");
        void (async () => {
            try {
                const approved = await showGeneratedDialog(setupButton.dialog, {
                    pendingPackages: setup.pending.map((entry) => ({
                        name: `${entry.kind.slice(0, -1)}: ${entry.id}`,
                        version: entry.version,
                        source: entry.source === "local" ? entry.path
                            : `${entry.source}: ${entry.downloadUrl ?? entry.catalogId}`,
                        community: entry.source !== "default",
                    })),
                });
                await api("/api/setup/confirm", { planId: setup.planId, confirmed: approved });
                await refresh();
            } catch (error) {
                message(`Setup confirmation failed: ${error.message}`, "setup-status", true);
            } finally { activeSetupPlan = null; }
        })();
    }
}
let phaseControl;
const drafts = new Map();
const failedValueDrafts = new Map();
const failedPatches = new Map();
let model, current = 0, sending = false, saving = Promise.resolve(), refreshSequence = 0;
let viewer = null, timer, constitutionTimer, constitutionDraft, saveFailure = null,
    pendingValueSaves = 0, workflowQuery = "";
const THEME_STORAGE_KEY = "speckit-generated-canvas.theme";
const placements = JSON.parse($("generated-field-placements")?.dataset.placements ?? "[]");
const mountedFields = new Map();
const pendingFieldDrafts = new Map();
let pageSelection = 0, mountedPage = "workflow", renderedPageValues = null;

function placementValue(placement) {
    const field = model?.valueFields?.find((entry) => entry.id === placement.field);
    return {
        field: { id: placement.field, label: field?.label ?? placement.label ?? placement.field },
        value: pendingFieldDrafts.get(placement.field)?.value
            ?? failedValueDrafts.get(placement.field)?.value ?? field?.value ?? placement.value,
        schema: field?.schema ?? placement.schema,
        editable: Boolean(field ? field.editable : placement.editable),
    };
}

function disposeFieldMounts(page) {
    for (const [id, mounted] of mountedFields) {
        if (mounted.page !== page) continue;
        mountedFields.delete(id);
        mounted.disposed = true;
        try { mounted.instance?.dispose?.(); }
        catch (error) { message(`Generated control could not be disposed: ${error.message}`, "canvas-message", true); }
        mounted.root.remove();
    }
}

function declaredFieldTargets(root, page, selector, slotProperty) {
    const targets = new Map();
    const needed = new Set(placements.filter((entry) => entry.page === page).map((entry) => entry.slot));
    for (const target of root.querySelectorAll(selector)) {
        const slot = target.dataset[slotProperty];
        if (!needed.has(slot)) continue;
        if (targets.has(slot)) throw new Error(`Duplicate generated field slot ${slot} on ${page}`);
        targets.set(slot, target);
    }
    for (const slot of needed) {
        if (!targets.has(slot)) throw new Error(`Generated page did not render field slot ${slot} on ${page}`);
    }
    return targets;
}

async function mountField(placement, root) {
    const mounted = { page: placement.page, root, placement, instance: null, disposed: false };
    mountedFields.set(placement.id, mounted);
    const state = placementValue(placement);
    mounted.lastValue = JSON.stringify(state.value);
    const onChange = state.editable ? (value) => saveFieldValue(placement.field, value)
        .catch((error) => message(`Value could not be saved: ${error.message} Your edit remains in this panel.`,
            "canvas-message", true)) : undefined;
    try {
        if (placement.control === "stock.image") {
            if (placement.asset) {
                await renderStockImage(root, state.field, placement.asset, state.field.label, "generated-image");
            } else root.replaceChildren();
        } else if (placement.control === "stock.text" || placement.control === "stock.checkbox") {
            const input = state.editable ? document.createElement("input") : null;
            if (input) {
                input.type = placement.control === "stock.checkbox" ? "checkbox" : "text";
                input.className = "phase-input-control";
                input.setAttribute("aria-label", state.field.label);
                if (state.schema?.maxLength && input.type === "text") input.maxLength = state.schema.maxLength;
                input.addEventListener("change", () => onChange(input.type === "checkbox" ? input.checked : input.value));
                root.replaceChildren(input);
            } else {
                root.replaceChildren();
                if (placement.control === "stock.checkbox") {
                    const indicator = document.createElement("input");
                    indicator.type = "checkbox";
                    indicator.disabled = true;
                    indicator.setAttribute("aria-label", state.field.label);
                    root.append(indicator);
                }
            }
            mounted.instance = { update: ({ value }) => {
                if (input) {
                    if (document.activeElement === input || failedValueDrafts.has(placement.field)) return;
                    if (input.type === "checkbox") input.checked = Boolean(value);
                    else input.value = value ?? "";
                } else if (placement.control === "stock.checkbox") root.querySelector("input").checked = Boolean(value);
                else root.textContent = value == null ? "" : String(value);
            } };
            mounted.instance.update(state);
        } else {
            if (!placement.adapter || !/^[a-z][a-z0-9-]{0,79}$/.test(placement.adapter)) {
                throw new Error(`Missing generated adapter for ${placement.field}`);
            }
            const { mount, controlId, valueContract } = await import(
                `/controls/${placement.adapter}.mjs?token=${encodeURIComponent(token)}`);
            if (mounted.disposed) return;
            if (typeof mount !== "function" || controlId !== placement.control
                || valueContract?.type !== state.schema?.type
                || (state.schema?.type === "object" && JSON.stringify(Object.entries(valueContract.properties ?? {}).sort())
                    !== JSON.stringify(Object.entries(state.schema.properties ?? {}).sort()))) {
                throw new Error(`Incompatible generated adapter for ${placement.field}`);
            }
            const values = () => ({ ...(model?.controlValues?.[placement.field] ?? {}) });
            mounted.instance = await mount({ root, field: state.field, value: state.value,
                values: values(), readValues: values, editable: state.editable,
                ...(onChange ? { onChange } : {}) });
            if (mounted.disposed) mounted.instance?.dispose?.();
        }
    } catch (error) {
        if (mounted.disposed) return;
        root.setAttribute("role", "alert");
        root.textContent = `Generated control could not render: ${error.message}`;
    }
}

async function syncFieldMounts(page, root, selector, slotProperty) {
    const targets = declaredFieldTargets(root, page, selector, slotProperty);
    const entries = placements.filter((entry) => entry.page === page);
    const seen = new Set();
    for (const entry of entries) {
        if (seen.has(entry.id)) throw new Error(`Duplicate generated field placement ${entry.id}`);
        seen.add(entry.id);
    }
    const ordered = entries.map((entry, index) => ({ entry, index }))
        .sort((a, b) => a.entry.order - b.entry.order || a.index - b.index);
    for (const { entry } of ordered) {
        const existing = mountedFields.get(entry.id);
        if (existing && existing.root.isConnected) {
            const state = placementValue(entry);
            if (!existing.root.contains(document.activeElement)) {
                if (typeof existing.instance?.update === "function") {
                    try { await existing.instance.update({ field: state.field, value: state.value, values: {
                        ...(model?.controlValues?.[entry.field] ?? {}) },
                        readValues: () => ({ ...(model?.controlValues?.[entry.field] ?? {}) }),
                        editable: state.editable });
                        existing.lastValue = JSON.stringify(state.value);
                    }
                    catch (error) {
                        existing.root.setAttribute("role", "alert");
                        existing.root.textContent = `Generated control could not update: ${error.message}`;
                    }
                } else if (entry.control !== "stock.image" && existing.lastValue !== JSON.stringify(state.value)) {
                    existing.disposed = true;
                    try { existing.instance?.dispose?.(); }
                    catch (error) { message(`Generated control could not be disposed: ${error.message}`, "canvas-message", true); }
                    existing.root.replaceChildren();
                    await mountField(entry, existing.root);
                }
            }
            continue;
        }
        if (existing) {
            existing.disposed = true;
            try { existing.instance?.dispose?.(); }
            catch (error) { message(`Generated control could not be disposed: ${error.message}`, "canvas-message", true); }
        }
        const target = targets.get(entry.slot);
        const mountPoint = document.createElement("div");
        mountPoint.dataset.fieldPlacement = entry.id;
        target.append(mountPoint);
        await mountField(entry, mountPoint);
    }
}

function wireGeneratedPages() {
    const root = $("generated-page");
    if (!root) return;
    const buttons = [...document.querySelectorAll("[data-canvas-page]")];
    for (const button of buttons) button.addEventListener("click", async () => {
        const currentSelection = ++pageSelection;
        const id = button.dataset.canvasPage;
        const workflow = id === "workflow";
        if (mountedPage !== id || !workflow) disposeFieldMounts(mountedPage);
        mountedPage = id;
        const introLogo = document.querySelector('[data-stock-image="workflow.intro"]');
        if (introLogo) introLogo.hidden = !workflow;
        root.hidden = workflow;
        root.replaceChildren();
        renderedPageValues = null;
        root.classList.remove("workflow-error");
        $("workflow-content").hidden = !workflow;
        for (const candidate of buttons) {
            if (candidate === button) candidate.setAttribute("aria-current", "page");
            else candidate.removeAttribute("aria-current");
        }
        if (workflow) {
            try { await syncFieldMounts("workflow", $("workflow-content") ?? document,
                "[data-workflow-slot]", "workflowSlot"); }
            catch (error) { message(`Generated workflow could not render: ${error.message}`, "canvas-message", true); }
            return;
        }
        const registration = [...document.querySelectorAll("[data-generated-renderer]")]
            .find((item) => item.dataset.generatedRenderer === id);
        try {
            if (!registration) throw new Error(`Missing generated page ${id}`);
            const { renderPage } = await import(`${registration.dataset.module}?token=${encodeURIComponent(token)}`);
            if (currentSelection !== pageSelection) return;
            if (typeof renderPage !== "function") throw new Error(`Invalid renderer for ${id}`);
            const content = document.createElement("div");
            await renderPage({ root: content, canvas: { id: root.dataset.canvasId,
                displayName: root.dataset.canvasTitle },
                values: { ...JSON.parse(registration.dataset.values), ...(model?.pageValues?.[id] ?? {}) } });
            if (currentSelection !== pageSelection) return;
            await mountPageAssets(content, JSON.parse(registration.dataset.assetSlots),
                JSON.parse(registration.dataset.assets),
                (target, asset) => renderStockImage(target,
                    { id: asset.id, label: asset.label }, asset, asset.label, "generated-image"));
            if (currentSelection !== pageSelection) return;
            root.replaceChildren(content);
            await syncFieldMounts(id, content, "[data-field-slot]", "fieldSlot");
            if (currentSelection !== pageSelection) return;
            renderedPageValues = JSON.stringify(model?.pageValues?.[id] ?? {});
        } catch (error) {
            if (currentSelection !== pageSelection) return;
            root.textContent = `Generated page could not render: ${error.message}`;
            root.classList.add("workflow-error");
        }
    });
}

function currentTheme() {
    const explicit = document.documentElement.getAttribute("data-theme");
    if (explicit === "dark" || explicit === "light") return explicit;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const button = $("theme-toggle");
    button.textContent = theme === "dark" ? "☾" : "☀";
    button.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    button.setAttribute("title", button.getAttribute("aria-label"));
}

function wireThemeToggle() {
    let stored = null;
    try { stored = localStorage.getItem(THEME_STORAGE_KEY); } catch { /* storage may be unavailable */ }
    applyTheme(stored === "dark" || stored === "light" ? stored : currentTheme());
    $("theme-toggle").addEventListener("click", () => {
        const next = currentTheme() === "dark" ? "light" : "dark";
        applyTheme(next);
        try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* storage may be unavailable */ }
    });
}

function setConnectionStatus(status) {
    const pill = $("connection-status");
    pill.className = status === "live" ? "conn conn-live" : "conn conn-lost";
    pill.textContent = status === "live" ? "Live" : "Disconnected";
}

function message(text, id = "canvas-message", error = false) {
    $(id).textContent = text;
    $(id).classList.toggle("workflow-error", error);
    if (id === "setup-status") $(id).hidden = false;
}
function displayValue(value) {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
}
function renderValues() {
    const container = $("canvas-value-list");
    if (!container || !model) return;
    $("canvas-value-errors").textContent = Object.values(model.valueErrors).join(" ");
    $("canvas-values").hidden = !model.valueFields.length && !Object.keys(model.valueErrors).length;
    const active = document.activeElement;
    const editing = active?.closest?.("[data-edit-value]");
    const draft = editing && {
        id: editing.dataset.editValue,
        values: [...editing.querySelectorAll("input, select")].map((input) =>
            ({ property: input.dataset.property, value: input.value, checked: input.checked })),
        property: active.dataset.property,
        selectionStart: active instanceof HTMLInputElement && active.type === "text"
            ? active.selectionStart : null,
        selectionEnd: active instanceof HTMLInputElement && active.type === "text"
            ? active.selectionEnd : null,
    };
    container.replaceChildren();
    const groups = new Map();
    for (const field of model.valueFields) {
        const groupId = field.section?.id ?? "";
        let group = groups.get(groupId);
        if (!group) {
            group = document.createElement("div");
            if (field.section) {
                const heading = document.createElement("h3");
                heading.textContent = field.section.title;
                group.append(heading);
            }
            groups.set(groupId, group);
            container.append(group);
        }
        const row = document.createElement("div");
        row.className = "field";
        const label = document.createElement("label");
        label.className = "field-label";
        label.textContent = field.label;
        row.append(label);
        if (!field.editable) {
            const output = document.createElement("div");
            output.dataset.fieldId = field.id;
            output.textContent = displayValue(field.value);
            row.append(output);
        } else {
            const editor = document.createElement("div");
            editor.dataset.editValue = field.id;
            const retained = failedValueDrafts.get(field.id);
            const value = retained ? retained.value : field.value;
            if (field.schema.type === "boolean") {
                const input = document.createElement("input");
                input.type = "checkbox";
                input.checked = value;
                input.id = `value-${field.id}`;
                label.htmlFor = input.id;
                editor.append(input);
            } else if (field.schema.type === "object") {
                for (const [key, options] of Object.entries(field.schema.properties)) {
                    const property = document.createElement("label");
                    property.textContent = key;
                    const select = document.createElement("select");
                    select.className = "phase-input-control";
                    select.dataset.property = key;
                    select.setAttribute("aria-label", `${field.label}: ${key}`);
                    for (const option of options) {
                        const item = document.createElement("option");
                        item.value = option;
                        item.textContent = option;
                        select.append(item);
                    }
                    select.value = value[key];
                    property.append(select);
                    editor.append(property);
                }
            } else {
                const input = document.createElement("input");
                input.type = "text";
                input.className = "phase-input-control";
                input.maxLength = field.schema.maxLength;
                input.value = value;
                input.id = `value-${field.id}`;
                label.htmlFor = input.id;
                editor.append(input);
            }
            row.append(editor);
        }
        group.append(row);
    }
    if (draft) {
        const editor = [...container.querySelectorAll("[data-edit-value]")]
            .find((entry) => entry.dataset.editValue === draft.id);
        if (editor) {
            const inputs = [...editor.querySelectorAll("input, select")];
            for (const [index, input] of inputs.entries()) {
                const retained = draft.values[index];
                if (!retained || retained.property !== input.dataset.property) continue;
                if (input.type === "checkbox") input.checked = retained.checked;
                else input.value = retained.value;
            }
            const focused = inputs.find((input) => input.dataset.property === draft.property) ?? inputs[0];
            focused?.focus({ preventScroll: true });
            if (focused instanceof HTMLInputElement && focused.type === "text"
                && draft.selectionStart !== null && draft.selectionEnd !== null) {
                focused.setSelectionRange(draft.selectionStart, draft.selectionEnd);
            }
        }
    }
}
function editValue(element) {
    const row = element.closest("[data-edit-value]");
    if (!row || !model) return;
    const field = model.valueFields.find((entry) => entry.id === row.dataset.editValue && entry.editable);
    if (!field) return;
    let value;
    if (field.schema.type === "boolean") value = row.querySelector("input").checked;
    else if (field.schema.type === "object") {
        value = Object.fromEntries([...row.querySelectorAll("[data-property]")]
            .map((input) => [input.dataset.property, input.value]));
    } else value = row.querySelector("input").value;
    return saveFieldValue(field.id, value);
}
function saveFieldValue(id, value) {
    const field = model?.valueFields.find((entry) => entry.id === id && entry.editable);
    if (!field) return Promise.reject(new Error(`Field ${id} is not editable.`));
    const draft = { value };
    pendingFieldDrafts.set(id, draft);
    const pageRoot = mountedPage === "workflow"
        ? $("workflow-content") ?? document : $("generated-page")?.firstElementChild;
    if (pageRoot && placements.some((entry) => entry.page === mountedPage && entry.field === id)) {
        void syncFieldMounts(mountedPage, pageRoot,
            mountedPage === "workflow" ? "[data-workflow-slot]" : "[data-field-slot]",
            mountedPage === "workflow" ? "workflowSlot" : "fieldSlot")
            .catch((error) => message(`Generated field could not update: ${error.message}`, "canvas-message", true));
    }
    if (timer) { clearTimeout(timer); timer = null; saveInputs(); }
    pendingValueSaves++;
    saving = saving.catch(() => {}).then(async () => {
        if (saveFailure) throw saveFailure;
        const result = await api("/api/values", { id: field.id, value, revision: model.revision });
        model.revision = result.revision;
        failedValueDrafts.delete(field.id);
        if (pendingFieldDrafts.get(id) === draft) pendingFieldDrafts.delete(id);
    }).catch((error) => {
        failedValueDrafts.set(field.id, { value, error });
        if (pendingFieldDrafts.get(id) === draft) pendingFieldDrafts.delete(id);
        throw error;
    }).finally(() => { pendingValueSaves--; });
    saving.catch(() => {});
    return saving.then(() => refresh());
}
async function api(path, input) {
    const response = await fetch(path, {
        headers: { "x-canvas-token": token, ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(input === undefined ? {} : { method: "POST", body: JSON.stringify(input) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status}).`);
    return result;
}
const workflowPhases = () => model?.phases.filter((phase) => !phase.project) ?? [];
const phase = () => workflowPhases()[current];
const creationPhase = () => workflowPhases().find((step) => step.output?.includes("<slug>")) ?? workflowPhases()[0];
const constitution = () => model?.phases.find((entry) => entry.project);
const draftKey = (step, item = model.selected) => JSON.stringify([step.project ? "project" : item, step.id]);
function remember(step, value) {
    const key = draftKey(step);
    drafts.set(key, value);
    return { item: step.project ? "project" : model.selected, phase: step.id, value };
}
function persist(patch) {
    const parts = [];
    if (Object.hasOwn(patch, "selected") || Object.hasOwn(patch, "name") || Object.hasOwn(patch, "slug")) {
        parts.push([`identity:${patch.selected ?? model.selected}`, {
            ...(Object.hasOwn(patch, "selected") ? { selected: patch.selected } : {}),
            ...(Object.hasOwn(patch, "name") ? { name: patch.name } : {}),
            ...(Object.hasOwn(patch, "slug") ? { slug: patch.slug } : {}),
        }]);
    }
    if (patch.draft) parts.push([`draft:${JSON.stringify([patch.draft.item, patch.draft.phase])}`,
        { draft: patch.draft }]);
    saving = saving.catch(() => {}).then(async () => {
        const saved = await api("/api/state", { revision: model.revision, ...patch });
        model.revision = saved.revision;
        for (const [key] of parts) failedPatches.delete(key);
        if (!failedPatches.size) saveFailure = null;
    }).catch((error) => {
        for (const [key, value] of parts) failedPatches.set(key, value);
        saveFailure = error;
        message(`Inputs could not be saved: ${error.message} Your draft is retained in this panel.`, "canvas-message", true);
        throw error;
    });
    // Input events have no awaiter; keep rejection observable via feedback and flush().
    saving.catch(() => {});
    return saving;
}
function queueInput() {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; saveInputs(); }, 400);
}
function saveInputs() {
    if (!model) return;
    const selected = phase();
    const patch = model.selected === "__new__"
        ? { name: model.name ?? "", ...(model.userProvidesSlug ? { slug: model.slug } : {}) } : {};
    if (selected) patch.draft = { item: model.selected, phase: selected.id, value: drafts.get(draftKey(selected)) ?? model.drafts[draftKey(selected)] ?? "" };
    return persist(patch);
}
function saveConstitutionDraft() {
    const draft = constitutionDraft;
    if (draft) {
        const pending = persist({ draft });
        pending.then(() => {
            if (constitutionDraft === draft) constitutionDraft = null;
        }, () => {});
        return pending;
    }
}
async function flush() {
    if (timer) { clearTimeout(timer); timer = null; saveInputs(); }
    if (constitutionTimer) {
        clearTimeout(constitutionTimer);
        constitutionTimer = null;
        saveConstitutionDraft();
    }
    await saving;
    if (saveFailure) throw saveFailure;
    if (failedValueDrafts.size) throw failedValueDrafts.values().next().value.error;
}
function phaseState(pendingLabel = () => null) {
    const phases = workflowPhases();
    const selected = phase();
    const status = selected ? model?.statuses[selected.id] : null;
    const item = model?.items.find((entry) => entry.id === model.selected);
    const slug = item?.slug ?? (model?.selected === "__new__" ? model.slug : "");
    const resolveOutput = (output) => slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
        ? output?.replace("<slug>", slug) : output;
    const output = selected
        ? (model.selected === "__new__" && selected.output
            ? resolveOutput(selected.output) : status?.output ?? resolveOutput(selected.output)) : null;
    return { phases: phases.map(({ id, label, output, outputs }) => ({ id, label, output, outputs })),
        statuses: model?.statuses ?? {}, autopilot: model?.autopilot ?? null,
        current: selected ? current : -1, workflow: model?.selected ?? "__new__",
        status: status && output !== status.output
            ? { ...status, artifactAvailability: "unknown", artifactError: null } : status,
        draft: selected ? drafts.get(draftKey(selected)) ?? model.drafts[draftKey(selected)] ?? "" : "",
        output: output ?? null, outputLinks: selected
            ? (selected.outputs ?? []).map((template) => ({
                template, label: resolveOutput(template),
            })) : [],
        slugEditable: Boolean(model?.userProvidesSlug),
        setupPending: Boolean(model?.showSetup && !model?.setup?.ready),
        sending: Boolean(selected && sending && sending.phase === selected.id
            && sending.item === model.selected),
        runLabel: selected ? pendingLabel(selected) : null };
}
function renderStatus() {
    function pendingLabel(step) {
        const item = step.project ? "project" : model.selected;
        if (sending && sending.phase === step.id && sending.item === item) return "Sending...";
        const status = model.statuses[step.id]?.status;
        return status === "Request sent" ? "Request sent..." : status === "Running" ? "Running..." : null;
    }
    function artifactAction(buttonId, noticeId, status) {
        const button = $(buttonId), notice = $(noticeId);
        if (button) button.hidden = status?.artifactAvailability !== "available";
        if (notice) {
            notice.textContent = status?.artifactError ?? (status?.artifactAvailability === "available" ? ""
                : status?.output ? `${status.output} is not available yet. Run the phase, then refresh to check again.`
                : "No artifact is available for this phase yet. Run the phase, then refresh to check again.");
            notice.hidden = !notice.textContent;
        }
    }
    phaseControl?.update(phaseState(pendingLabel));
    const setupPending = model.showSetup && !model.setup?.ready;
    if (constitution()) {
        const status = model.statuses[constitution().id];
        artifactAction("view-constitution", "constitution-artifact-status", status);
        const statusText = status?.status ?? "Not run";
        const card = $("constitution-card");
        if (card.dataset.status !== statusText) {
            card.open = statusText === "Not run" || statusText === "Failed"
                || statusText === "Needs clarification" || Boolean(status?.error);
            card.dataset.status = statusText;
        }
        $("constitution-status").textContent = statusText;
        $("run-constitution").textContent = pendingLabel(constitution()) ?? "Create / update";
        $("send-constitution").textContent = pendingLabel(constitution()) ?? "Run phase";
        $("run-constitution").disabled = setupPending;
        $("run-constitution").title = setupPending ? "Available after setup" : "";
        $("send-constitution").disabled = setupPending;
    }
    renderName();
    renderSlug();
}
function renderPhase() {
    renderStatus();
}
function renderSlug() {
    const input = $("workflow-slug");
    if (!input) return;
    const first = creationPhase();
    input.readOnly = model.selected !== "__new__"
        || Boolean(sending && sending.phase === first?.id)
        || ["Request sent", "Running"].includes(model.statuses[first?.id]?.status);
    input.placeholder = input.readOnly ? "Automatically assigned" : "your-slug";
    $("workflow-slug-label").querySelector(".muted").hidden = input.readOnly;
    if (document.activeElement !== input && !timer) {
        input.value = model.selected === "__new__" ? model.slug
            : model.items.find((entry) => entry.id === model.selected)?.slug ?? "";
    }
}
function renderName() {
    const input = $("workflow-name");
    if (!input) return;
    const first = creationPhase();
    input.readOnly = model.selected !== "__new__"
        || Boolean(sending && sending.phase === first?.id)
        || ["Request sent", "Running"].includes(model.statuses[first?.id]?.status);
    $("workflow-name-label").querySelector(".muted").hidden = input.readOnly;
    if (document.activeElement !== input && !timer) {
        input.value = model.selected === "__new__" ? model.name ?? ""
            : model.items.find((entry) => entry.id === model.selected)?.label ?? "";
    }
}
function renderCollection() {
    if (model.items.length <= 8) workflowQuery = "";
    $("workflow-count").textContent = `(${model.items.length})`;
    $("workflow-identity").hidden = model.selected !== "__new__" || !workflowPhases().length;
    const list = $("workflow-list");
    const scroll = list.scrollTop;
    list.replaceChildren(...model.items.map((entry) => {
        const item = document.createElement("div");
        item.className = `instance-row${entry.id === model.selected ? " active" : ""}`;
        item.setAttribute("role", "listitem");
        item.dataset.search = `${entry.label} ${entry.slug}`.toLowerCase();
        const button = document.createElement("button");
        button.type = "button";
        button.className = "instance-select";
        button.dataset.workflowId = entry.id;
        if (entry.id === model.selected) button.setAttribute("aria-current", "true");
        const identity = document.createElement("span");
        identity.className = "instance-select-main";
        const name = document.createElement("strong");
        name.textContent = entry.label;
        name.title = entry.label;
        identity.append(name);
        if (entry.slug !== entry.label) {
            const slug = document.createElement("code");
            slug.textContent = entry.slug;
            identity.append(slug);
        }
        button.append(identity);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "instance-delete";
        remove.dataset.deleteWorkflowId = entry.id;
        remove.textContent = "Delete";
        remove.setAttribute("aria-label", `Delete ${entry.label}`);
        item.append(button, remove);
        return item;
    }));
    list.hidden = !model.items.length;
    $("workflow-empty").hidden = Boolean(model.items.length);
    list.scrollTop = scroll;
    $("workflow-search-field").hidden = model.items.length <= 8;
    $("workflow-search").value = workflowQuery;
    filterWorkflowList();
}
function filterWorkflowList() {
    const query = workflowQuery.trim().toLowerCase();
    const rows = [...$("workflow-list").children];
    let shown = 0;
    for (const row of rows) {
        row.hidden = !row.dataset.search.includes(query);
        if (!row.hidden) shown++;
    }
    const notice = $("workflow-list-status");
    const missing = model.selected !== "__new__" && !model.items.some((entry) => entry.id === model.selected);
    notice.textContent = missing ? "Selected workflow is unavailable. Choose another or start a new workflow."
        : query ? `${shown} of ${rows.length} workflows match.` : "";
    notice.hidden = !notice.textContent;
}
async function refresh(reconcile = false) {
    const sequence = ++refreshSequence;
    const next = await api(reconcile ? "/api/refresh" : "/api/state", reconcile ? {} : undefined);
    if (sequence !== refreshSequence) return;
    const previous = model;
    model = next;
    renderSetup();
    if (!previous) current = Math.max(0, workflowPhases().findIndex((step) => step.id === model.phase));
    // Do not replace live input text during events or background refresh.
    if (previous && (timer || saveFailure)) {
        model.slug = previous.slug;
        model.name = previous.name;
    }
    const project = constitution();
    if (project && !model.statuses[project.id]?.error
        && $("constitution-message")?.classList.contains("workflow-error")) {
        message("", "constitution-message");
    }
    renderCollection();
    renderValues();
    renderPhase();
    if (mountedPage === "workflow") {
        try { await syncFieldMounts("workflow", $("workflow-content") ?? document,
            "[data-workflow-slot]", "workflowSlot"); }
        catch (error) { message(`Generated workflow could not render: ${error.message}`, "canvas-message", true); }
    } else {
        const root = $("generated-page");
        const page = mountedPage;
        if (root && renderedPageValues !== JSON.stringify(model?.pageValues?.[page] ?? {})
            && !root.contains(document.activeElement) && !failedValueDrafts.size) {
            document.querySelectorAll("[data-canvas-page]").forEach((button) => {
                if (button.dataset.canvasPage === page) button.click();
            });
        } else if (root?.firstElementChild) {
            try { await syncFieldMounts(page, root.firstElementChild, "[data-field-slot]", "fieldSlot"); }
            catch (error) {
                root.textContent = `Generated page could not render: ${error.message}`;
                root.classList.add("workflow-error");
                disposeFieldMounts(page);
            }
        }
    }
}
async function selectPhase(index) {
    if (index < 0 || index >= workflowPhases().length) {
        message(index < 0 ? "You are at the first phase." : "You are at the last phase.", "canvas-message");
        return;
    }
    await flush();
    await persist({ phase: workflowPhases()[index].id });
    current = index;
    renderPhase();
}
async function selectFeature(value) {
    await flush();
    await persist({ selected: value, ...(value === "__new__"
        ? { name: "", ...(model.userProvidesSlug ? { slug: "" } : {}) } : {}) });
    await refresh();
}
async function deleteFeature(itemId) {
    const item = model.items.find((entry) => entry.id === itemId);
    if (!item) throw new Error("This workflow is no longer available. Refresh and try again.");
    const dialog = $("delete-workflow-dialog");
    $("delete-workflow-name").textContent = item.label;
    $("delete-workflow-directory").textContent = item.id;
    dialog.returnValue = "";
    dialog.showModal();
    $("cancel-delete-workflow").focus();
    const listeners = new AbortController();
    const confirmed = await new Promise((resolve) => {
        $("confirm-delete-workflow").addEventListener("click", () => dialog.close("delete"), { signal: listeners.signal });
        $("cancel-delete-workflow").addEventListener("click", () => dialog.close("cancel"), { signal: listeners.signal });
        dialog.addEventListener("close", () => {
            listeners.abort();
            resolve(dialog.returnValue === "delete");
        }, { once: true });
    });
    if (!confirmed) return;
    await flush();
    await api("/api/workflow/delete", { itemId, confirmation: item.slug, revision: model.revision });
    await refresh();
    message(`Deleted ${item.label} and its directory.`);
}
async function send(step, value, target = "canvas-message") {
    if (sending) { message("This request is being sent. Check chat before trying again.", target); return; }
    sending = { phase: step.id, item: step.project ? "project" : model.selected };
    renderStatus();
    let accepted = false;
    try {
        await flush();
        await api("/api/run", { phase: step.id, args: value,
            ...(!step.project ? { itemId: model.selected,
                ...(model.selected === "__new__" && model.name?.trim() ? { name: model.name.trim() } : {}),
                ...(model.selected === "__new__" && $("workflow-slug") && model.slug ? { slug: model.slug } : {}) } : {}) });
        accepted = true;
        if (step.project) {
            $("constitution-dialog").close();
            $("run-constitution").focus({ preventScroll: true });
        }
        message("", step.project ? "canvas-message" : target);
        await refresh();
    } catch (error) {
        message(accepted ? `Request sent, but status could not be refreshed. Check chat before rerunning. ${error.message}` : error.message,
            accepted && step.project ? "canvas-message" : target, true);
    }
    finally {
        sending = false; renderStatus();
    }
}
async function refreshArtifact() {
    const context = viewer;
    if (!context) return;
    if (context.reading) { message("The artifact is already loading.", "artifact-message"); return; }
    context.reading = true;
    message("Loading artifact...", "artifact-message");
    try {
        const query = new URLSearchParams({ phase: context.phase, itemId: context.itemId,
            ...(context.output !== undefined ? { output: context.output } : {}) });
        const result = await api(`/api/artifact?${query}`);
        if (viewer !== context) return;
        $("artifact-path").textContent = result.path;
        $("artifact-content").innerHTML = renderMarkdown(result.content);
        context.loaded = true;
        message(result.message ?? "", "artifact-message");
    } catch (error) {
        if (viewer === context) message(context.loaded
            ? `Could not refresh the artifact. Displayed content is retained. ${error.message}` : error.message, "artifact-message", true);
    } finally { context.reading = false; }
    try { await refresh(); }
    catch (error) { message(`Could not refresh artifact availability: ${error.message}`, "canvas-message", true); }
}
async function openArtifact(step, output) {
    if (!step) throw new Error("Wait for the canvas to connect, then try again.");
    viewer = { phase: step.id, itemId: step.project ? "project" : model.selected,
        ...(output !== undefined ? { output } : {}), loaded: false };
    $("artifact-title").textContent = step.project ? "Constitution" : step.label;
    $("artifact-path").textContent = "";
    $("artifact-content").replaceChildren();
    $("artifact-viewer").showModal();
    $("close-artifact").focus();
    await refreshArtifact();
}
document.addEventListener("input", (event) => {
    if (!model) return;
    if (event.target.id === "workflow-name") {
        model.name = event.target.value;
        queueInput();
    }
    if (event.target.id === "workflow-slug") { model.slug = event.target.value; queueInput(); renderStatus(); }
    if (event.target.id === "constitution-args") {
        constitutionDraft = remember(constitution(), event.target.value);
        clearTimeout(constitutionTimer);
        constitutionTimer = setTimeout(() => { constitutionTimer = null; saveConstitutionDraft(); }, 400);
    }
});
document.addEventListener("change", (event) => {
    if (event.target.closest?.("[data-edit-value]")) {
        editValue(event.target).catch((error) =>
            message(`Value could not be saved: ${error.message} Your edit remains in this panel.`, "canvas-message", true));
    }
});
$("workflow-search").addEventListener("input", (event) => {
    workflowQuery = event.target.value;
    if (model) filterWorkflowList();
});
function requireModel() {
    if (!model) throw new Error("The canvas is connecting. Use Refresh to try again.");
}
document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    (async () => {
        if (button.id === "theme-toggle") {
            return;
        }
        if (button.id === "close-artifact") { $("artifact-viewer").close(); return; }
        if (button.id === "cancel-constitution") { $("constitution-dialog").close(); return; }
        if (button.id === "refresh-state") {
            // Fetch the current revision first; retry locally retained drafts explicitly.
            await saving.catch(() => {});
            await refresh(true);
            if (saveFailure) {
                if (failedPatches.size) {
                    let selectionRetried = false;
                    for (const patch of [...failedPatches.values()]) {
                        await persist(patch);
                        if (Object.hasOwn(patch, "selected")) selectionRetried = true;
                        if (patch.draft === constitutionDraft) constitutionDraft = null;
                    }
                    if (selectionRetried) await refresh();
                } else if (constitutionDraft) await saveConstitutionDraft();
                else await saveInputs();
            }
            if (saveFailure) throw saveFailure;
            message("Canvas refreshed.");
            return;
        }
        requireModel();
        if (button.dataset.deleteWorkflowId) { await deleteFeature(button.dataset.deleteWorkflowId); return; }
        if (button.dataset.workflowId) { await selectFeature(button.dataset.workflowId); return; }
        if (button.id === "new-workflow" || button.id === "create-first-workflow") {
            await selectFeature("__new__");
            $("workflow-name")?.focus();
        }
        else if (button.id === "view-constitution") await openArtifact(constitution());
        else if (button.id === "run-constitution") {
            const key = draftKey(constitution());
            $("constitution-args").value = drafts.get(key) ?? model.drafts[key] ?? "";
            $("constitution-dialog").showModal();
            $("constitution-args").focus();
        } else if (button.id === "send-constitution") await send(constitution(), $("constitution-args").value, "constitution-message");
    })().catch((error) => message(error.message, "canvas-message", true));
});
$("artifact-viewer").addEventListener("close", () => { viewer = null; });
const pipelineRoot = $("workflow-pipeline");
try {
    const { mount, controlId, contractVersion, requiredCapabilities = [] } = await import(
        `${pipelineRoot.dataset.module}?token=${encodeURIComponent(token)}`);
    if (controlId !== "workflow-phases" || contractVersion !== 1 || typeof mount !== "function") {
        throw new Error("Incompatible phase control adapter");
    }
    const capabilities = new Set(["workflow.rows.v1", "workflow.managed-run.v1"]);
    if (!Array.isArray(requiredCapabilities)
        || requiredCapabilities.some((name) => !capabilities.has(name))
        || new Set(requiredCapabilities).size !== requiredCapabilities.length) {
        throw new Error("Phase control adapter requires unavailable host capabilities");
    }
    const initialPhases = JSON.parse(pipelineRoot.dataset.phases);
    phaseControl = mount({ root: pipelineRoot,
        definition: { id: controlId, viewLabels: JSON.parse(pipelineRoot.dataset.viewLabels) },
        state: {
        phases: initialPhases, current: initialPhases.length ? 0 : -1,
        workflow: "__new__", status: null, draft: "",
        output: initialPhases[0]?.output ?? null, outputLinks: [],
        slugEditable: Boolean($("workflow-slug")), sending: false, statuses: {}, autopilot: null,
        setupPending: false,
    },
        actions: {
            select: (index) => { requireModel(); return selectPhase(index); },
            run: (value) => { requireModel(); return send(phase(), value); },
            view: (output) => { requireModel(); return openArtifact(phase(), output); },
            runAt: async (index) => {
                requireModel();
                const step = workflowPhases()[index];
                if (!step) throw new Error("This step is no longer configured.");
                return send(step, drafts.get(draftKey(step)) ?? model.drafts[draftKey(step)] ?? "");
            },
            viewAt: (index, output) => {
                requireModel();
                return openArtifact(workflowPhases()[index], output);
            },
            startManagedRun: async () => {
                requireModel();
                await flush();
                await api("/api/autopilot/start", { itemId: model.selected });
                await refresh();
            },
            stopManagedRun: async () => {
                requireModel();
                await api("/api/autopilot/stop", {});
                await refresh();
            },
            confirmRun: async (selected) => {
                requireModel();
                const binding = phaseDialogs.find((item) =>
                    item.phase === `speckit.${selected?.id?.replace(/^speckit\./, "")}`);
                return !binding || showGeneratedDialog(binding.dialog, {
                    phase: { id: selected.id, label: selected.label },
                });
            },
            reveal: async () => {
                requireModel();
                await flush();
                const result = await api("/api/reveal", { phase: phase().id, itemId: model.selected });
                message(result.message, "canvas-message");
            },
            draft: (value) => {
                if (model) { remember(phase(), value); queueInput(); }
            },
            error: (error) => message(error.message, "canvas-message", true),
        } });
    if (typeof phaseControl?.update !== "function" || typeof phaseControl.dispose !== "function") {
        throw new Error("Phase control adapter must return update and dispose");
    }
} catch (error) {
    message(`Pipeline could not render: ${error.message}`, "canvas-message", true);
    throw error;
}
wireThemeToggle();
wireGeneratedPages();
await mountGeneratedButtons().catch((error) => {
    message(`Generated buttons could not render: ${error.message}`, "canvas-message", true);
    throw error;
});
const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
events.onopen = () => setConnectionStatus("live");
events.onmessage = () => {
    if (!timer && !constitutionTimer) saving.catch(() => {}).then(() => refresh())
        .catch((error) => message(error.message, "canvas-message", true));
    if (viewer) refreshArtifact();
};
events.onerror = () => { setConnectionStatus("lost"); message("Connection interrupted. Drafts are retained; use Refresh if reconnection fails."); };
window.addEventListener("beforeunload", (event) => {
    if (timer || constitutionTimer || saveFailure || pendingValueSaves || failedValueDrafts.size) {
        event.preventDefault();
        event.returnValue = "";
    }
});
window.addEventListener("pagehide", () => {
    events.close();
    phaseControl?.dispose();
    buttonMounts.forEach((instance) => instance.dispose());
    disposeFieldMounts(mountedPage);
});
await refresh().catch((error) => message(error.message, "canvas-message", true));
for (const root of document.querySelectorAll("[data-control-id]")) {
    void mountGeneratedControl(root);
}
