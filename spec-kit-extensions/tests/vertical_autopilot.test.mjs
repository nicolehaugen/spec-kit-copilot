import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

async function setup(t, vertical = true) {
    const root = await mkdtemp(join(tmpdir(), "vertical-autopilot-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = join(root, "generated");
    const project = join(root, "project");
    await cp(new URL("../extension-canvas-design/generated-scaffold/", import.meta.url),
        target, { recursive: true });
    await mkdir(join(target, "pages"), { recursive: true });
    const adapter = await readFile(new URL(vertical
        ? "../../spec-kit-presets/copilot-vertical-phase-control/generated/phase-adapter.mjs"
        : "../extension-canvas-design/generated-host/phase-control/generated-phase-adapter.mjs", import.meta.url));
    await writeFile(join(target, "pages", "generated-phase-adapter.mjs"), adapter);
    for (const skill of ["specify", "plan"]) {
        const folder = join(project, ".github", "skills", `speckit-${skill}`);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "SKILL.md"), `---\nname: speckit-${skill}\n---\n`);
    }
    const sent = [], callbacks = new Map();
    let events = [];
    const session = {
        sessionId: "test-session", rpc: { skills: { reload: async () => ({ errors: [] }) },
            mode: { get: async () => session.mode ?? "interactive",
                set: async ({ mode }) => { session.mode = mode; return { modeApplied: true }; } } },
        send: async (options) => { sent.push(options); return "message-1"; },
        abort: async () => { sent.push({ aborted: true }); },
        on: (name, listener) => { callbacks.set(name, listener); return () => callbacks.delete(name); },
        getEvents: async () => events, log: async () => {},
    };
    const { createRuntime } = await import(pathToFileURL(join(target, "runtime.mjs")).href);
    const stateFile = join(root, "generated-canvases",
        createHash("sha256").update(JSON.stringify([project, "test-autopilot"])).digest("hex"), "state.json");
    const options = { config: {
        canvas: { id: "test-autopilot" }, phases: ["specify", "plan"],
        phaseOutputs: { specify: { expectsArtifact: true, outputPath: "specs/<slug>/spec.md" },
            plan: { expectsArtifact: true, outputPath: "specs/<slug>/plan.md" } },
        workflowPage: { adapter: "generated-phase-adapter",
            hash: createHash("sha256").update(adapter).digest("hex") },
    }, cwd: project, workspace: root, session };
    let runtime = await createRuntime(options);
    t.after(() => runtime.close());
    return { get runtime() { return runtime; }, project, sent, session,
        restart: async () => {
            runtime.close();
            runtime = await createRuntime(options);
            return runtime;
        },
        finish: async (success) => {
            events = [
                { type: "user.message", data: { messageId: "message-1", interactionId: "turn-1" } },
                { type: "assistant.turn_start", data: { interactionId: "turn-1", turnId: "reply" } },
                { type: "assistant.turn_end", data: { turnId: "reply" } },
                { type: "session.task_complete", data: { success, summary: "Finished" } },
            ];
            callbacks.get("session.idle")();
            for (let count = 0; count < 200; count++) {
                // A snapshot started before reconciliation can project its stale run as Blocked.
                const saved = JSON.parse(await readFile(stateFile, "utf8"));
                if (["Completed", "Blocked"].includes(saved.autopilot.status)) {
                    assert.equal((await runtime.snapshot()).autopilot.status, saved.autopilot.status);
                    return saved.autopilot.status;
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error("Autopilot completion was not reconciled");
        } };
}

test("vertical Autopilot starts first, verifies each artifact and refuses skipped or repeated steps", async (t) => {
    const { runtime, project, sent, session, finish } = await setup(t);
    const { autopilotId } = await runtime.startAutopilot({ itemId: "__new__" }, "panel");
    assert.equal(sent[0].agentMode, "autopilot");
    assert.match(sent[0].prompt, /beginning with step 0/);
    await assert.rejects(runtime.reportAutopilotStep(
        { autopilotId, phase: "plan", action: "start" }, "panel"), /configured order/);
    const { phaseRunId } = await runtime.reportAutopilotStep(
        { autopilotId, phase: "specify", action: "start" }, "panel");
    await mkdir(join(project, "specs", "demo"), { recursive: true });
    await runtime.reportSlug({ phaseRunId, slug: "demo" }, "panel");
    await writeFile(join(project, "specs", "demo", "spec.md"), "Feature specification");
    await runtime.report({ phaseRunId, path: "specs/demo/spec.md" }, "panel");
    assert.equal((await runtime.reportAutopilotStep(
        { autopilotId, phase: "specify", action: "complete" }, "panel")).nextPhase, "plan");
    const next = await runtime.reportAutopilotStep(
        { autopilotId, phase: "plan", action: "start" }, "panel");
    assert.equal(next.itemId, "specs/demo");
    await writeFile(join(project, "specs", "demo", "plan.md"), "Plan");
    await runtime.report({ phaseRunId: next.phaseRunId, path: "specs/demo/plan.md" }, "panel");
    assert.equal((await runtime.reportAutopilotStep(
        { autopilotId, phase: "plan", action: "complete" }, "panel")).nextPhase, null);
    assert.equal((await runtime.snapshot()).autopilot.status, "Finishing");
    assert.equal(await finish(true), "Completed");
    assert.equal(session.mode, "interactive");
    await assert.rejects(runtime.reportAutopilotStep(
        { autopilotId, phase: "plan", action: "start" }, "panel"), /inactive/);
});

test("concurrent Autopilot reports cannot start twice or skip a step", async (t) => {
    const fixture = await setup(t);
    const { runtime, project } = fixture;
    await mkdir(join(project, "specs", "demo"), { recursive: true });
    await runtime.save({ revision: (await runtime.snapshot()).revision, selected: "specs/demo" });
    const { autopilotId } = await runtime.startAutopilot({ itemId: "specs/demo" }, "panel");
    const started = await Promise.allSettled([
        runtime.reportAutopilotStep({ autopilotId, phase: "specify", action: "start" }, "panel"),
        runtime.reportAutopilotStep({ autopilotId, phase: "specify", action: "start" }, "panel"),
    ]);
    assert.deepEqual(started.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    assert.match(started.find((result) => result.status === "rejected").reason.message, /already started/);
    const { phaseRunId } = started.find((result) => result.status === "fulfilled").value;
    await writeFile(join(project, "specs", "demo", "spec.md"), "Specification");
    await runtime.report({ phaseRunId, path: "specs/demo/spec.md" }, "panel");
    const completed = await Promise.allSettled([
        runtime.reportAutopilotStep({ autopilotId, phase: "specify", action: "complete" }, "panel"),
        runtime.reportAutopilotStep({ autopilotId, phase: "specify", action: "complete" }, "panel"),
    ]);
    assert.deepEqual(completed.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(completed.find((result) => result.status === "fulfilled").value.nextPhase, "plan");
    assert.equal((await runtime.snapshot()).autopilot.current, 1);
    assert.ok((await runtime.reportAutopilotStep(
        { autopilotId, phase: "plan", action: "start" }, "panel")).phaseRunId);
});

test("an active workflow cannot be deleted before a report or while finishing", async (t) => {
    const { runtime, project } = await setup(t);
    await mkdir(join(project, "specs", "demo"), { recursive: true });
    await runtime.save({ revision: (await runtime.snapshot()).revision, selected: "specs/demo" });
    const { autopilotId } = await runtime.startAutopilot({ itemId: "specs/demo" }, "panel");
    const deletion = async () => runtime.deleteWorkflow({
        itemId: "specs/demo", confirmation: "demo", revision: (await runtime.snapshot()).revision,
    });
    await assert.rejects(deletion(), /Stop Autopilot/);
    const first = await runtime.reportAutopilotStep(
        { autopilotId, phase: "specify", action: "start" }, "panel");
    await writeFile(join(project, "specs", "demo", "spec.md"), "Specification");
    await runtime.report({ phaseRunId: first.phaseRunId, path: "specs/demo/spec.md" }, "panel");
    await runtime.reportAutopilotStep({ autopilotId, phase: "specify", action: "complete" }, "panel");
    const second = await runtime.reportAutopilotStep(
        { autopilotId, phase: "plan", action: "start" }, "panel");
    await writeFile(join(project, "specs", "demo", "plan.md"), "Plan");
    await runtime.report({ phaseRunId: second.phaseRunId, path: "specs/demo/plan.md" }, "panel");
    await runtime.reportAutopilotStep({ autopilotId, phase: "plan", action: "complete" }, "panel");
    assert.equal((await runtime.snapshot()).autopilot.status, "Finishing");
    await assert.rejects(deletion(), /Stop Autopilot/);
});

test("deletion waits for Autopilot preflight before touching its workflow", async (t) => {
    const { runtime, project, session } = await setup(t);
    await mkdir(join(project, "specs", "demo"), { recursive: true });
    let release, entered;
    const waiting = new Promise((resolve) => { release = resolve; });
    const ready = new Promise((resolve) => { entered = resolve; });
    session.rpc.skills.reload = async () => { entered(); await waiting; return { errors: [] }; };
    const starting = runtime.startAutopilot({ itemId: "specs/demo" }, "panel");
    try {
        await ready;
        await assert.rejects(runtime.deleteWorkflow({
            itemId: "specs/demo", confirmation: "demo", revision: (await runtime.snapshot()).revision,
        }), /operation is in progress/);
    } finally {
        release();
    }
    await starting;
});

test("restart persists an interrupted checkpoint and retry restores the original mode", async (t) => {
    const fixture = await setup(t);
    const { project, sent, session } = fixture;
    await mkdir(join(project, "specs", "demo"), { recursive: true });
    let runtime = fixture.runtime;
    await runtime.save({ revision: (await runtime.snapshot()).revision, selected: "specs/demo" });
    const { autopilotId } = await runtime.startAutopilot({ itemId: "specs/demo" }, "panel");
    const { phaseRunId } = await runtime.reportAutopilotStep(
        { autopilotId, phase: "specify", action: "start" }, "panel");
    await writeFile(join(project, "specs", "demo", "spec.md"), "Specification");
    await runtime.report({ phaseRunId, path: "specs/demo/spec.md" }, "panel");
    await runtime.reportAutopilotStep({ autopilotId, phase: "specify", action: "complete" }, "panel");
    runtime = await fixture.restart();
    assert.equal((await runtime.snapshot()).autopilot.status, "Blocked");
    runtime = await fixture.restart();
    assert.equal((await runtime.snapshot()).autopilot.current, 1);
    const retried = await runtime.startAutopilot({ itemId: "specs/demo" }, "panel");
    assert.match(sent[1].prompt, /beginning with step 1/);
    assert.equal(session.mode, "autopilot");
    const next = await runtime.reportAutopilotStep(
        { autopilotId: retried.autopilotId, phase: "plan", action: "start" }, "panel");
    await writeFile(join(project, "specs", "demo", "plan.md"), "Plan");
    await runtime.report({ phaseRunId: next.phaseRunId, path: "specs/demo/plan.md" }, "panel");
    await runtime.reportAutopilotStep(
        { autopilotId: retried.autopilotId, phase: "plan", action: "complete" }, "panel");
    assert.equal(await fixture.finish(true), "Completed");
    assert.equal(session.mode, "interactive");
});

test("restart after the last verified step does not replay it", async (t) => {
    const fixture = await setup(t);
    const { project, sent } = fixture;
    await mkdir(join(project, "specs", "demo"), { recursive: true });
    let runtime = fixture.runtime;
    await runtime.save({ revision: (await runtime.snapshot()).revision, selected: "specs/demo" });
    const { autopilotId } = await runtime.startAutopilot({ itemId: "specs/demo" }, "panel");
    for (const [phase, filename] of [["specify", "spec.md"], ["plan", "plan.md"]]) {
        const { phaseRunId } = await runtime.reportAutopilotStep(
            { autopilotId, phase, action: "start" }, "panel");
        await writeFile(join(project, "specs", "demo", filename), phase);
        await runtime.report({ phaseRunId, path: `specs/demo/${filename}` }, "panel");
        await runtime.reportAutopilotStep({ autopilotId, phase, action: "complete" }, "panel");
    }
    runtime = await fixture.restart();
    assert.equal((await runtime.snapshot()).autopilot.status, "Blocked");
    await assert.rejects(runtime.startAutopilot({ itemId: "specs/demo" }, "panel"), /no step remains to retry/);
    assert.equal(sent.length, 1);
});

test("Autopilot can be stopped without an automatic replay and stock adapters cannot opt in", async (t) => {
    const { runtime, sent } = await setup(t);
    const { autopilotId } = await runtime.startAutopilot({ itemId: "__new__" }, "panel");
    await runtime.reportAutopilotStep({ autopilotId, phase: "specify", action: "start" }, "panel");
    assert.equal((await runtime.stopAutopilot({}, "panel")).stopped, true);
    assert.deepEqual(sent.at(-1), { aborted: true });
    assert.equal((await runtime.snapshot()).autopilot.status, "Paused");
    await assert.rejects(runtime.reportAutopilotStep(
        { autopilotId, phase: "specify", action: "complete" }, "panel"), /inactive/);
    const stock = await setup(t, false);
    await assert.rejects(stock.runtime.startAutopilot({ itemId: "__new__" }, "panel"),
        /does not provide Autopilot/);
});

test("an incomplete Copilot response blocks automatic progression and requires an explicit restart", async (t) => {
    const { runtime, sent, finish } = await setup(t);
    const { autopilotId } = await runtime.startAutopilot({ itemId: "__new__" }, "panel");
    await runtime.reportAutopilotStep({ autopilotId, phase: "specify", action: "start" }, "panel");
    assert.equal(await finish(false), "Blocked");
    await assert.rejects(runtime.reportAutopilotStep(
        { autopilotId, phase: "plan", action: "start" }, "panel"), /inactive/);
    assert.equal(sent.length, 1);
    await runtime.startAutopilot({ itemId: "__new__" }, "panel");
    assert.equal(sent.length, 2);
    assert.match(sent[1].prompt, /beginning with step 0/);
});

test("a missing required artifact blocks the step rather than advancing", async (t) => {
    const { runtime, project } = await setup(t);
    const { autopilotId } = await runtime.startAutopilot({ itemId: "__new__" }, "panel");
    const { phaseRunId } = await runtime.reportAutopilotStep(
        { autopilotId, phase: "specify", action: "start" }, "panel");
    await mkdir(join(project, "specs", "demo"), { recursive: true });
    await runtime.reportSlug({ phaseRunId, slug: "demo" }, "panel");
    await assert.rejects(runtime.reportAutopilotStep(
        { autopilotId, phase: "specify", action: "complete" }, "panel"), /required artifact/);
    assert.equal((await runtime.snapshot()).autopilot.status, "Blocked");
    await assert.rejects(runtime.reportAutopilotStep(
        { autopilotId, phase: "plan", action: "start" }, "panel"), /inactive/);
});
