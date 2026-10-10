import assert from "node:assert/strict";
import { test } from "node:test";
import { mountBadges } from "../ui/badges-control.js";
import { declareMarkdownOutput } from "../ui/output-evidence.js";
import { mount as mountChecklistInputs } from
    "../../../../../spec-kit-extensions/extension-canvas-design/designer-host/badge-input-controls/checklist/designer.mjs";
import { mount as mountOrderedStaleInputs } from
    "../../../../../spec-kit-extensions/extension-canvas-design/designer-host/badge-input-controls/ordered-stale/designer.mjs";
import { mount as mountPhaseArtifactInputs, controlId as phaseArtifactControlId } from
    "../../../../../spec-kit-extensions/extension-canvas-design/designer-host/badge-input-controls/phase-artifact/designer.mjs";
import { mount as mountStockInputs, controlId, contractVersion } from
    "../../../../../spec-kit-extensions/extension-canvas-design/designer-host/badge-input-controls/stock/designer.mjs";
import { mount as mountPresetInputs } from
    "../../../../../tests/fixtures/test-presets/copilot-badge-input-test/designer/adapter.mjs";

class Node {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.events = {};
        this.textContent = "";
        this.className = "";
        this.dataset = {};
        this.style = {};
        this.attributes = {};
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = [...children]; }
    addEventListener(name, handler) { this.events[name] = handler; }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() { this.focused = true; }
    contains(node) { return descendants(this).includes(node); }
    querySelector(selector) {
        return descendants(this).find((node) => node.className.split(" ").includes(selector.slice(1)));
    }
}

function descendants(node) {
    return [node, ...node.children.flatMap(descendants)];
}

function setup({ phases = ["specify", "plan"], outputs = {
    specify: { outputs: ["other.md", "spec.md"], view: "spec.md" },
    plan: { outputs: ["plan.md"], view: "plan.md" },
}, badgeTypes = [{ id: "count", rule: "count", title: "Clarifications needed",
    description: "Counts markers", defaultText: "Clarifications needed ({count})",
    defaultColor: "amber", enabled: true }], badgeRules = [{
    id: "count", description: "Count distinct selected artifacts",
    textPlaceholders: ["count"], inputs: [{ id: "artifacts", type: "artifact-set" }],
}], draftBadges = [], controlMount = mountStockInputs, onDeclareFile } = {}) {
    const previous = globalThis.document;
    globalThis.document = { createElement: (tag) => new Node(tag) };
    const root = new Node("div");
    let changes = 0;
    const view = mountBadges({ root, page: { title: "Badges", description: "Add result badges" },
        phases, outputs, badgeTypes, badgeRules, draftBadges, controlMount, onDeclareFile,
        onChange() { changes++; } });
    return { root, view, draftBadges, changes: () => changes,
        cleanup: () => { globalThis.document = previous; } };
}

function choose(root, index = 0) {
    root.querySelector(".badge-add").events.click();
    assert.equal(root.querySelector(".badge-add"), undefined);
    assert.equal(root.querySelector(".badge-list"), undefined);
    const choices = descendants(root).filter((node) => node.className === "badge-type-choice");
    assert.equal(choices[index].tagName, "button");
    choices[index].events.click();
    assert.equal(root.querySelector(".badge-add"), undefined);
    assert.equal(root.querySelector(".badge-list"), undefined);
    return root.querySelector(".badge-editor");
}

function check(root, groupClass, name) {
    const group = root.querySelector(`.${groupClass}`);
    const label = descendants(group).find((node) => node.tagName === "label"
        && node.children[1]?.textContent === name);
    assert.ok(label, `${name} checkbox exists`);
    return label.children[0];
}

function placementText(root, name) {
    const label = descendants(root.querySelector(".badge-placements")).find((node) =>
        node.tagName === "label" && node.children[0]?.textContent === name);
    assert.ok(label, `${name} field exists`);
    return label.children[1];
}

function submit(editor) { editor.events.submit({ preventDefault() {} }); }

test("configured badges show their type alongside the instance name and placements", () => {
    const type = { id: "phase-artifact-complete", rule: "phase-artifact-complete",
        title: "Phase artifact complete", enabled: true };
    const badge = { id: "specify", type: type.id, inputs: {}, text: "Specify",
        showIn: ["workflow-list", "workflow-summary"], phase: null,
        targets: [{ phase: "specify", output: null }] };
    const { root, cleanup } = setup({ badgeTypes: [type],
        badgeRules: [{ id: type.rule, inputs: [] }], draftBadges: [badge] });
    try {
        const detail = root.querySelector(".badge-row").children[0];
        assert.equal(detail.children[0].textContent, "Specify");
        assert.equal(detail.children[1].textContent,
            "Phase artifact complete · Workflow list · Workflow summary · Specify phase card");
    } finally { cleanup(); }
});

test("stock input adapter exposes its contract and host requires an injected control", () => {
    assert.equal(controlId, "stock.badge-inputs");
    assert.equal(contractVersion, 1);
    const { root, draftBadges, changes, cleanup } = setup({ controlMount: null });
    try {
        const editor = choose(root);
        assert.ok(descendants(editor).some((node) => node.textContent
            === "Badge input controls are unavailable."));
        submit(editor);
        assert.equal(changes(), 0);
        assert.equal(draftBadges.length, 0);
        assert.match(descendants(editor).find((node) => node.attributes.role === "alert").textContent,
            /input controls are unavailable/);
    } finally { cleanup(); }
});

test("host accepts a custom input control without rendering rule-specific inputs", () => {
    let disposed = 0;
    const { root, draftBadges, cleanup } = setup({
        badgeTypes: [{ id: "custom", rule: "custom", title: "Custom",
            defaultText: "Ready", defaultColor: "green", enabled: true }],
        badgeRules: [{ id: "custom", inputs: [{ id: "phase", type: "phase" }] }],
        controlMount({ root: controlRoot, inputs, onChange }) {
            inputs.phase = "specify";
            const choice = document.createElement("output");
            choice.addEventListener("click", () => onChange({ phase: "plan" }));
            controlRoot.append(choice);
            return { isReady: () => true,
                dispose() { disposed++; } };
        },
    });

    try {
        const editor = choose(root);
        assert.equal(descendants(editor).filter((node) => node.tagName === "output").length, 1);
        assert.equal(root.querySelector(".badge-phase-list"), undefined);
        descendants(editor).find((node) => node.tagName === "output").events.click();
        submit(editor);
        assert.equal(disposed, 1);
        assert.equal(draftBadges[0].inputs.phase, "plan");
    } finally { cleanup(); }
});

test("host isolates adapter data and rejects missing or partial control updates", () => {
    let update;
    const phases = ["specify", "plan"];
    const outputs = {
        specify: { outputs: ["other.md", "spec.md"], view: "spec.md" },
        plan: { outputs: ["plan.md"], view: "plan.md" },
    };
    const badgeRules = [{ id: "custom", inputs: [{ id: "phase", type: "phase" },
        { id: "text", type: "text" }] }];
    const { root, draftBadges, cleanup } = setup({
        phases, outputs, badgeRules,
        badgeTypes: [{ id: "custom", rule: "custom", title: "Custom",
            defaultText: "Ready", defaultColor: "green", enabled: true }],
        controlMount({ rule, inputs, phases: choices, outputs: evidence, onChange }) {
            inputs.phase = "specify";
            inputs.text = "mutated";
            rule.inputs[0].id = "other";
            rule.inputs.push({ id: "extra", type: "text" });
            choices.splice(0, choices.length);
            evidence.specify.outputs.splice(0, evidence.specify.outputs.length);
            evidence.specify.view = "removed.md";
            update = onChange;
            return { isReady: () => true };
        },
    });
    try {
        const editor = choose(root);
        assert.deepEqual(badgeRules[0].inputs.map(({ id }) => id), ["phase", "text"]);
        assert.deepEqual(phases, ["specify", "plan"]);
        assert.deepEqual(outputs.specify,
            { outputs: ["other.md", "spec.md"], view: "spec.md" });
        update();
        assert.match(descendants(editor).find((node) => node.attributes.role === "alert").textContent,
            /do not match its rule/);
        submit(editor);
        assert.equal(draftBadges.length, 0);
        update({ phase: "plan" });
        submit(editor);
        assert.equal(draftBadges.length, 0);
        const replacement = { phase: "plan", text: "valid" };
        update(replacement);
        replacement.text = "mutated afterward";
        submit(editor);
        assert.deepEqual(draftBadges[0].inputs, { phase: "plan", text: "valid" });
        assert.deepEqual(outputs.specify.outputs, ["other.md", "spec.md"]);
    } finally { cleanup(); }
});

test("host rejects non-JSON-safe and invalid rule inputs before updating the badge draft", () => {
    let update;
    const { root, draftBadges, cleanup } = setup({
        badgeTypes: [{ id: "custom", rule: "custom", title: "Custom",
            defaultText: "Ready", defaultColor: "green", enabled: true }],
        badgeRules: [{ id: "custom", inputs: [
            { id: "phase", type: "phase" }, { id: "text", type: "text" },
            { id: "artifact", type: "artifact" },
            { id: "artifacts", type: "artifact-set" },
            { id: "ordered", type: "ordered-artifacts", before: "artifact" },
        ] }],
        controlMount({ onChange }) {
            update = onChange;
            return { isReady: () => true };
        },
    });
    try {
        const editor = choose(root);
        const valid = { phase: "plan", text: "Ready",
            artifact: { phase: "plan", output: "plan.md" },
            artifacts: [{ phase: "specify", outputs: ["spec.md"] }],
            ordered: [{ phase: "specify", output: "other.md" }] };
        const invalid = [
            { ...valid, phase: 42 },
            { ...valid, phase: "unknown" },
            { ...valid, text: 42 },
            { ...valid, artifact: { phase: "plan", output: "unknown.md" } },
            { ...valid, artifacts: [{ phase: "specify", outputs: ["unknown.md"] }] },
            { ...valid, ordered: [{ phase: "unknown", output: "other.md" }] },
            { ...valid, artifact: { phase: "plan", output: undefined } },
            { ...valid, text: Infinity },
            { ...valid, artifacts: [new Date()] },
        ];
        const cyclic = structuredClone(valid);
        cyclic.artifacts[0].self = cyclic;
        invalid.push(cyclic);
        const sparse = structuredClone(valid);
        sparse.ordered = new Array(1);
        invalid.push(sparse);
        const hidden = structuredClone(valid);
        Object.defineProperty(hidden.artifact, "extra", { value: "not serialized" });
        invalid.push(hidden);
        for (const inputs of invalid) {
            update(inputs);
            assert.match(descendants(editor).find((node) => node.attributes.role === "alert").textContent,
                /do not match its rule or available evidence/);
            submit(editor);
            assert.equal(draftBadges.length, 0);
        }
        update(valid);
        update({ ...valid, phase: "unknown" });
        submit(editor);
        assert.deepEqual(draftBadges[0].inputs, valid);
        assert.doesNotThrow(() => JSON.stringify(draftBadges));
    } finally { cleanup(); }
});

test("bubbled control events preserve invalid-input errors but host edits clear them", () => {
    let update;
    let input;
    const { root, cleanup } = setup({
        badgeTypes: [{ id: "custom", rule: "custom", title: "Custom",
            defaultText: "Ready", defaultColor: "green", enabled: true }],
        badgeRules: [{ id: "custom", inputs: [{ id: "phase", type: "phase" }] }],
        controlMount({ root: controlRoot, onChange }) {
            update = onChange;
            input = document.createElement("input");
            controlRoot.append(input);
            return { isReady: () => true };
        },
    });
    try {
        const editor = choose(root);
        const alert = descendants(editor).find((node) => node.attributes.role === "alert");
        update({ phase: "unavailable" });
        editor.events.change({ target: input });
        assert.match(alert.textContent, /available evidence/);
        assert.equal(alert.hidden, false);
        update({ phase: "plan" });
        assert.equal(alert.hidden, true);
        update({ phase: "unavailable" });
        editor.events.input({ target: editor.querySelector(".badge-preview") });
        assert.equal(alert.hidden, true);
    } finally { cleanup(); }
});

test("checklist control defaults to its evidence phase and permits independent placement", () => {
    const phases = ["draft", "review", "checklist", "publish"];
    const outputs = Object.fromEntries(phases.map((phase) => [phase,
        { outputs: phase === "publish" ? [] : [`${phase}.md`],
            view: phase === "publish" ? null : `${phase}.md` }]));
    const checklist = { id: "checklist-complete", description: "Current complete checklist",
        textPlaceholders: [], inputs: [{ id: "artifact", type: "artifact" },
            { id: "prerequisites", type: "ordered-artifacts", before: "artifact",
                scope: "metadata", minItems: 1 }, { id: "targetphase", type: "phase" }] };
    const type = { id: "checklist-complete", title: "Checklist complete",
        rule: checklist.id, defaultText: "Checklist complete", defaultColor: "green", enabled: true };
    const declarations = [];
    const { root, draftBadges, cleanup } = setup({
        phases, outputs, badgeTypes: [type], badgeRules: [checklist],
        controlMount: mountChecklistInputs,
        onDeclareFile(phase, path) {
            declarations.push([phase, path]);
            return declareMarkdownOutput(outputs, phases, phase, path);
        },
    });
    try {
        const editor = choose(root);
        assert.equal(editor.children[1].textContent, "When this badge appears");
        assert.equal(editor.children[2].textContent, checklist.description);
        assert.equal(editor.children[3].className, "badge-input-group");
        const selectors = descendants(editor.querySelector(".badge-input-controls"))
            .filter((node) => node.tagName === "select");
        assert.deepEqual(selectors.map((node) => node.value),
            ["checklist", "checklist", "checklist.md"]);
        submit(editor);
        assert.equal(draftBadges.length, 0);
        selectors[0].value = "publish";
        selectors[0].events.change();
        const checks = descendants(editor.querySelector(".badge-artifact-set"))
            .filter((node) => node.tagName === "input" && node.type === "checkbox");
        checks[0].checked = true;
        checks[0].events.change();
        const currentChecks = descendants(editor.querySelector(".badge-artifact-set"))
            .filter((node) => node.tagName === "input" && node.type === "checkbox");
        currentChecks[1].checked = true;
        currentChecks[1].events.change();
        assert.ok(descendants(root.querySelector(".badge-input-controls")).some((node) =>
            node.textContent === "Draft (draft.md) → Review (review.md) → Checklist (checklist.md)"));
        const phaseCard = check(root, "badge-placements", "Phase card");
        phaseCard.checked = true;
        phaseCard.events.change();
        submit(editor);
        assert.equal(draftBadges.length, 1);
        assert.deepEqual(draftBadges[0].targets, [{ phase: "publish", output: null }]);
        assert.deepEqual(draftBadges[0].inputs, {
            artifact: { phase: "checklist", output: "checklist.md" },
            prerequisites: [{ phase: "draft", output: "draft.md" },
                { phase: "review", output: "review.md" }], targetphase: "publish" });
        root.querySelector(".badge-edit").events.click();
        assert.equal(descendants(root.querySelector(".badge-editor")).some((node) =>
            node.textContent === "+ Declare a watched output"), false);
        const disclosure = root.querySelector(".badge-custom-file-disclosure");
        assert.equal(disclosure.tagName, "details");
        assert.equal(disclosure.open, false);
        assert.equal(disclosure.children[0].tagName, "summary");
        assert.equal(disclosure.children[0].textContent, "Use a checklist file not listed");
        disclosure.open = true;
        disclosure.events.toggle();
        assert.equal(disclosure.open, true);
        assert.equal(disclosure.children[1].textContent, "Add a Markdown file to the list");
        const form = root.querySelector(".badge-custom-file");
        assert.ok(form);
        const path = descendants(form).find((node) => node.tagName === "input");
        assert.equal(form.children[0].children[0].textContent, "Markdown file path");
        path.value = "specs/<slug>/more.md";
        descendants(form).find((node) => node.tagName === "button").events.click();
        assert.deepEqual(declarations, [["checklist", "specs/<slug>/more.md"]]);
        assert.equal(outputs.checklist.view, "checklist.md");
        assert.equal(descendants(root.querySelector(".badge-input-controls"))
            .find((node) => node.attributes["aria-label"] === "Checklist file").value,
        "specs/<slug>/more.md");
        assert.equal(root.querySelector(".badge-custom-file-disclosure").open, false);
    } finally { cleanup(); }
});

test("checklist help tracks selected phases and missing or incompatible declaration fails visibly", () => {
    const phases = ["tasks", "implement"];
    const outputs = { tasks: { outputs: ["tasks.md"], view: "tasks.md" },
        implement: { outputs: ["result.md"], view: "result.md" } };
    const rule = { id: "checklist-progress", inputs: [
        { id: "artifact", type: "artifact" },
        { id: "prerequisites", type: "ordered-artifacts", before: "artifact", minItems: 1 },
        { id: "targetphase", type: "phase" }] };
    const type = { id: "checklist-progress", rule: rule.id, title: "Checklist progress",
        defaultText: "Tasks: {completed}/{total}", defaultColor: "blue", enabled: true };
    for (const callback of [undefined, () => ({ tasks: { outputs: [], view: "tasks.md" } })]) {
        const { root, cleanup } = setup({ phases, outputs, badgeTypes: [type],
            badgeRules: [rule], controlMount: mountChecklistInputs, onDeclareFile: callback });
        try {
            choose(root);
            const control = root.querySelector(".badge-input-controls");
            const text = () => descendants(control).map((node) => node.textContent).join(" ");
            const field = (name) => descendants(control).find((node) =>
                node.tagName === "label" && node.children[0]?.textContent === name);
            assert.equal(field("Applies to phase").children[2].textContent,
                "This badge describes progress for the selected phase.");
            assert.equal(field("Checklist file").children[2].textContent,
                "Only this file's checkboxes are counted. The file does not need to exist yet.");
            assert.match(text(), /Select at least one upstream artifact/);
            const evidence = descendants(control).find((node) =>
                node.attributes["aria-label"] === "Evidence phase");
            evidence.value = "tasks";
            evidence.events.change();
            const target = descendants(control).find((node) =>
                node.attributes["aria-label"] === "Applies to phase");
            target.value = "implement";
            target.events.change();
            assert.equal(field("Evidence phase").children[2].textContent,
                "Tasks supplies the checklist used as evidence for Implement.");
            assert.match(text(), /Each upstream artifact must exist/);
            assert.match(text(), /Adds the selected Markdown file to the evidence phase/);
            const disclosure = control.querySelector(".badge-custom-file-disclosure");
            disclosure.open = true;
            disclosure.events.toggle();
            const form = control.querySelector(".badge-custom-file");
            descendants(form).find((node) => node.tagName === "input").value = "extra.md";
            descendants(form).find((node) => node.tagName === "button").events.click();
            assert.match(text(), callback ? /incompatible outputs/ : /unavailable in this Designer host/);
            assert.equal(outputs.tasks.outputs.length, 1);
        } finally { cleanup(); }
    }
});

test("inline watched-file declaration validates scope and leaves View artifact unchanged", () => {
    const phases = ["tasks", "implement", "constitution"];
    const outputs = { tasks: { outputs: ["tasks.md"], view: "tasks.md" },
        implement: { outputs: ["result.md"], view: "result.md" },
        constitution: { outputs: ["constitution.md"], view: "constitution.md" } };
    for (const [phase, path] of [["tasks", "../secret.md"], ["tasks", "TASKS.md"],
        ["tasks", "folder"], ["unknown", "extra.md"], ["constitution", "extra.md"]]) {
        assert.throws(() => declareMarkdownOutput(outputs, phases, phase, path));
    }
    assert.deepEqual(declareMarkdownOutput(outputs, phases, "tasks", "specs/<slug>/extra.md")
        .tasks.outputs, ["tasks.md", "specs/<slug>/extra.md"]);
    assert.equal(outputs.tasks.view, "tasks.md");
    outputs.implement.view = null;
    assert.deepEqual(declareMarkdownOutput(outputs, phases, "implement", "extra.md")
        .implement, { outputs: ["result.md", "extra.md"], view: null });
    assert.deepEqual(outputs.implement.outputs, ["result.md", "extra.md"]);
});

test("stock badge declares a Markdown file for a phase without a View target", () => {
    const phases = ["specify", "plan"];
    const outputs = { specify: { outputs: ["spec.md"], view: "spec.md" },
        plan: { outputs: [], view: null } };
    const type = { id: "file", rule: "file", title: "File", enabled: true,
        defaultText: "File", defaultColor: "blue" };
    const rule = { id: "file", inputs: [{ id: "artifact", type: "artifact" }] };
    const { root, draftBadges, cleanup } = setup({ phases, outputs,
        badgeTypes: [type], badgeRules: [rule],
        onDeclareFile: (phase, path) => declareMarkdownOutput(outputs, phases, phase, path) });
    try {
        const editor = choose(root);
        const group = editor.querySelector(".badge-input-controls");
        const plan = descendants(group).find((node) => node.tagName === "label"
            && node.children[1]?.textContent === "Plan");
        plan.children[0].checked = true;
        plan.children[0].events.change();
        const form = group.querySelector(".badge-custom-file");
        const input = descendants(form).find((node) => node.tagName === "input");
        const add = descendants(form).find((node) => node.tagName === "button");
        input.value = "../private.md";
        add.events.click();
        assert.match(group.querySelector(".badge-declaration-error").textContent, /safe relative/);
        assert.deepEqual(outputs.plan.outputs, []);
        input.value = "specs/<slug>/notes.md";
        add.events.click();
        assert.deepEqual(outputs.plan, { outputs: ["specs/<slug>/notes.md"], view: null });
        const option = descendants(group).find((node) => node.tagName === "label"
            && node.children[1]?.textContent === "specs/<slug>/notes.md");
        assert.equal(option.children[0].checked, true);
        submit(editor);
        assert.deepEqual(draftBadges[0].inputs.artifact,
            { phase: "plan", output: "specs/<slug>/notes.md" });
    } finally { cleanup(); }
});

test("stock artifact-set badge declares and selects a new file for its chosen phase", () => {
    const phases = ["specify", "plan"];
    const outputs = { specify: { outputs: ["spec.md"], view: "spec.md" },
        plan: { outputs: [], view: null } };
    const { root, draftBadges, cleanup } = setup({ phases, outputs,
        onDeclareFile: (phase, path) => declareMarkdownOutput(outputs, phases, phase, path) });
    try {
        const editor = choose(root);
        const group = editor.querySelector(".badge-input-controls");
        const phase = descendants(group).find((node) => node.attributes["aria-label"]
            === "File evidence phase");
        phase.value = "plan";
        const form = group.querySelector(".badge-custom-file");
        descendants(form).find((node) => node.tagName === "input").value = "plan-notes.md";
        descendants(form).find((node) => node.tagName === "button").events.click();
        assert.deepEqual(outputs.plan, { outputs: ["plan-notes.md"], view: null });
        submit(editor);
        assert.deepEqual(draftBadges[0].inputs.artifacts, [
            { phase: "specify", outputs: ["spec.md"] },
            { phase: "plan", outputs: ["plan-notes.md"] },
        ]);
    } finally { cleanup(); }
});

test("stock badge rejects an incompatible file declaration without accepting new evidence", () => {
    const phases = ["specify"];
    const outputs = { specify: { outputs: ["spec.md"], view: "spec.md" } };
    const { root, cleanup } = setup({ phases, outputs,
        badgeTypes: [{ id: "file", rule: "file", title: "File", enabled: true,
            defaultText: "File", defaultColor: "blue" }],
        badgeRules: [{ id: "file", inputs: [{ id: "artifact", type: "artifact" }] }],
        onDeclareFile: () => ({ specify: { outputs: ["wrong.md"], view: "spec.md" } }) });
    try {
        const editor = choose(root);
        const group = editor.querySelector(".badge-input-controls");
        const form = group.querySelector(".badge-custom-file");
        descendants(form).find((node) => node.tagName === "input").value = "notes.md";
        descendants(form).find((node) => node.tagName === "button").events.click();
        assert.match(group.querySelector(".badge-declaration-error").textContent, /incompatible outputs/);
        assert.deepEqual(outputs.specify.outputs, ["spec.md"]);
    } finally { cleanup(); }
});

test("disposed badge editors cannot declare watched files", () => {
    let declare;
    let calls = 0;
    const { root, cleanup } = setup({
        badgeTypes: [{ id: "file", rule: "file", title: "File", enabled: true,
            defaultText: "File", defaultColor: "blue" }],
        badgeRules: [{ id: "file", inputs: [{ id: "artifact", type: "artifact" }] }],
        controlMount({ onDeclareFile, onChange }) {
            declare = onDeclareFile;
            onChange({ artifact: { phase: "specify", output: "spec.md" } });
            return { isReady: () => true, handlesOutputDeclaration: true, dispose() {} };
        },
        onDeclareFile() { calls++; return {}; },
    });
    try {
        choose(root);
        descendants(root.querySelector(".badge-editor")).find((node) =>
            node.tagName === "button" && node.textContent === "Cancel").events.click();
        assert.throws(() => declare("specify", "extra.md"), /no longer active/);
        assert.equal(calls, 0);
    } finally { cleanup(); }
});

test("ordered stale control requires upstream evidence and keeps the target placement", () => {
    const phases = ["draft", "plan", "review"];
    const outputs = Object.fromEntries(phases.map((phase) => [phase,
        { outputs: [`${phase}.md`], view: `${phase}.md` }]));
    const rule = { id: "artifact-stale", description: "Upstream stale output",
        textPlaceholders: [], inputs: [
            { id: "artifact", type: "artifact", scope: "metadata" },
            { id: "prerequisites", type: "ordered-artifacts", scope: "metadata",
                before: "artifact", minItems: 1 }] };
    const type = { id: "artifact-stale", title: "Artifact stale", rule: rule.id,
        defaultText: "Artifact stale", defaultColor: "amber", enabled: true };
    const { root, draftBadges, cleanup } = setup({ phases, outputs, badgeTypes: [type],
        badgeRules: [rule], controlMount: mountOrderedStaleInputs });
    try {
        const editor = choose(root);
        assert.deepEqual(descendants(editor.querySelector(".badge-input-controls"))
            .filter((entry) => entry.tagName === "select").map((entry) => entry.value),
        ["review", "review.md"]);
        submit(editor);
        assert.equal(draftBadges.length, 0);
        const checks = descendants(editor.querySelector(".badge-artifact-set"))
            .filter((entry) => entry.tagName === "input" && entry.type === "checkbox");
        checks[0].checked = true;
        checks[0].events.change();
        const phaseCard = check(root, "badge-placements", "Phase card");
        phaseCard.checked = true;
        phaseCard.events.change();
        submit(editor);
        assert.deepEqual(draftBadges[0].targets, [{ phase: "review", output: null }]);
        assert.deepEqual(draftBadges[0].inputs, {
            artifact: { phase: "review", output: "review.md" },
            prerequisites: [{ phase: "draft", output: "draft.md" }] });
    } finally { cleanup(); }
});

test("disposed badge controls cannot update a redrawn editor or another badge", () => {
    const callbacks = [];
    const { root, view, draftBadges, cleanup } = setup({
        badgeTypes: [{ id: "custom", rule: "custom", title: "Custom",
            defaultText: "Ready", defaultColor: "green", enabled: true }],
        badgeRules: [{ id: "custom", inputs: [{ id: "phase", type: "phase" }] }],
        controlMount({ onChange }) {
            callbacks.push(onChange);
            onChange({ phase: "specify" });
            return { isReady: () => true, dispose() {} };
        },
    });
    try {
        choose(root);
        view.updateOutputs({ specify: { outputs: ["changed.md"], view: "changed.md" },
            plan: { outputs: ["plan.md"], view: "plan.md" } });
        callbacks[0]({ phase: "plan" });
        submit(root.querySelector(".badge-editor"));
        assert.equal(draftBadges[0].inputs.phase, "specify");
        root.querySelector(".badge-row").querySelector(".badge-edit").events.click();
        callbacks[1]({ phase: "plan" });
        submit(root.querySelector(".badge-editor"));
        assert.equal(draftBadges[0].inputs.phase, "specify");
        root.querySelector(".badge-row").querySelector(".badge-edit").events.click();
        root.querySelector(".badge-back").events.click();
        assert.doesNotThrow(() => callbacks[3]({ phase: "plan" }));
        assert.equal(draftBadges[0].inputs.phase, "specify");
    } finally { cleanup(); }
});

test("throwing disposal reports an error without blocking cancel, refresh, or save", () => {
    let disposals = 0;
    const { root, view, draftBadges, cleanup } = setup({
        badgeTypes: [{ id: "custom", rule: "custom", title: "Custom",
            defaultText: "Ready", defaultColor: "green", enabled: true }],
        badgeRules: [{ id: "custom", inputs: [{ id: "phase", type: "phase" }] }],
        controlMount({ onChange }) {
            onChange({ phase: "specify" });
            return { isReady: () => true, dispose() {
                disposals++;
                throw new Error("broken cleanup");
            } };
        },
    });
    const assertDisposalError = () => assert.match(descendants(root)
        .find((node) => node.attributes.role === "alert").textContent,
    /Could not dispose badge input control: broken cleanup/);
    try {
        choose(root);
        root.querySelector(".badge-editor").children.find((node) =>
            node.className === "badge-actions").children[1].events.click();
        assert.ok(root.querySelector(".badge-add"));
        assertDisposalError();

        choose(root);
        view.updateOutputs({ specify: { outputs: ["changed.md"], view: "changed.md" },
            plan: { outputs: ["plan.md"], view: "plan.md" } });
        assert.ok(root.querySelector(".badge-editor"));
        assertDisposalError();
        submit(root.querySelector(".badge-editor"));
        assert.equal(draftBadges.length, 1);
        assert.ok(root.querySelector(".badge-row"));
        assertDisposalError();
        assert.equal(disposals, 3);
    } finally { cleanup(); }
});

test("non-Error mount and disposal failures remain visible without aborting redraw", () => {
    let failMount = true;
    const { root, cleanup } = setup({
        controlMount({ onChange }) {
            if (failMount) throw null;
            onChange({ artifacts: [{ phase: "specify", outputs: ["spec.md"] }] });
            return { isReady: () => true, dispose() { throw undefined; } };
        },
    });
    try {
        choose(root);
        assert.match(descendants(root).find((node) => node.textContent
            ?.includes("Could not load badge input control")).textContent, /: null$/);
        failMount = false;
        root.querySelector(".badge-editor").children.find((node) =>
            node.className === "badge-actions").children[1].events.click();
        choose(root);
        root.querySelector(".badge-editor").children.find((node) =>
            node.className === "badge-actions").children[1].events.click();
        assert.ok(root.querySelector(".badge-add"));
        assert.match(descendants(root).find((node) => node.attributes.role === "alert").textContent,
            /Could not dispose badge input control: undefined/);
    } finally { cleanup(); }
});

test("throwing control readiness or validation reports inline errors without saving", () => {
    let failure = "readiness";
    const { root, draftBadges, cleanup } = setup({
        badgeTypes: [{ id: "custom", rule: "custom", title: "Custom",
            defaultText: "Ready", defaultColor: "green", enabled: true }],
        badgeRules: [{ id: "custom", inputs: [{ id: "phase", type: "phase" }] }],
        controlMount({ onChange }) {
            onChange({ phase: "specify" });
            return { isReady() {
                if (failure === "readiness") throw new Error("broken readiness");
                if (failure === "undefined") throw undefined;
                return failure !== "validation";
            }, validationError() {
                throw new Error("broken validation");
            } };
        },
    });

    test("throwing readiness getter stays in the badge editor instead of aborting redraw", () => {
        let reads = 0;
        const { root, draftBadges, cleanup } = setup({
            badgeTypes: [{ id: "custom", rule: "custom", title: "Custom",
                defaultText: "Ready", defaultColor: "green", enabled: true }],
            badgeRules: [{ id: "custom", inputs: [{ id: "phase", type: "phase" }] }],
            controlMount({ onChange }) {
                onChange({ phase: "specify" });
                return { get isReady() {
                    reads++;
                    throw new Error("broken readiness getter");
                } };
            },
        });
        try {
            const editor = choose(root);
            assert.match(descendants(editor).find((node) => node.textContent
                ?.includes("Could not load badge input control")).textContent,
            /broken readiness getter/);
            assert.doesNotThrow(() => submit(editor));
            assert.equal(reads, 1);
            assert.equal(draftBadges.length, 0);
            assert.match(descendants(editor).find((node) => node.attributes.role === "alert").textContent,
                /input controls are unavailable/);
        } finally { cleanup(); }
    });
    try {
        const editor = choose(root);
        assert.doesNotThrow(() => submit(editor));
        assert.equal(draftBadges.length, 0);
        assert.match(descendants(editor).find((node) => node.attributes.role === "alert").textContent,
            /Badge input control readiness failed: broken readiness/);
        failure = "undefined";
        assert.doesNotThrow(() => submit(editor));
        assert.equal(draftBadges.length, 0);
        assert.match(descendants(editor).find((node) => node.attributes.role === "alert").textContent,
            /Badge input control readiness failed: undefined/);
        failure = "validation";
        assert.doesNotThrow(() => submit(editor));
        assert.equal(draftBadges.length, 0);
        assert.match(descendants(editor).find((node) => node.attributes.role === "alert").textContent,
            /Badge input control readiness failed: broken validation/);
        failure = null;
        submit(editor);
        assert.equal(draftBadges.length, 1);
    } finally { cleanup(); }
});

test("badge submission requires a literal true readiness result", () => {
    let readiness = Promise.resolve(false);
    const { root, draftBadges, cleanup } = setup({
        badgeTypes: [{ id: "custom", rule: "custom", title: "Custom",
            defaultText: "Ready", defaultColor: "green", enabled: true }],
        badgeRules: [{ id: "custom", inputs: [{ id: "phase", type: "phase" }] }],
        controlMount({ onChange }) {
            onChange({ phase: "specify" });
            return { isReady: () => readiness };
        },
    });
    try {
        const editor = choose(root);
        for (const result of [Promise.resolve(false), Promise.resolve(true), 1, "ready"]) {
            readiness = result;
            submit(editor);
            assert.equal(draftBadges.length, 0);
            assert.match(descendants(editor).find((node) => node.attributes.role === "alert").textContent,
                /Complete the badge inputs/);
        }
        readiness = true;
        submit(editor);
        assert.equal(draftBadges.length, 1);
    } finally { cleanup(); }
});

test("preset control initializes, edits, and reopens its own labeled phase input", () => {
    const badgeTypes = [{ id: "test-phase", rule: "test-phase", title: "Phase confirmed",
        defaultText: "Phase confirmed", defaultColor: "purple", enabled: true }];
    const badgeRules = [{ id: "test-phase", inputs: [{ id: "phase", type: "phase" }] }];
    const badges = [];
    const { root, cleanup } = setup({ phases: ["speckit.constitution", "specify", "plan"],
        badgeTypes, badgeRules, draftBadges: badges, controlMount: mountPresetInputs });
    try {
        const editor = choose(root);
        const select = descendants(editor).find((node) => node.tagName === "select"
            && node.attributes["aria-label"] === "Phase to confirm");
        assert.ok(select);
        assert.ok(descendants(editor).some((node) => node.textContent.includes(
            "only after the selected phase")));
        assert.equal(select.value, "speckit.constitution");
        const card = check(root, "badge-placements", "Phase");
        card.checked = true;
        card.events.change();
        assert.equal(card.checked, true);
        submit(editor);
        assert.equal(badges[0].inputs.phase, "speckit.constitution");
        assert.deepEqual(badges[0].targets, [{ phase: "speckit.constitution", output: null }]);
        root.querySelector(".badge-row").querySelector(".badge-edit").events.click();
        const edited = root.querySelector(".badge-editor");
        const editSelect = descendants(edited).find((node) => node.tagName === "select"
            && node.attributes["aria-label"] === "Phase to confirm");
        assert.equal(editSelect.value, "speckit.constitution");
        editSelect.value = "plan";
        editSelect.events.change();
        submit(edited);
        assert.equal(badges[0].inputs.phase, "plan");
        assert.deepEqual(badges[0].targets, [{ phase: "plan", output: null }]);
        root.querySelector(".badge-row").querySelector(".badge-edit").events.click();
        const reopened = root.querySelector(".badge-editor");
        assert.equal(descendants(reopened).find((node) => node.tagName === "select"
            && node.attributes["aria-label"] === "Phase to confirm").value, "plan");
    } finally { cleanup(); }
});

test("preset control remains incomplete when there are no available phases", () => {
    const { root, draftBadges, cleanup } = setup({
        phases: [], outputs: {},
        badgeTypes: [{ id: "test-phase", rule: "test-phase", title: "Phase confirmed",
            defaultText: "Phase confirmed", defaultColor: "purple", enabled: true }],
        badgeRules: [{ id: "test-phase", inputs: [{ id: "phase", type: "phase" }] }],
        controlMount: mountPresetInputs,
    });
    try {
        const editor = choose(root);
        submit(editor);
        assert.equal(draftBadges.length, 0);
        assert.match(descendants(editor).find((node) => node.attributes.role === "alert").textContent,
            /Complete the badge inputs/);
    } finally { cleanup(); }
});

test("refreshing confirmed outputs updates cached choices without losing the badge editor", () => {
    const outputs = { specify: { outputs: ["spec.md"], view: "spec.md" } };
    const { root, view, draftBadges, cleanup } = setup({ phases: ["specify"], outputs });
    try {
        const editor = choose(root);
        view.updateOutputs(outputs);
        assert.equal(root.querySelector(".badge-editor"), editor);
        const text = placementText(root, "Workflow list text");
        text.value = "Still editing {count}";
        text.events.input();
        outputs.specify.outputs.push("new.md");
        view.updateOutputs(outputs);
        assert.equal(placementText(root, "Workflow list text").value, "Still editing {count}");
        assert.ok(check(root, "badge-artifact-set", "new.md"));
        outputs.specify.outputs.splice(0, 1);
        view.updateOutputs(outputs);
        assert.ok(descendants(root).some((node) => node.textContent.includes(
            "Some selected evidence outputs are no longer confirmed")));
        const added = check(root, "badge-artifact-set", "new.md");
        added.checked = true;
        added.events.change();
        submit(root.querySelector(".badge-editor"));
        assert.equal(draftBadges[0].text, "Still editing {count}");
        assert.deepEqual(draftBadges[0].inputs.artifacts,
            [{ phase: "specify", outputs: ["new.md"] }]);
    } finally { cleanup(); }
});

const checklistType = { id: "checklist-complete", rule: "checklist-complete",
    title: "Checklist complete", defaultText: "Checklist complete",
    defaultColor: "green", enabled: true };
const checklistRule = { id: "checklist-complete", placementPhaseInput: "artifact",
    textPlaceholders: [], inputs: [
    { id: "artifact", type: "artifact", label: "Checklist output" },
    { id: "prerequisite", type: "artifact", label: "Earlier output" },
] };

test("Constitution evidence selects its project card and follows edited phases", () => {
    const phase = "speckit.constitution";
    const { root, draftBadges, cleanup } = setup({
        phases: [phase, "speckit.specify"],
        outputs: { [phase]: { outputs: [".specify/memory/constitution.md"] },
            "speckit.specify": { outputs: ["specs/<slug>/spec.md"] } },
        badgeTypes: [{ id: "constitution-run", rule: "constitution-run",
            title: "Constitution run", defaultText: "Ready", defaultColor: "green", enabled: true }],
        badgeRules: [{ id: "constitution-run", inputs: [{ id: "phase", type: "phase" }],
            textPlaceholders: [] }],
    });
    try {
        const editor = choose(root);
        const evidence = descendants(root.querySelector(".badge-phase-list"))
            .filter((node) => node.tagName === "input");
        evidence[0].checked = true;
        evidence[0].events.change();
        const card = check(root, "badge-placements", "Phase");
        card.checked = true;
        card.events.change();
        assert.equal(card.checked, true);
        evidence[1].checked = true;
        evidence[1].events.change();
        card.checked = true;
        card.events.change();
        assert.equal(card.checked, true);
        evidence[0].checked = true;
        evidence[0].events.change();
        assert.equal(card.checked, true);
        submit(editor);
        assert.equal(draftBadges[0].inputs.phase, phase);
        assert.deepEqual(draftBadges[0].targets, [{ phase, output: null }]);
    } finally { cleanup(); }
});

test("Phase artifact editor follows target and one earlier output per checked phase", () => {
    const { root, draftBadges, changes, cleanup } = setup({
        phases: ["specify", "plan", "tasks"],
        outputs: { specify: { outputs: ["spec.md", "notes.md"], view: "spec.md" },
            plan: { outputs: ["plan.md", "research.md"], view: "plan.md" },
            tasks: { outputs: ["tasks.md"], view: "tasks.md" } },
        badgeTypes: [{ id: "phase-artifact-complete", rule: "phase-artifact-complete",
            title: "Phase artifact complete", description: "Check ordered outputs",
            defaultText: "Phase complete", defaultColor: "green", enabled: true }],
        badgeRules: [{ id: "phase-artifact-complete",
            description: "The selected output must exist. If earlier outputs are selected, they must also exist, and each later file must be at least as recent as the one before it.",
            textPlaceholders: [],
            placementPhaseInput: "target",
            inputs: [{ id: "target", type: "artifact", scope: "metadata" },
                { id: "prerequisites", type: "ordered-artifacts", scope: "metadata",
                    before: "target" }] }],
        controlMount: mountPhaseArtifactInputs,
    });
    try {
        const editor = choose(root);
        const nodes = () => descendants(editor);
        const select = (label) => nodes().find((node) => node.tagName === "select"
            && node.attributes["aria-label"] === label);
        const header = (title) => nodes().find((node) => node.tagName === "h3"
            && node.textContent === title);
        assert.ok(header("Phase and output to check"));
        assert.ok(header("Upstream artifacts to check"));
        assert.ok(header("When this badge appears"));
        assert.ok(header("Where should it appear?"));
        assert.equal(editor.children[2].textContent,
            "The selected output must exist. If earlier outputs are selected, they must also exist, and each later file must be at least as recent as the one before it.");
        assert.equal(phaseArtifactControlId, "stock.phase-artifact-inputs");
        assert.equal(nodes().find((node) => node.tagName === "label"
            && node.children[0]?.textContent === "Target phase").children[2].textContent,
        "Choose the phase whose output this badge checks.");
        assert.equal(nodes().find((node) => node.tagName === "label"
            && node.children[0]?.textContent === "Required output").children[2].textContent,
        "This file must exist for the badge to appear.");
        assert.ok(nodes().some((node) => node.textContent === "Specify (spec.md) — target output only"));
        assert.equal(editor.querySelector(".badge-custom-file-disclosure").open, false);
        assert.equal(nodes().some((node) => node.textContent === "+ Declare a watched output"), false);
        select("Target phase").value = "tasks";
        select("Target phase").events.change();
        const checkbox = (name) => descendants(editor.querySelector(".badge-artifact-set"))
            .find((node) => node.tagName === "label"
            && node.children[1]?.textContent === name).children[0];
        checkbox("Specify").checked = true;
        checkbox("Specify").events.change();
        checkbox("Plan").checked = true;
        checkbox("Plan").events.change();
        select("Plan output").value = "research.md";
        select("Plan output").events.change();
        assert.ok(nodes().some((node) =>
            node.textContent === "Specify (spec.md) → Plan (research.md) → Tasks (tasks.md)"));
        select("Target phase").value = "plan";
        select("Target phase").events.change();
        assert.ok(nodes().some((node) => node.textContent === "Plan (plan.md) — target output only"));
        select("Target phase").value = "tasks";
        select("Target phase").events.change();
        checkbox("Specify").checked = true;
        checkbox("Specify").events.change();
        checkbox("Plan").checked = true;
        checkbox("Plan").events.change();
        select("Plan output").value = "research.md";
        select("Plan output").events.change();
        check(root, "badge-placements", "Phase card").checked = true;
        check(root, "badge-placements", "Phase card").events.change();
        placementText(root, "Phase card text").value = "Tasks are ready";
        placementText(root, "Phase card text").events.input();
        placementText(root, "Workflow list text").value = "Workflow ready";
        placementText(root, "Workflow list text").events.input();
        check(root, "badge-placements", "Workflow summary").checked = true;
        check(root, "badge-placements", "Workflow summary").events.change();
        placementText(root, "Workflow summary text").value = "{workflows} ready";
        placementText(root, "Workflow summary text").events.input();
        submit(editor);
        assert.equal(changes(), 1);
        assert.deepEqual(draftBadges[0].inputs, {
            target: { phase: "tasks", output: "tasks.md" },
            prerequisites: [{ phase: "specify", output: "spec.md" },
                { phase: "plan", output: "research.md" }],
        });
        assert.deepEqual(draftBadges[0].targets, [{ phase: "tasks", output: null }]);
        assert.equal(draftBadges[0].text, "Workflow ready");
        assert.equal(draftBadges[0].phaseText, "Tasks are ready");
        assert.equal(draftBadges[0].summaryText, "{workflows} ready");
    } finally { cleanup(); }
});

test("Phase artifact editor declares a target file inline without changing View artifact", () => {
    const phases = ["specify", "plan"];
    const outputs = { specify: { outputs: ["spec.md"], view: "spec.md" },
        plan: { outputs: ["plan.md"], view: "plan.md" } };
    const rule = { id: "phase-artifact-complete", placementPhaseInput: "target",
        inputs: [{ id: "target", type: "artifact", scope: "metadata" },
            { id: "prerequisites", type: "ordered-artifacts", scope: "metadata",
                before: "target" }] };
    const type = { id: rule.id, rule: rule.id, title: "Phase artifact complete",
        defaultText: "Phase complete", defaultColor: "green", enabled: true };
    const { root, draftBadges, cleanup } = setup({ phases, outputs,
        badgeTypes: [type], badgeRules: [rule], controlMount: mountPhaseArtifactInputs,
        onDeclareFile(phase, path) {
            return declareMarkdownOutput(outputs, phases, phase, path);
        } });
    try {
        const editor = choose(root);
        const select = (label) => descendants(editor).find((node) =>
            node.attributes["aria-label"] === label);
        select("Target phase").value = "plan";
        select("Target phase").events.change();
        const disclosure = root.querySelector(".badge-custom-file-disclosure");
        assert.equal(disclosure.tagName, "details");
        assert.equal(disclosure.open, false);
        assert.equal(disclosure.children[0].textContent, "Use an output file not listed");
        disclosure.open = true;
        disclosure.events.toggle();
        assert.equal(disclosure.children[1].textContent, "Add a Markdown file to the list");
        const form = root.querySelector(".badge-custom-file");
        assert.equal(form.children[0].children[0].textContent, "Markdown file path");
        descendants(form).find((node) => node.tagName === "input").value =
            "specs/<slug>/extra.md";
        descendants(form).find((node) => node.tagName === "button").events.click();
        assert.deepEqual(outputs.plan.outputs, ["plan.md", "specs/<slug>/extra.md"]);
        assert.equal(outputs.plan.view, "plan.md");
        assert.equal(select("Required output").value, "specs/<slug>/extra.md");
        assert.equal(root.querySelector(".badge-custom-file-disclosure").open, false);
        assert.ok(descendants(editor).some((node) =>
            node.textContent === "Plan (extra.md) — target output only"));
        check(root, "badge-placements", "Phase card").checked = true;
        check(root, "badge-placements", "Phase card").events.change();
        submit(editor);
        assert.deepEqual(draftBadges[0].inputs,
            { target: { phase: "plan", output: "specs/<slug>/extra.md" }, prerequisites: [] });
        assert.deepEqual(draftBadges[0].targets, [{ phase: "plan", output: null }]);
    } finally { cleanup(); }
});

test("Phase artifact editor rejects incompatible rule and file declaration responses", () => {
    const rule = { id: "phase-artifact-complete", inputs: [
        { id: "target", type: "artifact", scope: "metadata" },
        { id: "prerequisites", type: "ordered-artifacts", scope: "metadata",
            before: "target" }] };
    const type = { id: rule.id, rule: rule.id, title: "Phase artifact complete",
        defaultText: "Phase complete", defaultColor: "green", enabled: true };
    const phases = ["specify", "plan"];
    const outputs = { specify: { outputs: ["spec.md"], view: "spec.md" },
        plan: { outputs: ["plan.md"], view: "plan.md" } };
    for (const callback of [undefined, () => ({
        specify: { outputs: [], view: "spec.md" },
        plan: { outputs: ["plan.md"], view: "plan.md" },
    })]) {
        const { root, cleanup } = setup({ phases, outputs, badgeTypes: [type],
            badgeRules: [rule], controlMount: mountPhaseArtifactInputs, onDeclareFile: callback });
        try {
            choose(root);
            const disclosure = root.querySelector(".badge-custom-file-disclosure");
            disclosure.open = true;
            disclosure.events.toggle();
            const form = root.querySelector(".badge-custom-file");
            descendants(form).find((node) => node.tagName === "input").value = "extra.md";
            descendants(form).find((node) => node.tagName === "button").events.click();
            assert.ok(descendants(root.querySelector(".badge-input-controls")).some((node) =>
                node.textContent.includes(callback ? "incompatible outputs"
                    : "unavailable in this Designer host")));
            assert.equal(outputs.specify.outputs.length, 1);
        } finally { cleanup(); }
    }
    const previous = globalThis.document;
    globalThis.document = { createElement: (tag) => new Node(tag) };
    try {
        assert.throws(() => mountPhaseArtifactInputs({ root: new Node("div"),
            rule: { ...rule, inputs: [rule.inputs[0],
                { ...rule.inputs[1], minItems: 1 }] },
            inputs: {}, phases, outputs, onChange() {} }), /optional ordered upstream/);
    } finally { globalThis.document = previous; }
});

test("Value match requires user-provided text and selects a single output", () => {
    const { root, draftBadges, changes, cleanup } = setup({
        badgeTypes: [{ id: "value-match", rule: "value-match", title: "Value match",
            defaultText: "Value matched", defaultColor: "amber", enabled: true }],
        badgeRules: [{ id: "value-match", textPlaceholders: [], inputs: [
            { id: "artifact", type: "artifact", label: "Output to search" },
            { id: "value", type: "text", label: "Text to match" },
        ] }],
    });
    try {
        const editor = choose(root);
        const input = descendants(editor).find((node) =>
            node.tagName === "label" && node.children[0]?.textContent === "Text to match").children[1];
        submit(editor);
        assert.equal(changes(), 0);
        assert.match(editor.querySelector(".badge-editor-error").textContent,
            /Enter text to match/);
        input.value = "Verdict: needs-clarification";
        input.events.input();
        submit(editor);
        assert.equal(changes(), 1);
        assert.deepEqual(draftBadges[0].inputs, { artifact: { phase: "specify", output: "spec.md" },
            value: "Verdict: needs-clarification" });
    } finally { cleanup(); }
});

test("Checklist complete uses two labeled outputs and requires a confirmed earlier one", () => {
    const { root, draftBadges, changes, cleanup } = setup({
        badgeTypes: [checklistType], badgeRules: [checklistRule],
    });
    try {
        const editor = choose(root);
        assert.ok(descendants(editor).some((node) => node.textContent === "Checklist output"));
        assert.ok(descendants(editor).some((node) => node.textContent === "Earlier output"));
        const groups = descendants(editor).filter((node) => node.className === "badge-phase-list");
        const phase = (name) => descendants(groups[1]).find((node) =>
            node.tagName === "label" && node.children[1]?.textContent === name).children[0];
        const plan = phase("Plan");
        plan.checked = true;
        plan.events.change();
        submit(editor);
        assert.equal(changes(), 0);
        assert.match(editor.querySelector(".badge-editor-error").textContent,
            /earlier output/);
        const specify = phase("Specify");
        specify.checked = true;
        specify.events.change();
        submit(editor);
        assert.equal(changes(), 1);
        assert.deepEqual(draftBadges[0].inputs, {
            artifact: { phase: "plan", output: "plan.md" },
            prerequisite: { phase: "specify", output: "spec.md" },
        });
    } finally { cleanup(); }

    const noEarlier = setup({ phases: ["plan"], outputs: {
        plan: { outputs: ["plan.md"], view: "plan.md" },
    }, badgeTypes: [checklistType], badgeRules: [checklistRule] });
    try {
        const editor = choose(noEarlier.root);
        submit(editor);
        assert.equal(noEarlier.changes(), 0);
        assert.equal(noEarlier.draftBadges.length, 0);
        assert.match(editor.querySelector(".badge-editor-error").textContent,
            /confirmed output/);
    } finally { noEarlier.cleanup(); }
});

test("editing an older Checklist complete badge requires selecting its missing earlier output", () => {
    const saved = { id: "old", type: "checklist-complete",
        inputs: { artifact: { phase: "plan", output: "plan.md" } },
        text: "Checklist complete", color: "green", showIn: ["workflow-list"], phase: null };
    const { root, draftBadges, changes, cleanup } = setup({
        badgeTypes: [checklistType], badgeRules: [checklistRule], draftBadges: [saved],
    });
    try {
        root.querySelector(".badge-edit").events.click();
        const editor = root.querySelector(".badge-editor");
        submit(editor);
        assert.equal(changes(), 0);
        assert.match(editor.querySelector(".badge-editor-error").textContent,
            /confirmed output/);
        const groups = descendants(editor).filter((node) => node.className === "badge-phase-list");
        const specify = descendants(groups[1]).find((node) =>
            node.tagName === "label" && node.children[1]?.textContent === "Specify").children[0];
        specify.checked = true;
        specify.events.change();
        submit(editor);
        assert.equal(changes(), 1);
        assert.deepEqual(draftBadges[0].inputs.prerequisite,
            { phase: "specify", output: "spec.md" });
    } finally { cleanup(); }
});

test("catalog groups artifact states and orders checklist progress before completion", () => {
    const ids = ["value-match", "artifact-current", "checklist-complete",
        "checklist-progress", "phase-run-complete", "artifact-stale", "custom"];
    const badgeTypes = ids.map((id) => ({ id, rule: id, title: id, enabled: true }));
    const badgeRules = ids.map((id) => ({ id, inputs: [], textPlaceholders: [] }));
    const { root, cleanup } = setup({ badgeTypes, badgeRules });
    try {
        root.querySelector(".badge-add").events.click();
        const choices = descendants(root).filter((node) => node.className === "badge-type-choice");
        assert.deepEqual(choices.map((node) => node.attributes["aria-label"]), [
            "value-match", "artifact-current", "artifact-stale",
            "checklist-progress", "checklist-complete",
            "phase-run-complete", "custom",
        ]);
        assert.deepEqual(badgeTypes.map((type) => type.id), ids);
    } finally {
        cleanup();
    }
});

test("list, picker, and editor are separate screens with one primary action each", () => {
    const { root, draftBadges, changes, cleanup } = setup();
    try {
        assert.equal(root.querySelector(".badge-add").textContent, "+ Add badge");
        assert.equal(root.querySelector(".badge-editor"), undefined);
        root.querySelector(".badge-add").events.click();
        assert.equal(root.querySelector(".badge-list"), undefined);
        assert.equal(root.querySelector(".badge-add"), undefined);
        assert.ok(descendants(root).some((node) => node.textContent === "Choose a badge type"));
        const choice = root.querySelector(".badge-type-choice");
        assert.equal(choice.children[0].textContent, "Clarifications needed");
        assert.equal(choice.attributes["aria-label"], "Clarifications needed");
        assert.ok(!descendants(root).some((node) => node.textContent === "Choose Clarifications needed"));
        choice.events.click();
        const editor = root.querySelector(".badge-editor");
        assert.equal(root.querySelector(".badge-list"), undefined);
        assert.equal(root.querySelector(".badge-add"), undefined);
        assert.ok(descendants(editor).some((node) => node.textContent === "Create badge"));
        assert.equal(descendants(editor).filter((node) => node.textContent === "Add badge").length, 0);
        const fields = descendants(editor);
        assert.ok(fields.findIndex((node) => node.textContent === "Phases and outputs")
            < fields.findIndex((node) => node.textContent === "Where to show this badge"));
        assert.ok(fields.findIndex((node) => node.textContent === "Where to show this badge")
            < fields.findIndex((node) => node.textContent === "Workflow list text"));
        assert.deepEqual(draftBadges, []);
        assert.equal(changes(), 0);
        submit(editor);
        assert.equal(changes(), 1);
        assert.deepEqual(draftBadges[0].inputs.artifacts,
            [{ phase: "specify", outputs: ["spec.md"] }]);
        assert.ok(root.querySelector(".badge-add"));
        assert.ok(root.querySelector(".badge-list"));
    } finally { cleanup(); }
});

test("Add badge blocks duplicate targets and links to the existing badge editor", () => {
    const { root, draftBadges, changes, cleanup } = setup();
    try {
        submit(choose(root));
        const existing = draftBadges[0];
        existing.color = "purple";
        existing.showIn = ["workflow-summary"];
        const editor = choose(root);
        submit(editor);
        assert.equal(draftBadges.length, 1);
        assert.equal(changes(), 1);
        assert.equal(editor.querySelector(".badge-editor-error").textContent,
            "This badge already has the same text and evidence at this phase/output. Edit it or change the text.");
        const link = root.querySelector(".badge-duplicate-edit");
        assert.equal(link.hidden, false);
        link.events.click();
        assert.equal(root.querySelector(".badge-editor-heading").focused, true);
        assert.ok(descendants(root).some((node) => node.textContent === "Save changes"));
        assert.deepEqual(draftBadges, [existing]);
    } finally { cleanup(); }
});

test("Add badge allows different text with the same evidence and phase placement", () => {
    const existing = { id: "existing", type: "count",
        inputs: { artifacts: [{ phase: "specify", outputs: ["spec.md"] }] },
        text: "Clarifications needed ({count})", color: "green",
        phaseText: "Clarifications needed ({count})",
        showIn: ["workflow-list"], phase: null,
        targets: [{ phase: "specify", output: null }] };
    const { root, draftBadges, changes, cleanup } = setup({ draftBadges: [existing] });
    try {
        const editor = choose(root);
        const phase = check(root, "badge-placements", "Phase");
        phase.checked = true;
        phase.events.change();
        submit(editor);
        assert.equal(draftBadges.length, 1);
        assert.equal(root.querySelector(".badge-duplicate-edit").hidden, false);
        const text = placementText(root, "Workflow list text");
        text.value = "Specify needs review ({count})";
        text.events.input();
        submit(editor);
        assert.equal(draftBadges.length, 2);
        assert.equal(changes(), 1);
        assert.equal(draftBadges[1].text, "Specify needs review ({count})");
        assert.deepEqual(draftBadges[1].targets, [{ phase: "specify", output: null }]);
    } finally { cleanup(); }
});

test("each checked placement edits its own text and summary uses workflow count", () => {
    const { root, draftBadges, cleanup } = setup();
    try {
        const editor = choose(root);
        const list = placementText(root, "Workflow list text");
        assert.equal(list.value, "Clarifications needed ({count})");
        const summary = check(root, "badge-placements", "Workflow summary");
        summary.checked = true;
        summary.events.change();
        const summaryLabel = placementText(root, "Workflow summary text");
        assert.equal(summaryLabel.value, "Clarifications needed ({workflows} workflows)");
        const phase = check(root, "badge-placements", "Phase");
        phase.checked = true;
        phase.events.change();
        const phaseLabel = placementText(root, "Phase text");
        assert.equal(phaseLabel.value, list.value);
        list.value = "List ({count})";
        list.events.input();
        phaseLabel.value = "Phase ({count})";
        phaseLabel.events.input();
        summaryLabel.value = "Workflows with checklists ({count})";
        summaryLabel.events.input();
        submit(editor);
        assert.deepEqual(draftBadges, []);
        assert.match(editor.querySelector(".badge-editor-error").textContent,
            /Workflow summary text/);
        summaryLabel.value = "Workflows with checklists ({workflows})";
        summaryLabel.events.input();
        submit(editor);
        assert.deepEqual(draftBadges[0].text, "List ({count})");
        assert.equal(draftBadges[0].phaseText, "Phase ({count})");
        assert.equal(draftBadges[0].summaryText, "Workflows with checklists ({workflows})");
        root.querySelector(".badge-edit").events.click();
        assert.equal(placementText(root, "Workflow list text").value, "List ({count})");
        assert.equal(placementText(root, "Phase text").value, "Phase ({count})");
        assert.equal(placementText(root, "Workflow summary text").value,
            "Workflows with checklists ({workflows})");
    } finally { cleanup(); }
});

test("back navigation and Cancel leave the badge draft untouched", () => {
    const { root, draftBadges, cleanup } = setup();
    try {
        root.querySelector(".badge-add").events.click();
        root.querySelector(".badge-back").events.click();
        assert.ok(root.querySelector(".badge-add"));
        const editor = choose(root);
        root.querySelector(".badge-back").events.click();
        assert.ok(root.querySelector(".badge-type-choice"));
        root.querySelector(".badge-type-choice").events.click();
        assert.ok(root.querySelector(".badge-editor"));
        descendants(root).find((node) => node.textContent === "Cancel").events.click();
        assert.ok(root.querySelector(".badge-add"));
        assert.deepEqual(draftBadges, []);
        assert.equal(editor.tagName, "form");
    } finally { cleanup(); }
});

test("phase selection nests outputs and Phase placement follows selected phases", () => {
    const { root, draftBadges, cleanup } = setup();
    try {
        const editor = choose(root);
        const evidence = root.querySelector(".badge-artifact-set");
        const specify = check(evidence, "badge-artifact-set", "Specify");
        const plan = check(evidence, "badge-artifact-set", "Plan");
        assert.equal(specify.checked, true);
        assert.equal(plan.checked, false);
        const outputLists = descendants(evidence).filter((node) =>
            node.className === "badge-output-list");
        assert.equal(outputLists[0].hidden, false);
        assert.equal(outputLists[1].hidden, true);
        plan.checked = true;
        plan.events.change();
        assert.equal(outputLists[1].hidden, false);
        assert.equal(check(evidence, "badge-artifact-set", "plan.md").checked, true);
        const phase = check(root, "badge-placements", "Phase");
        phase.checked = true;
        phase.events.change();
        specify.checked = false;
        specify.events.change();
        assert.equal(outputLists[0].hidden, true);
        submit(editor);
        assert.deepEqual(draftBadges[0].inputs.artifacts,
            [{ phase: "plan", outputs: ["plan.md"] }]);
        assert.deepEqual(draftBadges[0].targets, [{ phase: "plan", output: null }]);
        assert.ok(descendants(root).some((node) => node.textContent.includes("Plan phase card")));
    } finally { cleanup(); }
});

test("output checkboxes add evidence without automatically adding placements", () => {
    const { root, draftBadges, cleanup } = setup();
    try {
        const editor = choose(root);
        const other = check(root, "badge-artifact-set", "other.md");
        other.checked = true;
        other.events.change();
        check(root, "badge-placements", "Workflow summary").checked = true;
        const summary = check(root, "badge-placements", "Workflow summary");
        summary.events.change();
        submit(editor);
        assert.deepEqual(draftBadges[0].inputs.artifacts,
            [{ phase: "specify", outputs: ["other.md", "spec.md"] }]);
        assert.deepEqual(draftBadges[0].targets, []);
        assert.deepEqual(draftBadges[0].showIn, ["workflow-list", "workflow-summary"]);
    } finally { cleanup(); }
});

test("new badges expose only workflow and evidence-phase placements", () => {
    const { root, draftBadges, cleanup } = setup();
    try {
        const editor = choose(root);
        assert.equal(root.querySelector(".badge-custom-placement"), undefined);
        assert.equal(root.querySelector(".badge-target-choices"), undefined);
        assert.equal(root.querySelector(".badge-legacy-placement").children.length, 0);
        submit(editor);
        assert.deepEqual(draftBadges[0].targets, []);
        assert.deepEqual(draftBadges[0].inputs.artifacts,
            [{ phase: "specify", outputs: ["spec.md"] }]);
    } finally { cleanup(); }
});

test("single-artifact rules use a single checked phase and output", () => {
    const { root, draftBadges, cleanup } = setup({
        badgeTypes: [{ id: "count", rule: "count", title: "Artifact current",
            defaultText: "Artifact current", defaultColor: "green", enabled: true }],
        badgeRules: [{ id: "count", inputs: [{ id: "artifact", type: "artifact" }] }],
    });
    try {
        const editor = choose(root);
        const plan = check(root, "badge-phase-list", "Plan");
        plan.checked = true;
        plan.events.change();
        assert.equal(check(root, "badge-phase-list", "Specify").checked, false);
        assert.equal(check(root, "badge-phase-list", "plan.md").checked, true);
        const output = check(root, "badge-phase-list", "plan.md");
        output.checked = false;
        output.events.change();
        submit(editor);
        assert.deepEqual(draftBadges, []);
        assert.match(editor.querySelector(".badge-editor-error").textContent,
            /Choose a confirmed output/);
        output.checked = true;
        output.events.change();
        submit(editor);
        assert.deepEqual(draftBadges[0].inputs.artifact, { phase: "plan", output: "plan.md" });
    } finally { cleanup(); }
});

test("phase-only rules select one phase and use it for Phase placement", () => {
    const { root, draftBadges, cleanup } = setup({
        phases: ["specify", "plan"], outputs: {},
        badgeTypes: [{ id: "count", rule: "count", title: "Phase run complete",
            defaultText: "Complete", defaultColor: "green", enabled: true }],
        badgeRules: [{ id: "count", inputs: [{ id: "phase", type: "phase" }] }],
    });
    try {
        const editor = choose(root);
        assert.equal(root.querySelector(".badge-output-list"), undefined);
        const plan = check(root, "badge-phase-list", "Plan");
        plan.checked = true;
        plan.events.change();
        const placement = check(root, "badge-placements", "Phase");
        placement.checked = true;
        placement.events.change();
        submit(editor);
        assert.equal(draftBadges[0].inputs.phase, "plan");
        assert.deepEqual(draftBadges[0].targets, [{ phase: "plan", output: null }]);
    } finally { cleanup(); }
});

test("badges with an output and completion phase place on both checked phases", () => {
    const { root, draftBadges, cleanup } = setup({
        badgeTypes: [{ id: "count", rule: "count", title: "Count and phase",
            defaultText: "Count", defaultColor: "green", enabled: true }],
        badgeRules: [{ id: "count", inputs: [
            { id: "artifact", type: "artifact" }, { id: "completion", type: "phase" },
        ] }],
    });
    try {
        const editor = choose(root);
        const groups = descendants(editor).filter((node) => node.className === "badge-phase-list");
        const plan = descendants(groups[1]).find((node) => node.tagName === "label"
            && node.children[1]?.textContent === "Plan").children[0];
        plan.checked = true;
        plan.events.change();
        const placement = check(root, "badge-placements", "Phase");
        placement.checked = true;
        placement.events.change();
        submit(editor);
        assert.deepEqual(draftBadges[0].targets, [
            { phase: "specify", output: null }, { phase: "plan", output: null },
        ]);
    } finally { cleanup(); }
});

test("preview reflects live text and custom color, while invalid placeholders are rejected", () => {
    const { root, draftBadges, cleanup } = setup();
    try {
        const editor = choose(root);
        const preview = root.querySelector(".badge-preview");
        assert.equal(preview.textContent, "Clarifications needed (3)");
        assert.equal(preview.dataset.color, "amber");
        const text = placementText(root, "Workflow list text");
        text.value = "Needs review ({missing})";
        text.events.input();
        submit(editor);
        assert.match(editor.querySelector(".badge-editor-error").textContent,
            /Unknown badge text token/);
        assert.deepEqual(draftBadges, []);
        text.value = "Needs review ({count})";
        text.events.input();
        assert.equal(preview.textContent, "Needs review (3)");
        const color = descendants(editor).find((node) =>
            node.attributes["aria-label"] === "Badge color");
        color.value = "custom";
        color.events.change();
        const hex = descendants(editor).find((node) => node.type === "color");
        hex.value = "#101010";
        hex.events.input();
        assert.equal(preview.style.color, "#fff");
        submit(editor);
        assert.equal(draftBadges[0].color, "#101010");
    } finally { cleanup(); }
});

test("editing shows and preserves saved placements until Phase is explicitly changed", () => {
    const saved = { id: "old", type: "count",
        inputs: { artifacts: [{ phase: "specify", outputs: ["spec.md"] }] },
        text: "Needs review", color: "blue", showIn: ["workflow-list"],
        phase: null, targets: [{ phase: "plan", output: "plan.md" }] };
    const { root, draftBadges, cleanup } = setup({ draftBadges: [saved] });
    try {
        root.querySelector(".badge-edit").events.click();
        assert.equal(root.querySelector(".badge-list"), undefined);
        assert.ok(descendants(root).some((node) => node.textContent === "Save changes"));
        assert.equal(root.querySelector(".badge-custom-placement"), undefined);
        assert.ok(descendants(root.querySelector(".badge-legacy-placement"))
            .some((node) => node.textContent.includes("Plan: plan.md")));
        assert.deepEqual(draftBadges[0], saved);
        submit(root.querySelector(".badge-editor"));
        assert.deepEqual(draftBadges[0].targets, [{ phase: "plan", output: "plan.md" }]);
        root.querySelector(".badge-edit").events.click();
        const placement = check(root, "badge-placements", "Phase");
        placement.checked = false;
        placement.events.change();
        placement.checked = true;
        placement.events.change();
        submit(root.querySelector(".badge-editor"));
        assert.deepEqual(draftBadges[0].targets, [{ phase: "specify", output: null }]);
    } finally { cleanup(); }
});

test("editing removes only unavailable output placements", () => {
    const saved = { id: "old", type: "count",
        inputs: { artifacts: [{ phase: "specify", outputs: ["spec.md"] }] },
        text: "Needs review", color: "blue", showIn: ["workflow-list"],
        phase: null, targets: [{ phase: "specify", output: "spec.md" },
            { phase: "plan", output: "removed.md" }] };
    const { root, draftBadges, cleanup } = setup({ draftBadges: [saved] });
    try {
        root.querySelector(".badge-edit").events.click();
        const editor = root.querySelector(".badge-editor");
        assert.ok(descendants(root.querySelector(".badge-legacy-placement"))
            .some((node) => node.textContent.includes("Some saved placements are unavailable")));
        submit(editor);
        assert.deepEqual(draftBadges[0].targets, saved.targets);
        const remove = descendants(editor).find((node) =>
            node.textContent === "Remove unavailable placements");
        assert.ok(remove);
        remove.events.click();
        submit(editor);
        assert.deepEqual(draftBadges[0].targets,
            [{ phase: "specify", output: "spec.md" }]);
    } finally { cleanup(); }
});

test("refreshing a cached editor flags newly unavailable saved placements", () => {
    const outputs = { specify: { outputs: ["spec.md"], view: "spec.md" } };
    const saved = { id: "old", type: "count",
        inputs: { artifacts: [{ phase: "specify", outputs: ["spec.md"] }] },
        text: "Needs review", color: "blue", showIn: ["workflow-list"],
        phase: null, targets: [{ phase: "specify", output: "spec.md" }] };
    const { root, view, draftBadges, cleanup } = setup({
        phases: ["specify"], outputs, draftBadges: [saved],
    });
    try {
        root.querySelector(".badge-edit").events.click();
        assert.ok(!descendants(root.querySelector(".badge-legacy-placement"))
            .some((node) => node.textContent.includes("Some saved placements are unavailable")));
        outputs.specify.outputs.splice(0, 1);
        view.updateOutputs(outputs);
        assert.ok(descendants(root.querySelector(".badge-legacy-placement"))
            .some((node) => node.textContent.includes("Some saved placements are unavailable")));
        assert.deepEqual(draftBadges, [saved]);
    } finally { cleanup(); }
});

test("stale outputs and unavailable badge types report errors without deleting saved data", () => {
    const stale = { id: "old", type: "count",
        inputs: { artifacts: [{ phase: "plan", outputs: ["removed.md"] }] },
        text: "Needs review", color: "amber", showIn: ["workflow-list"],
        phase: null, targets: [] };
    const { root, draftBadges, cleanup } = setup({ draftBadges: [stale] });
    try {
        root.querySelector(".badge-edit").events.click();
        assert.ok(descendants(root).some((node) =>
            node.textContent.includes("no longer confirmed")));
        submit(root.querySelector(".badge-editor"));
        assert.deepEqual(draftBadges[0], stale);
        const replacement = check(root, "badge-artifact-set", "plan.md");
        replacement.checked = true;
        replacement.events.change();
        submit(root.querySelector(".badge-editor"));
        assert.deepEqual(draftBadges[0].inputs.artifacts,
            [{ phase: "plan", outputs: ["plan.md"] }]);
    } finally { cleanup(); }
    const unavailable = setup({ badgeTypes: [{ id: "count", rule: "count",
        title: "Retired", enabled: false }], draftBadges: [stale] });
    try {
        assert.equal(unavailable.root.querySelector(".badge-add").disabled, true);
        assert.equal(unavailable.root.querySelector(".badge-edit").disabled, true);
        descendants(unavailable.root).find((node) => node.textContent === "Remove").events.click();
        assert.deepEqual(unavailable.draftBadges, []);
    } finally { unavailable.cleanup(); }
});
