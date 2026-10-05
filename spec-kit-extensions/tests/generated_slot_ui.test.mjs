import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../extension-canvas-design/templates/generated-canvas/ui/app.js",
    import.meta.url), "utf8").then((text) => text.replaceAll("\r\n", "\n"));

function section(start, end) {
    const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, `Missing UI section ${start}`);
    return source.slice(first, last);
}

class Element {
    constructor(tag = "div", dataset = {}) {
        this.tagName = tag;
        this.dataset = dataset;
        this.children = [];
        this.parent = null;
        this.listeners = new Map();
        this.attributes = new Map();
        this.classList = { add() {}, remove() {}, contains: () => false };
        this.textContent = "";
        this.value = "";
        this.checked = false;
    }
    get isConnected() { return Boolean(this.parent && (this.parent.isConnected || this.parent.tagName === "document")); }
    get firstElementChild() { return this.children[0] ?? null; }
    set textContent(value) { this._text = value; if (this.children) this.replaceChildren(); }
    get textContent() { return this._text; }
    append(...nodes) {
        for (const node of nodes) {
            node.parent?.children.splice(node.parent.children.indexOf(node), 1);
            node.parent = this;
            this.children.push(node);
        }
    }
    replaceChildren(...nodes) {
        for (const node of this.children) node.parent = null;
        this.children = [];
        this.append(...nodes);
    }
    remove() {
        if (!this.parent) return;
        this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = null;
    }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
    querySelectorAll(selector) {
        const key = { "[data-workflow-slot]": "workflowSlot", "[data-field-slot]": "fieldSlot" }[selector];
        return this.children.flatMap((child) => [
            ...(key && key in child.dataset ? [child] : []), ...child.querySelectorAll(selector),
        ]);
    }
    querySelector(selector) {
        if (selector === "input") return this.children.find((child) => child.tagName === "input") ?? null;
        return null;
    }
    setAttribute(key, value) { this.attributes.set(key, value); }
    removeAttribute(key) { this.attributes.delete(key); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    click() { return this.listeners.get("click")?.(); }
    change() { return this.listeners.get("change")?.(); }
}

function harness({ placements, fields = [], pageSlots = [], adapter = null }) {
    const nodes = new Map();
    const page = new Element("section");
    const workflow = new Element("main");
    const notice = new Element("p");
    const registration = new Element("span", { placements: JSON.stringify(placements) });
    const pageRegistration = new Element("span", { generatedRenderer: "extra", module: "extra",
        values: "{}", assetSlots: "[]", assets: "[]" });
    const workflowButton = new Element("button", { canvasPage: "workflow" });
    const pageButton = new Element("button", { canvasPage: "extra" });
    for (const [key, value] of [
        ["generated-field-placements", registration], ["generated-page", page],
        ["workflow-content", workflow], ["canvas-message", notice],
    ]) nodes.set(key, value);
    const document = {
        tagName: "document",
        activeElement: null,
        createElement: (tag) => new Element(tag),
        getElementById: (id) => nodes.get(id) ?? null,
        querySelector: () => null,
        querySelectorAll: (selector) => selector === "[data-canvas-page]"
            ? [workflowButton, pageButton] : selector === "[data-generated-renderer]" ? [pageRegistration] : [],
    };
    for (const node of [workflow, page, notice, workflowButton, pageButton]) node.parent = document;
    const errors = [], saved = [], images = [];
    const state = { revision: 1, valueFields: fields, valueErrors: {}, pageValues: {},
        phases: [], statuses: {}, items: [], selected: "__new__", drafts: {} };
    const context = {
        document, JSON, Map, Set, Object, Boolean, String, Promise,
        token: "test", renderStockImage: async (root, field, asset) => {
            images.push({ field, asset });
            root.textContent = `packaged:${asset.file}`;
        }, mountPageAssets: async () => {},
        loadPage: async () => ({ renderPage: ({ root }) => {
            for (const slot of pageSlots) root.append(new Element("div", { fieldSlot: slot }));
        } }),
        loadControl: async () => adapter,
        api: async (path, input) => {
            if (path === "/api/values") {
                if (state.saveError) throw state.saveError;
                saved.push(input);
                const field = state.valueFields.find((entry) => entry.id === input.id);
                field.value = input.value;
                return { revision: ++state.revision };
            }
            return state;
        },
        message: (text, id, error) => {
            errors.push({ text, id, error });
            notice.textContent = text;
            if (error) notice.setAttribute("role", "alert");
        },
        renderCollection() {}, renderValues() {}, renderPhase() {},
        constitution: () => null, workflowPhases: () => [],
        saveInputs() {},
    };
    const program = [
        section("const $ = (id)", "function currentTheme()"),
        section("function editValue(element)", "async function api("),
        section("async function refresh(reconcile", "async function selectPhase("),
    ].join("\n")
        .replaceAll("await import(`${registration.dataset.module}?token=${encodeURIComponent(token)}`)",
            "await loadPage(registration.dataset.module)")
        .replaceAll("await import(\n                `/controls/${placement.adapter}.mjs?token=${encodeURIComponent(token)}`)",
            "await loadControl(placement.adapter)");
    assert.doesNotMatch(program, /await import\(/);
    runInNewContext(`${program}\nthis.ui = { refresh, wireGeneratedPages, mountedFields };`, context);
    return { ...context, ui: context.ui, workflow, page, notice, workflowButton, pageButton,
        errors, saved, images, state };
}

const placement = (id, page, slot, field, control, extras = {}) =>
    ({ id, page, slot, field, control, order: 0, ...extras });

test("Workflow slots mount readonly text and editable checkbox, saving via values revision", async () => {
    const ui = harness({ placements: [
        placement("heading", "workflow", "heading", "title", "stock.text", { value: "Frozen", label: "Title" }),
        placement("toggle", "workflow", "options", "enabled", "stock.checkbox"),
    ], fields: [{ id: "enabled", label: "Enabled", value: false, schema: { type: "boolean" },
        editable: true }] });
    const heading = new Element("section", { workflowSlot: "heading" });
    const options = new Element("section", { workflowSlot: "options" });
    ui.workflow.append(heading, options);
    await ui.ui.refresh();
    assert.equal(heading.firstElementChild.textContent, "Frozen");
    const checkbox = options.firstElementChild.querySelector("input");
    assert.equal(checkbox.type, "checkbox");
    checkbox.checked = true;
    await checkbox.change();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.saved.length, 1);
    assert.equal(ui.saved[0].revision, 1);
    assert.equal(ui.saved[0].value, true);
    assert.equal(ui.state.revision, 2);
});

test("Unconfigured image leaves its slot empty; configured image uses its packaged asset", async () => {
    const asset = { file: "brand.webp", hash: "a".repeat(64), mime: "image/webp" };
    const ui = harness({ placements: [
        placement("empty", "workflow", "empty", "unset-logo", "stock.image",
            { schema: { type: "image" } }),
        placement("image", "workflow", "image", "logo", "stock.image",
            { schema: { type: "image" }, asset }),
    ] });
    const empty = new Element("div", { workflowSlot: "empty" });
    const image = new Element("div", { workflowSlot: "image" });
    ui.workflow.append(empty, image);
    await ui.ui.refresh();
    assert.equal(empty.firstElementChild.textContent, "");
    assert.equal(empty.firstElementChild.children.length, 0);
    assert.equal(empty.firstElementChild.attributes.has("role"), false);
    assert.equal(image.firstElementChild.textContent, "packaged:brand.webp");
    assert.equal(ui.images.length, 1);
    assert.equal(JSON.stringify(ui.images[0].asset), JSON.stringify(asset));
    assert.deepEqual(ui.errors, []);
});

for (const slots of [[], ["target", "target"]]) {
    test(`Added page reports ${slots.length ? "duplicate" : "missing"} target visibly`, async () => {
        const ui = harness({ placements: [placement("x", "extra", "target", "name", "stock.text",
            { value: "Hi" })], pageSlots: slots });
        ui.ui.wireGeneratedPages();
        await ui.pageButton.click();
        assert.match(ui.page.textContent,
            slots.length ? /Duplicate generated field slot target/ : /did not render field slot target/);
    });
}

test("Shared field refreshes separate stock mounts without replacing a focused edit", async () => {
    const field = { id: "name", label: "Name", value: "first",
        schema: { type: "string", maxLength: 30 }, editable: true };
    const ui = harness({ placements: [
        placement("first", "workflow", "left", "name", "stock.text"),
        placement("second", "workflow", "right", "name", "stock.text"),
    ], fields: [field] });
    const left = new Element("div", { workflowSlot: "left" });
    const right = new Element("div", { workflowSlot: "right" });
    ui.workflow.append(left, right);
    await ui.ui.refresh();
    const first = left.firstElementChild.querySelector("input");
    const second = right.firstElementChild.querySelector("input");
    first.value = "draft";
    ui.document.activeElement = first;
    field.value = "server update";
    await ui.ui.refresh();
    assert.equal(first.value, "draft");
    assert.equal(second.value, "server update");
    await first.change();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(second.value, "draft");
    assert.equal(ui.saved.at(-1).value, "draft");
    assert.equal(left.firstElementChild.querySelector("input"), first);
});

test("Custom adapter updates per placement and disposes on page navigation", async () => {
    const calls = [];
    const adapter = { controlId: "custom.choice", valueContract: { type: "object",
        properties: { mode: ["a", "b"] } },
    mount: ({ field, value, readValues, onChange }) => {
        calls.push(["mount", field.id, value.mode, readValues(), typeof onChange]);
        return { update: ({ value: next }) => calls.push(["update", field.id, next.mode]),
            dispose: () => calls.push(["dispose", field.id]) };
    } };
    const schema = { type: "object", properties: { mode: ["a", "b"] } };
    const fields = ["one", "two"].map((id) =>
        ({ id, label: id, value: { mode: "a" }, schema, editable: true }));
    const ui = harness({ adapter, fields, placements: [
        placement("a", "workflow", "choices", "one", "custom.choice", { adapter: "choice" }),
        placement("b", "workflow", "choices", "two", "custom.choice", { adapter: "choice", order: 1 }),
    ] });
    ui.workflow.append(new Element("div", { workflowSlot: "choices" }));
    await ui.ui.refresh();
    assert.deepEqual(calls.filter(([action]) => action === "mount").map(([, id]) => id), ["one", "two"]);
    fields[0].value = { mode: "b" };
    await ui.ui.refresh();
    assert.ok(calls.some((call) => call[0] === "update" && call[1] === "one" && call[2] === "b"));
    ui.ui.wireGeneratedPages();
    await ui.pageButton.click();
    assert.deepEqual(calls.filter(([action]) => action === "dispose").map(([, id]) => id), ["one", "two"]);
});

test("Editable object adapter onChange saves through /api/values, syncs both mounts and reports failures", async () => {
    const handlers = [], updates = [];
    const schema = { type: "object", properties: {
        impact: ["low", "high"], likelihood: ["low", "high"],
    } };
    const adapter = {
        controlId: "custom.risk", valueContract: schema,
        mount: ({ onChange, field, editable }) => {
            assert.equal(field.id, "risk");
            assert.equal(editable, true);
            handlers.push(onChange);
            return { update: ({ value }) => updates.push(JSON.stringify(value)), dispose() {} };
        },
    };
    const field = { id: "risk", label: "Risk", schema, editable: true,
        value: { impact: "low", likelihood: "low" } };
    const ui = harness({ adapter, fields: [field], placements: [
        placement("risk-a", "workflow", "first", "risk", "custom.risk", { adapter: "risk" }),
        placement("risk-b", "workflow", "second", "risk", "custom.risk", { adapter: "risk" }),
    ] });
    ui.workflow.append(new Element("div", { workflowSlot: "first" }),
        new Element("div", { workflowSlot: "second" }));
    await ui.ui.refresh();
    assert.equal(handlers.length, 2);
    const edited = { impact: "high", likelihood: "low" };
    await handlers[0](edited);
    assert.equal(ui.saved.length, 1);
    assert.equal(ui.saved[0].id, "risk");
    assert.equal(ui.saved[0].revision, 1);
    assert.equal(JSON.stringify(ui.saved[0].value), JSON.stringify(edited));
    assert.equal(ui.state.revision, 2);
    assert.equal(JSON.stringify(field.value), JSON.stringify(edited));
    assert.ok(updates.filter((value) => value === JSON.stringify(edited)).length >= 2);
    assert.equal(ui.ui.mountedFields.size, 2);

    ui.state.saveError = new Error("Value rejected");
    const failed = { impact: "high", likelihood: "high" };
    await handlers[1](failed);
    assert.equal(ui.saved.length, 1);
    assert.equal(ui.state.revision, 2);
    assert.match(ui.notice.textContent, /Value could not be saved: Value rejected/);
    assert.equal(ui.notice.attributes.get("role"), "alert");
    assert.equal(ui.errors.at(-1).error, true);
    await ui.ui.refresh();
    assert.ok(updates.filter((value) => value === JSON.stringify(failed)).length >= 2);
});
