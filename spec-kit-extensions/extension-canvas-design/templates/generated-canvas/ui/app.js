const { renderMarkdown } = await import(`./markdown.mjs${new URL(import.meta.url).search}`);
for (const root of document.querySelectorAll("[data-control-id]")) {
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
        await mount({ root, field, value: JSON.parse(root.dataset.value) });
    } catch (error) {
        root.setAttribute("role", "alert");
        root.textContent = `Generated control could not render: ${error.message}`;
    }
}
const $ = (id) => document.getElementById(id);
const token = new URL(location.href).searchParams.get("token");
const steps = [...document.querySelectorAll("[data-phase-index]")];
const drafts = new Map();
let model, current = 0, sending = false, saving = Promise.resolve(), refreshSequence = 0;
let viewer = null, timer, saveFailure = null, workflowQuery = "";
const THEME_STORAGE_KEY = "speckit-generated-canvas.theme";

function wireGeneratedPages() {
    const root = $("generated-page");
    if (!root) return;
    const buttons = [...document.querySelectorAll("[data-canvas-page]")];
    let selection = 0;
    for (const button of buttons) button.addEventListener("click", async () => {
        const currentSelection = ++selection;
        const id = button.dataset.canvasPage;
        const workflow = id === "workflow";
        root.hidden = workflow;
        root.replaceChildren();
        root.classList.remove("workflow-error");
        $("phase-navigation").hidden = !workflow;
        $("phase-card").hidden = !workflow;
        for (const candidate of buttons) {
            if (candidate === button) candidate.setAttribute("aria-current", "page");
            else candidate.removeAttribute("aria-current");
        }
        if (workflow) return;
        const registration = [...document.querySelectorAll("[data-generated-renderer]")]
            .find((item) => item.dataset.generatedRenderer === id);
        try {
            if (!registration) throw new Error(`Missing generated page ${id}`);
            const { renderPage } = await import(`${registration.dataset.module}?token=${encodeURIComponent(token)}`);
            if (currentSelection !== selection) return;
            if (typeof renderPage !== "function") throw new Error(`Invalid renderer for ${id}`);
            const content = document.createElement("div");
            await renderPage({ root: content, canvas: { id: root.dataset.canvasId,
                displayName: root.dataset.canvasTitle }, values: JSON.parse(root.dataset.values) });
            if (currentSelection !== selection) return;
            root.replaceChildren(...content.childNodes);
        } catch (error) {
            if (currentSelection !== selection) return;
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
    saving = saving.catch(() => {}).then(async () => {
        const saved = await api("/api/state", { revision: model.revision, ...patch });
        model.revision = saved.revision;
        saveFailure = null;
    }).catch((error) => {
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
    if (selected) patch.draft = { item: model.selected, phase: selected.id, value: drafts.get(draftKey(selected)) ?? $("phase-args")?.value ?? "" };
    return persist(patch);
}
async function flush() {
    if (timer) { clearTimeout(timer); timer = null; saveInputs(); }
    await saving;
    if (saveFailure) throw saveFailure;
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
    const selected = phase();
    if (selected) {
        const status = model.statuses[selected.id];
        $("phase-card").querySelector(".phase-notice").textContent = status?.status ?? "Not run";
        const item = model.items.find((entry) => entry.id === model.selected);
        const slug = item?.slug ?? (model.selected === "__new__" ? model.slug : "");
        const resolveOutput = (output) => slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
            ? output?.replace("<slug>", slug) : output;
        const path = model.selected === "__new__" && selected.output ? resolveOutput(selected.output)
            : status?.output ?? resolveOutput(selected.output);
        const browse = $("browse-output-folder");
        browse.querySelector("code").textContent = path ?? "No declared output";
        const unresolved = !path || path.includes("<slug>") || path === "No declared output";
        browse.disabled = unresolved;
        browse.title = unresolved
            ? ($("workflow-slug") ? "Enter a workflow slug to resolve this path" : "Run the phase to resolve this path")
            : `Open ${path.slice(0, path.lastIndexOf("/")) || "."} in file explorer`;
        artifactAction("view-artifact", "phase-artifact-status", path !== status?.output
            ? { ...status, output: path, artifactAvailability: "unknown", artifactError: null } : status);
        const otherOutputs = $("phase-other-outputs");
        if (otherOutputs) {
            const paths = (selected.outputs ?? []).map(resolveOutput)
                .filter((output) => output !== path);
            otherOutputs.textContent = paths.length ? `Other expected outputs: ${paths.join(", ")}` : "";
            otherOutputs.hidden = !paths.length;
        }
        const run = $("run-phase");
        run.textContent = pendingLabel(selected) ?? (status?.status && status.status !== "Not run" ? "Run again" : "Run phase");
        if (status?.error) message(status.error, "phase-message", true);
    }
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
    }
    renderName();
    renderSlug();
}
function renderPhase(focusId) {
    if (!phase()) return;
    $("phase-card").replaceChildren($(`phase-template-${current}`).content.cloneNode(true));
    const key = draftKey(phase());
    $("phase-args").value = drafts.get(key) ?? model.drafts[key] ?? "";
    steps.forEach((button, index) => {
        button.classList.toggle("active", index === current);
        if (index === current) button.setAttribute("aria-current", "step");
        else button.removeAttribute("aria-current");
    });
    const mobileSelect = $("mobile-phase-select");
    if (mobileSelect) {
        mobileSelect.value = String(current);
        $("mobile-next-phase").textContent = current + 1 < steps.length
            ? `Next: ${steps[current + 1].dataset.phaseLabel}` : "Final phase";
    }
    const back = $("previous-phase"), next = $("next-phase");
    back.disabled = current === 0;
    next.disabled = current === steps.length - 1;
    back.textContent = current ? `◀ ${steps[current - 1].dataset.phaseLabel}` : "◀ Back";
    next.textContent = current + 1 < steps.length
        ? `Next: ${steps[current + 1].dataset.phaseLabel} ▶` : "Complete";
    renderStatus();
    if (focusId) $(focusId)?.focus({ preventScroll: true });
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
    if (!previous) current = Math.max(0, workflowPhases().findIndex((step) => step.id === model.phase));
    // Do not replace live input text during events or background refresh.
    if (previous && timer) {
        model.slug = previous.slug;
        model.name = previous.name;
    }
    renderCollection();
    if (!previous || previous.selected !== model.selected) renderPhase();
    else renderStatus();
}
async function selectPhase(index, focusId) {
    if (index < 0 || index >= workflowPhases().length) {
        message(index < 0 ? "You are at the first phase." : "You are at the last phase.", "phase-message");
        return;
    }
    await flush();
    await persist({ phase: workflowPhases()[index].id });
    current = index;
    renderPhase(focusId);
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
async function send(step, value, target = "phase-message") {
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
        const query = new URLSearchParams({ phase: context.phase, itemId: context.itemId });
        const result = await api(`/api/artifact?${query}`);
        if (viewer !== context) return;
        $("artifact-path").textContent = result.path;
        if (result.content.trim() || !context.loaded) $("artifact-content").innerHTML = renderMarkdown(result.content);
        context.loaded = true;
        message(result.message ?? "", "artifact-message");
    } catch (error) {
        if (viewer === context) message(context.loaded
            ? `Could not refresh the artifact. Displayed content is retained. ${error.message}` : error.message, "artifact-message", true);
    } finally { context.reading = false; }
    try { await refresh(); }
    catch (error) { message(`Could not refresh artifact availability: ${error.message}`, "canvas-message", true); }
}
async function openArtifact(step) {
    if (!step) throw new Error("Wait for the canvas to connect, then try again.");
    viewer = { phase: step.id, itemId: step.project ? "project" : model.selected, loaded: false };
    $("artifact-title").textContent = step.project ? "Constitution" : steps[current].dataset.phaseLabel;
    $("artifact-path").textContent = "";
    $("artifact-content").replaceChildren();
    $("artifact-viewer").showModal();
    $("close-artifact").focus();
    await refreshArtifact();
}
document.addEventListener("input", (event) => {
    if (!model) return;
    if (event.target.id === "phase-args") { remember(phase(), event.target.value); queueInput(); }
    if (event.target.id === "workflow-name") {
        model.name = event.target.value;
        queueInput();
    }
    if (event.target.id === "workflow-slug") { model.slug = event.target.value; queueInput(); renderStatus(); }
    if (event.target.id === "constitution-args") persist({ draft: remember(constitution(), event.target.value) });
});
$("workflow-search").addEventListener("input", (event) => {
    workflowQuery = event.target.value;
    if (model) filterWorkflowList();
});
$("mobile-phase-select")?.addEventListener("change", (event) => {
    selectPhase(Number(event.target.value), "mobile-phase-select")
        .catch((error) => {
            event.target.value = String(current);
            message(error.message, "canvas-message", true);
        });
});
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
            if (saveFailure) await saveInputs();
            message("Canvas refreshed.");
            return;
        }
        if (!model) throw new Error("The canvas is connecting. Use Refresh to try again.");
        if (button.dataset.deleteWorkflowId) { await deleteFeature(button.dataset.deleteWorkflowId); return; }
        if (button.dataset.workflowId) { await selectFeature(button.dataset.workflowId); return; }
        if (button.hasAttribute("data-phase-index")) await selectPhase(Number(button.dataset.phaseIndex));
        else if (button.id === "previous-phase") await selectPhase(current - 1, button.id);
        else if (button.id === "next-phase") await selectPhase(current + 1, button.id);
        else if (button.id === "new-workflow" || button.id === "create-first-workflow") {
            await selectFeature("__new__");
            $("workflow-name")?.focus();
        }
        else if (button.id === "run-phase") await send(phase(), $("phase-args").value);
        else if (button.id === "view-artifact") await openArtifact(phase());
        else if (button.id === "view-constitution") await openArtifact(constitution());
        else if (button.id === "browse-output-folder") {
            await flush();
            const result = await api("/api/reveal", { phase: phase().id, itemId: model.selected });
            message(result.message, "phase-message");
        } else if (button.id === "run-constitution") {
            const key = draftKey(constitution());
            $("constitution-args").value = drafts.get(key) ?? model.drafts[key] ?? "";
            $("constitution-dialog").showModal();
            $("constitution-args").focus();
        } else if (button.id === "send-constitution") await send(constitution(), $("constitution-args").value, "constitution-message");
    })().catch((error) => message(error.message, "canvas-message", true));
});
$("artifact-viewer").addEventListener("close", () => { viewer = null; });
wireThemeToggle();
wireGeneratedPages();
const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
events.onopen = () => setConnectionStatus("live");
events.onmessage = () => {
    if (!timer) saving.catch(() => {}).then(() => refresh()).catch((error) => message(error.message, "canvas-message", true));
    if (viewer) refreshArtifact();
};
events.onerror = () => { setConnectionStatus("lost"); message("Connection interrupted. Drafts are retained; use Refresh if reconnection fails."); };
window.addEventListener("beforeunload", (event) => {
    if (timer || saveFailure) { event.preventDefault(); event.returnValue = ""; }
});
window.addEventListener("pagehide", () => events.close());
await refresh().catch((error) => message(error.message, "canvas-message", true));
