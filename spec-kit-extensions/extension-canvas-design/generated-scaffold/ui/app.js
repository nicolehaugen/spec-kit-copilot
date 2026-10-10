const { renderMarkdown } = await import(`./markdown.mjs${new URL(import.meta.url).search}`);
const { mountPageAssets, createStockImageRenderer } = await import(
    `./page-assets.mjs${new URL(import.meta.url).search}`);
const { validatePhaseAdapter, validatePhaseMount, validatePhaseState,
    validateWorkflowPageState } = await import(
    `/contracts/host-adapter.mjs${new URL(import.meta.url).search}`);
const token = new URL(location.href).searchParams.get("token");
const imageRegistration = document.getElementById("stock-image-registration");
const renderStockImage = createStockImageRenderer(imageRegistration, token);
const textRegistration = document.getElementById("stock-text-registration");
const renderedStock = new WeakSet();
function mountStockPresentation() {
    for (const root of document.querySelectorAll("[data-stock-image]")) {
        if (renderedStock.has(root)) continue;
        renderedStock.add(root);
        void renderStockImage(root, { id: root.dataset.stockImage, label: root.dataset.imageAlt },
            { file: root.dataset.imageFile }, root.dataset.imageAlt, root.dataset.imageClass);
    }
    if (!textRegistration) return;
    for (const root of document.querySelectorAll("[data-stock-text]")) {
        if (renderedStock.has(root)) continue;
        renderedStock.add(root);
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
mountStockPresentation();
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
let buttonMounts = [], setupBusy = false, activeSetupPlan = null, dialogPending = false;

async function showGeneratedDialog(name, context = {}) {
    if (dialogPending) throw new Error("A generated dialog is already open");
    dialogPending = true;
    try {
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
        const root = $("generated-dialog-root");
        if (root.childElementCount) throw new Error("A generated dialog is already open");
        try {
            const instance = await entry.mount({ root, definition: entry.definition,
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
        } finally {
            root.replaceChildren();
        }
    } finally {
        dialogPending = false;
    }
}

async function confirmGeneratedPhase(selected) {
    requireModel();
    const selectedWorkflow = model.selected;
    const binding = phaseDialogs.find((item) =>
        item.phase === `speckit.${selected?.id?.replace(/^speckit\./, "")}`);
    if (!binding) return true;
    const confirmed = await showGeneratedDialog(binding.dialog, {
        phase: { id: selected.id, label: selected.label },
    });
    if (confirmed && model.selected !== selectedWorkflow) {
        throw new Error("Selected workflow or phase changed. Select the phase and retry.");
    }
    return confirmed;
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
        const instance = await module.mount({ root: mountRoot, definition,
            ...(definition.control === "project.setup-button" ? { onSetup: activate } : { onTrigger: activate }) });
        if (typeof instance?.dispose !== "function") throw new Error("Invalid button instance");
        buttonMounts.push(instance);
    }
}

function confirmSetup(setup) {
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
let workflowPage;
const drafts = new Map();
const failedValueDrafts = new Map();
const failedPatches = new Map();
let model, current = 0, sending = false, saving = Promise.resolve(), refreshSequence = 0;
let viewer = null, timer, constitutionTimer, constitutionDraft, saveFailure = null,
    pendingValueSaves = 0, slugTouched = false;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const reservedSlug = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const selectedPending = () => model?.items.some((entry) => entry.id === model.selected && entry.pending);
function slugError() {
    const value = model?.slug ?? "";
    if (!value) return "";
    if (value.length > 100 || !slugPattern.test(value) || reservedSlug.test(value)) {
        return "Use lowercase letters, numbers, and single hyphens; avoid reserved folder names.";
    }
    return "";
}
const THEME_STORAGE_KEY = "speckit-generated-canvas.theme";
const placements = JSON.parse($("generated-field-placements")?.dataset.placements ?? "[]");
const phaseBadgeSlots = JSON.parse($("workflow-pipeline")?.dataset.badgeSlots ?? "[]");
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
        message("", "generated-page-error");
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
    if (id === "canvas-message") {
        if (!error) return;
        id = mountedPage === "workflow" ? "workflow-action-error" : "generated-page-error";
    }
    const notice = $(id) ?? $("workflow-action-error") ?? $("canvas-fatal-error");
    notice.textContent = text;
    notice.hidden = !text;
    notice.setAttribute("role", error ? "alert" : "status");
    notice.classList.toggle("workflow-error", error);
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
        const result = await retryRevision("/api/values", { id: field.id, value });
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
async function api(path, input, options = {}) {
    const response = await fetch(path, {
        headers: { "x-canvas-token": token, ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(input === undefined ? {} : { method: "POST", body: JSON.stringify(input) }),
        ...options,
    });
    const result = await response.json();
    if (!response.ok) {
        const error = new Error(result.error ?? `Request failed (${response.status}).`);
        error.status = response.status;
        error.code = result.code;
        throw error;
    }
    return result;
}
async function retryRevision(path, input, shouldRetry = () => true) {
    try {
        return await api(path, { ...input, revision: model.revision });
    } catch (error) {
        if (error.status !== 409 || error.code !== "STALE_REVISION") throw error;
        await refreshCurrent();
        if (!shouldRetry()) return null;
        try {
            return await api(path, { ...input, revision: model.revision });
        } catch (retryError) {
            if (retryError.status === 409 && retryError.code === "STALE_REVISION") {
                await refreshCurrent();
                if (!shouldRetry()) return null;
                throw new Error("Canvas state is still changing. Try this action again.");
            }
            throw retryError;
        }
    }
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
        const saved = await retryRevision("/api/state", patch);
        model.revision = saved.revision;
        for (const [key] of parts) failedPatches.delete(key);
        if (!failedPatches.size) saveFailure = null;
    }).catch((error) => {
        for (const [key, value] of parts) failedPatches.set(key, value);
        saveFailure = error;
        message(`Inputs could not be saved: ${error.message} Your draft is retained in this panel.`, "workflow-action-error", true);
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
    const patch = selectedPending()
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
    const pending = Boolean(item?.pending || model?.selected === "__new__");
    const slug = pending && !model?.userProvidesSlug ? "" : item?.slug ?? (pending ? model.slug : "");
    const resolveOutput = (output) => slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
        && (!pending || !slugError())
        ? output?.replace("<slug>", slug) : output;
    const output = selected
        ? (pending && selected.output
            ? resolveOutput(selected.output) : status?.output ?? resolveOutput(selected.output)) : null;
    return { phases: phases.map(({ id, label, description, output, outputs }) =>
        ({ id, label, description, output, outputs })),
        statuses: model?.statuses ?? {}, autopilot: model?.autopilot ?? null,
        badgeSlots: phaseBadgeSlots,
        badgeModels: (model?.badges?.selected ?? []).filter((badge) =>
            badge.showIn.includes("phase-card") || badge.targets?.length),
        current: selected ? current : -1, workflow: pending ? "__new__" : model?.selected ?? "__new__",
        status: status && output !== status.output
            ? { ...status, artifactAvailability: "unknown", artifactError: null } : status,
        draft: selected ? drafts.get(draftKey(selected)) ?? model.drafts[draftKey(selected)] ?? "" : "",
        output: output ?? null, outputLinks: selected
            ? (selected.outputs ?? []).map((template) => ({
                template, label: resolveOutput(template),
            })) : [],
        slugEditable: Boolean(model?.userProvidesSlug),
        setupPending: Boolean(model?.showSetup && !model?.setup?.ready),
        blocked: model?.showSetup && !model?.setup?.ready ? "Available after setup"
            : !model?.items.length ? "Choose New workflow to start."
            : !model?.constitutionReady ? "Create a constitution before running a workflow."
                : pending && model?.userProvidesSlug ? slugError() : null,
        sending: Boolean(selected && sending && sending.phase === selected.id
            && sending.item === model.selected),
        runLabel: selected ? pendingLabel(selected) : null };
}
function pendingLabel(step) {
    const item = step.project ? "project" : model.selected;
    if (sending && sending.phase === step.id && sending.item === item) return "Running";
    const status = model.statuses[step.id]?.status;
    return status === "Request sent" || status === "Running" ? "Running" : null;
}
function renderStatus() {
    workflowPage.update(validateWorkflowPageState({ model: structuredClone(model),
        phaseState: phaseState(pendingLabel),
        pendingLabel, sending, setupBusy, inputPending: Boolean(timer),
        slugTouched, slugError: slugError(),
        valueDrafts: Object.fromEntries([...failedValueDrafts, ...pendingFieldDrafts]
            .map(([id, draft]) => [id, draft.value])) }));
}
function renderPhase() {
    renderStatus();
}
async function refresh(reconcile = false) {
    const sequence = ++refreshSequence;
    const next = await api(reconcile ? "/api/refresh" : "/api/state", reconcile ? {} : undefined);
    if (sequence !== refreshSequence) return false;
    const previous = model;
    model = next;
    if (!previous) current = Math.max(0, workflowPhases().findIndex((step) => step.id === model.phase));
    // Do not replace live input text during events or background refresh.
    if (previous && (timer || saveFailure)) {
        if (model.selected === previous.selected) {
            model.slug = previous.slug;
            model.name = previous.name;
            const entry = model.items.find((item) => item.id === model.selected && item.pending);
            if (entry) { entry.slug = model.slug; entry.label = model.name?.trim() || model.slug || "Unstarted workflow"; }
        }
    }
    const project = constitution();
    if (project && !model.statuses[project.id]?.error
        && $("constitution-message")?.classList.contains("workflow-error")) {
        message("", "constitution-message");
    }
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
    return sequence === refreshSequence;
}
let currentRefresh;
function refreshCurrent() {
    if (!currentRefresh) {
        currentRefresh = (async () => {
            while (!(await refresh())) {}
        })().finally(() => { currentRefresh = null; });
    }
    return currentRefresh;
}
async function selectPhase(index) {
    if (index < 0 || index >= workflowPhases().length) return;
    await flush();
    await persist({ phase: workflowPhases()[index].id });
    current = index;
    renderPhase();
}
async function selectFeature(value) {
    await flush();
    await persist({ selected: value });
    await refresh();
}
async function createWorkflow(initial = false) {
    await flush();
    if (initial && model.items.length) return;
    const created = await retryRevision("/api/workflow/new", {},
        initial ? () => !model.items.length : undefined);
    if (!created) return;
    message("", "workflow-action-error");
    slugTouched = false;
    current = 0;
    await refresh();
}
async function deleteFeature(itemId) {
    const item = model.items.find((entry) => entry.id === itemId);
    if (!item) throw new Error("This workflow is no longer available. Refresh and try again.");
    if (item.pending) {
        if (item.hasWorkflowRunHistory && !window.confirm(
            `Discard pending row ${item.label}? This removes its draft and run history only. No workflow directory will be deleted.`
        )) return;
        await flush();
        await retryRevision("/api/workflow/pending/remove", { itemId,
            ...(item.hasWorkflowRunHistory ? { confirmation: "discard" } : {}) });
        await refresh();
        message(`Removed ${item.label}. No directory was created.`);
        return;
    }
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
    await retryRevision("/api/workflow/delete", { itemId, confirmation: item.slug });
    await refresh();
    message(`Deleted ${item.label} and its directory.`);
}
async function send(step, value, target = "phase-action-error") {
    if (step.project && !model.constitutionReady && !value.trim()) {
        message("Enter project principles before creating the constitution.", target, true);
        $("constitution-args")?.focus();
        return;
    }
    if (!step.project && !model.constitutionReady) {
        message("Create a constitution before starting a workflow.", target, true);
        return;
    }
    if (!step.project && selectedPending() && model.userProvidesSlug && slugError()) {
        message(slugError(), target, true);
        $("workflow-slug")?.focus();
        return;
    }
    if (sending) { message("This request is being sent. Check chat before trying again.", target); return; }
    const previous = model.statuses[step.id];
    if ((previous?.artifactAvailability === "available"
        || ["Completed", "Failed"].includes(previous?.status))
        && !window.confirm("Rerun will overwrite the artifact, with valid content preserved. Proceed?")) return;
    sending = { phase: step.id, item: step.project ? "project" : model.selected };
    renderStatus();
    let accepted = false;
    let runSignal;
    try {
        await flush();
        runSignal = AbortSignal.timeout(30_000);
        await api("/api/run", { phase: step.id, args: value,
            ...(!step.project ? { itemId: model.selected,
                ...(selectedPending() && model.name?.trim() ? { name: model.name.trim() } : {}),
                ...(selectedPending() && model.userProvidesSlug && model.slug ? { slug: model.slug } : {}) } : {}) },
        { signal: runSignal });
        accepted = true;
        if (step.project) {
            $("constitution-dialog")?.close();
            $("run-constitution")?.focus({ preventScroll: true });
        }
        message("", target);
        await refresh();
    } catch (error) {
        message(accepted ? `Request sent, but status could not be refreshed. Check chat before rerunning. ${error.message}`
            : runSignal?.aborted ? "Run request timed out. It may have been sent; check chat before trying again."
                : error.message,
            accepted && step.project ? "workflow-action-error" : target, true);
    }
    finally {
        sending = false; renderStatus();
    }
}
async function refreshArtifact(initial) {
    const context = viewer;
    if (!context) return;
    if (context.reading) { message("The artifact is already loading.", "artifact-message"); return; }
    context.reading = true;
    message("Loading artifact...", "artifact-message");
    try {
        const query = new URLSearchParams({ phase: context.phase, itemId: context.itemId,
            ...(context.output !== undefined ? { output: context.output } : {}) });
        const result = initial ?? await api(`/api/artifact?${query}`);
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
    catch (error) { message(`Could not refresh artifact availability: ${error.message}`, "artifact-message", true); }
}
async function openArtifact(step, output) {
    if (!step) throw new Error("Wait for the canvas to connect, then try again.");
    const itemId = step.project ? "project" : model.selected;
    const query = new URLSearchParams({ phase: step.id, itemId,
        ...(output !== undefined ? { output } : {}) });
    let result;
    try {
        result = await api(`/api/artifact?${query}`);
    } catch (error) {
        if (error.status !== 404) throw error;
        await api("/api/reveal", { phase: step.id, itemId,
            ...(output !== undefined ? { output } : {}) });
        return;
    }
    viewer = { phase: step.id, itemId, ...(output !== undefined ? { output } : {}), loaded: false };
    $("artifact-title").textContent = step.project ? "Constitution" : step.label;
    $("artifact-path").textContent = "";
    $("artifact-content").replaceChildren();
    $("artifact-viewer").showModal();
    $("close-artifact").focus();
    await refreshArtifact(result);
}
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
            message("", "workflow-action-error");
            return;
        }
    })().catch((error) => message(error.message, "workflow-action-error", true));
});
$("artifact-viewer").addEventListener("close", () => { viewer = null; });
const pipelineRoot = $("workflow-pipeline");
const workflowRoot = $("workflow-content");
try {
    if (!workflowRoot?.dataset.pageModule || !workflowRoot.dataset.pageDefinition) {
        throw new Error("Missing Workflow page adapter registration");
    }
    const adapter = await import(`${pipelineRoot.dataset.module}?token=${encodeURIComponent(token)}`);
    const mount = validatePhaseAdapter(adapter);
    const { controlId } = adapter;
    const initialPhases = JSON.parse(pipelineRoot.dataset.phases);
    const mountPhase = (root, initialState) => {
        validatePhaseState(initialState);
        phaseControl = mount({ root,
        definition: { id: controlId, viewLabels: JSON.parse(pipelineRoot.dataset.viewLabels) },
        state: initialState,
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
            confirmRun: confirmGeneratedPhase,
            reveal: async () => {
                requireModel();
                await flush();
                await api("/api/reveal", { phase: phase().id, itemId: model.selected });
                message("", "phase-action-error");
            },
            draft: (value) => {
                if (model) { remember(phase(), value); queueInput(); }
            },
            error: (error) => message(error.message, "phase-action-error", true),
        } });
        return validatePhaseMount(phaseControl);
    };
    const initialState = {
        phases: initialPhases, current: initialPhases.length ? 0 : -1,
        workflow: "__new__", status: null, draft: "",
        output: initialPhases[0]?.output ?? null, outputLinks: [],
        badgeSlots: phaseBadgeSlots, badgeModels: [],
        slugEditable: false, sending: false, statuses: {}, autopilot: null,
        setupPending: false,
    };
    {
        const pageModule = await import(`${workflowRoot.dataset.pageModule}?token=${encodeURIComponent(token)}`);
        if (pageModule.pageId !== "workflow" || pageModule.contractVersion !== 1
            || typeof pageModule.mount !== "function") {
            throw new Error("Incompatible Workflow page adapter");
        }
        workflowPage = await pageModule.mount({
            root: workflowRoot, definition: JSON.parse(workflowRoot.dataset.pageDefinition),
            state: validateWorkflowPageState({ model: null, phaseState: initialState }),
            actions: {
                selectWorkflow: (id) => { requireModel(); return selectFeature(id); },
                createWorkflow: async () => {
                    requireModel();
                    await createWorkflow();
                },
                deleteWorkflow: (id) => { requireModel(); return deleteFeature(id); },
                selectPhase: (index) => { requireModel(); return selectPhase(index); },
                run: (index, value) => {
                    requireModel();
                    const step = workflowPhases()[index];
                    if (!step) throw new Error("This phase is no longer configured");
                    return send(step, value);
                },
                view: (index, output) => {
                    requireModel();
                    return openArtifact(workflowPhases()[index], output);
                },
                saveDraft: (index, value) => {
                    requireModel();
                    const step = workflowPhases()[index];
                    if (!step) throw new Error("This phase is no longer configured");
                    remember(step, value); queueInput();
                },
                runConstitution: (value) => {
                    requireModel();
                    return send(constitution(), value, "constitution-message");
                },
                viewConstitution: () => { requireModel(); return openArtifact(constitution()); },
                constitutionDraft: () => {
                    requireModel();
                    const step = constitution();
                    if (!step) throw new Error("Constitution is not configured");
                    const key = draftKey(step);
                    return drafts.get(key) ?? model.drafts[key] ?? "";
                },
                saveValue: (id, value) => { requireModel(); return saveFieldValue(id, value); },
                setIdentity: (field, value) => {
                    requireModel();
                    if (field !== "name" && field !== "slug") throw new Error("Unknown workflow identity field");
                    model[field] = value;
                    const entry = model.items.find((item) => item.id === model.selected && item.pending);
                    if (entry) {
                        entry.slug = model.slug;
                        entry.label = model.name?.trim() || entry.slug || "Unstarted workflow";
                    }
                    queueInput();
                    renderStatus();
                },
                setConstitutionDraft: (value) => {
                    requireModel();
                    const step = constitution();
                    if (!step) throw new Error("Constitution is not configured");
                    constitutionDraft = remember(step, value);
                    clearTimeout(constitutionTimer);
                    constitutionTimer = setTimeout(() => {
                        constitutionTimer = null;
                        saveConstitutionDraft();
                    }, 400);
                },
                touchSlug: () => {
                    requireModel();
                    if (selectedPending()) { slugTouched = true; renderStatus(); }
                },
                confirmSetup, clearSetupPlan: () => { activeSetupPlan = null; },
                mountPhase,
                showDialog: showGeneratedDialog,
                error: (error) => message(error.message, "workflow-action-error", true),
            },
        });
        if (typeof workflowPage?.update !== "function" || typeof workflowPage.dispose !== "function") {
            throw new Error("Workflow page adapter must return update and dispose");
        }
        mountStockPresentation();
    }
} catch (error) {
    message(`Pipeline could not render: ${error.message}`, "canvas-fatal-error", true);
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
    workflowPage.dispose();
    buttonMounts.forEach((instance) => instance.dispose());
    disposeFieldMounts(mountedPage);
});
await refreshCurrent().then(async () => {
    if (!model.items.length && workflowPhases().length) await createWorkflow(true);
}).catch((error) => message(error.message, "canvas-message", true));
for (const root of document.querySelectorAll("[data-control-id]")) {
    void mountGeneratedControl(root);
}
