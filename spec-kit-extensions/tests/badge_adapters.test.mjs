import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate as content } from "../extension-canvas-design/generated-host/badges/adapters/content.mjs";
import { evaluate as artifactState } from "../extension-canvas-design/generated-host/badges/adapters/artifact-state.mjs";
import { evaluate as run } from "../extension-canvas-design/generated-host/badges/adapters/run.mjs";
import { evaluate as phaseArtifactComplete } from
    "../extension-canvas-design/generated-host/badges/adapters/phase-artifact-complete.mjs";
import { evaluate as testPhase } from "../../spec-kit-presets/copilot-badge-input-test/generated/evaluator.mjs";

test("test preset evaluator decides matches from only its declared phase run", async () => {
    const requested = [];
    const evidence = { getRun: async (phase) => {
        requested.push(phase);
        return { status: "completed" };
    } };
    assert.deepEqual(await testPhase({ inputs: { phase: "plan" }, evidence }), { match: true });
    assert.deepEqual(requested, ["plan"]);
    evidence.getRun = async () => ({ status: "running" });
    assert.deepEqual(await testPhase({ inputs: { phase: "plan" }, evidence }), { match: false });
});

test("value match searches literal text anywhere in one output without regard to case", async () => {
    const inputs = { artifact: { phase: "decide", output: "decision.md" },
        value: "Verdict: needs-clarification" };
    const evidence = { readArtifact: async () =>
        ({ state: "ok", text: "## Outcome\nVERDICT: NEEDS-CLARIFICATION\n" }) };
    assert.deepEqual(await content({ ruleId: "value-match", inputs, evidence }),
        { match: true });
    inputs.value = "Verdict: needs.clarification";
    assert.deepEqual(await content({ ruleId: "value-match", inputs, evidence }),
        { match: false });
    inputs.value = "VERDICT: NEEDS-CLARIFICATION";
    evidence.readArtifact = async () =>
        ({ state: "ok", text: "```\nverdict: needs-clarification\n```" });
    assert.deepEqual(await content({ ruleId: "value-match", inputs, evidence }),
        { match: true });
    evidence.readArtifact = async () => ({ state: "missing" });
    assert.deepEqual(await content({ ruleId: "value-match", inputs, evidence }),
        { match: false });
});

test("Markdown file count is independent of checklist progress and surfaces unknown evidence", async () => {
    const inputs = { artifact: { phase: "any", output: "arbitrary/<name>.md" } };
    const evidence = { countMarkdownFiles: async () => ({ state: "ok", count: 3 }) };
    assert.deepEqual(await content({ ruleId: "markdown-file-count", inputs, evidence }),
        { match: true, values: { count: 3 } });
    evidence.countMarkdownFiles = async () => ({ state: "ok", count: 0 });
    assert.deepEqual(await content({ ruleId: "markdown-file-count", inputs, evidence }),
        { match: false, values: { count: 0 } });
    evidence.countMarkdownFiles = async () => ({ state: "unknown", diagnostic: "Unreadable directory" });
    assert.deepEqual(await content({ ruleId: "markdown-file-count", inputs, evidence }),
        { match: false, diagnostics: ["Unreadable directory"] });
});

test("checklist progress and completion share fence-aware parsing", async () => {
    const evidence = {
        readArtifact: async () => ({
            state: "ok", text: "- [x] one\n- [ ] two\n```\n- [x] ignored\n```\n1. [X] three",
        }),
        getRun: async () => ({ status: "completed" }),
    };
    const inputs = { artifact: { phase: "p", output: "list.md" }, phase: "p" };
    assert.deepEqual(await content({ ruleId: "checklist-progress", inputs, evidence }),
        { match: true, values: { completed: 2, total: 3, percent: 67 } });
    assert.deepEqual(await content({ ruleId: "checklist-complete", inputs, evidence }),
        { match: false });
    assert.deepEqual(await content({ ruleId: "work-complete", inputs, evidence }),
        { match: false });
    evidence.readArtifact = async () => ({ state: "ok", text: "- [x] one\n- [x] two" });
    assert.deepEqual(await content({ ruleId: "work-complete", inputs, evidence }),
        { match: true });
});

test("checklist completion requires a distinct earlier output no newer than the checklist", async () => {
    const inputs = { artifact: { phase: "tasks", output: "tasks.md" },
        prerequisite: { phase: "plan", output: "plan.md" } };
    let prerequisite = { state: "ok", mtimeMs: 100 };
    const evidence = { readArtifact: async ({ output }) => output === "plan.md" ? prerequisite
        : { state: "ok", text: "- [x] one\n- [x] two", mtimeMs: 100 } };
    const evaluate = () => content({ ruleId: "checklist-complete", inputs, evidence });
    assert.deepEqual(await evaluate(), { match: true });
    prerequisite = { state: "ok", mtimeMs: 101 };
    assert.deepEqual(await evaluate(), { match: false });
    prerequisite = { state: "missing" };
    assert.deepEqual(await evaluate(), { match: false });
    prerequisite = { state: "unknown", diagnostic: "Earlier output could not be read safely." };
    assert.deepEqual(await evaluate(), { match: false,
        diagnostics: ["Earlier output could not be read safely."] });
    prerequisite = { state: "ok" };
    assert.deepEqual(await evaluate(), { match: false,
        diagnostics: ["Checklist or earlier output timestamp is unavailable."] });
    evidence.readArtifact = async ({ output }) => output === "plan.md"
        ? { state: "ok", mtimeMs: 0 } : { state: "ok", text: "No tasks", mtimeMs: 100 };
    assert.deepEqual(await evaluate(), { match: false });
});

test("artifact freshness and phase completion use generic evidence", async () => {
    const evidence = {
        readArtifact: async () => ({ state: "ok", mtimeMs: 100 }),
        getRun: async () => ({ status: "completed", completedAt: new Date(200).toISOString() }),
    };
    const inputs = { artifact: { phase: "p", output: "doc.md" }, phase: "p" };
    assert.deepEqual(await artifactState({ ruleId: "artifact-stale", inputs, evidence }),
        { match: true });
    assert.deepEqual(await artifactState({ ruleId: "artifact-current", inputs, evidence }),
        { match: false });
    evidence.getRun = async () => ({ status: "completed",
        startedAt: new Date(50).toISOString(), completedAt: new Date(200).toISOString() });
    assert.deepEqual(await artifactState({ ruleId: "artifact-current", inputs, evidence }),
        { match: true });
    assert.deepEqual(await artifactState({ ruleId: "artifact-stale", inputs, evidence }),
        { match: false });
    evidence.readArtifact = async () => ({ state: "ok", mtimeMs: 40 });
    assert.deepEqual(await artifactState({ ruleId: "artifact-stale", inputs, evidence }),
        { match: true });
    assert.deepEqual(await run({ ruleId: "phase-run-complete", inputs, evidence }),
        { match: true, summaryCount: 1 });
});

test("unreadable evidence reports a diagnostic without claiming a match", async () => {
    const evidence = {
        readArtifact: async () => ({ state: "unknown", diagnostic: "Artifact could not be read" }),
        getRun: async () => null,
    };
    assert.deepEqual(await content({ ruleId: "value-match",
        inputs: { artifact: { phase: "p", output: "missing.md" }, value: "hello" }, evidence }),
    { match: false, diagnostics: ["Artifact could not be read"] });
    assert.deepEqual(await content({ ruleId: "checklist-progress",
        inputs: { artifact: { phase: "p", output: "list.md" } }, evidence }),
    { match: false, diagnostics: ["Artifact could not be read"] });
    assert.deepEqual(await artifactState({ ruleId: "artifact-current",
        inputs: { artifact: { phase: "p", output: "list.md" } }, evidence }),
    { match: false, diagnostics: ["Artifact could not be read"] });
});

test("phase artifact completion checks every adjacent file timestamp, not just the target", async () => {
    const inputs = { prerequisites: [{ phase: "specify", output: "spec.md" },
        { phase: "plan", output: "plan.md" }],
    target: { phase: "tasks", output: "tasks.md" } };
    const files = {
        "spec.md": { state: "ok", mtimeMs: 10 },
        "plan.md": { state: "ok", mtimeMs: 10 },
        "tasks.md": { state: "ok", mtimeMs: 10 },
    };
    const evidence = { readArtifact: async ({ output }) => files[output] };
    const check = () => phaseArtifactComplete({ ruleId: "phase-artifact-complete", inputs, evidence });
    assert.deepEqual(await check(), { match: true });
    files["spec.md"].mtimeMs = 20;
    files["tasks.md"].mtimeMs = 30;
    assert.deepEqual(await check(), { match: false });
    files["plan.md"].mtimeMs = 25;
    assert.deepEqual(await check(), { match: true });
    files["plan.md"] = { state: "missing" };
    assert.deepEqual(await check(), { match: false });
    files["plan.md"] = { state: "unknown", diagnostic: "Output could not be read safely." };
    assert.deepEqual(await check(), { match: false,
        diagnostics: ["Output could not be read safely."] });
    inputs.prerequisites = [];
    assert.deepEqual(await check(), { match: true });
});
