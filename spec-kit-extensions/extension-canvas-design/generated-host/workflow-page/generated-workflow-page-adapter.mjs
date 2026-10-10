export const capabilities = ["workflow.badges.project.v1"];
export const pageId = "workflow";
export const contractVersion = 1;

const escapeHtml = (value) => String(value).replace(/[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

export function renderStockPage(root, definition) {
    const { canvas, mainPageAsset, readOnlyFields, textPlacements, generatedControls,
        hasConstitution, hasBadges, hasValues, fieldSlots } = definition;
    const heading = textPlacements.find((item) =>
        item.id === "canvas.workflowListName" && item.slot === "workflow.heading");
    const description = textPlacements.find((item) =>
        item.id === "canvas.description" && item.slot === "workflow.description");
    const intro = `<div><h2 id="workflow-heading">${heading
        ? `<span data-stock-text="workflow.heading" data-field-id="canvas.workflowListName"
            data-text-label="${escapeHtml(heading.label)}">${escapeHtml(canvas.workflowListName)}</span>`
        : escapeHtml(canvas.workflowListName)} <span class="muted" id="workflow-count">(0)</span></h2>
        <p class="collection-description muted"${description
        ? ` data-stock-text="workflow.description" data-field-id="canvas.description"
            data-text-label="${escapeHtml(description.label)}"` : ""}>${escapeHtml(canvas.description)}</p></div>`;
    const groups = new Map();
    for (const field of readOnlyFields) {
        const id = field.section?.id ?? "";
        if (!groups.has(id)) groups.set(id, { title: field.section?.title ?? "Configured fields", fields: [] });
        groups.get(id).fields.push(field);
    }
    const details = [...groups.values()].map(({ title, fields }) =>
        `<section class="phase-card" aria-label="${escapeHtml(title)}"><h2>${escapeHtml(title)}</h2><dl class="phase-facts">${fields.map(({ id, label, value }) =>
            `<dt>${escapeHtml(label)}</dt><dd data-field-id="${escapeHtml(id)}"${textPlacements.some((item) =>
                item.id === id && item.slot === "details.content")
                ? ` data-stock-text="details.content" data-text-label="${escapeHtml(label)}"` : ""}>${escapeHtml(value)}</dd>`).join("")}</dl></section>`).join("");
    root.innerHTML = `<section id="setup-surface" class="phase-card" aria-labelledby="setup-heading" hidden>
        <div class="setup-copy"><h2 id="setup-heading">Set up this project</h2>
        <p class="muted">Set up Spec Kit and install the selected presets, extensions, and bundles.</p></div>
        <div id="setup-actions"></div><p id="setup-status" role="status" hidden></p>
    </section>
    <section id="instance-collection" class="instance-collection" aria-labelledby="workflow-heading">
        <div class="instance-collection-head">
            ${mainPageAsset
                ? `<div class="collection-intro"><span data-stock-image="workflow.intro"
                    data-image-file="${escapeHtml(mainPageAsset.file)}"
                    data-image-alt="${escapeHtml(canvas.displayName)} logo"
                    data-image-class="collection-logo generated-image"></span>${intro}</div>` : intro}
            <button class="btn btn-secondary" id="new-workflow" type="button">New workflow</button>
        </div>
        <div id="workflow-identity" class="workflow-identity-fields" hidden>
            <label class="field" for="workflow-name"><span class="field-label" id="workflow-name-label">Workflow name</span>
                <input class="phase-input-control" id="workflow-name" type="text" maxlength="120"
                    placeholder="Workflow 1" aria-describedby="workflow-name-help">
                <span class="muted" id="workflow-name-help">Shown in the workflow list.</span></label>
            <label class="field" for="workflow-slug"><span class="field-label" id="workflow-slug-label">Artifact directory slug</span>
                <input class="phase-input-control" id="workflow-slug" type="text" maxlength="100"
                    pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="workflow-1"
                    aria-describedby="workflow-slug-help workflow-slug-error">
                <span class="muted" id="workflow-slug-help">Leave blank to let Spec Kit choose the directory.
                    Use lowercase, numbers, or hyphens.</span>
                <span id="workflow-slug-error" class="workflow-error" role="alert" hidden></span></label>
        </div>
        ${hasBadges && definition.badgeDestinations.includes("workflow.summary")
            ? '<div id="workflow-badge-summary" data-badge-slot="workflow.summary" class="canvas-badges" aria-label="Selected workflow badges" hidden></div>' : ""}
        ${hasBadges ? '<p id="workflow-badge-diagnostics" class="muted" role="status" hidden></p>' : ""}
        <label id="workflow-search-field" class="workflow-search" for="workflow-search" hidden>
            <span class="visually-hidden">Search workflows</span>
            <input id="workflow-search" type="search" placeholder="Search workflows by name or directory"></label>
        <div id="workflow-list" class="instance-list">
            <div id="workflow-rows" role="list" aria-labelledby="workflow-heading"${definition.badgeDestinations.includes("workflow.list")
                ? ' data-badge-slot="workflow.list"' : ""}></div>
            <p id="workflow-empty">No workflows yet.</p>
        </div>
        <p id="workflow-constitution-note" class="muted" hidden>Create a constitution to start a workflow.</p>
        <p id="workflow-list-status" class="muted" role="status" hidden></p>
        <p id="workflow-action-error" class="workflow-error" role="alert" hidden></p>
    </section>
    ${hasConstitution ? `<section id="constitution-card" class="constitution-card" aria-label="Constitution">
        <div class="constitution-summary"><strong>Constitution</strong><span class="muted">
            Applies to all workflows</span><span class="muted" id="constitution-status" role="status">Checking...</span>
            ${hasBadges && definition.badgeDestinations.includes("phase.card")
                ? '<span id="constitution-badges" class="canvas-badges" aria-label="Constitution badges"></span>' : ""}
        </div>
        <div class="constitution-details"><p id="constitution-prerequisite">Set the principles that guide every workflow in this project.</p>
            <p id="constitution-artifact-status" class="muted" role="status"></p>
        </div>
        <div class="constitution-actions">
            ${hasBadges && definition.badgeDestinations.includes("phase.output")
                ? '<span id="constitution-output-badges" class="canvas-badges" aria-label="Constitution output badges"></span>' : ""}
            <button class="btn btn-secondary" id="view-constitution" type="button"
                aria-describedby="constitution-artifact-status" hidden>View</button>
            <button class="btn btn-secondary" id="run-constitution" type="button">Create constitution</button>
        </div></section>` : ""}
    ${details}
    ${hasValues ? '<section id="canvas-values" class="phase-card" aria-label="Canvas values"><h2>Canvas values</h2><div id="canvas-value-list"></div><p id="canvas-value-errors" role="alert"></p></section>' : ""}
    ${generatedControls.map(({ id, label, adapter, control, properties, value }) =>
        `<section class="phase-card" aria-label="${escapeHtml(label)}">
            <h2>${escapeHtml(label)}</h2><div data-control-id="${escapeHtml(id)}"
                data-field-label="${escapeHtml(label)}" data-control-type="${escapeHtml(control)}"
                data-contract="${escapeHtml(JSON.stringify({ type: "object", properties }))}"
                data-module="/controls/${escapeHtml(adapter)}.mjs"
                data-value="${escapeHtml(JSON.stringify(value))}"></div></section>`).join("")}
    <div id="workflow-pipeline" hidden></div>
    ${fieldSlots.map((id) =>
        `<section class="phase-card" data-workflow-slot="${escapeHtml(id)}"></section>`).join("")}
    <dialog id="delete-workflow-dialog" aria-labelledby="delete-workflow-title">
        <h2 id="delete-workflow-title">Delete <span id="delete-workflow-name"></span>?</h2>
        <p>This permanently deletes the selected workflow directory and everything in it:</p>
        <p><code id="delete-workflow-directory"></code></p>
        <footer class="viewer-head"><button class="btn btn-secondary" id="cancel-delete-workflow"
            type="button">Cancel</button><button class="btn btn-danger" id="confirm-delete-workflow"
            type="button">Delete workflow</button></footer></dialog>
    ${hasConstitution ? `<dialog id="constitution-dialog" aria-labelledby="constitution-dialog-title">
        <h2 id="constitution-dialog-title">Create constitution</h2>
        <label class="field" for="constitution-args"><span class="field-label" id="constitution-args-label">
            Project principles</span><textarea class="phase-input-control" id="constitution-args" required></textarea></label>
        <p id="constitution-message" role="status"></p><footer class="viewer-head">
        <button class="btn btn-secondary" id="cancel-constitution" type="button">Cancel</button>
        <button class="btn btn-primary" id="send-constitution" type="button">Create constitution</button>
        </footer></dialog>` : ""}`;
}

export function mount({ root, definition, state, actions }) {
    if (!root || definition?.id !== pageId || typeof actions?.selectWorkflow !== "function"
        || typeof actions?.mountPhase !== "function") {
        throw new Error("Incompatible Workflow page host");
    }
    if (definition.canvas) renderStockPage(root, definition);
    const find = (id) => root.querySelector(`#${id}`)
        ?? (id.startsWith("setup-") ? document.getElementById(id) : null);
    const workflowIdentity = find("workflow-identity");
    let phaseControl;
    let query = "";
    let previousRows;
    const onSearch = (event) => {
        query = event.target.value;
        filter();
    };
    find("workflow-search")?.addEventListener("input", onSearch);
    function filter() {
        const rows = [...(find("workflow-rows")?.children ?? [])];
        let shown = 0;
        for (const row of rows) {
            row.hidden = !row.dataset.search.includes(query.toLowerCase().trim());
            if (!row.hidden) shown++;
        }
        const notice = find("workflow-list-status");
        if (!notice) return;
        const missing = state.model?.selected !== "__new__"
            && !state.model?.items.some((item) => item.id === state.model.selected);
        notice.textContent = missing
            ? "Selected workflow is unavailable. Choose another or start a new workflow."
            : query ? `${shown} of ${rows.length} workflows match.` : "";
        notice.hidden = !notice.textContent;
    }
    function badgeList(badges, phaseText = false) {
        const group = document.createElement("span");
        group.className = "canvas-badges";
        for (const badge of badges) {
            const label = document.createElement("span");
            label.className = "canvas-badge";
            label.dataset.color = badge.color;
            if (/^#[0-9a-fA-F]{6}$/.test(badge.color)) {
                label.style.backgroundColor = badge.color;
                const rgb = [1, 3, 5].map((index) => {
                    const channel = parseInt(badge.color.slice(index, index + 2), 16) / 255;
                    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                });
                const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
                label.style.color = (luminance + 0.05) / (0.005605 + 0.05)
                    >= 1.05 / (luminance + 0.05) ? "#111" : "#fff";
            }
            label.textContent = phaseText ? badge.phaseText ?? badge.text : badge.text;
            group.append(label);
        }
        return group;
    }
    function collection(model) {
        const phases = model.phases.filter((entry) => !entry.project);
        const rows = find("workflow-rows");
        if (!rows) return;
        if (model.items.length <= 8) query = "";
        find("workflow-count").textContent = `(${model.items.length})`;
        find("new-workflow").disabled = !phases.length;
        find("workflow-constitution-note").hidden = model.constitutionReady || !model.items.length;
        const pipeline = find("workflow-pipeline");
        pipeline.hidden = !phases.length;
        pipeline.classList.toggle("workflow-pipeline-idle", !model.items.some((item) => item.id === model.selected));
        const badgeRows = JSON.stringify(model.badges?.items ?? {});
        const matches = rows.children.length === model.items.length
            && model.items.every((entry, index) => rows.children[index].dataset.workflowId === entry.id)
            && previousRows === badgeRows;
        previousRows = badgeRows;
        const scroll = find("workflow-list").scrollTop;
        if (!matches) rows.replaceChildren(...model.items.map((entry) => {
            const row = document.createElement("div");
            row.className = "instance-row";
            row.setAttribute("role", "listitem");
            row.dataset.workflowId = entry.id;
            const select = document.createElement("button");
            select.type = "button";
            select.className = "instance-select";
            select.dataset.workflowId = entry.id;
            const identity = document.createElement("span");
            identity.className = "instance-select-main";
            identity.append(document.createElement("strong"), document.createElement("code"));
            select.append(identity);
            const badges = (model.badges?.items?.[entry.id] ?? [])
                .filter((badge) => badge.showIn.includes("workflow-list"));
            if (badges.length && rows.dataset.badgeSlot) {
                const slot = badgeList(badges);
                slot.dataset.badgeSlot = rows.dataset.badgeSlot;
                select.append(slot);
            }
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "instance-delete";
            remove.dataset.deleteWorkflowId = entry.id;
            row.append(select, remove);
            return row;
        }));
        for (const [index, entry] of model.items.entries()) {
            const row = rows.children[index];
            const active = entry.id === model.selected;
            row.classList.toggle("active", active);
            row.classList.toggle("pending", Boolean(entry.pending));
            row.dataset.search = `${entry.label} ${entry.slug}`.toLowerCase();
            const select = row.querySelector(".instance-select");
            if (active) select.setAttribute("aria-current", "true");
            else select.removeAttribute("aria-current");
            const name = select.querySelector("strong");
            name.textContent = entry.label;
            name.title = entry.label;
            const slug = select.querySelector("code");
            slug.textContent = entry.slug;
            slug.hidden = entry.slug === entry.label;
            let notice = select.querySelector(".phase-notice");
            if (entry.pending && !notice) {
                notice = document.createElement("span");
                notice.className = "phase-notice";
                select.append(notice);
            }
            if (notice) { notice.textContent = entry.status === "Completed" ? "" : entry.status ?? "Not started";
                notice.hidden = !entry.pending || entry.status === "Completed"; }
            const remove = row.querySelector(".instance-delete");
            remove.hidden = entry.id === "__new__";
            remove.textContent = entry.pending ? "Remove" : "Delete";
            remove.setAttribute("aria-label", `${remove.textContent} ${entry.label}`);
        }
        const editor = workflowIdentity;
        editor.hidden = !model.items.some((item) => item.id === model.selected && item.pending);
        const selectedRow = [...rows.children].find((row) => row.dataset.workflowId === model.selected);
        if (!editor.hidden && selectedRow && editor.parentElement !== selectedRow) selectedRow.append(editor);
        const summary = find("workflow-badge-summary");
        if (summary) {
            const badges = model.badges?.summary ?? [];
            summary.replaceChildren(...(badges.length ? [badgeList(badges)] : []));
            summary.hidden = !badges.length;
        }
        const diagnostics = find("workflow-badge-diagnostics");
        if (diagnostics) {
            diagnostics.textContent = model.badges?.diagnostics?.join(" ") ?? "";
            diagnostics.hidden = !diagnostics.textContent;
        }
        find("workflow-empty").hidden = Boolean(model.items.length);
        find("workflow-empty").textContent = phases.length
            ? "No workflows yet." : "No workflow phases are configured.";
        find("workflow-list").scrollTop = scroll;
        find("workflow-search-field").hidden = model.items.length <= 8;
        find("workflow-search").value = query;
        filter();
    }
    function setup(model) {
        const visible = model.showSetup && !model.setup?.ready;
        find("setup-surface").hidden = !visible;
        if (!visible) { actions.clearSetupPlan(); return; }
        const status = find("setup-status");
        status.textContent = model.setup.error ?? ({
            initializing: "Initializing Specify in Copilot skills mode. Check chat for progress.",
            "awaiting-confirmation": "Review the complete package batch before installation.",
            installing: "Installing confirmed packages. Check chat for progress.",
            failed: "Setup failed. Check chat, then retry.",
            cancelled: "Installation cancelled. No additional packages were installed. Select setup to try again.",
        }[model.setup.stage] ?? "");
        status.hidden = !status.textContent;
        status.classList.toggle("workflow-error", Boolean(model.setup.error));
        const button = find("setup-actions")?.querySelector("button");
        if (button) button.disabled = state.setupBusy || ["initializing", "installing"].includes(model.setup.stage);
        actions.confirmSetup(model.setup);
    }
    function values(model) {
        const container = find("canvas-value-list");
        if (!container) return;
        find("canvas-value-errors").textContent = Object.values(model.valueErrors).join(" ");
        find("canvas-values").hidden = !model.valueFields.length && !Object.keys(model.valueErrors).length;
        const active = document.activeElement;
        const editing = active?.closest?.("[data-edit-value]");
        const draft = editing && {
            id: editing.dataset.editValue,
            values: [...editing.querySelectorAll("input, select")].map((input) =>
                ({ property: input.dataset.property, value: input.value, checked: input.checked })),
            property: active.dataset.property,
            start: active instanceof HTMLInputElement && active.type === "text" ? active.selectionStart : null,
            end: active instanceof HTMLInputElement && active.type === "text" ? active.selectionEnd : null,
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
                output.textContent = typeof field.value === "object"
                    ? JSON.stringify(field.value) : String(field.value);
                row.append(output);
            } else {
                const editor = document.createElement("div");
                editor.dataset.editValue = field.id;
                const value = state.valueDrafts?.[field.id] ?? field.value;
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
                    && draft.start !== null && draft.end !== null) focused.setSelectionRange(draft.start, draft.end);
            }
        }
    }
    const onChange = (event) => {
        const row = event.target.closest?.("[data-edit-value]");
        if (!row) return;
        const field = state.model?.valueFields.find((entry) => entry.id === row.dataset.editValue && entry.editable);
        if (!field) return;
        const value = field.schema.type === "boolean" ? row.querySelector("input").checked
            : field.schema.type === "object"
                ? Object.fromEntries([...row.querySelectorAll("[data-property]")]
                    .map((input) => [input.dataset.property, input.value]))
                : row.querySelector("input").value;
        Promise.resolve().then(() => actions.saveValue(field.id, value)).catch((error) =>
            actions.error(new Error(`Value could not be saved: ${error.message} Your edit remains in this panel.`)));
    };
    root.addEventListener("change", onChange);
    const onInput = (event) => {
        if (event.target.id === "workflow-name" || event.target.id === "workflow-slug") {
            actions.setIdentity(event.target.id === "workflow-name" ? "name" : "slug", event.target.value);
        } else if (event.target.id === "constitution-args") {
            actions.setConstitutionDraft(event.target.value);
        }
    };
    const onFocusOut = (event) => {
        if (event.target.id === "workflow-slug" && event.target.value.trim()) actions.touchSlug();
    };
    root.addEventListener("input", onInput);
    root.addEventListener("focusout", onFocusOut);
    const onClick = (event) => {
        const button = event.target.closest?.("button");
        if (!button) return;
        const operation = async () => {
            if (button.dataset.deleteWorkflowId) return actions.deleteWorkflow(button.dataset.deleteWorkflowId);
            if (button.dataset.workflowId) return actions.selectWorkflow(button.dataset.workflowId);
            if (button.id === "new-workflow") {
                await actions.createWorkflow();
                query = "";
                find("workflow-search").value = "";
                filter();
                find("workflow-name")?.focus();
            } else if (button.id === "view-constitution") return actions.viewConstitution();
            else if (button.id === "run-constitution") {
                find("constitution-args").value = actions.constitutionDraft();
                find("constitution-dialog").showModal();
                find("constitution-args").focus();
            } else if (button.id === "send-constitution") {
                return actions.runConstitution(find("constitution-args").value);
            }
        };
        Promise.resolve().then(operation).catch((error) => actions.error(error));
    };
    root.addEventListener("click", onClick);
    function status(model) {
        const phase = model.phases.find((entry) => entry.project);
        if (phase) {
            if (model.badges?.project !== undefined && !Array.isArray(model.badges.project)) {
                throw new Error("Invalid project badge results");
            }
            const projectBadges = model.badges?.project ?? [];
            const forTarget = (output) => projectBadges.filter((badge) => badge.targets
                ? badge.targets.some((target) => target.phase === phase.id && target.output === output)
                : output === null && badge.showIn.includes("phase-card") && badge.phase === phase.id);
            find("constitution-badges")?.replaceChildren(badgeList(forTarget(null), true));
            find("constitution-output-badges")?.replaceChildren(badgeList(
                forTarget(phase.output), true));
            const result = model.statuses[phase.id];
            const available = result?.artifactAvailability === "available";
            const notice = find("constitution-artifact-status");
            notice.textContent = result?.artifactError ?? (available ? ""
                : result?.output ? `${result.output} is not available yet. Run the phase, then refresh to check again.`
                    : "No artifact is available for this phase yet. Run the phase, then refresh to check again.");
            notice.hidden = !notice.textContent;
            find("view-constitution").hidden = !available;
            find("constitution-card").classList.toggle("constitution-ready", available);
            const status = find("constitution-status");
            status.textContent = available ? ""
                : result?.artifactAvailability === "error" ? "Unavailable"
                    : result?.status === "Not run" ? "Needed before starting a workflow"
                        : result?.status ?? "Checking...";
            status.hidden = !status.textContent;
            const label = state.pendingLabel(phase) ?? (available ? "Update" : "Create constitution");
            find("run-constitution").textContent = label;
            find("send-constitution").textContent = state.pendingLabel(phase)
                ?? (available ? "Update constitution" : "Create constitution");
            for (const id of ["run-constitution", "send-constitution"]) {
                find(id).disabled = Boolean(model.showSetup && !model.setup?.ready);
            }
            find("run-constitution").title = model.showSetup && !model.setup?.ready ? "Available after setup" : "";
            find("constitution-dialog-title").textContent = available
                ? "Update constitution" : "Create constitution";
            find("constitution-args-label").textContent = available ? "Guidance (optional)" : "Project principles";
            find("constitution-args").required = !available;
        }
        const input = find("workflow-slug");
        const pending = model.items.some((item) => item.id === model.selected && item.pending);
        if (input && pending) {
            const error = state.slugTouched && input.value.trim() ? state.slugError : "";
            find("workflow-slug-error").textContent = error;
            find("workflow-slug-error").hidden = !error;
            input.setAttribute("aria-invalid", String(Boolean(error)));
        }
        const first = model.phases.find((entry) => !entry.project);
        const item = model.items.find((entry) => entry.id === model.selected);
        const locked = !pending || Boolean(item?.status && !["Not started", "Failed"].includes(item.status))
            || Boolean(state.sending && state.sending.phase === first?.id)
            || ["Request sent", "Running"].includes(model.statuses[first?.id]?.status);
        const name = find("workflow-name");
        if (name) {
            name.readOnly = locked;
            if (document.activeElement !== name && !state.inputPending) name.value = pending
                ? model.name ?? "" : item?.label ?? "";
        }
        if (input) {
            input.closest(".field").hidden = !model.userProvidesSlug;
            input.readOnly = locked;
            input.placeholder = locked ? "Automatically assigned" : "workflow-1";
            if (document.activeElement !== input && !state.inputPending) input.value = pending
                ? model.slug : item?.slug ?? "";
        }
        if (phaseControl) phaseControl.update(state.phaseState);
        find("workflow-pipeline").querySelectorAll("[data-phase-index]")
            .forEach((button) => { button.disabled = !item; });
        const mobile = find("mobile-phase-select");
        if (mobile) mobile.disabled = !item;
    }
    const initial = state.phaseState;
    phaseControl = actions.mountPhase(find("workflow-pipeline"), initial);
    if (!phaseControl || typeof phaseControl.update !== "function"
        || typeof phaseControl.dispose !== "function") throw new Error("Invalid phase control instance");
    return {
        update(next) {
            state = next;
            if (!next.model) return;
            setup(next.model);
            collection(next.model);
            values(next.model);
            status(next.model);
        },
        dispose() {
            find("workflow-search")?.removeEventListener("input", onSearch);
            root.removeEventListener("change", onChange);
            root.removeEventListener("input", onInput);
            root.removeEventListener("focusout", onFocusOut);
            root.removeEventListener("click", onClick);
            phaseControl.dispose();
        },
    };
}
