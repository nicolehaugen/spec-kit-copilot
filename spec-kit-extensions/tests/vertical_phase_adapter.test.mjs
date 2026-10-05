import assert from "node:assert/strict";
import { test } from "node:test";
import { controlId, contractVersion, mount } from "../../spec-kit-presets/copilot-vertical-phase-control/generated/phase-adapter.mjs";

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
    const actions = Object.fromEntries(["select", "draft", "runAt", "viewAt",
        "autopilot", "stopAutopilot", "reveal", "error"]
        .map((name) => [name, (...args) => calls.push([name, ...args])]));
    const control = mount({ root, state: initial, actions });
    assert.match(root.innerHTML, /vertical-phase-list/);
    assert.match(root.innerHTML, /Autopilot/);
    assert.match(root.innerHTML, /Start Step 0/);
    assert.match(root.innerHTML, /aria-current="step"/);
    assert.match(root.innerHTML, /<section class="phase-card vertical-phase-detail"/);
    assert.match(root.innerHTML, /Initial &lt;input&gt;/);
    assert.doesNotMatch(root.innerHTML, /<script>/);
    assert.match(root.innerHTML, /Other expected outputs: specs\/demo\/checklist.md/);

    const click = (attributes, dataset = {}) => listeners.get("click")({
        target: { closest: () => ({
            disabled: false, dataset, hasAttribute: (name) => attributes.includes(name),
        }) },
    });
    click(["data-phase-index"], { phaseIndex: "1" });
    click([], { action: "start", index: "0" });
    click([], { action: "autopilot" });
    click([], { action: "reveal" });
    listeners.get("input")({ target: {
        matches: () => true, value: "New direction",
    } });
    assert.deepEqual(calls, [
        ["select", 1], ["runAt", 0], ["autopilot"], ["reveal"], ["draft", "New direction"],
    ]);
    control.update({ ...initial, current: 1, output: phases[1].output,
        status: { status: "Complete", output: phases[1].output, artifactAvailability: "available" },
        draft: "Done", otherOutputs: [] });
    assert.match(root.innerHTML, /Plan &lt;script&gt;/);
    assert.match(root.innerHTML, /class="phase-notice">Complete/);
    assert.match(root.innerHTML, /data-action="view-row"/);
    control.update({ ...initial, output: null, status: null, otherOutputs: [] });
    assert.match(root.innerHTML, /No declared output/);
    assert.match(root.innerHTML, /No artifact is available for this phase yet/);
    control.update({ ...initial, sending: true, status: { status: "Running" }, runLabel: "Sending..." });
    assert.match(root.innerHTML, /data-action="start" data-index="0">Start Step 0/);
    click([], { action: "start", index: "0" });
    assert.deepEqual(calls.at(-1), ["runAt", 0]);
    control.update({ ...initial, status: { status: "Request sent" }, runLabel: "Request sent..." });
    assert.match(root.innerHTML, /Request sent/);
    assert.match(root.innerHTML, /data-action="start" data-index="0">Start Step 0/);
    click([], { action: "start", index: "0" });
    assert.deepEqual(calls.at(-1), ["runAt", 0]);
    control.update({ ...initial, status: { status: "Running" }, runLabel: "Running..." });
    assert.match(root.innerHTML, /data-action="start" data-index="0">Start Step 0/);
    click([], { action: "start", index: "0" });
    assert.deepEqual(calls.at(-1), ["runAt", 0]);
    control.update({ ...initial, status: { status: "Completed" }, runLabel: null });
    assert.match(root.innerHTML, /Start Step 0/);
    control.dispose();
    assert.equal(root.innerHTML, "");
    assert.equal(listeners.size, 0);
});

test("vertical phase adapter handles empty workflows without host phase markup", () => {
    const { root } = rootFixture();
    const actions = Object.fromEntries(["select", "draft", "runAt", "viewAt",
        "autopilot", "stopAutopilot", "reveal", "error"]
        .map((name) => [name, () => {}]));
    mount({ root, state: {
        phases: [], current: -1, workflow: "__new__", status: null, draft: "",
        output: null, otherOutputs: [], sending: false, runLabel: null,
    }, actions });
    assert.match(root.innerHTML, /No workflow phases are configured/);
});
