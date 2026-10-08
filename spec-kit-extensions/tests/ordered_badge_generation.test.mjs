import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { frozenBadges } from "../extension-canvas-design/scripts/generate.mjs";
import { validateBadgeRule } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/pages.mjs";
import { validBadgeEvidence } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/generation.mjs";

const asset = (name, kind, value) => {
    const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    return { name, kind, sourceId: "test-preset", content: bytes.toString("base64"),
        hash: createHash("sha256").update(bytes).digest("hex") };
};
const target = { phase: "plan", output: "specs/<slug>/plan.md" };
const earlier = { phase: "specify", output: "specs/<slug>/spec.md" };
const rule = {
    schemaVersion: 1, id: "phase-artifact-complete", label: "Phase artifact complete",
    description: "Ordered metadata evidence", placementPhaseInput: "target",
    inputs: [{ id: "target", type: "artifact", scope: "metadata" },
        { id: "prerequisites", type: "ordered-artifacts", scope: "metadata", before: "target" }],
    textPlaceholders: [], module: "badge-rule-phase-artifact-complete-adapter",
};
const type = { id: "phase-artifact-complete", title: "Phase artifact complete",
    description: "Ordered output freshness", rule: rule.id,
    defaultText: "Phase complete", defaultColor: "green", enabled: true };
const workflow = { selectedPhases: ["specify", "plan"], phaseArtifacts: {
    specify: { outputs: [earlier.output] }, plan: { outputs: [target.output] },
} };
const instance = { id: "plan-complete", type: type.id, inputs: {
    target, prerequisites: [earlier],
}, text: "Ready", phaseText: "Phase ready", summaryText: "Ready ({workflows})",
color: "green", showIn: ["workflow-list", "workflow-summary", "phase-card"],
phase: "plan" };
const inventory = (badge = instance, definition = rule) => ({
    instances: [badge],
    settings: asset("badges-settings", "designer.badges-settings-definition",
        { schemaVersion: 1, types: [type] }),
    types: [{ name: "badges-settings", sourceId: "test-preset", schemaVersion: 1, ...type }],
    rules: [{ name: "phase-artifact-definition", sourceId: "test-preset", ...definition,
        assets: [asset("phase-artifact-definition", "generated.badge-rule-definition", definition)] }],
    adapters: [asset(definition.module, "generated.badge-rule-adapter",
        "export const contractVersion = 1; export function evaluate() {}")],
});
const declared = (entry) => Boolean(entry && workflow.phaseArtifacts[entry.phase]
    ?.outputs?.includes(entry.output));

test("ordered metadata evidence and target placement survive Designer and generator validation", () => {
    assert.doesNotThrow(() => validateBadgeRule(rule, "phase-artifact-definition"));
    assert.equal(validBadgeEvidence(instance, rule, workflow.selectedPhases, declared), true);
    const frozen = frozenBadges(inventory(), workflow);
    assert.equal(frozen.rules[0].placementPhaseInput, "target");
    assert.deepEqual(frozen.rules[0].inputs, rule.inputs);
    assert.deepEqual(frozen.instances[0].inputs.prerequisites, [earlier]);
    const targetOnly = { ...instance, inputs: { target: earlier, prerequisites: [] }, phase: "specify" };
    assert.equal(validBadgeEvidence(targetOnly, rule, workflow.selectedPhases, declared), true);
    assert.deepEqual(frozenBadges(inventory(targetOnly), workflow).instances[0].inputs.prerequisites, []);
});

test("malformed metadata rule references and ordered evidence are rejected", () => {
    for (const malformed of [
        { ...rule, placementPhaseInput: "prerequisites" },
        { ...rule, inputs: [{ ...rule.inputs[0], scope: "directory" }, rule.inputs[1]] },
        { ...rule, inputs: [rule.inputs[0], { ...rule.inputs[1], before: "missing" }] },
        { ...rule, inputs: [rule.inputs[0], { ...rule.inputs[1], scope: "directory" }] },
    ]) {
        assert.throws(() => validateBadgeRule(malformed, "phase-artifact-definition"),
            /invalid badge rule definition/);
        assert.throws(() => frozenBadges(inventory(instance, malformed), workflow),
            /Invalid frozen badge rule/);
    }
    for (const badge of [
        { ...instance, inputs: { target, prerequisites: [target] } },
        { ...instance, inputs: { target, prerequisites: [earlier, earlier] } },
        { ...instance, inputs: { target, prerequisites: [{ ...earlier, unexpected: 1 }] } },
        { ...instance, phase: "specify" },
    ]) {
        assert.equal(validBadgeEvidence(badge, rule, workflow.selectedPhases, declared), false);
        assert.throws(() => frozenBadges(inventory(badge), workflow), /Invalid configured badge/);
    }
});

test("generator rejects Constitution placements while keeping global Constitution evidence", () => {
    const constitution = { phase: "speckit.constitution", output: ".specify/memory/constitution.md" };
    const phases = { selectedPhases: [constitution.phase, ...workflow.selectedPhases],
        phaseArtifacts: { ...workflow.phaseArtifacts, [constitution.phase]: {
            outputs: [constitution.output],
        } } };
    const global = { id: "constitution-evidence", type: type.id,
        inputs: { target: constitution, prerequisites: [] }, text: "Ready", color: "green",
        showIn: ["workflow-list"], phase: null };
    assert.equal(frozenBadges(inventory(global), phases).instances[0].inputs.target.phase,
        constitution.phase);
    assert.throws(() => frozenBadges(inventory({ ...global, showIn: ["phase-card"],
        phase: constitution.phase, phaseText: "Ready" }), phases), /Invalid configured badge/);
    for (const output of [null, constitution.output]) {
        assert.throws(() => frozenBadges(inventory({ ...global, targets: [{
            phase: constitution.phase, output,
        }], phaseText: "Ready" }), phases), /Invalid configured badge/);
    }
});
