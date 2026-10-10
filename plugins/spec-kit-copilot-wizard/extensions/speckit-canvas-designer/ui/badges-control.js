const { jsonSafe, validBadgeInputDraft, hasDeclaredBadgeInputs, badgeInputReady } = await import(
    `./external-control-adapter-contract.js${new URL(import.meta.url).search}`);
const duplicateModule = new URL("./badge-duplicates.js", import.meta.url);
duplicateModule.search = new URL(import.meta.url).search;
const { findDuplicateBadge } = await import(duplicateModule.href);

const PLACES = [
    ["workflow-list", "Workflow list"],
    ["workflow-summary", "Workflow summary"],
];
const COLORS = ["theme", "red", "green", "amber", "blue", "purple", "pink", "orange"];

function adapterError(error) {
    if (error instanceof Error) return error.message;
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
        return "a non-Error value";
    }
    return String(error);
}

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

function select(options, value, label) {
    const node = element("select");
    node.setAttribute("aria-label", label);
    for (const [id, name] of options) {
        const option = element("option", name);
        option.value = id;
        node.append(option);
    }
    node.value = value;
    return node;
}

function field(title, control, hint) {
    const wrapper = element("label", undefined, "badge-field");
    wrapper.append(element("span", title), control);
    if (hint) wrapper.append(element("small", hint, "muted"));
    return wrapper;
}

function phaseOptions(phases) {
    return phases.map((phase) => [phase, phase.replace(/^speckit\./, "")
        .replace(/[.-]/g, " ").replace(/^./, (first) => first.toUpperCase())]);
}

function newDraft(type) {
    return { id: globalThis.crypto?.randomUUID?.() ?? `badge-${Date.now()}`,
        type: type.id, inputs: {}, text: type.defaultText, color: type.defaultColor,
        showIn: ["workflow-list"], phase: null, targets: [] };
}

function defaultSummaryText(type) {
    return `${type.title} ({workflows} workflows)`;
}

function editableBadge(badge, type) {
    const draft = structuredClone(badge);
    if (!Array.isArray(draft.targets)) {
        draft.targets = draft.showIn.includes("phase-card") && draft.phase
            ? [{ phase: draft.phase, output: null }] : [];
    }
    draft.showIn = draft.showIn.filter((place) => place !== "phase-card");
    draft.phase = null;
    if (draft.targets.length && draft.phaseText === undefined) draft.phaseText = draft.text;
    if (draft.showIn.includes("workflow-summary") && draft.summaryText === undefined) {
        draft.summaryText = defaultSummaryText(type);
    }
    return draft;
}

function evidencePhases(rule, inputs) {
    if (rule.placementPhaseInput) {
        return [inputs[rule.placementPhaseInput]?.phase].filter(Boolean);
    }
    const selected = new Set();
    for (const descriptor of rule.inputs ?? []) {
        const value = inputs[descriptor.id];
        if (descriptor.type === "phase" && value) selected.add(value);
        else if (descriptor.type === "artifact" && value?.phase) {
            selected.add(value.phase);
        }
        else if (descriptor.type === "artifact-set") {
            for (const entry of value ?? []) if (entry.outputs?.length) selected.add(entry.phase);
        }
    }
    return [...selected];
}

function placementSummary(badge, phases) {
    const global = badge.showIn.filter((place) => place !== "phase-card")
        .map((id) => PLACES.find(([key]) => key === id)?.[1] ?? id);
    const targets = badge.targets ?? (badge.showIn.includes("phase-card") && badge.phase
        ? [{ phase: badge.phase, output: null }] : []);
    if (targets.length && targets.every(({ output }) => output === null)) {
        global.push(`${targets.map(({ phase }) =>
            phaseOptions([phase])[0][1]).join(", ")} phase ${targets.length === 1 ? "card" : "cards"}`);
        return global.join(" · ");
    }
    for (const phase of phases) {
        const selected = targets.filter((target) => target.phase === phase);
        if (!selected.length) continue;
        const choices = selected.map(({ output }) => output ?? "Phase card");
        global.push(`${phaseOptions([phase])[0][1]}: ${choices.join(", ")}`);
    }
    return global.join("; ") || "No placements";
}

function readableBadgeForeground(hex) {
    const rgb = [1, 3, 5].map((index) => {
        const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    return (luminance + 0.05) / (0.005605 + 0.05) >= 1.05 / (luminance + 0.05)
        ? "#111" : "#fff";
}

function updatePreview(preview, badge) {
    preview.textContent = (badge.text || "Badge text").replace(/\{count\}/g, "3")
        .replace(/\{completed\}/g, "3").replace(/\{total\}/g, "5")
        .replace(/\{percent\}/g, "60").replace(/\{workflows\}/g, "2");
    preview.dataset.color = badge.color;
    preview.style.backgroundColor = "";
    preview.style.color = "";
    if (/^#[0-9a-fA-F]{6}$/.test(badge.color)) {
        preview.style.backgroundColor = badge.color;
        preview.style.color = readableBadgeForeground(badge.color);
    }
}

export function mountBadges({ root, page, phases, outputs, badgeTypes, badgeRules,
    draftBadges, onChange, controlMount, onDeclareFile }) {
    let outputsSnapshot = JSON.stringify(outputs);
    const types = badgeTypes.filter((type) => type.enabled);
    for (const [first, second] of [
        ["artifact-current", "artifact-stale"],
        ["checklist-progress", "checklist-complete"],
    ]) {
        const index = types.findIndex((type) => type.id === second);
        if (index < 0 || !types.some((type) => type.id === first)) continue;
        const [entry] = types.splice(index, 1);
        types.splice(types.findIndex((type) => type.id === first) + 1, 0, entry);
    }
    const rules = new Map(badgeRules.map((rule) => [rule.id, rule]));
    let catalogOpen = false;
    let pending = null;
    let activeControl;
    let renderId = 0;
    const openCatalog = () => {
        pending = null;
        catalogOpen = true;
        redraw();
        root.querySelector(".badge-type-choice")?.focus?.();
    };
    const redraw = () => {
        renderId++;
        const previousControl = activeControl;
        activeControl = null;
        let disposalError;
        let disposalFailed = false;
        try {
            previousControl?.dispose?.();
        } catch (error) {
            disposalError = error;
            disposalFailed = true;
        }
        root.replaceChildren();
        if (disposalFailed) {
            const warning = element("p",
                `Could not dispose badge input control: ${adapterError(disposalError)}`,
                "settings-field-error");
            warning.setAttribute("role", "alert");
            root.append(warning);
        }
        if (catalogOpen) {
            const back = element("button", "← Back to badges", "badge-back");
            back.type = "button";
            back.addEventListener("click", () => {
                catalogOpen = false;
                redraw();
                root.querySelector(".badge-add")?.focus?.();
            });
            const catalog = element("section", undefined, "badge-section badge-catalog");
            catalog.append(element("h1", "Choose a badge type"));
            for (const type of types) {
                const choice = element("button", undefined, "badge-type-choice");
                choice.type = "button";
                choice.setAttribute("aria-label", type.title);
                choice.append(element("strong", type.title),
                    element("span", type.description ?? "", "settings-note"),
                    element("span", "›", "badge-chevron"));
                choice.addEventListener("click", () => {
                    pending = newDraft(type);
                    catalogOpen = false;
                    redraw();
                    root.querySelector(".badge-editor-heading")?.focus?.();
                });
                catalog.append(choice);
            }
            root.append(back, catalog);
            return;
        }
        if (pending) {
            const editing = draftBadges.some((entry) => entry.id === pending.id);
            const back = element("button", editing ? "← Back to badges" : "← Back to badge types",
                "badge-back");
            back.type = "button";
            back.addEventListener("click", () => {
                pending = null;
                catalogOpen = !editing;
                redraw();
                root.querySelector(editing ? ".badge-edit" : ".badge-type-choice")?.focus?.();
            });
            root.append(back);
        } else {
            root.append(element("h1", page.title),
                element("p", page.description ?? "", "muted"));
        }
        if (!pending) {
            const configured = element("section", undefined, "badge-toolbar");
            const listHeading = element("h2", "Configured badges", "badge-list-heading");
            listHeading.tabIndex = -1;
            configured.append(listHeading);
            const browse = element("button", "+ Add badge", "badge-add");
            browse.type = "button";
            browse.disabled = draftBadges.length >= 100 || !types.length;
            browse.addEventListener("click", openCatalog);
            configured.append(browse);
            if (browse.disabled) {
                const help = element("p", draftBadges.length >= 100
                    ? "100 badges is the limit. Remove one before adding another."
                    : "No badge types are available. Ask your agent to check this Designer setup.",
                "settings-note");
                help.id = "badge-add-help";
                browse.setAttribute("aria-describedby", help.id);
                configured.append(help);
            }
            root.append(configured);
            const list = element("div", undefined, "badge-list");
            if (!draftBadges.length) list.append(element("p", "No badges yet.", "settings-note"));
            for (const badge of draftBadges) {
                const row = element("div", undefined, "badge-row");
                const type = badgeTypes.find((item) => item.id === badge.type);
                const available = type?.enabled && rules.has(type.rule);
                const label = badge.showIn.includes("workflow-list") ? badge.text
                    : badge.targets?.length || badge.showIn.includes("phase-card")
                        ? badge.phaseText ?? badge.text : badge.summaryText ?? badge.text;
                const typeName = type?.title ?? badge.type;
                const instanceName = label || typeName;
                const detail = element("div");
                const placements = placementSummary(badge, phases);
                detail.append(element("strong", instanceName),
                    element("p", instanceName === typeName ? placements
                        : `${typeName} · ${placements}`, "settings-note"));
                if (!available) detail.append(element("p",
                    "This badge type is unavailable. Ask your agent to restore it, or remove this badge before saving.",
                    "settings-field-error"));
                const actions = element("div", undefined, "badge-actions");
                const edit = element("button", "Edit", "badge-edit");
                edit.type = "button";
                edit.disabled = !available;
                edit.setAttribute("aria-label", `Edit ${label || type?.title || badge.type}`);
                edit.addEventListener("click", () => {
                    pending = editableBadge(badge, type);
                    redraw();
                    root.querySelector(".badge-editor-heading")?.focus?.();
                });
                const remove = element("button", "Remove");
                remove.type = "button";
                remove.setAttribute("aria-label", `Remove ${label || type?.title || badge.type}`);
                remove.addEventListener("click", () => {
                    const index = draftBadges.indexOf(badge);
                    draftBadges.splice(index, 1);
                    onChange();
                    redraw();
                    const next = root.querySelector(".badge-list")?.children[
                        Math.min(index, draftBadges.length - 1)]?.querySelector(".badge-edit");
                    const add = root.querySelector(".badge-add");
                    (next && !next.disabled ? next : !add.disabled ? add
                        : root.querySelector(".badge-list-heading"))?.focus?.();
                });
                actions.append(edit, remove);
                row.append(detail, actions);
                list.append(row);
            }
            root.append(list);
            return;
        }
        const type = badgeTypes.find((item) => item.id === pending.type);
        const rule = rules.get(type?.rule);
        if (!type || !rule) { pending = null; redraw(); return; }
        const editor = element("form", undefined, "badge-section badge-editor");
        editor.noValidate = true;
        const heading = element("h2", undefined, "badge-editor-heading");
        heading.tabIndex = -1;
        heading.append(element("span", `${draftBadges.some((entry) => entry.id === pending.id)
            ? "Edit" : "Add"} ${type.title}`));
        const preview = element("span", undefined, "badge-preview");
        updatePreview(preview, pending);
        const ordered = (rule.inputs ?? []).find(({ type }) => type === "ordered-artifacts");
        editor.append(heading);
        if (ordered) editor.append(element("h3", "When this badge appears"));
        editor.append(element("p", rule.description, "settings-note"));
        const error = element("p", undefined, "settings-field-error badge-editor-error");
        error.setAttribute("role", "alert");
        error.tabIndex = -1;
        error.hidden = true;
        const editDuplicate = element("button", "Edit existing badge", "badge-duplicate-edit");
        editDuplicate.type = "button";
        editDuplicate.hidden = true;
        let duplicateTarget;
        editDuplicate.addEventListener("click", () => {
            if (!duplicateTarget) return;
            pending = editableBadge(duplicateTarget, type);
            redraw();
            root.querySelector(".badge-editor-heading")?.focus?.();
        });
        const revealError = (message) => {
            error.textContent = message;
            error.hidden = !message;
            editDuplicate.hidden = true;
            duplicateTarget = null;
            if (message) error.focus?.();
        };
        const controlRoot = element("div", undefined, "badge-input-controls");
        const clearHostError = (event) => {
            if (!controlRoot.contains(event.target)) revealError("");
        };
        editor.addEventListener("input", clearHostError);
        editor.addEventListener("change", clearHostError);
        const previewField = element("div", undefined, "badge-preview-field");
        previewField.append(element("span", "Preview (example)"), preview);
        const colorGroup = element("div", undefined, "badge-input-group");
        const named = select([...COLORS.map((name) => [name, name]), ["custom", "Custom color"]],
            COLORS.includes(pending.color) ? pending.color : "custom", "Badge color");
        const hex = element("input");
        hex.type = "color";
        hex.value = /^#[0-9a-fA-F]{6}$/.test(pending.color) ? pending.color : "#0b6e99";
        const customColor = field("Custom color", hex);
        customColor.hidden = named.value !== "custom";
        named.addEventListener("change", () => {
            customColor.hidden = named.value !== "custom";
            pending.color = named.value === "custom" ? hex.value : named.value;
            updatePreview(preview, pending);
        });
        hex.addEventListener("input", () => {
            pending.color = hex.value;
            updatePreview(preview, pending);
        });
        colorGroup.append(field("Color", named), customColor, previewField);
        editor.append(colorGroup, element("h3", ordered
            ? "Phase and output to check" : "Phases and outputs"));
        let phasePlacement;
        let refreshLegacy = () => {};
        const phaseCardPhases = () => {
            const selected = typeof control?.selectedPhases === "function"
                ? control.selectedPhases() : evidencePhases(rule, pending.inputs);
            return Array.isArray(selected) ? [...new Set(selected)].filter((phase) =>
                phases.includes(phase)) : [];
        };
        const syncPhasePlacement = () => {
            if (!phasePlacement?.checked) return;
            const selected = phaseCardPhases();
            if (!selected.length) {
                phasePlacement.checked = false;
                phaseTextField.hidden = true;
                delete pending.phaseText;
                revealError("Choose phase evidence before selecting Phase placement.");
            }
            pending.targets = selected.map((phase) => ({ phase, output: null }));
            refreshLegacy();
        };
        editor.append(controlRoot);
        let control;
        let isReady;
        const inputIds = (rule.inputs ?? []).map(({ id }) => id).sort().join();
        const hasDeclaredInputs = (value) => hasDeclaredBadgeInputs(value, inputIds);
        const editorPending = pending;
        const editorRenderId = renderId;
        try {
            control = controlMount?.({ root: controlRoot, rule: structuredClone(rule),
                inputs: structuredClone(pending.inputs), phases: structuredClone(phases),
                outputs: structuredClone(outputs), onDeclareFile: onDeclareFile && ((phase, path) => {
                    if (renderId !== editorRenderId || pending !== editorPending) {
                        throw new Error("This badge editor is no longer active.");
                    }
                    if (!phases.includes(phase) || typeof path !== "string" || !path.endsWith(".md")) {
                        throw new Error("Choose a valid phase and Markdown file.");
                    }
                    const expected = structuredClone(outputs);
                    expected[phase].outputs.push(path);
                    const next = onDeclareFile(phase, path);
                    if (!jsonSafe(next) || JSON.stringify(next) !== JSON.stringify(expected)) {
                        throw new Error("File declaration returned incompatible outputs.");
                    }
                    outputs = structuredClone(next);
                    outputsSnapshot = JSON.stringify(outputs);
                    return structuredClone(outputs);
                }), onChange(nextInputs) {
                    if (renderId !== editorRenderId || pending !== editorPending) return;
                    try {
                        if (!hasDeclaredInputs(nextInputs) || !jsonSafe(nextInputs)
                            || !validBadgeInputDraft(nextInputs, rule, phases, outputs)) {
                            revealError("Badge control returned inputs that do not match its rule or available evidence.");
                            return;
                        }
                        pending.inputs = structuredClone(nextInputs);
                    } catch (error) {
                        revealError(`Badge control returned invalid inputs: ${adapterError(error)}`);
                        return;
                    }
                    revealError("");
                    syncPhasePlacement();
                } });
            isReady = control?.isReady;
        } catch (error) {
            controlRoot.append(element("p", `Could not load badge input control: ${adapterError(error)}`,
                "settings-field-error"));
        }
        activeControl = control;
        if (typeof isReady !== "function" && !controlRoot.children.length) {
            controlRoot.append(element("p", "Badge input controls are unavailable.",
                "settings-field-error"));
        }
        editor.append(element("h3", ordered ? "Where should it appear?"
            : "Where to show this badge"));
        const placements = element("div", undefined, "badge-placements");
        const orderedPlacementOptions = [];
        const ruleTokens = rule.textPlaceholders?.map((placeholder) =>
            `{${typeof placeholder === "string" ? placeholder : placeholder.id}}`).join(", ");
        for (const [id, title] of PLACES) {
            const option = element("div", undefined, "badge-placement-option");
            const label = element("label", undefined, "badge-check");
            const checkbox = element("input");
            checkbox.type = "checkbox";
            checkbox.checked = pending.showIn.includes(id);
            const isSummary = id === "workflow-summary";
            const badgeText = element("input");
            badgeText.type = "text";
            badgeText.maxLength = 120;
            badgeText.value = isSummary ? pending.summaryText ?? defaultSummaryText(type)
                : pending.text;
            const textField = field(`${title} text`, badgeText,
                isSummary ? "Use {workflows} for the number of matching workflows."
                    : ruleTokens ? `Available placeholders: ${ruleTokens}` : "");
            textField.hidden = !checkbox.checked;
            badgeText.addEventListener("input", () => {
                if (isSummary) pending.summaryText = badgeText.value;
                else pending.text = badgeText.value;
                updatePreview(preview, { ...pending, text: badgeText.value });
            });
            checkbox.addEventListener("change", () => {
                pending.showIn = checkbox.checked
                    ? [...pending.showIn, id] : pending.showIn.filter((place) => place !== id);
                textField.hidden = !checkbox.checked;
                if (isSummary) {
                    if (checkbox.checked) pending.summaryText = badgeText.value;
                    else delete pending.summaryText;
                }
            });
            label.append(checkbox, element("span", title));
            option.append(label, textField);
            if (ordered) orderedPlacementOptions.push(option);
            else placements.append(option);
        }
        const phaseLabel = element("label", undefined, "badge-check");
        phasePlacement = element("input");
        phasePlacement.type = "checkbox";
        const followsEvidence = () => {
            const selected = new Set(phaseCardPhases());
            return pending.targets.length === selected.size
                && pending.targets.every(({ phase, output }) =>
                    output === null && selected.has(phase));
        };
        phasePlacement.checked = pending.targets.length > 0 && followsEvidence();
        const phaseHint = element("p", ordered
            ? "Show on the target phase's card."
            : "Show on the selected phases' cards.", "settings-note");
        const phaseText = element("input");
        phaseText.type = "text";
        phaseText.maxLength = 120;
        phaseText.value = pending.phaseText ?? pending.text;
        phaseText.addEventListener("input", () => {
            pending.phaseText = phaseText.value;
            updatePreview(preview, { ...pending, text: phaseText.value });
        });
        const phaseTextField = field(ordered ? "Phase card text" : "Phase text", phaseText,
            ruleTokens ? `Available placeholders: ${ruleTokens}` : "");
        phaseTextField.hidden = !phasePlacement.checked;
        phasePlacement.addEventListener("change", () => {
            if (phasePlacement.checked && !phaseCardPhases().length) {
                phasePlacement.checked = false;
                revealError("Choose phase evidence before selecting Phase placement.");
            }
            pending.targets = phasePlacement.checked
                ? phaseCardPhases().map((phase) => ({ phase, output: null })) : [];
            phaseTextField.hidden = !phasePlacement.checked;
            if (phasePlacement.checked) pending.phaseText = phaseText.value;
            else delete pending.phaseText;
            refreshLegacy();
        });
        phaseLabel.append(phasePlacement, element("span", ordered ? "Phase card" : "Phase"));
        const phaseLine = element("div", undefined, "badge-phase-placement");
        phaseLine.append(phaseLabel, phaseHint);
        placements.append(phaseLine);
        placements.append(phaseTextField);
        placements.append(...orderedPlacementOptions);
        const supportsArtifactTargets = rule.inputs?.some(({ type }) =>
            type === "artifact" || type === "artifact-set");
        const unavailableTarget = ({ phase, output }) => !phases.includes(phase)
            || (output !== null && (!supportsArtifactTargets
                || !outputs[phase]?.outputs?.includes(output)));
        const legacy = element("div", undefined, "badge-legacy-placement");
        refreshLegacy = () => {
            legacy.replaceChildren();
            if (!pending.targets.length || followsEvidence()) return;
            legacy.append(element("p",
                `Saved placements: ${pending.targets.map(({ phase, output }) =>
                    `${phaseOptions([phase])[0][1]}: ${output ?? "Phase card"}`).join("; ")}. `
                + "Select Phase to replace them with the selected phases' cards.",
                "settings-note"));
            if (pending.targets.some(unavailableTarget)) {
                legacy.append(element("p", "Some saved placements are unavailable.",
                    "settings-field-error"));
                const removeUnavailable = element("button", "Remove unavailable placements");
                removeUnavailable.type = "button";
                removeUnavailable.addEventListener("click", () => {
                    pending.targets = pending.targets.filter((target) => !unavailableTarget(target));
                    revealError("");
                    refreshLegacy();
                });
                legacy.append(removeUnavailable);
            }
            const remove = element("button", "Remove saved placements");
            remove.type = "button";
            remove.addEventListener("click", () => {
                pending.targets = [];
                revealError("");
                refreshLegacy();
            });
            legacy.append(remove);
        };
        refreshLegacy();
        placements.append(legacy);
        editor.append(placements, error, editDuplicate);
        const actions = element("div", undefined, "badge-actions");
        const apply = element("button", draftBadges.some((entry) => entry.id === pending.id)
            ? "Save changes" : "Create badge");
        apply.type = "submit";
        const cancel = element("button", draftBadges.some((entry) => entry.id === pending.id)
            ? "Discard changes" : "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", () => {
            pending = null;
            redraw();
            root.querySelector(".badge-add")?.focus?.();
        });
        actions.append(apply, cancel);
        editor.append(actions);
        editor.addEventListener("submit", (event) => {
            event.preventDefault();
            if (!pending.text.trim()) return revealError("Enter badge text.");
            if (pending.text.length > 120) {
                return revealError("Badge text must be 120 characters or fewer.");
            }
            if (/[\x00-\x1f\x7f<>]/.test(pending.text)) {
                return revealError("Badge text cannot contain control characters or angle brackets.");
            }
            const allowedPlaceholders = new Set((rule.textPlaceholders ?? []).map((placeholder) =>
                typeof placeholder === "string" ? placeholder : placeholder.id));
            const unknownToken = [...pending.text.matchAll(/\{([^{}]+)\}/g)]
                .find(([, placeholder]) => !allowedPlaceholders.has(placeholder));
            if (unknownToken) {
                return revealError(`Unknown badge text token {${unknownToken[1]}}. Use a listed token or remove the braces.`);
            }
            if (/[{}]/.test(pending.text.replace(/\{[^{}]+\}/g, ""))) {
                return revealError("Badge text has unmatched braces. Remove them or use an available token.");
            }
            for (const [name, value, placeholders] of [
                ["Phase", phasePlacement.checked ? pending.phaseText : undefined, allowedPlaceholders],
                ["Workflow summary", pending.showIn.includes("workflow-summary")
                    ? pending.summaryText : undefined, new Set(["workflows"])],
            ]) {
                if (value === undefined && !(name === "Phase"
                    ? phasePlacement.checked : pending.showIn.includes("workflow-summary"))) continue;
                if (typeof value !== "string" || !value.trim() || value.length > 120
                    || /[\x00-\x1f\x7f<>]/.test(value)
                    || [...value.matchAll(/\{([^{}]+)\}/g)].some(([, token]) =>
                        !placeholders.has(token))
                    || /[{}]/.test(value.replace(/\{[^{}]+\}/g, ""))) {
                    return revealError(`Enter valid ${name} text using only its available placeholders.`);
                }
            }
            if (!pending.color) return revealError("Select a badge color.");
            if (typeof isReady !== "function") {
                return revealError("Badge input controls are unavailable.");
            }
            if (!hasDeclaredInputs(pending.inputs)) {
                return revealError("Badge control returned inputs that do not match its rule.");
            }
            try {
                if (!badgeInputReady(isReady, control)) {
                    return revealError(control.validationError?.() || "Complete the badge inputs before saving.");
                }
            } catch (error) {
                return revealError(`Badge input control readiness failed: ${adapterError(error)}`);
            }
            if (pending.targets.length > 100) {
                return revealError("A badge can have at most 100 placements. Remove some selections.");
            }
            if (pending.targets.some(unavailableTarget)) {
                return revealError("A saved placement is unavailable. Remove unavailable placements or select Phase.");
            }
            if (phasePlacement.checked && !pending.targets.length) {
                return revealError("Choose a phase above or uncheck Phase.");
            }
            const index = draftBadges.findIndex((entry) => entry.id === pending.id);
            if (index < 0 && draftBadges.length >= 100) return revealError("At most 100 badges can be configured.");
            const duplicate = findDuplicateBadge(pending, draftBadges);
            if (duplicate) {
                revealError("This badge already has the same text and evidence at this phase/output. Edit it or change the text.");
                duplicateTarget = duplicate;
                editDuplicate.hidden = false;
                return;
            }
            if (index < 0) draftBadges.push(structuredClone(pending));
            else draftBadges[index] = structuredClone(pending);
            pending = null;
            onChange();
            redraw();
            root.querySelector(".badge-add")?.focus?.();
        });
        root.append(editor);
    };
    redraw();
    return {
        updateOutputs(next) {
            const snapshot = JSON.stringify(next);
            if (snapshot === outputsSnapshot) return;
            outputs = next;
            outputsSnapshot = snapshot;
            redraw();
        },
    };
}
