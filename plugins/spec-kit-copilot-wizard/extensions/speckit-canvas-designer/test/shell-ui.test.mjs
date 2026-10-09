import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../ui/app.js", import.meta.url), "utf8");
const generationGuidance = "Canvas generation is underway. You can close the Designer now. To generate another canvas, reopen Designer after this one finishes generation.";

test("Designer shows only one message bar across repeated errors and generation guidance", () => {
    const names = ["page-error", "generation-note", "generation-error",
        "composition-error", "action-message"];
    const slots = Object.fromEntries(names.map((name) =>
        [name, { textContent: "", hidden: true }]));
    const start = source.indexOf("const messageSlots = ");
    const end = source.indexOf("let model,", start);
    const setMessage = runInNewContext(`${source.slice(start, end)}\nsetMessage`, {
        errorBox: slots["page-error"],
        generationNote: slots["generation-note"],
        generationError: slots["generation-error"],
        compositionError: slots["composition-error"],
        messageBox: slots["action-message"],
    });
    const visible = () => names.filter((name) => !slots[name].hidden);
    const exists = "Canvas already exists; choose and save a different Canvas ID.";
    setMessage(slots["generation-note"], exists);
    setMessage(slots["page-error"], exists);
    assert.deepEqual(visible(), ["page-error"]);
    setMessage(slots["page-error"], "");
    assert.deepEqual(visible(), ["generation-note"]);
    setMessage(slots["generation-note"], generationGuidance);
    setMessage(slots["action-message"], "Settings saved.");
    assert.deepEqual(visible(), ["generation-note"]);
    setMessage(slots["action-message"], "Warning: Check the generated page.");
    assert.deepEqual(visible(), ["action-message"]);
    setMessage(slots["action-message"], "");
    setMessage(slots["generation-note"], "");
    setMessage(slots["generation-error"], "Cannot generate.");
    setMessage(slots["composition-error"], "Cannot generate.");
    assert.deepEqual(visible(), ["generation-error"]);
    setMessage(slots["generation-error"], "");
    assert.deepEqual(visible(), ["composition-error"]);
});

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

test("Generate saves a snapshot and dispatches with the returned revision", async () => {
    const start = source.indexOf('generate.addEventListener("click"');
    const end = source.indexOf("function element(", start);
    assert.ok(start >= 0 && end > start);
    const draft = { "canvas.id": "first-canvas" };
    let click, release, submitted;
    const calls = [];
    const context = {
        generate: { disabled: false, addEventListener: (_name, handler) => { click = handler; } },
        model: { preview: false, templates: [], revision: "model-1", settingsRevision: 0 },
        draft, draftOutputs: {}, draftBadges: [], queuedCanvasId: null, token: "test",
        existingCanvasMessage: "Canvas already exists; choose and save a different Canvas ID.",
        generating: false, status: {}, messageBox: {}, checkReady: () => true,
        showError: () => {}, updateSave: () => {},
        setMessage: (slot, text) => { slot.textContent = text; slot.hidden = !text; },
        showFieldError: (message) => { throw new Error(message); },
        persistSettings: async (input) => {
            calls.push(["save", input.values["canvas.id"]]);
            return { revision: "model-1", settingsRevision: 1 };
        },
        fetch: (_url, options) => {
            const body = JSON.parse(options.body);
            submitted = body.values["canvas.id"];
            assert.equal(body.settingsRevision, 1);
            calls.push(["generate", submitted]);
            return new Promise((resolve) => { release = resolve; });
        },
        structuredClone, encodeURIComponent,
    };
    runInNewContext(source.slice(start, end), context);
    const request = click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(submitted, "first-canvas");
    draft["canvas.id"] = "second-canvas";
    release({ ok: true, json: async () => ({ target: ".github/extensions/first-canvas/" }) });
    await request;
    assert.deepEqual(calls, [["save", "first-canvas"], ["generate", "first-canvas"]]);
    assert.equal(context.queuedCanvasId, "first-canvas");
});

test("Generate does not dispatch or disable future attempts when the implicit save fails", async () => {
    const start = source.indexOf('generate.addEventListener("click"');
    const end = source.indexOf("function element(", start);
    let click, reported = "";
    const context = {
        generate: { disabled: false, addEventListener: (_name, handler) => { click = handler; } },
        model: { preview: false, templates: [], revision: "model-1", settingsRevision: 0 },
        draft: { "canvas.id": "first-canvas" }, draftOutputs: {}, draftBadges: [],
        existingCanvasMessage: "Canvas already exists; choose and save a different Canvas ID.",
        queuedCanvasId: null, token: "test", generating: false, messageBox: {},
        checkReady: () => true, showError: () => {}, updateSave: () => {},
        setMessage: (slot, text) => { slot.textContent = text; slot.hidden = !text; },
        showFieldError: (message) => { reported = message; },
        persistSettings: async () => { throw new Error("stale settings revision"); },
        fetch: () => { throw new Error("Generate must not be dispatched"); },
        structuredClone, encodeURIComponent,
    };
    runInNewContext(source.slice(start, end), context);
    await click();
    assert.match(reported, /Could not save settings: stale settings revision/);
    assert.equal(context.queuedCanvasId, null);
    assert.equal(context.generating, false);
});

test("Designer health check reports failed and restored connections without replacing drafts", async () => {
    const start = source.indexOf('const status = document.getElementById("conn-status");');
    const end = source.lastIndexOf("try {", source.indexOf("    [{ mountIdentity", start));
    assert.ok(start >= 0 && end > start);
    const status = {};
    const errorBox = { textContent: "" };
    const generationNote = { textContent: "", hidden: true };
    const draft = { "canvas.displayName": "Unsaved title" };
    let response = { ok: true, json: async () => ({ generationAvailable: true, generationError: null }) };
    let polls;
    let reloaded = false;
    const { checkConnection: check, setQueued } = runInNewContext(`${source.slice(start, end)}
({ checkConnection, setQueued: (id) => { queuedCanvasId = id; } })`, {
        document: { getElementById: (id) =>
            id === "generation-note" ? generationNote : status },
        errorBox,
        generationNote,
        token: "test",
        model: {},
        draft,
        queuedCanvasId: null,
        generationGuidance,
        generating: false,
        fetch: async () => response,
        updateGenerate: () => {},
        AbortSignal,
        encodeURIComponent,
        showError: (message) => { errorBox.textContent = message; },
        setMessage: (slot, text) => { slot.textContent = text; slot.hidden = !text; },
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
    assert.equal(errorBox.textContent, "");
    assert.match(generationNote.textContent, /connection interrupted.*503.*Unsaved edits remain/);
    assert.match(generationNote.textContent, /restart Designer \(close this panel and open Designer again\)/);
    assert.equal(draft["canvas.displayName"], "Unsaved title");
    response = { ok: true, json: async () => ({ generationAvailable: true, generationError: null }) };
    await check();
    assert.equal(status.textContent, "Live");
    assert.equal(errorBox.textContent, "");
    assert.equal(reloaded, false);
    setQueued("first-canvas");
    response = { ok: false, status: 503 };
    await check();
    assert.equal(status.textContent, "Disconnected");
    assert.equal(errorBox.textContent, "");
    assert.equal(generationNote.textContent, generationGuidance);
});

test("queued editing lock belongs to this panel, not a new Designer instance", () => {
    const start = source.indexOf("function updateSave()");
    const end = source.indexOf("async function persistSettings(", start);
    const evaluate = (queuedCanvasId) => {
        const saveButton = {
            disabled: false, setAttribute: () => {}, removeAttribute: () => {},
        };
        const root = { inert: false };
        const tabs = { children: [{ disabled: false }] };
        const help = { title: "" };
        const update = runInNewContext(`${source.slice(start, end)}\nupdateSave`, {
            model: { preview: false, persisted: true, values: { "canvas.id": "first" },
                outputs: {}, badges: [], pages: [{}] },
            draft: { "canvas.id": "second" }, draftOutputs: {}, draftBadges: [],
            saveButton, root, tabs, saving: false, generating: false,
            queuedCanvasId, activeUploads: new Set(), outputPathsReady: () => true,
            updateGenerate: () => {},
            document: { getElementById: () => help },
        });
        update();
        return { saveButton, root, tabs };
    };
    const queued = evaluate("first");
    assert.equal(queued.saveButton.disabled, true);
    assert.equal(queued.root.inert, true);
    assert.equal(queued.tabs.children[0].disabled, true);
    const newInstance = evaluate(null);
    assert.equal(newInstance.saveButton.disabled, false);
    assert.equal(newInstance.root.inert, false);
    assert.equal(newInstance.tabs.children[0].disabled, false);
});

test("Generate stays disabled in the queued panel even after publication and a different saved ID", () => {
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
    const context = {
        model, draft, draftOutputs: {}, generate, generationNote, generationError,
        saving: false, generating: false,
        queuedCanvasId: "first-canvas", generationGuidance, activeUploads: new Set(),
        existingCanvasMessage: "Canvas already exists; choose and save a different Canvas ID.",
        setMessage: (slot, text) => {
            slot.textContent = text;
            const selected = generationNote.textContent ? generationNote
                : generationError.textContent ? generationError : null;
            for (const item of [generationNote, generationError]) item.hidden = item !== selected;
        },
        required: ["canvas.id", "canvas.displayName"],
        document: { getElementById: (id) =>
            id === "generation-note" ? generationNote : generationError },
    };
    const update = runInNewContext(`${source.slice(start, end)}\nupdateGenerate`, context);
    context.queuedCanvasId = null;
    context.generating = true;
    update();
    assert.equal(generationNote.hidden, true);
    context.queuedCanvasId = "first-canvas";
    context.generating = false;
    update();
    assert.equal(generate.disabled, true);
    assert.equal(generationError.hidden, true);
    assert.equal(generationNote.hidden, false);
    assert.equal(generationNote.textContent, generationGuidance);
    draft["canvas.id"] = "second-canvas";
    update();
    assert.equal(generate.disabled, true);
    model.values["canvas.id"] = "second-canvas";
    model.generationAvailable = true;
    model.generationError = null;
    update();
    assert.equal(generate.disabled, true);
    assert.equal(generationNote.hidden, false);
    assert.equal(generationError.hidden, true);
    assert.equal(generationNote.textContent, generationGuidance);
    draft["canvas.id"] = "first-canvas";
    update();
    assert.equal(generate.disabled, true);
    model.values["canvas.id"] = "first-canvas";
    model.generationAvailable = false;
    model.generationError = "Canvas already exists; choose and save a different Canvas ID.";
    update();
    assert.equal(generationNote.hidden, false);
    assert.equal(generationNote.textContent, generationGuidance);
    assert.equal(generationError.hidden, true);
    model.generationError = "Canvas Design does not provide Generate in this session.";
    update();
    assert.equal(generationNote.hidden, false);
    assert.equal(generationError.hidden, true);
    assert.equal(generationError.textContent, model.generationError);
});
