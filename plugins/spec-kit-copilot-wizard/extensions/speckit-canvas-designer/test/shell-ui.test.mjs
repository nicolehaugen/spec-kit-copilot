import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../ui/app.js", import.meta.url), "utf8");

test("Designer fixed-shell theme toggle follows preference, persists choice and remains accessible", async () => {
    const html = await readFile(new URL("../ui/index.html", import.meta.url), "utf8");
    const css = await readFile(new URL("../ui/styles.css", import.meta.url), "utf8");
    assert.match(html, /id="theme-toggle"[^>]*aria-label="Toggle theme"/);
    assert.match(css, /\[data-theme="dark"\]\s*\{/);
    const start = source.indexOf('const themeKey = "speckit-designer.theme";');
    const end = source.indexOf("function outputPathsReady()", start);
    assert.ok(start >= 0 && end > start);

    let theme = null;
    let click;
    const attributes = new Map();
    const button = {
        addEventListener: (_name, handler) => { click = handler; },
        setAttribute: (name, value) => attributes.set(name, value),
        getAttribute: (name) => attributes.get(name),
    };
    const document = {
        documentElement: {
            getAttribute: () => theme,
            setAttribute: (_name, value) => { theme = value; },
        },
        getElementById: () => button,
    };
    let saved = null;
    const localStorage = {
        getItem: () => saved,
        setItem: (_key, value) => { saved = value; },
    };
    const run = () => runInNewContext(source.slice(start, end), {
        document, window: { matchMedia: () => ({ matches: true }) }, localStorage,
    });
    run();
    assert.equal(theme, "dark");
    assert.equal(attributes.get("aria-label"), "Switch to light theme");
    click();
    assert.equal(theme, "light");
    assert.equal(saved, "light");
    assert.equal(button.title, "Switch to dark theme");
    theme = null;
    run();
    assert.equal(theme, "light");
});

test("Designer health check reports failed and restored connections without replacing drafts", async () => {
    const start = source.indexOf('const status = document.getElementById("conn-status");');
    const end = source.lastIndexOf("try {", source.indexOf("    [{ mountIdentity", start));
    assert.ok(start >= 0 && end > start);
    const status = {};
    const errorBox = { textContent: "" };
    const draft = { "canvas.displayName": "Unsaved title" };
    let response = { ok: true, json: async () => ({ generationAvailable: true, generationError: null }) };
    let polls;
    let reloaded = false;
    const check = runInNewContext(`${source.slice(start, end)}\ncheckConnection`, {
        document: { getElementById: () => status },
        errorBox,
        token: "test",
        model: {},
        draft,
        fetch: async () => response,
        updateGenerate: () => {},
        AbortSignal,
        encodeURIComponent,
        showError: (message) => { errorBox.textContent = message; },
        setInterval: (handler) => { polls = handler; return 1; },
        clearInterval: () => {},
        window: { addEventListener: () => {} },
        location: { reload: () => { reloaded = true; } },
    });
    assert.equal(status.textContent, undefined);
    await check();
    assert.equal(status.textContent, "Live");
    response = { ok: false, status: 503 };
    polls();
    await check();
    assert.equal(status.textContent, "Disconnected");
    assert.match(errorBox.textContent, /connection interrupted.*503.*Unsaved edits remain/);
    assert.equal(draft["canvas.displayName"], "Unsaved title");
    response = { ok: true, json: async () => ({ generationAvailable: true, generationError: null }) };
    await check();
    assert.equal(status.textContent, "Live");
    assert.equal(errorBox.textContent, "");
    assert.equal(reloaded, false);
});

test("Generate remains disabled for the queued ID and enables for a different saved ID", () => {
    const start = source.indexOf("function outputPathsReady()");
    const end = source.indexOf("function confirmProviders(", start);
    assert.ok(start >= 0 && end > start);
    const generate = { disabled: false };
    const generationError = { textContent: "", hidden: true };
    const model = {
        pages: [{ page: "designer-essentials", fields: [
            { id: "canvas.id" }, { id: "canvas.displayName" },
        ] }],
        values: { "canvas.id": "first-canvas" },
        handoffId: "handoff-1",
        generationAvailable: false,
        generationBlockers: [],
    };
    const draft = { "canvas.id": "first-canvas" };
    const update = runInNewContext(`${source.slice(start, end)}\nupdateGenerate`, {
        model, draft, draftOutputs: {}, generate, saving: false, generating: false,
        queuedCanvasId: "first-canvas", activeUploads: new Set(),
        required: ["canvas.id", "canvas.displayName"],
        document: { getElementById: () => generationError },
    });
    update();
    assert.equal(generate.disabled, true);
    draft["canvas.id"] = "second-canvas";
    update();
    assert.equal(generate.disabled, true);
    model.values["canvas.id"] = "second-canvas";
    model.generationAvailable = true;
    update();
    assert.equal(generate.disabled, false);
    draft["canvas.id"] = "first-canvas";
    update();
    assert.equal(generate.disabled, true);
});
