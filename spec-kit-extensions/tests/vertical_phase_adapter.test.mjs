import assert from "node:assert/strict";
import { test } from "node:test";
import { controlId, contractVersion, mount } from "../../spec-kit-presets/copilot-vertical-pipeline-test/generated/phase-adapter.mjs";

const phases = [
    { id: "specify", label: "Specify", output: "specs/demo/spec.md" },
    { id: "plan", label: "Plan <script>", output: "specs/demo/plan.md" },
];
const initial = {
    workflow: "demo", phases, current: 0, status: { status: "Not run" },
    draft: "Initial <input>", output: phases[0].output,
    otherOutputs: ["specs/demo/checklist.md"], sending: false, runLabel: null,
};

function rootFixture() {
    const listeners = new Map();
    const root = {
        innerHTML: "", ownerDocument: { activeElement: null },
        addEventListener(type, listener) { listeners.set(type, listener); },
        removeEventListener(type) { listeners.delete(type); },
        replaceChildren() { this.innerHTML = ""; },
        contains() { return true; },
        querySelector(selector) {
            return selector === "[data-phase-draft]" ? { value: "Edited draft" } : null;
        },
    };
    return { root, listeners };
}

test("vertical phase adapter owns full navigation and card and dispatches the contracted actions", () => {
    assert.equal(controlId, "workflow-phases");
    assert.equal(contractVersion, 1);
    const { root, listeners } = rootFixture();
    const calls = [];
    const actions = Object.fromEntries(["select", "draft", "run", "view", "reveal", "error"]
        .map((name) => [name, (...args) => calls.push([name, ...args])]));
    const control = mount({ root, state: initial, actions });
    assert.match(root.innerHTML, /vertical-phase-list/);
    assert.match(root.innerHTML, /aria-current="step"/);
    assert.match(root.innerHTML, /<section class="phase-card"/);
    assert.match(root.innerHTML, /Initial &lt;input&gt;/);
    assert.doesNotMatch(root.innerHTML, /<script>/);
    assert.match(root.innerHTML, /Other expected outputs: specs\/demo\/checklist.md/);
    control.update({ ...initial, outputLinks: [
        { template: "reports/<slug>/notes.md", label: "reports/demo/notes.md" },
    ] });
    assert.match(root.innerHTML, /data-action="output" data-output="reports\/&lt;slug&gt;\/notes.md"/);
    assert.match(root.innerHTML, /reports\/demo\/notes.md/);
    listeners.get("click")({ target: { closest: () => ({
        disabled: false, dataset: { action: "output", output: "reports/<slug>/notes.md" },
        hasAttribute: () => false,
    }) } });
    assert.deepEqual(calls.at(-1), ["view", "reports/<slug>/notes.md"]);
    calls.length = 0;

    const click = (attributes, dataset = {}) => listeners.get("click")({
        target: { closest: () => ({
            disabled: false, dataset, hasAttribute: (name) => attributes.includes(name),
        }) },
    });
    click(["data-phase-index"], { phaseIndex: "1" });
    click([], { action: "run" });
    click([], { action: "reveal" });
    listeners.get("input")({ target: {
        matches: () => true, value: "New direction",
    } });
    assert.deepEqual(calls, [
        ["select", 1], ["run", "Edited draft"], ["reveal"], ["draft", "New direction"],
    ]);
    control.update({ ...initial, current: 1, output: phases[1].output,
        status: { status: "Complete", output: phases[1].output, artifactAvailability: "available" },
        draft: "Done", otherOutputs: [] });
    assert.match(root.innerHTML, /Plan &lt;script&gt;/);
    assert.match(root.innerHTML, /class="phase-notice">Complete/);
    assert.match(root.innerHTML, /data-action="view" type="button"\s*>View artifact/);
    click([], { action: "view" });
    assert.deepEqual(calls.at(-1), ["view"]);
    control.update({ ...initial, output: null, status: null, otherOutputs: [] });
    assert.match(root.innerHTML, /No declared output/);
    assert.match(root.innerHTML, /No artifact is available for this phase yet/);
    control.update({ ...initial, sending: true, status: { status: "Running" }, runLabel: "Sending..." });
    assert.match(root.innerHTML, /data-action="run" type="button"\s*>Sending\.\.\./);
    click([], { action: "run" });
    assert.deepEqual(calls.at(-1), ["run", "Edited draft"]);
    control.update({ ...initial, status: { status: "Request sent" }, runLabel: "Request sent..." });
    assert.match(root.innerHTML, /data-action="run" type="button"\s*>Request sent\.\.\./);
    click([], { action: "run" });
    assert.deepEqual(calls.at(-1), ["run", "Edited draft"]);
    control.update({ ...initial, status: { status: "Running" }, runLabel: "Running..." });
    assert.match(root.innerHTML, /data-action="run" type="button"\s*>Running\.\.\./);
    click([], { action: "run" });
    assert.deepEqual(calls.at(-1), ["run", "Edited draft"]);
    control.update({ ...initial, status: { status: "Completed" }, runLabel: null });
    assert.match(root.innerHTML, /data-action="run" type="button"\s*>Run again/);
    control.dispose();
    assert.equal(root.innerHTML, "");
    assert.equal(listeners.size, 0);
});

test("vertical phase adapter handles empty workflows without host phase markup", () => {
    const { root } = rootFixture();
    const actions = Object.fromEntries(["select", "draft", "run", "view", "reveal", "error"]
        .map((name) => [name, () => {}]));
    mount({ root, state: {
        phases: [], current: -1, workflow: "__new__", status: null, draft: "",
        output: null, otherOutputs: [], sending: false, runLabel: null,
    }, actions });
    assert.match(root.innerHTML, /No workflow phases are configured/);
});
