const duplicateModule = new URL("./badge-duplicates.js", import.meta.url);
duplicateModule.search = new URL(import.meta.url).search;
const { findDuplicateBadge } = await import(duplicateModule.href);

const PLACES = [
    ["workflow-list", "Workflow list"],
    ["workflow-summary", "Workflow summary"],
];
const COLORS = ["theme", "red", "green", "amber", "blue", "purple", "pink", "orange"];
const supportsPhaseCard = (phase) => phase?.replace(/^speckit\./, "") !== "constitution";

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

function artifactOptions(outputs, phase) {
    return (outputs[phase]?.outputs ?? []).map((path) => [path, path]);
}

function defaultPhase(phases) {
    return phases.find(supportsPhaseCard) ?? "";
}

function firstArtifact(outputs) {
    const phase = Object.keys(outputs).find((id) =>
        supportsPhaseCard(id) && outputs[id]?.outputs?.length);
    if (!phase || !outputs[phase]?.outputs?.length) return { phase: "", output: "" };
    return { phase, output: outputs[phase].view ?? outputs[phase].outputs[0] };
}

function newDraft(type, rules, phases, outputs) {
    const rule = rules.find((item) => item.id === type.rule);
    const inputs = {};
    const initial = firstArtifact(outputs);
    for (const input of rule?.inputs ?? []) {
        inputs[input.id] = input.type === "phase" ? defaultPhase(phases)
            : input.type === "text" ? ""
            : input.type === "artifact" ? { ...initial }
            : input.type === "ordered-artifacts" ? []
                : initial.phase ? [{ phase: initial.phase, outputs: [initial.output] }] : [];
    }
    if (rule?.id === "checklist-complete") {
        const prior = phases.find((id) => outputs[id]?.outputs?.length);
        const firstOutput = outputs[prior]?.view ?? outputs[prior]?.outputs[0];
        const checklist = prior && phases.find((id) => phases.indexOf(id) > phases.indexOf(prior)
            && outputs[id]?.outputs?.some((path) => path.toLowerCase()
                !== firstOutput.toLowerCase()));
        inputs.prerequisite = prior
            ? { phase: prior, output: firstOutput }
            : { phase: "", output: "" };
        inputs.artifact = checklist
            ? { phase: checklist, output: outputs[checklist].outputs.find((path) =>
                path.toLowerCase() !== inputs.prerequisite.output.toLowerCase()) }
            : { phase: "", output: "" };
    }
    return { id: globalThis.crypto?.randomUUID?.() ?? `badge-${Date.now()}`,
        type: type.id, inputs, text: type.defaultText, color: type.defaultColor,
        showIn: ["workflow-list"], phase: null, targets: [] };
}

function defaultSummaryText(type) {
    return `${type.title} ({workflows} workflows)`;
}

function editableBadge(badge, rule, type) {
    const draft = structuredClone(badge);
    for (const input of rule.inputs ?? []) {
        if (input.type === "artifact" && !draft.inputs[input.id]) {
            draft.inputs[input.id] = { phase: "", output: "" };
        } else if (input.type === "ordered-artifacts" && !Array.isArray(draft.inputs[input.id])) {
            draft.inputs[input.id] = [];
        } else if (input.type === "text" && typeof draft.inputs[input.id] !== "string") {
            draft.inputs[input.id] = "";
        }
    }
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

function checkedPhases(badge, rule) {
    const selected = new Set();
    for (const descriptor of rule.inputs ?? []) {
        const value = badge.inputs[descriptor.id];
        if (descriptor.type === "phase" && value) selected.add(value);
        else if (descriptor.type === "artifact" && value?.phase
            && !(rule.id === "checklist-complete" && descriptor.id === "prerequisite")) {
            selected.add(value.phase);
        }
        else if (descriptor.type === "artifact-set") {
            for (const entry of value ?? []) if (entry.outputs?.length) selected.add(entry.phase);
        }
    }
    return selected;
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
    draftBadges, onChange }) {
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
    const openCatalog = () => {
        pending = null;
        catalogOpen = true;
        redraw();
        root.querySelector(".badge-type-choice")?.focus?.();
    };
    const redraw = () => {
        root.replaceChildren();
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
                    pending = newDraft(type, badgeRules, phases, outputs);
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
                const detail = element("div");
                detail.append(element("strong", label || type?.title || badge.type),
                    element("p", placementSummary(badge, phases), "settings-note"));
                if (!available) detail.append(element("p",
                    "This badge type is unavailable. Ask your agent to restore it, or remove this badge before saving.",
                    "settings-field-error"));
                const actions = element("div", undefined, "badge-actions");
                const edit = element("button", "Edit", "badge-edit");
                edit.type = "button";
                edit.disabled = !available;
                edit.setAttribute("aria-label", `Edit ${label || type?.title || badge.type}`);
                edit.addEventListener("click", () => {
                    pending = editableBadge(badge, rules.get(type.rule), type);
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
        editor.append(heading, element("p", rule.description, "settings-note"));
        const error = element("p", undefined, "settings-field-error");
        error.setAttribute("role", "alert");
        error.tabIndex = -1;
        error.hidden = true;
        const editDuplicate = element("button", "Edit existing badge", "badge-duplicate-edit");
        editDuplicate.type = "button";
        editDuplicate.hidden = true;
        let duplicateTarget;
        editDuplicate.addEventListener("click", () => {
            if (!duplicateTarget) return;
            pending = editableBadge(duplicateTarget, rule, type);
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
        editor.addEventListener("input", () => revealError(""));
        editor.addEventListener("change", () => revealError(""));
        const phaseChoices = phaseOptions(phases);
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
        const ordered = (rule.inputs ?? []).find(({ type }) => type === "ordered-artifacts");
        editor.append(colorGroup, element("h3", ordered
            ? "Phase and output to check" : "Phases and outputs"));
        let phasePlacement;
        let refreshLegacy = () => {};
        const syncPhasePlacement = () => {
            if (!phasePlacement?.checked) return;
            const selected = phaseCardPhases();
            if (!selected.length) {
                phasePlacement.checked = false;
                phaseTextField.hidden = true;
                delete pending.phaseText;
                revealError("Phase cards are available only for workflow phases. Choose workflow-phase evidence.");
            }
            pending.targets = selected.map((phase) => ({ phase, output: null }));
            refreshLegacy();
        };
        if (ordered) {
            const target = pending.inputs[ordered.before];
            const targetPhase = select(phaseChoices, target.phase, "Target phase");
            const targetOutput = select(artifactOptions(outputs, target.phase),
                target.output, "Target output");
            const targetWarning = element("p",
                "This phase has no confirmed matching output. Choose an output on the Outputs page or select a different phase.",
                "settings-field-error");
            const earlierGroup = element("div", undefined, "badge-artifact-set");
            const explanation = element("div", undefined, "settings-note");
            const refresh = () => {
                targetOutput.replaceChildren(...artifactOptions(outputs, target.phase).map(([path]) => {
                    const option = element("option", path);
                    option.value = path;
                    return option;
                }));
                targetOutput.value = target.output;
                targetWarning.hidden = !!outputs[target.phase]?.outputs?.includes(target.output);
                earlierGroup.replaceChildren();
                const prerequisites = pending.inputs[ordered.id];
                const earlier = phases.slice(0, phases.indexOf(target.phase));
                const invalid = prerequisites.filter((entry) => !earlier.includes(entry.phase)
                    || !outputs[entry.phase]?.outputs?.includes(entry.output));
                if (invalid.length) {
                    earlierGroup.append(element("p",
                        "Some saved choices are no longer earlier confirmed outputs. Remove or correct them before saving.",
                        "settings-field-error"));
                    const remove = element("button", "Remove unavailable selections");
                    remove.type = "button";
                    remove.addEventListener("click", () => {
                        pending.inputs[ordered.id] = prerequisites.filter((entry) => !invalid.includes(entry));
                        refresh();
                    });
                    earlierGroup.append(remove);
                }
                const setChoice = (id, output) => {
                    const remaining = pending.inputs[ordered.id]
                        .filter((entry) => entry.phase !== id);
                    if (output) remaining.push({ phase: id, output });
                    pending.inputs[ordered.id] = remaining.sort((a, b) =>
                        phases.indexOf(a.phase) - phases.indexOf(b.phase));
                    refresh();
                };
                for (const id of earlier) {
                    const title = phaseOptions([id])[0][1];
                    const selected = prerequisites.find((entry) => entry.phase === id);
                    const label = element("label", undefined, "badge-check");
                    const checkbox = element("input");
                    checkbox.type = "checkbox";
                    checkbox.checked = !!selected;
                    checkbox.disabled = !outputs[id]?.outputs?.length;
                    checkbox.addEventListener("change", () =>
                        setChoice(id, checkbox.checked
                            ? outputs[id]?.view ?? outputs[id].outputs[0] : null));
                    label.append(checkbox, element("span", title));
                    earlierGroup.append(label);
                    if (checkbox.disabled) {
                        earlierGroup.append(element("p",
                            `No confirmed outputs for ${title}. Add one on the Outputs page.`,
                            "settings-note"));
                    }
                    if (!selected) continue;
                    const outputList = element("div", undefined, "badge-output-list");
                    outputList.setAttribute("role", "radiogroup");
                    outputList.setAttribute("aria-label", `${title} outputs`);
                    for (const [path] of artifactOptions(outputs, id)) {
                        const option = element("label", undefined, "badge-check");
                        const radio = element("input");
                        radio.type = "radio";
                        radio.name = `badge-${pending.id}-${id}`;
                        radio.checked = selected.output === path;
                        radio.addEventListener("change", () => { if (radio.checked) setChoice(id, path); });
                        option.append(radio, element("span", path));
                        outputList.append(option);
                    }
                    earlierGroup.append(outputList);
                }
                explanation.replaceChildren();
                const chain = [...pending.inputs[ordered.id]
                    .filter((entry) => earlier.includes(entry.phase)
                        && outputs[entry.phase]?.outputs?.includes(entry.output))
                    .sort((a, b) => phases.indexOf(a.phase) - phases.indexOf(b.phase)), target];
                for (const [index, entry] of chain.entries()) {
                    const title = phaseOptions([entry.phase])[0][1];
                    explanation.append(element("p", index
                        ? `${title}: ${entry.output} must exist and be at least as recent as ${chain[index - 1].output}.`
                        : `${title}: ${entry.output} must exist.`));
                }
                if (chain.length > 1) {
                    explanation.append(element("p",
                        "All of these conditions must pass for a workflow."));
                }
                syncPhasePlacement();
            };
            targetPhase.addEventListener("change", () => {
                target.phase = targetPhase.value;
                target.output = outputs[target.phase]?.view ?? outputs[target.phase]?.outputs?.[0] ?? "";
                refresh();
            });
            targetOutput.addEventListener("change", () => {
                target.output = targetOutput.value;
                refresh();
            });
            editor.append(field("Target phase", targetPhase), field("Required output", targetOutput),
                targetWarning,
                element("h3", "Which earlier outputs must be current?"), earlierGroup,
                element("h3", "When this badge appears"), explanation);
            refresh();
        }
        if (!ordered) {
        for (const descriptor of rule.inputs ?? []) {
            if (rule.inputs.length > 1 && descriptor.type !== "text") {
                editor.append(element("h4", descriptor.label ?? (descriptor.type === "phase"
                    ? "Completion phase" : descriptor.type === "text"
                        ? "Text to match" : "Output to check")));
            }
            if (descriptor.type === "text") {
                const value = element("input");
                value.type = "text";
                value.maxLength = 256;
                value.value = pending.inputs[descriptor.id];
                value.addEventListener("input", () => { pending.inputs[descriptor.id] = value.value; });
                editor.append(field(descriptor.label ?? "Text to match", value,
                    "Match this literal text anywhere in the output, ignoring capitalization."));
            } else if (descriptor.type === "phase") {
                const value = pending.inputs[descriptor.id];
                const group = element("div", undefined, "badge-phase-list");
                const choices = [];
                for (const [id, title] of phaseChoices) {
                    const label = element("label", undefined, "badge-check");
                    const checkbox = element("input");
                    checkbox.type = "checkbox";
                    checkbox.checked = value === id;
                    checkbox.addEventListener("change", () => {
                        pending.inputs[descriptor.id] = checkbox.checked ? id : "";
                        for (const [otherId, other] of choices) other.checked = otherId === pending.inputs[descriptor.id];
                        syncPhasePlacement();
                    });
                    choices.push([id, checkbox]);
                    label.append(checkbox, element("span", title));
                    group.append(label);
                }
                editor.append(group);
            } else if (descriptor.type === "artifact") {
                const value = pending.inputs[descriptor.id];
                const group = element("div", undefined, "badge-phase-list");
                const choices = [];
                for (const [id, title] of phaseChoices) {
                    const label = element("label", undefined, "badge-check");
                    const checkbox = element("input");
                    checkbox.type = "checkbox";
                    checkbox.checked = value.phase === id;
                    const outputList = element("div", undefined, "badge-output-list");
                    outputList.setAttribute("role", "group");
                    outputList.setAttribute("aria-label", `${title} outputs`);
                    outputList.hidden = !checkbox.checked;
                    const outputChoices = [];
                    for (const [path] of artifactOptions(outputs, id)) {
                        const item = element("label", undefined, "badge-check");
                        const output = element("input");
                        output.type = "checkbox";
                        output.checked = value.phase === id && value.output === path;
                        output.addEventListener("change", () => {
                            value.phase = id;
                            value.output = output.checked ? path : "";
                            for (const [otherId, other, list, options] of choices) {
                                other.checked = otherId === value.phase;
                                list.hidden = !other.checked;
                                for (const [otherPath, input] of options) {
                                    input.checked = otherId === value.phase && otherPath === value.output;
                                }
                            }
                            syncPhasePlacement();
                        });
                        outputChoices.push([path, output]);
                        item.append(output, element("span", path));
                        outputList.append(item);
                    }
                    if (!outputChoices.length) outputList.append(element("p",
                        "No confirmed outputs. Add one on the Outputs page.", "settings-note"));
                    checkbox.addEventListener("change", () => {
                        value.phase = checkbox.checked ? id : "";
                        value.output = checkbox.checked ? outputs[id]?.view ?? outputs[id]?.outputs?.[0] ?? "" : "";
                        for (const [otherId, other, list, options] of choices) {
                            other.checked = otherId === value.phase;
                            list.hidden = !other.checked;
                            for (const [path, input] of options) {
                                input.checked = otherId === value.phase && path === value.output;
                            }
                        }
                        syncPhasePlacement();
                    });
                    choices.push([id, checkbox, outputList, outputChoices]);
                    label.append(checkbox, element("span", title));
                    group.append(label, outputList);
                }
                editor.append(group);
            } else if (descriptor.type === "artifact-set") {
                const group = element("div", undefined, "badge-artifact-set");
                const chosen = new Set((pending.inputs[descriptor.id] ?? [])
                    .flatMap(({ phase, outputs: paths }) => paths.map((path) => JSON.stringify([phase, path]))));
                const available = phases.filter((id) => outputs[id]?.outputs?.length);
                const confirmed = new Set(available.flatMap((id) =>
                    outputs[id].outputs.map((path) => JSON.stringify([id, path]))));
                const stale = [...chosen].filter((key) => !confirmed.has(key));
                const updateInputs = () => {
                    pending.inputs[descriptor.id] = phases.map((id) => ({
                        phase: id, outputs: (outputs[id]?.outputs ?? [])
                            .filter((path) => chosen.has(JSON.stringify([id, path]))),
                    })).filter((entry) => entry.outputs.length);
                    syncPhasePlacement();
                };
                const warning = element("p", stale.length
                    ? "Some selected evidence outputs are no longer confirmed. Choose a current output to replace them."
                    : "", "settings-field-error");
                warning.hidden = !stale.length;
                for (const [id, title] of phaseChoices) {
                    const label = element("label", undefined, "badge-check");
                    const phase = element("input");
                    phase.type = "checkbox";
                    phase.checked = outputs[id]?.outputs?.some((path) =>
                        chosen.has(JSON.stringify([id, path]))) ?? false;
                    const outputList = element("div", undefined, "badge-output-list");
                    outputList.setAttribute("role", "group");
                    outputList.setAttribute("aria-label", `${title} outputs`);
                    outputList.hidden = !phase.checked;
                    const outputChecks = [];
                    for (const [path] of artifactOptions(outputs, id)) {
                        const item = element("label", undefined, "badge-check");
                        const checkbox = element("input");
                        checkbox.type = "checkbox";
                        const key = JSON.stringify([id, path]);
                        checkbox.checked = chosen.has(key);
                        checkbox.addEventListener("change", () => {
                            for (const oldKey of stale) chosen.delete(oldKey);
                            warning.hidden = true;
                            if (checkbox.checked) chosen.add(key);
                            else chosen.delete(key);
                            phase.checked = outputChecks.some(([key]) => chosen.has(key));
                            outputList.hidden = !phase.checked;
                            updateInputs();
                        });
                        outputChecks.push([key, checkbox]);
                        item.append(checkbox, element("span", path));
                        outputList.append(item);
                    }
                    if (!outputChecks.length) outputList.append(element("p",
                        "No confirmed outputs. Add one on the Outputs page.", "settings-note"));
                    phase.addEventListener("change", () => {
                        for (const oldKey of stale) chosen.delete(oldKey);
                        warning.hidden = true;
                        for (const [key, checkbox] of outputChecks) {
                            if (!phase.checked) chosen.delete(key);
                            checkbox.checked = chosen.has(key);
                        }
                        if (phase.checked && !outputChecks.some(([key]) => chosen.has(key))) {
                            const preferred = outputs[id]?.view ?? outputs[id]?.outputs?.[0];
                            if (preferred) chosen.add(JSON.stringify([id, preferred]));
                            for (const [key, checkbox] of outputChecks) checkbox.checked = chosen.has(key);
                        }
                        outputList.hidden = !phase.checked;
                        updateInputs();
                    });
                    label.append(phase, element("span", title));
                    group.append(label, outputList);
                }
                if (!available.length) {
                    group.append(element("p", "Add a confirmed output on the Outputs page first.", "settings-note"));
                }
                group.append(warning);
                editor.append(group);
            }
        }
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
        const phaseCardPhases = () => (rule.placementPhaseInput
            ? [pending.inputs[rule.placementPhaseInput]?.phase].filter(Boolean)
            : [...checkedPhases(pending, rule)]).filter(supportsPhaseCard);
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
                revealError("Phase cards are available only for workflow phases. Choose workflow-phase evidence.");
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
            || !supportsPhaseCard(phase)
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
            for (const descriptor of rule.inputs ?? []) {
                const value = pending.inputs[descriptor.id];
                if (descriptor.type === "text"
                    && (typeof value !== "string" || !value.trim()
                        || value.length > 256 || /[\x00-\x1f\x7f]/.test(value))) {
                    return revealError("Enter text to match (1-256 characters).");
                }
                if (descriptor.type === "phase" && !phases.includes(value)) {
                    return revealError("Choose a phase for this badge to check.");
                }
                if (descriptor.type === "artifact"
                    && !outputs[value?.phase]?.outputs?.includes(value.output)) {
                    return revealError("Choose a confirmed output for this badge to check.");
                }
                if (descriptor.type === "artifact-set"
                    && (!Array.isArray(value) || !value.some((entry) => entry.outputs?.length)
                        || value.some((entry) => !phases.includes(entry.phase)
                            || !Array.isArray(entry.outputs)
                            || entry.outputs.some((path) =>
                                !outputs[entry.phase]?.outputs?.includes(path))))) {
                    return revealError("Choose at least one confirmed output for this badge to check.");
                }
                if (descriptor.type === "ordered-artifacts") {
                    const target = pending.inputs[descriptor.before];
                    const chain = [...value, target];
                    if (!Array.isArray(value) || value.length > 100
                        || chain.some((entry) => !phases.includes(entry?.phase)
                            || !outputs[entry.phase]?.outputs?.includes(entry.output))
                        || chain.some((entry, index) => index > 0
                            && phases.indexOf(chain[index - 1].phase) >= phases.indexOf(entry.phase))
                        || new Set(chain.map((entry) => entry.output.toLowerCase())).size !== chain.length) {
                        return revealError("Choose one distinct confirmed output per selected earlier phase.");
                    }
                }
            }
            if (rule.id === "checklist-complete") {
                const { artifact, prerequisite } = pending.inputs;
                if (phases.indexOf(prerequisite.phase) >= phases.indexOf(artifact.phase)
                    || prerequisite.output.toLowerCase() === artifact.output.toLowerCase()) {
                    return revealError("Choose a different confirmed earlier output for Checklist complete.");
                }
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
