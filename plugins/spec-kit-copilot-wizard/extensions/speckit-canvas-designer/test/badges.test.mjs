import assert from "node:assert/strict";
import test from "node:test";
import { validateBadges } from "../contracts/badges.mjs";

const model = {
    phases: ["specify", "plan"],
    outputs: {
        specify: { outputs: ["specs/<slug>/spec.md", "specs/<slug>/notes.md"],
            view: "specs/<slug>/spec.md" },
        plan: { outputs: ["specs/<slug>/plan.md"], view: "specs/<slug>/plan.md" },
    },
    badgeTypes: [{ id: "artifact", rule: "artifact-rule", enabled: true },
        { id: "distinct", rule: "distinct-rule", enabled: true },
        { id: "disabled", rule: "artifact-rule", enabled: false }],
    badgeRules: [
        { id: "artifact-rule", inputs: [{ id: "item", type: "artifact" }],
            textPlaceholders: ["status"] },
        { id: "distinct-rule", inputs: [{ id: "items", type: "artifact-set" },
            { id: "completion", type: "phase" }], textPlaceholders: [] },
    ],
};
const artifact = { id: "badge-1", type: "artifact",
    inputs: { item: { phase: "specify", output: "specs/<slug>/spec.md" } },
    text: "Ready {status}", color: "green",
    showIn: ["workflow-list", "phase-card"], phase: "plan" };
const distinct = { id: "badge-2", type: "distinct",
    inputs: { items: [{ phase: "specify",
        outputs: ["specs/<slug>/spec.md", "specs/<slug>/notes.md"] }],
        completion: "plan" },
    text: "Clarified", color: "#abcdef", showIn: [], phase: null };

test("badge validation accepts zero, configured, and Off instances", () => {
    assert.deepEqual(validateBadges([], model), []);
    assert.deepEqual(validateBadges([artifact, distinct], model), [artifact, distinct]);
    const { phase, ...withoutDestination } = distinct;
    assert.deepEqual(validateBadges([withoutDestination], model), [withoutDestination]);
    assert.deepEqual(validateBadges([{ ...distinct, inputs: { ...distinct.inputs,
        items: [{ phase: "specify", outputs: ["specs/<slug>/spec.md"] }] } }], model).length, 1);
});

test("badge validation checks membership and distinct artifact sets", () => {
    const bad = (entry, reason) => assert.throws(() => validateBadges([entry], model), reason);
    bad({ ...artifact, inputs: { item: { phase: "plan", output: "specs/<slug>/spec.md" } } },
        /invalid artifact input/);
    bad({ ...distinct, inputs: { ...distinct.inputs, items: [] } },
        /invalid artifact-set input/);
    bad({ ...distinct, inputs: { ...distinct.inputs, items: [
        { phase: "specify", outputs: ["specs/<slug>/spec.md", "specs/<slug>/spec.md"] }] } },
    /duplicate artifact/);
    bad({ ...distinct, inputs: { ...distinct.inputs, completion: "other" } },
        /invalid phase input/);
    bad({ ...artifact, inputs: { wrong: artifact.inputs.item } }, /rule inputs/);
});

test("Value match requires a confirmed output and bounded nonblank literal text", () => {
    const config = { ...model, badgeRules: [...model.badgeRules,
        { id: "value-match", inputs: [{ id: "artifact", type: "artifact" },
            { id: "value", type: "text" }], textPlaceholders: [] }],
    badgeTypes: [...model.badgeTypes,
        { id: "value-match", rule: "value-match", enabled: true }] };
    const matching = { ...artifact, type: "value-match", text: "Needs review",
        inputs: { artifact: artifact.inputs.item, value: "Verdict: needs-clarification" } };
    assert.deepEqual(validateBadges([matching], config), [matching]);
    assert.doesNotThrow(() => validateBadges([{ ...matching,
        inputs: { ...matching.inputs, value: "x".repeat(256) } }], config));
    for (const value of ["", "  ", "x".repeat(257), "line\nbreak"]) {
        assert.throws(() => validateBadges([{ ...matching,
            inputs: { ...matching.inputs, value } }], config), /invalid text input/);
    }
    assert.throws(() => validateBadges([{ ...matching,
        inputs: { ...matching.inputs, artifact: { phase: "plan", output: "missing.md" } } }],
    config), /invalid artifact input/);
});

test("Checklist complete requires a different confirmed output from an earlier phase", () => {
    const config = { ...model, badgeRules: [...model.badgeRules,
        { id: "checklist-complete", inputs: [{ id: "artifact", type: "artifact" },
            { id: "prerequisite", type: "artifact" }], textPlaceholders: [] }],
    badgeTypes: [...model.badgeTypes,
        { id: "checklist-complete", rule: "checklist-complete", enabled: true }] };
    const complete = { ...artifact, type: "checklist-complete", text: "Complete",
        inputs: { artifact: { phase: "plan", output: "specs/<slug>/plan.md" },
            prerequisite: { phase: "specify", output: "specs/<slug>/spec.md" } } };
    assert.deepEqual(validateBadges([complete], config), [complete]);
    assert.throws(() => validateBadges([{ ...complete,
        inputs: { artifact: complete.inputs.artifact } }], config), /rule inputs/);
    assert.throws(() => validateBadges([{ ...complete, inputs: { ...complete.inputs,
        prerequisite: { phase: "plan", output: "specs/<slug>/plan.md" } } }], config),
    /earlier phase/);
    assert.throws(() => validateBadges([{ ...complete, inputs: { ...complete.inputs,
        prerequisite: { phase: "plan", output: "specs/<slug>/spec.md" } } }], config),
    /invalid artifact input/);
    assert.throws(() => validateBadges([{ ...complete, inputs: { ...complete.inputs,
        artifact: { phase: "specify", output: "specs/<slug>/spec.md" } } }], config),
    /earlier phase/);
});

test("Phase artifact complete accepts one declared earlier output per phase in order", () => {
    const config = { ...model, phases: [...model.phases, "tasks"],
        outputs: { ...model.outputs, tasks: { outputs: ["specs/<slug>/tasks.md"] } },
        badgeRules: [...model.badgeRules, { id: "phase-artifact-complete",
            placementPhaseInput: "target", textPlaceholders: [],
            inputs: [{ id: "target", type: "artifact", scope: "metadata" },
                { id: "prerequisites", type: "ordered-artifacts", scope: "metadata",
                    before: "target" }] }],
        badgeTypes: [...model.badgeTypes,
            { id: "phase-artifact-complete", rule: "phase-artifact-complete", enabled: true }] };
    const target = { phase: "tasks", output: "specs/<slug>/tasks.md" };
    const previous = { phase: "specify", output: "specs/<slug>/spec.md" };
    const plan = { phase: "plan", output: "specs/<slug>/plan.md" };
    const badge = { ...artifact, type: "phase-artifact-complete", text: "Complete",
        showIn: ["workflow-list", "workflow-summary"], phase: null,
        phaseText: "Phase complete", summaryText: "{workflows} complete",
        targets: [{ phase: "tasks", output: null }],
        inputs: { target, prerequisites: [previous, plan] } };
    assert.deepEqual(validateBadges([badge], config), [badge]);
    assert.deepEqual(validateBadges([{ ...badge, inputs: {
        target: previous, prerequisites: [] }, targets: [{ phase: "specify", output: null }] }],
    config).length, 1);
    for (const prerequisites of [
        [plan, previous], [previous, previous], [plan, plan],
        [{ phase: "plan", output: "missing.md" }], [target],
    ]) {
        assert.throws(() => validateBadges([{ ...badge,
            inputs: { target, prerequisites } }], config), /Invalid Designer badge/);
    }
    assert.throws(() => validateBadges([{ ...badge,
        targets: [{ phase: "plan", output: null }] }], config),
    /target phase/);
});

test("badge validation checks identity, placeholders, color, placements, and cap", () => {
    const bad = (entry, reason) => assert.throws(() => validateBadges([entry], model), reason);
    bad({ ...artifact, id: "Badge-1" }, /invalid or duplicate id/);
    bad({ ...artifact, id: "badge_1" }, /invalid or duplicate id/);
    bad({ ...artifact, id: "-badge" }, /invalid or duplicate id/);
    bad({ ...artifact, type: "disabled" }, /disabled badge type/);
    bad({ ...artifact, text: "Unknown {other}" }, /unknown text token/);
    bad({ ...artifact, color: "chartreuse" }, /invalid color/);
    bad({ ...artifact, showIn: ["workflow-list", "workflow-list"] }, /invalid placement/);
    bad({ ...artifact, showIn: [], phase: "plan" }, /phase-card destination/);
    bad({ ...artifact, phase: "other" }, /phase-card destination/);
    assert.throws(() => validateBadges([artifact, artifact], model), /duplicate id/);
    const many = Array.from({ length: 100 },
        (_, index) => ({ ...artifact, id: `badge-${index}`, type: `type-${index}` }));
    assert.equal(validateBadges(many, { ...model, badgeTypes: [...model.badgeTypes,
        ...many.map(({ type }) => ({ id: type, rule: "artifact-rule", enabled: true }))] }).length, 100);
    assert.throws(() => validateBadges(Array.from({ length: 101 }, () => artifact), model),
        /at most 100/);
});

test("Constitution evidence can target its project card or declared output", () => {
    const constitution = { phase: "speckit.constitution", output: ".specify/memory/constitution.md" };
    const withConstitution = { ...model, phases: [constitution.phase, ...model.phases],
        outputs: { ...model.outputs, [constitution.phase]: {
            outputs: [constitution.output], view: constitution.output,
        } } };
    const global = { ...artifact, inputs: { item: constitution },
        showIn: ["workflow-list"], phase: null };
    assert.deepEqual(validateBadges([global], withConstitution), [global]);
    assert.deepEqual(validateBadges([{ ...global, showIn: ["phase-card"],
        phase: constitution.phase }], withConstitution).length, 1);
    for (const output of [null, constitution.output]) {
        assert.deepEqual(validateBadges([{ ...global, targets: [{
            phase: constitution.phase, output,
        }] }], withConstitution).length, 1);
    }
    assert.throws(() => validateBadges([{ ...global, targets: [{
        phase: constitution.phase, output: "undeclared.md",
    }] }], withConstitution), /phase\/output placement/);
});

test("duplicate badges require matching text, inputs, and overlapping targets", () => {
    const first = { ...artifact, showIn: ["workflow-list"], phase: null,
        targets: [{ phase: "specify", output: null },
            { phase: "plan", output: "specs/<slug>/plan.md" }] };
    const duplicate = { ...first, id: "another",
        color: "pink", showIn: ["workflow-summary"],
        targets: [{ phase: "plan", output: "specs/<slug>/plan.md" }] };
    assert.throws(() => validateBadges([first, duplicate], model),
        /duplicate phase\/output target already covered by badge badge-1/);
    assert.throws(() => validateBadges([artifact, { ...artifact, id: "another",
        color: "blue", showIn: ["workflow-summary"], phase: null,
        targets: [{ phase: "plan", output: null }] }], model),
    /duplicate phase\/output target/);
    assert.doesNotThrow(() => validateBadges([first, { ...duplicate,
        text: "Different {status}" }], model));
    assert.doesNotThrow(() => validateBadges([artifact, { ...artifact, id: "another",
        inputs: { item: { phase: "plan", output: "specs/<slug>/plan.md" } },
        text: "Plan ready" }], model));
    assert.doesNotThrow(() => validateBadges([first, { ...duplicate,
        targets: [{ phase: "plan", output: null }] }], model));
    assert.doesNotThrow(() => validateBadges([first, { ...duplicate,
        targets: [{ phase: "specify", output: "specs/<slug>/spec.md" }] }], model));
    assert.doesNotThrow(() => validateBadges([first, { ...duplicate,
        inputs: { item: { phase: "plan", output: "specs/<slug>/plan.md" } } }], model));
    assert.throws(() => validateBadges([distinct, { ...distinct, id: "another",
        inputs: { completion: "plan", items: [{ phase: "specify",
            outputs: ["specs/<slug>/notes.md", "specs/<slug>/spec.md"] }] },
        color: "orange" }], model), /duplicate phase\/output target/);
});

test("badge placement pairs remain specific to their own phase and output", () => {
    const badge = { ...artifact, showIn: ["workflow-list"], phase: null,
        targets: [{ phase: "specify", output: "specs/<slug>/spec.md" },
            { phase: "plan", output: "specs/<slug>/plan.md" },
            { phase: "plan", output: null }] };
    assert.deepEqual(validateBadges([badge], model), [badge]);
    assert.throws(() => validateBadges([{ ...badge, targets: [
        { phase: "plan", output: "specs/<slug>/spec.md" }] }], model),
    /invalid phase\/output placement/);
    assert.throws(() => validateBadges([{ ...badge, targets: [
        badge.targets[0], badge.targets[0]] }], model), /duplicate phase\/output placement/);
    assert.throws(() => validateBadges([{ ...badge, showIn: ["phase-card"] }], model),
        /invalid phase\/output placements/);
    assert.throws(() => validateBadges([{ ...badge, type: "phase-only", text: "Done",
        inputs: { completion: "plan" }, targets: [
            { phase: "plan", output: "specs/<slug>/plan.md" }] }], {
        ...model, badgeRules: [...model.badgeRules,
            { id: "phase-only", inputs: [{ id: "completion", type: "phase" }] }],
        badgeTypes: [...model.badgeTypes,
            { id: "phase-only", rule: "phase-only", enabled: true }],
    }), /invalid phase\/output placement/);
});

test("per-placement text uses rule tokens on cards and workflow count only in summary", () => {
    const configured = { ...artifact, showIn: ["workflow-list", "workflow-summary"],
        phase: null, targets: [{ phase: "specify", output: null }],
        text: "List {status}", phaseText: "Phase {status}",
        summaryText: "Workflows in review ({workflows})" };
    assert.deepEqual(validateBadges([configured], model), [configured]);
    assert.throws(() => validateBadges([{ ...configured,
        summaryText: "Files ({status})" }], model), /invalid Workflow summary text/);
    assert.throws(() => validateBadges([{ ...configured,
        phaseText: "Phase {workflows}" }], model), /invalid Phase text/);
    assert.throws(() => validateBadges([{ ...configured,
        showIn: ["workflow-list"] }], model), /invalid Workflow summary text/);
    assert.throws(() => validateBadges([{ ...configured,
        targets: [] }], model), /invalid Phase text/);
    const { phaseText: _phaseText, summaryText: _summaryText, ...legacy } = configured;
    assert.doesNotThrow(() => validateBadges([{ ...legacy, id: "legacy" }], model));
});
