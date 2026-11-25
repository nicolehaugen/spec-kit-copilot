import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { phaseContract } from "../extensions/bugfix-canvas/contract.mjs";
import { validatePhaseAdapter, validateWorkflowAdapter, validateWorkflowPageState } from
    "../extensions/bugfix-canvas/contracts/external-host-adapter.mjs";
import * as phaseAdapter from "../extensions/bugfix-canvas/pages/generated-phase-adapter.mjs";
import * as workflowAdapter from "../extensions/bugfix-canvas/pages/generated-workflow-page-adapter.mjs";
import { createRuntime } from "../extensions/bugfix-canvas/runtime.mjs";
import { readConfig } from "../extensions/bugfix-canvas/server.mjs";
import { createSetup, validateRuntimeSetup } from "../extensions/bugfix-canvas/setup.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const canvasRoot = fileURLToPath(new URL("../extensions/bugfix-canvas/", import.meta.url));
const locator = { installedId: "bug", source: "default", catalogId: "bug", downloadUrl: null };

async function setupHarness(t, initialInventory) {
    const cwd = await mkdtemp(join(repoRoot, ".bugfix-canvas-test-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const config = readConfig();
    const phases = phaseContract(config);
    await mkdir(join(cwd, ".specify"), { recursive: true });
    for (const skill of new Set(["speckit-specify", ...phases.map((phase) => phase.skill)])) {
        const directory = join(cwd, ".github", "skills", skill);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "SKILL.md"), `---\nname: ${skill}\n---\n`);
    }

    let inventory = initialInventory;
    const calls = [], sent = [];
    const command = async (_exe, args) => {
        calls.push(args);
        if (args.join(" ") === "--version") return { stdout: "specify 1.4.2\n" };
        if (args.join(" ") === "extension list --json") return { stdout: JSON.stringify(inventory) };
        throw new Error(`Unexpected Specify command: ${args.join(" ")}`);
    };
    const session = {
        send: async ({ prompt }) => { sent.push(prompt); return "setup-message"; },
        getEvents: async () => [],
        rpc: { skills: { reload: async () => ({ errors: [] }) } },
    };
    return {
        setup: createSetup({ config, cwd, session, phases, command }),
        calls,
        sent,
        setInventory: (value) => { inventory = value; },
    };
}

test("imported configuration preserves the portable recipe and workflow artifacts", () => {
    const config = readConfig();
    assert.equal(config.canvas.id, "bugfix-canvas");
    assert.deepEqual(config.runtimeSetup, {
        presets: [],
        extensions: [{ id: "bug", version: "1.0.2", enabled: true, priority: 10, locator }],
        bundles: [],
    });
    assert.deepEqual(phaseContract(config).map(({ id, outputs }) => ({ id, outputs })), [
        { id: "speckit.bug.assess", outputs: [".specify/bugs/<slug>/assessment.md"] },
        { id: "speckit.bug.fix", outputs: [".specify/bugs/<slug>/fix.md"] },
        { id: "speckit.bug.test", outputs: [".specify/bugs/<slug>/test.md"] },
    ]);
    assert.equal(validateRuntimeSetup(config.runtimeSetup), true);
    const incompatible = structuredClone(config.runtimeSetup);
    delete incompatible.extensions[0].locator.catalogId;
    assert.equal(validateRuntimeSetup(incompatible), false);
});

test("setup accepts the matching bundled package and reviews an incompatible version", async (t) => {
    const installed = { id: "bug", version: "1.0.2", enabled: true, priority: 10,
        source: { kind: "local" } };
    const h = await setupHarness(t, [installed]);
    assert.equal((await h.setup.probe()).ready, true);
    assert.deepEqual(h.sent, []);

    h.setInventory([{ ...installed, version: "1.0.3" }]);
    const checked = await h.setup.probe();
    assert.equal(checked.ready, false);
    assert.equal(checked.pending[0].version, "1.0.2");
    const plan = await h.setup.start({});
    assert.equal(plan.stage, "awaiting-confirmation");
    assert.deepEqual(plan.pending[0].locator, locator);
    assert.deepEqual(h.sent, []);

    assert.equal((await h.setup.confirm({ planId: plan.planId, confirmed: true })).stage, "installing");
    const batch = JSON.parse(h.sent[0].split("Confirmed batch: ")[1]);
    assert.equal(batch[0].version, "1.0.2");
    assert.deepEqual(batch[0].locator, locator);
    assert.ok(h.calls.every((args) =>
        ["--version", "extension list --json"].includes(args.join(" "))));
});

test("imported adapters accept the host contract and reject incompatible exchanges", () => {
    assert.doesNotThrow(() => validateWorkflowAdapter(workflowAdapter));
    assert.equal(validatePhaseAdapter(phaseAdapter), phaseAdapter.mount);
    assert.throws(() => validateWorkflowAdapter({ ...workflowAdapter, contractVersion: 2 }),
        /Incompatible Workflow page adapter/);
    assert.throws(() => validatePhaseAdapter({ ...phaseAdapter, requiredCapabilities: ["unknown"] }),
        /unavailable host capabilities/);

    const state = { model: { userProvidesSlug: true, items: [] }, phaseState: { slugEditable: true } };
    assert.equal(validateWorkflowPageState(state), state);
    assert.throws(() => validateWorkflowPageState({
        ...state, phaseState: { slugEditable: false },
    }), /slug settings disagree/);
});

test("phase reporting binds the actual bug directory and rejects incompatible reports", async (t) => {
    const cwd = await mkdtemp(join(repoRoot, ".bugfix-canvas-test-"));
    let runtime;
    t.after(async () => {
        runtime?.close();
        await rm(cwd, { recursive: true, force: true });
    });
    const workspace = join(cwd, "session");
    const skill = join(cwd, ".github", "skills", "speckit-bug-assess");
    await mkdir(workspace);
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: speckit-bug-assess\n---\n");
    const sent = [];
    runtime = await createRuntime({
        config: { ...readConfig(), runtimeSetup: undefined, showSetup: false },
        cwd,
        workspace,
        session: {
            sessionId: "test-session",
            send: async ({ prompt }) => { sent.push(prompt); return "phase-message"; },
            on: () => () => {},
            getEvents: async () => [],
            log: async () => {},
            rpc: { skills: { reload: async () => ({ errors: [] }) } },
        },
    });
    const { runId } = await runtime.run({
        phase: "speckit.bug.assess", args: "A bug", slug: "example",
    }, "panel");
    assert.match(sent[0], /report_workflow_slug/);
    await assert.rejects(runtime.reportSlug({ phaseRunId: runId, slug: "001-example" }, "panel"),
        /does not exist yet/);
    const directory = join(cwd, ".specify", "bugs", "001-example");
    await mkdir(directory, { recursive: true });
    const resolved = await runtime.reportSlug({ phaseRunId: runId, slug: "001-example" }, "panel");
    assert.equal(resolved.phases[0].outputs[0], ".specify/bugs/001-example/assessment.md");
    await assert.rejects(runtime.report({
        phaseRunId: runId, path: ".specify/bugs/001-example/fix.md",
    }, "panel"), /another declared phase output/);
    await writeFile(join(directory, "assessment.md"), "# Assessment\n");
    await assert.rejects(runtime.report({
        phaseRunId: runId, path: ".specify/bugs/001-example/assessment.md",
    }, "other-panel"), /Unknown or stale/);
    assert.deepEqual(await runtime.report({
        phaseRunId: runId, path: ".specify/bugs/001-example/assessment.md",
    }, "panel"), { accepted: true });
});

test("Git filters preserve the bytes of packaged contributions", async () => {
    for (const directory of ["pages", "buttons", "dialogs", "controls", "badges", "assets"]) {
        for (const entry of await readdir(join(canvasRoot, directory), { withFileTypes: true })) {
            assert.equal(entry.isFile(), true);
            const file = join(canvasRoot, directory, entry.name);
            const indexPath = relative(repoRoot, file).split(sep).join("/");
            const git = (...args) => {
                const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true });
                assert.equal(result.status, 0, result.stderr || result.error?.message);
                return result.stdout.trim();
            };
            assert.equal(
                git("-c", "core.autocrlf=true", "hash-object", `--path=${indexPath}`, file),
                git("hash-object", "--no-filters", file),
                `${indexPath} would be changed by Git filters`,
            );
        }
    }
});
