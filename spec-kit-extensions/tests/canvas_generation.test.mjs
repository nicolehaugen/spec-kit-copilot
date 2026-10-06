import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { materialize, readBoundedSessionFile } from "../extension-canvas-design/scripts/generate.mjs";
import { createRuntime } from "../extension-canvas-design/generated-scaffold/runtime.mjs";
import { phaseContract } from "../extension-canvas-design/generated-scaffold/contract.mjs";
import { renderHtml } from "../extension-canvas-design/generated-scaffold/server.mjs";
import { freezeGeneration, readCurrentInstalledVersions, validateEssentials } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/generation.mjs";
import { buildAugmentedPath } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-wizard-canvas/env/resolve-path.mjs";
import { addWorkflowFixture } from "./workflow_fixture.mjs";
import { addDesignerAdapterFixture, resolveFixtureFields } from "./designer_adapter_fixture.mjs";
import { isWindowsDeviceName as designerDeviceName } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/pages.mjs";
import { isWindowsDeviceName as runtimeDeviceName } from "../extension-canvas-design/generated-scaffold/files.mjs";

const entryTemplate = await readFile(new URL("../extension-canvas-design/generated-scaffold/extension.mjs",
    import.meta.url), "utf8");
const model = {
    revision: "test-revision",
    settingsRevision: 0,
    pages: [{ page: "designer-essentials", fields: [
        { id: "canvas.id" }, { id: "canvas.displayName" }, { id: "canvas.description" },
        { id: "canvas.workflowListName" }, { id: "workflowSlug.userProvided" },
    ] }],
    constraints: {
        "canvas.id": { type: "string", minLength: 1, maxLength: 100,
            pattern: "^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9][a-z0-9-]*$" },
        "canvas.displayName": { type: "string", minLength: 1, maxLength: 120 },
        "canvas.description": { type: "string", maxLength: 240 },
        "canvas.workflowListName": { type: "string", maxLength: 80 },
        "workflowSlug.userProvided": { type: "boolean" },
    },
};
const values = { "canvas.id": "my-workflow", "canvas.displayName": "My Workflow",
    "canvas.description": "A workflow", "canvas.workflowListName": "Workflows",
    "workflowSlug.userProvided": false };

test("confirmed outputs override legacy defaults, including an explicitly empty phase", () => {
    const config = { phases: ["specify", "plan"], phaseOutputs: {
        specify: { expectsArtifact: true, outputPath: "specs/<slug>/spec.md" },
        plan: { expectsArtifact: true, outputPath: "specs/<slug>/plan.md" },
    }, phaseArtifacts: {
        specify: { outputs: ["specs/<slug>/spec.md", "specs/<slug>/research.md"],
            view: "specs/<slug>/research.md" },
        plan: { outputs: [], view: null },
    } };
    const phases = phaseContract(config);
    assert.equal(phases[0].output, "specs/<slug>/research.md");
    assert.deepEqual(phases[0].outputs, config.phaseArtifacts.specify.outputs);
    assert.equal(phases[1].output, null);
    assert.deepEqual(phases[1].outputs, []);
    assert.equal(phases[1].expectsArtifact, false);
    for (const invalid of [
        { outputs: [], view: "specs/<slug>/plan.md" },
        { outputs: ["../bad.md"], view: "../bad.md" },
        { outputs: ["specs/<slug>/plan.md", "specs/<slug>/plan.md"],
            view: "specs/<slug>/plan.md" },
    ]) {
        assert.throws(() => phaseContract({ ...config, phaseArtifacts:
            { ...config.phaseArtifacts, plan: invalid } }), /Invalid|outside|Duplicate/);
    }
});

test("Constitution always opens its fixed artifact despite stale output mappings", () => {
    const [phase] = phaseContract({ phases: ["constitution"], phaseOutputs: {
        constitution: { expectsArtifact: false, outputPath: null },
    }, phaseArtifacts: { constitution: { outputs: [], view: null } } });
    assert.equal(phase.output, ".specify/memory/constitution.md");
    assert.deepEqual(phase.outputs, [".specify/memory/constitution.md"]);
    assert.equal(phase.expectsArtifact, true);
});

test("frozen Designer outputs become the generated viewer and link configuration", async (t) => {
    const { project, workspace } = await fixture(t);
    const outputs = {
        constitution: { outputs: [".specify/memory/constitution.md"],
            view: ".specify/memory/constitution.md" },
        specify: { outputs: ["specs/<slug>/spec.md", "specs/<slug>/research.md"],
            view: "specs/<slug>/research.md" },
        plan: { outputs: [], view: null },
    };
    const prepared = await freezeGeneration({ project, workspace, model, values, handoff, outputs });
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const config = JSON.parse(await readFile(join(project, ".github", "extensions",
        "my-workflow", "canvas-config.json"), "utf8"));
    assert.deepEqual(config.phaseArtifacts, outputs);
    const steps = phaseContract(config);
    assert.equal(steps.find((step) => step.id === "specify").output, "specs/<slug>/research.md");
    assert.equal(steps.find((step) => step.id === "plan").output, null);
    assert.equal(steps.find((step) => step.id === "constitution").output,
        ".specify/memory/constitution.md");
    await assert.rejects(freezeGeneration({ project, workspace, model, values, handoff,
        outputs: { ...outputs, constitution: { outputs: [], view: null } } }),
    /Constitution output is fixed/);
    const directory = join(project, "specs", "demo");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "spec.md"), "# Spec");
    await writeFile(join(directory, "research.md"), "# Research");
    const runtime = await createRuntime({ config, cwd: project, workspace,
        session: { sessionId: "outputs-test", on: () => () => {},
            getEvents: async () => [], log: async () => {} } });
    t.after(() => runtime.close());
    assert.equal((await runtime.artifact({ phase: "specify", itemId: "specs/demo" })).path,
        "specs/demo/research.md");
    assert.equal((await runtime.artifact({ phase: "specify", itemId: "specs/demo",
        output: "specs/<slug>/spec.md" })).content, "# Spec");
    await assert.rejects(runtime.artifact({ phase: "specify", itemId: "specs/demo",
        output: ".github/private.md" }), /not declared/);
    await assert.rejects(runtime.artifact({ phase: "plan", itemId: "specs/demo" }),
        /No artifact is available/);
});

test("viewer-only roots do not create workflows and links resolve within the selected slug", async (t) => {
    const { project, workspace } = await fixture(t);
    const config = {
        canvas: { id: "viewer-roots", displayName: "Viewer roots" },
        phases: ["specify"], phaseOutputs: {
            specify: { expectsArtifact: true, outputPath: "specs/<slug>/spec.md" },
        },
        phaseArtifacts: { specify: {
            outputs: ["specs/<slug>/spec.md", "reports/<slug>/notes.md"],
            view: "specs/<slug>/spec.md",
        } },
    };
    await mkdir(join(project, "specs", "demo"), { recursive: true });
    await mkdir(join(project, "reports", "demo"), { recursive: true });
    await writeFile(join(project, "specs", "demo", "spec.md"), "# Spec");
    await writeFile(join(project, "reports", "demo", "notes.md"), "# Notes");
    const runtime = await createRuntime({ config, cwd: project, workspace,
        session: { sessionId: "viewer-roots", on: () => () => {},
            getEvents: async () => [], log: async () => {} } });
    t.after(() => runtime.close());
    const state = await runtime.snapshot();
    assert.deepEqual(state.items.map(({ id }) => id), ["specs/demo"]);
    assert.equal((await runtime.artifact({ phase: "specify", itemId: "specs/demo",
        output: "reports/<slug>/notes.md" })).content, "# Notes");
});
const handoff = { handoffId: "handoff-1", sourceFingerprint: "",
    selections: { presets: [], extensions: [], bundles: [] },
    workflow: { selectedPhases: ["constitution", "specify", "plan"],
        installed: { presets: [{ id: "copilot-sub-agents", source: "copilot",
            version: "1.0.0", priority: 1 }],
            extensions: [], bundles: [] } } };
handoff.sourceFingerprint = createHash("sha256").update(JSON.stringify({
    workflow: handoff.workflow, selections: handoff.selections,
})).digest("hex");

async function fixture(t, selectedHandoff = handoff, selectedValues = values, runtimeInventory) {
    const root = await mkdtemp(join(tmpdir(), "designer-generate-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const project = join(root, "project"), workspace = join(root, "workspace");
    await mkdir(project);
    await mkdir(workspace);
    await addDesignerAdapterFixture(project, model);
    await addWorkflowFixture(project, model);
    const folder = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "handoff.json"), JSON.stringify(selectedHandoff));
    const prepared = await freezeGeneration({ project, workspace, model, values: selectedValues,
        handoff: selectedHandoff, runtimeInventory });
    const sdk = join(project, ".github", "extensions", selectedValues["canvas.id"]);
    return { project, workspace, prepared, sdk };
}

test("Specify inventories supply observed package versions and reject invalid responses", async () => {
    const lists = {
        preset: [{ id: "copilot-sub-agents", version: "1.2.3", priority: 4 }],
        extension: [{ id: "extension-canvas-design", version: "0.1.19", priority: 1 }],
        bundle: [{ bundle_id: "bundle-one", version: "2.0.0" }],
    };
    const frozen = { presets: [{ id: "copilot-sub-agents" }],
        extensions: [{ id: "extension-canvas-design" }],
        bundles: [{ id: "bundle-one" }] };
    const kinds = ["presets", "extensions", "bundles"];
    const calls = [];
    const run = async (_command, args, options) => {
        calls.push({ args, cwd: options.cwd, env: options.env, shell: options.shell });
        return { stdout: JSON.stringify(lists[args[0]]) };
    };
    assert.deepEqual(await readCurrentInstalledVersions("child", frozen, run), {
        inventory: { presets: lists.preset, extensions: lists.extension,
            bundles: [{ id: "bundle-one", version: "2.0.0" }] }, warnings: [],
    });
    const augmentedPath = await buildAugmentedPath();
    assert.deepEqual(calls, kinds.map((kind) => ({
        args: [kind === "presets" ? "preset" : kind === "extensions" ? "extension" : "bundle",
            "list", "--json"], cwd: "child",
        env: { ...process.env, PATH: augmentedPath }, shell: process.platform === "win32",
    })));
    assert.deepEqual(await readCurrentInstalledVersions("child",
        { presets: [], extensions: [], bundles: [] }, run),
        { inventory: { presets: [], extensions: [], bundles: [] }, warnings: [] });
    const unreadable = await readCurrentInstalledVersions("child", frozen, async (_command, args) => ({
        stdout: args[0] === "preset" ? "not JSON" : JSON.stringify(lists[args[0]]),
    }));
    assert.match(unreadable.warnings[0], /Invalid presets JSON from Specify/);
    assert.deepEqual(unreadable.inventory.extensions, lists.extension);
    const duplicates = await readCurrentInstalledVersions("child", frozen, async (_command, args) => ({
        stdout: JSON.stringify(args[0] === "preset"
            ? [lists.preset[0], lists.preset[0]] : lists[args[0]]),
    }));
    assert.match(duplicates.warnings[0], /Invalid presets package identity or version/);
    const unrelated = Array.from({ length: 45 }, (_, index) =>
        ({ id: `other-${index}`, version: "1.0.0", priority: 1 }));
    const crowded = await readCurrentInstalledVersions("child", frozen, async (_command, args) => ({
        stdout: JSON.stringify(args[0] === "preset"
            ? [...unrelated, { id: "unrelated-malformed" }, lists.preset[0]]
            : lists[args[0]]),
    }));
    assert.deepEqual(crowded.inventory.presets, lists.preset);
    assert.deepEqual(crowded.warnings, []);
    const malformedRelevant = await readCurrentInstalledVersions("child", frozen,
        async (_command, args) => ({
            stdout: JSON.stringify(args[0] === "preset"
                ? [...unrelated, { id: "copilot-sub-agents" }]
                : lists[args[0]]),
        }));
    assert.match(malformedRelevant.warnings[0], /Invalid presets package identity or version/);
    const missingCli = await readCurrentInstalledVersions("child", frozen, async () => {
        throw Object.assign(new Error("specify not found"), { code: "ENOENT" });
    });
    assert.equal(missingCli.warnings.length, 3);
    assert.deepEqual(missingCli.inventory, { presets: [], extensions: [], bundles: [] });
});

test("generated package versions reflect the installed inventory without blocking drift", async (t) => {
    const current = { presets: [{ id: "copilot-sub-agents", version: "1.2.3", priority: 4 }],
        extensions: [], bundles: [] };
    const { project, workspace, prepared, sdk } = await fixture(t, handoff, values, current);
    assert.match(prepared.warnings[0], /Wizard version 1\.0\.0, installed version 1\.2\.3/);
    const request = JSON.parse(await readFile(join(workspace, "speckit-canvas-designer",
        "handoffs", handoff.handoffId, "generations", prepared.requestId, "request.json"), "utf8"));
    assert.deepEqual(request.installed, handoff.workflow.installed);
    assert.deepEqual(request.actualInstalled.presets, [{ id: "copilot-sub-agents",
        version: "1.2.3", priority: 4 }]);
    const generated = await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    assert.match(generated.warnings[0], /Wizard version 1\.0\.0, installed version 1\.2\.3/);
    const config = JSON.parse(await readFile(join(sdk, "canvas-config.json"), "utf8"));
    assert.deepEqual(config.installed.presets, request.actualInstalled.presets);
});

test("unavailable installed packages remain unverified, not mislabeled as frozen versions", async (t) => {
    const empty = { presets: [], extensions: [], bundles: [] };
    const { project, workspace, prepared, sdk } = await fixture(t, handoff, values, empty);
    assert.match(prepared.warnings[0], /installed version unverified/);
    const generated = await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    assert.match(generated.warnings[0], /installed version unverified/);
    const config = JSON.parse(await readFile(join(sdk, "canvas-config.json"), "utf8"));
    assert.deepEqual(config.installed.presets, [{ id: "copilot-sub-agents", version: "unverified" }]);
});

test("bundle version drift is recorded from Specify without changing the Wizard snapshot", async (t) => {
    const withBundle = structuredClone(handoff);
    withBundle.workflow.installed.bundles = [{ id: "sample-bundle", version: "2.0.0" }];
    withBundle.sourceFingerprint = createHash("sha256").update(JSON.stringify({
        workflow: withBundle.workflow, selections: withBundle.selections,
    })).digest("hex");
    const current = { presets: [{ id: "copilot-sub-agents", version: "1.0.0", priority: 1 }],
        extensions: [], bundles: [{ id: "sample-bundle", version: "2.1.0" }] };
    const { project, workspace, prepared, sdk } = await fixture(t, withBundle, values, current);
    assert.match(prepared.warnings[0], /bundles sample-bundle: Wizard version 2\.0\.0, installed version 2\.1\.0/);
    await materialize(project, workspace, withBundle.handoffId, prepared.requestId);
    const config = JSON.parse(await readFile(join(sdk, "canvas-config.json"), "utf8"));
    assert.deepEqual(config.installed.bundles, [{ id: "sample-bundle", version: "2.1.0" }]);
});

test("a signed generation request cannot relabel a Wizard package ID", async (t) => {
    const current = { presets: [{ id: "copilot-sub-agents", version: "1.2.3", priority: 4 }],
        extensions: [], bundles: [] };
    const { project, workspace, prepared } = await fixture(t, handoff, values, current);
    const path = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId,
        "generations", prepared.requestId, "request.json");
    const request = JSON.parse(await readFile(path, "utf8"));
    request.actualInstalled.presets[0].id = "wrong-package";
    const { integrity: _integrity, ...payload } = request;
    request.integrity = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    await writeFile(path, JSON.stringify(request));
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /Invalid verified generation inventory/);
});

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
    await assert.rejects(freezeGeneration({ model, values: { ...values, "canvas.id": "../bad" },
        handoff, project, workspace }), /Invalid Designer setting: canvas.id/);
    await assert.rejects(freezeGeneration({ model, values: { ...values, "canvas.displayName": " " },
        handoff, project, workspace }), /Canvas ID and Title must be valid/);
    assert.throws(() => validateEssentials(model, { ...values, "canvas.id": "../bad" }), /canvas.id/);
    for (const id of ["con", "prn", "aux", "nul",
        ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
        ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)]) {
        assert.throws(() => validateEssentials(model, { ...values, "canvas.id": id }), /non-reserved/);
    }
    for (const id of ["com0", "com10", "lpt0", "lpt10", "con-1"]) {
        assert.equal(validateEssentials(model, { ...values, "canvas.id": id })["canvas.id"], id);
    }
    assert.throws(() => validateEssentials(model, { ...values, "canvas.displayName": " " }), /Canvas ID and Title must be valid/);
    assert.throws(() => validateEssentials(model, { ...values, "workflowSlug.userProvided": "true" }), /workflowSlug.userProvided/);
    const { ["workflowSlug.userProvided"]: omitted, ...missingToggle } = values;
    assert.throws(() => validateEssentials(model, missingToggle), /unexpected or missing fields/);
});

test("all enabled Designer values are validated and frozen, with only bound fields rendered", async (t) => {
    const { project, workspace } = await fixture(t);
    const contributedModel = { ...model,
        pages: model.pages.map((page) => ({ ...page, fields: [...page.fields] })),
        constraints: { ...model.constraints,
            "billing.costCode": { type: "string", maxLength: 64 },
            "designer.note": { type: "string", maxLength: 80 } },
        contributions: [{ field: { id: "billing.costCode", label: "Cost code" },
            generatedBinding: { presentation: "stock.readonly",
                section: { id: "billing", title: "Billing" } } },
        { field: { id: "designer.note", label: "Internal note" } }] };
    resolveFixtureFields(contributedModel);
    const supplied = { ...values, "billing.costCode": "CC-481", "designer.note": "Designer only" };
    await assert.rejects(freezeGeneration({ model: contributedModel,
        values: { ...supplied, "designer.note": "x".repeat(81) },
        handoff, project, workspace }), /Invalid Internal note \(designer.note\)/);
    const prepared = await freezeGeneration({ model: contributedModel, values: supplied,
        handoff, project, workspace });
    const frozen = JSON.parse(await readFile(join(workspace, "speckit-canvas-designer",
        "handoffs", handoff.handoffId, "generations", prepared.requestId, "request.json"), "utf8"));
    assert.equal(frozen.values["billing.costCode"], "CC-481");
    assert.equal(frozen.values["designer.note"], "Designer only");
    assert.deepEqual(frozen.generatedFields.map(({ id }) => id), ["billing.costCode"]);
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const setup = JSON.parse(await readFile(join(project, ".github", "extensions",
        "my-workflow", "canvas-setup.json"), "utf8"));
    assert.equal(setup.values["billing.costCode"], "CC-481");
    assert.equal(setup.values["designer.note"], "Designer only");
    const config = JSON.parse(await readFile(join(project, ".github", "extensions",
        "my-workflow", "canvas-config.json"), "utf8"));
    assert.equal(config.readOnlyFields.some((field) => field.id === "designer.note"), false);
});

test("re-signed requests reject inconsistent, missing, and colliding generated values", async (t) => {
    for (const [name, change, error] of [
        ["undeclared value", (request) => { request.values["designer.note"] = "not generated"; },
            /Invalid frozen Designer fields/],
        ["missing Essential", (request) => { delete request.values["canvas.description"]; },
            /Invalid frozen Designer fields/],
        ["missing bound value", (request) => {
            request.generatedFields = [{ id: "billing.costCode", label: "Cost code", maxLength: 64 }];
        }, /Invalid frozen generated fields/],
        ["bound ID collides with Essential", (request) => {
            request.generatedFields = [{ id: "canvas.displayName", label: "Title", maxLength: 120 }];
        }, /Invalid frozen generated values/],
        ["generated field maxLength differs from its constraint", (request) => {
            request.generatedFields = [{ id: "canvas.description", label: "Description", maxLength: 1000 }];
        }, /Invalid frozen generated fields/],
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
    assert.ok(raw.length <= 4 * 1024 * 1024);
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
    await writeFile(path, "x".repeat(4 * 1024 * 1024 + 1));
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /Generation request is too large/);
});

test("six maximum-size generated pages fit the frozen request and materialize", async (t) => {
    const { project, workspace } = await fixture(t);
    const pages = join(project, ".specify", "pages");
    await mkdir(pages, { recursive: true });
    const generatedPages = [], templates = [...model.templates];
    const rendererContent = "export function renderPage({ root }) { root.textContent = 'Overview'; }"
        .padEnd(32 * 1024, " ");
    for (let index = 0; index < 6; index++) {
        const id = `canvas-generated-${index}`, renderer = `canvas-renderer-${index}`;
        const title = `Overview ${index}`;
        const definition = JSON.stringify({ schemaVersion: 1, id, renderer, title })
            .padEnd(32 * 1024, " ");
        generatedPages.push({ name: id, id, title, renderer });
        for (const [name, kind, content, extension] of [
            [id, "generated.added-page-definition", definition, "json"],
            [renderer, "generated.added-page-renderer", rendererContent, "mjs"],
        ]) {
            const path = join(pages, `${name}.${extension}`);
            await writeFile(path, content);
            templates.push({ name, path, kind, sourceId: "test-preset", strategy: "replace",
                hash: createHash("sha256").update(content).digest("hex") });
        }
    }
    const prepared = await freezeGeneration({ project, workspace,
        model: { ...model, generatedPages, templates }, values, handoff });
    const request = await readFile(join(workspace, "speckit-canvas-designer", "handoffs",
        handoff.handoffId, "generations", prepared.requestId, "request.json"));
    assert.ok(request.length > 512 * 1024);
    assert.ok(request.length <= 4 * 1024 * 1024);
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    for (const page of generatedPages) {
        const bytes = await readFile(join(project, ".github", "extensions", values["canvas.id"],
            "pages", `${page.renderer}.mjs`));
        assert.equal(bytes.length, 32 * 1024);
    }
});

test("generated navigation preserves frozen order with explicit and implicit page orders", async (t) => {
    const { project, workspace } = await fixture(t);
    const pages = join(project, ".specify", "pages");
    await mkdir(pages, { recursive: true });
    const generatedPages = [], templates = [...model.templates];
    for (const [id, order] of [["explicit", 50], ["implicit", undefined]]) {
        const pageId = `canvas-generated-${id}`, renderer = `canvas-renderer-${id}`;
        const definition = JSON.stringify({ schemaVersion: 1, id: pageId, title: id,
            renderer, ...(order !== undefined ? { order } : {}) });
        generatedPages.push({ name: pageId, id: pageId, title: id, renderer,
            ...(order !== undefined ? { order } : {}) });
        for (const [name, kind, content, extension] of [
            [pageId, "generated.added-page-definition", definition, "json"],
            [renderer, "generated.added-page-renderer", "export function renderPage() {}", "mjs"],
        ]) {
            const path = join(pages, `${name}.${extension}`);
            await writeFile(path, content);
            templates.push({ name, path, kind, sourceId: "test-preset", strategy: "replace",
                hash: createHash("sha256").update(content).digest("hex") });
        }
    }
    const prepared = await freezeGeneration({ project, workspace,
        model: { ...model, generatedPages, templates }, values, handoff });
    const frozen = JSON.parse(await readFile(join(workspace, "speckit-canvas-designer",
        "handoffs", handoff.handoffId, "generations", prepared.requestId, "request.json"), "utf8"));
    const expected = ["canvas-generated-implicit", "canvas-generated-explicit"];
    assert.deepEqual(frozen.generatedPages.map(({ id }) => id), expected);

    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const config = JSON.parse(await readFile(join(project, ".github", "extensions",
        values["canvas.id"], "canvas-config.json"), "utf8"));
    assert.deepEqual(config.generatedPages.map(({ id }) => id), expected);
    const navigation = renderHtml(config).match(/<nav class="phase-navigation" aria-label="Canvas pages">([\s\S]*?)<\/nav>/)?.[1];
    assert.ok(navigation);
    assert.deepEqual([...navigation.matchAll(/data-canvas-page="([^"]+)"/g)]
        .map(([, id]) => id), ["workflow", ...expected]);
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
    const pagesHtml = renderHtml({ ...config, generatedPages: [
        { id: "undeclared", title: "Undeclared", renderer: "undeclared", values: [] },
        { id: "declared", title: "Declared", renderer: "declared", values: ["billing.costCode"],
            slots: [{ id: "hero.logo", accepts: ["asset"] }] },
    ], generatedPageAssets: [{ id: "brand.gallery", page: "declared",
        slot: "hero.logo", label: "Gallery logo", file: "asset-gallery.png",
        mime: "image/png", hash: "a".repeat(64) }] });
    assert.doesNotMatch(pagesHtml, /<section id="generated-page"[^>]*data-values=/);
    assert.match(pagesHtml, /data-generated-renderer="undeclared"[\s\S]*?data-values="\{\}"/);
    assert.match(pagesHtml, /data-generated-renderer="declared"[\s\S]*?data-values="\{&quot;billing\.costCode&quot;:&quot;&lt;script&gt;\\&quot;CC\\&quot;&lt;\/script&gt;&quot;\}"/);
    assert.match(pagesHtml, /data-generated-renderer="declared"[\s\S]*?data-asset-slots="\[\{&quot;id&quot;:&quot;hero\.logo&quot;,&quot;accepts&quot;:\[&quot;asset&quot;\]\}\]"/);
    assert.match(pagesHtml, /data-generated-renderer="declared"[\s\S]*?data-assets="\[\{&quot;id&quot;:&quot;brand\.gallery&quot;/);
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
    await writeFile(join(target, "canvas-config.json"),
        JSON.stringify({ ...defaultConfig, generatedPages: [{
            id: "workflow", title: "Workflow", renderer: "workflow-renderer",
        }] }));
    assert.throws(() => readConfig(), /Invalid generated canvas configuration/);
    for (const name of ["con", "prn", "aux", "nul", "com1", "lpt9"]) {
        for (const field of ["id", "renderer"]) {
            await writeFile(join(target, "canvas-config.json"),
                JSON.stringify({ ...defaultConfig, generatedPages: [{
                    id: "overview", title: "Overview", renderer: "overview-renderer", [field]: name,
                }] }));
            assert.throws(() => readConfig(), /Invalid generated canvas configuration/);
        }
    }
    await writeFile(join(target, "canvas-config.json"),
        JSON.stringify({ ...defaultConfig, canvas: { ...defaultConfig.canvas, id: "con" } }));
    assert.throws(() => readConfig(), /Invalid generated canvas configuration/);
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
        /Invalid frozen (?:Designer field: canvas\.id|canvas identity)/);
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
        ["run_phase", "report_workflow_slug", "report_phase_artifact", "report_autopilot_step"]);
    const opened = await canvas.open({ instanceId: "generated-test" });
    assert.match(await (await fetch(opened.url)).text(), /My Workflow/);
    const state = await (await fetch(new URL(`/api/state?token=${new URL(opened.url).searchParams.get("token")}`,
        opened.url))).json();
    assert.deepEqual(state.phases.map((phase) => phase.id), handoff.workflow.selectedPhases);
    await canvas.onClose({ instanceId: "generated-test" });
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId));
});

test("generation rejects malformed or mismatched frozen page assets before creating a target", async (t) => {
    const { project, workspace, prepared, sdk } = await fixture(t);
    const path = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId,
        "generations", prepared.requestId, "request.json");
    const request = JSON.parse(await readFile(path, "utf8"));
    const definition = JSON.stringify({ schemaVersion: 1, id: "canvas-generated-overview",
        renderer: "canvas-generated-overview-renderer", title: "Overview" });
    const module = "export function renderPage({ root }) { root.textContent = 'Overview'; }";
    const asset = (name, kind, content) => ({ name, kind, sourceId: "copilot-generated-page-test",
        hash: createHash("sha256").update(content).digest("hex"),
        content: Buffer.from(content).toString("base64") });
    request.generatedPages = [{ id: "canvas-generated-overview", title: "Overview",
        renderer: "canvas-generated-overview-renderer", assets: [
            asset("canvas-generated-overview", "generated.added-page-definition", definition),
            asset("canvas-generated-overview-renderer", "generated.added-page-renderer", module),
        ] }];
    for (const change of [
        (page) => { page.assets[0].hash = "0".repeat(64); },
        (page) => { page.assets[1].kind = "script"; },
        (page) => { page.title = "Changed"; },
        (page) => { page.renderer = "../escape"; },
        (page) => { page.id = "workflow"; },
        (page) => { page.assets[1] = asset(page.renderer, "generated.added-page-renderer",
            module.padEnd(32 * 1024 + 1, " ")); },
    ]) {
        const trial = structuredClone(request);
        change(trial.generatedPages[0]);
        const { integrity: _old, ...payload } = trial;
        trial.integrity = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
        await writeFile(path, JSON.stringify(trial));
        await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
            /Invalid frozen generated page assets|frozen generated page definition|Invalid frozen generated pages/);
        await assert.rejects(readdir(sdk), { code: "ENOENT" });
    }
    for (const [field, name] of [["id", "con"], ["renderer", "nul"]]) {
        const trial = structuredClone(request);
        const page = trial.generatedPages[0];
        page[field] = name;
        page.assets[0] = asset(page.id, "generated.added-page-definition", JSON.stringify({
            schemaVersion: 1, id: page.id, renderer: page.renderer, title: page.title,
        }));
        page.assets[1] = asset(page.renderer, "generated.added-page-renderer", module);
        const { integrity: _old, ...payload } = trial;
        trial.integrity = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
        await writeFile(path, JSON.stringify(trial));
        await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
            /Invalid frozen generated page assets/);
        await assert.rejects(readdir(sdk), { code: "ENOENT" });
    }
    const boundary = structuredClone(request);
    boundary.generatedPages[0].assets[1] = asset("canvas-generated-overview-renderer",
        "generated.added-page-renderer", module.padEnd(32 * 1024, " "));
    const { integrity: _old, ...payload } = boundary;
    boundary.integrity = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    await writeFile(path, JSON.stringify(boundary));
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    assert.equal((await readFile(join(project, ".github", "extensions", "my-workflow",
        "pages", "canvas-generated-overview-renderer.mjs"))).length, 32 * 1024);
});

test("generated page IDs cannot overwrite fixed page assets before target creation", async (t) => {
    const { project, workspace, prepared, sdk } = await fixture(t);
    const path = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId,
        "generations", prepared.requestId, "request.json");
    const original = JSON.parse(await readFile(path, "utf8"));
    const digest = (content) => createHash("sha256").update(content).digest("hex");
    const asset = (name, kind, content) => ({
        name, kind, sourceId: "copilot-generated-page-test",
        hash: digest(content), content: Buffer.from(content).toString("base64"),
    });
    for (const id of ["phase-control"]) {
        const request = structuredClone(original);
        const renderer = "unique-page-renderer";
        request.generatedPages = [{
            id, title: "Extra page", renderer, assets: [
                asset(id, "generated.added-page-definition", JSON.stringify({
                    schemaVersion: 1, id, renderer, title: "Extra page",
                })),
                asset(renderer, "generated.added-page-renderer",
                    "export function renderPage({ root }) { root.textContent = 'Extra page'; }"),
            ],
        }];
        const { integrity: _previous, ...payload } = request;
        request.integrity = digest(JSON.stringify(payload));
        await writeFile(path, JSON.stringify(request));
        await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
            new RegExp(`Conflicting generated page asset: ${id}\\.json`));
        await assert.rejects(readdir(sdk), { code: "ENOENT" });
    }
});

test("Workflow layout and phase control freeze, validate and package independently of the preset", async (t) => {
    const { project, workspace, prepared, sdk } = await fixture(t);
    const requestPath = join(workspace, "speckit-canvas-designer", "handoffs",
        handoff.handoffId, "generations", prepared.requestId, "request.json");
    const original = JSON.parse(await readFile(requestPath, "utf8"));
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const rewrite = async (edit) => {
        const request = structuredClone(original);
        edit(request);
        const { integrity: _old, ...payload } = request;
        request.integrity = digest(JSON.stringify(payload));
        await writeFile(requestPath, JSON.stringify(request));
    };
    for (const edit of [
        (page) => { page.slots.pop(); },
        (page) => { page.slots.push({ id: "workflow.phases" }); },
        (page) => { page.title = "../escape"; },
        (page) => { page.assets[1].hash = "0".repeat(64); },
        (page) => { page.assets[2].kind = "script"; },
        (page) => {
            const bytes = Buffer.from('{"schemaVersion":1,"id":"workflow-phases","adapter":"wrong"}');
            page.assets[1].content = bytes.toString("base64");
            page.assets[1].hash = digest(bytes);
        },
        (page) => {
            const bytes = Buffer.from("export function mount( {");
            page.assets[2].content = bytes.toString("base64");
            page.assets[2].hash = digest(bytes);
        },
    ]) {
        await rewrite((request) => edit(request.workflowPage));
        await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
            /Invalid frozen Workflow page assets|Frozen Workflow page definition|Invalid frozen phase control/);
        await assert.rejects(readFile(join(sdk, "extension.mjs")), { code: "ENOENT" });
    }
    await rewrite((request) => {
        const bytes = Buffer.from(JSON.stringify({
            schemaVersion: 1, id: "workflow-phases", adapter: "generated-phase-adapter",
            placement: { page: "workflow", slot: "workflow.missing" },
        }));
        request.workflowPage.assets[1].content = bytes.toString("base64");
        request.workflowPage.assets[1].hash = digest(bytes);
    });
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /Invalid frozen phase control definition/);
    await rewrite((request) => { request.workflowPage.managedRun = true; });
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /Frozen phase control capabilities differ from its adapter/);
    const replacement = await readFile(new URL(
        "../../spec-kit-presets/copilot-vertical-phase-control/generated/phase-adapter.mjs", import.meta.url));
    const presetPath = join(project, ".specify", "templates", "generated-phase-adapter.mjs");
    await writeFile(presetPath, replacement);
    const presetModel = { ...model, workflowPage: { ...model.workflowPage, managedRun: true },
        templates: model.templates.map((entry) =>
        entry.name === "generated-phase-adapter"
            ? { ...entry, sourceId: "copilot-vertical-phase-control", hash: digest(replacement) }
            : entry) };
    const frozen = await freezeGeneration({ model: presetModel, values, handoff, project, workspace });
    await rm(presetPath);
    await materialize(project, workspace, handoff.handoffId, frozen.requestId);
    assert.deepEqual(await readFile(join(sdk, "pages", "generated-phase-adapter.mjs")), replacement);
    const { readConfig, renderHtml: renderPackaged } = await import(pathToFileURL(join(sdk, "server.mjs")).href);
    assert.equal(readConfig().workflowPage.hash, digest(replacement));
    assert.equal(readConfig().workflowPage.managedRun, true);
    assert.equal(readConfig().workflowPage.phaseControl, "generated-phase-control");
    assert.deepEqual(await readdir(join(sdk, "pages")), [
        "generated-phase-adapter.mjs", "phase-control.json", "workflow.json",
    ]);
    assert.match(renderPackaged(readConfig()), /data-module="\/pages\/generated-phase-adapter.mjs"/);
    await writeFile(join(sdk, "pages", "phase-control.json"), '{"schemaVersion":1,"id":"workflow-phases","adapter":"wrong"}');
    assert.throws(() => readConfig(), /phase control/);
    await writeFile(join(sdk, "pages", "phase-control.json"),
        Buffer.from(original.workflowPage.assets[1].content, "base64"));
    await writeFile(join(sdk, "pages", "generated-phase-adapter.mjs"), "export function mount() {}");
    assert.throws(() => readConfig(), /phase control|Invalid generated canvas/);
});

test("generation accepts a frozen, indented multiline single-quoted capability array", async (t) => {
    const { project, workspace, prepared, sdk } = await fixture(t);
    const requestPath = join(workspace, "speckit-canvas-designer", "handoffs",
        handoff.handoffId, "generations", prepared.requestId, "request.json");
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    const bytes = Buffer.from(`export const controlId = "workflow-phases";
export const contractVersion = 1;
  export const requiredCapabilities = [
    'workflow.rows.v1',
    'workflow.managed-run.v1',
  ];
export function mount() {}`);
    request.workflowPage.managedRun = true;
    request.workflowPage.assets[2].content = bytes.toString("base64");
    request.workflowPage.assets[2].hash = createHash("sha256").update(bytes).digest("hex");
    const { integrity: _old, ...payload } = request;
    request.integrity = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    await writeFile(requestPath, JSON.stringify(request));
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const { readConfig } = await import(pathToFileURL(join(sdk, "server.mjs")).href);
    assert.equal(readConfig().workflowPage.managedRun, true);
});

test("additional Workflow slots do not reorder the fixed shell", async (t) => {
    const { project, workspace, prepared, sdk } = await fixture(t);
    const requestPath = join(workspace, "speckit-canvas-designer", "handoffs",
        handoff.handoffId, "generations", prepared.requestId, "request.json");
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    const slots = [...request.workflowPage.slots, { id: "workflow.extra" }];
    request.workflowPage.slots = slots;
    const definition = JSON.parse(Buffer.from(request.workflowPage.assets[0].content, "base64"));
    definition.slots = slots;
    const bytes = Buffer.from(JSON.stringify(definition));
    request.workflowPage.assets[0].content = bytes.toString("base64");
    request.workflowPage.assets[0].hash = createHash("sha256").update(bytes).digest("hex");
    const { integrity: _old, ...payload } = request;
    request.integrity = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    await writeFile(requestPath, JSON.stringify(request));
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const { readConfig, renderHtml: renderPackaged } = await import(
        pathToFileURL(join(sdk, "server.mjs")).href);
    const html = renderPackaged(readConfig());
    assert.ok(html.indexOf('id="instance-collection"') < html.indexOf('id="workflow-pipeline"'));
});

test("registered Workflow field placements are packaged and reject unknown slots", async (t) => {
    const { project, workspace, prepared, sdk } = await fixture(t);
    const path = join(workspace, "speckit-canvas-designer", "handoffs",
        handoff.handoffId, "generations", prepared.requestId, "request.json");
    const original = JSON.parse(await readFile(path, "utf8"));
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const bytes = Buffer.from(JSON.stringify({
        schemaVersion: 1, id: "workflow-description-placement", page: "workflow",
        slot: "workflow.summary", field: "canvas.description", order: 10,
    }));
    const request = structuredClone(original);
    request.workflowPage.slots.push({ id: "workflow.summary" });
    const page = JSON.parse(Buffer.from(request.workflowPage.assets[0].content, "base64"));
    page.slots = request.workflowPage.slots;
    const pageBytes = Buffer.from(JSON.stringify(page));
    request.workflowPage.assets[0].content = pageBytes.toString("base64");
    request.workflowPage.assets[0].hash = digest(pageBytes);
    request.fieldPlacements = [{
        id: "workflow-description-placement", page: "workflow", slot: "workflow.summary",
        field: "canvas.description", order: 10, label: "Description", control: "stock.text",
        assets: [{ kind: "generated.field-placement", name: "workflow-description-placement",
            sourceId: "test-preset", content: bytes.toString("base64"), hash: digest(bytes) }],
    }];
    request.designerFields = [{ id: "canvas.description", label: "Description", control: "stock.text" }];
    const writeRequest = async () => {
        const { integrity: _previous, ...payload } = request;
        request.integrity = digest(JSON.stringify(payload));
        await writeFile(path, JSON.stringify(request));
    };
    await writeRequest();
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const { readConfig, renderHtml: renderPackaged } = await import(pathToFileURL(join(sdk, "server.mjs")).href);
    assert.equal(readConfig().fieldPlacements[0].field, "canvas.description");
    assert.match(renderPackaged(readConfig()), /data-workflow-slot="workflow.summary"/);
    assert.deepEqual(await readFile(join(sdk, "pages", "workflow-description-placement.json")), bytes);
    request.fieldPlacements[0].slot = "workflow.unknown";
    await writeRequest();
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /frozen generated.field-placement|Invalid generated field placement/i);
});

test("field placement IDs cannot overwrite fixed page assets before target creation", async (t) => {
    const { project, workspace, prepared, sdk } = await fixture(t);
    const path = join(workspace, "speckit-canvas-designer", "handoffs",
        handoff.handoffId, "generations", prepared.requestId, "request.json");
    const original = JSON.parse(await readFile(path, "utf8"));
    const digest = (content) => createHash("sha256").update(content).digest("hex");
    for (const [id, error] of [
        ["phase-control", /Invalid generated field placement: phase-control/],
    ]) {
        const request = structuredClone(original);
        request.workflowPage.slots.push({ id: "workflow.summary" });
        const page = JSON.parse(Buffer.from(request.workflowPage.assets[0].content, "base64"));
        page.slots = request.workflowPage.slots;
        const pageBytes = JSON.stringify(page);
        request.workflowPage.assets[0].content = Buffer.from(pageBytes).toString("base64");
        request.workflowPage.assets[0].hash = digest(pageBytes);
        const placement = JSON.stringify({
            schemaVersion: 1, id, page: "workflow", slot: "workflow.summary",
            field: "canvas.description", order: 10,
        });
        request.fieldPlacements = [{
            id, page: "workflow", slot: "workflow.summary", field: "canvas.description",
            order: 10, label: "Description", control: "stock.text",
            assets: [{ kind: "generated.field-placement", name: id, sourceId: "test-preset",
                content: Buffer.from(placement).toString("base64"), hash: digest(placement) }],
        }];
        request.designerFields = [{ id: "canvas.description", label: "Description", control: "stock.text" }];
        const { integrity: _previous, ...payload } = request;
        request.integrity = digest(JSON.stringify(payload));
        await writeFile(path, JSON.stringify(request));
        await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId), error);
        await assert.rejects(readdir(sdk), { code: "ENOENT" });
    }
});

test("frozen named values reject tampered modules and package independently of their preset", async (t) => {
    const { project, workspace, prepared, sdk } = await fixture(t);
    const requestPath = join(workspace, "speckit-canvas-designer", "handoffs",
        handoff.handoffId, "generations", prepared.requestId, "request.json");
    const original = JSON.parse(await readFile(requestPath, "utf8"));
    const preset = new URL("../../spec-kit-presets/copilot-canvas-values-test/", import.meta.url);
    const sourceId = "copilot-canvas-values-test";
    const asset = async (name, kind, file) => {
        const content = await readFile(new URL(file, preset));
        return { name, kind, sourceId, hash: createHash("sha256").update(content).digest("hex"),
            content: content.toString("base64") };
    };
    const definitions = [
        ["heading", "canvas-value-heading"],
        ["enabled", "canvas-value-enabled"],
        ["choice", "canvas-value-choice"],
        ["note", "canvas-value-note"],
        ["workflow", "canvas-value-workflow"],
        ["processing", "canvas-value-processing"],
    ];
    const valueSources = await Promise.all(definitions.map(async ([file, name]) => {
        const definition = JSON.parse(await readFile(new URL(`values/${file}.json`, preset)));
        const assets = [await asset(name, "generated.value-definition", `values/${file}.json`)];
        if (definition.source.kind === "computed") {
            assets.push(await asset(definition.source.module, "generated.computed-value-provider", "values/workflow.mjs"));
        }
        const { schemaVersion: _version, ...source } = definition;
        return { ...source, assets };
    }));
    const page = JSON.parse(await readFile(new URL("generated/pages/values.json", preset)));
    const request = { ...original, valueSources, generatedPages: [{
        id: page.id, title: page.title, renderer: page.renderer, values: page.values,
        assets: [
            await asset(page.id, "generated.added-page-definition", "generated/pages/values.json"),
            await asset(page.renderer, "generated.added-page-renderer", "generated/pages/values.mjs"),
        ],
    }] };
    const persist = async (candidate) => {
        const { integrity: _old, ...payload } = candidate;
        await writeFile(requestPath, JSON.stringify({ ...payload,
            integrity: createHash("sha256").update(JSON.stringify(payload)).digest("hex") }));
    };
    for (const name of ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"]) {
        assert.equal(designerDeviceName(name), true);
        assert.equal(runtimeDeviceName(name), true);
        const invalid = structuredClone(request);
        invalid.valueSources.find((entry) => entry.id === "demo.workflow").source.module = name;
        await persist(invalid);
        await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
            /Invalid frozen value source registration/);
        await assert.rejects(readFile(join(sdk, "extension.mjs")), { code: "ENOENT" });
    }
    for (const name of ["com0", "com10", "lpt0", "lpt10", "con-1"]) {
        assert.equal(designerDeviceName(name), false);
        assert.equal(runtimeDeviceName(name), false);
    }
    const tampered = structuredClone(request);
    tampered.valueSources.find((entry) => entry.id === "demo.workflow").assets[1].hash = "0".repeat(64);
    await persist(tampered);
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /Invalid frozen value source asset/);
    await assert.rejects(readFile(join(sdk, "extension.mjs")), { code: "ENOENT" });
    const provider = valueSources.find((entry) => entry.id === "demo.workflow").assets[1];
    const providerSource = await readFile(new URL("values/workflow.mjs", preset), "utf8");
    const oversized = structuredClone(request);
    const oversizedBytes = Buffer.from(providerSource.padEnd(32 * 1024 + 1, " "));
    oversized.valueSources.find((entry) => entry.id === "demo.workflow").assets[1] = {
        ...provider, hash: createHash("sha256").update(oversizedBytes).digest("hex"),
        content: oversizedBytes.toString("base64"),
    };
    await persist(oversized);
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /Invalid frozen value source asset/);
    await assert.rejects(readFile(join(sdk, "extension.mjs")), { code: "ENOENT" });
    const unregistered = structuredClone(request);
    unregistered.generatedPages[0].values = ["demo.missing"];
    await persist(unregistered);
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /Invalid frozen generated page assets|Invalid frozen generated pages|invalid frozen generated page definition/);
    await assert.rejects(readFile(join(sdk, "extension.mjs")), { code: "ENOENT" });
    const boundary = structuredClone(request);
    const boundaryBytes = Buffer.from(providerSource.padEnd(32 * 1024, " "));
    boundary.valueSources.find((entry) => entry.id === "demo.workflow").assets[1] = {
        ...provider, hash: createHash("sha256").update(boundaryBytes).digest("hex"),
        content: boundaryBytes.toString("base64"),
    };
    await persist(boundary);
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const { readConfig } = await import(pathToFileURL(join(sdk, "server.mjs")).href);
    const config = readConfig();
    for (const name of ["con", "com1", "lpt9"]) {
        const invalid = structuredClone(config);
        invalid.valueSources.find((entry) => entry.id === "demo.workflow").source.module = name;
        await writeFile(join(sdk, "canvas-config.json"), JSON.stringify(invalid));
        assert.throws(readConfig, /Invalid value provider/);
    }
    await writeFile(join(sdk, "canvas-config.json"), JSON.stringify(config));
    assert.equal(config.valueSources.length, definitions.length);
    assert.deepEqual(config.generatedPages[0].values, ["demo.processing"]);
    assert.equal(config.valueSources.find((entry) => entry.id === "demo.note").presentation, "stock.editable");
    assert.deepEqual(await readFile(join(sdk, "providers", "canvas-value-workflow-provider.mjs")),
        boundaryBytes);
    const portable = join(workspace, "portable-values");
    const { cp } = await import("node:fs/promises");
    await cp(sdk, portable, { recursive: true });
    const { readConfig: readPortableConfig } = await import(pathToFileURL(join(portable, "server.mjs")).href);
    assert.deepEqual(readPortableConfig().valueSources, config.valueSources);
});

test("Essentials keeps Workflow header separate from the default-off custom slug toggle", async () => {
    const page = JSON.parse(await readFile(new URL("../extension-canvas-design/designer-host/tabs/essentials.json", import.meta.url)));
    assert.deepEqual(page.fields.map((entry) => entry.id), ["canvas.id", "canvas.displayName"]);
    const heading = JSON.parse(await readFile(new URL("../extension-canvas-design/designer-host/essentials-settings/workflow-heading.json", import.meta.url)));
    const slug = JSON.parse(await readFile(new URL("../extension-canvas-design/designer-host/essentials-settings/custom-slug.json", import.meta.url)));
    assert.deepEqual(slug.field, {
        id: "workflowSlug.userProvided", type: "boolean", control: "stock.checkbox", default: false, label: "Allow custom slug",
        description: "Lets users specify the slug used as the directory name for generated artifacts. Otherwise, Spec Kit chooses a default.",
    });
    assert.equal(heading.field.label, "Workflow header");
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
        assert.match(html, /id="workflow-pipeline" data-module="\/pages\/generated-phase-adapter.mjs"/);
        assert.doesNotMatch(html, /id="phase-card"|id="phase-args"|phase-template-/);
        assert.match(collection, /id="workflow-name-label">Workflow name <span class="muted">\(optional\)<\/span>/);
        assert.doesNotMatch(collection, /workflow-name-help|workflow-slug-help/);
        if (enabled) {
            assert.ok(collection.indexOf('id="workflow-slug"') > collection.indexOf('id="workflow-name"'));
            assert.match(collection, /id="workflow-slug-label">Artifact directory slug <span class="muted">\(optional\)<\/span>/);
            assert.match(collection, /id="workflow-slug"[^>]+placeholder="your-slug"/);
        } else assert.doesNotMatch(html, /id="workflow-slug"/);
        const ui = await readFile(new URL("../extension-canvas-design/generated-scaffold/ui/app.js", import.meta.url), "utf8");
        assert.match(ui, /input\.placeholder = input\.readOnly \? "Automatically assigned" : "your-slug"/);
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

    const hosted = { ...handoff, canvasDesign: {
        version: "0.1.18", downloadUrl: "https://example.org/extension-canvas-design.zip",
    } };
    hosted.sourceFingerprint = createHash("sha256").update(JSON.stringify({
        workflow: hosted.workflow, selections: hosted.selections,
        canvasDesign: hosted.canvasDesign,
    })).digest("hex");
    const another = await fixture(t, hosted);
    const result = await materialize(another.project, another.workspace,
        hosted.handoffId, another.prepared.requestId);
    assert.deepEqual(result.warnings, []);

    const drifted = await fixture(t, hosted);
    const path = join(drifted.workspace, "speckit-canvas-designer", "handoffs",
        hosted.handoffId, "handoff.json");
    await writeFile(path, JSON.stringify({ ...hosted,
        selections: { ...hosted.selections, presets: [{ id: "changed" }] } }));
    const warned = await materialize(drifted.project, drifted.workspace,
        hosted.handoffId, drifted.prepared.requestId);
    assert.match(warned.warnings[0], /fingerprint differs/);
    assert.equal(warned.canvasId, "my-workflow");
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

test("generator rejects inconsistent all-page values and stock defaults before writing", async (t) => {
    const { project, workspace, prepared, sdk } = await fixture(t);
    const path = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId,
        "generations", prepared.requestId, "request.json");
    const original = JSON.parse(await readFile(path, "utf8"));
    const failures = [
        (request) => { request.values["other.page"] = "unexpected"; },
        (request) => { delete request.values["canvas.displayName"]; },
        (request) => { request.values["workflowSlug.userProvided"] = "true"; },
        (request) => { request.values["canvas.description"] = "x".repeat(241); },
        (request) => { request.canvas.description = "not the frozen value"; },
        (request) => { request.fieldConstraints["canvas.description"].type = "object"; },
        (request) => { request.fieldConstraints["canvas.id"].pattern = "^(a+)+$"; },
        (request) => { delete request.fieldConstraints["canvas.id"].pattern; },
        (request) => { request.fieldConstraints["canvas.description"].pattern = "^(a+)+$"; },
    ];
    for (const change of failures) {
        const request = structuredClone(original);
        change(request);
        const { integrity: _old, ...payload } = request;
        request.integrity = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
        await writeFile(path, JSON.stringify(request));
        await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
            /Invalid frozen Designer field|Invalid frozen Designer fields|Invalid frozen canvas identity/);
        await assert.rejects(readFile(join(sdk, "extension.mjs")), { code: "ENOENT" });
    }
});

test("generation request and Wizard handoff reject symlinks and oversized files", async (t) => {
    for (const [name, limit] of [["request.json", 4 * 1024 * 1024], ["handoff.json", 64 * 1024]]) {
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
        ["request.json", 4 * 1024 * 1024, "Generation request"],
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
