import { escapeHtml } from "./client.js";
import { state, TOKEN } from "./state.js";
import { openCommunityInstallModal } from "./modals.js";
import { effectivePipelinePhases, stripCommandsPrefix } from "../pipeline/effective-phases.mjs";

const KINDS = [["presets", "Presets"], ["extensions", "Extensions"], ["bundles", "Bundles"]];
// The canvas designer extension renders the designer itself: it is always
// included and cannot be unchecked by the user, regardless of hosted catalog
// availability or any other selection state.
export const REQUIRED_DESIGNER_EXTENSION_ID = "extension-canvas-design";
let confirming = false;
let selections = null;
let bundleMembers = new Map();
let deselectedMembers = new Set();
let restoreFocus = null;
let inspecting = 0;
let errorMessage = "";
let processing = false;
let pendingInspections = new Set();
// Hosted checkboxes for the required designer extension, forced checked and
// disabled at render time; `updateLaunch` re-asserts `disabled` here so no
// later state transition (processing, bundle refresh, etc.) can re-enable it.
let requiredInputs = new Set();
// Local development sources (presets/extensions only, never bundles): a
// session-only, opt-in addition alongside the hosted catalog selections
// above. Reset whenever the dialog closes or reopens; retained across a
// failed launch attempt, matching the hosted `selections` persistence.
const LOCAL_KINDS = ["presets", "extensions"];
let localItems = { presets: [], extensions: [] };

function phaseIds(snapshot) {
    return [...new Set(effectivePipelinePhases(snapshot).map((phase) =>
        stripCommandsPrefix(phase.id)))];
}

export async function submitDesignerLaunch(snapshot, checked, fetcher = fetch, localChecked = undefined) {
    let response;
    try {
        response = await fetcher(`/api/designer/launch?token=${encodeURIComponent(TOKEN)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Canvas-Token": TOKEN },
            body: JSON.stringify({
                selections: checked,
                catalogFingerprint: snapshot.catalog.designerFingerprint,
                expectedPhases: phaseIds(snapshot),
                ...(localChecked !== undefined ? { localSelections: localChecked } : {}),
            }),
        });
    } catch (error) {
        throw new Error(`Could not reach the Wizard: ${error.message}`);
    }
    if (!response?.ok) {
        const text = await response?.text();
        let detail = text;
        try {
            const body = JSON.parse(text);
            detail = body.error ?? text;
        } catch { /* plain response */ }
        throw new Error(`Designer launch failed (${response?.status ?? "unknown"}): ${detail || "Try again."}`);
    }
    const result = await response.json();
    if (result?.queued !== true) throw new Error("Wizard did not queue the Designer session.");
    return result;
}

function updateLaunch(root) {
    const submit = root.querySelector(".designer-submit");
    if (!submit) return;
    const ready = ["presets", "extensions", "bundles"].every((kind) =>
        Array.isArray(state.snapshot?.catalog?.[kind]))
        && typeof state.snapshot.catalog.designerFingerprint === "string";
    submit.disabled = Boolean(processing || confirming || inspecting || !ready);
    submit.setAttribute("aria-busy", String(processing));
    root.querySelectorAll("[data-designer-kind], [data-designer-tab], .wizard-modal-close, .wizard-modal-cancel")
        .forEach((element) => {
            element.disabled = Boolean(processing || pendingInspections.has(element)) || requiredInputs.has(element);
        });
    // Local development controls (add/path/checkbox/remove) are a separate
    // additive section that otherwise has no busy guard: without this, a
    // user could add/remove/toggle a local source while a launch request
    // for the *previous* checked state is in flight, racing the payload
    // `sendLaunch` already captured. Disable them for the same `processing`
    // window as the hosted controls above, without altering hosted behavior.
    root.querySelectorAll("[data-designer-local-kind], [data-designer-local-add], [data-designer-local-path]")
        .forEach((element) => {
            element.disabled = Boolean(processing);
        });
    const error = root.querySelector(".designer-error");
    error.textContent = errorMessage || (!ready ? "Wait for the catalog to load before launching." : "");
    error.hidden = !error.textContent;
}

export function canvasDesignEntries(snapshot, kind) {
    const items = snapshot?.catalog?.[kind];
    return (Array.isArray(items) ? items : []).filter((item) =>
        item?.id && (["community", "copilot"].includes(item.source)
            || (kind === "bundles" && item.source === "default"))
        && Array.isArray(item.tags) && item.tags.includes("canvas-design"));
}

export function freshCanvasDesignerSelections() {
    return { presets: [], extensions: [], bundles: [] };
}

function isRequiredDesignerExtension(kind, item) {
    return kind === "extensions" && item?.id === REQUIRED_DESIGNER_EXTENSION_ID;
}

/** Checked local sources, keyed by kind, as `{id, path}` pairs ready for the
 * launch payload. Returns `undefined` when nothing is checked so callers can
 * omit the `localSelections` key entirely (byte-identical request when the
 * feature is unused). */
function checkedLocalSelections() {
    const result = {};
    for (const kind of LOCAL_KINDS) {
        const checked = localItems[kind]
            .filter((item) => item.checked)
            .map((item) => ({ id: item.id, path: item.path }));
        if (checked.length) result[kind] = checked;
    }
    return Object.keys(result).length ? result : undefined;
}

export function currentCanvasDesignerSelections() {
    if (!selections) return null;
    const result = structuredClone(selections);
    for (const { members } of bundleMembers.values()) {
        for (const { kind, id, source } of members) {
            if (!deselectedMembers.has(`${kind}:${source}:${id}`)
                && !result[kind].some((item) => item.id === id && item.source === source)) {
                result[kind].push({ id, source, approved: true });
            }
        }
    }
    return result;
}

function closeDialog() {
    if (processing) return;
    document.getElementById("wizard-modal-root")?.replaceChildren();
    selections = null;
    bundleMembers = new Map();
    deselectedMembers = new Set();
    errorMessage = "";
    pendingInspections = new Set();
    inspecting = 0;
    localItems = { presets: [], extensions: [] };
    requiredInputs = new Set();
    if (restoreFocus?.isConnected) restoreFocus.focus();
    restoreFocus = null;
}

// Rendered once, as a sibling of the Presets/Extensions/Bundles tabpanels
// (not nested inside any one of them), so there is a single "Local
// development" section regardless of which tab is active. It covers both
// local kinds that are supported (presets and extensions, never bundles),
// each as its own labeled subgroup reusing the existing per-kind add/list
// wiring and data attributes.
function renderLocalSection() {
    const groups = LOCAL_KINDS.map((kind) => {
        const label = KINDS.find(([entryKind]) => entryKind === kind)?.[1] ?? kind;
        const singular = label.slice(0, -1).toLowerCase();
        return `<div class="designer-local-kind" data-designer-local-section="${kind}">
            <h4 class="designer-local-kind-title">${label}</h4>
            <div class="designer-local-add">
                <input type="text" class="designer-local-path" data-designer-local-path="${kind}" placeholder="Absolute path to ${singular} directory" aria-label="Local ${singular} directory path">
                <button type="button" class="btn btn-secondary designer-local-add-btn" data-designer-local-add="${kind}">Add</button>
            </div>
            <p class="designer-local-error" data-designer-local-error="${kind}" role="alert" hidden></p>
            <ul class="designer-local-list" data-designer-local-list="${kind}"></ul>
        </div>`;
    }).join("");
    return `<details class="designer-local" data-designer-local>
        <summary>Local development</summary>
        <div class="designer-local-body">
            <p class="wizard-modal-desc designer-local-desc">Add uninstalled local preset or extension directories for this session. A local preset or extension takes precedence over a hosted selection with the same ID, including a bundle member.</p>
            ${groups}
        </div>
    </details>`;
}

function renderChoices(snapshot, kind, label) {
    const items = canvasDesignEntries(snapshot, kind);
    return `<fieldset class="designer-group" id="designer-panel-${kind}" data-designer-panel="${kind}" role="tabpanel" aria-labelledby="designer-tab-${kind}" ${kind !== "presets" ? "hidden" : ""}>
        ${items.length ? items.map((item, index) => {
            const required = isRequiredDesignerExtension(kind, item);
            return `<label class="designer-choice${required ? " designer-choice-required" : ""}">
            <input type="checkbox" data-designer-kind="${kind}" data-designer-index="${index}"${required ? " checked disabled" : ""}>
            <span class="designer-choice-text"><strong>${escapeHtml(item.name ?? item.id)}</strong><small>${escapeHtml(item.id)}${item.version ? ` · v${escapeHtml(item.version)}` : ""}</small><small class="designer-included-by" hidden></small></span>
            <span class="badge source designer-source-tag">${escapeHtml((item.source ?? "default").replace(/^./, (c) => c.toUpperCase()))}</span>
            ${required ? '<span class="badge designer-required-badge" title="Always included to render the canvas designer">Required</span>' : ""}
        </label>`;
        }).join("") : `<p class="wizard-modal-desc">No ${label.toLowerCase()} tagged canvas-design are available.</p>`}
    </fieldset>`;
}

function includedBy(kind, id, source) {
    return [...bundleMembers.values()]
        .filter(({ members }) => members.some((member) =>
            member.kind === kind && member.id === id && member.source === source))
        .map(({ bundle }) => bundle.name ?? bundle.id);
}

function refreshBundleChoices(root, snapshot) {
    for (const kind of ["presets", "extensions"]) {
        const catalog = canvasDesignEntries(snapshot, kind);
        root.querySelectorAll(`[data-designer-kind="${kind}"]`).forEach((input) => {
            const item = catalog[Number(input.dataset.designerIndex)];
            const names = includedBy(kind, item.id, item.source);
            const note = input.parentElement.querySelector(".designer-included-by");
            note.textContent = names.length ? `Included by bundle: ${names.join(", ")}` : "";
            note.hidden = !names.length;
            input.title = note.textContent;
            input.checked = selections[kind].some((entry) =>
                entry.id === item.id && entry.source === item.source)
                || (!!names.length && !deselectedMembers.has(`${kind}:${item.source}:${item.id}`));
        });
    }
}

function renderLocalList(root, kind) {
    const list = root.querySelector(`[data-designer-local-list="${kind}"]`);
    if (!list) return;
    list.innerHTML = localItems[kind].map((item, index) => `<li class="designer-local-item">
            <label class="designer-choice">
                <input type="checkbox" data-designer-local-kind="${kind}" data-designer-local-index="${index}" ${item.checked ? "checked" : ""}>
                <span class="designer-choice-text"><strong>${escapeHtml(item.name ?? item.id)}</strong><small>${escapeHtml(item.id)}${item.version ? ` · v${escapeHtml(item.version)}` : ""}</small><small class="designer-local-path-text">${escapeHtml(item.path)}</small></span>
            </label>
            <button type="button" class="btn btn-secondary designer-local-remove" data-designer-local-kind="${kind}" data-designer-local-index="${index}">Remove</button>
        </li>`).join("");
    list.querySelectorAll("input[data-designer-local-index]").forEach((input) => {
        input.addEventListener("change", () => {
            localItems[kind][Number(input.dataset.designerLocalIndex)].checked = input.checked;
        });
    });
    list.querySelectorAll("button[data-designer-local-index]").forEach((button) => {
        button.addEventListener("click", () => {
            localItems[kind].splice(Number(button.dataset.designerLocalIndex), 1);
            renderLocalList(root, kind);
        });
    });
}

async function addLocalSource(root, kind, pathInput) {
    if (processing) return;
    const dialogSelections = selections;
    const errorEl = root.querySelector(`[data-designer-local-error="${kind}"]`);
    const addBtn = root.querySelector(`[data-designer-local-add="${kind}"]`);
    const path = pathInput.value.trim();
    errorEl.hidden = true;
    errorEl.textContent = "";
    if (!path) {
        errorEl.textContent = "Enter a directory path.";
        errorEl.hidden = false;
        return;
    }
    addBtn.disabled = true;
    pathInput.disabled = true;
    try {
        const response = await fetch(`/api/designer/local-source?token=${encodeURIComponent(TOKEN)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Canvas-Token": TOKEN },
            body: JSON.stringify({ kind, path }),
        });
        const body = await response.json().catch(() => null);
        if (dialogSelections !== selections) return;
        if (!response.ok) {
            throw new Error(body?.error ?? `Could not add local ${kind.slice(0, -1)} (${response.status}).`);
        }
        const item = body?.item;
        if (!item?.id || !item?.path) throw new Error("Local source response was invalid.");
        if (localItems[kind].some((entry) => entry.id === item.id)) {
            throw new Error(`A local ${kind.slice(0, -1)} with id "${item.id}" is already added.`);
        }
        localItems[kind].push({ ...item, checked: true });
        pathInput.value = "";
        renderLocalList(root, kind);
    } catch (error) {
        if (dialogSelections !== selections) return;
        errorEl.textContent = error.message;
        errorEl.hidden = false;
    } finally {
        if (dialogSelections === selections) {
            addBtn.disabled = false;
            pathInput.disabled = false;
        }
    }
}

async function inspectBundle(item) {
    const params = new URLSearchParams({ id: item.id, source: item.source, token: TOKEN });
    const response = await fetch(`/api/designer/bundle-members?${params}`);
    if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error ?? `Bundle inspection failed (${response.status}).`);
    }
    const { members } = await response.json();
    if (!Array.isArray(members)) throw new Error("Bundle inspection returned no member list.");
    return members;
}

export function openCanvasDesignerDialog() {
    if (document.querySelector(".designer-modal")) return;
    const snapshot = state.snapshot;
    const root = document.getElementById("wizard-modal-root");
    if (!root) return;
    restoreFocus = document.activeElement;
    selections = freshCanvasDesignerSelections();
    bundleMembers = new Map();
    deselectedMembers = new Set();
    errorMessage = "";
    pendingInspections = new Set();
    localItems = { presets: [], extensions: [] };
    requiredInputs = new Set();
    const requiredExtension = canvasDesignEntries(snapshot, "extensions")
        .find((item) => item.id === REQUIRED_DESIGNER_EXTENSION_ID);
    if (requiredExtension) {
        selections.extensions.push({
            id: requiredExtension.id, source: requiredExtension.source, approved: true,
        });
    }
    root.innerHTML = `<div class="wizard-modal-backdrop designer-backdrop">
        <section class="wizard-modal generation-modal designer-modal" role="dialog" aria-modal="true" aria-labelledby="designer-title" aria-describedby="designer-description">
            <header class="wizard-modal-head"><h3 id="designer-title">Canvas designer setup</h3><button type="button" class="wizard-modal-close" aria-label="Close">✕</button></header>
            <div class="wizard-modal-body">
                <p class="wizard-modal-desc" id="designer-description">Select presets, extensions, or bundles to customize the canvas designer's settings and generation behavior. Your selections will be installed in a separate designer session, leaving the wizard's configuration unchanged.</p>
                <p class="wizard-modal-desc">Choose from the available catalogs.</p>
                <p class="designer-error" role="alert" hidden></p>
                <nav class="subtabs designer-tabs" role="tablist" aria-label="Design customization type">
                    ${KINDS.map(([kind, label]) => `<button type="button" id="designer-tab-${kind}" class="subtab${kind === "presets" ? " is-active" : ""}" role="tab" aria-selected="${kind === "presets"}" aria-controls="designer-panel-${kind}" tabindex="${kind === "presets" ? "0" : "-1"}" data-designer-tab="${kind}">${label}</button>`).join("")}
                </nav>
                ${KINDS.map(([kind, label]) => renderChoices(snapshot, kind, label)).join("")}
                ${renderLocalSection()}
            </div>
            <footer class="wizard-modal-foot"><button type="button" class="btn btn-secondary wizard-modal-cancel">Cancel</button><button type="button" class="btn btn-primary designer-submit">Launch designer</button></footer>
        </section></div>`;
    const dialog = root.querySelector(".designer-modal");
    root.querySelector(".wizard-modal-close").addEventListener("click", closeDialog);
    root.querySelector(".wizard-modal-cancel").addEventListener("click", closeDialog);
    root.querySelector(".designer-backdrop").addEventListener("click", (event) => {
        if (event.target === event.currentTarget) closeDialog();
    });
    const tabs = [...root.querySelectorAll("[data-designer-tab]")];
    const activateTab = (tab) => {
        tabs.forEach((entry) => {
            const active = entry === tab;
            entry.classList.toggle("is-active", active);
            entry.setAttribute("aria-selected", String(active));
            entry.setAttribute("tabindex", active ? "0" : "-1");
        });
        root.querySelectorAll("[data-designer-panel]").forEach((panel) => {
            panel.hidden = panel.dataset.designerPanel !== tab.dataset.designerTab;
        });
    };
    tabs.forEach((tab, index) => {
        tab.addEventListener("click", () => activateTab(tab));
        tab.addEventListener("keydown", (event) => {
            let target;
            if (event.key === "ArrowRight") target = (index + 1) % tabs.length;
            else if (event.key === "ArrowLeft") target = (index - 1 + tabs.length) % tabs.length;
            else if (event.key === "Home") target = 0;
            else if (event.key === "End") target = tabs.length - 1;
            else return;
            event.preventDefault();
            activateTab(tabs[target]);
            tabs[target].focus();
        });
    });
    for (const kind of LOCAL_KINDS) {
        const pathInput = root.querySelector(`[data-designer-local-path="${kind}"]`);
        const addBtn = root.querySelector(`[data-designer-local-add="${kind}"]`);
        if (!pathInput || !addBtn) continue;
        addBtn.addEventListener("click", () => addLocalSource(root, kind, pathInput));
        pathInput.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            addLocalSource(root, kind, pathInput);
        });
        renderLocalList(root, kind);
    }
    root.querySelectorAll("[data-designer-kind]").forEach((input) => {
        const setupKind = input.dataset.designerKind;
        const setupItem = canvasDesignEntries(snapshot, setupKind)[Number(input.dataset.designerIndex)];
        if (isRequiredDesignerExtension(setupKind, setupItem)) {
            requiredInputs.add(input);
            input.checked = true;
            input.disabled = true;
        }
        input.addEventListener("change", async () => {
        if (confirming || processing || input.disabled || requiredInputs.has(input)) return;
        const dialogSelections = selections;
        const kind = input.dataset.designerKind;
        const item = canvasDesignEntries(snapshot, kind)[Number(input.dataset.designerIndex)];
        if (!item) return;
        const error = root.querySelector(".designer-error");
        error.hidden = true;
        error.textContent = "";
        if (input.checked && (item.installAllowed === false || item.source === "community")) {
            confirming = true;
            updateLaunch(root);
            const backdrop = root.querySelector(".designer-backdrop");
            const restoreBackdrop = () => {
                backdrop.removeAttribute("aria-hidden");
                backdrop.inert = false;
            };
            let approved;
            try {
                approved = await new Promise((resolve) => openCommunityInstallModal({
                    displayName: item.name ?? item.id,
                    kind: kind.slice(0, -1),
                    designerSession: true,
                    afterFocus: () => {
                        backdrop.inert = true;
                        backdrop.setAttribute("aria-hidden", "true");
                    },
                    beforeRestoreFocus: restoreBackdrop,
                    onConfirm: () => resolve(true),
                    onCancel: () => resolve(false),
                }));
            } finally {
                restoreBackdrop();
                confirming = false;
                updateLaunch(root);
            }
            if (selections !== dialogSelections) return;
            if (!approved) { input.checked = false; input.focus(); return; }
        }
        if (kind === "bundles") {
            const key = `${item.source}:${item.id}`;
            if (input.checked) {
                inspecting += 1;
                pendingInspections.add(input);
                updateLaunch(root);
                const restoreInputFocus = document.activeElement === input;
                input.disabled = true;
                try {
                    const members = await inspectBundle(item);
                    if (selections !== dialogSelections) return;
                    bundleMembers.set(key, { bundle: item, members: members.flatMap((member) => {
                        const match = canvasDesignEntries(snapshot, member.kind).find((candidate) =>
                            candidate.id === member.id && candidate.source === item.source);
                        return match ? [{ ...member, source: match.source }] : [];
                    }) });
                    for (const member of bundleMembers.get(key).members) {
                        deselectedMembers.delete(`${member.kind}:${member.source}:${member.id}`);
                    }
                } catch (err) {
                    if (selections !== dialogSelections) return;
                    input.checked = false;
                    errorMessage = `Could not inspect ${item.name ?? item.id}: ${err.message}`;
                    updateLaunch(root);
                    return;
                } finally {
                    pendingInspections.delete(input);
                    if (selections === dialogSelections) {
                        inspecting -= 1;
                        updateLaunch(root);
                    }
                    if (restoreInputFocus && input.isConnected
                        && (document.activeElement === document.body || document.activeElement === input)) {
                        input.focus();
                    }
                }
            } else {
                bundleMembers.delete(key);
            }
        } else {
            const key = `${kind}:${item.source}:${item.id}`;
            if (input.checked) deselectedMembers.delete(key);
            else if (includedBy(kind, item.id, item.source).length) deselectedMembers.add(key);
        }
        selections[kind] = selections[kind].filter((entry) =>
            entry.id !== item.id || entry.source !== item.source);
        if (input.checked) selections[kind].push({
            id: item.id, source: item.source, approved: true,
        });
        if (kind === "bundles") refreshBundleChoices(root, snapshot);
        errorMessage = "";
        updateLaunch(root);
    });
    });
    const sendLaunch = async (checked) => {
        if (processing) return;
        const dialogSelections = selections;
        processing = true;
        errorMessage = "";
        updateLaunch(root);
        let accepted = false;
        try {
            await submitDesignerLaunch(snapshot, checked, fetch, checkedLocalSelections());
            if (selections !== dialogSelections) return;
            accepted = true;
        } catch (error) {
            if (selections !== dialogSelections) return;
            errorMessage = error.message;
        } finally {
            processing = false;
            if (selections === dialogSelections) {
                if (accepted) closeDialog();
                else updateLaunch(root);
            }
        }
    };
    root.querySelector(".designer-submit").addEventListener("click", () => {
        if (processing || confirming || inspecting) return;
        return sendLaunch(currentCanvasDesignerSelections());
    });
    updateLaunch(root);
    dialog.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); closeDialog(); }
        if (event.key !== "Tab") return;
        const focusable = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled])")];
        if (!focusable.length) return;
        if (event.shiftKey && document.activeElement === focusable[0]) {
            event.preventDefault(); focusable.at(-1).focus();
        } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
            event.preventDefault(); focusable[0].focus();
        }
    });
    root.querySelector(".wizard-modal-close").focus();
}
