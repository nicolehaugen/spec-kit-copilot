import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { materialize, readBoundedSessionFile } from "../extension-canvas-design/scripts/generate.mjs";
import { createRuntime } from "../extension-canvas-design/templates/generated-canvas/runtime.mjs";
import { renderHtml } from "../extension-canvas-design/templates/generated-canvas/server.mjs";
import { freezeGeneration, validateEssentials } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/generation.mjs";

const entryTemplate = await readFile(new URL("../extension-canvas-design/templates/generated-canvas/extension.mjs",
    import.meta.url), "utf8");
const model = {
    revision: "test-revision",
    settingsRevision: 0,
    pages: [{ page: "canvas-settings-setup", fields: [
        { id: "canvas.id" }, { id: "canvas.displayName" }, { id: "canvas.description" },
        { id: "canvas.workflowListName" }, { id: "workflowSlug.userProvided" },
    ] }],
    constraints: {
        "canvas.id": { type: "string", minLength: 1, maxLength: 100, pattern: "^[a-z0-9][a-z0-9-]*$" },
        "canvas.displayName": { type: "string", minLength: 1, maxLength: 120 },
        "canvas.description": { type: "string", maxLength: 240 },
        "canvas.workflowListName": { type: "string", maxLength: 80 },
        "workflowSlug.userProvided": { type: "boolean" },
    },
};
const values = { "canvas.id": "my-workflow", "canvas.displayName": "My Workflow",
    "canvas.description": "A workflow", "canvas.workflowListName": "Workflows",
    "workflowSlug.userProvided": false };
const handoff = { handoffId: "handoff-1", sourceFingerprint: "",
    selections: { presets: [], extensions: [], bundles: [] },
    workflow: { selectedPhases: ["constitution", "specify", "plan"],
        installed: { presets: [{ id: "copilot-sub-agents", source: "copilot",
            version: "1.0.0", priority: 1 }],
            extensions: [], bundles: [] } } };
handoff.sourceFingerprint = createHash("sha256").update(JSON.stringify({
    workflow: handoff.workflow, selections: handoff.selections,
})).digest("hex");

async function fixture(t, selectedHandoff = handoff, selectedValues = values) {
    const root = await mkdtemp(join(tmpdir(), "designer-generate-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const project = join(root, "project"), workspace = join(root, "workspace");
    await mkdir(project);
    await mkdir(workspace);
    const folder = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "handoff.json"), JSON.stringify(selectedHandoff));
    const prepared = await freezeGeneration({ project, workspace, model, values: selectedValues,
        handoff: selectedHandoff });
    const sdk = join(project, ".github", "extensions", selectedValues["canvas.id"]);
    return { project, workspace, prepared, sdk };
}

test("Essentials are validated before freezing a bounded, immutable generation request", async (t) => {
    const { project, workspace, prepared } = await fixture(t);
    const path = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId,
        "generations", prepared.requestId, "request.json");
    const request = JSON.parse(await readFile(path, "utf8"));
    const { integrity, ...payload } = request;
    assert.equal(integrity, createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
    assert.equal(request.project, project);
    assert.deepEqual(request.workflow.selectedPhases, handoff.workflow.selectedPhases);
    assert.deepEqual(request.installed.presets, handoff.workflow.installed.presets);
    assert.deepEqual(request.values, values);
    assert.throws(() => validateEssentials(model, { ...values, "canvas.id": "../bad" }), /canvas.id/);
    for (const id of ["con", "prn", "aux", "nul",
        ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
        ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)]) {
        assert.throws(() => validateEssentials(model, { ...values, "canvas.id": id }), /non-reserved/);
    }
    for (const id of ["com0", "com10", "lpt0", "lpt10", "con-1"]) {
        assert.equal(validateEssentials(model, { ...values, "canvas.id": id })["canvas.id"], id);
    }
    assert.throws(() => validateEssentials(model, { ...values, "canvas.displayName": " " }), /Title/);
    assert.throws(() => validateEssentials(model, { ...values, "workflowSlug.userProvided": "true" }), /workflowSlug.userProvided/);
    const { ["workflowSlug.userProvided"]: omitted, ...missingToggle } = values;
    assert.throws(() => validateEssentials(model, missingToggle), /workflowSlug.userProvided/);
});

test("Designer-only values are validated but excluded from frozen and generated files", async (t) => {
    const { project, workspace } = await fixture(t);
    const contributedModel = { ...model,
        constraints: { ...model.constraints,
            "billing.costCode": { type: "string", maxLength: 64 },
            "designer.note": { type: "string", maxLength: 80 } },
        contributions: [{ field: { id: "billing.costCode", label: "Cost code" },
            generatedBinding: { presentation: "stock.readonly",
                section: { id: "billing", title: "Billing" } } }] };
    const supplied = { ...values, "billing.costCode": "CC-481", "designer.note": "Designer only" };
    await assert.rejects(freezeGeneration({ model: contributedModel,
        values: { ...supplied, "designer.note": "x".repeat(81) },
        handoff, project, workspace }), /Invalid Designer setting: designer.note/);
    const prepared = await freezeGeneration({ model: contributedModel, values: supplied,
        handoff, project, workspace });
    const frozen = JSON.parse(await readFile(join(workspace, "speckit-canvas-designer",
        "handoffs", handoff.handoffId, "generations", prepared.requestId, "request.json"), "utf8"));
    assert.equal(frozen.values["billing.costCode"], "CC-481");
    assert.equal(Object.hasOwn(frozen.values, "designer.note"), false);
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const setup = JSON.parse(await readFile(join(project, ".github", "extensions",
        "my-workflow", "canvas-setup.json"), "utf8"));
    assert.equal(setup.values["billing.costCode"], "CC-481");
    assert.equal(Object.hasOwn(setup.values, "designer.note"), false);
});

test("re-signed requests reject unbound, missing, and colliding generated values", async (t) => {
    for (const [name, change, error] of [
        ["unbound value", (request) => { request.values["designer.note"] = "not generated"; },
            /Invalid frozen generated values/],
        ["missing Essential", (request) => { delete request.values["canvas.description"]; },
            /Invalid frozen canvas identity/],
        ["missing bound value", (request) => {
            request.generatedFields = [{ id: "billing.costCode", label: "Cost code", maxLength: 64 }];
        }, /Invalid frozen generated fields/],
        ["bound ID collides with Essential", (request) => {
            request.generatedFields = [{ id: "canvas.displayName", label: "Title", maxLength: 120 }];
        }, /Invalid frozen generated values/],
    ]) {
        await t.test(name, async (child) => {
            const { project, workspace, prepared, sdk } = await fixture(child);
            const path = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId,
                "generations", prepared.requestId, "request.json");
            const request = JSON.parse(await readFile(path, "utf8"));
            change(request);
            const { integrity: _integrity, ...payload } = request;
            request.integrity = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
            await writeFile(path, JSON.stringify(request));
            await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
                error);
            await assert.rejects(readdir(sdk), { code: "ENOENT" });
        });
    }
});

test("100 bounded generated fields materialize when the frozen request exceeds 128KB", async (t) => {
    const { project, workspace } = await fixture(t);
    const constraints = { ...model.constraints };
    const contributions = [];
    const supplied = { ...values };
    for (let index = 0; index < 100; index++) {
        const id = `billing.code${index}`;
        constraints[id] = { type: "string", maxLength: 1000 };
        supplied[id] = "x".repeat(1000);
        contributions.push({ field: { id, label: "L".repeat(120) },
            generatedBinding: { presentation: "stock.readonly",
                section: { id: `billing-${index}`, title: "S".repeat(120) } } });
    }
    const prepared = await freezeGeneration({ model: { ...model, constraints, contributions },
        values: supplied, handoff, project, workspace });
    const path = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId,
        "generations", prepared.requestId, "request.json");
    const raw = await readFile(path);
    assert.ok(raw.length > 128 * 1024);
    assert.ok(raw.length <= 512 * 1024);
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const config = JSON.parse(await readFile(join(project, ".github", "extensions",
        "my-workflow", "canvas-config.json"), "utf8"));
    assert.equal(config.readOnlyFields.length, 100);
    assert.equal(config.readOnlyFields[99].value, "x".repeat(1000));
});

test("the generator rejects a frozen request above its shared size limit", async (t) => {
    const { project, workspace, prepared } = await fixture(t);
    const path = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId,
        "generations", prepared.requestId, "request.json");
    await writeFile(path, "x".repeat(512 * 1024 + 1));
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /Generation request is too large/);
});

test("generated stock scalar is escaped, read-only and absent from unchanged defaults", async (t) => {
    const { project, workspace, prepared } = await fixture(t);
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const target = join(project, ".github", "extensions", "my-workflow");
    const { readConfig } = await import(pathToFileURL(join(target, "server.mjs")).href);
    const defaultConfig = JSON.parse(await readFile(join(target, "canvas-config.json"), "utf8"));
    assert.equal(defaultConfig.readOnlyFields, undefined);
    assert.doesNotMatch(renderHtml(defaultConfig), /Configured fields|data-field-id/);
    const config = { ...defaultConfig,
        readOnlyFields: [{ id: "billing.costCode", label: "Cost code", value: '<script>"CC"</script>' }] };
    const html = renderHtml(config);
    assert.match(html, /data-field-id="billing.costCode">&lt;script&gt;&quot;CC&quot;&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>"CC"<\/script>|<input[^>]+billing\.costCode/);
    const grouped = renderHtml({ ...defaultConfig, readOnlyFields: [
        { id: "billing.costCode", label: "Cost code", value: "CC-481",
            section: { id: "billing", title: "Billing" } },
        { id: "billing.other", label: "Other code", value: "CC-482",
            section: { id: "billing", title: "Billing" } },
        { id: "finance.code", label: "Finance code", value: "CC-483",
            section: { id: "finance", title: "Billing" } },
        { id: "note", label: "Note", value: "Untitled" },
    ] });
    assert.equal((grouped.match(/<h2>Billing<\/h2>/g) ?? []).length, 2);
    assert.equal((grouped.match(/<h2>Configured fields<\/h2>/g) ?? []).length, 1);
    assert.match(grouped, /<h2>Billing<\/h2><dl[^>]*>[\s\S]*?billing\.costCode[\s\S]*?billing\.other[\s\S]*?<\/dl>/);
    for (const invalid of [
        [{ id: "billing.costCode", label: "Cost code", value: 123 }],
        [{ id: "billing.costCode", label: "Cost code", value: "x".repeat(1001) }],
        [{ id: "billing.costCode", label: "Cost code", value: "one" },
            { id: "billing.costCode", label: "Duplicate", value: "two" }],
        [{ id: "billing.costCode", label: "Cost code", value: "one",
            section: { id: "billing", title: "" } }],
        [{ id: "billing.costCode", label: "Cost code", value: "one",
            section: { id: "billing", title: "Billing" } },
        { id: "billing.other", label: "Other code", value: "two",
            section: { id: "billing", title: "Finance" } }],
    ]) {
        await writeFile(join(target, "canvas-config.json"),
            JSON.stringify({ ...defaultConfig, readOnlyFields: invalid }));
        assert.throws(() => readConfig(), /Invalid generated canvas configuration|Conflicting generated canvas section/);
    }
});

test("materialization rejects a re-signed request with a Windows device Canvas ID", async (t) => {
    const { project, workspace, prepared } = await fixture(t);
    const path = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId,
        "generations", prepared.requestId, "request.json");
    const request = JSON.parse(await readFile(path, "utf8"));
    request.canvas.id = "con";
    request.values["canvas.id"] = "con";
    request.target = ".github/extensions/con/";
    const { integrity, ...payload } = request;
    request.integrity = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    await writeFile(path, JSON.stringify(request));
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /Invalid frozen canvas identity/);
    await assert.rejects(readdir(join(project, ".github", "extensions")), { code: "ENOENT" });
});

test("materialization rejects re-signed requests that diverge from frozen Essentials", async (t) => {
    for (const [field, canvasField, original] of [
        ["canvas.description", "description", values["canvas.description"]],
        ["canvas.workflowListName", "workflowListName", values["canvas.workflowListName"]],
        ["canvas.description", "description", ""],
        ["canvas.workflowListName", "workflowListName", ""],
    ]) {
        await t.test(`${field} ${original ? "explicit" : "default"}`, async (child) => {
            const selectedValues = { ...values, [field]: original };
            const { project, workspace, prepared, sdk } = await fixture(child, handoff, selectedValues);
            const path = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId,
                "generations", prepared.requestId, "request.json");
            const request = JSON.parse(await readFile(path, "utf8"));
            request.canvas[canvasField] = "A different value";
            const { integrity, ...payload } = request;
            request.integrity = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
            await writeFile(path, JSON.stringify(request));
            await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
                /Invalid frozen canvas identity/);
            await assert.rejects(readdir(sdk), { code: "ENOENT" });
        });
    }
});

test("materialization accepts frozen default description and workflow header", async (t) => {
    const selectedValues = { ...values, "canvas.description": "", "canvas.workflowListName": "" };
    const { project, workspace, prepared, sdk } = await fixture(t, handoff, selectedValues);
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const config = JSON.parse(await readFile(join(sdk, "canvas-config.json"), "utf8"));
    assert.equal(config.canvas.description, "Spec Kit workflow canvas.");
    assert.equal(config.canvas.workflowListName, "Workflows");
});

test("source-owned SDK entry registers, serves and closes the generated project canvas", async (t) => {
    const { project, workspace, prepared } = await fixture(t);
    const result = await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    assert.equal(result.target, ".github/extensions/my-workflow/");
    const target = join(project, ".github", "extensions", "my-workflow");
    await assert.rejects(readdir(join(workspace, "extensions")), { code: "ENOENT" });
    const entry = await readFile(join(target, "extension.mjs"), "utf8");
    assert.equal(entry, entryTemplate);
    assert.match(entry, /joinSession\(\{/);
    assert.match(entry, /createCanvas\(\{/);
    assert.match(entry, /createServer\(\(req, res\)/);
    assert.match(entry, /server\.listen\(0, "127\.0\.0\.1"/);
    assert.match(entry, /onClose: \(ctx\) => withLifecycle\(async \(\) =>/);
    assert.match(entry, /entry\.server\.close/);
    assert.doesNotMatch(entry, /Example agent-callable action/);
    assert.equal((await readFile(join(target, "ui", "workflow-theme.css"), "utf8"))
        .includes(".app-header"), true);
    const config = JSON.parse(await readFile(join(target, "canvas-config.json"), "utf8"));
    assert.deepEqual(config.phases, handoff.workflow.selectedPhases);
    assert.equal(config.userProvidesSlug, false);
    assert.deepEqual(config.installed, { presets: [{ id: "copilot-sub-agents", version: "1.0.0", priority: 1 }],
        extensions: [], bundles: [] });
    assert.equal(Object.hasOwn(config, "resultTags"), false);
    assert.equal(Object.hasOwn(config, "phaseResults"), false);
    for (const removed of ["result-tags.mjs", "tag-evaluator.mjs", "staleness.mjs"]) {
        await assert.rejects(readFile(join(target, removed)), { code: "ENOENT" });
    }
    const sdk = join(target, "node_modules", "@github", "copilot-sdk");
    await mkdir(sdk, { recursive: true });
    await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "@github/copilot-sdk",
        type: "module", exports: { "./extension": "./extension.mjs" } }));
    await writeFile(join(sdk, "extension.mjs"), `
        export const createCanvas = (options) => options;
        export async function joinSession({ canvases }) {
            globalThis.__generatedCanvas = canvases[0];
            return { sessionId: "test-session", workspacePath: ${JSON.stringify(workspace)},
                rpc: { metadata: { snapshot: async () => ({
                    workingDirectory: ${JSON.stringify(project)} }) } },
                on: () => () => {}, getEvents: async () => [], log: async () => {} };
        }
    `);
    await import(pathToFileURL(join(target, "extension.mjs")).href);
    const canvas = globalThis.__generatedCanvas;
    delete globalThis.__generatedCanvas;
    assert.equal(canvas.id, "my-workflow");
    assert.deepEqual(canvas.actions.map((action) => action.name),
        ["run_phase", "report_workflow_slug", "report_phase_artifact"]);
    const opened = await canvas.open({ instanceId: "generated-test" });
    assert.match(await (await fetch(opened.url)).text(), /My Workflow/);
    const state = await (await fetch(new URL(`/api/state?token=${new URL(opened.url).searchParams.get("token")}`,
        opened.url))).json();
    assert.deepEqual(state.phases.map((phase) => phase.id), handoff.workflow.selectedPhases);
    await canvas.onClose({ instanceId: "generated-test" });
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId));
});

test("Essentials keeps Workflow header separate from the default-off custom slug toggle", async () => {
    const page = JSON.parse(await readFile(new URL("../extension-canvas-design/pages/essentials.json", import.meta.url)));
    assert.deepEqual(page.fields.find((entry) => entry.id === "workflowSlug.userProvided"), {
        id: "workflowSlug.userProvided", type: "boolean", default: false, label: "Allow custom slug",
        description: "Lets users specify the slug used as the directory name for generated artifacts. Otherwise, Spec Kit chooses a default.",
    });
    assert.equal(page.fields.find((entry) => entry.id === "canvas.workflowListName").label, "Workflow header");
});

test("legacy result state stays on disk but is not evaluated or shown", async (t) => {
    const { project, workspace, prepared } = await fixture(t);
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const config = JSON.parse(await readFile(join(project, ".github", "extensions",
        "my-workflow", "canvas-config.json"), "utf8"));
    config.resultTags = [{ id: "legacy" }];
    config.phaseResults = { specify: { source: { kind: "phase-report" }, values: [{ id: "done" }] } };
    const stateKey = createHash("sha256").update(JSON.stringify([project, config.canvas.id])).digest("hex");
    const stateDir = join(workspace, "generated-canvases", stateKey);
    await mkdir(stateDir, { recursive: true });
    const old = { version: 1, revision: 0, selected: "__new__", phase: null, slug: "",
        name: "", names: {}, drafts: {}, runs: [], tagMatches: { old: { id: "old", name: "Old" } } };
    await writeFile(join(stateDir, "state.json"), JSON.stringify(old));
    const skill = join(project, ".github", "skills", "speckit-specify");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: speckit-specify\n---\n");
    let events = [];
    const runtime = await createRuntime({ config, cwd: project, workspace,
        session: { sessionId: "legacy-test", on: () => () => {},
            rpc: { skills: { reload: async () => ({ errors: [] }) } },
            send: async () => "message-legacy",
            getEvents: async () => events, log: async () => {} } });
    t.after(() => runtime.close());
    const snapshot = JSON.parse(JSON.stringify(await runtime.snapshot()));
    assert.equal(Object.hasOwn(snapshot, "tagMatches"), false);
    assert.equal(Object.hasOwn(snapshot, "summaryTags"), false);
    assert.equal(Object.hasOwn(snapshot.statuses.specify, "tags"), false);
    assert.equal(Object.hasOwn(snapshot.phases[1], "results"), false);
    assert.equal(Object.hasOwn(snapshot.items[0] ?? {}, "tags"), false);
    const html = renderHtml(config);
    assert.doesNotMatch(html, /result-tags|tag-diagnostic|checklist-progress/);
    await runtime.save({ revision: 0, selected: "__new__" });
    const run = await runtime.run({ phase: "specify", itemId: "__new__", args: "Feature" }, "panel-legacy");
    events = [
        { type: "user.message", data: { messageId: "message-legacy", interactionId: "interaction-legacy" } },
        { type: "assistant.turn_start", data: { interactionId: "interaction-legacy", turnId: "turn-legacy" } },
        { type: "assistant.message", data: { interactionId: "interaction-legacy",
            turnId: "turn-legacy", content: "Done", phase: "final" } },
        { type: "assistant.turn_end", data: { turnId: "turn-legacy" } },
    ];
    const completed = await runtime.refresh();
    assert.equal(completed.statuses.specify.status, "Completed");
    assert.equal(Object.hasOwn(completed.statuses.specify, "result"), false);
    assert.equal(JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"))
        .runs.find((entry) => entry.runId === run.runId).status, "Completed");
    assert.deepEqual(JSON.parse(await readFile(join(stateDir, "state.json"), "utf8")).tagMatches,
        old.tagMatches);
});

test("custom slug toggle controls the field and View target preview; actual directory binds artifacts", async (t) => {
    for (const [mode, requested] of [
        ["supplied", "sample-feature"],
        ["blank", ""],
        ["off", ""],
    ]) await t.test(mode, async (child) => {
        const enabled = mode !== "off";
        const { project, workspace, prepared } = await fixture(child, handoff,
            { ...values, "workflowSlug.userProvided": enabled });
        await materialize(project, workspace, handoff.handoffId, prepared.requestId);
        const config = JSON.parse(await readFile(join(project, ".github", "extensions", "my-workflow",
            "canvas-config.json"), "utf8"));
        const html = renderHtml(config);
        assert.equal(config.userProvidesSlug, enabled);
        const collection = html.slice(html.indexOf('<section id="instance-collection"'),
            html.indexOf('<p id="canvas-message"'));
        assert.match(html, /id="constitution-card"/);
        assert.doesNotMatch(renderHtml({ ...config, phases: ["specify"] }),
            /id="constitution-card"|id="view-constitution"|id="constitution-dialog"/);
        assert.doesNotMatch(collection, /id="feature-select"/);
        assert.match(collection, /id="workflow-list" class="instance-list"/);
        assert.match(collection, /id="workflow-search"/);
        assert.doesNotMatch(html, /id="current-workflow-title"/);
        assert.ok(collection.indexOf('id="workflow-name"') > collection.indexOf('id="new-workflow"'));
        const firstPhase = html.slice(html.indexOf('<section id="phase-card"'),
            html.indexOf('<template id="phase-template-1"'));
        assert.doesNotMatch(firstPhase, /id="workflow-name"|id="workflow-slug"/);
        assert.match(collection, /id="workflow-name-label">Workflow name <span class="muted">\(optional\)<\/span>/);
        assert.doesNotMatch(collection, /workflow-name-help|workflow-slug-help/);
        if (enabled) {
            assert.ok(collection.indexOf('id="workflow-slug"') > collection.indexOf('id="workflow-name"'));
            assert.match(collection, /id="workflow-slug-label">Artifact directory slug <span class="muted">\(optional\)<\/span>/);
            assert.match(collection, /id="workflow-slug"[^>]+placeholder="your-slug"/);
        } else assert.doesNotMatch(html, /id="workflow-slug"/);
        const ui = await readFile(new URL("../extension-canvas-design/templates/generated-canvas/ui/app.js", import.meta.url), "utf8");
        assert.match(ui, /input\.placeholder = input\.readOnly \? "Automatically assigned" : "your-slug"/);
        assert.doesNotMatch(html.slice(html.indexOf('<template id="phase-template-1"')),
            /id="workflow-slug"|id="workflow-name"/);
        assert.match(html, /<h2 id="workflow-heading">Workflows/);
        assert.match(renderHtml({ ...config, phases: ["constitution"] }), /id="workflow-name"/);
        const skill = join(project, ".github", "skills", "speckit-specify");
        await mkdir(skill, { recursive: true });
        await writeFile(join(skill, "SKILL.md"), "---\nname: speckit-specify\n---\n");
        const prompts = [];
        const runtime = await createRuntime({
            config, cwd: project, workspace, session: {
                sessionId: "workflow-test", rpc: { skills: { reload: async () => ({ errors: [] }) } },
                send: async ({ prompt }) => { prompts.push(prompt); return "message-1"; },
                on: () => () => {}, getEvents: async () => [], log: async () => {},
            },
        });
        child.after(() => runtime.close());
        await assert.rejects(runtime.run({ phase: "specify", itemId: "__new__", args: "Feature",
            slug: enabled ? "Invalid Name" : "sample-feature" }, "panel-1"),
        enabled ? /lowercase letters/ : /disabled/);
        await assert.rejects(runtime.run({ phase: "specify", itemId: "__new__", args: "Feature",
            name: "\n" }, "panel-1"), /Workflow name/);
        if (mode === "supplied") {
            await runtime.save({ revision: 0, slug: requested, name: "Customer dashboard" });
            assert.equal((await runtime.snapshot()).statuses.specify.output,
                "specs/sample-feature/spec.md");
        } else if (enabled) await runtime.save({ revision: 0, slug: "stale-name" });
        else await assert.rejects(runtime.save({ revision: 0, slug: "sample-feature" }), /disabled/);
        const result = await runtime.run({ phase: "specify", itemId: "__new__", args: "Feature",
            ...(mode === "supplied" ? { name: "Customer dashboard" } : {}),
            ...(mode === "blank" ? { slug: "" } : mode === "supplied" ? { slug: requested } : {}) }, "panel-1");
        assert.equal(prompts.length, 1);
        assert.equal(prompts[0].includes("Requested short name:"), !!requested);
        if (requested) assert.match(prompts[0], /Requested short name: "sample-feature"/);
        else assert.doesNotMatch(prompts[0], /Requested short name:|ask_user|Do not invent a name/);
        assert.doesNotMatch(prompts[0], /Customer dashboard/);
        assert.match(prompts[0], /Before writing workflow artifacts, invoke report_workflow_slug/);
        assert.doesNotMatch(prompts[0], /report_phase_result/);
        await assert.rejects(runtime.reportSlug({ phaseRunId: result.runId,
            slug: "001-sample-feature" }, "panel-1"), /does not exist yet/);
        const directory = join(project, "specs", "001-sample-feature");
        await mkdir(directory, { recursive: true });
        const reported = await runtime.reportSlug({ phaseRunId: result.runId,
            slug: "001-sample-feature" }, "panel-1");
        await assert.rejects(runtime.reportSlug({ phaseRunId: result.runId,
            slug: "002-other-feature" }, "panel-1"), /already reported a different/);
        assert.equal(reported.phases.find((phase) => phase.phase === "specify").outputs[0],
            "specs/001-sample-feature/spec.md");
        assert.equal((await runtime.snapshot()).selected, "specs/001-sample-feature");
        assert.equal((await runtime.snapshot()).items.find((item) => item.id === "specs/001-sample-feature").label,
            mode === "supplied" ? "Customer dashboard" : "001-sample-feature");
        await writeFile(join(directory, "spec.md"), "# Feature\n");
        await runtime.report({ phaseRunId: result.runId,
            path: "specs/001-sample-feature/spec.md" }, "panel-1");
        const snapshot = await runtime.snapshot();
        assert.equal(snapshot.selected, "specs/001-sample-feature");
        assert.equal(snapshot.statuses.specify.output, "specs/001-sample-feature/spec.md");
        if (mode === "supplied") {
            const reopened = await createRuntime({
                config, cwd: project, workspace, session: {
                    sessionId: "reopened-test", on: () => () => {},
                    getEvents: async () => [], log: async () => {},
                },
            });
            child.after(() => reopened.close());
            assert.equal((await reopened.snapshot()).items.find((item) => item.id === snapshot.selected).label,
                "Customer dashboard");
        }
    });
});

test("local development selections remain bound to the frozen handoff at publication", async (t) => {
    const local = { ...handoff, localSelections: { extensions: [{
        id: "extension-canvas-design", source: "local", approved: true,
        path: join(tmpdir(), "canvas-design-dev"),
    }] } };
    local.sourceFingerprint = createHash("sha256").update(JSON.stringify({
        workflow: local.workflow, selections: local.selections,
        localSelections: local.localSelections,
    })).digest("hex");
    const { project, workspace, prepared } = await fixture(t, local);
    await materialize(project, workspace, local.handoffId, prepared.requestId);
    const config = JSON.parse(await readFile(join(project, ".github", "extensions",
        "my-workflow", "canvas-config.json"), "utf8"));
    assert.deepEqual(config.installed.presets, [{ id: "copilot-sub-agents", version: "1.0.0", priority: 1 }]);
});

test("generated config excludes session-only installed package locators", async (t) => {
    const withLocators = { ...handoff, workflow: { ...handoff.workflow, installed: {
        presets: [{ id: "copilot-sub-agents", version: "1.0.0", priority: 1,
            path: join(tmpdir(), "private-preset"), source: "local",
            downloadUrl: "https://example.com/preset.zip" }],
        extensions: [{ id: "runtime-extension", version: "2.0.0", priority: 2,
            path: join(tmpdir(), "private-extension"), downloadUrl: "https://example.com/extension.zip" }],
        bundles: [{ id: "runtime-bundle", version: "3.0.0", source: "community",
            downloadUrl: "https://example.com/bundle.zip", catalogId: "community-bundle" }],
    } } };
    withLocators.sourceFingerprint = createHash("sha256").update(JSON.stringify({
        workflow: withLocators.workflow, selections: withLocators.selections,
    })).digest("hex");
    const { project, workspace, prepared, sdk } = await fixture(t, withLocators);
    const request = JSON.parse(await readFile(join(workspace, "speckit-canvas-designer", "handoffs",
        withLocators.handoffId, "generations", prepared.requestId, "request.json"), "utf8"));
    assert.deepEqual(request.installed, withLocators.workflow.installed);
    await materialize(project, workspace, withLocators.handoffId, prepared.requestId);
    const config = JSON.parse(await readFile(join(sdk, "canvas-config.json"), "utf8"));
    assert.deepEqual(config.installed, {
        presets: [{ id: "copilot-sub-agents", version: "1.0.0", priority: 1 }],
        extensions: [{ id: "runtime-extension", version: "2.0.0", priority: 2 }],
        bundles: [{ id: "runtime-bundle", version: "3.0.0" }],
    });
});

test("existing canvases are preserved and tampered requests fail before creation", async (t) => {
    const one = await fixture(t);
    await mkdir(one.sdk, { recursive: true });
    await writeFile(join(one.sdk, "extension.mjs"), "await joinSession({})");
    await assert.rejects(materialize(one.project, one.workspace, handoff.handoffId, one.prepared.requestId),
        /Canvas extension already exists/);
    assert.equal(await readFile(join(one.sdk, "extension.mjs"), "utf8"), "await joinSession({})");
    assert.deepEqual(await readdir(one.sdk), ["extension.mjs"]);
    const two = await fixture(t);
    const path = join(two.workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId,
        "generations", two.prepared.requestId, "request.json");
    const request = JSON.parse(await readFile(path, "utf8"));
    request.values["canvas.displayName"] = "Tampered";
    await writeFile(path, JSON.stringify(request));
    await assert.rejects(materialize(two.project, two.workspace, handoff.handoffId, two.prepared.requestId),
        /integrity mismatch/);
});

test("generation request and Wizard handoff reject symlinks and oversized files", async (t) => {
    for (const [name, limit] of [["request.json", 512 * 1024], ["handoff.json", 64 * 1024]]) {
        await t.test(name, async (child) => {
            const { project, workspace, prepared, sdk } = await fixture(child);
            const folder = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId);
            const path = name === "request.json"
                ? join(folder, "generations", prepared.requestId, name) : join(folder, name);
            const saved = `${path}.saved`;
            await rename(path, saved);
            let linked = false;
            try {
                await symlink(saved, path, "file");
                linked = true;
            } catch (error) {
                if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
                child.diagnostic(`File symlink unavailable: ${error.code}`);
            }
            if (linked) {
                await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
                    /bounded regular session file|ELOOP|EINVAL/);
                await rm(path);
            }
            await writeFile(path, Buffer.alloc(limit + 1, 32));
            await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
                /too large/);
            await assert.rejects(readdir(sdk), { code: "ENOENT" });
        });
    }
});

test("pinned generation reads reject leaf and parent swaps during open", async (t) => {
    for (const [name, limit, label] of [
        ["request.json", 512 * 1024, "Generation request"],
        ["handoff.json", 64 * 1024, "Wizard handoff"],
    ]) {
        for (const swap of ["leaf", "parent"]) {
            await t.test(`${name} ${swap}`, async (child) => {
                const { workspace, prepared } = await fixture(child);
                const folder = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId);
                const parent = name === "request.json"
                    ? join(folder, "generations", prepared.requestId) : folder;
                const path = join(parent, name);
                await assert.rejects(readBoundedSessionFile(parent, name, limit, label, async (filePath, flags) => {
                    if (swap === "parent") {
                        await rename(parent, `${parent}.old`);
                        await mkdir(parent);
                        await writeFile(path, "replacement");
                    }
                    const file = await open(filePath, flags);
                    if (swap === "leaf") {
                        await rename(path, `${path}.old`);
                        await writeFile(path, "replacement");
                    }
                    return file;
                }), /bounded regular session file/);
            });
        }
    }
});
