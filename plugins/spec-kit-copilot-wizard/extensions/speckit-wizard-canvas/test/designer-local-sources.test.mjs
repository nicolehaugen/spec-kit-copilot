import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isSupportedLocalKind, validateLocalSource } from "../server/designer-local-sources.mjs";

async function fixture(t) {
    const dir = await mkdtemp(join(tmpdir(), "speckit-local-source-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

test("only presets and extensions are supported local kinds, never bundles", () => {
    assert.equal(isSupportedLocalKind("presets"), true);
    assert.equal(isSupportedLocalKind("extensions"), true);
    assert.equal(isSupportedLocalKind("bundles"), false);
    assert.equal(isSupportedLocalKind("unknown"), false);
});

test("validates a well-formed local preset directory and returns its canonical path", async (t) => {
    const dir = await fixture(t);
    await writeFile(join(dir, "preset.yml"), "schema_version: 1\npreset:\n  id: my-preset\n  name: My Preset\n  version: 1.2.3\n");
    const result = await validateLocalSource("presets", dir);
    assert.equal(result.kind, "presets");
    assert.equal(result.id, "my-preset");
    assert.equal(result.name, "My Preset");
    assert.equal(result.version, "1.2.3");
    assert.equal(result.path, await realpath(dir));
});

test("validates a well-formed local extension directory with no version", async (t) => {
    const dir = await fixture(t);
    await writeFile(join(dir, "extension.yml"), "schema_version: 1\nextension:\n  id: extension-canvas-design\n  name: Canvas Design\n");
    const result = await validateLocalSource("extensions", dir);
    assert.equal(result.id, "extension-canvas-design");
    assert.equal(result.name, "Canvas Design");
    assert.equal(result.version, null);
});

test("rejects unsupported kinds, empty/relative paths and missing directories", async (t) => {
    const dir = await fixture(t);
    await assert.rejects(validateLocalSource("bundles", dir), /only supports presets and extensions/);
    await assert.rejects(validateLocalSource("presets", ""), /Enter a local directory path/);
    await assert.rejects(validateLocalSource("presets", "   "), /Enter a local directory path/);
    await assert.rejects(validateLocalSource("presets", "relative\\path"), /must be absolute/);
    await assert.rejects(validateLocalSource("presets", join(dir, "does-not-exist")), /Directory not found/);
    await assert.rejects(validateLocalSource("presets", `${dir}\x00bad`), /path looks invalid/);
});

test("rejects a directory missing its manifest file", async (t) => {
    const dir = await fixture(t);
    await assert.rejects(validateLocalSource("presets", dir), /Missing preset\.yml/);
    await assert.rejects(validateLocalSource("extensions", dir), /Missing extension\.yml/);
});

test("rejects an unparsable manifest", async (t) => {
    const dir = await fixture(t);
    await writeFile(join(dir, "preset.yml"), "preset: [this is not: valid: yaml");
    await assert.rejects(validateLocalSource("presets", dir), /Could not parse preset\.yml/);
});

test("rejects a manifest missing or malformed id/name/version", async (t) => {
    const dir = await fixture(t);
    const write = (body) => writeFile(join(dir, "preset.yml"), body);
    await write("preset:\n  name: Missing Id\n");
    await assert.rejects(validateLocalSource("presets", dir), /missing a valid preset\.id/);
    await write("preset:\n  id: ../escape\n  name: Bad Id\n");
    await assert.rejects(validateLocalSource("presets", dir), /missing a valid preset\.id/);
    await write("preset:\n  id: ok-id\n");
    await assert.rejects(validateLocalSource("presets", dir), /missing a preset\.name/);
    await write("preset:\n  id: ok-id\n  name: OK\n  version: \"not a version!\"\n");
    await assert.rejects(validateLocalSource("presets", dir), /invalid preset\.version/);
});

test("rejects a manifest whose section key does not match the declared kind", async (t) => {
    const dir = await fixture(t);
    // An extension.yml nested under `extension:` has no `preset:` section,
    // so requesting it as a local preset must fail the same way a manifest
    // with a missing id would.
    await writeFile(join(dir, "preset.yml"), "extension:\n  id: wrong-section\n  name: Wrong Section\n");
    await assert.rejects(validateLocalSource("presets", dir), /missing a valid preset\.id/);
});
