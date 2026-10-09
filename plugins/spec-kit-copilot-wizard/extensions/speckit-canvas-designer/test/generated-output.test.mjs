import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generatedOutput, readGeneratedJson, validateOutputAction } from "../contracts/generated-output.mjs";
import { validateOutputStatusResponse, validateRevealResponse, validateOpenResponse, validateGenerateResponse,
    validateOutputError } from "../ui/generated-output-state.js";

test("generated output response contract accepts matching status, folder and Open exchanges", () => {
    const id = "team-dashboard";
    const target = ".github/extensions/team-dashboard/";
    for (const status of ["absent", "foreign", "incomplete"]) {
        assert.deepEqual(validateOutputStatusResponse({ status, target }, id), { status, target });
    }
    assert.deepEqual(validateOutputStatusResponse({ status: "ready", target, requestId: "request-1" }, id),
        { status: "ready", target, requestId: "request-1" });
    assert.deepEqual(validateRevealResponse({ target: ".github/extensions/" }, id),
        { target: ".github/extensions/" });
    assert.deepEqual(validateRevealResponse({ target }, id), { target });
    assert.deepEqual(validateOpenResponse({ status: "opening", target }, id),
        { status: "opening", target });
    assert.deepEqual(validateGenerateResponse({ target, requestId: "request-1" }, id),
        { target, requestId: "request-1" });
    assert.deepEqual(validateGenerateResponse({ target, requestId: "request_2", warnings: ["Version drift"] }, id),
        { target, requestId: "request_2", warnings: ["Version drift"] });
    assert.deepEqual(validateOutputError({ error: "Cannot open canvas" }),
        { error: "Cannot open canvas" });
});

test("generated output response contract rejects incompatible host responses", () => {
    const id = "team-dashboard";
    const target = ".github/extensions/team-dashboard/";
    for (const response of [
        { status: "queued", target },
        { status: "ready", target },
        { status: "ready", target, requestId: "../escape" },
        { status: "ready", target, requestId: "request-1", extra: true },
        { status: "absent", target, requestId: "request-1" },
        { status: "ready", target: ".github/extensions/other/", requestId: "request-1" },
    ]) {
        assert.throws(() => validateOutputStatusResponse(response, id),
            /Invalid generated output status/);
    }
    for (const response of [{ target: ".github/extensions/other/" }, { target, extra: true }]) {
        assert.throws(() => validateRevealResponse(response, id),
            /Invalid generated canvas folder response/);
    }
    for (const response of [{ status: "ready", target }, { status: "opening" },
        { status: "opening", target: ".github/extensions/other/" }]) {
        assert.throws(() => validateOpenResponse(response, id),
            /Invalid generated canvas opening response/);
    }
    for (const response of [{ target }, { target, requestId: "../escape" },
        { target: ".github/extensions/other/", requestId: "request-1" },
        { target, requestId: "request-1", warnings: "Wrong type" },
        { target, requestId: "request-1", warnings: [null] },
        { target, requestId: "request-1", extra: true }]) {
        assert.throws(() => validateGenerateResponse(response, id),
            /Invalid generated canvas submission response/);
    }
    for (const response of [{}, { error: "" }, { error: "failure", status: 500 }]) {
        assert.throws(() => validateOutputError(response),
            /Invalid generated canvas error response/);
    }
});

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

test("generated metadata reads reject replaced entries and oversized files", async (t) => {
    const project = await mkdtemp(join(tmpdir(), "designer-output-race-"));
    t.after(() => rm(project, { recursive: true, force: true }));
    const target = join(project, ".github", "extensions", "team-dashboard");
    await mkdir(target, { recursive: true });
    const path = join(target, "canvas-config.json");
    await writeFile(path, JSON.stringify({ canvas: { id: "team-dashboard" } }));
    await assert.rejects(readGeneratedJson(target, "canvas-config.json", async (file, flags) => {
        const descriptor = await open(file, flags);
        await rename(path, `${path}.prior`);
        await writeFile(path, JSON.stringify({ canvas: { id: "team-dashboard" } }));
        return descriptor;
    }), /metadata changed during read/);
    await writeFile(path, "x".repeat(1024 * 1024 + 1));
    assert.equal(await readGeneratedJson(target, "canvas-config.json"), null);
    assert.equal((await generatedOutput(project, "team-dashboard", "handoff-1")).status, "foreign");
});
