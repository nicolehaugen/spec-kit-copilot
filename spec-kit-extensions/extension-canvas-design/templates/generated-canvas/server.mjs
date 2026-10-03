import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { UserError } from "./files.mjs";
import { phaseContract, valueContract } from "./contract.mjs";

const styles = readFileSync(new URL("./ui/workflow-theme.css", import.meta.url), "utf8");
const script = readFileSync(new URL("./ui/app.js", import.meta.url), "utf8");
const markdown = readFileSync(new URL("./ui/markdown.mjs", import.meta.url), "utf8");
const pageAssets = readFileSync(new URL("./ui/page-assets.mjs", import.meta.url), "utf8");
const runtimeStyles = readFileSync(new URL("./ui/runtime.css", import.meta.url), "utf8");
const RESERVED_GENERATED_PAGE_ID = "workflow";
const imageValueContract = { type: "image", maxBytes: 32768,
    mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] };

const escapeHtml = (value) => String(value).replace(/[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function validImageAsset(asset, basename) {
    return asset && typeof asset === "object" && !Array.isArray(asset)
        && Object.keys(asset).sort().join() === "file,hash,mime"
        && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(asset.mime)
        && asset.file === `${basename}.${{
            "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
            "image/webp": "webp",
        }[asset.mime]}`
        && /^[a-f0-9]{64}$/.test(asset.hash);
}

function readOnlySections(fields) {
    const groups = new Map();
    const ungrouped = Symbol("ungrouped");
    for (const field of fields ?? []) {
        const key = field.section?.id ?? ungrouped;
        if (!groups.has(key)) groups.set(key, { title: field.section?.title ?? "Configured fields", fields: [] });
        groups.get(key).fields.push(field);
    }
    return [...groups.values()].map(({ title, fields: entries }) =>
        `<section class="phase-card" aria-label="${escapeHtml(title)}"><h2>${escapeHtml(title)}</h2><dl class="phase-facts">${entries.map(({ id, label, value }) =>
            `<dt>${escapeHtml(label)}</dt><dd data-field-id="${escapeHtml(id)}">${escapeHtml(value)}</dd>`).join("")}</dl></section>`).join("");
}

export function readConfig() {
    const config = JSON.parse(readFileSync(new URL("./canvas-config.json", import.meta.url), "utf8"));
    if (config.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(config.canvas?.id)
        || ["displayName", "description", "workflowListName"].some((key) =>
            typeof config.canvas[key] !== "string" || !config.canvas[key].trim())
        || !Array.isArray(config.phases) || !config.phases.length
        || config.phases.some((phase) => typeof phase !== "string" || !phase)
        || typeof config.userProvidesSlug !== "boolean"
        || (config.readOnlyFields !== undefined
            && (!Array.isArray(config.readOnlyFields) || config.readOnlyFields.length > 100
                || new Set(config.readOnlyFields.map((field) => field?.id)).size !== config.readOnlyFields.length
                || config.readOnlyFields.some((field) => !field || typeof field !== "object"
                    || Array.isArray(field)
                    || Object.keys(field).some((key) => !["id", "label", "value", "section"].includes(key))
                    || typeof field.id !== "string"
                    || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(field.id)
                    || typeof field.label !== "string" || !field.label || field.label.length > 120
                    || typeof field.value !== "string" || field.value.length > 1000
                    || (field.section !== undefined
                        && (!field.section || typeof field.section !== "object"
                            || Array.isArray(field.section)
                            || Object.keys(field.section).sort().join() !== "id,title"
                            || typeof field.section.id !== "string"
                            || !/^[a-z][a-z0-9.-]{0,79}$/.test(field.section.id)
                            || typeof field.section.title !== "string"
                            || !field.section.title.trim() || field.section.title.length > 120)))))
        || (config.generatedPages !== undefined
            && (!Array.isArray(config.generatedPages) || config.generatedPages.length > 30
                || new Set(config.generatedPages.map((page) => page?.id)).size !== config.generatedPages.length
                || config.generatedPages.some((page) => !page || typeof page !== "object"
                            || Array.isArray(page) || Object.keys(page).some((key) =>
                                !["id", "renderer", "title", "values", "slots"].includes(key))
                            || typeof page.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(page.id)
                            || page.id === RESERVED_GENERATED_PAGE_ID
                            || typeof page.renderer !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(page.renderer)
                            || typeof page.title !== "string" || !page.title.trim() || page.title.length > 120
                            || (page.slots !== undefined && (!Array.isArray(page.slots)
                                || page.slots.length > 30
                                || new Set(page.slots.map((slot) => slot?.id)).size !== page.slots.length
                                || page.slots.some((slot) => !slot || typeof slot !== "object"
                                    || Object.keys(slot).sort().join() !== "accepts,id"
                                    || typeof slot.id !== "string"
                                    || !/^[a-z][a-z0-9.-]{0,79}$/.test(slot.id)
                                    || JSON.stringify(slot.accepts) !== '["asset"]'))))))
        || (config.generatedPageAssets !== undefined
            && (!Array.isArray(config.generatedPageAssets)
                || config.generatedPageAssets.length > 10
                || new Set(config.generatedPageAssets.map((asset) => asset?.id)).size
                    !== config.generatedPageAssets.length
                || new Set(config.generatedPageAssets.map((asset) =>
                    `${asset?.page}:${asset?.slot}`)).size !== config.generatedPageAssets.length
                || config.generatedPageAssets.some((asset) => !asset
                    || Object.keys(asset).sort().join() !== "file,hash,id,label,mime,page,slot"
                    || typeof asset.id !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(asset.id)
                    || typeof asset.label !== "string" || !asset.label.trim() || asset.label.length > 120
                    || typeof asset.page !== "string" || typeof asset.slot !== "string"
                    || !config.generatedPages?.some((page) => page.id === asset.page
                        && page.slots?.some((slot) => slot.id === asset.slot
                            && slot.accepts.includes("asset")))
                    || !validImageAsset({ file: asset.file, hash: asset.hash, mime: asset.mime },
                        `asset-${createHash("sha256").update(asset.id).digest("hex").slice(0,24)}`))))
        || (config.generatedControls !== undefined
            && (!Array.isArray(config.generatedControls) || config.generatedControls.length > 30
                || new Set(config.generatedControls.map((item) => item?.id)).size !== config.generatedControls.length
                || config.generatedControls.some((item) => !item
                    || Object.keys(item).sort().join() !== "adapter,control,id,label,properties,slot,value"
                    || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(item.id)
                    || !/^[a-z][a-z0-9-]{0,79}$/.test(item.adapter)
                    || !/^[a-z][a-z0-9-]{0,79}$/.test(item.control)
                    || typeof item.label !== "string" || !item.label || item.label.length > 120
                    || item.slot !== "details.content"
                    || !item.properties || typeof item.properties !== "object"
                    || Array.isArray(item.properties) || !Object.keys(item.properties).length
                    || !item.value || typeof item.value !== "object" || Array.isArray(item.value)
                    || Object.keys(item.value).sort().join() !== Object.keys(item.properties).sort().join()
                    || Object.entries(item.properties).some(([key, allowed]) =>
                        !/^[a-z][A-Za-z0-9]{0,39}$/.test(key)
                        || !Array.isArray(allowed) || !allowed.length || allowed.length > 20
                        || !allowed.includes(item.value[key])))))
        || !config.phaseOutputs || typeof config.phaseOutputs !== "object" || Array.isArray(config.phaseOutputs)
        || Object.values(config.phaseOutputs).some((output) => !output
            || typeof output.expectsArtifact !== "boolean"
            || (output.outputPath !== null && typeof output.outputPath !== "string"))
        || (config.brandAsset !== undefined && !validImageAsset(config.brandAsset, "logo"))
        || (config.mainPageAsset !== undefined && !validImageAsset(config.mainPageAsset, "main-page-logo"))
        || (config.imageControl !== undefined && (!config.imageControl
            || Object.keys(config.imageControl).sort().join() !== "adapter,definition,definitionHash,hash"
            || !/^[a-z][a-z0-9-]{0,79}$/.test(config.imageControl.adapter)
            || !/^[a-z][a-z0-9-]{0,79}$/.test(config.imageControl.definition)
            || !/^[a-f0-9]{64}$/.test(config.imageControl.hash)
            || !/^[a-f0-9]{64}$/.test(config.imageControl.definitionHash)))
        || (!config.imageControl && !!(config.brandAsset || config.mainPageAsset
            || config.generatedPageAssets?.length))
        || (config.imageControl && config.generatedControls?.some((item) =>
            item.adapter === config.imageControl.adapter))
        || (config.theme !== undefined && !["light", "dark"].includes(config.theme))
        || !config.installed || ["presets", "extensions", "bundles"].some((kind) =>
            !Array.isArray(config.installed[kind]) || config.installed[kind].some((item) =>
                typeof item.id !== "string" || typeof item.version !== "string"))) {
        throw new Error("Invalid generated canvas configuration");
    }
    for (const asset of [config.brandAsset, config.mainPageAsset, ...(config.generatedPageAssets ?? [])]) {
        if (asset) readImageAsset(asset);
    }
    if (config.imageControl) readImageControl(config.imageControl);
    const sections = new Map();
    for (const { section } of config.readOnlyFields ?? []) {
        if (!section) continue;
        if (sections.has(section.id) && sections.get(section.id) !== section.title) {
            throw new Error(`Conflicting generated canvas section: ${section.id}`);
        }
        sections.set(section.id, section.title);
    }
    phaseContract(config);
    valueContract(config);
    return config;
}

function readImageAsset(asset) {
    const bytes = readFileSync(new URL(`./assets/${asset.file}`, import.meta.url));
    if (!bytes.length || bytes.length > 32 * 1024
        || createHash("sha256").update(bytes).digest("hex") !== asset.hash) {
        throw new Error("Packaged image does not match its frozen hash");
    }
    return bytes;
}

function readImageControl(control) {
    const bytes = readFileSync(new URL(`./controls/${control.adapter}.mjs`, import.meta.url));
    if (!bytes.length || bytes.length > 32 * 1024
        || createHash("sha256").update(bytes).digest("hex") !== control.hash) {
        throw new Error("Packaged stock.image adapter does not match its frozen hash");
    }
    const definition = readFileSync(new URL(`./controls/${control.definition}.json`, import.meta.url));
    const parsed = JSON.parse(definition);
    if (createHash("sha256").update(definition).digest("hex") !== control.definitionHash
        || parsed.id !== "stock.image" || parsed.adapters?.generated !== control.adapter
        || JSON.stringify(Object.entries(parsed.value ?? {}).sort())
            !== JSON.stringify(Object.entries(imageValueContract).sort())) {
        throw new Error("Packaged stock.image definition does not match its frozen contract");
    }
    return bytes;
}
function phaseLabel(phase) {
    if (phase.replace(/^speckit\./, "") === "taskstoissues") return "Create issues";
    return phase.replace(/^speckit\./, "").split(/[._-]/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function renderPhase(config, phases, index) {
    const phase = phases[index];
    const outputPath = phaseContract(config).find((step) => step.id === phase).output ?? "No declared output";
    return `<header class="workflow-header">
        <div class="workflow-header-main"><div class="phase-heading"><h2>${escapeHtml(phaseLabel(phase))}</h2><span class="phase-notice">Not run</span></div>
        <p class="tagline">${escapeHtml(phase.startsWith("speckit.") ? phase : `speckit.${phase}`)}</p></div>
    </header>
    <dl class="phase-facts"><dt>View target</dt><dd><button class="phase-artifact-link" id="browse-output-folder" type="button" title="Open the viewer target's folder"><code>${escapeHtml(outputPath)}</code></button></dd></dl>
    <p id="phase-artifact-status" class="muted" role="status"></p>
    <p id="phase-other-outputs" class="muted" hidden></p>
    <label class="field" for="phase-args">
        <span class="field-label" id="phase-input-label">Phase input</span>
        <span class="visually-hidden" id="phase-input-help">Add details or direction for this phase.</span>
        <textarea class="phase-input-control" id="phase-args" aria-labelledby="phase-input-label" aria-describedby="phase-input-help" placeholder="Add details or direction for this phase."></textarea>
    </label>
    <div id="phase-message" class="muted" role="status"></div>
    <footer class="phase-actions phase-actions-nav">
        <div class="phase-actions-left"><button class="btn btn-secondary" id="previous-phase" type="button">&#9664; Back</button></div>
        <div class="phase-actions-center">
            <button class="btn btn-primary" id="run-phase" type="button" aria-describedby="phase-message">Run phase</button>
            <button class="btn btn-secondary" id="view-artifact" type="button" aria-describedby="phase-artifact-status" hidden>View artifact</button>
        </div>
        <div class="phase-actions-right"><button class="btn btn-secondary" id="next-phase" type="button">Continue &#9654;</button></div>
    </footer>`;
}

export function renderHtml(config, token = "") {
    const { canvas } = config;
    const isConstitution = (phase) => phase.replace(/^speckit\./, "") === "constitution";
    const phases = config.phases.filter((phase) => !isConstitution(phase));
    const hasConstitution = config.phases.some(isConstitution);
    const intro = `<div><h2 id="workflow-heading">${escapeHtml(canvas.workflowListName)} <span class="muted" id="workflow-count">(0)</span></h2><p class="collection-description muted">${escapeHtml(canvas.description)}</p></div>`;
    return `<!doctype html>
<html lang="en"${config.theme ? ` data-theme="${escapeHtml(config.theme)}"` : ""}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(canvas.displayName)}</title><style>${styles}\n${runtimeStyles}</style></head>
<body>
<header class="app-header">
    <div class="brand"><span class="brand-mark${config.brandAsset ? " brand-image" : ""}"${config.brandAsset
        ? ` data-stock-image="header.brand" data-image-file="${escapeHtml(config.brandAsset.file)}" data-image-alt="" data-image-class="generated-image"`
        : ' aria-hidden="true"'}>${config.brandAsset ? "" : "&#9671;"}</span><span class="brand-text">${escapeHtml(canvas.displayName)}</span></div>
    <div class="header-status"><button class="btn-icon" id="theme-toggle" type="button" title="Toggle theme" aria-label="Toggle theme">&#9680;</button><button class="btn btn-secondary" id="refresh-state" type="button">Refresh</button><span id="connection-status" class="conn conn-connecting" role="status">Connecting</span></div>
</header>
<main class="app-body workflow-surface">
    <section id="instance-collection" class="instance-collection" aria-labelledby="workflow-heading">
        <div class="instance-collection-head">
            ${config.mainPageAsset
                ? `<div class="collection-intro"><span data-stock-image="workflow.intro" data-image-file="${escapeHtml(config.mainPageAsset.file)}" data-image-alt="${escapeHtml(canvas.displayName)} logo" data-image-class="collection-logo generated-image"></span>${intro}</div>`
                : intro}
            <button class="btn btn-secondary" id="new-workflow" type="button">+ New</button>
        </div>
        <div id="workflow-identity" class="workflow-identity-fields"${phases.length ? "" : " hidden"}>
            <label class="field" for="workflow-name">
                <span class="field-label" id="workflow-name-label">Workflow name <span class="muted">(optional)</span></span>
                <input class="phase-input-control" id="workflow-name" type="text" maxlength="120" placeholder="My workflow">
            </label>
            ${config.userProvidesSlug ? `<label class="field" for="workflow-slug">
                <span class="field-label" id="workflow-slug-label">Artifact directory slug <span class="muted">(optional)</span></span>
                <input class="phase-input-control" id="workflow-slug" type="text" maxlength="100" placeholder="your-slug">
            </label>` : ""}
        </div>
        <label id="workflow-search-field" class="workflow-search" for="workflow-search" hidden><span class="visually-hidden">Search workflows</span><input id="workflow-search" type="search" placeholder="Search workflows by name or directory"></label>
        <div id="workflow-list" class="instance-list" role="list" aria-label="Existing workflows" hidden></div>
        <div id="workflow-empty" class="instance-list" hidden><button id="create-first-workflow" class="instance-select empty-workflow" type="button"><span class="empty-workflow-mark" aria-hidden="true">+</span><span class="instance-select-main"><strong>No workflows yet</strong><span class="muted">Create a workflow to see it here.</span></span><span class="empty-workflow-action" aria-hidden="true">Create workflow &#8594;</span></button></div>
        <p id="workflow-list-status" class="muted" role="status" hidden></p>
    </section>
    ${readOnlySections(config.readOnlyFields)}
    ${config.valueSources?.length ? '<section id="canvas-values" class="phase-card" aria-label="Canvas values"><h2>Canvas values</h2><div id="canvas-value-list"></div><p id="canvas-value-errors" role="alert"></p></section>' : ""}
    ${config.generatedControls?.map(({ id, label, adapter, control, properties, value }) =>
        `<section class="phase-card" aria-label="${escapeHtml(label)}">
            <h2>${escapeHtml(label)}</h2><div data-control-id="${escapeHtml(id)}"
                data-field-label="${escapeHtml(label)}"
                data-control-type="${escapeHtml(control)}"
                data-contract="${escapeHtml(JSON.stringify({ type: "object", properties }))}"
                data-module="/controls/${escapeHtml(adapter)}.mjs"
                data-value="${escapeHtml(JSON.stringify(value))}"></div></section>`).join("") ?? ""}
    ${config.generatedPages?.length ? `<nav class="phase-navigation" aria-label="Canvas pages">
        <button class="btn btn-secondary" type="button" data-canvas-page="workflow" aria-current="page">Workflow</button>
        ${config.generatedPages.map(({ id, title }) => `<button class="btn btn-secondary" type="button" data-canvas-page="${escapeHtml(id)}">${escapeHtml(title)}</button>`).join("")}
    </nav>
    <section id="generated-page" class="phase-card" data-canvas-id="${escapeHtml(canvas.id)}"
        data-canvas-title="${escapeHtml(canvas.displayName)}"
        data-values="${escapeHtml(JSON.stringify(Object.fromEntries((config.readOnlyFields ?? []).map(({ id, value }) => [id, value]))))}" hidden></section>` : ""}
    ${hasConstitution ? `<details id="constitution-card" class="constitution-card" aria-label="Project constitution" open>
        <summary><strong>Constitution</strong><span class="muted" id="constitution-status">Not run</span></summary>
        <div class="constitution-details"><p id="constitution-prerequisite">Project principles apply to every workflow.</p><p id="constitution-artifact-status" class="muted" role="status"></p>
        <div class="constitution-actions"><button class="btn btn-secondary" id="view-constitution" type="button" aria-describedby="constitution-artifact-status" hidden>View</button><button class="btn btn-secondary" id="run-constitution" type="button">Create / update</button></div></div>
    </details>` : ""}
    <p id="canvas-message" role="status"></p>
    <nav id="phase-navigation" class="phase-navigation" aria-label="Workflow phases">
        ${phases.length ? `<div class="phase-mobile-nav"><label class="visually-hidden" for="mobile-phase-select">Jump to phase</label><select id="mobile-phase-select" class="phase-input-control">${phases.map((phase, index) =>
            `<option value="${index}">Phase ${index + 1} of ${phases.length}: ${escapeHtml(phaseLabel(phase))}</option>`).join("")}</select><span id="mobile-next-phase" class="muted"></span></div>` : ""}
        ${phases.length ? `<ol class="stepper">${phases.map((phase, index) => `
            ${index > 0 ? '<li class="step-sep" aria-hidden="true"></li>' : ""}
            <li><button class="step${index === 0 ? " active" : ""}" type="button" data-phase-index="${index}" data-phase-label="${escapeHtml(phaseLabel(phase))}"${index === 0 ? ' aria-current="step"' : ""} aria-label="Phase ${index + 1} of ${phases.length}: ${escapeHtml(phaseLabel(phase))}">
                <span class="step-order" aria-hidden="true">${index + 1}</span>
                <span class="step-label"><span class="step-name">${escapeHtml(phaseLabel(phase))}</span></span>
            </button></li>`).join("")}</ol>` : ""}
    </nav>
    <section id="phase-card" class="phase-card" aria-label="Selected phase">${phases.length ? renderPhase(config, phases, 0) : '<div class="workflow-empty">No workflow phases are configured.</div>'}</section>
    ${config.generatedPages?.map(({ id, renderer, slots }) =>
        `<span hidden data-generated-renderer="${escapeHtml(id)}" data-module="/pages/${escapeHtml(renderer)}.mjs"
            data-asset-slots="${escapeHtml(JSON.stringify(slots ?? []))}"
            data-assets="${escapeHtml(JSON.stringify((config.generatedPageAssets ?? [])
                .filter((asset) => asset.page === id)))}"></span>`).join("") ?? ""}
    ${config.imageControl ? `<span hidden id="stock-image-registration"
        data-module="/controls/${escapeHtml(config.imageControl.adapter)}.mjs"
        data-assets="${escapeHtml(JSON.stringify([config.brandAsset, config.mainPageAsset,
            ...(config.generatedPageAssets ?? [])].filter(Boolean).map((asset) => asset.file)))}"></span>` : ""}
    ${phases.map((_, index) => `<template id="phase-template-${index}">${renderPhase(config, phases, index)}</template>`).join("")}
</main>
<dialog id="artifact-viewer" class="artifact-viewer" aria-labelledby="artifact-title"><header class="artifact-viewer-header"><button class="btn btn-secondary artifact-viewer-back" id="close-artifact" type="button">&#8592; Canvas</button><div class="artifact-viewer-title"><h2 id="artifact-title">Artifact</h2><code id="artifact-path" class="muted"></code></div></header><div class="artifact-viewer-body"><p id="artifact-message" role="status"></p><article id="artifact-content" class="artifact-viewer-md"></article></div></dialog>
<dialog id="delete-workflow-dialog" aria-labelledby="delete-workflow-title"><h2 id="delete-workflow-title">Delete <span id="delete-workflow-name"></span>?</h2><p>This permanently deletes the selected workflow directory and everything in it:</p><p><code id="delete-workflow-directory"></code></p><footer class="viewer-head"><button class="btn btn-secondary" id="cancel-delete-workflow" type="button">Cancel</button><button class="btn btn-danger" id="confirm-delete-workflow" type="button">Delete workflow</button></footer></dialog>
${hasConstitution ? `<dialog id="constitution-dialog" aria-labelledby="constitution-dialog-title"><h2 id="constitution-dialog-title">Create / update Constitution</h2><label class="field" for="constitution-args"><span class="field-label">Guidance (optional)</span><textarea class="phase-input-control" id="constitution-args"></textarea></label><p id="constitution-message" role="status"></p><footer class="viewer-head"><button class="btn btn-secondary" id="cancel-constitution" type="button">Cancel</button><button class="btn btn-primary" id="send-constitution" type="button">Run phase</button></footer></dialog>` : ""}
<script type="module" src="/ui/app.js?token=${escapeHtml(encodeURIComponent(token))}"></script>
</body></html>`;
}

export function createWorkflowRoutes(config, { runtime, instanceId, token, port, log = () => {} }) {
    const html = renderHtml(config, token);
    const clients = new Set();
    const json = (response, status, value) => response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value));
    const handle = async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
        let url;
        try { url = new URL(request.url, "http://127.0.0.1"); }
        catch { response.writeHead(400).end("Invalid URL"); return; }
        const supplied = request.headers["x-canvas-token"] ?? url.searchParams.get("token");
        const candidate = Buffer.from(typeof supplied === "string" ? supplied : "");
        const expected = Buffer.from(token);
        if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
            response.writeHead(401).end("Unauthorized"); return;
        }
        try {
            if (request.method === "GET" && ["/", "/ui/app.js", "/ui/markdown.mjs",
                "/ui/page-assets.mjs"].includes(url.pathname)) {
                const body = url.pathname === "/" ? html : url.pathname === "/ui/app.js"
                    ? script : url.pathname === "/ui/markdown.mjs" ? markdown : pageAssets;
                response.writeHead(200, { "Content-Type": `${url.pathname === "/" ? "text/html" : "text/javascript"}; charset=utf-8` }).end(body);
                return;
            }
            const imageAsset = [config.brandAsset, config.mainPageAsset,
                ...(config.generatedPageAssets ?? [])]
                .find((asset) => asset && url.pathname === `/assets/${asset.file}`);
            if (request.method === "GET" && imageAsset) {
                const bytes = readImageAsset(imageAsset);
                response.writeHead(200, { "Content-Type": imageAsset.mime,
                    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
                    .end(bytes);
                return;
            }
            const moduleName = /^\/pages\/([a-z][a-z0-9-]{0,79})\.mjs$/.exec(url.pathname)?.[1];
            if (request.method === "GET" && moduleName
                && config.generatedPages?.some((page) => page.renderer === moduleName)) {
                const module = readFileSync(new URL(`./pages/${moduleName}.mjs`, import.meta.url));
                response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(module);
                return;
            }
            const controlName = /^\/controls\/([a-z][a-z0-9-]{0,79})\.mjs$/.exec(url.pathname)?.[1];
            if (request.method === "GET" && controlName
                && (config.generatedControls?.some((item) => item.adapter === controlName)
                    || config.imageControl?.adapter === controlName)) {
                const module = config.imageControl?.adapter === controlName
                    ? readImageControl(config.imageControl)
                    : readFileSync(new URL(`./controls/${controlName}.mjs`, import.meta.url));
                response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" })
                    .end(module);
                return;
            }
            if (!runtime) throw new UserError("The Copilot session runtime is unavailable. Reopen the canvas.", 503);
            if (request.method === "GET" && url.pathname === "/api/events") {
                response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
                response.write("data: refresh\n\n");
                clients.add(response);
                request.on("close", () => clients.delete(response));
                return;
            }
            if (request.method === "GET" && url.pathname === "/api/state") return json(response, 200, await runtime.snapshot());
            if (request.method === "GET" && url.pathname === "/api/artifact") return json(response, 200, await runtime.artifact({
                phase: url.searchParams.get("phase"), itemId: url.searchParams.get("itemId"),
            }));
            if (request.method !== "POST" || !["/api/run", "/api/state", "/api/values", "/api/refresh", "/api/reveal", "/api/workflow/delete"].includes(url.pathname)) return json(response, 404, { error: "Not found" });
            const origin = request.headers.origin;
            if (origin && origin !== `http://127.0.0.1:${port()}`) throw new UserError("Untrusted request origin.", 403);
            if (!request.headers["content-type"]?.startsWith("application/json")) throw new UserError("Expected a JSON request.", 415);
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
                size += chunk.length;
                if (size > 128 * 1024) throw new UserError("Request is too large.", 413);
                chunks.push(chunk);
            }
            let input;
            try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new UserError("Invalid JSON request."); }
            if (!input || typeof input !== "object" || Array.isArray(input)) throw new UserError("Expected a JSON object.");
            const result = url.pathname === "/api/run" ? await runtime.run(input, instanceId)
                : url.pathname === "/api/state" ? await runtime.save(input)
                    : url.pathname === "/api/values" ? await runtime.saveValue(input)
                    : url.pathname === "/api/reveal" ? await runtime.reveal(input)
                        : url.pathname === "/api/workflow/delete" ? await runtime.deleteWorkflow(input)
                            : await runtime.refresh();
            return json(response, url.pathname === "/api/run" ? 202 : 200, result);
        } catch (error) {
            if (!(error instanceof UserError)) await log("Generated canvas request failed. Check the local runtime and state permissions.");
            json(response, error instanceof UserError ? error.status : 500, {
                error: error instanceof UserError ? error.message : "Could not complete this action. Check the file and state permissions, then refresh.",
            });
        }
    };
    return {
        handle,
        broadcast: () => { for (const client of clients) client.write("data: refresh\n\n"); },
        close: () => {
            for (const client of clients) client.end();
            clients.clear();
        },
    };
}
