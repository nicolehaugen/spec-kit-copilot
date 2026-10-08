import assert from "node:assert/strict";
import { test } from "node:test";
import { mount, pageId, contractVersion, renderStockPage } from "../extension-canvas-design/generated-host/workflow-page/generated-workflow-page-adapter.mjs";

test("stock adapter owns setup, constitution, values, phase and contributed markup", () => {
    const root = { innerHTML: "" };
    renderStockPage(root, { id: "workflow", canvas: {
        displayName: "Demo", workflowListName: "<unsafe>", description: "Description",
    }, mainPageAsset: null, readOnlyFields: [{ id: "test.note", label: "Note", value: "<script>" }],
    textPlacements: [], hasValues: true,
    generatedControls: [], hasConstitution: true, hasBadges: true,
    badgeDestinations: ["workflow.list", "phase.card"],
    fieldSlots: ["workflow.actions"] });
    for (const id of ["setup-surface", "instance-collection", "constitution-card",
        "canvas-values", "workflow-pipeline", "delete-workflow-dialog", "constitution-dialog"]) {
        assert.match(root.innerHTML, new RegExp(`id="${id}"`));
    }
    assert.match(root.innerHTML, /data-workflow-slot="workflow.actions"/);
    assert.match(root.innerHTML, /data-badge-slot="workflow.list"/);
    assert.doesNotMatch(root.innerHTML, /data-badge-slot="workflow.summary"/);
    assert.match(root.innerHTML, /&lt;unsafe&gt;|&lt;script&gt;/);
    assert.doesNotMatch(root.innerHTML, /<script>/);
});

test("stock Workflow page mounts its phase control, updates collection and disposes", (t) => {
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, {
            id, dataset: {}, children: [], hidden: false, scrollTop: 0,
            classList: { toggle() {} },
            addEventListener(name, callback) { this.listener = callback; },
            removeEventListener() { this.listener = null; },
            querySelector() { return { hidden: false }; },
            querySelectorAll() { return []; },
            closest() { return { hidden: false }; },
            replaceChildren(...children) { this.children = children; },
        });
        return elements.get(id);
    };
    const root = { querySelector: (selector) => element(selector.slice(1)),
        addEventListener() {}, removeEventListener() {} };
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById: element, activeElement: null };
    t.after(() => { globalThis.document = originalDocument; });
    let disposed = false, updates = 0;
    const page = mount({ root, definition: { id: pageId },
        state: { model: null, phaseState: {} },
        actions: {
            selectWorkflow() {},
            mountPhase: (pipeline, state) => {
                assert.equal(pipeline, element("workflow-pipeline"));
                assert.deepEqual(state, {});
                return { update() { updates++; }, dispose() { disposed = true; } };
            },
            clearSetupPlan() {},
        } });
    assert.equal(contractVersion, 1);
    page.update({ model: { showSetup: false, items: [], selected: "__new__",
        phases: [], badges: {}, constitutionReady: false, statuses: {},
        valueFields: [], valueErrors: {} },
    phaseState: {}, inputPending: false });
    assert.equal(element("workflow-count").textContent, "(0)");
    assert.equal(element("workflow-empty").textContent, "No workflow phases are configured.");
    assert.equal(updates, 1);
    const project = { id: "constitution", project: true };
    const model = { showSetup: false, items: [], selected: "__new__",
        phases: [project], badges: {}, constitutionReady: true,
        valueFields: [], valueErrors: {} };
    page.update({ model: { ...model, statuses: { constitution: {
        artifactAvailability: "available", status: "Completed" } } },
    pendingLabel: () => null, phaseState: {}, inputPending: false });
    assert.equal(element("constitution-status").textContent, "");
    assert.equal(element("constitution-status").hidden, true);
    assert.equal(element("view-constitution").hidden, false);
    page.update({ model: { ...model, statuses: { constitution: {
        artifactAvailability: "error", status: "Failed" } } },
    pendingLabel: () => null, phaseState: {}, inputPending: false });
    assert.equal(element("constitution-status").textContent, "Unavailable");
    assert.equal(element("constitution-status").hidden, false);
    page.dispose();
    assert.equal(disposed, true);
    assert.equal(element("workflow-search").listener, null);
});

test("workflow identity survives rebuilding a selected row after evidence changes", (t) => {
    class Element {
        constructor(tagName = "div", id = "") {
            this.tagName = tagName;
            this.id = id;
            this.dataset = {};
            this.children = [];
            this.parentElement = null;
            this.classList = { toggle() {} };
            this.hidden = false;
            this.scrollTop = 0;
        }
        append(...children) {
            for (const child of children) {
                if (child.parentElement) {
                    const siblings = child.parentElement.children;
                    siblings.splice(siblings.indexOf(child), 1);
                }
                child.parentElement = this;
                this.children.push(child);
            }
        }
        replaceChildren(...children) {
            for (const child of this.children) child.parentElement = null;
            this.children = [];
            this.append(...children);
        }
        querySelector(selector) {
            const matches = (node) => selector.startsWith("#") ? node.id === selector.slice(1)
                : selector.startsWith(".") ? node.className?.split(" ").includes(selector.slice(1))
                    : node.tagName === selector;
            for (const child of this.children) {
                if (matches(child)) return child;
                const nested = child.querySelector(selector);
                if (nested) return nested;
            }
            return null;
        }
        querySelectorAll() { return []; }
        closest() { return { hidden: false }; }
        setAttribute() {}
        removeAttribute() {}
        addEventListener() {}
        removeEventListener() {}
    }
    const root = new Element();
    const identity = new Element("div", "workflow-identity");
    identity.append(new Element("input", "workflow-name"));
    const slugLabel = new Element("span", "workflow-slug-label");
    const required = new Element("span");
    required.className = "muted";
    slugLabel.append(required);
    identity.append(slugLabel, new Element("input", "workflow-slug"), new Element("span", "workflow-slug-error"));
    const rows = new Element("div", "workflow-rows");
    for (const id of ["setup-surface", "workflow-search", "workflow-count", "new-workflow",
        "workflow-constitution-note", "workflow-pipeline", "workflow-list",
        "workflow-empty", "workflow-search-field", "workflow-list-status"]) {
        root.append(new Element("div", id));
    }
    root.append(rows, identity);
    const originalDocument = globalThis.document;
    globalThis.document = {
        createElement: (tag) => new Element(tag),
        getElementById: () => null,
        activeElement: null,
    };
    t.after(() => { globalThis.document = originalDocument; });
    const page = mount({ root, definition: { id: pageId },
        state: { model: null, phaseState: {} },
        actions: { selectWorkflow() {}, mountPhase: () => ({ update() {}, dispose() {} }),
            clearSetupPlan() {} } });
    const model = (badges) => ({
        showSetup: false, items: [{ id: "draft", label: "Draft", slug: "draft", pending: true }],
        selected: "draft", name: "Draft", slug: "draft", phases: [{ id: "specify" }],
        badges: { items: badges }, constitutionReady: true, statuses: {},
        valueFields: [], valueErrors: {},
    });
    const update = (badges) => page.update({
        model: model(badges), phaseState: {}, inputPending: false, slugTouched: false,
        slugError: "", pendingLabel: () => null,
    });
    update({});
    assert.equal(identity.parentElement, rows.children[0]);
    update({ draft: [{ text: "Ready", color: "amber", showIn: ["workflow-list"] }] });
    assert.equal(identity.parentElement, rows.children[0]);
    assert.equal(root.querySelector("#workflow-name"), identity.querySelector("#workflow-name"));
    page.update({ model: {
        ...model({}), selected: "saved",
        items: [{ id: "saved", label: "Saved", slug: "saved", pending: false }],
    }, phaseState: {}, inputPending: false, pendingLabel: () => null });
    assert.equal(identity.hidden, true);
    update({});
    assert.equal(identity.hidden, false);
    assert.equal(identity.parentElement, rows.children[0]);
    page.dispose();
});
