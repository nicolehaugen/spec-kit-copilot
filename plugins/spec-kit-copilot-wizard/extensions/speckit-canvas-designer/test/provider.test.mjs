import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, copyFile, mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    fingerprint, handoffDirectory, HANDOFF_LIMIT, readHandoff, validateHandoff,
    validateHandoffId,
} from "../handoff.mjs";
import { shellHtml, startShell } from "../server.mjs";
import { assertPageCommand, loadResolvedDesignerPages } from "../pages.mjs";
import {
    loadDesignerSettings, SAVE_REQUEST_LIMIT, saveDesignerSettings, SETTINGS_LIMIT,
} from "../settings.mjs";

const ID = "designer_1";

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
    const pages = ["setup", "artifacts", "appearance", "results"];
    const entries = [];
    for (const name of pages) {
        const path = join(installed, "pages", `${name}.json`);
        await copyFile(join(source, "pages", `${name}.json`), path);
        entries.push({ name: `canvas-settings-${name}`, path });
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

test("handoff reads only validated artifacts from its session workspace", async (t) => {
    const workspace = await fixture(t);
    const handoff = validHandoff();
    const directory = await saveHandoff(workspace, handoff);
    assert.deepEqual(await readHandoff(workspace, ID), handoff);
    await assert.rejects(readHandoff(workspace, "../escape"), /Invalid Designer handoff ID/);
    await assert.rejects(readHandoff("", ID), /Designer session workspace is unavailable/);
    await assert.rejects(readHandoff(workspace, "other"), { code: "ENOENT" });

    const path = join(directory, "handoff.json");
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
    const handoff = validHandoff();
    const model = { pages: [{ id: "canvas-settings-setup", page: "canvas-settings-setup",
        title: "Essentials", fields: [] }], constraints: {}, values: {}, revision: "test" };
    await assert.rejects(startShell(handoff), /validated before opening/);
    const shell = await startShell(handoff, model);
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
    const shell = await startShell(handoff, model, workspace);
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
    const shell = await startShell(handoff, model, workspace);
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
    const effective = [{ name: entries[0].name, path: override }, ...entries.slice(1)];
    const model = await loadResolvedDesignerPages(handoff, project, effective);
    assert.equal(model.pages[0].fields[1].label, "Custom title");
    assert.equal(model.pages[0].provenance.path, override);
    assert.equal((await loadResolvedDesignerPages(handoff, project, effective)).revision, model.revision);
    await assert.rejects(loadResolvedDesignerPages(handoff, project, entries.slice(1)),
        /all four Canvas Design pages/);
    await assert.rejects(loadResolvedDesignerPages(handoff, project, [...entries, entries[0]]),
        /duplicate Designer page name/);
    const missing = await loadResolvedDesignerPages(handoff, project,
        [{ name: entries[0].name, path: join(project, ".specify", "missing.json") }, ...entries.slice(1)]);
    assert.equal(missing.pages[0].error.name, "canvas-settings-setup");
    assert.match(missing.pages[0].error.reason, /missing/);
    assert.equal(Object.hasOwn(missing.constraints, "canvas.id"), false);
    const missingParentPath = join(project, ".specify", "not-created", "nested", "setup.json");
    const missingParent = await loadResolvedDesignerPages(handoff, project,
        [{ name: entries[0].name, path: missingParentPath }, ...entries.slice(1)]);
    assert.equal(missingParent.pages[0].error.path, missingParentPath);
    assert.match(missingParent.pages[0].error.reason, /missing/);
    assert.equal(missingParent.pages[1].title, "Artifacts");
    await writeFile(join(workspace, "outside.json"), JSON.stringify(changed));
    await assert.rejects(loadResolvedDesignerPages(handoff, project,
        [{ name: entries[0].name, path: join(workspace, "outside.json") }, ...entries.slice(1)]),
    /inside \.specify/);
    const extra = join(project, ".specify", "presets", "extra.json");
    await writeFile(extra, JSON.stringify({ schemaVersion: 1, id: "extra-settings",
        title: "Extra", order: 5, enabled: true, fields: [] }));
    const withExtra = await loadResolvedDesignerPages(handoff, project,
        [...effective, { name: "extra-settings", path: extra }]);
    assert.equal(withExtra.pages[0].title, "Extra");
    assert.equal(withExtra.pages.length, 5);
    await writeFile(extra, JSON.stringify({ schemaVersion: 1, id: "extra-settings",
        title: "Extra", order: 5, enabled: false, fields: [] }));
    assert.equal((await loadResolvedDesignerPages(handoff, project,
        [...effective, { name: "extra-settings", path: extra }])).pages.length, 4);
    await writeFile(extra, JSON.stringify({ schemaVersion: 1, id: "extra-settings",
        title: "Extra", order: "invalid", fields: [] }));
    const invalidOrder = await loadResolvedDesignerPages(handoff, project,
        [...effective, { name: "extra-settings", path: extra }]);
    assert.match(invalidOrder.pages.at(-1).error.reason, /expected integer/);
    await writeFile(extra, " ".repeat(256 * 1024 + 1));
    const oversized = await loadResolvedDesignerPages(handoff, project,
        [...effective, { name: "extra-settings", path: extra }]);
    assert.match(oversized.pages.at(-1).error.reason, /exceeds its size limit/);
    changed.id = "wrong-page";
    await writeFile(override, JSON.stringify(changed));
    const wrongId = await loadResolvedDesignerPages(handoff, project, effective);
    assert.match(wrongId.pages[0].error.reason, /page id does not match/);
    assert.equal(wrongId.pages[0].fields, undefined);
    await assert.rejects(readFile(join(handoffDirectory(workspace, handoff.handoffId), "pages.json")),
        { code: "ENOENT" });
});

test("page errors retain healthy fields and never accept unsafe or incomplete input", async (t) => {
    const workspace = await fixture(t);
    const { project, entries } = await projectFixture(t, workspace);
    const handoff = validHandoff();
    const extra = join(project, ".specify", "extra.json");
    await writeFile(extra, JSON.stringify({ schemaVersion: 1, id: "extra-settings",
        title: "Extra", order: 5, fields: [{ id: "canvas.id", label: "Collision" }] }));
    const conflict = await loadResolvedDesignerPages(handoff, project,
        [...entries, { name: "extra-settings", path: extra }]);
    assert.match(conflict.pages.find((page) => page.page === "extra-settings").error.reason,
        /duplicate enabled field canvas.id/);
    assert.equal(conflict.constraints["canvas.id"].minLength, 1);
    assert.equal(conflict.pages[0].page, "canvas-settings-setup");

    await writeFile(entries[0].path, "{invalid");
    const broken = await loadResolvedDesignerPages(handoff, project, entries);
    assert.equal(broken.pages[0].page, "canvas-settings-setup");
    assert.match(broken.pages[0].error.reason, /Invalid Designer JSON/);
    assert.equal(broken.pages[0].error.path, entries[0].path);
    assert.equal(Object.hasOwn(broken.values, "canvas.id"), false);
    assert.equal(broken.pages[1].title, "Artifacts");
    const allMissing = await loadResolvedDesignerPages(handoff, project, entries.map((entry, i) =>
        ({ name: entry.name, path: join(project, ".specify", `missing-${i}.json`) })));
    assert.equal(allMissing.pages.length, 4);
    assert.ok(allMissing.pages.every((page) => page.error && !page.fields));
    assert.deepEqual(Object.keys(allMissing.values), []);
    await assert.rejects(loadResolvedDesignerPages(handoff, project,
        [...entries.slice(0, 3), { name: entries[3].name, path: join(workspace, "outside.json") }]),
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
            [{ name: entries[0].name, path: alias }, ...entries.slice(1)]),
        /escapes its allowed directory/);
    }
    const outsideAlias = join(project, ".specify", "outside-alias");
    try {
        await symlink(workspace, outsideAlias, process.platform === "win32" ? "junction" : "dir");
        await assert.rejects(loadResolvedDesignerPages(handoff, project,
            [{ name: entries[0].name, path: join(outsideAlias, "missing-dir", "setup.json") },
                ...entries.slice(1)]), /escapes its allowed directory/);
    } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
        t.diagnostic("Windows symlink creation is not permitted; parent alias assertion skipped");
    }
    await assert.rejects(loadResolvedDesignerPages(handoff, project,
        [entries[0], entries[0], ...entries.slice(2)]), /duplicate Designer page name/);
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
    const sdk = join(extension, "node_modules", "@github", "copilot-sdk");
    await mkdir(sdk, { recursive: true });
    for (const file of ["extension.mjs", "handoff.mjs", "server.mjs", "pages.mjs", "settings.mjs"]) {
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
    assert.equal(canvas.inputSchema.properties.pages.maxItems, 100);

    let releaseShell;
    try {
        const empty = await canvas.open({ instanceId: "same", input: {} });
        assert.match(await (await fetch(empty.url)).text(), /No Wizard handoff is attached yet/);
        await assert.rejects(canvas.open({ instanceId: "same", input: { handoffId: ID } }),
            /complete page list/);
        await assert.rejects(canvas.open({ instanceId: "same", input: { handoffId: ID, pages: entries } }),
            (error) => error.code === "designer_handoff_invalid");
        await saveHandoff(workspace);
        await assert.rejects(canvas.open({ instanceId: "same", input: {
            handoffId: ID, pages: entries.slice(1),
        } }), /all four Canvas Design pages/);
        await assert.rejects(canvas.open({ instanceId: "same", input: {
            handoffId: ID, pages: [...entries, entries[0]],
        } }), /duplicate Designer page name/);
        const schema = join(project, ".specify", "extensions", "extension-canvas-design",
            "schemas", "page.schema.json");
        const installedSchema = await readFile(schema);
        await rm(schema);
        await assert.rejects(canvas.open({ instanceId: "same", input: { handoffId: ID, pages: entries } }),
            (error) => error.code === "designer_open_failed"
                && error.message.includes(schema)
                && /Repair or reinstall extension-canvas-design/.test(error.message));
        await assert.rejects(fetch(empty.url));
        await writeFile(schema, installedSchema);
        const missing = await canvas.open({ instanceId: "same", input: {
            handoffId: ID, pages: [{ name: entries[0].name, path: join(project, ".specify", "missing.json") },
                ...entries.slice(1)],
        } });
        const missingStateUrl = new URL(missing.url);
        missingStateUrl.pathname = "/api/state";
        assert.match((await (await fetch(missingStateUrl)).json()).pages[0].error.reason, /missing/);
        const filled = await canvas.open({ instanceId: "same", input: { handoffId: ID, pages: entries } });
        assert.notEqual(filled.url, empty.url);
        assert.match(await (await fetch(filled.url)).text(), /Spec Kit Canvas Designer/);
        const stateUrl = new URL(filled.url);
        stateUrl.pathname = "/api/state";
        const initial = await (await fetch(stateUrl)).json();
        assert.equal(initial.pages.length, 4);
        assert.equal((await fetch(new URL("/api/reload", filled.url), { method: "POST" })).status, 404);
        const changed = JSON.parse(await readFile(entries[0].path, "utf8"));
        changed.title = "Updated Essentials";
        await writeFile(entries[0].path, JSON.stringify(changed));
        const reopened = await canvas.open({ instanceId: "same", input: { handoffId: ID, pages: entries } });
        assert.notEqual(reopened.url, filled.url);
        await assert.rejects(fetch(stateUrl));
        const latest = new URL(reopened.url);
        latest.pathname = "/api/state";
        const updated = await (await fetch(latest)).json();
        assert.equal(updated.pages[0].title, "Updated Essentials");
        assert.notEqual(updated.revision, initial.revision);
        await writeFile(entries[1].path, "{broken");
        const broken = await canvas.open({ instanceId: "same", input: { handoffId: ID, pages: entries } });
        await assert.rejects(fetch(latest));
        const brokenStateUrl = new URL(broken.url);
        brokenStateUrl.pathname = "/api/state";
        const brokenState = await (await fetch(brokenStateUrl)).json();
        assert.equal(brokenState.pages.length, 4);
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
        const restored = await canvas.open({ instanceId: "same", input: { handoffId: ID, pages: entries } });
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
