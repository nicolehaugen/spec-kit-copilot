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
    let prefersDark = true;
    let onColorChange;
    const preference = { get matches() { return prefersDark; },
        addEventListener: (_name, handler) => { onColorChange = handler; } };
    const localStorage = {
        getItem: () => saved,
        setItem: (_key, value) => { saved = value; },
    };
    const run = () => runInNewContext(source.slice(start, end), {
        document, window: { matchMedia: () => preference }, localStorage,
    });
    run();
    assert.equal(theme, "dark");
    assert.equal(attributes.get("aria-label"), "Switch to light theme");
    prefersDark = false;
    onColorChange({ matches: false });
    assert.equal(theme, "light");
    click();
    assert.equal(theme, "dark");
    assert.equal(saved, "dark");
    assert.equal(button.title, "Switch to light theme");
    onColorChange({ matches: true });
    onColorChange({ matches: false });
    assert.equal(theme, "dark");
    theme = null;
    run();
    assert.equal(theme, "dark");
});

test("dark badge text and accent buttons meet small-text contrast", async () => {
    const css = await readFile(new URL("../ui/styles.css", import.meta.url), "utf8");
    const dark = css.match(/\[data-theme="dark"\]\s*\{([^}]+)\}/)?.[1];
    assert.ok(dark);
    const systemDark = css.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{([^}]+)\}/)?.[1];
    assert.ok(systemDark);
    const value = (name) => dark.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))?.[1];
    const luminance = (hex) => {
        const channels = hex.slice(1).match(/../g).map((part) => {
            const channel = Number.parseInt(part, 16) / 255;
            return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
        });
        return channels.reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    };
    const contrast = (foreground, background) => {
        const [lighter, darker] = [luminance(foreground), luminance(background)]
            .sort((a, b) => b - a);
        return (lighter + .05) / (darker + .05);
    };
    for (const color of ["purple", "pink", "orange"]) {
        assert.ok(contrast(value(`badge-${color}`), value("background-color-secondary")) >= 4.5, color);
        assert.match(css, new RegExp(`\\.badge-preview\\[data-color="${color}"\\] \\{ color: var\\(--badge-${color}\\)`));
        assert.match(systemDark, new RegExp(`--badge-${color}:\\s*${value(`badge-${color}`)}`, "i"));
    }
    assert.ok(contrast(value("accent-contrast"), value("accent-color")) >= 4.5);
    assert.match(css, /\.badge-toolbar > \.badge-add[^}]+color: var\(--accent-contrast\)/);
    assert.match(css, /\.badge-editor \.badge-actions button:first-child[^}]+color: var\(--accent-contrast\)/);
});

test("Generate remembers the submitted ID when the draft changes during dispatch", async () => {
    const start = source.indexOf('generate.addEventListener("click"');
    const end = source.indexOf("function element(", start);
    assert.ok(start >= 0 && end > start);
    const draft = { "canvas.id": "first-canvas" };
    let click, release, submitted;
    const context = {
        generate: { disabled: false, addEventListener: (_name, handler) => { click = handler; } },
        model: { preview: false, templates: [], revision: "model-1", settingsRevision: 0 },
        draft, draftOutputs: {}, draftBadges: [], queuedCanvasId: null, token: "test",
        generating: false, status: {}, messageBox: {}, checkReady: () => true,
        showError: () => {}, updateGenerate: () => {},
        showFieldError: (message) => { throw new Error(message); },
        fetch: (_url, options) => {
            submitted = JSON.parse(options.body).values["canvas.id"];
            return new Promise((resolve) => { release = resolve; });
        },
        structuredClone, encodeURIComponent,
    };
    runInNewContext(source.slice(start, end), context);
    const request = click();
    assert.equal(submitted, "first-canvas");
    draft["canvas.id"] = "second-canvas";
    release({ ok: true, json: async () => ({ target: ".github/extensions/first-canvas/" }) });
    await request;
    assert.equal(context.queuedCanvasId, "first-canvas");
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
    const generationNote = { textContent: "", hidden: true };
    const model = {
        pages: [{ page: "designer-essentials", fields: [
            { id: "canvas.id" }, { id: "canvas.displayName" },
        ] }],
        values: { "canvas.id": "first-canvas" },
        handoffId: "handoff-1",
        generationAvailable: false,
        generationError: "Generation is already queued for this Designer panel",
        generationBlockers: [],
    };
    const draft = { "canvas.id": "first-canvas" };
    const update = runInNewContext(`${source.slice(start, end)}\nupdateGenerate`, {
        model, draft, draftOutputs: {}, generate, saving: false, generating: false,
        queuedCanvasId: "first-canvas", activeUploads: new Set(),
        required: ["canvas.id", "canvas.displayName"],
        document: { getElementById: (id) =>
            id === "generation-note" ? generationNote : generationError },
    });
    update();
    assert.equal(generate.disabled, true);
    assert.equal(generationError.hidden, true);
    assert.equal(generationNote.hidden, false);
    assert.match(generationNote.textContent, /already queued/);
    draft["canvas.id"] = "second-canvas";
    update();
    assert.equal(generate.disabled, true);
    model.values["canvas.id"] = "second-canvas";
    model.generationAvailable = true;
    model.generationError = null;
    update();
    assert.equal(generate.disabled, false);
    assert.equal(generationNote.hidden, true);
    assert.equal(generationError.hidden, true);
    draft["canvas.id"] = "first-canvas";
    update();
    assert.equal(generate.disabled, true);
    model.values["canvas.id"] = "first-canvas";
    model.generationAvailable = false;
    model.generationError = "Canvas already exists; choose and save a different Canvas ID.";
    update();
    assert.equal(generationNote.hidden, false);
    assert.equal(generationError.hidden, true);
    model.generationError = "Canvas Design does not provide Generate in this session.";
    update();
    assert.equal(generationNote.hidden, true);
    assert.equal(generationError.hidden, false);
});
