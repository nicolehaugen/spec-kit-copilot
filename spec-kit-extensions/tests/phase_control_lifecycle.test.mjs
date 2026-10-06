import assert from "node:assert/strict";
import { test } from "node:test";
import * as stock from "../extension-canvas-design/generated-host/phase-control/generated-phase-adapter.mjs";
import * as vertical from "../../spec-kit-presets/copilot-vertical-phase-control/generated/phase-adapter.mjs";
import { phaseControlDom } from "./phase_control_dom_fixture.mjs";

const phases = [
    { id: "specify", label: "Specify", output: "specs/demo/spec.md" },
    { id: "plan", label: "Plan", output: "specs/demo/plan.md" },
];
const state = {
    phases, current: 0, workflow: "demo", status: null, draft: "initial",
    output: phases[0].output, outputLinks: [], sending: false, runLabel: null,
};
const definition = { id: "workflow-phases", viewLabels: { plan: "Inspect Plan" } };

for (const [name, adapter] of [["stock", stock], ["vertical", vertical]]) {
    test(`${name} does not dispatch a confirmed selection after navigation`, async (t) => {
        const dom = phaseControlDom();
        const previousDocument = globalThis.document;
        globalThis.document = dom.document;
        t.after(() => { globalThis.document = previousDocument; });
        const calls = [];
        let confirm;
        const decision = new Promise((resolve) => { confirm = resolve; });
        const actions = Object.fromEntries(["select", "draft", "run", "view", "runAt", "viewAt",
            "startManagedRun", "stopManagedRun", "reveal", "error"]
            .map((action) => [action, (...args) => { calls.push([action, ...args]); }]));
        actions.confirmRun = () => decision;
        const control = adapter.mount({ root: dom.root, definition, state, actions });
        dom.root.dispatch("click", dom.root.querySelector(name === "stock" ? "#run-phase"
            : '[data-action="start"]'));
        control.update(name === "stock" ? { ...state, current: 1, output: phases[1].output }
            : { ...state, workflow: "another-workflow" });
        confirm(true);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(calls.map(([action]) => action), ["error"]);
        assert.match(calls[0][1].message, /workflow or phase changed/);
        control.dispose();
    });

    test(`${name} preview disables phase execution and restores pending-turn retries after setup`, (t) => {
        const dom = phaseControlDom();
        const previousDocument = globalThis.document;
        globalThis.document = dom.document;
        t.after(() => { globalThis.document = previousDocument; });
        const actions = Object.fromEntries(["select", "draft", "run", "view", "runAt", "viewAt",
            "startManagedRun", "stopManagedRun", "reveal", "error"].map((action) => [action, () => {}]));
        const control = adapter.mount({ root: dom.root, definition,
            state: { ...state, setupPending: true }, actions });
        const selector = name === "stock" ? "#run-phase" : '[data-action="start"]';
        const input = dom.root.querySelector(name === "stock" ? "#phase-args" : "[data-phase-draft]");
        assert.equal(dom.root.querySelector(selector).disabled, true);
        assert.equal(name === "stock" ? input.readOnly : input.hasAttribute("readonly"), true);
        if (name === "vertical") assert.equal(dom.root.querySelector('[data-action="autopilot"]').disabled, true);
        assert.match(name === "stock" ? dom.root.querySelector("#phase-message").textContent
            : dom.root.innerHTML, /Available after setup/);
        control.update({ ...state, setupPending: false, status: { status: "Running" } });
        assert.equal(dom.root.querySelector(selector).disabled, false);
        if (name === "vertical") assert.equal(dom.root.querySelector('[data-action="autopilot"]').disabled, false);
        control.dispose();
    });

    test(`${name} phase control mounts, updates a focused draft, dispatches actions and disposes`, async (t) => {
        const dom = phaseControlDom();
        const previousDocument = globalThis.document;
        globalThis.document = dom.document;
        t.after(() => { globalThis.document = previousDocument; });
        const calls = [];
        const actions = Object.fromEntries(["select", "draft", "run", "view", "runAt", "viewAt",
            "startManagedRun", "stopManagedRun", "reveal", "error"]
            .map((action) => [action, (...args) => { calls.push([action, ...args]); }]));
        const initial = name === "stock" ? {
            ...state, phases: [], current: -1, output: null,
        } : state;
        const control = adapter.mount({ root: dom.root, definition, state: initial, actions });
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
        const view = dom.root.querySelector(name === "stock" ? "#view-artifact" : '[data-action="view-row"]');
        if (name === "stock") assert.equal(view.hidden, false);
        else assert.match(dom.root.innerHTML, /data-action="view-row"/);
        dom.root.querySelectorAll("[data-phase-index]")[0].focus();
        control.update({ ...state, status: { status: "Completed" } });
        assert.equal(dom.document.activeElement,
            dom.root.querySelectorAll("[data-phase-index]")[0]);
        if (name === "vertical") {
            const secondStart = dom.root.querySelector('[data-action="start"][data-index="1"]');
            secondStart.focus();
            control.update(state);
            assert.equal(dom.document.activeElement,
                dom.root.querySelector('[data-action="start"][data-index="1"]'));
        }

        dom.root.dispatch("click", dom.root.querySelectorAll("[data-phase-index]")[1]);
        const input = dom.root.querySelector(name === "stock" ? "#phase-args" : "[data-phase-draft]");
        input.value = "run this";
        dom.root.dispatch("input", input);
        dom.root.dispatch("click", dom.root.querySelector(name === "stock" ? "#run-phase" : '[data-action="start"]'));
        if (name === "stock") {
            dom.root.dispatch("click", dom.root.querySelector("#view-artifact"));
            dom.root.dispatch("click", dom.root.querySelector("#browse-output-folder"));
        } else {
            for (const action of ["view-row", "reveal"])
                dom.root.dispatch("click", dom.root.querySelector(`[data-action="${action}"]`));
        }
        assert.deepEqual(calls.map(([action]) => action), name === "stock"
            ? ["select", "draft", "run", "view", "reveal"]
            : ["select", "draft", "runAt", "reveal"]);
        assert.deepEqual(calls[0], ["select", 1]);
        assert.deepEqual(calls[2], name === "stock" ? ["run", "run this"] : ["runAt", 0]);
        if (name === "stock") {
            control.update({ ...state, outputLinks: [
                { template: "specs/<slug>/spec.md", label: "specs/demo/spec.md" },
            ] });
            const link = dom.root.querySelector("#phase-other-outputs").children
                .find((node) => node.tag === "button");
            assert.equal(link.textContent, "specs/demo/spec.md");
            dom.root.dispatch("click", link);
            assert.deepEqual(calls.at(-1), ["view", "specs/<slug>/spec.md"]);
        }
        actions[name === "stock" ? "run" : "runAt"] = () => Promise.reject(new Error("run failed"));
        dom.root.dispatch("click", dom.root.querySelector(name === "stock" ? "#run-phase" : '[data-action="start"]'));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(calls.at(-1).slice(0, 1), ["error"]);
        assert.match(calls.at(-1)[1].message, /run failed/);
        control.update({ ...state, current: 1, draft: "plan details", output: phases[1].output,
            status: { status: "Running" } });
        assert.match(dom.root.innerHTML, /<h2>Plan<\/h2>/);
        assert.equal(dom.root.querySelector(name === "stock" ? "#view-artifact"
            : '[data-action="view-row"][data-index="1"]').textContent, "Inspect Plan");
        assert.equal(dom.root.querySelectorAll("[data-phase-index]")[1].hasAttribute("aria-current"), true);
        assert.equal(dom.root.querySelector(name === "stock" ? "#phase-args" : "[data-phase-draft]").value,
            "plan details");
        control.update({ ...state, current: 0 });
        assert.equal(dom.root.querySelector(name === "stock" ? "#view-artifact"
            : '[data-action="view-row"][data-index="0"]').textContent, "View artifact");
        control.update({ ...state, phases: [{ ...phases[0], id: "constructor" }, phases[1]] });
        assert.equal(dom.root.querySelector(name === "stock" ? "#view-artifact"
            : '[data-action="view-row"][data-index="0"]').textContent, "View artifact");
        control.dispose();
        const count = calls.length;
        dom.root.dispatch("input", input);
        assert.equal(calls.length, count);
        assert.equal(dom.listeners.size, 0);
    });
}

test("stock phase Run confirms only when an optional callback is supplied", async (t) => {
    const dom = phaseControlDom();
    const previousDocument = globalThis.document;
    globalThis.document = dom.document;
    t.after(() => { globalThis.document = previousDocument; });
    const calls = [];
    let decision = false;
    const actions = Object.fromEntries(["select", "draft", "view", "reveal", "error"]
        .map((name) => [name, () => {}]));
    actions.run = (input) => calls.push(["run", input]);
    actions.confirmRun = (phase) => { calls.push(["confirm", phase.id]); return decision; };
    const control = stock.mount({ root: dom.root, definition, state, actions });
    const run = dom.root.querySelector("#run-phase");
    dom.root.querySelector("#phase-args").value = "details";
    dom.root.dispatch("click", run);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [["confirm", "specify"]]);
    decision = true;
    dom.root.dispatch("click", run);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [["confirm", "specify"], ["confirm", "specify"], ["run", "details"]]);
    control.dispose();
});
