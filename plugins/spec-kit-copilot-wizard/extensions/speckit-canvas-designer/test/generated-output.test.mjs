import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generatedOutput, validateOutputAction } from "../contracts/generated-output.mjs";

test("generated output contract validates IDs and action shapes", () => {
    assert.deepEqual(validateOutputAction({ canvasId: "team-dashboard" }), { canvasId: "team-dashboard" });
    assert.deepEqual(validateOutputAction({ canvasId: "team-dashboard", replaceExisting: true },
        { replace: true }), { canvasId: "team-dashboard", replaceExisting: true });
    for (const input of [{ canvasId: "../escape" }, { canvasId: "con" },
        { canvasId: "team-dashboard", extra: true },
        { canvasId: "team-dashboard", replaceExisting: false }]) {
        assert.throws(() => validateOutputAction(input, { replace: true }), /Invalid generated/);
    }
});

test("generated output distinguishes absent, foreign, incomplete and ready targets", async (t) => {
    const project = await mkdtemp(join(tmpdir(), "designer-output-"));
    t.after(() => rm(project, { recursive: true, force: true }));
    const parent = join(project, ".github", "extensions");
    const target = join(parent, "team-dashboard");
    assert.equal((await generatedOutput(project, "team-dashboard", "handoff-1")).status, "absent");
    await mkdir(target, { recursive: true });
    assert.equal((await generatedOutput(project, "team-dashboard", "handoff-1")).status, "foreign");
    await writeFile(join(target, "canvas-config.json"), JSON.stringify({ canvas: { id: "team-dashboard" } }));
    await writeFile(join(target, "settings-provenance.json"),
        JSON.stringify({ handoffId: "handoff-1", requestId: "request-1" }));
    assert.equal((await generatedOutput(project, "team-dashboard", "handoff-1")).status, "incomplete");
    await writeFile(join(target, "extension.mjs"), "export {};");
    assert.deepEqual(await generatedOutput(project, "team-dashboard", "handoff-1"), {
        status: "ready", target: ".github/extensions/team-dashboard/", requestId: "request-1",
    });
    assert.equal((await generatedOutput(project, "team-dashboard", "other")).status, "foreign");
    await rm(target, { recursive: true });
    try {
        await symlink(project, target, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
        t.diagnostic("Windows symlink creation is not permitted; link assertion skipped");
        return;
    }
    assert.equal((await generatedOutput(project, "team-dashboard", "handoff-1")).status, "foreign");
});
