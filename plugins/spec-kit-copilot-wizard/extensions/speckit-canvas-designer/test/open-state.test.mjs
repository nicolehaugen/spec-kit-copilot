import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadLastOpen, saveLastOpen } from "../open-state.mjs";

async function fixture(t) {
    const workspace = await mkdtemp(join(tmpdir(), "designer-open-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    return workspace;
}

const record = { handoffId: "handoff-1", pages: [], templates: [] };
const inventory = (workspace) => join(workspace, "speckit-canvas-designer", "last-open.json");

test("saved open inventory round-trips and rejects a file exceeding 1 MiB", async (t) => {
    const workspace = await fixture(t);
    assert.equal(await loadLastOpen(workspace), null);
    await saveLastOpen(workspace, record);
    assert.deepEqual(await loadLastOpen(workspace), record);
    await writeFile(inventory(workspace), " ".repeat(1024 * 1024 + 1));
    await assert.rejects(loadLastOpen(workspace), /Invalid saved Designer open inventory file/);
    await assert.rejects(saveLastOpen(workspace, {
        ...record, pages: Array.from({ length: 100 }, (_, index) => ({
            name: `page-${index}`, path: "界".repeat(4096),
            kind: "designer.tab-definition", strategy: "replace",
        })),
    }), /Designer open inventory exceeds the size limit/);
});

test("saved open inventory rejects a symlinked file", async (t) => {
    const workspace = await fixture(t);
    await saveLastOpen(workspace, record);
    const path = inventory(workspace);
    const outside = join(workspace, "outside.json");
    await writeFile(outside, await readFile(path));
    await rm(path);
    try {
        await symlink(outside, path, "file");
    } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
        t.diagnostic("Windows symlink creation is not permitted; file assertion skipped");
        return;
    }
    await assert.rejects(loadLastOpen(workspace));
});

test("saved open inventory rejects a different opened file even when its path is valid", async (t) => {
    const workspace = await fixture(t);
    const outside = await fixture(t);
    await saveLastOpen(workspace, record);
    await saveLastOpen(outside, record);
    await assert.rejects(
        loadLastOpen(workspace, (_path, flags) => open(inventory(outside), flags)),
        /Invalid saved Designer open inventory file/,
    );
});

test("saved open inventory rejects a parent replaced during open, including a missing file", async (t) => {
    const workspace = await fixture(t);
    const outside = await fixture(t);
    await saveLastOpen(workspace, record);
    await saveLastOpen(outside, record);
    const path = inventory(workspace);
    const folder = dirname(path);
    const backup = `${folder}-original`;
    for (const missing of [false, true]) {
        if (missing) await rm(inventory(outside));
        let replaced = false;
        try {
            await assert.rejects(loadLastOpen(workspace, async (file, flags) => {
                await rename(folder, backup);
                try {
                    await symlink(dirname(inventory(outside)), folder,
                        process.platform === "win32" ? "junction" : "dir");
                } catch (error) {
                    await rename(backup, folder);
                    throw error;
                }
                replaced = true;
                return open(file, flags);
            }), missing ? /Designer open inventory escapes session artifacts/
                : /Designer open inventory escapes session artifacts|Invalid saved Designer open inventory file/);
        } catch (error) {
            if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
            t.diagnostic("Windows symlink creation is not permitted; directory assertion skipped");
            return;
        } finally {
            if (replaced) {
                await rm(folder, { recursive: true });
                await rename(backup, folder);
            }
        }
    }
});
