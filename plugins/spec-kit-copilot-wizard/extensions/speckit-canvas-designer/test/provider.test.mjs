import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { appendFile, copyFile, cp, mkdtemp, mkdir, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    fingerprint, handoffDirectory, HANDOFF_LIMIT, readHandoff, validateHandoff,
    validateHandoffId,
} from "../handoff.mjs";
import { shellHtml, startShell } from "../server.mjs";
import { assertPageCommand, loadResolvedDesignerPages, readFrozenAsset } from "../pages.mjs";
import {
    loadDesignerSettings, SAVE_REQUEST_LIMIT, saveDesignerSettings, SETTINGS_LIMIT,
} from "../settings.mjs";
import { freezeGeneration } from "../generation.mjs";

const ID = "designer_1";

test("Designer packages the same control validator as the generated app", async () => {
    assert.deepEqual(await readFile(new URL("../control-contract.mjs", import.meta.url)),
        await readFile(new URL(
            "../../../../../spec-kit-extensions/extension-canvas-design/templates/generated-canvas/control-contract.mjs",
            import.meta.url)));
});

function validHandoff(id = ID) {
    const workflow = { selectedPhases: ["specify", "plan"] };
    const selections = {
        presets: [{ id: "theme", source: "copilot", approved: true,
            version: "1.2.3", downloadUrl: "https://example.com/theme" }],
        extensions: [],
        bundles: [{ id: "starter", source: "default", approved: true,
            version: null, downloadUrl: null }],
    };
    return { schemaVersion: 1, handoffId: id, workflow, selections,
        sourceFingerprint: fingerprint({ workflow, selections }) };
}

async function fixture(t) {
    const workspace = await mkdtemp(join(tmpdir(), "speckit-designer-test-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    return workspace;
}

async function saveHandoff(workspace, handoff = validHandoff()) {
    const directory = handoffDirectory(workspace, handoff.handoffId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "handoff.json"), JSON.stringify(handoff));
    return directory;
}

async function projectFixture(t, workspace) {
    const project = join(workspace, "project");
    const specify = join(project, ".specify");
    const installed = join(specify, "extensions", "extension-canvas-design");
    const source = fileURLToPath(new URL("../../../../../spec-kit-extensions/extension-canvas-design/", import.meta.url));
    await mkdir(join(installed, "pages"), { recursive: true });
    await mkdir(join(installed, "schemas"), { recursive: true });
    await mkdir(join(project, ".github", "skills", "speckit-extension-canvas-design-load-page"),
        { recursive: true });
    await writeFile(join(project, ".github", "skills", "speckit-extension-canvas-design-load-page", "SKILL.md"), "test");
    await writeFile(join(specify, "extensions", ".registry"),
        JSON.stringify({ extensions: { "extension-canvas-design": { enabled: true } } }));
    await copyFile(join(source, "schemas", "page.schema.json"),
        join(installed, "schemas", "page.schema.json"));
    const pages = [["setup", "essentials"], ["artifacts", "artifacts"],
        ["appearance", "appearance"]];
    const entries = [];
    for (const [name, filename] of pages) {
        const path = join(installed, "pages", `${filename}.json`);
        await copyFile(join(source, "pages", `${filename}.json`), path);
        entries.push({ name: `canvas-settings-${name}`, path,
            kind: "designer.page", strategy: "replace" });
    }
    t.after(() => rm(project, { recursive: true, force: true }));
    return { project, entries };
}

test("handoff validates bounded IDs, shape, URLs and fingerprint", () => {
    const good = validHandoff();
    assert.equal(validateHandoff(good, ID), good);
    for (const id of ["", "../escape", "space here", "x".repeat(129), null]) {
        assert.throws(() => validateHandoffId(id), /Invalid Designer handoff ID/);
    }
    assert.throws(() => validateHandoff(good, "different"), /Invalid Designer handoff/);
    const mutate = (change) => {
        const copy = structuredClone(good);
        change(copy);
        copy.sourceFingerprint = fingerprint({ workflow: copy.workflow, selections: copy.selections });
        return copy;
    };
    const invalid = [
        mutate((copy) => { copy.extra = "unexpected"; }),
        mutate((copy) => { copy.workflow.selectedPhases = Array(31).fill("plan"); }),
        mutate((copy) => { copy.selections.presets.push({ ...copy.selections.presets[0] }); }),
        mutate((copy) => { copy.selections.presets[0].downloadUrl = "http://example.com"; }),
        mutate((copy) => { copy.selections.presets[0].downloadUrl = "https://user:pass@example.com"; }),
        mutate((copy) => { copy.selections.bundles[0].approved = false; }),
        mutate((copy) => { delete copy.selections.extensions; }),
        mutate((copy) => { copy.selections.presets[0].id = "../escape"; }),
    ];
    for (const handoff of invalid) {
        assert.throws(() => validateHandoff(handoff, ID), /Invalid Designer handoff/);
    }
    const changed = structuredClone(good);
    changed.workflow.selectedPhases.push("tasks");
    assert.throws(() => validateHandoff(changed, ID), /fingerprint mismatch/);
});

test("handoff accepts additive localSelections (presets/extensions only) and rejects malformed ones", () => {
    const base = validHandoff();
    const withLocal = (localSelections) => {
        const copy = structuredClone(base);
        copy.localSelections = localSelections;
        copy.sourceFingerprint = fingerprint({
            workflow: copy.workflow, selections: copy.selections, localSelections,
        });
        return copy;
    };
    const goodLocal = withLocal({
        presets: [{ id: "my-preset", source: "local", approved: true, path: "C:\\dev\\my-preset" }],
        extensions: [{ id: "extension-canvas-design", source: "local", approved: true, path: "/home/dev/ext" }],
    });
    assert.equal(validateHandoff(goodLocal, ID), goodLocal);
    // A fingerprint computed without localSelections never matches a handoff
    // that declares localSelections (and vice versa) — the field is part of
    // the signed payload, not a trailing decoration.
    const staleFingerprint = structuredClone(goodLocal);
    staleFingerprint.sourceFingerprint = fingerprint({
        workflow: staleFingerprint.workflow, selections: staleFingerprint.selections,
    });
    assert.throws(() => validateHandoff(staleFingerprint, ID), /fingerprint mismatch/);
    const invalidLocal = [
        withLocal({ bundles: [] }),
        withLocal({ presets: "not-an-array" }),
        withLocal({ presets: Array(21).fill({ id: "a", source: "local", approved: true, path: "/a" }) }),
        withLocal({ presets: [{ id: "dup", source: "local", approved: true, path: "/a" },
            { id: "dup", source: "local", approved: true, path: "/b" }] }),
        withLocal({ presets: [{ id: "x", source: "copilot", approved: true, path: "/a" }] }),
        withLocal({ presets: [{ id: "x", source: "local", approved: false, path: "/a" }] }),
        withLocal({ presets: [{ id: "x", source: "local", approved: true, path: "relative/path" }] }),
        withLocal({ presets: [{ id: "x", source: "local", approved: true, path: "/a", downloadUrl: null }] }),
        withLocal({ presets: [{ id: "../escape", source: "local", approved: true, path: "/a" }] }),
    ];
    for (const handoff of invalidLocal) {
        assert.throws(() => validateHandoff(handoff, ID), /Invalid Designer handoff/);
    }
});

test("handoff reads only validated artifacts from its session workspace", async (t) => {
    const workspace = await fixture(t);
    const handoff = validHandoff();
    const directory = await saveHandoff(workspace, handoff);
    assert.deepEqual(await readHandoff(workspace, ID), handoff);
    await assert.rejects(readHandoff(workspace, "../escape"), /Invalid Designer handoff ID/);
    await assert.rejects(readHandoff("", ID), /Designer session workspace is unavailable/);
    await assert.rejects(readHandoff(workspace, "other"), { code: "ENOENT" });

    const path = join(directory, "handoff.json");
    await writeFile(path, `${JSON.stringify(handoff)}\r\n`);
    assert.deepEqual(await readHandoff(workspace, ID), handoff);
    await writeFile(path, "{broken");
    await assert.rejects(readHandoff(workspace, ID), /Malformed Designer handoff/);
    await writeFile(path, JSON.stringify({ ...handoff, sourceFingerprint: "0".repeat(64) }));
    await assert.rejects(readHandoff(workspace, ID), /fingerprint mismatch/);
    await writeFile(path, "x".repeat(HANDOFF_LIMIT + 1));
    await assert.rejects(readHandoff(workspace, ID), /Invalid Designer handoff file/);

    const outside = await fixture(t);
    await saveHandoff(outside);
    await rm(directory, { recursive: true });
    try {
        await symlink(handoffDirectory(outside, ID), directory,
            process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
        t.diagnostic("Windows symlink creation is not permitted; traversal assertion skipped");
        return;
    }
    await assert.rejects(readHandoff(workspace, ID), /Designer handoff escapes session artifacts/);
});

test("handoff rejects symlinked file without following it", async (t) => {
    const workspace = await fixture(t);
    const directory = await saveHandoff(workspace);
    const path = join(directory, "handoff.json");
    const target = join(workspace, "outside.json");
    await writeFile(target, JSON.stringify(validHandoff()));
    await rm(path);
    try {
        await symlink(target, path, "file");
    } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
        t.diagnostic("Windows symlink creation is not permitted; file assertion skipped");
        return;
    }
    await assert.rejects(readHandoff(workspace, ID), /Invalid Designer handoff file/);
});

test("handoff rejects a parent directory replaced during file open", async (t) => {
    const workspace = await fixture(t);
    const outside = await fixture(t);
    const directory = await saveHandoff(workspace);
    await saveHandoff(outside);
    const backup = `${directory}-original`;
    let replaced = false;
    try {
        await assert.rejects(readHandoff(workspace, ID, async (path, flags) => {
            await rename(directory, backup);
            try {
                await symlink(handoffDirectory(outside, ID), directory,
                    process.platform === "win32" ? "junction" : "dir");
            } catch (error) {
                await rename(backup, directory);
                throw error;
            }
            replaced = true;
            return open(path, flags);
        }), /Designer handoff escapes session artifacts/);
    } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
        t.diagnostic("Windows symlink creation is not permitted; race assertion skipped");
    } finally {
        if (replaced) {
            await rm(directory, { recursive: true });
            await rename(backup, directory);
        }
    }
});

test("handoff rejects a different opened file even if the path still passes validation", async (t) => {
    const workspace = await fixture(t);
    const outside = await fixture(t);
    await saveHandoff(workspace);
    const outsideDirectory = await saveHandoff(outside);
    await assert.rejects(
        readHandoff(workspace, ID, (_path, flags) => open(join(outsideDirectory, "handoff.json"), flags)),
        /Invalid Designer handoff file/,
    );
});

test("settings reject a parent directory replaced during file open, including a missing file", async (t) => {
    const workspace = await fixture(t);
    const outside = await fixture(t);
    const handoff = validHandoff();
    const directory = await saveHandoff(workspace, handoff);
    const outsideDirectory = await saveHandoff(outside, handoff);
    const model = { revision: "snapshot", constraints: {
        "canvas.id": { type: "string", minLength: 1, maxLength: 100 },
    }, values: { "canvas.id": "" } };
    await saveDesignerSettings(outside, handoff, model, { revision: 0,
        modelRevision: model.revision, values: { "canvas.id": "outside" } });
    const backup = `${directory}-original`;
    for (const existing of [true, false]) {
        if (!existing) await rm(join(outsideDirectory, "settings.json"));
        let replaced = false;
        try {
            await assert.rejects(loadDesignerSettings(workspace, handoff, model,
                async (path, flags) => {
                    await rename(directory, backup);
                    try {
                        await symlink(outsideDirectory, directory,
                            process.platform === "win32" ? "junction" : "dir");
                    } catch (error) {
                        await rename(backup, directory);
                        throw error;
                    }
                    replaced = true;
                    return open(path, flags);
                }), /Designer settings escape session artifacts/);
        } catch (error) {
            if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
            t.diagnostic("Windows symlink creation is not permitted; settings race assertion skipped");
            return;
        } finally {
            if (replaced) {
                await rm(directory, { recursive: true });
                await rename(backup, directory);
            }
        }
    }
});

test("settings reject a different opened file even when their parent remains valid", async (t) => {
    const workspace = await fixture(t);
    const outside = await fixture(t);
    const handoff = validHandoff();
    await saveHandoff(workspace, handoff);
    const outsideDirectory = await saveHandoff(outside, handoff);
    const model = { revision: "snapshot", constraints: {
        "canvas.id": { type: "string", minLength: 1, maxLength: 100 },
    }, values: { "canvas.id": "" } };
    const request = { revision: 0, modelRevision: model.revision,
        values: { "canvas.id": "saved" } };
    await saveDesignerSettings(workspace, handoff, model, request);
    await saveDesignerSettings(outside, handoff, model, request);
    await assert.rejects(loadDesignerSettings(workspace, handoff, model,
        (_path, flags) => open(join(outsideDirectory, "settings.json"), flags)),
    /Invalid saved Designer settings file/);
});

test("settings use the canonical workspace when the session path is a symlink", async (t) => {
    const workspace = await fixture(t);
    const aliasParent = await fixture(t);
    const handoff = validHandoff();
    const folder = await saveHandoff(workspace, handoff);
    const alias = join(aliasParent, "linked-session");
    try {
        await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
        t.diagnostic("Windows symlink creation is not permitted; workspace alias assertion skipped");
        return;
    }
    try {
        assert.deepEqual(await readHandoff(alias, ID), handoff);
        const model = { revision: "snapshot", constraints: {
            "canvas.id": { type: "string", minLength: 1, maxLength: 100 },
        }, values: { "canvas.id": "" } };
        assert.equal((await loadDesignerSettings(alias, handoff, model)).settingsRevision, 0);
        await saveDesignerSettings(alias, handoff, model, { revision: 0,
            modelRevision: model.revision, values: { "canvas.id": "saved" } });
        assert.equal((await loadDesignerSettings(alias, handoff, model)).values["canvas.id"], "saved");
        assert.equal(JSON.parse(await readFile(join(folder, "settings.json"))).values["canvas.id"], "saved");
    } finally {
        await rm(alias);
    }
});

test("settings reads stay bounded when the file grows after its initial stat", async (t) => {
    const workspace = await fixture(t);
    const handoff = validHandoff();
    const folder = await saveHandoff(workspace, handoff);
    const model = { revision: "snapshot", constraints: {
        "canvas.id": { type: "string", minLength: 1, maxLength: 100 },
    }, values: { "canvas.id": "" } };
    await saveDesignerSettings(workspace, handoff, model, { revision: 0,
        modelRevision: model.revision, values: { "canvas.id": "saved" } });
    await assert.rejects(loadDesignerSettings(workspace, handoff, model,
        async (path, flags) => {
            const file = await open(path, flags);
            return {
                stat: async () => {
                    const before = await file.stat();
                    await appendFile(join(folder, "settings.json"), "x".repeat(256 * 1024 + 1));
                    return before;
                },
                read: (...args) => file.read(...args),
                close: () => file.close(),
            };
        }), /Saved Designer settings exceed the size limit/);
});

test("settings reject a swapped temporary-file parent before writing", async (t) => {
    const workspace = await fixture(t);
    const outside = await fixture(t);
    const handoff = validHandoff();
    const directory = await saveHandoff(workspace, handoff);
    const outsideDirectory = await saveHandoff(outside, handoff);
    const model = { revision: "snapshot", constraints: {
        "canvas.id": { type: "string", minLength: 1, maxLength: 100 },
    }, values: { "canvas.id": "" } };
    const backup = `${directory}-original`;
    let replaced = false;
    try {
        await assert.rejects(saveDesignerSettings(workspace, handoff, model, {
            revision: 0, modelRevision: model.revision, values: { "canvas.id": "saved" },
        }, async (path, flags, mode) => {
            await rename(directory, backup);
            try {
                await symlink(outsideDirectory, directory,
                    process.platform === "win32" ? "junction" : "dir");
            } catch (error) {
                await rename(backup, directory);
                throw error;
            }
            replaced = true;
            return open(path, flags, mode);
        }), /Designer settings escape session artifacts/);
        assert.deepEqual((await readdir(outsideDirectory)).sort(), ["handoff.json"]);
    } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
        t.diagnostic("Windows symlink creation is not permitted; settings write race assertion skipped");
    } finally {
        if (replaced) {
            await rm(directory, { recursive: true });
            await rename(backup, directory);
        }
    }
});

test("handoff rejects a FIFO promptly instead of waiting for a writer", {
    skip: process.platform === "win32",
}, async (t) => {
    const workspace = await fixture(t);
    const directory = handoffDirectory(workspace, ID);
    await mkdir(directory, { recursive: true });
    const fifo = join(directory, "handoff.json");
    const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr || created.error?.message);

    const script = `
        import { readHandoff } from ${JSON.stringify(new URL("../handoff.mjs", import.meta.url).href)};
        try {
            await readHandoff(process.argv[1], ${JSON.stringify(ID)});
            process.exitCode = 1;
        } catch (error) {
            if (!/Invalid Designer handoff file/.test(error.message)) {
                console.error(error);
                process.exitCode = 2;
            }
        }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, workspace],
        { timeout: 3000, encoding: "utf8" });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
});

test("shell serves validated pages behind its token", async (t) => {
    const workspace = await fixture(t);
    const handoff = validHandoff();
    await saveHandoff(workspace, handoff);
    const model = { pages: [{ id: "canvas-settings-setup", page: "canvas-settings-setup",
        title: "Essentials", fields: [] }], constraints: {}, values: {}, revision: "test" };
    await assert.rejects(startShell(handoff), /validated before opening/);
    await assert.rejects(startShell(handoff, model), /session workspace is required/);
    const shell = await startShell(handoff, model, { workspace });
    t.after(() => shell.close());
    const url = new URL(shell.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.match(url.searchParams.get("token"), /^[a-f0-9]{48}$/);
    const good = await fetch(shell.url);
    assert.equal(good.status, 200);
    assert.match(good.headers.get("content-type"), /text\/html/);
    assert.equal(good.headers.get("cache-control"), "no-store");
    assert.equal(good.headers.get("x-content-type-options"), "nosniff");
    assert.match(await good.text(), /Spec Kit Canvas Designer/);
    const stateUrl = new URL(`/api/state?token=${url.searchParams.get("token")}`, url);
    const state = await (await fetch(stateUrl)).json();
    assert.equal(state.pages[0].title, "Essentials");
    assert.equal(state.handoffId, handoff.handoffId);
    assert.equal((await fetch(new URL(`/events?token=${url.searchParams.get("token")}`, url))).status, 404);
    for (const [address, options] of [
        [url.origin, undefined],
        [`${url.origin}/?token=wrong`, undefined],
        [`${url.origin}/other?token=${url.searchParams.get("token")}`, undefined],
        [shell.url, { method: "POST" }],
    ]) {
        assert.equal((await fetch(address, options)).status, 404);
    }
});

test("Save persists values beside the handoff and rejects stale or invalid changes", async (t) => {
    const workspace = await fixture(t);
    const handoff = validHandoff();
    const folder = await saveHandoff(workspace, handoff);
    const { project, entries } = await projectFixture(t, workspace);
    const model = await loadResolvedDesignerPages(handoff, project, entries);
    const initial = await loadDesignerSettings(workspace, handoff, model);
    assert.equal(initial.settingsRevision, 0);
    assert.equal(initial.persisted, false);
    const values = { ...initial.values, "canvas.id": "my-canvas",
        "canvas.displayName": "My Canvas" };
    const request = { revision: 0, modelRevision: model.revision, values };
    await assert.rejects(saveDesignerSettings(workspace, handoff, model, {
        ...request, values: { ...values, "canvas.id": "../escape" },
    }), /Invalid Designer setting: canvas.id/);
    for (const id of ["con", "prn", "aux", "nul",
        ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
        ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)]) {
        await assert.rejects(saveDesignerSettings(workspace, handoff, model, {
            ...request, values: { ...values, "canvas.id": id },
        }), /Invalid Designer setting: canvas.id/);
    }
    await assert.rejects(saveDesignerSettings(workspace, handoff, model, {
        ...request, values: { ...values, unexpected: "extra" },
    }), /unexpected or missing fields/);
    const saved = await saveDesignerSettings(workspace, handoff, model, request);
    assert.equal(saved.settingsRevision, 1);
    assert.equal(saved.persisted, true);
    assert.deepEqual((await loadDesignerSettings(workspace, handoff, model)).values, values);
    const stored = JSON.parse(await readFile(join(folder, "settings.json"), "utf8"));
    assert.deepEqual(stored.values, values);
    assert.equal(stored.revision, 1);
    assert.deepEqual((await readFile(entries[0].path, "utf8")).includes("my-canvas"), false);
    await assert.rejects(saveDesignerSettings(workspace, handoff, model, request),
        /Copy any unsaved edits, then close and reopen Designer before saving/);
    const revised = await saveDesignerSettings(workspace, handoff, model,
        { ...request, revision: 1, values: { ...values, "canvas.description": "Updated" } });
    assert.equal(revised.settingsRevision, 2);
    await assert.rejects(loadDesignerSettings(workspace, handoff,
        { ...model, revision: "new-page-fingerprint" }), /do not match the current handoff or pages/);
    await writeFile(join(folder, "settings.json"), "{broken");
    await assert.rejects(loadDesignerSettings(workspace, handoff, model),
        /Invalid saved Designer settings JSON/);
});

test("token-gated Save endpoint reports errors without losing the current values", async (t) => {
    const workspace = await fixture(t);
    const handoff = validHandoff();
    await saveHandoff(workspace, handoff);
    const { project, entries } = await projectFixture(t, workspace);
    const changedPage = JSON.parse(await readFile(entries[1].path, "utf8"));
    changedPage.fields.push({ id: "changed", label: "Changed" });
    await writeFile(entries[1].path, JSON.stringify(changedPage));
    const model = await loadDesignerSettings(workspace, handoff,
        await loadResolvedDesignerPages(handoff, project, entries));
    const shell = await startShell(handoff, model, { workspace });
    t.after(() => shell.close());
    const url = new URL(shell.url);
    const saveUrl = new URL("/api/save", url);
    const values = { ...model.values, "canvas.id": "sample",
        "canvas.displayName": "Sample" };
    const payload = { revision: 0, modelRevision: model.revision, values };
    assert.equal((await fetch(saveUrl, { method: "POST", headers: {
        "Content-Type": "application/json",
    }, body: JSON.stringify(payload) })).status, 404);
    saveUrl.search = url.search;
    const post = (body) => fetch(saveUrl, { method: "POST", headers: {
        "Content-Type": "application/json",
    }, body: JSON.stringify(body) });
    const accepted = await post(payload);
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).settingsRevision, 1);
    const stateUrl = new URL("/api/state", url);
    stateUrl.search = url.search;
    assert.deepEqual((await (await fetch(stateUrl)).json()).values, values);
    const stale = await post(payload);
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /close and reopen Designer before saving/);
    const invalid = await post({ ...payload, revision: 1, values: { ...values,
        "canvas.id": "UPPER" } });
    assert.equal(invalid.status, 422);
    const invalidNamedChanged = await post({ ...payload, revision: 1,
        values: { ...values, changed: true } });
    assert.equal(invalidNamedChanged.status, 422);
    assert.equal((await invalidNamedChanged.json()).error, "Invalid Designer setting: changed");
    assert.deepEqual((await (await fetch(stateUrl)).json()).values, values);
});

test("Save reserves space for the stored envelope and rejects larger valid requests", async (t) => {
    const workspace = await fixture(t);
    const handoff = validHandoff("a".repeat(128));
    const folder = await saveHandoff(workspace, handoff);
    const { project, entries } = await projectFixture(t, workspace);
    for (const [index, entry] of entries.slice(0, 3).entries()) {
        const page = JSON.parse(await readFile(entry.path, "utf8"));
        while (page.fields.length < 100) {
            const id = `custom.${index}.${page.fields.length}`;
            page.fields.push({ id, label: id });
        }
        await writeFile(entry.path, JSON.stringify(page));
    }
    const model = await loadResolvedDesignerPages(handoff, project, entries);
    assert.equal(Object.keys(model.constraints).length, 300);
    const values = { ...model.values, "canvas.id": "example", "canvas.displayName": "Example" };
    const payload = { revision: 0, modelRevision: model.revision, values };
    let remaining = SAVE_REQUEST_LIMIT - Buffer.byteLength(JSON.stringify(payload));
    for (const id of Object.keys(values).filter((key) => key.startsWith("custom."))) {
        const length = Math.min(remaining, model.constraints[id].maxLength);
        values[id] = "x".repeat(length);
        remaining -= length;
    }
    assert.equal(remaining, 0);
    const body = JSON.stringify(payload);
    assert.equal(Buffer.byteLength(body), SAVE_REQUEST_LIMIT);
    const shell = await startShell(handoff, model, { workspace });
    t.after(() => shell.close());
    const saveUrl = new URL(shell.url);
    saveUrl.pathname = "/api/save";
    const response = await fetch(saveUrl, { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: `${body} ` });
    assert.equal(response.status, 413);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await response.json(), { error: "Designer save request is too large" });
    await assert.rejects(readFile(join(folder, "settings.json")), { code: "ENOENT" });
    const accepted = await fetch(saveUrl, { method: "POST",
        headers: { "Content-Type": "application/json" }, body });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).settingsRevision, 1);
    assert.ok((await readFile(join(folder, "settings.json"))).length <= SETTINGS_LIMIT);
});

test("Generate freezes Essentials and queues one composed skill invocation", async (t) => {
    const workspace = await fixture(t);
    const handoff = validHandoff();
    handoff.workflow.installed = { presets: [], extensions: [], bundles: [] };
    handoff.sourceFingerprint = fingerprint({ workflow: handoff.workflow, selections: handoff.selections });
    await saveHandoff(workspace, handoff);
    const { project, entries } = await projectFixture(t, workspace);
    const generateSkill = join(project, ".github", "skills",
        "speckit-extension-canvas-design-generate", "SKILL.md");
    await mkdir(join(project, ".github", "skills", "speckit-extension-canvas-design-generate"));
    await writeFile(generateSkill, "---\nname: speckit-extension-canvas-design-generate\n---\n");
    const model = await loadDesignerSettings(workspace, handoff,
        await loadResolvedDesignerPages(handoff, project, entries));
    const prompts = [];
    const shell = await startShell(handoff, model, { project, workspace,
        session: { send: async (value) => prompts.push(value.prompt) } });
    t.after(() => shell.close());
    const url = new URL(shell.url);
    const endpoint = new URL(`/api/generate?token=${url.searchParams.get("token")}`, url);
    const values = { "canvas.id": "my-canvas", "canvas.displayName": "My Canvas",
        "canvas.description": "", "canvas.workflowListName": "",
        "workflowSlug.userProvided": false };
    const post = (body, address = endpoint) => fetch(address, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: url.origin },
        body: JSON.stringify(body),
    });
    const wrongType = await fetch(endpoint, { method: "POST",
        headers: { "Content-Type": "text/plain", Origin: url.origin }, body: "{}" });
    assert.equal(wrongType.status, 422);
    assert.equal((await wrongType.json()).error, "Expected JSON Designer settings");
    const generationRequest = (settingsRevision, draft) => ({
        modelRevision: model.revision, settingsRevision, values: draft,
    });
    assert.equal((await post(generationRequest("stale", values))).status, 422);
    assert.equal((await post(generationRequest(0, {
        ...values, "canvas.id": "../outside",
    }))).status, 422);
    assert.equal((await post(generationRequest(0, values),
        new URL("/api/generate?token=wrong", url))).status, 404);
    assert.equal(prompts.length, 0);
    await rm(generateSkill);
    const unavailable = await post(generationRequest(0, values));
    assert.equal(unavailable.status, 409);
    assert.match((await unavailable.json()).error, /Launch a new Designer session using extension-canvas-design v0\.1\.6/);
    assert.equal(prompts.length, 0);
    await assert.rejects(readdir(join(workspace, "speckit-canvas-designer", "handoffs",
        handoff.handoffId, "generations")), { code: "ENOENT" });
    await writeFile(generateSkill, "---\nname: speckit-extension-canvas-design-generate\n---\n");
    const newerValues = { ...values, "canvas.description": "Newer settings" };
    const saved = await saveDesignerSettings(workspace, handoff, model,
        { revision: 0, modelRevision: model.revision, values: newerValues });
    assert.equal(saved.settingsRevision, 1);
    const stale = await post(generationRequest(0, values));
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /settings changed elsewhere/);
    assert.equal(prompts.length, 0);
    await assert.rejects(readdir(join(workspace, "speckit-canvas-designer", "handoffs",
        handoff.handoffId, "generations")), { code: "ENOENT" });
    const response = await post(generationRequest(saved.settingsRevision, newerValues));
    assert.equal(response.status, 202);
    const generated = await response.json();
    assert.equal(generated.target, ".github/extensions/my-canvas/");
    assert.match(prompts[0], /speckit-extension-canvas-design-generate skill/);
    const frozen = JSON.parse(await readFile(join(workspace, "speckit-canvas-designer",
        "handoffs", handoff.handoffId, "generations", generated.requestId, "request.json")));
    assert.equal(frozen.canvas.id, "my-canvas");
    assert.equal(frozen.canvas.description, "Newer settings");
    assert.equal(frozen.settingsRevision, 1);
    assert.deepEqual(frozen.workflow.selectedPhases, handoff.workflow.selectedPhases);
});

test("Generate accepts a saved Designer draft larger than 16KB", async (t) => {
    const workspace = await fixture(t);
    const handoff = validHandoff();
    handoff.workflow.installed = { presets: [], extensions: [], bundles: [] };
    handoff.sourceFingerprint = fingerprint({ workflow: handoff.workflow, selections: handoff.selections });
    await saveHandoff(workspace, handoff);
    const { project, entries } = await projectFixture(t, workspace);
    const page = JSON.parse(await readFile(entries[1].path, "utf8"));
    for (let index = 0; index < 20; index++) {
        page.fields.push({ id: `custom.${index}`, label: `Custom ${index}` });
    }
    await writeFile(entries[1].path, JSON.stringify(page));
    const model = await loadResolvedDesignerPages(handoff, project, entries);
    const values = { ...model.values, "canvas.id": "large-canvas",
        "canvas.displayName": "Large Canvas" };
    for (let index = 0; index < 20; index++) values[`custom.${index}`] = "x".repeat(1000);
    const saved = await saveDesignerSettings(workspace, handoff, model,
        { modelRevision: model.revision, revision: 0, values });
    const body = JSON.stringify({ modelRevision: model.revision,
        settingsRevision: saved.settingsRevision, values });
    assert.ok(Buffer.byteLength(body) > 16 * 1024);
    assert.ok(Buffer.byteLength(body) < SETTINGS_LIMIT);
    const skill = join(project, ".github", "skills",
        "speckit-extension-canvas-design-generate", "SKILL.md");
    await mkdir(join(project, ".github", "skills", "speckit-extension-canvas-design-generate"));
    await writeFile(skill, "---\nname: speckit-extension-canvas-design-generate\n---\n");
    const prompts = [];
    const shell = await startShell(handoff, saved, { project, workspace,
        session: { send: async (value) => prompts.push(value.prompt) } });
    t.after(() => shell.close());
    const url = new URL(shell.url);
    url.pathname = "/api/generate";
    const response = await fetch(url, { method: "POST",
        headers: { "Content-Type": "application/json" }, body });
    assert.equal(response.status, 202);
    assert.equal(prompts.length, 1);
    const { requestId } = await response.json();
    const frozen = JSON.parse(await readFile(join(workspace, "speckit-canvas-designer",
        "handoffs", handoff.handoffId, "generations", requestId, "request.json")));
    assert.equal(frozen.canvas.id, "large-canvas");
    assert.equal(Object.hasOwn(frozen.values, "custom.0"), false);
});

test("missing Generate skill disables the button and reports a repair path without preparing a request", async (t) => {
    const workspace = await fixture(t);
    const handoff = validHandoff();
    handoff.workflow.installed = { presets: [], extensions: [], bundles: [] };
    handoff.sourceFingerprint = fingerprint({ workflow: handoff.workflow, selections: handoff.selections });
    await saveHandoff(workspace, handoff);
    const { project, entries } = await projectFixture(t, workspace);
    const model = await loadResolvedDesignerPages(handoff, project, entries);
    const prompts = [];
    const shell = await startShell(handoff, model, { project, workspace,
        session: { send: async (value) => prompts.push(value.prompt) } });
    t.after(() => shell.close());
    const url = new URL(shell.url);
    const stateUrl = new URL(`/api/state?token=${url.searchParams.get("token")}`, url);
    const state = await (await fetch(stateUrl)).json();
    assert.equal(state.generationAvailable, false);
    assert.equal(state.generationError,
        "Canvas Design does not provide Generate in this session. Launch a new Designer session using extension-canvas-design v0.1.6 or the current local source.");
    const generateUrl = new URL(`/api/generate?token=${url.searchParams.get("token")}`, url);
    const response = await fetch(generateUrl, { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelRevision: model.revision, settingsRevision: 0, values: { ...model.values,
            "canvas.id": "my-canvas", "canvas.displayName": "My Canvas" } }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, state.generationError);
    assert.equal(prompts.length, 0);
    await assert.rejects(readdir(join(workspace, "speckit-canvas-designer", "handoffs",
        handoff.handoffId, "generations")), { code: "ENOENT" });
});

test("malformed raw request targets return 404 without stopping the shell", async (t) => {
    const shell = await startShell();
    t.after(() => shell.close());
    const url = new URL(shell.url);
    const status = await new Promise((resolve, reject) => {
        const req = request({ hostname: url.hostname, port: url.port, path: "//[" }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
        req.end();
    });
    assert.equal(status, 404);
    assert.equal((await fetch(shell.url)).status, 200);
});

test("empty shell renders without a handoff and keeps the token gate", async (t) => {
    const html = shellHtml();
    assert.match(html, /No Wizard handoff is attached yet/);
    assert.doesNotMatch(html, /Wizard handoff received|customizations queued/);
    const shell = await startShell();
    t.after(() => shell.close());
    assert.match(await (await fetch(shell.url)).text(), /No Wizard handoff is attached yet/);
    const url = new URL(shell.url);
    assert.equal((await fetch(url.origin)).status, 404);
});

test("reads the complete effective page set from the child checkout without a snapshot", async (t) => {
    const workspace = await fixture(t);
    const handoff = validHandoff();
    await saveHandoff(workspace, handoff);
    const { project, entries } = await projectFixture(t, workspace);
    await assertPageCommand(project);
    const override = join(project, ".specify", "presets", "override.json");
    await mkdir(join(project, ".specify", "presets"));
    const changed = JSON.parse(await readFile(entries[0].path, "utf8"));
    changed.fields[1].label = "Custom title";
    await writeFile(override, JSON.stringify(changed));
    const effective = [{ ...entries[0], path: override }, ...entries.slice(1)];
    const model = await loadResolvedDesignerPages(handoff, project, effective);
    assert.equal(model.pages[0].fields[1].label, "Custom title");
    assert.equal(model.pages[0].provenance.path, override);
    assert.equal((await loadResolvedDesignerPages(handoff, project, effective)).revision, model.revision);
    await assert.rejects(loadResolvedDesignerPages(handoff, project, entries.slice(1)),
        /all three Canvas Design pages/);
    await assert.rejects(loadResolvedDesignerPages(handoff, project, [...entries, entries[0]]),
        /duplicate Designer page name/);
    const missing = await loadResolvedDesignerPages(handoff, project,
        [{ ...entries[0], path: join(project, ".specify", "missing.json") }, ...entries.slice(1)]);
    assert.equal(missing.pages[0].error.name, "canvas-settings-setup");
    assert.match(missing.pages[0].error.reason, /missing/);
    assert.equal(Object.hasOwn(missing.constraints, "canvas.id"), false);
    const missingParentPath = join(project, ".specify", "not-created", "nested", "setup.json");
    const missingParent = await loadResolvedDesignerPages(handoff, project,
        [{ ...entries[0], path: missingParentPath }, ...entries.slice(1)]);
    assert.equal(missingParent.pages[0].error.path, missingParentPath);
    assert.match(missingParent.pages[0].error.reason, /missing/);
    assert.equal(missingParent.pages[1].title, "Artifacts");
    await writeFile(join(workspace, "outside.json"), JSON.stringify(changed));
    await assert.rejects(loadResolvedDesignerPages(handoff, project,
        [{ ...entries[0], path: join(workspace, "outside.json") }, ...entries.slice(1)]),
    /inside \.specify/);
    const extra = join(project, ".specify", "presets", "extra.json");
    await writeFile(extra, JSON.stringify({ schemaVersion: 1, id: "extra-settings",
        title: "Extra", order: 5, enabled: true, fields: [] }));
    const withExtra = await loadResolvedDesignerPages(handoff, project,
        [...effective, { name: "extra-settings", path: extra,
            kind: "designer.page", strategy: "replace" }]);
    assert.equal(withExtra.pages[0].title, "Extra");
    assert.equal(withExtra.pages.length, 4);
    await writeFile(extra, JSON.stringify({ schemaVersion: 1, id: "extra-settings",
        title: "Extra", order: 5, enabled: false, fields: [] }));
    assert.equal((await loadResolvedDesignerPages(handoff, project,
        [...effective, { name: "extra-settings", path: extra,
            kind: "designer.page", strategy: "replace" }])).pages.length, 3);
    await assert.rejects(loadResolvedDesignerPages(handoff, project,
        [...effective, { name: "extra-settings", path: extra,
            kind: "designer.page", strategy: "replace" }],
        [{ name: "extra-settings", path: extra, sourceId: "aaa" }]),
    /Invalid or duplicate Canvas Design template: extra-settings/);
    await writeFile(extra, JSON.stringify({ schemaVersion: 1, id: "extra-settings",
        title: "Extra", order: "invalid", fields: [] }));
    const invalidOrder = await loadResolvedDesignerPages(handoff, project,
        [...effective, { name: "extra-settings", path: extra,
            kind: "designer.page", strategy: "replace" }]);
    assert.match(invalidOrder.pages.at(-1).error.reason, /expected integer/);
    await assert.rejects(loadResolvedDesignerPages(handoff, project,
        [...effective, { name: "extra-settings", path: extra,
            kind: "designer.page", strategy: "replace" }],
        [{ name: "extra-settings", path: extra, sourceId: "aaa" }]),
    /Invalid or duplicate Canvas Design template: extra-settings/);
    await writeFile(extra, " ".repeat(256 * 1024 + 1));
    const oversized = await loadResolvedDesignerPages(handoff, project,
        [...effective, { name: "extra-settings", path: extra,
            kind: "designer.page", strategy: "replace" }]);
    assert.match(oversized.pages.at(-1).error.reason, /exceeds its size limit/);
    changed.id = "wrong-page";
    await writeFile(override, JSON.stringify(changed));
    const wrongId = await loadResolvedDesignerPages(handoff, project, effective);
    assert.match(wrongId.pages[0].error.reason, /page id does not match/);
    assert.equal(wrongId.pages[0].fields, undefined);
    await assert.rejects(readFile(join(handoffDirectory(workspace, handoff.handoffId), "pages.json")),
        { code: "ENOENT" });
});

test("valid large page files do not inflate the Designer model with raw bytes", async (t) => {
    const workspace = await fixture(t);
    const { project, entries } = await projectFixture(t, workspace);
    for (const entry of entries) {
        const contents = await readFile(entry.path, "utf8");
        await writeFile(entry.path, contents + " ".repeat(256 * 1024 - Buffer.byteLength(contents)));
    }
    const model = await loadResolvedDesignerPages(validHandoff(), project, entries);
    assert.deepEqual(model.pages.map((page) => page.page), entries.map((entry) => entry.name));
});

test("registered contributions validate slots, sources, references and deterministic order", async (t) => {
    const workspace = await fixture(t);
    const { project, entries } = await projectFixture(t, workspace);
    const handoff = validHandoff();
    const directory = join(project, ".specify", "presets");
    await mkdir(directory);
    const make = (id, sourceId, fieldId, overrides = {}) => ({
        name: `canvas-contribution-${id}`, path: join(directory, `${id}.json`), sourceId,
        kind: "designer.field", strategy: "replace",
        document: { schemaVersion: 1, id, host: "designer", slot: "essentials.options",
            order: 30, field: { id: fieldId, label: id, type: "string", control: "stock.text" },
            ...overrides },
    });

    await t.test("Billing fixture resolves only registered pages, and both slots save and freeze the same field", async (t) => {
        const workspace = await fixture(t);
        const { project, entries } = await projectFixture(t, workspace);
        const handoff = validHandoff();
        handoff.workflow.installed = { presets: [], extensions: [], bundles: [] };
        handoff.sourceFingerprint = fingerprint({ workflow: handoff.workflow, selections: handoff.selections });
        await saveHandoff(workspace, handoff);
        const preset = fileURLToPath(new URL("../../../../../spec-kit-presets/copilot-billing-canvas-test/",
            import.meta.url));
        const directory = join(project, ".specify", "presets");
        await mkdir(directory);
        const pagePath = join(directory, "billing-page.json");
        const contributionPath = join(directory, "billing-contribution.json");
        await copyFile(join(preset, "pages", "billing.json"), pagePath);
        const pageEntry = { name: "canvas-settings-billing", path: pagePath,
            kind: "designer.page", strategy: "replace" };
        const contribution = JSON.parse(await readFile(join(preset, "contributions", "billing.json")));
        const templates = [{ name: "canvas-contributions-billing", path: contributionPath,
            sourceId: "copilot-billing-canvas-test",
            kind: "designer.field", strategy: "replace" }];
        const { materialize } = await import(new URL("../../../../../spec-kit-extensions/extension-canvas-design/scripts/generate.mjs",
            import.meta.url));
        for (const slot of ["billing.options", "essentials.options"]) {
            await t.test(slot, async () => {
                await writeFile(contributionPath, JSON.stringify({ ...contribution, slot }));
                const unregistered = await loadResolvedDesignerPages(handoff, project, entries);
                assert.equal(unregistered.pages.length, 3);
                assert.equal(unregistered.values["billing.costCode"], undefined);
                const model = await loadResolvedDesignerPages(handoff, project,
                    [...entries, pageEntry], templates);
                assert.deepEqual(model.pages.map((page) => page.title),
                    ["Essentials", "Artifacts", "Appearance", "Billing"]);
                assert.equal(model.pages.find((page) => page.fields.some((field) =>
                    field.id === "billing.costCode")).page,
                slot === "essentials.options" ? "canvas-settings-setup" : "canvas-settings-billing");
                assert.equal(model.constraints["billing.costCode"].maxLength, 64);
                const values = { ...model.values, "canvas.id": `cost-${slot.split(".")[0]}`,
                    "canvas.displayName": "Cost code test", "billing.costCode": "CC-481" };
                const request = { modelRevision: model.revision, revision: 0, values };
                await assert.rejects(saveDesignerSettings(workspace, handoff, model, {
                    ...request, values: { ...values, "billing.costCode": "x".repeat(65) },
                }), /Invalid Designer setting: billing.costCode/);
                await assert.rejects(freezeGeneration({ model, values: {
                    ...values, "billing.costCode": "x".repeat(65) },
                handoff, project, workspace }), /Invalid Designer setting: billing.costCode/);
                await assert.rejects(freezeGeneration({ model, values: {
                    ...values, "canvas.displayName": "" },
                handoff, project, workspace }), /canvas.displayName|Canvas ID and Title/);
                const saved = await saveDesignerSettings(workspace, handoff, model, request);
                assert.equal((await loadDesignerSettings(workspace, handoff, model))
                    .values["billing.costCode"], "CC-481");
                const prepared = await freezeGeneration({ model: saved, values: saved.values,
                    handoff, project, workspace });
                const frozen = JSON.parse(await readFile(join(workspace, "speckit-canvas-designer",
                    "handoffs", handoff.handoffId, "generations", prepared.requestId, "request.json")));
                assert.equal(frozen.values["billing.costCode"], "CC-481");
                assert.deepEqual(frozen.generatedFields, [{ id: "billing.costCode",
                    label: "Cost code", maxLength: 64,
                    section: { id: "billing", title: "Billing" } }]);
                await materialize(project, workspace, handoff.handoffId, prepared.requestId);
                const config = JSON.parse(await readFile(join(project, prepared.target,
                    "canvas-config.json"), "utf8"));
                assert.deepEqual(config.readOnlyFields, [{ id: "billing.costCode",
                    label: "Cost code", value: "CC-481",
                    section: { id: "billing", title: "Billing" } }]);
            });
            if (slot === "billing.options") {
                const model = await loadResolvedDesignerPages(handoff, project, [...entries, pageEntry], templates);
                await assert.rejects(loadResolvedDesignerPages(handoff, project, entries, templates),
                    /unknown or incompatible Designer slot billing.options/);
                assert.equal(model.pages.length, 4);
                await rm(join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId,
                    "settings.json"));
            }
        }
        for (const patch of [
            { field: { ...contribution.field, maxLength: 1001 } },
            { field: { ...contribution.field, maxLength: 0 } },
            { generatedBinding: { presentation: "unknown" } },
            { generatedBinding: { presentation: "stock.readonly", adapter: "foreign" } },
            { generatedBinding: { presentation: "stock.readonly",
                section: { id: "", title: "Billing" } } },
            { generatedBinding: { presentation: "stock.readonly",
                section: { id: "billing", title: " " } } },
            { generatedBinding: { presentation: "stock.readonly",
                section: { id: "billing", title: "Billing", extra: true } } },
        ]) {
            await writeFile(contributionPath, JSON.stringify({ ...contribution, ...patch }));
            await assert.rejects(loadResolvedDesignerPages(handoff, project,
                [...entries, pageEntry], templates), /incompatible/);
        }
        await writeFile(contributionPath, JSON.stringify(contribution));
        const secondPath = join(directory, "second.json");
        const second = { ...contribution, id: "billing-second",
            field: { ...contribution.field, id: "billing.second" },
            generatedBinding: { presentation: "stock.readonly",
                section: { id: "other-billing", title: "Billing" } } };
        await writeFile(secondPath, JSON.stringify(second));
        const secondEntry = { name: "canvas-contributions-second", path: secondPath,
            sourceId: "copilot-billing-canvas-test",
            kind: "designer.field", strategy: "replace" };
        const sameTitle = await loadResolvedDesignerPages(handoff, project,
            [...entries, pageEntry], [...templates, secondEntry]);
        assert.deepEqual(sameTitle.contributions.map((item) => item.generatedBinding.section.title),
            ["Billing", "Billing"]);
        await writeFile(secondPath, JSON.stringify({ ...second, generatedBinding: {
            presentation: "stock.readonly", section: { id: "billing", title: "Other title" },
        } }));
        await assert.rejects(loadResolvedDesignerPages(handoff, project,
            [...entries, pageEntry], [...templates, secondEntry]), /conflicting generated section billing/);
    });
    const beta = make("beta", "zzz", "billing.beta");
    const alpha = make("alpha", "aaa", "billing.alpha");
    for (const item of [beta, alpha]) await writeFile(item.path, JSON.stringify(item.document));
    const paths = [beta, alpha].map(({ name, path, sourceId, kind, strategy }) =>
        ({ name, path, sourceId, kind, strategy }));
    const model = await loadResolvedDesignerPages(handoff, project, entries, paths);
    assert.deepEqual(model.contributions.map((item) => item.id), ["alpha", "beta"]);
    assert.deepEqual(model.pages[0].fields.slice(-2).map((field) => field.id),
        ["billing.alpha", "billing.beta"]);
    assert.equal(model.constraints["billing.alpha"].maxLength, 1000);
    assert.equal(model.values["billing.alpha"], "");
    assert.equal(model.pages.length, 3);
    const defaultModel = await loadResolvedDesignerPages(handoff, project, entries);
    assert.deepEqual(defaultModel.contributions, []);
    assert.equal(defaultModel.pages[0].fields.length, 5);
    assert.notEqual((await loadResolvedDesignerPages(handoff, project, entries, paths.slice(1))).revision,
        model.revision);

    await assert.rejects(loadResolvedDesignerPages(handoff, project, entries, [...paths, paths[0]]),
        /duplicate Canvas Design template/);
    await assert.rejects(loadResolvedDesignerPages(handoff, project, entries, [
        { ...paths[0], name: entries[0].name },
    ]), /duplicate Canvas Design template/);
    await writeFile(beta.path, JSON.stringify({ ...beta.document,
        field: { ...beta.document.field, id: "billing.alpha" } }));
    await assert.rejects(loadResolvedDesignerPages(handoff, project, entries, paths),
        /canvas-contribution-beta: duplicate field billing.alpha also defined by canvas-contribution-alpha|canvas-contribution-alpha: duplicate field billing.alpha also defined by canvas-contribution-beta/);
    await writeFile(beta.path, JSON.stringify({ ...beta.document,
        field: { ...beta.document.field, id: "canvas.id" } }));
    await assert.rejects(loadResolvedDesignerPages(handoff, project, entries, paths),
        /canvas-contribution-beta: duplicate field canvas.id also defined by canvas-settings-setup/);
    await writeFile(beta.path, JSON.stringify({ ...beta.document, slot: "unknown.slot" }));
    await assert.rejects(loadResolvedDesignerPages(handoff, project, entries, paths),
        /canvas-contribution-beta: unknown or incompatible Designer slot unknown.slot/);
    await writeFile(beta.path, JSON.stringify({ ...beta.document, requires: ["missing-template"] }));
    await assert.rejects(loadResolvedDesignerPages(handoff, project, entries, paths),
        /unresolved required Canvas Design template missing-template/);
    await writeFile(beta.path, JSON.stringify(beta.document));
    const replacement = join(directory, "project-replacement.json");
    await writeFile(replacement, JSON.stringify({ ...beta.document,
        field: { ...beta.document.field, label: "Replaced cost code" } }));
    const projectWinner = { ...paths[0], path: replacement, sourceId: "project" };
    const projectModel = await loadResolvedDesignerPages(handoff, project, entries,
        [projectWinner, paths[1]]);
    assert.equal(projectModel.contributions.find((item) => item.id === "beta").sourceId, "project");
    assert.equal(projectModel.pages[0].fields.at(-1).label, "Replaced cost code");
    assert.notEqual(projectModel.revision, model.revision);
    const duplicateSlot = JSON.parse(await readFile(entries[1].path, "utf8"));
    duplicateSlot.slots = [{ id: "essentials.options", accepts: ["field"],
        orderBy: ["order", "presetId", "id"] }];
    await writeFile(entries[1].path, JSON.stringify(duplicateSlot));
    await assert.rejects(loadResolvedDesignerPages(handoff, project, entries, paths),
        /duplicate Designer slot essentials.options also defined by canvas-settings-setup/);
    delete duplicateSlot.slots;
    await writeFile(entries[1].path, JSON.stringify(duplicateSlot));
    const modulePath = join(directory, "new-control.mjs");
    await writeFile(modulePath, "export const control = () => null;\n");
    const moduleEntry = { name: "canvas-control-new", path: modulePath, sourceId: "aaa",
        kind: "generated.renderer", strategy: "replace" };
    const registration = () => ({ kind: "template", stack: [
        { active: true, sourceId: "aaa", layer: "preset", strategy: "replace" }] });
    await assert.rejects(loadResolvedDesignerPages(handoff, project, entries,
        [...paths, moduleEntry], registration), /invalid generated renderer/);
    await writeFile(modulePath, Buffer.from([0xff]));
    await assert.rejects(loadResolvedDesignerPages(handoff, project, entries,
        [...paths, moduleEntry], registration), /Invalid Designer UTF-8/);
    await writeFile(modulePath, "export function renderPage({ root }) { root.textContent = 'ok'; }\n");
    await assert.rejects(loadResolvedDesignerPages(handoff, project, entries,
        [...paths, { ...moduleEntry, path: join(directory, "missing.mjs") }],
        registration), /ENOENT/);
    await assert.rejects(loadResolvedDesignerPages(handoff, project, entries,
        [...paths, moduleEntry], registration), /generated renderer must belong to exactly one page/);
    await assert.rejects(loadResolvedDesignerPages(handoff, project, entries, [
        { ...paths[0], path: join(workspace, "outside.json") },
    ]), /inside \.specify/);
});

test("resolved contributions cannot enlarge the assembled Designer model past its limit", async (t) => {
    const workspace = await fixture(t);
    const { project, entries } = await projectFixture(t, workspace);
    const handoff = validHandoff();
    const directory = join(project, ".specify", "presets");
    await mkdir(directory);
    const pages = [...entries];
    for (let pageIndex = 0; pageIndex < 17; pageIndex++) {
        const name = `canvas-settings-extra-${pageIndex}`;
        const path = join(directory, `${name}.json`);
        await writeFile(path, JSON.stringify({
            schemaVersion: 1, id: name, title: name, order: 100 + pageIndex,
            fields: Array.from({ length: 100 }, (_, fieldIndex) => ({
                id: `extra.${pageIndex}.${fieldIndex}`, label: "Field",
                description: "x".repeat(1000),
            })),
        }));
        pages.push({ name, path, kind: "designer.page", strategy: "replace" });
    }
    const baseline = await loadResolvedDesignerPages(handoff, project, pages);
    assert.ok(Buffer.byteLength(JSON.stringify(baseline)) <= 2 * 1024 * 1024);
    const contributions = [];
    for (let index = 0; index < 95; index++) {
        const name = `canvas-contribution-extra-${index}`;
        const path = join(directory, `${name}.json`);
        await writeFile(path, JSON.stringify({
            schemaVersion: 1, id: `extra-${index}`, host: "designer",
            slot: "essentials.options", order: index,
            field: { id: `added.${index}`, label: "Field", description: "y".repeat(1000),
                type: "string", control: "stock.text" },
        }));
        contributions.push({ name, path, sourceId: "test",
            kind: "designer.field", strategy: "replace" });
    }
    await assert.rejects(loadResolvedDesignerPages(handoff, project, pages, contributions),
        /Designer page model exceeds its size limit/);
});

test("page errors retain healthy fields and never accept unsafe or incomplete input", async (t) => {
    const workspace = await fixture(t);
    const { project, entries } = await projectFixture(t, workspace);
    const handoff = validHandoff();
    const extra = join(project, ".specify", "extra.json");
    await writeFile(extra, JSON.stringify({ schemaVersion: 1, id: "extra-settings",
        title: "Extra", order: 5, fields: [{ id: "canvas.id", label: "Collision" }] }));
    await assert.rejects(loadResolvedDesignerPages(handoff, project,
        [...entries, { name: "extra-settings", path: extra,
            kind: "designer.page", strategy: "replace" }]),
    /extra-settings: duplicate enabled field canvas.id also defined by canvas-settings-setup/);

    await writeFile(entries[0].path, "{invalid");
    const broken = await loadResolvedDesignerPages(handoff, project, entries);
    assert.equal(broken.pages[0].page, "canvas-settings-setup");
    assert.match(broken.pages[0].error.reason, /Invalid Designer JSON/);
    assert.equal(broken.pages[0].error.path, entries[0].path);
    assert.equal(Object.hasOwn(broken.values, "canvas.id"), false);
    assert.equal(broken.pages[1].title, "Artifacts");
    const allMissing = await loadResolvedDesignerPages(handoff, project, entries.map((entry, i) =>
        ({ ...entry, path: join(project, ".specify", `missing-${i}.json`) })));
    assert.equal(allMissing.pages.length, 3);
    assert.ok(allMissing.pages.every((page) => page.error && !page.fields));
    assert.deepEqual(Object.keys(allMissing.values), []);
    await assert.rejects(loadResolvedDesignerPages(handoff, project,
        [...entries.slice(0, 2), { ...entries[2], path: join(workspace, "outside.json") }]),
    /inside \.specify/);
    const outside = join(workspace, "outside.json");
    await writeFile(outside, "{}");
    const alias = join(project, ".specify", "alias.json");
    let linked = false;
    try {
        await symlink(outside, alias, "file");
        linked = true;
    } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
        t.diagnostic("Windows symlink creation is not permitted; page alias assertion skipped");
    }
    if (linked) {
        await assert.rejects(loadResolvedDesignerPages(handoff, project,
            [{ ...entries[0], path: alias }, ...entries.slice(1)]),
        /escapes its allowed directory/);
    }
    const outsideAlias = join(project, ".specify", "outside-alias");
    try {
        await symlink(workspace, outsideAlias, process.platform === "win32" ? "junction" : "dir");
        await assert.rejects(loadResolvedDesignerPages(handoff, project,
            [{ ...entries[0], path: join(outsideAlias, "missing-dir", "setup.json") },
                ...entries.slice(1)]), /escapes its allowed directory/);
    } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
        t.diagnostic("Windows symlink creation is not permitted; parent alias assertion skipped");
    }
    await assert.rejects(loadResolvedDesignerPages(handoff, project,
        [entries[0], entries[0], ...entries.slice(2)]), /duplicate Designer page name/);
});

test("generated-only page validates typed assets, freezes winners and packages without design presets", async (t) => {
    const workspace = await fixture(t);
    const { project, entries } = await projectFixture(t, workspace);
    const handoff = validHandoff();
    handoff.workflow.installed = { presets: [], extensions: [], bundles: [] };
    handoff.sourceFingerprint = fingerprint({ workflow: handoff.workflow, selections: handoff.selections });
    await saveHandoff(workspace, handoff);
    const preset = fileURLToPath(new URL("../../../../../spec-kit-presets/copilot-generated-page-test/",
        import.meta.url));
    const directory = join(project, ".specify", "presets");
    await mkdir(directory);
    const definitionPath = join(directory, "overview.json");
    const rendererPath = join(directory, "overview.mjs");
    await copyFile(join(preset, "pages", "overview.json"), definitionPath);
    await copyFile(join(preset, "pages", "overview.mjs"), rendererPath);
    const definition = JSON.parse(await readFile(definitionPath, "utf8"));
    const renderer = await readFile(rendererPath, "utf8");
    const pages = [
        { name: definition.id, path: definitionPath, sourceId: "copilot-generated-page-test",
            kind: "generated.page", strategy: "replace" },
        { name: definition.renderer, path: rendererPath, sourceId: "copilot-generated-page-test",
            kind: "generated.renderer", strategy: "replace" },
    ];
    const registration = () => ({ kind: "template", stack: [{
        active: true, sourceId: "copilot-generated-page-test", layer: "preset",
        strategy: "replace",
    }] });
    const load = (assets) => loadResolvedDesignerPages(handoff, project, entries, assets, registration);
    const defaults = await loadResolvedDesignerPages(handoff, project, entries);
    assert.deepEqual(defaults.generatedPages, []);
    const tooManyPages = Array.from({ length: 31 }, (_, index) => ({
        ...pages[0], name: `generated-page-${index}`,
    }));
    await assert.rejects(load(tooManyPages), /at most 30 generated pages/);
    let loaded;
    const executable = process.execPath;
    try {
        process.execPath = join(workspace, "copilot.exe");
        loaded = await load(pages);
    } finally {
        process.execPath = executable;
    }
    assert.deepEqual(loaded.pages.map((page) => page.page), defaults.pages.map((page) => page.page));
    assert.deepEqual(loaded.values, defaults.values);
    assert.deepEqual(loaded.generatedPages, [{ name: definition.id, ...definition }]);
    const projectPages = pages.map((page) => ({ ...page, sourceId: "project" }));
    const projectRegistration = () => ({ kind: "template", stack: [{
        active: true, sourceId: "_", layer: "project", strategy: "replace",
    }] });
    assert.deepEqual((await loadResolvedDesignerPages(handoff, project, entries,
        projectPages, projectRegistration)).generatedPages, loaded.generatedPages);
    for (const [assets, source] of [
        [projectPages, { sourceId: "_", layer: "preset" }],
        [pages, { sourceId: "copilot-generated-page-test", layer: "project" }],
        [pages.map((page) => ({ ...page, sourceId: "extension:copilot-generated-page-test" })),
            { sourceId: "copilot-generated-page-test", layer: "preset" }],
    ]) {
        await assert.rejects(loadResolvedDesignerPages(handoff, project, entries, assets,
            () => ({ kind: "template", stack: [{
                active: true, ...source, strategy: "replace",
            }] })), /replace-only Specify template/);
    }
    for (const candidate of [
        [pages.slice(0, 1), /missing generated renderer/],
        [pages.slice(1), /renderer must belong to exactly one page/],
        [[{ ...pages[0], kind: "designer.field" }, pages[1]], /Canvas Design contribution/],
        [[{ ...pages[0], path: rendererPath }, pages[1]], /must be a \.json/],
        [[pages[0], { ...pages[1], path: definitionPath }], /must be a \.mjs/],
        [[pages[0], { ...pages[1], kind: "designer.field" }], /must be a \.json/],
        [[pages[0], { ...pages[1], strategy: "append" }], /Invalid or duplicate Canvas Design template/],
        [[pages[0], { ...pages[1], strategy: "wrap" }], /Invalid or duplicate Canvas Design template/],
        [[pages[0], { ...pages[1], kind: "script" }], /Invalid or duplicate Canvas Design template/],
    ]) await assert.rejects(load(candidate[0]), candidate[1]);
    for (const invalid of [
        { kind: "script", stack: [{ active: true, sourceId: "copilot-generated-page-test",
            layer: "preset", strategy: "replace" }] },
        { kind: "template", stack: [{ active: true, sourceId: "copilot-generated-page-test",
            layer: "preset", strategy: "append" }] },
        { kind: "template", stack: [{ active: true, sourceId: "copilot-generated-page-test",
            layer: "preset", strategy: "replace" }, { active: false, strategy: "wrap" }] },
    ]) await assert.rejects(loadResolvedDesignerPages(handoff, project, entries, pages,
        () => invalid), /replace-only Specify template/);
    await writeFile(definitionPath, JSON.stringify({ ...definition, renderer: "missing-renderer" }));
    await assert.rejects(load(pages), /missing generated renderer/);
    await writeFile(definitionPath, JSON.stringify({ ...definition, extra: true }));
    await assert.rejects(load(pages), /invalid generated page definition/);
    await writeFile(definitionPath, JSON.stringify({ ...definition, id: "workflow" }));
    await assert.rejects(load([{ ...pages[0], name: "workflow" }, pages[1]]),
        /invalid generated page definition/);
    await writeFile(definitionPath, JSON.stringify(definition));
    await writeFile(rendererPath, "export function renderPage( {");
    await assert.rejects(load(pages), /invalid generated renderer/);
    await writeFile(rendererPath, "import './missing.mjs'; export function renderPage() {}");
    await assert.rejects(load(pages), /renderer must be self-contained/);
    await writeFile(join(directory, "helper.mjs"), "export function renderPage() {}");
    await writeFile(rendererPath,
        "const label = 'Overview'; import { renderPage } from './helper.mjs'; export { renderPage };");
    await assert.rejects(load(pages), /renderer must be self-contained/);
    await writeFile(rendererPath, "export { renderPage } from './helper.mjs';");
    await assert.rejects(load(pages), /renderer must be self-contained/);
    await writeFile(rendererPath,
        "export async function renderPage() { return import('./helper.mjs'); }");
    await assert.rejects(load(pages), /renderer must be self-contained/);
    await writeFile(rendererPath,
        "export function renderPage() { return import.meta.url + 'import(\"./helper.mjs\")'; }");
    assert.equal((await load(pages)).generatedPages.length, 1);
    await writeFile(rendererPath, "export const renderPage = null;");
    assert.equal((await load(pages)).generatedPages.length, 1);
    await writeFile(rendererPath, "export const renderPage = ;");
    await assert.rejects(load(pages), /invalid generated renderer/);
    await writeFile(rendererPath, "export function otherPage() {}");
    await assert.rejects(load(pages), /invalid generated renderer/);
    await writeFile(rendererPath, "const href = window.location.href; export function renderPage() { return href; }");
    assert.equal((await load(pages)).generatedPages.length, 1);
    const sideEffectPath = join(workspace, "renderer-evaluated");
    await writeFile(rendererPath,
        `process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(sideEffectPath)}, "executed"); export function renderPage() {}`);
    assert.equal((await load(pages)).generatedPages.length, 1);
    await assert.rejects(stat(sideEffectPath), { code: "ENOENT" });
    await writeFile(rendererPath, renderer);
    const billing = JSON.parse(await readFile(new URL(
        "../../../../../spec-kit-presets/copilot-billing-canvas-test/contributions/billing.json",
        import.meta.url)));
    const billingPath = join(directory, "billing.json");
    await writeFile(billingPath, JSON.stringify({ ...billing, slot: "essentials.options" }));
    const model = await load([...pages, { name: "canvas-contributions-billing",
        path: billingPath, sourceId: "copilot-billing-canvas-test",
        kind: "designer.field", strategy: "replace" }]);
    assert.equal(model.pages.length, 3);
    assert.ok(model.pages[0].fields.some((field) => field.id === "billing.costCode"));
    const values = { ...model.values, "canvas.id": "generated-only",
        "canvas.displayName": "Generated Only", "billing.costCode": "CC-481" };
    const prepared = await freezeGeneration({ model, values, handoff, project, workspace });
    await writeFile(rendererPath, `${renderer}\n// changed`);
    await assert.rejects(freezeGeneration({ model, values, handoff, project, workspace }),
        /changed since Designer opened/);
    await writeFile(rendererPath, "x".repeat(32 * 1024 + 1));
    await assert.rejects(freezeGeneration({ model, values, handoff, project, workspace }),
        /exceeds its size limit/);
    await writeFile(rendererPath, renderer);
    const { materialize } = await import(new URL(
        "../../../../../spec-kit-extensions/extension-canvas-design/scripts/generate.mjs", import.meta.url));
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const target = join(project, prepared.target);
    assert.deepEqual(JSON.parse(await readFile(join(target, "pages", `${definition.id}.json`))), definition);
    assert.equal(await readFile(join(target, "pages", `${definition.renderer}.mjs`), "utf8"), renderer);
    const portable = join(workspace, "portable");
    await mkdir(portable);
    const { cp } = await import("node:fs/promises");
    await cp(target, join(portable, "generated-only"), { recursive: true });
    const { readConfig, renderHtml, createWorkflowRoutes } = await import(pathToFileURL(
        join(portable, "generated-only", "server.mjs")).href);
    const config = readConfig();
    assert.deepEqual(config.generatedPages, [{ id: definition.id,
        title: definition.title, renderer: definition.renderer }]);
    assert.equal(config.readOnlyFields[0].value, "CC-481");
    assert.match(renderHtml(config), /data-canvas-page="canvas-generated-overview"/);
    assert.match(renderHtml(config), /data-generated-renderer="canvas-generated-overview"/);
    assert.doesNotMatch(renderHtml({ ...config, generatedPages: undefined }), /data-canvas-page=/);
    assert.equal(typeof createWorkflowRoutes, "function");
    assert.equal((await import(pathToFileURL(join(portable, "generated-only", "pages",
        `${definition.renderer}.mjs`)).href)).renderPage.name, "renderPage");
    assert.ok((await readFile(join(portable, "generated-only", "ui", "app.js"), "utf8"))
        .includes("wireGeneratedPages()"));
});

test("paired control validates both adapters, typed values and portable generated display", async (t) => {
    const workspace = await fixture(t);
    const { project, entries } = await projectFixture(t, workspace);
    const handoff = validHandoff();
    handoff.workflow.installed = { presets: [], extensions: [], bundles: [] };
    handoff.sourceFingerprint = fingerprint({ workflow: handoff.workflow, selections: handoff.selections });
    await saveHandoff(workspace, handoff);
    const preset = fileURLToPath(new URL("../../../../../spec-kit-presets/copilot-risk-matrix-test/",
        import.meta.url));
    const directory = join(project, ".specify", "presets");
    await mkdir(directory);
    const items = [
        ["canvas-control-risk-matrix", "controls/risk-matrix/control.json", "control.definition"],
        ["canvas-contributions-risk-designer", "contributions/designer.json", "designer.field"],
        ["canvas-control-risk-matrix-designer", "controls/risk-matrix/designer.mjs", "designer.adapter"],
        ["canvas-control-risk-matrix-generated", "controls/risk-matrix/generated.mjs", "generated.adapter"],
    ];
    const templates = await Promise.all(items.map(async ([name, file, kind]) => {
        const path = join(directory, `${name}${file.endsWith(".mjs") ? ".mjs" : ".json"}`);
        await copyFile(join(preset, ...file.split("/")), path);
        return { name, path, kind, sourceId: "copilot-risk-matrix-test", strategy: "replace" };
    }));
    const registration = () => ({ kind: "template", stack: [{
        active: true, sourceId: "copilot-risk-matrix-test", layer: "preset", strategy: "replace",
    }] });
    const load = (assets = templates, verify = registration) =>
        loadResolvedDesignerPages(handoff, project, entries, assets, verify);
    const model = await load();
    assert.equal(model.pages[0].fields.find((field) => field.id === "risk.rating").control, "risk-matrix");
    assert.deepEqual(model.values["risk.rating"], null);
    assert.equal(model.generatedPages.length, 0);
    assert.equal(model.adapters["risk-matrix"], "canvas-control-risk-matrix-designer");
    assert.equal(model.controls[0].template, templates[0].name);
    const controlDocument = JSON.parse(await readFile(templates[0].path, "utf8"));
    const contributionSource = await readFile(templates[1].path, "utf8");
    const contributionDocument = JSON.parse(contributionSource);
    const secondField = { ...contributionDocument, id: "risk-second-field",
        field: { ...contributionDocument.field, id: "risk.second", label: "Second risk" } };
    const secondFieldTemplate = { ...templates[1], name: "canvas-contributions-risk-second",
        path: join(directory, "risk-second.json") };
    await writeFile(secondFieldTemplate.path, JSON.stringify(secondField));
    assert.equal((await load([...templates, secondFieldTemplate])).pages[0].fields
        .filter((field) => field.control === "risk-matrix").length, 2);
    const secondControlTemplate = { ...templates[0], name: "canvas-control-risk-other",
        path: join(directory, "risk-other.json") };
    await writeFile(secondControlTemplate.path, JSON.stringify({
        ...controlDocument, id: "risk-other",
    }));
    await writeFile(secondFieldTemplate.path, JSON.stringify({
        ...secondField, requires: [secondControlTemplate.name],
        field: { ...secondField.field, control: "risk-other" },
    }));
    await assert.rejects(load([...templates, secondControlTemplate, secondFieldTemplate]),
        /designer adapter belongs to both risk-matrix and risk-other/);
    const secondDesignerAdapter = { ...templates[2], name: "canvas-control-risk-other-designer",
        path: join(directory, "risk-other.mjs") };
    await copyFile(templates[2].path, secondDesignerAdapter.path);
    await writeFile(secondControlTemplate.path, JSON.stringify({
        ...controlDocument, id: "risk-other",
        adapters: { ...controlDocument.adapters, designer: secondDesignerAdapter.name },
    }));
    await assert.rejects(load([...templates, secondControlTemplate, secondFieldTemplate,
        secondDesignerAdapter]), /generated adapter belongs to both risk-matrix and risk-other/);
    const secondGeneratedAdapter = { ...templates[3], name: "canvas-control-risk-other-generated",
        path: join(directory, "risk-other-generated.mjs") };
    await copyFile(templates[3].path, secondGeneratedAdapter.path);
    await writeFile(secondControlTemplate.path, JSON.stringify({
        ...controlDocument, id: "risk-other",
        adapters: { designer: secondDesignerAdapter.name, generated: secondGeneratedAdapter.name },
    }));
    const bothControls = [...templates, secondControlTemplate, secondFieldTemplate,
        secondDesignerAdapter, secondGeneratedAdapter];
    assert.equal((await load(bothControls)).controls.length, 2);
    await writeFile(templates[1].path, JSON.stringify({
        ...contributionDocument, requires: [secondControlTemplate.name, templates[0].name],
    }));
    await assert.rejects(load(bothControls), /object field requires exactly one control definition template/);
    await writeFile(templates[1].path, contributionSource);
    const designerAdapter = templates[2];
    const designerModule = await readFile(designerAdapter.path, "utf8");
    await writeFile(designerAdapter.path, `${designerModule}\nprocess.exit(57);`);
    assert.equal((await load()).adapters["risk-matrix"], designerAdapter.name);
    await writeFile(designerAdapter.path, designerModule);
    const raced = await load(templates, (checkout, name) => {
        if (name === designerAdapter.name) {
            writeFileSync(designerAdapter.path, "export const mount = null;");
        }
        return registration(checkout, name);
    });
    assert.equal(raced.templates.find((item) => item.name === designerAdapter.name).hash,
        model.templates.find((item) => item.name === designerAdapter.name).hash);
    await assert.rejects(startShell(handoff, raced, { project, workspace }),
        /changed since Designer opened/);
    await writeFile(designerAdapter.path, "export function mount() { throw new Error('unvalidated'); }");
    await assert.rejects(startShell(handoff, model, { project, workspace }),
        /changed since Designer opened/);
    await writeFile(designerAdapter.path, "x".repeat(32 * 1024 + 1));
    await assert.rejects(startShell(handoff, model, { project, workspace }),
        /exceeds its size limit/);
    await writeFile(designerAdapter.path, designerModule);
    const shell = await startShell(handoff, model, { project, workspace });
    t.after(() => shell.close());
    await writeFile(designerAdapter.path, "export function mount() { throw new Error('unvalidated'); }");
    const adapterUrl = new URL(shell.url);
    adapterUrl.pathname = `/adapters/${designerAdapter.name}.mjs`;
    assert.equal(await (await fetch(adapterUrl)).text(), designerModule);
    await writeFile(designerAdapter.path, designerModule);
    const moved = `${directory}-original`;
    const outside = join(workspace, "untrusted-presets");
    await mkdir(outside);
    await writeFile(join(outside, `${designerAdapter.name}.mjs`), "export function mount() {}");
    await rename(directory, moved);
    let linked = false;
    try {
        try {
            await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
            linked = true;
        } catch (error) {
            if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
            t.diagnostic("Windows symlink creation is not permitted; adapter parent assertion skipped");
        }
        if (linked) await assert.rejects(startShell(handoff, model, { project, workspace }),
            /escapes its allowed directory|changed since Designer opened/);
    } finally {
        if (linked) await rm(directory);
        await rename(moved, directory);
    }
    const values = { ...model.values, "canvas.id": "risk-demo", "canvas.displayName": "Risk",
        "risk.rating": { impact: "high", likelihood: "medium" } };
    await assert.rejects(saveDesignerSettings(workspace, handoff, model,
        { modelRevision: model.revision, revision: 0, values: { ...values, "risk.rating": null } }),
    /Invalid Designer setting: risk.rating/);
    for (const value of [null, { impact: "high" },
        { impact: "high", likelihood: "unknown" }, { impact: "high", likelihood: "medium", extra: 1 }]) {
        await assert.rejects(freezeGeneration({ model, values: { ...values, "risk.rating": value },
            handoff, project, workspace }), /Invalid Designer setting: risk.rating/);
    }
    const controlContribution = model.contributions.find((item) => item.field.id === "risk.rating");
    const controlId = (index) => index ? `risk.rating${index}` : "risk.rating";
    const controlValues = { ...values };
    const controlConstraints = { ...model.constraints };
    const controls = Array.from({ length: 31 }, (_, index) => {
        const id = controlId(index);
        controlValues[id] = values["risk.rating"];
        controlConstraints[id] = model.constraints["risk.rating"];
        return { ...controlContribution, field: { ...controlContribution.field, id } };
    });
    const controlModel = { ...model, constraints: controlConstraints };
    await assert.rejects(freezeGeneration({
        model: { ...controlModel, contributions: controls }, values: controlValues,
        handoff, project, workspace,
    }), /Generated controls exceed the 30-control limit/);
    await assert.rejects(readdir(join(workspace, "speckit-canvas-designer", "handoffs",
        handoff.handoffId, "generations")), { code: "ENOENT" });
    const atLimit = await freezeGeneration({
        model: { ...controlModel, contributions: controls.slice(0, 30) }, values: controlValues,
        handoff, project, workspace,
    });
    const atLimitRequest = JSON.parse(await readFile(join(workspace, "speckit-canvas-designer",
        "handoffs", handoff.handoffId, "generations", atLimit.requestId, "request.json")));
    assert.equal(atLimitRequest.generatedControls.length, 30);
    assert.ok(atLimitRequest.generatedControls.every((item) =>
        item.assets[0].name === templates[0].name));
    const saved = await saveDesignerSettings(workspace, handoff, model,
        { modelRevision: model.revision, revision: 0, values });
    const reopened = await loadDesignerSettings(workspace, handoff, await load());
    assert.deepEqual(saved.values["risk.rating"], reopened.values["risk.rating"]);
    for (const [assets, message] of [
        [templates.filter((item) => item.kind !== "designer.adapter"), /missing designer adapter/],
        [templates.filter((item) => item.kind !== "generated.adapter"), /missing generated adapter/],
        [templates.map((item) => item.kind === "control.definition"
            ? { ...item, kind: "designer.field" } : item), /Canvas Design contribution/],
        [templates.map((item) => item.kind === "generated.adapter"
            ? { ...item, kind: "designer.field" } : item), /must be a \.json/],
        [templates.map((item) => item.kind === "designer.adapter"
            ? { ...item, strategy: "append" } : item), /Invalid or duplicate/],
    ]) await assert.rejects(load(assets), message);
    await assert.rejects(load(templates, () => ({ kind: "script", stack: [] })),
        /replace-only Specify template/);
    const definition = templates[0];
    for (const requires of [
        null, undefined, [], [templates[2].name],
        [templates[2].name, definition.name], [definition.name, definition.name],
    ]) {
        const invalid = { ...contributionDocument };
        if (requires === undefined) delete invalid.requires;
        else invalid.requires = requires;
        await writeFile(templates[1].path, JSON.stringify(invalid));
        await assert.rejects(load(), /object field requires exactly one control definition template|missing or incompatible shared control definition/);
    }
    await writeFile(templates[1].path, contributionSource);
    const original = await readFile(definition.path, "utf8");
    await writeFile(definition.path, original.replace('"type": "object"', '"type": "string"'));
    await assert.rejects(load(), /invalid shared control value contract|incompatible shared control/);
    for (const invalidProperties of [
        Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`key${index}`, ["low"]])),
        { impact: ["low", "low"] },
        { impact: ["low", null] },
        { impact: [""] },
        { impact: ["x".repeat(81)] },
    ]) {
        const invalidDefinition = JSON.parse(original);
        invalidDefinition.value.properties = invalidProperties;
        await writeFile(definition.path, JSON.stringify(invalidDefinition));
        await assert.rejects(load(), /invalid shared control value contract/);
    }
    await writeFile(definition.path, original);
    await writeFile(designerAdapter.path, designerModule.replace(
        'export const controlId = "risk-matrix"', 'export const controlId = "other-control"'));
    assert.equal((await load()).adapters["risk-matrix"], designerAdapter.name);
    await writeFile(designerAdapter.path, designerModule);
    const generated = templates[3];
    const module = await readFile(generated.path, "utf8");
    await writeFile(generated.path, module.replace('"medium", "high"', '"medium", "critical"'));
    assert.equal((await load()).controls[0].id, "risk-matrix");
    await writeFile(generated.path, module);
    await writeFile(generated.path, "export const mount = null;");
    assert.equal((await load()).controls[0].id, "risk-matrix");
    await writeFile(generated.path, "export const mount = ;");
    await assert.rejects(load(), /invalid generated.adapter/);
    await writeFile(generated.path, module);
    const prepared = await freezeGeneration({ model, values, handoff, project, workspace });
    const { materialize } = await import(new URL(
        "../../../../../spec-kit-extensions/extension-canvas-design/scripts/generate.mjs", import.meta.url));
    const requestPath = join(workspace, "speckit-canvas-designer", "handoffs",
        handoff.handoffId, "generations", prepared.requestId, "request.json");
    const originalRequest = await readFile(requestPath, "utf8");
    for (const invalidProperties of [
        Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`key${index}`, ["low"]])),
        { impact: ["low", "low"] },
        { impact: ["low", null] },
        { impact: [""] },
        { impact: ["x".repeat(81)] },
    ]) {
        const request = JSON.parse(originalRequest);
        const asset = request.generatedControls[0].assets[0];
        const definition = JSON.parse(Buffer.from(asset.content, "base64").toString("utf8"));
        definition.value.properties = invalidProperties;
        const bytes = Buffer.from(JSON.stringify(definition));
        asset.content = bytes.toString("base64");
        asset.hash = createHash("sha256").update(bytes).digest("hex");
        const { integrity: _hash, ...unsigned } = request;
        request.integrity = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
        await writeFile(requestPath, JSON.stringify(request));
        await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
            /incompatible frozen control value or adapters/);
    }
    for (const change of [
        (request) => { request.values["designer.unbound"] = "not generated"; },
        (request) => { request.generatedControls[0].id = "canvas.description"; },
    ]) {
        const request = JSON.parse(originalRequest);
        change(request);
        const { integrity: _hash, ...unsigned } = request;
        request.integrity = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
        await writeFile(requestPath, JSON.stringify(request));
        await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
            /Invalid frozen generated values/);
    }
    const invalidRequest = JSON.parse(originalRequest);
    invalidRequest.generatedControls[0].value.likelihood = "impossible";
    const { integrity: _integrity, ...payload } = invalidRequest;
    invalidRequest.integrity = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    await writeFile(requestPath, JSON.stringify(invalidRequest));
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /incompatible frozen control value or adapters/);
    const oversizedRequest = JSON.parse(originalRequest);
    const oversized = Buffer.alloc(32 * 1024 + 1);
    oversizedRequest.generatedControls[0].assets[1].content = oversized.toString("base64");
    oversizedRequest.generatedControls[0].assets[1].hash =
        createHash("sha256").update(oversized).digest("hex");
    const { integrity: _oversizedIntegrity, ...oversizedPayload } = oversizedRequest;
    oversizedRequest.integrity = createHash("sha256").update(JSON.stringify(oversizedPayload)).digest("hex");
    await writeFile(requestPath, JSON.stringify(oversizedRequest));
    await assert.rejects(materialize(project, workspace, handoff.handoffId, prepared.requestId),
        /Invalid frozen generated control asset/);
    await writeFile(requestPath, originalRequest);
    await materialize(project, workspace, handoff.handoffId, prepared.requestId);
    const portable = join(workspace, "portable-risk");
    const { cp } = await import("node:fs/promises");
    await cp(join(project, prepared.target), portable, { recursive: true });
    const { readConfig, renderHtml, createWorkflowRoutes } = await import(
        pathToFileURL(join(portable, "server.mjs")).href);
    const config = readConfig();
    assert.deepEqual(config.generatedControls[0].value, values["risk.rating"]);
    assert.deepEqual(await readFile(join(portable, "control-contract.mjs")),
        await readFile(new URL("../../../../../spec-kit-extensions/extension-canvas-design/templates/generated-canvas/control-contract.mjs",
            import.meta.url)));
    const configPath = join(portable, "canvas-config.json");
    for (const invalidProperties of [
        Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`key${index}`, ["low"]])),
        { impact: ["low", "low"] },
        { impact: ["low", null] },
        { impact: [""] },
        { impact: ["x".repeat(81)] },
    ]) {
        const invalid = structuredClone(config);
        invalid.generatedControls[0].properties = invalidProperties;
        await writeFile(configPath, JSON.stringify(invalid));
        assert.throws(() => readConfig(), /Invalid generated canvas configuration/);
    }
    await writeFile(configPath, JSON.stringify(config));
    assert.match(renderHtml(config), /data-control-id="risk.rating"/);
    assert.equal((await import(pathToFileURL(join(portable, "controls",
        `${generated.name}.mjs`)).href)).mount.name, "mount");
    assert.equal(await readFile(join(portable, "controls", `${generated.name}.mjs`), "utf8"), module);
    assert.doesNotMatch(renderHtml({ ...config, generatedControls: undefined }), /data-control-id=/);
    const routes = createWorkflowRoutes(config, {
        runtime: null, instanceId: "test", token: "portable-token", port: () => server.address().port,
    });
    const server = createServer(routes.handle);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const html = await fetch(`${origin}/?token=portable-token`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /data-control-id="risk.rating"/);
    const packaged = await fetch(`${origin}/controls/${generated.name}.mjs?token=portable-token`);
    assert.equal(packaged.status, 200);
    assert.equal(await packaged.text(), module);
    assert.equal((await fetch(`${origin}/controls/${generated.name}.mjs`)).status, 401);
});

test("frozen generated asset read rejects a FIFO without blocking", {
    skip: process.platform === "win32",
}, async (t) => {
    const workspace = await fixture(t);
    const path = join(workspace, "renderer.mjs");
    const created = spawnSync("mkfifo", [path], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    await assert.rejects(readFrozenAsset({ name: "renderer", path, hash: "unused" }, workspace),
        /Invalid Designer file/);
});

test("unavailable page schema stops opening with repair guidance; invalid pages remain per-page errors", async (t) => {
    const workspace = await fixture(t);
    const { project, entries } = await projectFixture(t, workspace);
    const schema = join(project, ".specify", "extensions", "extension-canvas-design",
        "schemas", "page.schema.json");
    const original = await readFile(schema);
    for (const [contents, reason] of [
        [null, /ENOENT/], ["{broken", /Invalid Designer JSON/],
        ["{}", /Invalid shared Designer page schema/],
    ]) {
        if (contents === null) await rm(schema);
        else await writeFile(schema, contents);
        await assert.rejects(loadResolvedDesignerPages(validHandoff(), project, entries),
            (error) => error.message.includes(schema)
                && /Repair or reinstall extension-canvas-design/.test(error.message)
                && reason.test(error.message));
    }
    await writeFile(schema, original);
    await writeFile(entries[0].path, "{broken");
    const model = await loadResolvedDesignerPages(validHandoff(), project, entries);
    assert.match(model.pages[0].error.reason, /Invalid Designer JSON/);
    assert.equal(model.pages[1].title, "Artifacts");
});

test("canvas opens only after validating complete pages and rebuilds on reopening", async (t) => {
    const workspace = await fixture(t);
    const source = fileURLToPath(new URL("../", import.meta.url));
    const extension = join(workspace, "provider");
    const sdk = join(workspace, "node_modules", "@github", "copilot-sdk");
    await mkdir(sdk, { recursive: true });
    await mkdir(extension);
    for (const file of ["extension.mjs", "handoff.mjs", "server.mjs", "pages.mjs", "control-contract.mjs",
        "settings.mjs", "generation.mjs"]) {
        await copyFile(join(source, file), join(extension, file));
    }
    await copyFile(join(extension, "server.mjs"), join(extension, "shell.mjs"));
    await writeFile(join(extension, "server.mjs"), `
        import { startShell as actualStartShell } from "./shell.mjs";
        export async function startShell(...args) {
            const shell = await actualStartShell(...args);
            if (globalThis.__pauseDesignerShell) await globalThis.__pauseDesignerShell(shell);
            return shell;
        }
    `);
    const shared = join(workspace, "speckit-wizard-canvas", "env");
    await mkdir(shared, { recursive: true });
    await copyFile(join(source, "..", "speckit-wizard-canvas", "env", "workspace.mjs"),
        join(shared, "workspace.mjs"));
    for (const file of ["resolve-path.mjs", "specify-invocation.mjs"]) {
        await copyFile(join(source, "..", "speckit-wizard-canvas", "env", file),
            join(shared, file));
    }
    await mkdir(join(extension, "ui"));
    for (const file of ["index.html", "app.js", "styles.css"]) {
        await copyFile(join(source, "ui", file), join(extension, "ui", file));
    }
    const { project, entries } = await projectFixture(t, workspace);
    await writeFile(join(sdk, "package.json"), JSON.stringify({
        name: "@github/copilot-sdk", type: "module", exports: { "./extension": "./extension.mjs" },
    }));
    await writeFile(join(sdk, "extension.mjs"), `
        export const createCanvas = (canvas) => canvas;
        export class CanvasError extends Error {
            constructor(code, message) { super(message); this.code = code; }
        }
        export const joinSession = async ({ canvases, tools }) => {
            globalThis.__designerTestCanvas = canvases[0];
            globalThis.__designerTestTools = tools;
            return { workspacePath: ${JSON.stringify(workspace)},
                rpc: { metadata: { snapshot: async () => ({
                    workingDirectory: ${JSON.stringify(project)} }) },
                    skills: { reload: async () => ({ errors: [], warnings: [] }) } },
                log: async () => {} };
        };
    `);
    await import(pathToFileURL(join(extension, "extension.mjs")).href);
    const canvas = globalThis.__designerTestCanvas;
    delete globalThis.__designerTestCanvas;
    const tools = globalThis.__designerTestTools;
    delete globalThis.__designerTestTools;
    assert.deepEqual(tools.map((tool) => tool.name), ["speckit_designer_reload_skills"]);
    assert.deepEqual(canvas.actions ?? [], []);
    assert.deepEqual(canvas.inputSchema.required, undefined);
    assert.deepEqual(canvas.inputSchema.properties.handoffId.type, "string");
    assert.equal(canvas.inputSchema.properties.pages.minItems, 3);
    assert.equal(canvas.inputSchema.properties.pages.maxItems, 100);
    assert.equal(canvas.inputSchema.properties.templates.maxItems, 100);

    let releaseShell;
    try {
        await assert.rejects(readFile(join(extension, "node_modules", "es-module-lexer", "package.json")),
            { code: "ENOENT" });
        await assert.rejects(canvas.open({ instanceId: "same", input: {} }),
            /Designer requires es-module-lexer.*Wizard.*environment setup/);
        await cp(join(source, "node_modules", "es-module-lexer"),
            join(extension, "node_modules", "es-module-lexer"), { recursive: true });
        const empty = await canvas.open({ instanceId: "same", input: {} });
        assert.match(await (await fetch(empty.url)).text(), /No Wizard handoff is attached yet/);
        await assert.rejects(canvas.open({ instanceId: "same", input: { handoffId: ID } }),
            /complete resolved inventory/);
        await assert.rejects(canvas.open({ instanceId: "same", input: { handoffId: ID, pages: entries } }),
            /complete resolved inventory/);
        await assert.rejects(canvas.open({ instanceId: "same", input: {
            handoffId: ID, pages: entries, templates: [],
        } }), (error) => error.code === "designer_handoff_invalid");
        await saveHandoff(workspace);
        await assert.rejects(canvas.open({ instanceId: "same", input: {
            handoffId: ID, pages: entries.slice(1), templates: [],
        } }), /all three Canvas Design pages/);
        await assert.rejects(canvas.open({ instanceId: "same", input: {
            handoffId: ID, pages: [...entries, entries[0]], templates: [],
        } }), /duplicate Designer page name/);
        const schema = join(project, ".specify", "extensions", "extension-canvas-design",
            "schemas", "page.schema.json");
        const installedSchema = await readFile(schema);
        await rm(schema);
        await assert.rejects(canvas.open({ instanceId: "same", input: {
            handoffId: ID, pages: entries, templates: [],
        } }),
            (error) => error.code === "designer_open_failed"
                && error.message.includes(schema)
                && /Repair or reinstall extension-canvas-design/.test(error.message));
        await assert.rejects(fetch(empty.url));
        await writeFile(schema, installedSchema);
        const missing = await canvas.open({ instanceId: "same", input: {
            handoffId: ID, pages: [{ ...entries[0], path: join(project, ".specify", "missing.json") },
                ...entries.slice(1)], templates: [],
        } });
        const missingStateUrl = new URL(missing.url);
        missingStateUrl.pathname = "/api/state";
        assert.match((await (await fetch(missingStateUrl)).json()).pages[0].error.reason, /missing/);
        const filled = await canvas.open({ instanceId: "same", input: {
            handoffId: ID, pages: entries, templates: [],
        } });
        assert.notEqual(filled.url, empty.url);
        assert.match(await (await fetch(filled.url)).text(), /Spec Kit Canvas Designer/);
        const stateUrl = new URL(filled.url);
        stateUrl.pathname = "/api/state";
        const initial = await (await fetch(stateUrl)).json();
        assert.equal(initial.pages.length, 3);
        assert.equal((await fetch(new URL("/api/reload", filled.url), { method: "POST" })).status, 404);
        const templatePath = join(project, ".specify", "billing.json");
        await writeFile(templatePath, JSON.stringify({
            schemaVersion: 1, id: "billing-code", host: "designer",
            slot: "essentials.options", order: 30,
            field: { id: "billing.costCode", label: "Cost code",
                type: "string", control: "stock.text" },
        }));
        const withTemplate = await canvas.open({ instanceId: "same", input: {
            handoffId: ID, pages: entries,
            templates: [{ name: "canvas-contribution-billing", path: templatePath,
                sourceId: "billing", kind: "designer.field", strategy: "replace" }],
        } });
        const templateStateUrl = new URL(withTemplate.url);
        templateStateUrl.pathname = "/api/state";
        const templateState = await (await fetch(templateStateUrl)).json();
        assert.deepEqual(templateState.contributions.map((item) => item.id), ["billing-code"]);
        assert.deepEqual(Object.fromEntries(Object.entries(templateState.values)
            .filter(([id]) => id !== "billing.costCode")), initial.values);
        assert.equal(templateState.values["billing.costCode"], "");
        assert.ok(templateState.pages[0].fields.some((field) => field.id === "billing.costCode"));
        assert.equal(templateState.pages.length, initial.pages.length);
        assert.notEqual(templateState.revision, initial.revision);
        const preset = fileURLToPath(new URL(
            "../../../../../spec-kit-presets/copilot-canvas-design-test/", import.meta.url));
        const testPage = join(project, ".specify", "pr1-test-page.json");
        const testField = join(project, ".specify", "pr1-test-field.json");
        const testToggle = join(project, ".specify", "pr1-test-toggle.json");
        await copyFile(join(preset, "pages", "pr1-test.json"), testPage);
        await copyFile(join(preset, "contributions", "pr1-test.json"), testField);
        await copyFile(join(preset, "contributions", "pr1-toggle.json"), testToggle);
        const withPreset = await canvas.open({ instanceId: "same", input: {
            handoffId: ID,
            pages: [...entries, { name: "canvas-settings-pr1-test", path: testPage,
                kind: "designer.page", strategy: "replace" }],
            templates: [{ name: "canvas-contribution-pr1-test", path: testField,
                sourceId: "copilot-canvas-design-test", kind: "designer.field", strategy: "replace" },
            { name: "canvas-contribution-pr1-toggle", path: testToggle,
                sourceId: "copilot-canvas-design-test", kind: "designer.field", strategy: "replace" }],
        } });
        const presetStateUrl = new URL(withPreset.url);
        presetStateUrl.pathname = "/api/state";
        const presetState = await (await fetch(presetStateUrl)).json();
        assert.equal(presetState.pages.at(-1).title, "Test settings");
        assert.deepEqual(presetState.pages.at(-1).fields.map((field) => field.id),
            ["pr1Test.label", "pr1Test.enabled"]);
        assert.deepEqual(presetState.constraints["pr1Test.enabled"], { type: "boolean" });
        assert.equal(presetState.values["pr1Test.enabled"], true);
        assert.equal(presetState.contributions[0].sourceId, "copilot-canvas-design-test");
        const changed = JSON.parse(await readFile(entries[0].path, "utf8"));
        changed.title = "Updated Essentials";
        await writeFile(entries[0].path, JSON.stringify(changed));
        const reopened = await canvas.open({ instanceId: "same", input: {
            handoffId: ID, pages: entries, templates: [],
        } });
        assert.notEqual(reopened.url, filled.url);
        await assert.rejects(fetch(stateUrl));
        const latest = new URL(reopened.url);
        latest.pathname = "/api/state";
        const updated = await (await fetch(latest)).json();
        assert.equal(updated.pages[0].title, "Updated Essentials");
        assert.notEqual(updated.revision, initial.revision);
        await writeFile(entries[1].path, "{broken");
        const broken = await canvas.open({ instanceId: "same", input: {
            handoffId: ID, pages: entries, templates: [],
        } });
        await assert.rejects(fetch(latest));
        const brokenStateUrl = new URL(broken.url);
        brokenStateUrl.pathname = "/api/state";
        const brokenState = await (await fetch(brokenStateUrl)).json();
        assert.equal(brokenState.pages.length, 3);
        assert.match(brokenState.pages[1].error.reason, /Invalid Designer JSON/);
        assert.notEqual(brokenState.revision, updated.revision);
        const saveUrl = new URL(broken.url);
        saveUrl.pathname = "/api/save";
        const savedValues = { ...brokenState.values, "canvas.id": "saved-designer",
            "canvas.displayName": "Saved Designer" };
        const savedResponse = await fetch(saveUrl, { method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ modelRevision: brokenState.revision,
                revision: brokenState.settingsRevision, values: savedValues }) });
        assert.equal(savedResponse.status, 200);
        const restored = await canvas.open({ instanceId: "same", input: {
            handoffId: ID, pages: entries, templates: [],
        } });
        const restoredUrl = new URL(restored.url);
        restoredUrl.pathname = "/api/state";
        const restoredState = await (await fetch(restoredUrl)).json();
        assert.deepEqual(restoredState.values, savedValues);
        assert.equal(restoredState.settingsRevision, 1);
        assert.equal(restoredState.persisted, true);

        const started = new Promise((resolve) => {
            globalThis.__pauseDesignerShell = async (shell) => {
                resolve(shell);
                await new Promise((release) => { releaseShell = release; });
            };
        });
        const pending = canvas.open({ instanceId: "closed-during-open", input: {} });
        const shell = await started;
        await canvas.onClose({ instanceId: "closed-during-open" });
        delete globalThis.__pauseDesignerShell;
        const reopenedAfterClose = await canvas.open({ instanceId: "closed-during-open", input: {} });
        releaseShell();
        releaseShell = null;
        await assert.rejects(pending, /panel closed while opening/);
        await assert.rejects(fetch(shell.url));
        assert.equal((await fetch(reopenedAfterClose.url)).status, 200);
    } finally {
        releaseShell?.();
        delete globalThis.__pauseDesignerShell;
        await canvas.onClose({ instanceId: "closed-during-open" });
        await canvas.onClose({ instanceId: "same" });
    }
});
