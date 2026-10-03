import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { freezeGeneration } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/generation.mjs";
import { materialize } from "../extension-canvas-design/scripts/generate.mjs";
import { mountPageAssets, createStockImageRenderer } from
    "../extension-canvas-design/templates/generated-canvas/ui/page-assets.mjs";

const source = new URL("../extension-canvas-design/", import.meta.url);
const logo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YC24x8AAAAASUVORK5CYII=";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const handoff = { handoffId: "image-handoff", selections: {},
    workflow: { selectedPhases: ["specify"],
        installed: { presets: [], extensions: [], bundles: [] } } };
handoff.sourceFingerprint = digest(JSON.stringify({
    workflow: handoff.workflow, selections: handoff.selections,
}));

async function setup(t, selected = [logo, logo, logo]) {
    const root = join(process.cwd(), `.canvas-image-test-${randomUUID()}`);
    t.after(() => rm(root, { recursive: true, force: true }));
    const project = join(root, "project"), workspace = join(root, "workspace");
    const specify = join(project, ".specify", "templates");
    await mkdir(specify, { recursive: true });
    await mkdir(workspace);
    const handoffFolder = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId);
    await mkdir(handoffFolder, { recursive: true });
    await writeFile(join(handoffFolder, "handoff.json"), JSON.stringify(handoff));
    const names = [
        ["shared-controls-image", "shared.control-definition", "controls/stock-image/control.json"],
        ["generated-control-adapter-image", "generated.control-adapter", "controls/stock-image/generated.mjs"],
    ];
    const templates = [];
    for (const [name, kind, file] of names) {
        const path = join(specify, `${name}.${kind === "shared.control-definition" ? "json" : "mjs"}`);
        const bytes = await readFile(new URL(file, source));
        await writeFile(path, bytes);
        templates.push({ name, kind, sourceId: "extension:extension-canvas-design",
            strategy: "replace", path: await realpath(path), hash: digest(bytes) });
    }
    const page = { schemaVersion: 1, id: "gallery", title: "Gallery", renderer: "gallery-renderer",
        slots: [{ id: "gallery.logo" }] };
    const pageFiles = [
        ["gallery", "generated.added-page-definition", JSON.stringify(page)],
        ["gallery-renderer", "generated.added-page-renderer",
            'export function renderPage({ root }) { const el = document.createElement("div"); el.dataset.assetSlot = "gallery.logo"; root.append(el); }'],
    ];
    for (const [name, kind, text] of pageFiles) {
        const path = join(specify, `${name}.${kind === "generated.added-page-definition" ? "json" : "mjs"}`);
        await writeFile(path, text);
        templates.push({ name, kind, sourceId: "extension:extension-canvas-design",
            strategy: "replace", path: await realpath(path), hash: digest(text) });
    }
    const fieldIds = ["canvas.logo", "main.logo", "gallery.logo"];
    const baseConstraints = {
        "canvas.id": { type: "string", minLength: 1, maxLength: 100, pattern: "^[a-z0-9][a-z0-9-]*$" },
        "canvas.displayName": { type: "string", minLength: 1, maxLength: 120 },
    };
    const constraints = Object.fromEntries(fieldIds.map((id) => [id, { type: "image", maxBytes: 32768,
        mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] }]));
    const values = { "canvas.id": "image-canvas", "canvas.displayName": "Image canvas",
        ...Object.fromEntries(fieldIds.map((id, index) => [id, selected[index]])) };
    const contributions = fieldIds.map((id, index) => ({
        name: `image-${index}`,
        field: { id, label: `Logo ${index}`, type: "image", control: "stock.image" },
        generatedBinding: { presentation: "asset",
            slot: ["header.brand", "workflow.intro", "gallery.logo"][index],
            ...(index === 2 ? { page: "gallery" } : {}) },
    }));
    const model = { revision: "image-revision",
        pages: [{ page: "designer-essentials", fields: [
            { id: "canvas.id" }, { id: "canvas.displayName" }] }],
        constraints: { ...baseConstraints, ...constraints }, templates, contributions,
        controls: [{ id: "stock.image", adapters: { generated: "generated-control-adapter-image" } }],
        generatedPages: [{ id: "gallery", name: "gallery", title: "Gallery",
            renderer: "gallery-renderer", slots: page.slots }] };
    const prepared = await freezeGeneration({ model, values, handoff, project, workspace });
    const requestPath = join(handoffFolder, "generations", prepared.requestId, "request.json");
    const sdk = join(project, ".github", "extensions", "image-canvas");
    return { project, workspace, prepared, sdk, requestPath, templates, model, values };
}

async function rewrite(requestPath, edit) {
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    edit(request);
    const { integrity: _previous, ...payload } = request;
    await writeFile(requestPath, JSON.stringify({ ...payload, integrity: digest(JSON.stringify(payload)) }));
}

test("stock.image resolves a unique frozen definition by control ID", async (t) => {
    const { project, workspace, templates, model, values } = await setup(t);
    const missing = { ...model, templates: templates.filter((entry) =>
        entry.name !== "shared-controls-image") };
    await assert.rejects(freezeGeneration({ model: missing, values, handoff, project, workspace }),
        /Missing paired stock.image definition or generated adapter/);
    const duplicate = { ...model, templates: [...templates, {
        ...templates.find((entry) => entry.name === "shared-controls-image"),
        name: "another-stock-image",
    }] };
    await assert.rejects(freezeGeneration({ model: duplicate, values, handoff, project, workspace }),
        /Missing paired stock.image definition or generated adapter/);
});

test("one frozen stock.image adapter renders Header, Main and gallery without design-time files", async (t) => {
    const { project, workspace, prepared, sdk, requestPath } = await setup(t);
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    assert.equal(request.generatedImageControl.assets.length, 2);
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const { readConfig, renderHtml, createWorkflowRoutes } = await import(pathToFileURL(join(sdk, "server.mjs")).href);
    const config = readConfig();
    assert.equal(config.imageControl.adapter, "generated-control-adapter-image");
    assert.equal(config.generatedPageAssets.length, 1);
    const configPath = join(sdk, "canvas-config.json");
    const configText = await readFile(configPath, "utf8");
    for (const obsolete of [{ accepts: ["asset"] }, { orderBy: ["order"] }]) {
        const invalid = structuredClone(config);
        invalid.generatedPages[0].slots[0] = { ...invalid.generatedPages[0].slots[0], ...obsolete };
        await writeFile(configPath, JSON.stringify(invalid));
        assert.throws(() => readConfig(), /Invalid generated canvas configuration/);
    }
    await writeFile(configPath, configText);
    const html = renderHtml(config, "secret");
    assert.match(html, /data-stock-image="header.brand"/);
    assert.match(html, /data-stock-image="workflow.intro"/);
    assert.match(html, /gallery.logo/);
    assert.doesNotMatch(html, /<img src="\/assets\/logo/);
    const packaged = join(sdk, "controls", "generated-control-adapter-image.mjs");
    assert.deepEqual((await readdir(join(sdk, "controls"))).sort(),
        ["generated-control-adapter-image.mjs", "shared-controls-image.json"]);
    assert.equal(await readFile(packaged, "utf8"),
        await readFile(new URL("controls/stock-image/generated.mjs", source), "utf8"));
    const routes = createWorkflowRoutes(config, { token: "secret", runtime: null });
    const server = createServer(routes.handle);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
        routes.close();
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${url}/controls/generated-control-adapter-image.mjs`)).status, 401);
    assert.equal((await fetch(`${url}/controls/generated-control-adapter-image.mjs?token=secret`)).status, 200);
    assert.equal((await fetch(`${url}/assets/logo.png?token=secret`)).status, 200);
    assert.equal((await fetch(`${url}/assets/unlisted.png?token=secret`)).status, 503);
    const portable = join(workspace, "portable");
    await cp(sdk, portable, { recursive: true });
    assert.equal((await import(`${pathToFileURL(join(portable, "server.mjs")).href}?portable=1`))
        .readConfig().imageControl.hash, config.imageControl.hash);
    await writeFile(packaged, "export const controlId = 'tampered';");
    assert.throws(() => readConfig(), /adapter does not match its frozen hash/);
    assert.equal((await fetch(`${url}/controls/generated-control-adapter-image.mjs?token=secret`)).status, 500);
    await writeFile(packaged, await readFile(new URL("controls/stock-image/generated.mjs", source)));
    await writeFile(join(sdk, "assets", "logo.png"), "tampered");
    assert.throws(() => readConfig(), /image does not match its frozen hash/);
    assert.equal((await fetch(`${url}/assets/logo.png?token=secret`)).status, 500);
});

test("missing Logo keeps diamond; frozen image and adapter tampering fail before packaging", async (t) => {
    const { project, workspace, prepared, sdk, requestPath, templates } = await setup(t, ["", logo, ""]);
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    await rewrite(requestPath, (candidate) => { candidate.generatedImageControl.assets[1].hash = "0".repeat(64); });
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /stock.image control asset or hash/);
    await rewrite(requestPath, (candidate) => {
        candidate.generatedImageControl = structuredClone(request.generatedImageControl);
        candidate.generatedImageControl.assets[1].name = "wrong-adapter";
    });
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /Incompatible frozen stock.image/);
    await rewrite(requestPath, (candidate) => {
        candidate.generatedImageControl = structuredClone(request.generatedImageControl);
        const module = 'import "https://example.invalid/foreign.mjs"; export function mount() {}';
        candidate.generatedImageControl.assets[1].content = Buffer.from(module).toString("base64");
        candidate.generatedImageControl.assets[1].hash = digest(module);
    });
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /adapter must be self-contained/);
    await rewrite(requestPath, (candidate) => {
        candidate.generatedImageControl = structuredClone(request.generatedImageControl);
        candidate.generatedImageControl.assets[0].content = Buffer.from(JSON.stringify({
            schemaVersion: 1, id: "stock.image",
            value: { type: "image", maxBytes: 64, mimeTypes: ["image/png"] },
            adapters: { designer: "designer-control-adapter-image",
                generated: "generated-control-adapter-image" },
        })).toString("base64");
        candidate.generatedImageControl.assets[0].hash =
            digest(Buffer.from(candidate.generatedImageControl.assets[0].content, "base64"));
    });
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /Incompatible frozen stock.image/);
    await rewrite(requestPath, (candidate) => {
        candidate.generatedImageControl = structuredClone(request.generatedImageControl);
        candidate.generatedAssets[0].hash = "0".repeat(64);
    });
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /image bytes or hash/);
    await rewrite(requestPath, (candidate) => {
        candidate.generatedAssets = structuredClone(request.generatedAssets);
        delete candidate.generatedImageControl;
    });
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /require a frozen stock.image/);
    await assert.rejects(readFile(join(sdk, "extension.mjs")), { code: "ENOENT" });
    await writeFile(requestPath, JSON.stringify(request));
    await writeFile(templates[1].path, "export const controlId = 'changed';");
    await assert.rejects(freezeGeneration({
        model: { revision: "changed", pages: [{ page: "designer-essentials",
            fields: [{ id: "canvas.id" }, { id: "canvas.displayName" }] }],
        constraints: request.fieldConstraints,
        contributions: [{ field: { id: "canvas.logo", type: "image", control: "stock.image" },
            generatedBinding: { presentation: "asset", slot: "header.brand" } }],
        templates, controls: [{ id: "stock.image",
            adapters: { generated: "generated-control-adapter-image" } }] },
        values: request.values, handoff, project, workspace }), /generated asset changed/);
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const { readConfig, renderHtml } = await import(pathToFileURL(join(sdk, "server.mjs")).href);
    const config = readConfig();
    assert.equal(config.brandAsset, undefined);
    assert.match(renderHtml(config), /brand-mark" aria-hidden="true">&#9671;/);
    await assert.rejects(readFile(join(sdk, "assets", "logo.png")), { code: "ENOENT" });
    assert.equal(config.imageControl.adapter, "generated-control-adapter-image");
});

test("the shared image adapter mounts only its authorized presentation; gallery slots remain host-owned", async () => {
    const { mount, controlId, valueContract } = await import(
        new URL("../extension-canvas-design/controls/stock-image/generated.mjs", import.meta.url));
    const definition = JSON.parse(await readFile(new URL(
        "../extension-canvas-design/controls/stock-image/control.json", import.meta.url)));
    assert.equal(controlId, definition.id);
    assert.equal(definition.adapters.generated, "generated-control-adapter-image");
    assert.deepEqual(valueContract, definition.value);
    assert.deepEqual(definition.value, { type: "image", maxBytes: 32768,
        mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] });
    const previousDocument = globalThis.document;
    const image = {};
    globalThis.document = { createElement: (tag) => {
        assert.equal(tag, "img"); return image;
    } };
    try {
        const target = { replaceChildren(...children) { this.children = children; } };
        const field = { id: "gallery.logo", label: "Gallery Logo" };
        const value = "/assets/asset-local.png?token=secret";
        const context = { alt: "Gallery Logo", className: "generated-image" };
        mount({ root: target, field, value, context });
        assert.deepEqual(target.children, [image]);
        assert.equal(image.src, value);
        assert.equal(image.alt, context.alt);
        assert.equal(image.className, context.className);
        assert.throws(() => mount({ root: target, field, value: null, context }),
            /Invalid packaged image presentation/);
        assert.throws(() => mount({ root: target, field, value, context: null }),
            /Invalid packaged image presentation/);
        const slot = { dataset: { assetSlot: "gallery.logo" } };
        const content = { querySelectorAll: () => [slot] };
        const assets = [{ id: "gallery.logo", label: "Gallery Logo",
            slot: "gallery.logo", file: "asset-local.png" }];
        const mounted = [];
        await mountPageAssets(content, [{ id: "gallery.logo" }],
            assets, async (root, asset) => mounted.push([root, asset]));
        assert.deepEqual(mounted, [[slot, assets[0]]]);
        await assert.rejects(mountPageAssets(content, [], assets, async () => {}),
            /Unknown or duplicate generated asset slot/);
        await assert.rejects(mountPageAssets(content, [{ id: "gallery.logo" }],
            assets, async () => { throw new Error("adapter failed"); }), /adapter failed/);
    } finally {
        globalThis.document = previousDocument;
    }
});

test("generated host exposes adapter failure rather than hiding or replacing a configured Logo", async () => {
    const registration = { dataset: { module: "/controls/generated-control-adapter-image.mjs",
        assets: '["logo.png"]' } };
    const field = { id: "canvas.logo", label: "Logo" };
    const asset = { file: "logo.png" };
    const root = { setAttribute(name, value) { this[name] = value; }, textContent: "" };
    const contract = { type: "image", maxBytes: 32768,
        mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] };
    const calls = [];
    const render = createStockImageRenderer(registration, "secret", async (url) => {
        calls.push(url);
        return { controlId: "stock.image", valueContract: contract,
            mount: async ({ value, context }) => { root.value = value; root.context = context; } };
    });
    await render(root, field, asset, "", "generated-image");
    assert.equal(root.value, "/assets/logo.png?token=secret");
    assert.deepEqual(root.context, { alt: "", className: "generated-image" });
    assert.equal(calls.length, 1);
    await render(root, field, asset, "", "generated-image");
    assert.equal(calls.length, 1);
    const failed = createStockImageRenderer(registration, "secret",
        async () => ({ controlId: "stock.text", valueContract: contract, mount() {} }));
    await failed(root, field, asset, "", "generated-image");
    assert.equal(root.role, "alert");
    assert.match(root.textContent, /Generated image could not render: Incompatible stock.image adapter/);
    const denied = createStockImageRenderer(registration, "secret", async () => {
        throw new Error("Should not load for unauthorized asset");
    });
    await denied(root, field, { file: "../secret.png" }, "", "generated-image");
    assert.match(root.textContent, /Unauthorized packaged image/);
    const throwing = createStockImageRenderer(registration, "secret",
        async () => ({ controlId: "stock.image", valueContract: contract,
            mount() { throw new Error("Adapter crashed"); } }));
    await throwing(root, field, asset, "", "generated-image");
    assert.match(root.textContent, /Generated image could not render: Adapter crashed/);
});
