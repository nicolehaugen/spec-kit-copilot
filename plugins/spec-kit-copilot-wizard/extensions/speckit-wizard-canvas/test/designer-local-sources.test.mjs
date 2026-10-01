import assert from "node:assert/strict";
import { mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isSupportedLocalKind, stripSurroundingQuotes, validateLocalSource } from "../server/designer-local-sources.mjs";

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

test("stripSurroundingQuotes strips exactly one balanced wrapping pair", () => {
    assert.equal(stripSurroundingQuotes("C:\\Users\\name\\dir"), "C:\\Users\\name\\dir");
    assert.equal(stripSurroundingQuotes("\"C:\\Users\\name\\dir\""), "C:\\Users\\name\\dir");
    assert.equal(stripSurroundingQuotes("'C:\\Users\\name\\dir'"), "C:\\Users\\name\\dir");
    assert.equal(stripSurroundingQuotes("/home/name/dir"), "/home/name/dir");
});

test("stripSurroundingQuotes rejects unmatched or embedded quotes", () => {
    assert.throws(() => stripSurroundingQuotes("\"C:\\Users\\name\\dir"), /quotes/);
    assert.throws(() => stripSurroundingQuotes("C:\\Users\\name\\dir\""), /quotes/);
    assert.throws(() => stripSurroundingQuotes("C:\\Users\\na\"me\\dir"), /quotes/);
    assert.throws(() => stripSurroundingQuotes("\"C:\\Users\\name\\dir'"), /quotes/);
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

test("accepts a path pasted with surrounding double quotes (Explorer 'Copy as path')", async (t) => {
    const dir = await fixture(t);
    await writeFile(join(dir, "preset.yml"), "schema_version: 1\npreset:\n  id: my-preset\n  name: My Preset\n  version: 1.2.3\n");
    const result = await validateLocalSource("presets", `"${dir}"`);
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
    await assert.rejects(validateLocalSource("presets", `"${dir}`), /quotes/);
});

test("rejects a directory missing its manifest file", async (t) => {
    const dir = await fixture(t);
    await assert.rejects(validateLocalSource("presets", dir), /Missing preset\.yml/);
    await assert.rejects(validateLocalSource("extensions", dir), /Missing extension\.yml/);
});

test("rejects a manifest larger than the bounded read limit", async (t) => {
    const dir = await fixture(t);
    const oversized = `preset:\n  id: too-big\n  name: ${"x".repeat(70000)}\n`;
    await writeFile(join(dir, "preset.yml"), oversized);
    await assert.rejects(validateLocalSource("presets", dir), /preset\.yml is too large \(max 65536 bytes\)/);
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

test("auto-detects kind from whichever manifest is present when kind is omitted/null/empty/\"auto\"", async (t) => {
    const presetDir = await fixture(t);
    await writeFile(join(presetDir, "preset.yml"), "preset:\n  id: auto-preset\n  name: Auto Preset\n  version: 1.0.0\n");
    for (const kindArg of [undefined, null, "", "auto"]) {
        const result = await validateLocalSource(kindArg, presetDir);
        assert.equal(result.kind, "presets");
        assert.equal(result.id, "auto-preset");
    }

    const extensionDir = await fixture(t);
    await writeFile(join(extensionDir, "extension.yml"), "extension:\n  id: auto-extension\n  name: Auto Extension\n");
    const extResult = await validateLocalSource(undefined, extensionDir);
    assert.equal(extResult.kind, "extensions");
    assert.equal(extResult.id, "auto-extension");
});

test("auto-detect rejects a directory with neither manifest", async (t) => {
    const dir = await fixture(t);
    await assert.rejects(validateLocalSource(undefined, dir), /No preset\.yml or extension\.yml found/);
});

test("auto-detect rejects a directory with both manifests present", async (t) => {
    const dir = await fixture(t);
    await writeFile(join(dir, "preset.yml"), "preset:\n  id: both-preset\n  name: Both Preset\n");
    await writeFile(join(dir, "extension.yml"), "extension:\n  id: both-extension\n  name: Both Extension\n");
    await assert.rejects(validateLocalSource(undefined, dir),
        /Found both preset\.yml and extension\.yml .* a local source must be exactly one/);
});

test("auto-detect still rejects unsupported explicit kinds and invalid paths", async (t) => {
    const dir = await fixture(t);
    await assert.rejects(validateLocalSource("bundles", dir), /only supports presets and extensions/);
    await assert.rejects(validateLocalSource("auto", ""), /Enter a local directory path/);
});

test("rejects a local source whose parent directory is replaced during file open", async (t) => {
    const dir = await fixture(t);
    const outside = await fixture(t);
    await writeFile(join(dir, "preset.yml"), "preset:\n  id: my-preset\n  name: My Preset\n");
    await writeFile(join(outside, "preset.yml"), "preset:\n  id: swapped-preset\n  name: Swapped Preset\n");
    const backup = `${dir}-original`;
    let replaced = false;
    try {
        await assert.rejects(validateLocalSource("presets", dir, async (path, flags) => {
            // Simulate a TOCTOU race: between `resolveCanonicalPath`
            // resolving `dir` and this `open`, its directory is renamed
            // away and replaced by a link to a different directory, so the
            // opened file no longer lives under the originally-resolved
            // canonical path.
            await rename(dir, backup);
            try {
                await symlink(outside, dir, process.platform === "win32" ? "junction" : "dir");
            } catch (error) {
                await rename(backup, dir);
                throw error;
            }
            replaced = true;
            return open(path, flags);
        }), /escaped the expected directory/);
    } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
        t.diagnostic("Windows symlink creation is not permitted; race assertion skipped");
    } finally {
        if (replaced) {
            await rm(dir, { recursive: true });
            await rename(backup, dir);
        }
    }
});

test("rejects a different opened file even if the path still passes validation", async (t) => {
    const dir = await fixture(t);
    const outside = await fixture(t);
    await writeFile(join(dir, "preset.yml"), "preset:\n  id: my-preset\n  name: My Preset\n");
    await writeFile(join(outside, "preset.yml"), "preset:\n  id: swapped-preset\n  name: Swapped Preset\n");
    await assert.rejects(
        validateLocalSource("presets", dir, (_path, flags) => open(join(outside, "preset.yml"), flags)),
        /Missing preset\.yml/,
    );
});
