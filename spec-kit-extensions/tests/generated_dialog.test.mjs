import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../extension-canvas-design/generated-host/dialog/generated-dialog-adapter.mjs";

function dialogRoot() {
    const document = { activeElement: null };
    const node = (tag) => ({
        tag, ownerDocument: document, children: [], listeners: new Map(),
        append(...children) { this.children.push(...children); for (const child of children) child.parent = this; },
        replaceChildren(...children) { this.children = []; this.append(...children); },
        remove() {
            this.parent.children = this.parent.children.filter((child) => child !== this);
        },
        setAttribute() {},
        addEventListener(event, listener) { this.listeners.set(event, listener); },
        focus() { document.activeElement = this; },
        querySelectorAll() {
            const descendants = (parent) => parent.children.flatMap((child) =>
                [child, ...descendants(child)]);
            return descendants(this).filter((child) => child.tag === "a" || child.tag === "button");
        },
    });
    document.createElement = node;
    return node("root");
}

test("dialog keyboard trap includes links before buttons and cleanup is idempotent", async () => {
    const root = dialogRoot();
    const original = { focus() { root.ownerDocument.activeElement = this; } };
    root.ownerDocument.activeElement = original;
    const decisions = [];
    const instance = mount({ root, definition: {
        title: "Confirmation",
        blocks: [{ type: "link", href: "https://example.org", text: "Documentation" }],
        buttons: { cancel: "Cancel", confirm: "Confirm" },
    }, onDecision: (decision) => decisions.push(decision) });
    const dialog = root.children[0].children[0];
    const [link, cancel, confirm] = dialog.querySelectorAll();
    assert.equal(root.ownerDocument.activeElement, cancel);
    const pressTab = (shiftKey) => {
        let prevented = false;
        dialog.listeners.get("keydown")({ key: "Tab", shiftKey,
            preventDefault() { prevented = true; } });
        return prevented;
    };
    assert.equal(pressTab(true), false);
    link.focus();
    assert.equal(pressTab(true), true);
    assert.equal(root.ownerDocument.activeElement, confirm);
    assert.equal(pressTab(false), true);
    assert.equal(root.ownerDocument.activeElement, link);
    cancel.listeners.get("click")();
    assert.equal(await instance.result, "cancelled");
    instance.dispose();
    assert.deepEqual(decisions, ["cancelled"]);
    assert.equal(root.children.length, 0);
    assert.equal(root.ownerDocument.activeElement, original);
});
