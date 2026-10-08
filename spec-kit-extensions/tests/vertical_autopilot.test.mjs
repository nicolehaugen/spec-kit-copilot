import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

test("vertical control directs Stop to the child chat without offering a parent Stop button", async () => {
    const { mount } = await import(new URL(
        "../../spec-kit-presets/copilot-vertical-phase-control/generated/phase-adapter.mjs", import.meta.url));
    const root = { innerHTML: "", ownerDocument: { activeElement: null },
        contains: () => false, addEventListener: () => {}, removeEventListener: () => {},
        replaceChildren: () => {} };
    const action = () => {};
    const actions = { select: action, draft: action, runAt: action, viewAt: action,
        reveal: action, startManagedRun: action, stopManagedRun: action, error: action };
    const state = { phases: [{ id: "specify", label: "Specify", output: "specs/demo/spec.md" }],
        current: 0, workflow: "specs/demo", status: null, draft: "", output: null,
        outputLinks: [], sending: false, statuses: {}, autopilot: {
            item: "specs/demo", status: "Running", current: 0, message: "Running" } };
    const control = mount({ root, definition: { id: "workflow-phases", viewLabels: {} },
        state, actions });
    assert.match(root.innerHTML, /Stop in its child session Copilot chat/);
    assert.doesNotMatch(root.innerHTML, /data-action="stop"/);
    assert.match(root.innerHTML, /disabled title="This workflow is already running in its child session"/);
    control.update({ ...state, workflow: "specs/other" });
    assert.doesNotMatch(root.innerHTML, /Stop in its child session Copilot chat/);
    control.dispose();
});

async function setup(t, phaseDialogs = []) {
    const root = join(tmpdir(), `vertical-autopilot-${randomUUID()}`);
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = join(root, "generated");
    const project = join(root, "project");
    await mkdir(join(project, ".specify", "memory"), { recursive: true });
    await writeFile(join(project, ".specify", "memory", "constitution.md"), "Shared principles");
    await cp(new URL("../extension-canvas-design/generated-scaffold/", import.meta.url),
        target, { recursive: true });
    await mkdir(join(target, "pages"), { recursive: true });
    const adapter = await readFile(new URL(
        "../../spec-kit-presets/copilot-vertical-phase-control/generated/phase-adapter.mjs",
        import.meta.url));
    await writeFile(join(target, "pages", "generated-phase-adapter.mjs"), adapter);
    for (const skill of ["specify", "plan"]) {
        const folder = join(project, ".github", "skills", `speckit-${skill}`);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "SKILL.md"), `---\nname: speckit-${skill}\n---\n`);
    }
    const id = randomUUID();
    const projectId = "vertical-test";
    const children = new Map();
    const messages = [];
    let serial = 0;
    const session = {
        sessionId: id,
        log: async () => {},
        on: () => () => {},
        rpc: {
            skills: { reload: async () => ({ errors: [] }) },
            mode: { get: async () => { throw new Error("Parent mode must not change"); } },
            tools: { execute: async ({ name, arguments: input }) => {
                if (name === "get_session") {
                    const child = children.get(input.project_session_id);
                    return { resultType: "success", textResultForLlm: JSON.stringify(child
                        ? { id: input.project_session_id, project_id: projectId,
                            session_type: "worktree", path: child.path, name: child.name }
                        : { id, project_id: projectId, path: project, branch: "main" }) };
                }
                if (name === "create_session") {
                    const childId = randomUUID();
                    const path = join(root, `child-${++serial}`);
                    await mkdir(path, { recursive: true });
                    children.set(childId, { path, name: input.name });
                    return { resultType: "success",
                        textResultForLlm: `Created session '${input.name}' (id: ${childId}) in project 'Test'` };
                }
                if (name === "send_session_message") {
                    messages.push(input);
                    return { resultType: "success", textResultForLlm: "Message accepted" };
                }
                throw new Error(`Unexpected tool: ${name}`);
            } },
        },
    };
    const config = {
        canvas: { id: "vertical-test" }, phases: ["specify", "plan"],
        phaseOutputs: { specify: { expectsArtifact: true, outputPath: "specs/<slug>/spec.md" },
            plan: { expectsArtifact: true, outputPath: "specs/<slug>/plan.md" } },
        ...(phaseDialogs.length ? { phaseDialogs } : {}),
        workflowPage: { adapter: "generated-phase-adapter", managedRun: true,
            hash: createHash("sha256").update(adapter).digest("hex") },
    };
    const { createRuntime } = await import(pathToFileURL(join(target, "runtime.mjs")).href);
    const options = { config, cwd: project, workspace: root, session };
    let runtime = await createRuntime(options);
    t.after(() => runtime.close());
    const stateFile = join(root, "generated-canvases",
        createHash("sha256").update(JSON.stringify([project, config.canvas.id])).digest("hex"), "state.json");
    const saved = async () => JSON.parse(await readFile(stateFile, "utf8"));
    const report = async (run, status, extra = {}) =>
        runtime.reportChild({ runId: run.runId, token: run.token, status, ...extra });
    const startNew = async () => {
        const { id: itemId } = await runtime.createPending({ revision: (await runtime.snapshot()).revision });
        await runtime.save({ revision: (await runtime.snapshot()).revision, slug: `demo-${serial + 1}` });
        return { itemId, ...await runtime.startAutopilot({ itemId }, "panel") };
    };
    return { target, project, children, messages, session, config, saved, report, startNew,
        get runtime() { return runtime; },
        restart: async () => {
            runtime.close();
            runtime = await createRuntime(options);
            return runtime;
        } };
}

test("dialog-bound phases reject a child launch without changing the parent session", async (t) => {
    const f = await setup(t, [{ phase: "speckit.plan", dialog: "confirm-plan" }]);
    const { id } = await f.runtime.createPending({ revision: (await f.runtime.snapshot()).revision });
    await assert.rejects(f.runtime.startAutopilot({ itemId: id }, "panel"),
        /confirmation.*manually/i);
    assert.equal(f.children.size, 0);
    assert.equal(f.messages.length, 0);
});

test("ordered Autopilot phases use one child and validate actual artifacts", async (t) => {
    const f = await setup(t);
    const { autopilotId } = await f.startNew();
    const runs = (await f.saved()).runs.filter((run) => run.autopilotId === autopilotId);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].childId, runs[1].childId);
    assert.equal(f.children.size, 1);
    await assert.rejects(f.report(runs[1], "start"), /configured order/);
    await f.report(runs[0], "start");
    await assert.rejects(f.report(runs[0], "start"), /cannot be started again|already started/);
    await mkdir(join(runs[0].childPath, "specs", "demo-1"), { recursive: true });
    await assert.rejects(f.report(runs[0], "complete", { slug: "demo-1", artifacts: [] }),
        /Required artifact/);
    await writeFile(join(runs[0].childPath, "specs", "demo-1", "spec.md"), "Specification");
    await f.report(runs[0], "complete",
        { slug: "demo-1", artifacts: ["specs/demo-1/spec.md"] });
    await f.report(runs[1], "start");
    await writeFile(join(runs[1].childPath, "specs", "demo-1", "plan.md"), "Plan");
    await f.report(runs[1], "complete", { artifacts: ["specs/demo-1/plan.md"] });
    assert.equal((await f.saved()).autopilots.find((entry) => entry.id === autopilotId).status, "Completed");
    assert.equal((await f.runtime.artifact({ phase: "plan", itemId: "specs/demo-1" })).content, "Plan");
    assert.match(f.messages[0].message, /Run this Canvas Design workflow/);
});

test("different workflows run concurrently, but a duplicate start cannot reuse a busy child", async (t) => {
    const f = await setup(t);
    const first = await f.startNew();
    const { id: independent } = await f.runtime.createPending({
        revision: (await f.runtime.snapshot()).revision });
    assert.equal((await f.runtime.snapshot()).autopilot, null,
        "another workflow must not inherit the first workflow's active toolbar");
    await f.runtime.removePending({ itemId: independent,
        revision: (await f.runtime.snapshot()).revision });
    const second = await f.startNew();
    const saved = await f.saved();
    assert.notEqual(saved.runs.find((entry) => entry.autopilotId === first.autopilotId).childId,
        saved.runs.find((entry) => entry.autopilotId === second.autopilotId).childId);
    await assert.rejects(f.runtime.startAutopilot({ itemId: first.itemId }, "panel"),
        /already running|busy|active/i);
    assert.equal(f.children.size, 2);
    assert.equal(saved.autopilots.length, 2);
    await assert.rejects(f.runtime.stopAutopilot({}), /child session Copilot chat/);
});

test("a child failure blocks only that workflow; restart retains independent checkpoints", async (t) => {
    const f = await setup(t);
    const first = await f.startNew();
    const second = await f.startNew();
    const runs = (await f.saved()).runs;
    const failed = runs.find((run) => run.autopilotId === first.autopilotId);
    await f.report(failed, "start");
    await f.report(failed, "fail", { error: "Missing requirements" });
    await f.restart();
    const saved = await f.saved();
    assert.equal(saved.autopilots.find((entry) => entry.id === first.autopilotId).status, "Blocked");
    assert.equal(saved.autopilots.find((entry) => entry.id === second.autopilotId).status,
        "Request sent");
    assert.equal(saved.runs.find((entry) => entry.runId === failed.runId).status, "Failed");
    await assert.rejects(f.report(failed, "complete", { artifacts: [] }), /no longer active|Start the child step/);
});

test("managed run never imports the packaged browser adapter into its server", async (t) => {
    const f = await setup(t);
    const file = join(f.target, "pages", "generated-phase-adapter.mjs");
    const module = Buffer.concat([await readFile(file), Buffer.from("\nglobalThis.__serverAdapterExecuted = true;\n")]);
    await writeFile(file, module);
    f.config.workflowPage.hash = createHash("sha256").update(module).digest("hex");
    await f.restart();
    await f.startNew();
    assert.equal(globalThis.__serverAdapterExecuted, undefined);
});
