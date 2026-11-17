import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createWorkflowRoutes, readConfig, renderHtml } from "../extensions/bugfix-canvas/server.mjs";
import { phaseContract } from "../extensions/bugfix-canvas/contract.mjs";
import { evaluateBadges, verifyBadgeModules } from "../extensions/bugfix-canvas/badge-runtime.mjs";
import { createRuntime } from "../extensions/bugfix-canvas/runtime.mjs";
import { createSetup, validateRuntimeSetup } from "../extensions/bugfix-canvas/setup.mjs";
import { validatePhaseAdapter, validateWorkflowAdapter } from
    "../extensions/bugfix-canvas/contracts/external-host-adapter.mjs";
import * as phaseAdapter from "../extensions/bugfix-canvas/pages/generated-phase-adapter.mjs";
import * as workflowAdapter from "../extensions/bugfix-canvas/pages/generated-workflow-page-adapter.mjs";

test("packaged host accepts its adapters and rejects incompatible exchanges", () => {
    const config = readConfig();
    assert.match(renderHtml(config), /Bug Fix Triage Pipeline/);
    assert.doesNotThrow(() => validateWorkflowAdapter(workflowAdapter));
    assert.equal(validatePhaseAdapter(phaseAdapter), phaseAdapter.mount);
    assert.throws(() => validateWorkflowAdapter({ ...workflowAdapter, contractVersion: 2 }),
        /Incompatible Workflow page adapter/);
    assert.throws(() => validatePhaseAdapter({ ...phaseAdapter, requiredCapabilities: ["unknown"] }),
        /unavailable host capabilities/);
    assert.equal(validateRuntimeSetup(config.runtimeSetup), true);
    assert.deepEqual(config.runtimeSetup.presets.map(({ id }) => id), ["copilot-sub-agents"]);
    assert.deepEqual(config.installed.presets.map(({ id }) => id), ["copilot-sub-agents"]);
    const incompatible = structuredClone(config.runtimeSetup);
    incompatible.extensions[0].locator = { installedId: "bug", source: "local" };
    assert.equal(validateRuntimeSetup(incompatible), false);
    for (const entry of [...config.runtimeSetup.extensions, ...config.runtimeSetup.presets]) {
        assert.notEqual(entry.locator.source, "local");
        assert.equal(Object.hasOwn(entry.locator, "path"), false);
    }
});

test("Git preserves frozen contribution bytes with automatic line-ending conversion", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "bugfix-git-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, ".gitattributes"),
        await readFile(new URL("../../../.gitattributes", import.meta.url)));
    execFileSync("git", ["init", "--quiet", root]);
    const repository = fileURLToPath(new URL("../../../", import.meta.url));
    const canvas = fileURLToPath(new URL("../extensions/bugfix-canvas/", import.meta.url));
    const hash = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    for (const folder of ["badges", "buttons", "controls", "dialogs", "pages"]) {
        for (const entry of await readdir(join(canvas, folder), { withFileTypes: true })) {
            if (!entry.isFile() || !/\.(?:mjs|json)$/.test(entry.name)) continue;
            const file = join(canvas, folder, entry.name);
            const gitPath = relative(repository, file).split(sep).join("/");
            assert.equal(hash(["-c", "core.autocrlf=true", "hash-object",
                `--path=${gitPath}`, file]),
            hash(["hash-object", "--no-filters", file]), `Git rewrites ${folder}/${entry.name}`);
        }
    }
});

test("setup reviews portable packages and checks installed versions", async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "bugfix-setup-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, ".specify"), { recursive: true });
    const config = readConfig();
    const phases = phaseContract(config);
    for (const skill of ["speckit-specify", ...phases.map((phase) => phase.skill)]) {
        const directory = join(cwd, ".github", "skills", skill);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "SKILL.md"), `---\nname: ${skill}\n---\n`);
    }

    let installed = false, cliVersion = "1.0.6", bugVersion = "1.0.0", reloads = 0;
    const events = [], sent = [], approved = [];
    const session = {
        send: async ({ prompt }) => { sent.push(prompt); return `setup-message-${sent.length}`; },
        getEvents: async () => events,
        rpc: { skills: { reload: async () => { reloads++; return { errors: [] }; } } },
    };
    const command = async (_exe, args) => {
        if (args[0] === "--version") return { stdout: `specify ${cliVersion}` };
        assert.ok(["extension", "preset"].includes(args[0]));
        assert.deepEqual(args.slice(1), ["list", "--json"]);
        const entry = args[0] === "extension"
            ? { id: "bug", version: bugVersion, priority: 10 }
            : { id: "copilot-sub-agents", version: "1.0.0", priority: 1 };
        return { stdout: JSON.stringify(installed
            ? [{ ...entry, enabled: true, source: { kind: "local" } }] : []) };
    };
    const setup = createSetup({ config, cwd, session, phases, command,
        approvedSources: () => approved,
        saveApprovedSources: async (receipts) => { approved.push(...receipts); } });

    const complete = (index) => events.push(
        { type: "user.message", data: { messageId: `setup-message-${index}`, interactionId: `interaction-${index}` } },
        { type: "assistant.turn_start", data: { interactionId: `interaction-${index}`, turnId: `turn-${index}` } },
        { type: "assistant.message", data: {
            interactionId: `interaction-${index}`, turnId: `turn-${index}`, content: "Done.", phase: "final",
        } },
        { type: "assistant.turn_end", data: { interactionId: `interaction-${index}`, turnId: `turn-${index}` } },
    );
    for (const [version, ready] of [["1.0.6", false], ["1.0.7", true], ["1.1.0", true], ["2.0.0", true]]) {
        cliVersion = version;
        assert.equal((await setup.probe()).cliReady, ready);
    }
    cliVersion = "1.0.6";
    assert.equal((await setup.status({ fresh: true })).checks.cli, "Update required");
    assert.equal((await setup.start({})).stage, "initializing");
    assert.match(sent[0], /\/speckit-self/);
    assert.match(sent[0], />=1\.0\.7/);
    cliVersion = "1.0.7";
    complete(1);
    const review = await setup.status();
    assert.equal(review.stage, "awaiting-confirmation");
    assert.deepEqual(review.pending.map(({ id }) => id), ["bug", "copilot-sub-agents"]);
    assert.equal(review.pending[0].locator.source, "default");
    assert.match(review.pending[1].locator.downloadUrl, /^https:\/\//);
    await assert.rejects(setup.confirm({ planId: "stale", confirmed: true }), /changed/);
    assert.equal(sent.length, 1);
    assert.equal((await setup.confirm({ planId: review.planId, confirmed: true })).stage, "installing");
    assert.match(sent[1], /"id":"bug"/);
    assert.match(sent[1], /copilot-sub-agents-v1\.0\.0/);

    installed = true;
    complete(2);
    assert.equal((await setup.status()).ready, true);
    assert.equal(reloads, 1);
    bugVersion = "2.0.0";
    assert.equal((await setup.status({ fresh: true })).ready, false);
    assert.deepEqual((await setup.start({})).pending.map(({ id }) => id), ["bug"]);
});

test("SDK entry registers and opens the packaged canvas", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "bugfix-entry-"));
    const canvasDir = join(root, "canvas"), project = join(root, "project");
    const workspace = join(root, "workspace");
    await cp(new URL("../extensions/bugfix-canvas/", import.meta.url), canvasDir, { recursive: true });
    await mkdir(project);
    await mkdir(workspace);
    const sdk = join(canvasDir, "node_modules", "@github", "copilot-sdk");
    await mkdir(sdk, { recursive: true });
    await writeFile(join(sdk, "package.json"), JSON.stringify({
        name: "@github/copilot-sdk", type: "module", exports: { "./extension": "./extension.mjs" },
    }));
    await writeFile(join(sdk, "extension.mjs"), `
        export const createCanvas = (options) => options;
        export async function joinSession({ canvases }) {
            globalThis.__bugfixCanvas = canvases[0];
            return { sessionId: "test-session", workspacePath: ${JSON.stringify(workspace)},
                rpc: { metadata: { snapshot: async () => ({ workingDirectory: ${JSON.stringify(project)} }) } },
                on: () => () => {}, getEvents: async () => [], log: async () => {} };
        }
    `);
    let canvas;
    t.after(async () => {
        delete globalThis.__bugfixCanvas;
        if (canvas) await canvas.onClose({ instanceId: "test-panel" });
        await rm(root, { recursive: true, force: true });
    });
    await import(pathToFileURL(join(canvasDir, "extension.mjs")).href);
    canvas = globalThis.__bugfixCanvas;
    assert.equal(canvas.id, "bugfix-canvas");
    assert.deepEqual(canvas.actions.map(({ name }) => name), [
        "run_phase", "report_workflow_slug", "report_phase_artifact", "report_autopilot_step",
    ]);
    const opened = await canvas.open({ instanceId: "test-panel" });
    assert.match(await (await fetch(opened.url)).text(), /Bug Fix Triage Pipeline/);
    const report = canvas.actions.find(({ name }) => name === "report_phase_artifact");
    await assert.rejects(() => report.handler({ instanceId: "test-panel",
        input: { phaseRunId: "missing", path: ".specify/bugs/demo/fix.md" } }),
    /Unknown or stale phase reporting request/);
});

test("packaged canvas serves the bug workflow and rejects untrusted requests", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "bugfix-canvas-"));
    const cwd = join(root, "project"), workspace = join(root, "workspace");
    const directory = join(cwd, ".specify", "bugs", "demo");
    await mkdir(directory, { recursive: true });
    await mkdir(workspace);
    await writeFile(join(directory, "assessment.md"), "- **Verdict**: valid\n");
    await writeFile(join(directory, "fix.md"), "- **Status**: applied\n");
    const config = readConfig();
    const session = { sessionId: "test-session", on: () => () => {},
        getEvents: async () => [], log: async () => {} };
    const runtime = await createRuntime({ config, cwd, workspace, session });
    let server;
    const routes = createWorkflowRoutes(config, {
        runtime, instanceId: "test-panel", token: "test-token", port: () => server.address().port,
    });
    server = createServer((request, response) => {
        void routes.handle(request, response).catch((error) => response.destroy(error));
    });
    t.after(async () => {
        routes.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        runtime.close();
        await rm(root, { recursive: true, force: true });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${url}/`)).status, 401);
    const html = await fetch(`${url}/?token=test-token`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Bug Fix Triage Pipeline/);
    assert.equal((await fetch(`${url}/pages/generated-phase-adapter.mjs?token=test-token`)).status, 200);
    const response = await fetch(`${url}/api/state?token=test-token`);
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.ok(snapshot.items.some(({ id }) => id === ".specify/bugs/demo"));
    assert.equal(snapshot.badges.items[".specify/bugs/demo"]
        .find(({ category }) => category === "Fix")?.text, "Applied");
    const params = new URLSearchParams({ token: "test-token", phase: "speckit.bug.fix",
        itemId: ".specify/bugs/demo" });
    const artifact = await fetch(`${url}/api/artifact?${params}`);
    assert.equal(artifact.status, 200);
    assert.match((await artifact.json()).content, /\*\*Status\*\*: applied/);
    const rejected = await fetch(`${url}/api/workflow/new?token=test-token`, {
        method: "POST", headers: { "content-type": "application/json", origin: "http://example.test" },
        body: "{}",
    });
    assert.equal(rejected.status, 403);
});

test("Fix badge reads the fix artifact, not the assessment", async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "bugfix-badges-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const directory = join(cwd, ".specify", "bugs", "demo");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "assessment.md"), "- **Verdict**: valid\n- **Status**: partial\n");
    const config = readConfig();
    const phases = phaseContract(config);
    await verifyBadgeModules(config.badges);
    const workflow = ".specify/bugs/demo";
    const evaluate = () => evaluateBadges(config.badges, {
        cwd, workflows: [workflow], phases, runFor: () => null,
        outputPath: async ({ output }) => output.replace("<slug>", "demo"),
    });
    assert.equal((await evaluate()).items[workflow].some(({ category }) => category === "Fix"), false);
    await writeFile(join(directory, "fix.md"), "- **Status**: applied\n");
    const badge = (await evaluate()).items[workflow].find(({ category }) => category === "Fix");
    assert.equal(badge?.text, "Applied");
});
