import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

async function setup(t, vertical = true, phaseDialogs = [], userProvidesSlug = true) {
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
    const sent = [], callbacks = new Map(), diagnostics = [];
    let events = [];
    const session = {
        sessionId: "test-session", rpc: { skills: { reload: async () => ({ errors: [] }) },
            mode: { get: async () => session.mode ?? "interactive",
                set: async ({ mode }) => { session.mode = mode; return { modeApplied: true }; } } },
        send: async (options) => { sent.push(options); return "message-1"; },
        abort: async () => { sent.push({ aborted: true }); },
        on: (name, listener) => { callbacks.set(name, listener); return () => callbacks.delete(name); },
        getEvents: async () => events, log: async (message) => { diagnostics.push(message); },
    };
    const { createRuntime } = await import(pathToFileURL(join(target, "runtime.mjs")).href);
    const stateFile = join(root, "generated-canvases",
        createHash("sha256").update(JSON.stringify([project, "test-autopilot"])).digest("hex"), "state.json");
    const options = { config: {
        canvas: { id: "test-autopilot" }, userProvidesSlug, phases: ["specify", "plan"],
        phaseOutputs: { specify: { expectsArtifact: true, outputPath: "specs/<slug>/spec.md" },
            plan: { expectsArtifact: true, outputPath: "specs/<slug>/plan.md" } },
        ...(phaseDialogs.length ? { phaseDialogs } : {}),
        workflowPage: { adapter: "generated-phase-adapter",
            hash: createHash("sha256").update(adapter).digest("hex"), managedRun: vertical },
    }, cwd: project, workspace: root, session };
    let runtime = await createRuntime(options);
    t.after(() => runtime.close());
    return { get runtime() { return runtime; }, project, sent, session, diagnostics, stateFile, target, options,
        restart: async () => {
            runtime.close();
            runtime = await createRuntime(options);
            return runtime;
        },
        setEvents: (value) => { events = value; },
        idle: () => callbacks.get("session.idle")(),
        active: () => callbacks.get("tool.execution_start")(),
        finish: async (success) => {
            events = [
                { type: "user.message", data: { messageId: "message-1", interactionId: "turn-1" } },
                { type: "assistant.turn_start", data: { interactionId: "turn-1", turnId: "reply" } },
                { type: "assistant.turn_end", data: { turnId: "reply" } },
                { type: "session.task_complete", data: { success, summary: "Finished" } },
            ];
            callbacks.get("session.idle")();
            const expected = success ? "Completed" : "Blocked";
            for (let count = 0; count < 600; count++) {
                if ((await runtime.snapshot()).autopilot.status === expected) {
                    const saved = JSON.parse(await readFile(stateFile, "utf8"));
                    if (saved.autopilot.status === expected) return expected;
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error("Autopilot completion was not reconciled");
        } };
}

for (const status of ["Request sent", "Running", "Unconfirmed", "Run output unconfirmed"]) {
test(`restart recovers message-less ${status} only after idle and retains folder checks`, async (t) => {
    const fixture = await setup(t);
    const itemId = await prepareNewWorkflow(fixture.runtime);
    const saved = JSON.parse(await readFile(fixture.stateFile, "utf8"));
    saved.runs = [{ runId: "interrupted", before: [], item: itemId,
        phase: "specify", sessionId: "test-session", instanceId: "panel", args: "",
        status, artifact: null, messageId: null }];
    await writeFile(fixture.stateFile, JSON.stringify(saved));
    const runtime = await fixture.restart();
    let snapshot = await runtime.snapshot();
    assert.equal(snapshot.items.find((row) => row.id === itemId).status, "Unconfirmed");
    const discard = () => runtime.removePending({ itemId,
        revision: snapshot.revision, confirmation: "discard" });
    await assert.rejects(discard(), /agent turn has not ended/);
    fixture.idle();
    fixture.active();
    await assert.rejects(discard(), /agent turn has not ended/);
    fixture.idle();
    await mkdir(join(fixture.project, "specs", "001-demo"), { recursive: true });
    await assert.rejects(discard(), /workflow directory appeared/);
    await rm(join(fixture.project, "specs", "001-demo"), { recursive: true });
    snapshot = await runtime.snapshot();
    await discard();
    assert.equal((await runtime.snapshot()).items.some((row) => row.id === itemId), false);
});
}

test("interrupted dispatch recovery does not announce again on repeated state reads", async (t) => {
    const fixture = await setup(t);
    const itemId = await prepareNewWorkflow(fixture.runtime);
    const saved = JSON.parse(await readFile(fixture.stateFile, "utf8"));
    saved.runs = [{ runId: "interrupted", before: [], item: itemId,
        phase: "specify", sessionId: "test-session", instanceId: "panel", args: "",
        status: "Unconfirmed", artifact: null, messageId: null }];
    await writeFile(fixture.stateFile, JSON.stringify(saved));
    let announcements = 0;
    fixture.options.notify = () => { announcements++; };
    const runtime = await fixture.restart();
    await runtime.snapshot();
    assert.equal(announcements, 1);
    const recovered = await readFile(fixture.stateFile, "utf8");
    for (let index = 0; index < 5; index++) await runtime.snapshot();
    assert.equal(announcements, 1);
    assert.equal(await readFile(fixture.stateFile, "utf8"), recovered);
    fixture.idle();
    const snapshot = await runtime.snapshot();
    await runtime.removePending({ itemId, revision: snapshot.revision, confirmation: "discard" });
    const afterDiscard = announcements;
    for (let index = 0; index < 5; index++) await runtime.snapshot();
    assert.equal(announcements, afterDiscard);
});

test("restart leaves conclusive terminal message-less attempts unchanged", async (t) => {
    const fixture = await setup(t);
    const itemId = await prepareNewWorkflow(fixture.runtime);
    const saved = JSON.parse(await readFile(fixture.stateFile, "utf8"));
    saved.runs = ["Failed", "Completed"].map((status) => ({ runId: status,
        before: [], item: itemId, phase: "specify", sessionId: "test-session",
        instanceId: "panel", args: "", status, artifact: null, messageId: null,
        ...(status === "Completed" ? { confirmedSlug: true } : {}) }));
    await writeFile(fixture.stateFile, JSON.stringify(saved));
    await (await fixture.restart()).snapshot();
    assert.deepEqual(JSON.parse(await readFile(fixture.stateFile, "utf8")).runs
        .map((run) => run.status), ["Failed", "Completed"]);
});

test("Completed pending output without event history recovers after idle", async (t) => {
    const fixture = await setup(t);
    const itemId = await prepareNewWorkflow(fixture.runtime);
    const saved = JSON.parse(await readFile(fixture.stateFile, "utf8"));
    saved.runs = [{ runId: "missing-output", before: [], item: itemId,
        phase: "specify", sessionId: "test-session", instanceId: "panel", args: "",
        status: "Completed", artifact: null, messageId: "missing-message" }];
    await writeFile(fixture.stateFile, JSON.stringify(saved));
    const runtime = await fixture.restart();
    let snapshot = await runtime.snapshot();
    assert.equal(snapshot.items.find((row) => row.id === itemId).status, "Unconfirmed");
    await assert.rejects(runtime.removePending({ itemId, revision: snapshot.revision,
        confirmation: "discard" }), /agent turn has not ended/);
    fixture.idle();
    await runtime.refresh();
    snapshot = await runtime.snapshot();
    assert.equal(snapshot.items.find((row) => row.id === itemId).status, "Run output unconfirmed");
    await runtime.removePending({ itemId, revision: snapshot.revision, confirmation: "discard" });
});

test("a later active turn overrides an earlier ended turn for recovery and discard", async (t) => {
    const fixture = await setup(t);
    const itemId = await prepareNewWorkflow(fixture.runtime);
    const saved = JSON.parse(await readFile(fixture.stateFile, "utf8"));
    saved.runs = [{ runId: "retry-turn", before: [], item: itemId,
        phase: "specify", sessionId: "test-session", instanceId: "panel", args: "",
        status: "Running", artifact: null, messageId: "message" }];
    await writeFile(fixture.stateFile, JSON.stringify(saved));
    fixture.setEvents([
        { type: "user.message", data: { messageId: "message", interactionId: "run" } },
        { type: "assistant.turn_start", data: { interactionId: "run", turnId: "first" } },
        { type: "assistant.turn_end", data: { turnId: "first" } },
        { type: "assistant.turn_start", data: { interactionId: "run", turnId: "second" } },
    ]);
    const runtime = await fixture.restart();
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.items.find((row) => row.id === itemId).status, "Running");
    await assert.rejects(runtime.removePending({ itemId, revision: snapshot.revision,
        confirmation: "discard" }), /agent turn has not ended/);
});

test("restart reconnects a message-less dispatch to its exact prompt and live turn", async (t) => {
    const fixture = await setup(t);
    const itemId = await prepareNewWorkflow(fixture.runtime);
    const saved = JSON.parse(await readFile(fixture.stateFile, "utf8"));
    saved.runs = [{ runId: "interrupted", before: [], item: itemId,
        phase: "specify", sessionId: "test-session", instanceId: "panel", args: "",
        status: "Request sent", artifact: null, messageId: null }];
    await writeFile(fixture.stateFile, JSON.stringify(saved));
    fixture.setEvents([
        { type: "user.message", data: { messageId: "recovered", interactionId: "run",
            content: 'report with {phaseRunId:"interrupted"}' } },
        { type: "assistant.turn_start", data: { interactionId: "run", turnId: "turn" } },
    ]);
    const runtime = await fixture.restart();
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.items.find((row) => row.id === itemId).status, "Running");
    assert.equal(JSON.parse(await readFile(fixture.stateFile, "utf8")).runs[0].messageId, "recovered");
    await assert.rejects(runtime.removePending({ itemId, revision: snapshot.revision,
        confirmation: "discard" }), /agent turn has not ended/);
    fixture.idle();
    await runtime.refresh();
    const ended = await runtime.snapshot();
    assert.equal(ended.items.find((row) => row.id === itemId).status, "Run output unconfirmed");
    fixture.active();
    await assert.rejects(runtime.removePending({ itemId, revision: ended.revision,
        confirmation: "discard" }), /agent turn has not ended/);
    fixture.idle();
    await runtime.refresh();
    await runtime.removePending({ itemId, revision: (await runtime.snapshot()).revision,
        confirmation: "discard" });
});

test("many attempts share one verified directory inventory per snapshot", async (t) => {
    const fixture = await setup(t);
    const itemId = await prepareNewWorkflow(fixture.runtime);
    const saved = JSON.parse(await readFile(fixture.stateFile, "utf8"));
    saved.runs = Array.from({ length: 100 }, (_, index) => ({ runId: `attempt-${index}`,
        before: [], item: itemId, phase: "specify", sessionId: "test-session",
        instanceId: "panel", args: "", status: "Failed", artifact: null, messageId: null }));
    await mkdir(join(fixture.project, "specs", "001-demo"), { recursive: true });
    await writeFile(fixture.stateFile, JSON.stringify(saved));
    const file = join(fixture.target, "runtime.mjs");
    const source = await readFile(file, "utf8");
    await writeFile(file, source.replace("async function inspectDirectories() {",
        "async function inspectDirectories() { globalThis.inventoryScans++;"));
    const { createRuntime } = await import(pathToFileURL(file).href + "?inventory-test");
    globalThis.inventoryScans = 0;
    t.after(() => { delete globalThis.inventoryScans; });
    const runtime = await createRuntime(fixture.options);
    t.after(() => runtime.close());
    const snapshot = await runtime.snapshot();
    assert.equal(globalThis.inventoryScans, 1);
    assert.match(snapshot.items.find((row) => row.id === itemId).workflowRecoveryMessage,
        /specs\/001-demo/);
    await runtime.snapshot();
    assert.equal(globalThis.inventoryScans, 2);
});

test("pending recovery includes earlier attempts and unsafe checks after a retry", async (t) => {
    const fixture = await setup(t);
    const itemId = await prepareNewWorkflow(fixture.runtime);
    const saved = JSON.parse(await readFile(fixture.stateFile, "utf8"));
    const attempt = (runId, before) => ({ runId, before, item: itemId,
        phase: "specify", sessionId: "test-session", instanceId: "panel",
        args: "", status: "Failed", artifact: null, messageId: null, error: null });
    saved.runs = [
        attempt("first", []),
        attempt("second", []),
        attempt("retry", ["specs/001-demo"]),
    ];
    await mkdir(join(fixture.project, "specs", "001-demo"), { recursive: true });
    await writeFile(fixture.stateFile, JSON.stringify(saved));
    const runtime = await fixture.restart();
    const snapshot = await runtime.snapshot();
    const row = snapshot.items.find((entry) => entry.id === itemId);
    assert.equal(row.workflowRecoveryMessage,
        "New workflow directory: specs/001-demo. Select it in the workflow list to inspect it.");
    assert.equal(row.status, "Failed");
    await assert.rejects(runtime.removePending({ itemId, revision: snapshot.revision,
        confirmation: "discard" }), /A workflow directory appeared: specs\/001-demo/);

    saved.runs.splice(1, 0, attempt("unsafe", ["specs/invalid/path"]));
    await writeFile(fixture.stateFile, JSON.stringify(saved));
    const unsafe = await (await fixture.restart()).snapshot();
    const recovery = unsafe.items.find((entry) => entry.id === itemId).workflowRecoveryMessage;
    assert.match(recovery, /New workflow directory: specs\/001-demo/);
    assert.match(recovery, /cannot reliably check/);
    assert.equal(recovery.split("specs/001-demo").length - 1, 1);

    saved.runs = [attempt("first", []), attempt("retry", [])];
    await rm(join(fixture.project, "specs", "001-demo"), { recursive: true });
    await writeFile(fixture.stateFile, JSON.stringify(saved));
    const emptyRuntime = await fixture.restart();
    const empty = await emptyRuntime.snapshot();
    assert.equal(empty.items.find((entry) => entry.id === itemId).workflowRecoveryMessage, null);
    await emptyRuntime.removePending({ itemId, revision: empty.revision, confirmation: "discard" });
    assert.equal((await emptyRuntime.snapshot()).items.some((entry) => entry.id === itemId), false);
});

test("Autopilot refuses dialog-bound phases before dispatch or mode changes", async (t) => {
    const { runtime, sent, session } = await setup(t, true,
        [{ phase: "speckit.plan", dialog: "confirm-plan" }]);
    const itemId = await prepareNewWorkflow(runtime);
    await assert.rejects(runtime.startAutopilot({ itemId }, "panel"),
        (error) => error.status === 409 && /Plan.*requires confirmation.*manually/.test(error.message));
    assert.equal(sent.length, 0);
    assert.equal(session.mode, undefined);
    assert.equal((await runtime.snapshot()).autopilot, null);
});

async function prepareNewWorkflow(runtime) {
    const { id } = await runtime.createPending({ revision: (await runtime.snapshot()).revision });
    await runtime.save({ revision: (await runtime.snapshot()).revision, slug: "demo" });
    return id;
}

async function startNewAutopilot(runtime) {
    const itemId = await prepareNewWorkflow(runtime);
    return { ...await runtime.startAutopilot({ itemId }, "panel"), itemId };
}

test("vertical Autopilot starts first, verifies each artifact and refuses skipped or repeated steps", async (t) => {
    const { runtime, project, sent, session, finish } = await setup(t);
    const { autopilotId } = await startNewAutopilot(runtime);
    assert.equal(sent[0].agentMode, "autopilot");
    assert.match(sent[0].prompt, /beginning with step 0/);
    assert.match(sent[0].prompt, /Requested artifact folder name \(slug\): "demo"\./);
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

test("Autopilot omits an empty slug request in both custom and automatic modes", async (t) => {
    for (const enabled of [true, false]) {
        await t.test(enabled ? "custom slug left blank" : "automatic slug", async (child) => {
            const { runtime, sent } = await setup(child, true, [], enabled);
            const { id } = await runtime.createPending({ revision: (await runtime.snapshot()).revision });
            await runtime.startAutopilot({ itemId: id }, "panel");
            assert.doesNotMatch(sent[0].prompt, /Requested artifact folder name \(slug\):/);
            assert.match(sent[0].prompt, /report_workflow_slug \(new workflow only\)/);
            assert.match(sent[0].prompt, /For subsequent steps use the actual feature directory/);
        });
    }
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
    const { autopilotId } = await startNewAutopilot(runtime);
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
    const { autopilotId, itemId } = await startNewAutopilot(runtime);
    await runtime.reportAutopilotStep({ autopilotId, phase: "specify", action: "start" }, "panel");
    assert.equal(await finish(false), "Blocked");
    await assert.rejects(runtime.reportAutopilotStep(
        { autopilotId, phase: "plan", action: "start" }, "panel"), /inactive/);
    assert.equal(sent.length, 1);
    await runtime.startAutopilot({ itemId }, "panel");
    assert.equal(sent.length, 2);
    assert.match(sent[1].prompt, /beginning with step 0/);
});

test("Autopilot remains stoppable while viewing another workflow without projecting its step progress", async (t) => {
    const { runtime, project } = await setup(t);
    await mkdir(join(project, "specs", "alpha"), { recursive: true });
    await mkdir(join(project, "specs", "beta"), { recursive: true });
    await runtime.save({ revision: (await runtime.snapshot()).revision, selected: "specs/alpha" });
    const { autopilotId } = await runtime.startAutopilot({ itemId: "specs/alpha" }, "panel");
    await runtime.reportAutopilotStep({ autopilotId, phase: "specify", action: "start" }, "panel");
    await runtime.save({ revision: (await runtime.snapshot()).revision, selected: "specs/beta" });
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.autopilot.item, "specs/alpha");
    assert.equal(snapshot.autopilot.status, "Running");
    assert.equal(snapshot.statuses.specify.status, "Not run");
    await assert.rejects(runtime.reportAutopilotStep(
        { autopilotId, phase: "specify", action: "complete" }, "other-panel"), /inactive/);
    assert.equal((await runtime.stopAutopilot({}, "other-panel")).stopped, true);
    assert.equal((await runtime.snapshot()).autopilot.status, "Paused");
});

test("switching a blocked run cannot capture transient Autopilot as the previous mode", async (t) => {
    const { runtime, project, session, finish } = await setup(t);
    await mkdir(join(project, "specs", "alpha"), { recursive: true });
    await mkdir(join(project, "specs", "beta"), { recursive: true });
    await runtime.startAutopilot({ itemId: "specs/alpha" }, "panel");
    assert.equal(await finish(false), "Blocked");
    session.mode = "autopilot";
    await assert.rejects(runtime.startAutopilot({ itemId: "specs/beta" }, "panel"),
        /Stop the blocked Autopilot/);
    await runtime.startAutopilot({ itemId: "specs/alpha" }, "panel");
    assert.equal((await runtime.snapshot()).autopilot.previousMode, "interactive");
    await runtime.stopAutopilot({}, "panel");
    assert.equal(session.mode, "interactive");
    await runtime.startAutopilot({ itemId: "specs/beta" }, "panel");
    assert.equal((await runtime.snapshot()).autopilot.previousMode, "interactive");
});

test("completed Autopilot cannot seed another run with an unrestored session mode", async (t) => {
    const { runtime, project, session, sent, finish } = await setup(t);
    for (const name of ["alpha", "beta"]) {
        await mkdir(join(project, "specs", name), { recursive: true });
    }
    let restorationAttempt;
    const restoration = new Promise((resolve) => { restorationAttempt = resolve; });
    const setMode = session.rpc.mode.set;
    session.rpc.mode.set = async (input) => {
        if (input.mode === "interactive") {
            restorationAttempt();
            return { modeApplied: false };
        }
        return setMode(input);
    };
    const { autopilotId } = await runtime.startAutopilot({ itemId: "specs/alpha" }, "panel");
    for (const [phase, file] of [["specify", "spec.md"], ["plan", "plan.md"]]) {
        const { phaseRunId } = await runtime.reportAutopilotStep(
            { autopilotId, phase, action: "start" }, "panel");
        await writeFile(join(project, "specs", "alpha", file), phase);
        await runtime.report({ phaseRunId, path: `specs/alpha/${file}` }, "panel");
        await runtime.reportAutopilotStep({ autopilotId, phase, action: "complete" }, "panel");
    }
    assert.equal(await finish(true), "Completed");
    let timeout;
    try {
        await Promise.race([restoration, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Mode restoration was not attempted")), 5000);
        })]);
    } finally {
        clearTimeout(timeout);
    }
    assert.equal(session.mode, "autopilot");
    for (const itemId of ["specs/alpha", "specs/beta"]) {
        await assert.rejects(runtime.startAutopilot({ itemId }, "panel"),
            /Switch Copilot to interactive mode before starting another workflow/);
    }
    assert.equal(sent.length, 1);
    assert.equal((await runtime.snapshot()).autopilot.previousMode, "interactive");
    session.rpc.mode.set = setMode;
    session.mode = "interactive";
    await runtime.startAutopilot({ itemId: "specs/alpha" }, "panel");
    assert.equal((await runtime.snapshot()).autopilot.previousMode, "interactive");
    await runtime.stopAutopilot({}, "panel");
    await runtime.startAutopilot({ itemId: "specs/beta" }, "panel");
    assert.equal((await runtime.snapshot()).autopilot.previousMode, "interactive");
});

test("a stale Paused run requires mode recovery before a new start", async (t) => {
    const { runtime, project, session } = await setup(t);
    for (const name of ["alpha", "beta"]) {
        await mkdir(join(project, "specs", name), { recursive: true });
    }
    await runtime.startAutopilot({ itemId: "specs/alpha" }, "panel");
    await runtime.stopAutopilot({}, "panel");
    session.mode = "autopilot";
    for (const itemId of ["specs/alpha", "specs/beta"]) {
        await assert.rejects(runtime.startAutopilot({ itemId }, "panel"),
            /Switch Copilot to interactive mode before starting another workflow/);
    }
    assert.equal((await runtime.snapshot()).autopilot.status, "Paused");
    session.mode = "interactive";
    await runtime.startAutopilot({ itemId: "specs/beta" }, "panel");
    assert.equal((await runtime.snapshot()).autopilot.previousMode, "interactive");
});

test("an intentionally preexisting Autopilot mode remains the original mode", async (t) => {
    const { runtime, project, session } = await setup(t);
    for (const name of ["alpha", "beta"]) {
        await mkdir(join(project, "specs", name), { recursive: true });
    }
    session.mode = "autopilot";
    await runtime.startAutopilot({ itemId: "specs/alpha" }, "panel");
    assert.equal((await runtime.snapshot()).autopilot.previousMode, "autopilot");
    await runtime.stopAutopilot({}, "panel");
    assert.equal(session.mode, "autopilot");
    await runtime.startAutopilot({ itemId: "specs/beta" }, "panel");
    assert.equal((await runtime.snapshot()).autopilot.previousMode, "autopilot");
});

test("Stop cannot pause a run while Copilot remains in Autopilot mode", async (t) => {
    const { runtime, project, session, finish } = await setup(t);
    await mkdir(join(project, "specs", "alpha"), { recursive: true });
    await mkdir(join(project, "specs", "beta"), { recursive: true });
    await runtime.startAutopilot({ itemId: "specs/alpha" }, "panel");
    assert.equal(await finish(false), "Blocked");
    session.mode = "autopilot";
    const setMode = session.rpc.mode.set;
    session.rpc.mode.set = async (input) => input.mode === "interactive"
        ? { modeApplied: false } : setMode(input);
    session.log = async () => { throw new Error("Logger unavailable"); };
    await assert.rejects(runtime.stopAutopilot({}, "panel"),
        /Switch Copilot to interactive mode manually before starting another workflow/);
    assert.equal(session.mode, "autopilot");
    assert.equal((await runtime.snapshot()).autopilot.status, "Blocked");
    await assert.rejects(runtime.startAutopilot({ itemId: "specs/beta" }, "panel"),
        /Stop the blocked Autopilot/);
    session.rpc.mode.set = setMode;
    assert.equal((await runtime.stopAutopilot({}, "panel")).stopped, true);
    assert.equal(session.mode, "interactive");
    assert.equal((await runtime.snapshot()).autopilot.status, "Paused");
    await runtime.startAutopilot({ itemId: "specs/beta" }, "panel");
    assert.equal((await runtime.snapshot()).autopilot.previousMode, "interactive");
});

test("Stop accepts a concurrent mode change when restoration is unapplied", async (t) => {
    const { runtime, session } = await setup(t);
    await startNewAutopilot(runtime);
    const setMode = session.rpc.mode.set;
    session.rpc.mode.set = async (input) => {
        if (input.mode !== "interactive") return setMode(input);
        session.mode = "interactive";
        return { modeApplied: false };
    };
    session.log = async () => { throw new Error("Logger unavailable"); };
    assert.equal((await runtime.stopAutopilot({}, "panel")).stopped, true);
    assert.equal((await runtime.snapshot()).autopilot.status, "Paused");
    assert.equal(session.mode, "interactive");
});

test("a dispatched Blocked Autopilot cannot lose its pending row before Stop", async (t) => {
    const { runtime, session, stateFile } = await setup(t);
    const itemId = await prepareNewWorkflow(runtime);
    session.send = async () => "";
    await assert.rejects(runtime.startAutopilot({ itemId }, "panel"), /No Autopilot message ID/);
    assert.equal((await runtime.snapshot()).autopilot.status, "Blocked");
    assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).runs, []);
    await assert.rejects(runtime.removePending({
        itemId, revision: (await runtime.snapshot()).revision,
    }), /Stop Autopilot/);
    assert.equal((await runtime.stopAutopilot({})).stopped, true);
    await runtime.removePending({ itemId, revision: (await runtime.snapshot()).revision });
    assert.equal((await runtime.snapshot()).items.length, 0);
});

test("failed error persistence cannot skip mode restoration or dispatch cleanup", async (t) => {
    const fixture = await setup(t);
    const { runtime, session, stateFile, diagnostics } = fixture;
    const itemId = await prepareNewWorkflow(runtime);
    const directory = join(stateFile, "..");
    const backup = `${directory}-backup`;
    session.send = async () => {
        await rename(directory, backup);
        await writeFile(directory, "blocked");
        throw new Error("Dispatch failed");
    };
    await assert.rejects(runtime.startAutopilot({ itemId }, "panel"),
        /state could not be saved/);
    assert.equal(session.mode, "interactive");
    assert.ok(diagnostics.some((message) => /Could not persist the Autopilot dispatch outcome/.test(message)));
    await rm(directory);
    await rename(backup, directory);
    session.send = async () => "retry-message";
    assert.ok((await runtime.startAutopilot({ itemId }, "panel")).autopilotId);
});

test("failed persistence and mode restoration report both failures and manual recovery", async (t) => {
    const { runtime, session, stateFile, diagnostics } = await setup(t);
    const itemId = await prepareNewWorkflow(runtime);
    const directory = join(stateFile, "..");
    const backup = `${directory}-backup`;
    session.send = async () => {
        await rename(directory, backup);
        await writeFile(directory, "blocked");
        throw new Error("Dispatch failed");
    };
    const setMode = session.rpc.mode.set;
    session.rpc.mode.set = async (input) => {
        if (input.mode === "interactive") throw new Error("Mode service unavailable");
        return setMode(input);
    };
    await assert.rejects(runtime.startAutopilot({ itemId }, "panel"), (error) => {
        assert.match(error.message, /state could not be saved/);
        assert.match(error.message, /Mode restoration also failed: Mode service unavailable/);
        assert.match(error.message, /Switch Copilot to interactive mode manually before retrying/);
        return true;
    });
    assert.equal(session.mode, "autopilot");
    assert.ok(diagnostics.some((message) => /Could not persist the Autopilot dispatch outcome/.test(message)));
    assert.ok(diagnostics.some((message) => /Could not restore the Copilot session mode: Mode service unavailable/.test(message)));
    await rm(directory);
    await rename(backup, directory);
    session.rpc.mode.set = setMode;
    session.mode = "interactive";
    session.send = async () => "retry-message";
    assert.ok((await runtime.startAutopilot({ itemId }, "panel")).autopilotId);
});

test("failed mode restoration after saving Blocked state reports dispatch and recovery", async (t) => {
    const { runtime, session, diagnostics } = await setup(t);
    const itemId = await prepareNewWorkflow(runtime);
    session.send = async () => { throw new Error("Dispatch failed"); };
    const setMode = session.rpc.mode.set;
    session.rpc.mode.set = async (input) => {
        if (input.mode === "interactive") throw new Error("Mode service unavailable");
        return setMode(input);
    };
    await assert.rejects(runtime.startAutopilot({ itemId }, "panel"), (error) => {
        assert.match(error.message, /Autopilot failed: Dispatch failed/);
        assert.match(error.message, /Mode restoration also failed: Mode service unavailable/);
        assert.match(error.message, /Switch Copilot to interactive mode manually before retrying/);
        return true;
    });
    assert.equal(session.mode, "autopilot");
    assert.equal((await runtime.snapshot()).autopilot.status, "Blocked");
    assert.equal((await runtime.snapshot()).autopilot.error, "Dispatch failed");
    assert.ok(diagnostics.some((message) => /Could not restore the Copilot session mode: Mode service unavailable/.test(message)));
    session.rpc.mode.set = setMode;
    session.mode = "interactive";
    session.send = async () => "retry-message";
    assert.ok((await runtime.startAutopilot({ itemId }, "panel")).autopilotId);
});

test("an unapplied mode restoration cannot hide a session left in Autopilot", async (t) => {
    const { runtime, session, diagnostics } = await setup(t);
    const itemId = await prepareNewWorkflow(runtime);
    session.send = async () => { throw new Error("Dispatch failed"); };
    const setMode = session.rpc.mode.set;
    session.rpc.mode.set = async (input) => input.mode === "interactive"
        ? { modeApplied: false } : setMode(input);
    await assert.rejects(runtime.startAutopilot({ itemId }, "panel"), (error) => {
        assert.match(error.message, /Autopilot failed: Dispatch failed/);
        assert.match(error.message, /Mode restoration also failed: Copilot did not restore the previous mode/);
        assert.match(error.message, /Switch Copilot to interactive mode manually before retrying/);
        return true;
    });
    assert.equal(session.mode, "autopilot");
    assert.equal((await runtime.snapshot()).autopilot.status, "Blocked");
    assert.ok(diagnostics.some((message) => /Could not restore the Copilot session mode/.test(message)));
    session.rpc.mode.set = setMode;
    session.mode = "interactive";
    session.send = async () => "retry-message";
    assert.ok((await runtime.startAutopilot({ itemId }, "panel")).autopilotId);
});

test("an unapplied restoration does not report failure when mode already changed", async (t) => {
    const { runtime, session } = await setup(t);
    const itemId = await prepareNewWorkflow(runtime);
    session.send = async () => { throw new Error("Dispatch failed"); };
    const setMode = session.rpc.mode.set;
    session.rpc.mode.set = async (input) => {
        if (input.mode === "interactive") {
            session.mode = "interactive";
            return { modeApplied: false };
        }
        return setMode(input);
    };
    await assert.rejects(runtime.startAutopilot({ itemId }, "panel"),
        (error) => error.message === "Dispatch failed");
    assert.equal(session.mode, "interactive");
    assert.equal((await runtime.snapshot()).autopilot.status, "Blocked");
});

test("rejected cleanup logging preserves dispatch failures and recovery guidance", async (t) => {
    for (const { persistence, restore } of [
        { persistence: true, restore: false },
        { persistence: false, restore: true },
        { persistence: true, restore: true },
        { persistence: false, restore: "already changed" },
    ]) {
        await t.test(`persistence=${persistence}, restoration=${restore}`, async (t) => {
            const { runtime, session, stateFile } = await setup(t);
            const itemId = await prepareNewWorkflow(runtime);
            const directory = join(stateFile, "..");
            const backup = `${directory}-backup`;
            let logCalls = 0;
            session.log = async () => {
                logCalls++;
                throw new Error("Logger unavailable");
            };
            session.send = async () => {
                if (persistence) {
                    await rename(directory, backup);
                    await writeFile(directory, "blocked");
                }
                throw new Error("Dispatch failed");
            };
            const setMode = session.rpc.mode.set;
            if (restore) {
                session.rpc.mode.set = async (input) => {
                    if (input.mode !== "interactive") return setMode(input);
                    if (restore === "already changed") session.mode = "interactive";
                    return { modeApplied: false };
                };
            }
            await assert.rejects(runtime.startAutopilot({ itemId }, "panel"), (error) => {
                assert.match(error.message, /Dispatch failed/);
                if (persistence || restore === true) assert.match(error.message, /Autopilot failed: Dispatch failed/);
                if (persistence) assert.match(error.message, /state could not be saved/);
                if (restore === true) {
                    assert.match(error.message, /Mode restoration also failed: Copilot did not restore the previous mode/);
                    assert.match(error.message, /Switch Copilot to interactive mode manually before retrying/);
                } else {
                    assert.doesNotMatch(error.message, /Mode restoration also failed/);
                }
                assert.doesNotMatch(error.message, /Logger unavailable/);
                return true;
            });
            assert.equal(logCalls, Number(persistence) + Number(Boolean(restore)) + Number(restore === true));
            assert.equal(session.mode, restore === true ? "autopilot" : "interactive");
            if (!persistence) assert.equal((await runtime.snapshot()).autopilot.status, "Blocked");
            if (persistence) {
                await rm(directory);
                await rename(backup, directory);
            }
            session.rpc.mode.set = setMode;
            session.mode = "interactive";
            session.send = async () => "retry-message";
            assert.ok((await runtime.startAutopilot({ itemId }, "panel")).autopilotId);
        });
    }
});

test("failed tracking after dispatch still directs the user to check chat when logging rejects", async (t) => {
    const { runtime, session, stateFile } = await setup(t);
    const itemId = await prepareNewWorkflow(runtime);
    const directory = join(stateFile, "..");
    const backup = `${directory}-backup`;
    session.log = async () => { throw new Error("Logger unavailable"); };
    session.send = async () => {
        await rename(directory, backup);
        await writeFile(directory, "blocked");
        return "sent-message";
    };
    await assert.rejects(runtime.startAutopilot({ itemId }, "panel"), (error) => {
        assert.match(error.message, /state could not be saved/);
        assert.match(error.message, /Autopilot was sent; check chat before retrying/);
        assert.doesNotMatch(error.message, /Logger unavailable/);
        return true;
    });
    assert.equal(session.mode, "autopilot");
    await rm(directory);
    await rename(backup, directory);
});

test("a packaged adapter never executes on the server even with a frozen managed-run flag", async (t) => {
    const fixture = await setup(t);
    const { target, options } = fixture;
    const itemId = await prepareNewWorkflow(fixture.runtime);
    const file = join(target, "pages", "generated-phase-adapter.mjs");
    const module = Buffer.concat([await readFile(file), Buffer.from("\nglobalThis.__serverAdapterExecuted = true;\n")]);
    await writeFile(file, module);
    options.config.workflowPage.hash = createHash("sha256").update(module).digest("hex");
    const runtime = await fixture.restart();
    await runtime.startAutopilot({ itemId }, "panel");
    assert.equal(globalThis.__serverAdapterExecuted, undefined);
});

test("a missing required artifact blocks the step rather than advancing", async (t) => {
    const { runtime, project } = await setup(t);
    const { autopilotId } = await startNewAutopilot(runtime);
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
