import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildCatalogPrompt } from "../prompts/catalog.mjs";
import { buildCompositionPrompt } from "../prompts/composition.mjs";
import { beginOutputInference, failOutputInference, finishOutputInference } from "../canvas-runtime/output-inference.mjs";
import { dispatchKindPrompt } from "../canvas-runtime/dispatch.mjs";
import { failRefresh, finishRefreshPart, setRefreshWork, startRefresh } from "../canvas-runtime/refresh-status.mjs";
import { validateCandidates } from "../artifact-evidence.mjs";
import { attachOutputEvidence } from "../canvas-runtime/output-availability.mjs";
import { compositionActions } from "../canvas-runtime/actions/composition.mjs";
import { catalogActions } from "../canvas-runtime/actions/catalog.mjs";
import { allInstances, getInstance } from "../canvas-runtime/instances.mjs";

const request = { commandId: "speckit.plan", fingerprint: "a".repeat(64) };
const instance = () => ({ url: "http://127.0.0.1:1234", token: "test-token", broadcast() {} });

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const dispatchDeps = (send) => ({
    compose: async () => ({ ok: true, stage2Needed: true }),
    getSnapshot: async () => ({ artifactInferenceRequests: [request] }),
    getInstalledCounts: async () => ({}),
    send,
});

async function actionFixture(run) {
    const root = await mkdtemp(join(import.meta.dirname, ".refresh-fixture-"));
    const id = randomUUID();
    const inst = getInstance(id);
    Object.assign(inst, instance(), { workspacePath: root });
    try {
        await mkdir(join(root, ".specify"));
        await run(inst);
    } finally {
        clearTimeout(inst.refreshStatus?.timer);
        clearTimeout(inst.outputInference?.timer);
        allInstances().delete(id);
        await rm(root, { recursive: true, force: true });
    }
}

test("starting a refresh immediately detaches old output inference and both timers", () => {
    const inst = instance();
    startRefresh(inst);
    beginOutputInference(inst, [request], inst.refreshStatus);
    const refresh = inst.refreshStatus;
    const inference = inst.outputInference;
    try {
        const next = startRefresh(inst);
        assert.equal(next, inst.refreshStatus);
        assert.notEqual(next, refresh);
        assert.equal(inst.outputInference, null);
        assert.equal(refresh.timer._destroyed, true);
        assert.equal(inference.timer._destroyed, true);
        assert.equal(inference.pending.size, 1);
    } finally {
        clearTimeout(inst.refreshStatus.timer);
        clearTimeout(inference.timer);
    }
});

test("stale refresh helpers cannot declare, complete, or fail replacement work", () => {
    const inst = instance();
    startRefresh(inst);
    const previous = inst.refreshStatus;
    startRefresh(inst);
    const current = inst.refreshStatus;
    try {
        setRefreshWork(inst, { pipeline: false, outputs: false }, previous);
        finishRefreshPart(inst, "pipeline", previous);
        failRefresh(inst, previous);
        assert.throws(() => beginOutputInference(inst, [request], previous), /superseded/);
        assert.equal(inst.refreshStatus, current);
        assert.equal(current.status, "refreshing");
        assert.equal(current.pipelinePending, true);
        assert.equal(current.outputsPending, true);
        assert.equal(current.timer._destroyed, false);
    } finally {
        clearTimeout(current.timer);
    }
});

test("an inference-only replacement rejects an older failure", () => {
    const inst = instance();
    startRefresh(inst);
    beginOutputInference(inst, [request], inst.refreshStatus);
    const previous = inst.outputInference;
    beginOutputInference(inst, [request], inst.refreshStatus);
    try {
        failOutputInference(inst, previous);
        assert.equal(inst.outputInference.status, "updating");
        assert.equal(inst.outputInference.timer._destroyed, false);
        assert.equal(inst.refreshStatus.status, "refreshing");
    } finally {
        clearTimeout(inst.outputInference.timer);
        clearTimeout(inst.refreshStatus.timer);
    }
});

test("an old output timeout cannot fail a refresh-only retry", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const inst = instance();
    try {
        startRefresh(inst);
        beginOutputInference(inst, [request], inst.refreshStatus);
        t.mock.timers.tick(9 * 60 * 1000);
        startRefresh(inst);
        t.mock.timers.tick(60 * 1000);
        assert.equal(inst.refreshStatus.status, "refreshing");
        assert.equal(inst.outputInference, null);
        t.mock.timers.tick(9 * 60 * 1000);
        assert.equal(inst.refreshStatus.status, "incomplete");
    } finally {
        t.mock.timers.reset();
    }
});

test("a failed evidence scan retains warnings without failing a newer refresh", async () => {
    const inst = instance();
    startRefresh(inst);
    const previous = inst.refreshStatus;
    startRefresh(inst);
    try {
        const snap = { warnings: [], phases: {}, commands: [] };
        await attachOutputEvidence(inst, {}, snap, {
            evidence: {}, requests: [], incomplete: true, warnings: ["old source read failed"],
        }, undefined, previous);
        assert.deepEqual(snap.warnings, ["old source read failed"]);
        assert.equal(snap.artifactEvidenceIncomplete, true);
        assert.equal(snap.refreshStatus, "refreshing");
        assert.equal(inst.refreshStatus.status, "refreshing");
    } finally {
        clearTimeout(inst.refreshStatus.timer);
    }
});

test("a pipeline accepted before an await cannot complete a refresh started during persistence", async () => {
    await actionFixture(async (inst) => {
        const pipeline = ["commands/speckit.specify", "commands/speckit.plan", "commands/speckit.tasks"];
        inst.cachedComposition = { artifacts: pipeline.map((id) => ({ id, kind: "command" })) };
        startRefresh(inst);
        inst.broadcast = (frame) => {
            if (frame.type === "composition") startRefresh(inst);
        };
        const result = await compositionActions[0].handler({ instanceId: inst.instanceId, input: {
            inferredPipeline: { shape: "standalone", pipeline,
                unplaced: [], rationale: "Specify, plan, then tasks" },
        } });
        assert.equal(result.inferredPipelineStatus.accepted, true);
        assert.equal(inst.refreshStatus.status, "refreshing");
        assert.equal(inst.refreshStatus.pipelinePending, true);
    });
});

for (const replacement of ["refresh", "inference"]) {
    test(`a delayed catalog push cannot replace newer ${replacement} work`, async () => {
        await actionFixture(async (inst) => {
            let currentInference;
            let replaced = false;
            inst.broadcast = (frame) => {
                if (frame.type !== "state" || replaced) return;
                replaced = true;
                if (replacement === "refresh") startRefresh(inst);
                beginOutputInference(inst, [request], inst.refreshStatus);
                currentInference = inst.outputInference;
            };
            const action = catalogActions.find(({ name }) => name === "showExtensionCatalog");
            await assert.rejects(action.handler({ instanceId: inst.instanceId, input: { items: [] } }),
                /superseded/);
            assert.ok(replaced);
            assert.equal(inst.outputInference, currentInference);
            assert.equal(currentInference.status, "updating");
            assert.equal(currentInference.timer._destroyed, false);
        });
    });
}

for (const refreshing of [false, true]) {
    test(`a catalog push ${refreshing ? "with" : "without"} a refresh can finish when its output completes during persistence`, async () => {
        await actionFixture(async (inst) => {
            if (refreshing) startRefresh(inst);
            beginOutputInference(inst, [request], inst.refreshStatus);
            const inference = inst.outputInference;
            inst.broadcast = (frame) => {
                if (frame.type === "state") finishOutputInference(inst, inference, ["speckit.plan"]);
            };
            const action = catalogActions.find(({ name }) => name === "showExtensionCatalog");
            const result = await action.handler({ instanceId: inst.instanceId, input: { items: [] } });
            assert.equal(result.ok, true);
            assert.equal(inference.pending.size, 0);
            assert.equal(inference.timer._destroyed, true);
            if (!refreshing) assert.equal(inst.refreshStatus, undefined);
        });
    });
}

test("a refresh-less catalog push rejects replacement work even if the replacement completes during persistence", async () => {
    await actionFixture(async (inst) => {
        beginOutputInference(inst, [request], inst.refreshStatus);
        const previous = inst.outputInference;
        let replacement;
        inst.broadcast = (frame) => {
            if (frame.type !== "state" || replacement) return;
            beginOutputInference(inst, [request], inst.refreshStatus);
            replacement = inst.outputInference;
            finishOutputInference(inst, replacement, ["speckit.plan"]);
        };
        const action = catalogActions.find(({ name }) => name === "showExtensionCatalog");
        await assert.rejects(action.handler({ instanceId: inst.instanceId, input: { items: [] } }),
            /superseded/);
        assert.ok(replacement);
        assert.notEqual(replacement, previous);
        assert.equal(previous.pending.size, 1);
        assert.equal(replacement.pending.size, 0);
        assert.equal(inst.outputInference, null);
        assert.equal(inst.refreshStatus, undefined);
    });
});

for (const [stage, value, failure, inferenceOnly] of [
    ["compose", { ok: true, stage2Needed: true }],
    ["getSnapshot", { artifactInferenceRequests: [request] }],
    ["getInstalledCounts", {}],
    ["getInstalledCounts", null, "installed-count probe failed"],
    ["getSnapshot", { artifactInferenceRequests: [request] }, null, true],
    ["getInstalledCounts", {}, null, true],
]) {
    test(`superseded dispatch ${failure ? "failure" : "result"} at ${stage} preserves newer ${
        inferenceOnly ? "inference" : "refresh"} work`, async () => {
        const inst = instance();
        const entered = deferred();
        const waiting = deferred();
        const sent = [];
        const deps = dispatchDeps((message) => sent.push(message));
        deps[stage] = () => { entered.resolve(); return waiting.promise; };
        const running = dispatchKindPrompt(inst, "composition.refresh", {}, deps);
        await entered.promise;
        const refresh = inferenceOnly ? inst.refreshStatus : startRefresh(inst);
        beginOutputInference(inst, [request], refresh);
        setRefreshWork(inst, { pipeline: true, outputs: true }, refresh);
        const inference = inst.outputInference;
        try {
            if (failure) waiting.reject(new Error(failure));
            else waiting.resolve(value);
            await assert.rejects(running, failure ? /installed-count probe failed/ : /superseded/);
            assert.equal(inst.refreshStatus, refresh);
            assert.equal(refresh.status, "refreshing");
            assert.equal(refresh.pipelinePending, true);
            assert.equal(refresh.outputsPending, true);
            assert.equal(refresh.timer._destroyed, false);
            assert.equal(inst.outputInference, inference);
            assert.equal(inference.status, "updating");
            assert.equal(inference.timer._destroyed, false);
            assert.deepEqual(sent, []);
        } finally {
            clearTimeout(refresh.timer);
            clearTimeout(inference.timer);
        }
    });
}

test("a queued refresh send is skipped if a newer refresh starts before the deferred send", async () => {
    const inst = instance();
    const sent = [];
    try {
        await dispatchKindPrompt(inst, "composition.refresh", {}, dispatchDeps((message) => sent.push(message)));
        startRefresh(inst);
        await new Promise(setImmediate);
        assert.deepEqual(sent, []);
        assert.equal(inst.refreshStatus.status, "refreshing");
        assert.equal(inst.refreshStatus.pipelinePending, true);
        assert.equal(inst.refreshStatus.outputsPending, true);
    } finally {
        clearTimeout(inst.refreshStatus.timer);
        clearTimeout(inst.outputInference?.timer);
    }
});

for (const retry of [null, "refresh", "inference", "completed outputs"]) {
    test(`deferred transport failure after ${retry ?? "no replacement"} affects only its owning work`, async () => {
        const inst = instance();
        const entered = deferred();
        const transport = deferred();
        try {
            await dispatchKindPrompt(inst, "composition.refresh", {}, dispatchDeps(() => {
                entered.resolve();
                return transport.promise;
            }));
            await entered.promise;
            if (retry === "refresh") {
                startRefresh(inst);
            }
            if (retry === "refresh" || retry === "inference") {
                beginOutputInference(inst, [request], inst.refreshStatus);
            }
            if (retry === "completed outputs") {
                finishOutputInference(inst, inst.outputInference, ["speckit.plan"]);
            }
            const refresh = inst.refreshStatus;
            const inference = inst.outputInference;
            transport.reject(new Error("session unavailable"));
            await new Promise(setImmediate);
            assert.equal(inst.refreshStatus, refresh);
            assert.equal(inst.outputInference, inference);
            const superseded = retry === "refresh" || retry === "inference";
            assert.equal(refresh.status, superseded ? "refreshing" : "incomplete");
            if (inference) {
                assert.equal(inference.status, superseded ? "updating" : "incomplete");
                assert.equal(inference.timer._destroyed, !superseded);
            }
        } finally {
            clearTimeout(inst.refreshStatus.timer);
            clearTimeout(inst.outputInference?.timer);
        }
    });
}

test("catalog inference without an explicit refresh can complete or fail normally", () => {
    const inst = instance();
    try {
        beginOutputInference(inst, [request], inst.refreshStatus);
        finishOutputInference(inst, inst.outputInference, ["speckit.plan"]);
        assert.equal(inst.outputInference, null);
        assert.equal(inst.refreshStatus, undefined);
        beginOutputInference(inst, [request], inst.refreshStatus);
        failOutputInference(inst, inst.outputInference);
        assert.equal(inst.outputInference.status, "incomplete");
        assert.equal(inst.outputInference.timer._destroyed, true);
        assert.equal(inst.refreshStatus, undefined);
    } finally {
        clearTimeout(inst.outputInference?.timer);
    }
});

test("current output inference still times out and broadcasts its concrete failure", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const frames = [];
    const inst = { ...instance(), broadcast: (frame) => frames.push(frame) };
    try {
        beginOutputInference(inst, [request], inst.refreshStatus);
        t.mock.timers.tick(10 * 60 * 1000);
        assert.equal(inst.outputInference.status, "incomplete");
        assert.ok(frames.some(({ reason }) => reason === "output inference timed out"));
    } finally {
        t.mock.timers.reset();
    }
});

test("refresh finishes only after both pipeline and output inference complete", () => {
    const frames = [];
    const inst = { url: "http://127.0.0.1:1234", token: "test-token",
        broadcast: (frame) => frames.push(frame) };
    startRefresh(inst);
    const endpoint = beginOutputInference(inst, [
        { commandId: "speckit.plan", fingerprint: "a".repeat(64) },
    ], inst.refreshStatus);
    assert.equal(endpoint.searchParams.get("token"), "test-token");
    setRefreshWork(inst, { pipeline: true, outputs: true }, inst.refreshStatus);
    finishRefreshPart(inst, "pipeline", inst.refreshStatus);
    assert.equal(inst.refreshStatus.status, "refreshing");
    finishOutputInference(inst, inst.outputInference, ["speckit.plan"]);
    assert.equal(inst.refreshStatus.status, "up-to-date");
    assert.ok(frames.some(({ type, reason }) => type === "invalidate"
        && reason === "composition refresh status changed"));
    const completedId = inst.refreshStatus.id;
    startRefresh(inst);
    assert.equal(inst.refreshStatus.status, "refreshing");
    assert.notEqual(inst.refreshStatus.id, completedId);
    failRefresh(inst, inst.refreshStatus);
    assert.equal(inst.refreshStatus.status, "incomplete");
});

test("output inference failure marks refresh incomplete without leaving a timer", () => {
    const inst = { url: "http://127.0.0.1:1234", token: "test-token", broadcast() {} };
    startRefresh(inst);
    beginOutputInference(inst, [{ commandId: "speckit.specify", fingerprint: "b".repeat(64) }], inst.refreshStatus);
    failOutputInference(inst, inst.outputInference);
    assert.equal(inst.outputInference.status, "incomplete");
    assert.equal(inst.refreshStatus.status, "incomplete");
});

test("catalog changes infer outputs after catalog updates, including removal", () => {
    for (const kind of ["preset.install", "preset.remove", "extension.install",
        "extension.remove", "bundle.install", "bundle.remove"]) {
        const prompt = buildCatalogPrompt(kind, { name: "example" }, {},
            { workspacePath: "C:\\workspace", skill: "speckit-bundle" });
        const finalCatalog = prompt.indexOf(kind.startsWith("preset.") ? "showPresetCatalog"
            : "showExtensionCatalog");
        const inference = prompt.indexOf("After the final catalog action");
        assert.ok(finalCatalog >= 0 && inference > finalCatalog,
            `${kind} must request output evidence only after its final catalog update`);
        assert.match(prompt, /artifactInferenceRequests/);
    }
});

test("inference prompt distinguishes feature-relative paths from named roots", () => {
    for (const prompt of [
        buildCatalogPrompt("preset.install", { name: "example" }, {},
            { workspacePath: "C:\\workspace", skill: "speckit-preset" }),
        buildCatalogPrompt("extension.install", { name: "example" }, {},
            { workspacePath: "C:\\workspace", skill: "speckit-extension" }),
    ]) {
        assert.match(prompt, /Never include root and relativeTo on the same candidate/);
        assert.match(prompt, /including helpers that call it FEATURE_DIR/);
        assert.match(prompt, /\"path\":\"plan\.md\",\"relativeTo\":\"feature\"/);
        assert.match(prompt, /\"root\":\{\"name\":\"REPORT_DIR\",\"path\":\"reports\/<slug>\"\}/);
    }
    const feature = { kind: "file", path: "plan.md", relativeTo: "feature",
        source: "inference", effect: "creates", evidence: "Writes FEATURE_DIR/plan.md" };
    const named = { kind: "file", path: "summary.md",
        root: { name: "REPORT_DIR", path: "reports/<slug>" },
        source: "inference", effect: "creates", evidence: "Writes REPORT_DIR/summary.md" };
    assert.equal(validateCandidates([feature, named], { inference: true }).length, 2);
    assert.throws(() => validateCandidates([{ ...feature, root: named.root }], { inference: true }),
        /Invalid feature-relative artifact evidence/);
});

test("inference prompts require copying fresh fingerprints rather than transcribing them", () => {
    for (const prompt of [
        buildCatalogPrompt("preset.install", { name: "example" }, {},
            { workspacePath: "C:\\workspace", skill: "speckit-preset" }),
        buildCatalogPrompt("extension.install", { name: "example" }, {},
            { workspacePath: "C:\\workspace", skill: "speckit-extension" }),
        buildCompositionPrompt("extension.inferArtifactTargets",
            { commands: [{ commandId: "speckit.plan", skillPath: ".github/skills/speckit-plan/SKILL.md",
                fingerprint: "a".repeat(64) }], origin: "http://127.0.0.1:1234", token: "test-token" },
            {}, { workspacePath: "C:\\workspace", skill: "speckit-plan" }),
    ]) {
        assert.match(prompt, /GET \/api\/state on the artifactInferenceEndpoint origin with the same token/);
        assert.match(prompt, /artifactInferenceRequests as the data source for command IDs and fingerprints/);
        assert.match(prompt, /Verify the GET request IDs exactly match/);
        assert.match(prompt, /Build entries programmatically by joining your inferred candidates by command ID/);
        assert.match(prompt, /If an ID is missing, extra, duplicated, or lacks a fingerprint or inference result, stop without POST/);
        assert.match(prompt, /fingerprint copied programmatically from matching GET request/);
    }
});
