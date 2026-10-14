import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createSessionStartup } from "../startup.mjs";

test("Designer and generated fixed-shell startup use the same maintained implementation", async () => {
    const [designer, generated] = await Promise.all([
        readFile(new URL("../startup.mjs", import.meta.url), "utf8"),
        readFile(new URL("../../../../../spec-kit-extensions/extension-canvas-design/generated-scaffold/startup.mjs", import.meta.url), "utf8"),
    ]);
    assert.equal(designer.replaceAll("\r\n", "\n"), generated.replaceAll("\r\n", "\n"));
});

test("an early awaited Open returns before session registration, then redirects", async (t) => {
    const startup = createSessionStartup();
    t.after(() => startup.close("early"));
    let opened = false;
    const result = await startup.open({ instanceId: "early" }, async () => {
        opened = true;
        return { url: "http://127.0.0.1:1/real-shell" };
    }, async () => {});
    assert.equal(opened, false);
    const loading = await fetch(result.url);
    assert.equal(loading.status, 200);
    assert.match(await loading.text(), /Starting Spec Kit Canvas Designer/);
    assert.doesNotMatch(loading.headers.get("Content-Security-Policy"), /frame-ancestors/);
    startup.ready();
    const ready = await fetch(result.url, { redirect: "manual" });
    assert.equal(ready.status, 302);
    assert.equal(ready.headers.get("Location"), "http://127.0.0.1:1/real-shell");
});

test("close before registration never starts the real shell", async () => {
    const startup = createSessionStartup();
    let opened = false;
    const result = await startup.open({ instanceId: "closed" }, async () => {
        opened = true;
    }, async () => {});
    await startup.close("closed");
    startup.ready();
    await new Promise((done) => setImmediate(done));
    assert.equal(opened, false);
    await assert.rejects(fetch(result.url));
});

test("a close while the shell starts closes the eventual shell", async () => {
    const startup = createSessionStartup();
    let complete;
    const starting = new Promise((resolve) => { complete = resolve; });
    let closed = false;
    await startup.open({ instanceId: "closing" }, () => starting, async () => { closed = true; });
    startup.ready();
    await new Promise((done) => setImmediate(done));
    await startup.close("closing");
    complete({ url: "http://127.0.0.1:1/" });
    await new Promise((done) => setImmediate(done));
    assert.equal(closed, true);
});

test("startup errors are visible, escaped, and do not masquerade as success", async (t) => {
    const startup = createSessionStartup();
    t.after(() => startup.close("failed"));
    const result = await startup.open({ instanceId: "failed" }, async () => {
        throw new Error("<script>broken</script>");
    }, async () => {});
    startup.ready();
    const response = await fetch(result.url);
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.match(text, /Designer startup failed/);
    assert.match(text, /&lt;script&gt;/);
    assert.doesNotMatch(text, /http-equiv="refresh"/);
});
