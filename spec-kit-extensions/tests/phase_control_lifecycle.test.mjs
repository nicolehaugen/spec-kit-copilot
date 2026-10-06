import assert from "node:assert/strict";
import { test } from "node:test";
import * as stock from "../extension-canvas-design/generated-host/phase-control/generated-phase-adapter.mjs";
import * as vertical from "../../spec-kit-presets/copilot-vertical-pipeline-test/generated/phase-adapter.mjs";
import { phaseControlDom } from "./phase_control_dom_fixture.mjs";

const phases = [
    { id: "specify", label: "Specify", output: "specs/demo/spec.md" },
    { id: "plan", label: "Plan", output: "specs/demo/plan.md" },
];
const state = {
    phases, current: 0, workflow: "demo", status: null, draft: "initial",
    output: phases[0].output, otherOutputs: [], sending: false, runLabel: null,
};

for (const [name, adapter] of [["stock", stock], ["vertical", vertical]]) {
    test(`${name} phase control mounts, updates a focused draft, dispatches actions and disposes`, async (t) => {
        const dom = phaseControlDom();
        const previousDocument = globalThis.document;
        globalThis.document = dom.document;
        t.after(() => { globalThis.document = previousDocument; });
        const calls = [];
        const actions = Object.fromEntries(["select", "draft", "run", "view", "reveal", "error"]
            .map((action) => [action, (...args) => { calls.push([action, ...args]); }]));
        const initial = name === "stock" ? {
            ...state, phases: [], current: -1, output: null,
        } : state;
        const control = adapter.mount({ root: dom.root, state: initial, actions });
        assert.equal(adapter.controlId, "workflow-phases");
        assert.equal(adapter.contractVersion, 1);
        if (name === "stock") {
            assert.match(dom.root.innerHTML, /No workflow phases are configured/);
            assert.equal(dom.root.querySelectorAll("[data-phase-index]").length, 0);
            control.update(state);
        }
        assert.match(dom.root.innerHTML, /aria-label="Workflow phases"/);
        assert.match(dom.root.innerHTML, /aria-label="Selected phase"/);
        assert.equal(dom.root.querySelectorAll("[data-phase-index]").length, 2);

        const draft = dom.root.querySelector(name === "stock" ? "#phase-args" : "[data-phase-draft]");
        draft.value = "typed but not yet saved";
        draft.focus();
        draft.setSelectionRange(5, 5);
        control.update({ ...state, status: {
            status: "Completed", output: phases[0].output, artifactAvailability: "available",
        }, draft: "typed but not yet saved" });
        const updatedDraft = dom.root.querySelector(name === "stock" ? "#phase-args" : "[data-phase-draft]");
        assert.equal(dom.document.activeElement, updatedDraft);
        if (name === "stock") assert.equal(updatedDraft, draft);
        assert.equal(updatedDraft.value, "typed but not yet saved");
        assert.equal(updatedDraft.selectionStart, 5);
        assert.equal(dom.root.querySelector(".phase-notice").textContent, "Completed");
        const view = dom.root.querySelector(name === "stock" ? "#view-artifact" : '[data-action="view"]');
        if (view) assert.equal(view.hidden, false);
        else assert.match(dom.root.innerHTML, /data-action="view" type="button"\s*>View artifact/);
        dom.root.querySelectorAll("[data-phase-index]")[0].focus();
        control.update({ ...state, status: { status: "Completed" } });
        assert.equal(dom.document.activeElement,
            dom.root.querySelectorAll("[data-phase-index]")[0]);

        dom.root.dispatch("click", dom.root.querySelectorAll("[data-phase-index]")[1]);
        const input = dom.root.querySelector(name === "stock" ? "#phase-args" : "[data-phase-draft]");
        input.value = "run this";
        dom.root.dispatch("input", input);
        dom.root.dispatch("click", dom.root.querySelector(name === "stock" ? "#run-phase" : '[data-action="run"]'));
        if (name === "stock") {
            dom.root.dispatch("click", dom.root.querySelector("#view-artifact"));
            dom.root.dispatch("click", dom.root.querySelector("#browse-output-folder"));
        } else {
            for (const action of ["view", "reveal"])
                dom.root.dispatch("click", dom.root.querySelector(`[data-action="${action}"]`));
        }
        assert.deepEqual(calls.map(([action]) => action),
            ["select", "draft", "run", "view", "reveal"]);
        assert.deepEqual(calls[0], ["select", 1]);
        assert.deepEqual(calls[2], ["run", "run this"]);
        if (name === "stock") {
            control.update({ ...state, otherOutputs: ["specs/demo/spec.md"], outputLinks: [
                { template: "specs/<slug>/spec.md", label: "specs/demo/spec.md" },
            ] });
            const link = dom.root.querySelector("#phase-other-outputs").children
                .find((node) => node.tag === "button");
            assert.equal(link.textContent, "specs/demo/spec.md");
            dom.root.dispatch("click", link);
            assert.deepEqual(calls.at(-1), ["view", "specs/<slug>/spec.md"]);
        }
        actions.run = () => Promise.reject(new Error("run failed"));
        dom.root.dispatch("click", dom.root.querySelector(name === "stock" ? "#run-phase" : '[data-action="run"]'));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(calls.at(-1).slice(0, 1), ["error"]);
        assert.match(calls.at(-1)[1].message, /run failed/);
        control.update({ ...state, current: 1, draft: "plan details", output: phases[1].output,
            status: { status: "Running" } });
        assert.match(dom.root.innerHTML, /<h2>Plan<\/h2>/);
        assert.equal(dom.root.querySelectorAll("[data-phase-index]")[1].hasAttribute("aria-current"), true);
        assert.equal(dom.root.querySelector(name === "stock" ? "#phase-args" : "[data-phase-draft]").value,
            "plan details");
        control.dispose();
        const count = calls.length;
        dom.root.dispatch("input", input);
        assert.equal(calls.length, count);
        assert.equal(dom.listeners.size, 0);
    });
}
