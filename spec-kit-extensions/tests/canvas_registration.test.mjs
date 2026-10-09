import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
    validateGeneratedProvider, validateGeneratedCanvas, validateGeneratedOpen,
} from "../extension-canvas-design/scripts/validate-generated-open.mjs";

const checkout = resolve("generated-registration-fixture");
const canvasId = "my-workflow";
const requestId = "abc123";
const extensionId = `project:${canvasId}`;
const entry = join(checkout, ".github", "extensions", canvasId, "extension.mjs");
const listEntry = (id = extensionId, source = "project", path = entry) =>
    `• **my-workflow** — running\n  ID: ${id}\n  Source: ${source}\n  Path: ${path}\n  PID: 123\n`;
const list = `Discovered extensions (2):\n\n${listEntry()}\n${listEntry("user:other", "user", entry)}`;
const inspect = (id = extensionId, source = "project", path = entry, status = "running") =>
    `Extension: **my-workflow**\nID: ${id}\nSource: ${source}\nPath: ${path}\nStatus: ${status}\n`;
const args = [checkout, canvasId, requestId];
const capabilities = { canvasId, extensionId, actions: [] };
const opened = { canvasId, extensionId, instanceId: `generated-${requestId}`, url: "http://127.0.0.1/" };
const script = fileURLToPath(new URL("../extension-canvas-design/scripts/validate-generated-open.mjs",
    import.meta.url));

function invoke(stage, input) {
    return spawnSync(process.execPath, [script, stage, ...args], {
        encoding: "utf8", input: JSON.stringify(input),
    });
}

test("open-generated command validates existing provenance before reload and exact identity before open", async () => {
    const command = await readFile(new URL("../extension-canvas-design/commands/open-generated.md",
        import.meta.url), "utf8");
    for (const required of [
        "$ARGUMENTS", "handoffId", "requestId", "request.json", "settings-provenance.json",
        "sourceFingerprint", "canvas-config.json", "extensions_reload", "extensions_manage",
        "validate-generated-open.mjs", "list_canvas_capabilities", "open_canvas",
        "generated-<requestId>", "after reset/clear", "exact error",
    ]) assert.ok(command.includes(required), required);
    assert.match(command, /Require one\s+unique matching directory/);
    assert.match(command, /A present\s+but invalid request is an error/);
    assert.match(command, /Do not fill in a\s+missing result ID/);
    assert.match(command, /do not\s+regenerate/);
    assert.ok(command.includes("[A-Za-z0-9][A-Za-z0-9_-]{0,127}"));
    assert.ok(command.indexOf("settings-provenance.json") < command.indexOf("Call `extensions_reload`"));
    assert.ok(command.indexOf("Call `extensions_reload`") < command.indexOf("Call `extensions_manage`"));
    assert.ok(command.indexOf("provider` mode") < command.indexOf("list_canvas_capabilities"));
    assert.ok(command.indexOf("canvas` mode") < command.indexOf("Call `open_canvas`"));
    assert.ok(command.indexOf("Call `open_canvas`") < command.indexOf("open` mode"));
});

test("generated registration validator accepts the project provider, its canvas and opened instance", () => {
    const wanted = { canvasId, extensionId, instanceId: `generated-${requestId}`, entry: resolve(entry) };
    assert.deepEqual(validateGeneratedProvider(list, inspect(), ...args), wanted);
    assert.deepEqual(validateGeneratedCanvas(capabilities, ...args), wanted);
    assert.deepEqual(validateGeneratedOpen(opened, ...args), wanted);
    for (const [stage, input] of [
        ["provider", { list, inspect: inspect() }],
        ["canvas", { capabilities }],
        ["open", { opened }],
    ]) {
        const response = invoke(stage, input);
        assert.equal(response.status, 0, response.stderr);
        assert.deepEqual(JSON.parse(response.stdout), wanted);
    }
    assert.equal(validateGeneratedOpen({ ...opened, instanceId: "generated-request_2" },
        checkout, canvasId, "request_2").instanceId, "generated-request_2");
    assert.equal(validateGeneratedProvider(list, inspect(), checkout, canvasId, "request_2").instanceId,
        "generated-request_2");
});

test("generated registration rejects missing, duplicate, user-owned, wrong-path and failed providers", () => {
    for (const [registered, details] of [
        [listEntry("user:my-workflow", "user"), inspect()],
        [list + listEntry(), inspect()],
        [listEntry(extensionId, "user"), inspect()],
        [listEntry(extensionId, "project", join(checkout, "other", "extension.mjs")), inspect()],
        [list, inspect("user:my-workflow")],
        [list, inspect(extensionId, "user")],
        [list, inspect(extensionId, "project", join(checkout, "other", "extension.mjs"))],
        [list, inspect(extensionId, "project", entry, "failed")],
    ]) {
        assert.throws(() => validateGeneratedProvider(registered, details, ...args),
            /Generated canvas registration:/);
        const response = invoke("provider", { list: registered, inspect: details });
        assert.notEqual(response.status, 0);
        assert.match(response.stderr, /Generated canvas registration:/);
    }
});

test("generated registration rejects incompatible or unidentifiable canvas and open results", () => {
    for (const result of [
        { ...capabilities, extensionId: "user:my-workflow" },
        { ...capabilities, canvasId: "another-canvas" },
        { canvasId, actions: [] },
        { extensionId, actions: [] },
        null,
    ]) {
        assert.throws(() => validateGeneratedCanvas(result, ...args), /Generated canvas registration:/);
        assert.notEqual(invoke("canvas", { capabilities: result }).status, 0);
    }
    for (const result of [
        { ...opened, instanceId: "generated-other" },
        { ...opened, extensionId: "plugin:other:my-workflow" },
        { ...opened, canvasId: "another-canvas" },
        { canvasId, extensionId },
    ]) {
        assert.throws(() => validateGeneratedOpen(result, ...args), /Generated canvas registration:/);
        assert.notEqual(invoke("open", { opened: result }).status, 0);
    }
});

test("generated registration fails closed on malformed tool input and invalid expectations", () => {
    assert.notEqual(spawnSync(process.execPath, [script, "provider", ...args], {
        encoding: "utf8", input: "{not-json",
    }).status, 0);
    assert.notEqual(invoke("unrecognized", { list, inspect: inspect() }).status, 0);
    assert.throws(() => validateGeneratedProvider(list, inspect(), checkout, "../other", requestId),
        /invalid checkout, canvas ID or request ID/);
    for (const invalid of ["con", "lpt1", "speckit-wizard", "a".repeat(101)]) {
        assert.throws(() => validateGeneratedProvider(list, inspect(), checkout, invalid, requestId),
            /invalid checkout, canvas ID or request ID/);
    }
    const maxId = "a".repeat(100);
    assert.equal(validateGeneratedCanvas({ canvasId: maxId, extensionId: `project:${maxId}` },
        checkout, maxId, requestId).canvasId, maxId);
    assert.notEqual(spawnSync(process.execPath, [script, "canvas", checkout, "con", requestId], {
        encoding: "utf8", input: JSON.stringify({ capabilities }),
    }).status, 0);
    assert.throws(() => validateGeneratedProvider(list, inspect(), checkout, canvasId, "../other"),
        /invalid checkout, canvas ID or request ID/);
    assert.throws(() => validateGeneratedProvider(list, inspect(), checkout, canvasId, "a".repeat(129)),
        /invalid checkout, canvas ID or request ID/);
});
