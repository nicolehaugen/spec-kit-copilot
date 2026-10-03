import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCatalogPrompt } from "../prompts/catalog.mjs";
import { beginOutputInference, failOutputInference } from "../canvas-runtime/output-inference.mjs";
import { failRefresh, finishRefreshPart, setRefreshWork, startRefresh } from "../canvas-runtime/refresh-status.mjs";
import { validateCandidates } from "../artifact-evidence.mjs";

test("refresh finishes only after both pipeline and output inference complete", () => {
    const frames = [];
    const inst = { url: "http://127.0.0.1:1234", token: "test-token",
        broadcast: (frame) => frames.push(frame) };
    startRefresh(inst);
    const endpoint = beginOutputInference(inst, [
        { commandId: "speckit.plan", fingerprint: "a".repeat(64) },
    ]);
    assert.equal(endpoint.searchParams.get("token"), "test-token");
    setRefreshWork(inst, { pipeline: true, outputs: true });
    finishRefreshPart(inst, "pipeline");
    assert.equal(inst.refreshStatus.status, "refreshing");
    inst.outputInference.pending.clear();
    clearTimeout(inst.outputInference.timer);
    inst.outputInference = null;
    finishRefreshPart(inst, "outputs");
    assert.equal(inst.refreshStatus.status, "up-to-date");
    assert.ok(frames.some(({ type, reason }) => type === "invalidate"
        && reason === "composition refresh status changed"));
    const completedId = inst.refreshStatus.id;
    startRefresh(inst);
    assert.equal(inst.refreshStatus.status, "refreshing");
    assert.notEqual(inst.refreshStatus.id, completedId);
    failRefresh(inst);
    assert.equal(inst.refreshStatus.status, "incomplete");
});

test("output inference failure marks refresh incomplete without leaving a timer", () => {
    const inst = { url: "http://127.0.0.1:1234", token: "test-token", broadcast() {} };
    startRefresh(inst);
    beginOutputInference(inst, [{ commandId: "speckit.specify", fingerprint: "b".repeat(64) }]);
    failOutputInference(inst);
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
