import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHandler } from "../server.mjs";
import { buildDesignerHandoff, buildDesignerLaunchPrompt,
    checkDesignerProvider, DESIGNER_EXTENSION_ID, enableDesignerProvider,
    normalizeInstalledBundles, normalizeInstalledWorkflowInventory,
    readInstalledWorkflowInventory, validateDesignerSelections,
    validateLocalDesignerSelections } from "../server/handlers-designer.mjs";
import { fingerprint, readHandoff, validateHandoff } from "../../speckit-canvas-designer/handoff.mjs";
import { designerCatalogFingerprint } from "../catalog/designer-fingerprint.mjs";

// Real, valid manifests in this repo (same fixtures e2e/canvas-designer.spec.mjs
// uses), so local-dev validation and precedence are exercised against actual
// preset.yml/extension.yml parsing rather than a mocked validateLocalSource.
const LOCAL_PRESET_PATH = fileURLToPath(
    new URL("../../../../../spec-kit-presets/copilot-sub-agents", import.meta.url),
).replace(/[\\/]$/, "");
const LOCAL_CANVAS_DESIGN_EXT_PATH = fileURLToPath(
    new URL("../../../../../spec-kit-extensions/extension-canvas-design", import.meta.url),
).replace(/[\\/]$/, "");

const catalog = {
    designerFingerprint: "catalog-v1",
    presets: [{ id: "theme", source: "copilot", tags: ["canvas-design"],
        version: "1.0.0", downloadUrl: "https://example.org/theme.zip" }],
    extensions: [], bundles: [],
};
const snapshot = { pipeline: [{ id: "commands/plan" }], catalog };
const empty = { presets: [], extensions: [], bundles: [] };

function fixture(overrides = {}) {
    const sent = [];
    const errors = [];
    const inst = { workspacePath: process.cwd() };
    const provider = { id: DESIGNER_EXTENSION_ID, source: "plugin", status: "running" };
    const registered = { extensionId: DESIGNER_EXTENSION_ID, canvasId: "speckit-canvas-designer" };
    let current = snapshot;
    const session = {
        send: async (message) => { sent.push(message); },
        rpc: {
            extensions: { list: async () => ({ extensions: [provider] }),
                enable: async () => { provider.status = "running"; } },
            canvas: { list: async () => ({ canvases: [registered] }) },
        },
    };
    const handler = createHandler({
        token: "secret",
        log: async (message, level) => { errors.push({ message, level }); },
        getInstance: () => inst,
        getState: async () => current,
        getInstalledWorkflow: async () => empty,
        registerSse() {}, broadcast() {},
        ...overrides,
        session: { ...session, ...overrides.session },
    });
    async function post(body, token = "secret") {
        const req = Readable.from([Buffer.from(JSON.stringify(body))]);
        req.method = "POST";
        req.url = `/api/designer/launch?token=${token}`;
        req.headers = {};
        const res = {
            setHeader() {},
            writeHead(code) { this.statusCode = code; },
            end(data) { this.body = JSON.parse(data); },
        };
        await handler(req, res);
        await new Promise(setImmediate);
        return res;
    }
    return { post, sent, errors, inst, provider, registered,
        setSnapshot: (value) => { current = value; } };
}
const request = (selections = empty) => ({
    selections, catalogFingerprint: "catalog-v1", expectedPhases: ["plan"],
});

test("Designer fingerprint tracks tagged catalog entries, not unrelated active composition", () => {
    const original = designerCatalogFingerprint(catalog);
    assert.notEqual(original, designerCatalogFingerprint({ ...catalog,
        presets: [{ ...catalog.presets[0], version: "1.0.1" }] }));
    assert.notEqual(original, designerCatalogFingerprint({ ...catalog,
        presets: [{ ...catalog.presets[0], tags: [] }] }));
    assert.notEqual(original, designerCatalogFingerprint({ ...catalog,
        presets: [{ ...catalog.presets[0], downloadUrl: "https://example.org/changed.zip" }] }));
    assert.equal(original, designerCatalogFingerprint({ ...catalog,
        presets: [...catalog.presets, { id: "unrelated", source: "copilot", tags: [] }] }));
});

test("empty selections produce a complete immutable inline handoff and one queued launch", async () => {
    const { post, sent } = fixture();
    const response = await post(request());
    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.body, { queued: true });
    assert.equal(sent.length, 1);
    assert.match(sent[0].prompt, /no base_branch \(the project default\)/);
    assert.match(sent[0].prompt, /Session folder:" path in the child session context/);
    assert.match(sent[0].prompt, /session-state ROOT and the parent of its files\/ directory/);
    assert.match(sent[0].prompt, /Do NOT put it under <Session folder>\/files\//);
    assert.match(sent[0].prompt, /Before any Designer open, verify the file exists at that exact root-relative path/);
    assert.match(sent[0].prompt, /if the session folder cannot be identified or the file is missing, stop and report the error/);
    assert.doesNotMatch(sent[0].prompt, /bytes equal HANDOFF_JSON/);
    assert.match(sent[0].prompt, /Do not edit it afterward/);
    assert.match(sent[0].prompt, /speckit-extension.*--install-allowed/);
    assert.match(sent[0].prompt, /Install extension-canvas-design by ID/);
    assert.match(sent[0].prompt, /install the required Canvas Design base before any bundle or preset/);
    assert.ok(sent[0].prompt.indexOf("Install extension-canvas-design by ID")
        < sent[0].prompt.indexOf("Then install approved bundles"));
    assert.ok(sent[0].prompt.indexOf("Immediately after bundles, inspect extension list --json")
        > sent[0].prompt.indexOf("Then install approved bundles"));
    assert.ok(sent[0].prompt.indexOf("Immediately after bundles, inspect extension list --json")
        < sent[0].prompt.indexOf("Install ALL remaining standalone extensions"));
    assert.match(sent[0].prompt, /even when it is absent from handoff\.workflow\.installed/);
    assert.match(sent[0].prompt, /Require extension-canvas-design to remain at hosted version 0\.1\.5 from the registered approved catalog/);
    assert.match(sent[0].prompt, /If a bundle replaced it, reinstall extension-canvas-design by ID with --force.*verify its version and source again/);
    assert.ok(sent[0].prompt.indexOf("remaining standalone extensions")
        < sent[0].prompt.indexOf("Only after ALL extensions"));
    assert.match(sent[0].prompt, /running specify extension add separately for each ID or path/);
    assert.match(sent[0].prompt, /running specify preset add separately for each ID or path/);
    assert.match(sent[0].prompt, /composition warning.*is a failure even with exit code 0/);
    assert.match(sent[0].prompt, /verify ALL handoff\.workflow\.installed presets and extensions/);
    assert.match(sent[0].prompt, /Verify runtime bundles separately with bundle list --json \(bundle_id and version only\)/);
    assert.match(sent[0].prompt, /bundle IDs have no enabled state or priority and do not appear in preset\/extension lists/);
    assert.doesNotMatch(sent[0].prompt, /verify ALL handoff\.workflow\.installed IDs, versions, enabled states/);
    assert.match(sent[0].prompt, /confirm it includes any page and template names registered by the installed Canvas Design presets/);
    assert.match(sent[0].prompt, /speckit-extension-canvas-design-load-page/);
    assert.match(sent[0].prompt, /Invoke the generated, preset-composed speckit-extension-canvas-design-load-page skill with handoffId/);
    assert.match(sent[0].prompt, /If the generated skill is unavailable after reload, report the concrete error and stop/);
    assert.match(sent[0].prompt, /Follow its entire composed command for the complete named-template resolution/);
    assert.match(sent[0].prompt, /ONCE after all installations/);
    assert.match(sent[0].prompt, /Require the installed version to be 0\.1\.5/);
    assert.deepEqual(JSON.parse(sent[0].prompt.match(/\nHANDOFF_JSON:\n([^\n]+)\n/)[1])
        .workflow.installed, { presets: [], extensions: [], bundles: [] });
    assert.match(sent[0].prompt, /Confirm the open_canvas result has the requested canvasId:.*input\.handoffId/);
    assert.match(sent[0].prompt, /Do not use Playwright or inspect page tabs after opening/);
    assert.match(sent[0].prompt, /Do not claim all pages loaded or generation is ready/);
    assert.doesNotMatch(sent[0].prompt, /identify any page-error tabs by name and reason/);
    assert.match(sent[0].prompt, /single official Designer open/);
    assert.match(sent[0].prompt, /The composed skill owns the names to resolve and the open_canvas input/);
    assert.doesNotMatch(sent[0].prompt, /input:\{handoffId:.*pages:\[\{name,path\}/);
    assert.match(sent[0].prompt, /plugin:spec-kit-copilot-wizard:speckit-canvas-designer/);
    assert.doesNotMatch(sent[0].prompt, /extensions_manage|list_canvas_capabilities|extensions_reload/);
    assert.match(sent[0].prompt, /canvasId:"speckit-canvas-designer", extensionId:"plugin:spec-kit-copilot-wizard:speckit-canvas-designer"/);
    assert.doesNotMatch(sent[0].prompt, /loadPages canvas action/);
    assert.doesNotMatch(sent[0].prompt, /speckit_designer_load_pages/);
    assert.doesNotMatch(sent[0].prompt, /bootstrap\.mjs|\.github\/extensions\//);
    assert.match(sent[0].prompt, /<Session folder>\/speckit-canvas-designer\/handoffs\/.*\/handoff\.json/);
    const json = sent[0].prompt.match(/\nHANDOFF_JSON:\n([^\n]+)\nEND_HANDOFF_JSON\n/)[1];
    const handoff = JSON.parse(json);
    assert.deepEqual(handoff.selections, empty);
    assert.deepEqual(handoff.workflow.selectedPhases, ["plan"]);
    assert.equal(handoff.sourceFingerprint, fingerprint({
        workflow: handoff.workflow, selections: handoff.selections,
    }));
    assert.deepEqual(validateHandoff(handoff, handoff.handoffId), handoff);
    assert.equal(buildDesignerLaunchPrompt(handoff).includes(json), true);
    const otherProject = fixture();
    otherProject.inst.workspacePath = tmpdir();
    assert.equal((await otherProject.post(request())).statusCode, 202);
});

test("selected catalog entries are validated and normalized from the server's catalog", async () => {
    const selection = { presets: [{ id: "theme", source: "copilot", approved: true }],
        extensions: [], bundles: [] };
    const normalized = validateDesignerSelections(selection, catalog);
    assert.deepEqual(normalized.presets[0], { id: "theme", source: "copilot",
        approved: true, version: "1.0.0", downloadUrl: "https://example.org/theme.zip" });
    const { post, sent } = fixture();
    assert.equal((await post(request(selection))).statusCode, 202);
    assert.deepEqual(JSON.parse(sent[0].prompt.match(/\nHANDOFF_JSON:\n([^\n]+)\n/)[1])
        .selections.presets, normalized.presets);
    for (const invalid of [
        { ...selection, presets: [...selection.presets, selection.presets[0]] },
        { ...selection, presets: [{ ...selection.presets[0], downloadUrl: "https://evil.invalid" }] },
        { ...selection, presets: [{ id: "unknown", source: "copilot", approved: true }] },
        { ...selection, presets: [{ ...selection.presets[0], approved: false }] },
    ]) {
        assert.equal((await post(request(invalid))).statusCode, 422);
    }
});

test("outdated hosted Canvas Design requires a checked local override before dispatch", async () => {
    const hosted = { ...catalog, extensions: [{
        id: "extension-canvas-design", source: "copilot", tags: ["canvas-design"],
        version: "0.1.3", downloadUrl: "https://example.org/extension-canvas-design.zip",
    }] };
    const selection = { ...empty, extensions: [{
        id: "extension-canvas-design", source: "copilot", approved: true,
    }] };
    const noLocal = fixture({ getState: async () => ({ ...snapshot, catalog: hosted }) });
    const response = await noLocal.post(request(selection));
    assert.equal(response.statusCode, 422);
    assert.equal(response.body.error,
        "The Spec Kit extension `extension-canvas-design` has a version mismatch: the Wizard canvas expects v0.1.3, while Canvas Designer requires v0.1.5. Use compatible canvas versions or add a compatible extension under Local development.");
    assert.equal(noLocal.sent.length, 0);

    const withLocal = fixture({ getState: async () => ({ ...snapshot, catalog: hosted }) });
    assert.equal((await withLocal.post({ ...request(selection), localSelections: {
        extensions: [{ id: "extension-canvas-design", path: LOCAL_CANVAS_DESIGN_EXT_PATH }],
    } })).statusCode, 202);
    const handoff = JSON.parse(withLocal.sent[0].prompt.match(/\nHANDOFF_JSON:\n([^\n]+)\n/)[1]);
    assert.deepEqual(handoff.localSelections.extensions, [{
        id: "extension-canvas-design", source: "local", approved: true,
        path: LOCAL_CANVAS_DESIGN_EXT_PATH,
    }]);
    assert.match(withLocal.sent[0].prompt, /skip the official by-ID install/);
    assert.match(withLocal.sent[0].prompt,
        /do not install its hosted selection even if that selection names an older release/);
});

test("Designer handoff keeps runtime packages separate from Designer-only selections", async () => {
    assert.deepEqual(normalizeInstalledBundles([{
        bundle_id: "workflow-kit", version: "2.0.0",
        installed_at: "2026-10-01T17:00:00Z", contributed_components: [],
    }]), [{ id: "workflow-kit", version: "2.0.0" }]);
    assert.throws(() => normalizeInstalledBundles([{ id: "workflow-kit", version: "2.0.0" }]),
        /Invalid installed bundle identity/);
    const installed = normalizeInstalledWorkflowInventory({
        presets: [{ id: "copilot-sub-agents", version: "1.0.0", priority: 1,
            enabled: true, source: { kind: "local" } },
        { id: "disabled", version: "1.0.0", priority: 10, enabled: false }],
        extensions: [{ id: "extension-writer", version: "0.3.0", priority: 5,
            enabled: true, source: { kind: "catalog" } }],
        bundles: [{ bundle_id: "workflow-kit", version: "2.0.0" }],
    });
    const runtime = fixture({ getInstalledWorkflow: async () => installed });
    runtime.setSnapshot({ ...snapshot, composition: {
        presets: [{ id: "copilot-sub-agents", priority: 10 }],
        extensions: [{ id: "extension-writer", priority: 10 }],
        bundles: [{ id: "workflow-kit", version: "2.0.0" }],
    } });
    const selection = { presets: [{ id: "theme", source: "copilot", approved: true }],
        extensions: [], bundles: [] };
    assert.equal((await runtime.post(request(selection))).statusCode, 202);
    const handoff = JSON.parse(runtime.sent[0].prompt.match(/\nHANDOFF_JSON:\n([^\n]+)\n/)[1]);
    assert.deepEqual(handoff.workflow.installed, installed);
    assert.match(runtime.sent[0].prompt, /--priority.*set-priority/);
    assert.match(runtime.sent[0].prompt, /including entries not tagged canvas-design/);
    assert.deepEqual(handoff.selections.presets.map((item) => item.id), ["theme"]);
    const invalid = fixture();
    invalid.setSnapshot({ ...snapshot, composition: { presets: [{ id: "unknown", version: null }],
        extensions: [], bundles: [] } });
    assert.equal((await invalid.post(request())).statusCode, 202);
    assert.deepEqual(JSON.parse(invalid.sent[0].prompt.match(/\nHANDOFF_JSON:\n([^\n]+)\n/)[1])
        .workflow.installed, empty);
    assert.throws(() => validateHandoff({ ...handoff,
        workflow: { ...handoff.workflow, installed: {
            ...installed, presets: [{ id: "copilot-sub-agents", version: "1.0.0", priority: 10 }],
        } },
    }, handoff.handoffId), /fingerprint mismatch/);
});

test("live CLI inventory is read from the Wizard checkout, including priorities", async () => {
    const path = await mkdtemp(join(tmpdir(), "designer-inventory-"));
    try {
        const presetPath = join(path, ".specify", "presets", "preset");
        await mkdir(presetPath, { recursive: true });
        await writeFile(join(presetPath, "preset.yml"),
            "preset:\n  id: preset\n  name: Test preset\n  version: 1.0.0\n");
        const calls = [];
        const installed = await readInstalledWorkflowInventory({ workspacePath: path },
            async (binary, args, options) => {
                calls.push({ binary, args, cwd: options.cwd });
                const item = args[0] === "bundle"
                    ? [{ bundle_id: "kit", version: "2.0.0" }]
                    : args[0] === "preset"
                        ? [{ id: "preset", version: "1.0.0", priority: 1, enabled: true,
                            source: { kind: "local" } }] : [];
                return { stdout: JSON.stringify(item) };
            });
        assert.deepEqual(calls.map(({ args }) => args), [
            ["preset", "list", "--json"], ["extension", "list", "--json"],
            ["bundle", "list", "--json"],
        ]);
        assert.ok(calls.every(({ cwd }) => cwd === path));
        assert.deepEqual(installed.presets, [{ id: "preset", version: "1.0.0",
            priority: 1, source: "local", path: presetPath }]);
        assert.deepEqual(installed.bundles, [{ id: "kit", version: "2.0.0" }]);
        const catalogInstalled = await readInstalledWorkflowInventory({
            workspacePath: path, catalog: { presets: [{ id: "preset", version: "1.0.0",
                source: "community", downloadUrl: "https://example.org/preset.zip" }] },
        }, async (binary, args) => ({ stdout: JSON.stringify(args[0] === "preset"
            ? [{ id: "preset", version: "1.0.0", priority: 1, enabled: true,
                source: { kind: "catalog", catalog: "community" } }] : []) }));
        assert.deepEqual(catalogInstalled.presets, [{ id: "preset", version: "1.0.0",
            priority: 1, source: "community", downloadUrl: "https://example.org/preset.zip" }]);
        const unavailableCatalog = await readInstalledWorkflowInventory({
            workspacePath: path, catalog: { presets: [], extensions: [] },
        }, async (binary, args) => ({ stdout: JSON.stringify(args[0] === "preset"
            ? [{ id: "preset", version: "1.0.0", priority: 1, enabled: true,
                source: { kind: "catalog", catalog: "community" } }] : []) }));
        assert.deepEqual(unavailableCatalog.presets, [{ id: "preset", version: "1.0.0",
            priority: 1, source: "community", path: presetPath }]);
        await assert.rejects(readInstalledWorkflowInventory({
            workspacePath: path, catalog: { presets: [{ id: "preset", version: "1.0.0",
                source: "community", downloadUrl: "http://example.org/preset.zip" }] },
        }, async (binary, args) => ({ stdout: JSON.stringify(args[0] === "preset"
            ? [{ id: "preset", version: "1.0.0", priority: 1, enabled: true,
                source: { kind: "catalog", catalog: "community" } }] : []) })),
        /Invalid installed presets download URL/);
        await assert.rejects(readInstalledWorkflowInventory({ workspacePath: path },
            async () => ({ stdout: "not-json" })), /Invalid installed presets inventory/);
    } finally {
        await rm(path, { recursive: true, force: true });
    }
});

test("invalid or drifting runtime priorities never dispatch a Designer launch", async () => {
    assert.deepEqual(normalizeInstalledWorkflowInventory({
        presets: [{ id: "preset", version: "1.0.0", priority: -2 }],
        extensions: [], bundles: [],
    }).presets, [{ id: "preset", version: "1.0.0", priority: -2 }]);
    for (const bad of [
        { id: "preset", version: "1.0.0" },
        { id: "preset", version: "1.0.0", priority: Number.MAX_SAFE_INTEGER + 1 },
        { id: "preset", version: "", priority: 1 },
    ]) {
        assert.throws(() => normalizeInstalledWorkflowInventory({
            presets: [bad], extensions: [], bundles: [],
        }), /identity, version or priority/);
    }
    let reads = 0;
    const changed = fixture({ getInstalledWorkflow: async () => ({
        presets: [{ id: "preset", version: "1.0.0", priority: ++reads }],
        extensions: [], bundles: [],
    }) });
    const response = await changed.post(request());
    assert.equal(response.statusCode, 409);
    assert.match(response.body.error, /Installed workflow packages changed/);
    assert.equal(changed.sent.length, 0);
});

test("stale, unauthenticated and unavailable requests never acknowledge launch", async () => {
    const { post, sent, inst, setSnapshot } = fixture();
    assert.equal((await post(request(), "wrong")).statusCode, 401);
    assert.equal((await post({ ...request(), catalogFingerprint: "old" })).statusCode, 409);
    assert.equal((await post({ ...request(), expectedPhases: [] })).statusCode, 409);
    assert.equal(sent.length, 0);
    setSnapshot({ ...snapshot, catalog: { ...catalog, designerFingerprint: "new" } });
    assert.equal((await post(request())).statusCode, 409);
    assert.equal(sent.length, 0);
    const unavailable = fixture({ session: { send: null } });
    assert.equal((await unavailable.post(request())).statusCode, 503);
});

test("only the running official plugin provider with a registered canvas can launch", async () => {
    const { post, sent, provider, registered } = fixture();
    provider.status = "failed";
    assert.match((await post(request())).body.error, /failed.*extension log/i);
    provider.status = "running";
    registered.extensionId = "session:speckit-canvas-designer";
    assert.match((await post(request())).body.error, /not registered/i);
    registered.extensionId = DESIGNER_EXTENSION_ID;
    provider.id = "project:speckit-canvas-designer";
    assert.match((await post(request())).body.error, /missing.*install or update/i);
    assert.equal(sent.length, 0);
    provider.id = DESIGNER_EXTENSION_ID;
    assert.equal((await post(request())).statusCode, 202);
    assert.equal(sent.length, 1);
});

test("disabled provider is enabled on launch in the current session", async () => {
    const { post, sent, provider } = fixture();
    provider.status = "disabled";
    const response = await post(request());
    assert.equal(response.statusCode, 202);
    assert.equal(provider.status, "running");
    assert.equal(sent.length, 1);
});

test("activation errors and timeouts never dispatch", async () => {
    const provider = { id: DESIGNER_EXTENSION_ID, source: "plugin", status: "disabled" };
    const rpc = {
        extensions: {
            list: async () => ({ extensions: [provider] }),
            enable: async () => { throw new Error("permission denied"); },
        },
        canvas: { list: async () => ({ canvases: [] }) },
    };
    const { post, sent } = fixture({ session: { rpc, send: async (message) => { sent.push(message); } } });
    const error = await post(request());
    assert.equal(error.statusCode, 503);
    assert.match(error.body.error, /permission denied/);
    assert.equal(sent.length, 0);
    rpc.extensions.enable = async ({ id }) => {
        assert.equal(id, DESIGNER_EXTENSION_ID);
        provider.status = "starting";
    };
    await assert.rejects(enableDesignerProvider(rpc, { timeoutMs: 0 }), /activation timed out/);
    provider.status = "disabled";
    const timedOut = fixture({
        session: { rpc },
        enableDesignerProvider: (sessionRpc) => enableDesignerProvider(sessionRpc, { timeoutMs: 0 }),
    });
    const timeout = await timedOut.post(request());
    assert.equal(timeout.statusCode, 503);
    assert.match(timeout.body.error, /activation timed out/);
    assert.equal(timedOut.sent.length, 0);
    rpc.extensions.enable = () => new Promise(() => {});
    await assert.rejects(enableDesignerProvider(rpc, { timeoutMs: 10 }), /activation timed out/);
    rpc.extensions.enable = async () => { provider.status = "running"; };
    rpc.canvas.list = async () => ({ canvases: [{
        extensionId: "session:speckit-canvas-designer", canvasId: "speckit-canvas-designer",
    }] });
    await assert.rejects(enableDesignerProvider(rpc, { timeoutMs: 10, intervalMs: 1 }),
        /activation timed out/);
    provider.status = "failed";
    await assert.rejects(checkDesignerProvider(rpc), /failed/);
});

test("launches cannot overlap while readiness is being checked", async () => {
    let release;
    let entered;
    const ready = new Promise((resolve) => { release = resolve; });
    const checking = new Promise((resolve) => { entered = resolve; });
    const delayed = fixture({
        session: {
            rpc: {
                extensions: {
                    list: async () => {
                        entered();
                        await ready;
                        return { extensions: [{
                            id: DESIGNER_EXTENSION_ID, source: "plugin", status: "running",
                        }] };
                    },
                },
                canvas: { list: async () => ({ canvases: [{
                    extensionId: DESIGNER_EXTENSION_ID, canvasId: "speckit-canvas-designer",
                }] }) },
            },
        },
    });
    const first = delayed.post(request());
    await checking;
    const duplicate = await delayed.post(request());
    assert.equal(duplicate.statusCode, 409);
    release();
    assert.equal((await first).statusCode, 202);
    assert.equal(delayed.sent.length, 1);
    assert.equal((await delayed.post(request())).statusCode, 202);
});

test("catalog or pipeline changes during provider readiness reject the stale launch", async () => {
    for (const changed of [
        { ...snapshot, catalog: { ...catalog, designerFingerprint: "catalog-v2" } },
        { ...snapshot, pipeline: [{ id: "commands/tasks" }] },
    ]) {
        let release;
        let entered;
        const ready = new Promise((resolve) => { release = resolve; });
        const checking = new Promise((resolve) => { entered = resolve; });
        const delayed = fixture({
            session: {
                rpc: {
                    extensions: { list: async () => {
                        entered();
                        await ready;
                        return { extensions: [{
                            id: DESIGNER_EXTENSION_ID, source: "plugin", status: "running",
                        }] };
                    } },
                    canvas: { list: async () => ({ canvases: [{
                        extensionId: DESIGNER_EXTENSION_ID, canvasId: "speckit-canvas-designer",
                    }] }) },
                },
            },
        });
        const launch = delayed.post(request());
        await checking;
        delayed.setSnapshot(changed);
        release();
        const response = await launch;
        assert.equal(response.statusCode, 409);
        assert.match(response.body.error, /pipeline or catalog changed/);
        assert.equal(delayed.sent.length, 0);
    }
});

test("consecutive launch requests acknowledge before agent turns finish and have separate handoffs", async () => {
    const sent = [];
    let finish;
    const completion = new Promise((resolve) => { finish = resolve; });
    const { post } = fixture({ session: { send: async (message) => {
        sent.push(message);
        await completion;
    } } });
    const first = await post(request());
    const second = await post(request());
    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 202);
    assert.equal(sent.length, 2);
    const handoffIds = sent.map(({ prompt }) =>
        JSON.parse(prompt.match(/\nHANDOFF_JSON:\n([^\n]+)\n/)[1]).handoffId);
    assert.equal(new Set(handoffIds).size, 2);
    finish();
});

test("deferred send failures are logged without changing an accepted response", async () => {
    const failing = fixture({ session: { send: async () => { throw new Error("no session"); } } });
    const response = await failing.post(request());
    assert.equal(response.statusCode, 202);
    assert.deepEqual(failing.errors, [{ message: "Designer dispatch failed: no session", level: "error" }]);
});

test("oversized Designer handoff returns 413 without dispatching", async () => {
    const largeCatalog = { ...catalog, presets: Array.from({ length: 40 }, (_, index) => ({
        id: `preset-${index}`, source: "copilot", tags: ["canvas-design"],
        downloadUrl: `https://example.org/${"x".repeat(1950)}${index}`,
    })) };
    const sent = [];
    const { post } = fixture({
        getState: async () => ({ ...snapshot, catalog: largeCatalog }),
        session: { send: async (message) => { sent.push(message); } },
    });
    const selections = { ...empty, presets: largeCatalog.presets.map((item) => ({
        id: item.id, source: item.source, approved: true,
    })) };
    const response = await post(request(selections));
    assert.equal(response.statusCode, 413);
    assert.match(response.body.error, /exceeds 64KB/);
    assert.equal(sent.length, 0);
});

test("invalid fingerprints, oversized handoffs and unsafe IDs are rejected", async () => {
    const handoff = buildDesignerHandoff(snapshot, empty, undefined, empty, randomUUID());
    assert.throws(() => validateHandoff({ ...handoff, sourceFingerprint: "0".repeat(64) },
        handoff.handoffId), /fingerprint mismatch/);
    assert.throws(() => validateHandoff({ ...handoff, extra: "x".repeat(65 * 1024) },
        handoff.handoffId), /Invalid Designer handoff/);
    const malformed = { ...handoff, selections: { ...empty,
        presets: [{ id: null, source: "copilot", approved: true,
            version: null, downloadUrl: null }] } };
    malformed.sourceFingerprint = fingerprint({
        workflow: malformed.workflow, selections: malformed.selections,
    });
    assert.throws(() => validateHandoff(malformed, handoff.handoffId), /Invalid Designer handoff/);
    for (const invalid of [
        { source: "local", path: "../outside" },
        { source: "community", downloadUrl: "http://example.org/preset.zip" },
        { source: "local", path: LOCAL_PRESET_PATH, downloadUrl: "https://example.org/preset.zip" },
    ]) {
        const withLocator = { ...handoff, workflow: { ...handoff.workflow,
            installed: { ...empty, presets: [{ id: "preset", version: "1.0.0",
                priority: 1, ...invalid }] } } };
        withLocator.sourceFingerprint = fingerprint({
            workflow: withLocator.workflow, selections: withLocator.selections,
        });
        assert.throws(() => validateHandoff(withLocator, handoff.handoffId),
            /Invalid Designer handoff/);
    }
    await assert.rejects(readHandoff(tmpdir(), "../escape"), /Invalid Designer handoff ID/);
});

test("validateLocalDesignerSelections validates real manifests and stays undefined when absent", async () => {
    assert.equal(await validateLocalDesignerSelections(undefined), undefined);
    assert.equal(await validateLocalDesignerSelections({ presets: [], extensions: [] }), undefined);
    const result = await validateLocalDesignerSelections({
        presets: [{ id: "copilot-sub-agents", path: LOCAL_PRESET_PATH }],
        extensions: [{ id: "extension-canvas-design", path: LOCAL_CANVAS_DESIGN_EXT_PATH }],
    });
    assert.deepEqual(result, {
        presets: [{ id: "copilot-sub-agents", source: "local", approved: true, path: LOCAL_PRESET_PATH }],
        extensions: [{ id: "extension-canvas-design", source: "local", approved: true,
            path: LOCAL_CANVAS_DESIGN_EXT_PATH }],
    });
});

test("validateLocalDesignerSelections rejects malformed, duplicate, mismatched or unreadable entries", async () => {
    for (const invalid of [
        { bundles: [] },
        { presets: "not-an-array" },
        { presets: Array.from({ length: 21 }, () => ({ id: "x", path: LOCAL_PRESET_PATH })) },
        { presets: [{ id: "copilot-sub-agents" }] },
        { presets: [{ id: "copilot-sub-agents", path: "relative/not/absolute" }] },
        { presets: [{ id: "copilot-sub-agents", path: LOCAL_PRESET_PATH, extra: true }] },
        { presets: [{ id: "copilot-sub-agents", path: LOCAL_PRESET_PATH },
            { id: "copilot-sub-agents", path: LOCAL_PRESET_PATH }] },
    ]) {
        await assert.rejects(validateLocalDesignerSelections(invalid));
    }
    await assert.rejects(validateLocalDesignerSelections({
        presets: [{ id: "wrong-id", path: LOCAL_PRESET_PATH }],
    }), /no longer matches id wrong-id/);
    await assert.rejects(validateLocalDesignerSelections({
        presets: [{ id: "copilot-sub-agents", path: `${LOCAL_PRESET_PATH}\\does-not-exist` }],
    }), /Directory not found/);
});

test("buildDesignerLaunchPrompt is purely additive: no local-dev step or wording when localSelections is absent", () => {
    const handoff = buildDesignerHandoff(snapshot, empty, undefined, empty, randomUUID());
    const prompt = buildDesignerLaunchPrompt(handoff);
    assert.doesNotMatch(prompt, /localSelections/);
    assert.doesNotMatch(prompt, /local development sources/i);
    assert.doesNotMatch(prompt, /For each approved entry in localSelections\.presets/);
    assert.doesNotMatch(prompt, /specify extension add <path> --dev/);
    assert.doesNotMatch(prompt, /skip this required-by-ID install/);
    assert.equal(handoff.localSelections, undefined);
});

test("runtime package locators are carried into the child installation instructions", () => {
    const installed = { presets: [{ id: "local-runtime", version: "1.0.0", priority: 2,
        source: "local", path: LOCAL_PRESET_PATH }],
    extensions: [{ id: "remote-runtime", version: "1.0.0", priority: 3,
        source: "community", downloadUrl: "https://example.org/extension.zip" }],
    bundles: [] };
    const handoff = buildDesignerHandoff(snapshot, empty, undefined, installed, randomUUID());
    assert.deepEqual(handoff.workflow.installed, installed);
    const prompt = buildDesignerLaunchPrompt(handoff);
    assert.match(prompt, /runtime preset.*frozen downloadUrl.*frozen path.*--dev <path>/);
    assert.match(prompt, /runtime extension.*frozen downloadUrl.*frozen path.*--dev/);
    assert.match(prompt, /manifest id and version against the frozen entry/);
});

test("buildDesignerLaunchPrompt documents local-wins precedence, including the extension-canvas-design special case", () => {
    const localSelections = {
        presets: [{ id: "copilot-sub-agents", source: "local", approved: true, path: LOCAL_PRESET_PATH }],
    };
    const handoff = buildDesignerHandoff(snapshot, empty, localSelections, empty, randomUUID());
    assert.deepEqual(handoff.localSelections, localSelections);
    const prompt = buildDesignerLaunchPrompt(handoff);
    assert.match(prompt, /specify preset add --dev <path>/);
    assert.match(prompt, /specify preset remove <id>.*retry specify preset add --dev <path>/);
    assert.match(prompt, /specify extension add <path> --dev --force/);
    assert.match(prompt, /A local entry always takes precedence over a hosted selection or bundle member sharing the same ID/);
    // No local extension-canvas-design selection here, so the required
    // hosted install step must use its unchanged, legacy wording.
    assert.match(prompt, /Install extension-canvas-design by ID/);
    assert.match(prompt, /Require the installed version to be 0\.1\.5/);
    assert.doesNotMatch(prompt, /skip the official by-ID install/);

    const withLocalCanvasDesignExt = buildDesignerHandoff(snapshot, empty, {
        extensions: [{ id: "extension-canvas-design", source: "local", approved: true,
            path: LOCAL_CANVAS_DESIGN_EXT_PATH }],
    }, empty, randomUUID());
    const promptWithExt = buildDesignerLaunchPrompt(withLocalCanvasDesignExt);
    // With a local core extension approved, the official by-ID install and
    // its mandatory version-0.1.5 check are skipped entirely (not merely
    // suffixed with a contradicting note) in favor of the local --dev
    // --force install producing the generated skill/schema instead.
    assert.match(promptWithExt, /skip the official by-ID install of extension-canvas-design and its required-version-0\.1\.5 check entirely/);
    assert.match(promptWithExt, /verify the approved local path and manifest id, then install it now with specify extension add <path> --dev --force/);
    assert.ok(promptWithExt.indexOf("then install it now with specify extension add <path> --dev --force")
        < promptWithExt.indexOf("Then install approved bundles"));
    assert.match(promptWithExt, /Verify extension-canvas-design still comes from the approved local path; if a bundle replaced it, restore that local override with specify extension add <path> --dev --force and verify its source again/);
    assert.ok(promptWithExt.indexOf("Then install approved bundles")
        < promptWithExt.indexOf("Verify extension-canvas-design still comes from the approved local path"));
    assert.ok(promptWithExt.indexOf("Verify extension-canvas-design still comes from the approved local path")
        < promptWithExt.indexOf("Only after ALL extensions"));
    assert.doesNotMatch(promptWithExt, /Require extension-canvas-design to remain at hosted version 0\.1\.5/);
    assert.doesNotMatch(promptWithExt, /Install extension-canvas-design by ID \(a normal install, NOT --dev\)/);
});

test("Designer launch installs every extension before standalone presets, including local overrides", () => {
    const handoff = buildDesignerHandoff(snapshot, empty, {
        presets: [{ id: "copilot-sub-agents", source: "local", approved: true,
            path: LOCAL_PRESET_PATH }],
        extensions: [{ id: "extension-canvas-design", source: "local", approved: true,
            path: LOCAL_CANVAS_DESIGN_EXT_PATH }],
    }, { presets: [{ id: "copilot-sub-agents", version: "1.0.0", priority: 1 }],
        extensions: [], bundles: [] }, randomUUID());
    const prompt = buildDesignerLaunchPrompt(handoff);
    const extensionStep = prompt.indexOf("Install ALL remaining standalone extensions");
    const localExtension = prompt.indexOf("For each approved entry in localSelections.extensions");
    const presetStep = prompt.indexOf("Only after ALL extensions");
    const localPreset = prompt.indexOf("For each approved entry in localSelections.presets");
    assert.ok(prompt.indexOf("then install it now with specify extension add <path> --dev --force")
        < prompt.indexOf("Then install approved bundles"));
    assert.ok(extensionStep > 0 && extensionStep < localExtension
        && localExtension < presetStep && presetStep < localPreset);
    assert.match(prompt, /including 'no base command layer'/);
    assert.match(prompt, /If any registration is missing, stop and report incomplete command composition/);
});

test("handleDesignerLaunch inlines validated localSelections into the handoff end-to-end", async () => {
    const { post, sent } = fixture();
    const response = await post({ ...request(), localSelections: {
        presets: [{ id: "copilot-sub-agents", path: LOCAL_PRESET_PATH }],
    } });
    assert.equal(response.statusCode, 202);
    const json = sent[0].prompt.match(/\nHANDOFF_JSON:\n([^\n]+)\nEND_HANDOFF_JSON\n/)[1];
    const handoff = JSON.parse(json);
    assert.deepEqual(handoff.localSelections, { presets: [{ id: "copilot-sub-agents",
        source: "local", approved: true, path: LOCAL_PRESET_PATH }] });
    assert.equal(handoff.sourceFingerprint, fingerprint({
        workflow: handoff.workflow, selections: handoff.selections,
        localSelections: handoff.localSelections,
    }));
    assert.deepEqual(validateHandoff(handoff, handoff.handoffId), handoff);
});

test("handleDesignerLaunch rejects an invalid localSelections payload without dispatching", async () => {
    const { post, sent } = fixture();
    const response = await post({ ...request(), localSelections: {
        presets: [{ id: "copilot-sub-agents", path: "relative/not/absolute" }],
    } });
    assert.equal(response.statusCode, 422);
    assert.equal(sent.length, 0);
});

test("handleDesignerLaunch revalidates localSelections at the final pre-dispatch checkpoint and rejects drift", async () => {
    const dir = await mkdtemp(join(tmpdir(), "designer-local-"));
    await writeFile(join(dir, "preset.yml"),
        "preset:\n  id: drift-preset\n  name: Drift Preset\n  version: 1.0.0\n");
    const provider = { id: DESIGNER_EXTENSION_ID, source: "plugin", status: "running" };
    const registered = { extensionId: DESIGNER_EXTENSION_ID, canvasId: "speckit-canvas-designer" };
    const { post, sent } = fixture({
        session: {
            rpc: {
                extensions: { list: async () => ({ extensions: [provider] }) },
                canvas: {
                    // Simulate the local directory disappearing during the
                    // (bounded) readiness wait — i.e. between the initial
                    // local-selections validation and the final
                    // pre-dispatch checkpoint re-validation.
                    list: async () => {
                        await rm(dir, { recursive: true, force: true });
                        return { canvases: [registered] };
                    },
                },
            },
        },
    });
    try {
        const response = await post({ ...request(), localSelections: {
            presets: [{ id: "drift-preset", path: dir }],
        } });
        assert.equal(response.statusCode, 409);
        assert.match(response.body.error, /Local development sources changed before launch/);
        assert.equal(sent.length, 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
