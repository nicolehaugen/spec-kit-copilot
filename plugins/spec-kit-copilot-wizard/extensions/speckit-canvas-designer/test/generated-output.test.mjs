import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkGenerationProtocol, generatedOutput, readGeneratedJson,
    validateOutputAction } from "../contracts/generated-output.mjs";
import { validateOutputStatusResponse, validateRevealResponse, validateOpenResponse,
    validateGenerateResponse, validateOutputError } from "../ui/generated-output-state.js";

const id = "team-dashboard";
const paths = { target: "generated-canvases/team-dashboard/",
    publicationTarget: ".github/extensions/team-dashboard/" };
const status = (state) => ({ ...paths, status: state, publication: { status: "absent" },
    ...(["ready", "modified"].includes(state) ? { requestId: "request-1" } : {}) });

test("output contracts distinguish generated source from publication and dispatch from completion", () => {
    for (const state of ["absent", "foreign", "incomplete", "ready", "modified"]) {
        assert.deepEqual(validateOutputStatusResponse(status(state), id), status(state));
    }
    assert.deepEqual(validateRevealResponse({ target: paths.target }, id), { target: paths.target });
    assert.deepEqual(validateRevealResponse({ target: "generated-canvases/" }, id), { target: "generated-canvases/" });
    assert.deepEqual(validateOpenResponse({ ...paths, status: "opening" }, id), { ...paths, status: "opening" });
    assert.deepEqual(validateGenerateResponse({ ...paths, requestId: "request-1" }, id),
        { ...paths, requestId: "request-1" });
    assert.deepEqual(validateGenerateResponse({ ...paths, requestId: "request-1", warnings: ["drift"] }, id),
        { ...paths, requestId: "request-1", warnings: ["drift"] });
    assert.deepEqual(validateOutputError({ error: "Cannot open" }), { error: "Cannot open" });
});

test("output contracts reject old, mismatched, unbound and success-shaped exchanges", () => {
    for (const response of [
        { status: "ready", target: paths.publicationTarget, requestId: "request-1" },
        { ...status("ready"), requestId: "../escape" },
        { ...status("ready"), publicationTarget: ".github/extensions/other/" },
        { ...status("ready"), extra: true },
        { ...status("absent"), requestId: "request-1" },
        { ...status("ready"), publication: { status: "opened" } },
        { ...status("ready"), publication: { status: "ready", requestId: "request-1", digest: "bad" } },
    ]) assert.throws(() => validateOutputStatusResponse(response, id), /Invalid/);
    for (const response of [{ ...paths, status: "opened" }, { status: "opening", target: paths.target }]) {
        assert.throws(() => validateOpenResponse(response, id), /Invalid/);
    }
    for (const response of [{ ...paths, requestId: "../escape" },
        { ...paths, requestId: "request-1", warnings: [null] }]) {
        assert.throws(() => validateGenerateResponse(response, id), /Invalid/);
    }
    assert.throws(() => validateRevealResponse({ target: paths.publicationTarget }, id), /Invalid/);
    for (const response of [{}, { error: "" }, { error: "failure", status: 500 }]) {
        assert.throws(() => validateOutputError(response), /Invalid/);
    }
});

test("Open separately binds its request and runtime replacement snapshot", () => {
    const input = { canvasId: id, requestId: "new-request", replaceExisting: true,
        replaceRequestId: "prior-request", expectedTargetDigest: "a".repeat(64) };
    assert.deepEqual(validateOutputAction({ canvasId: id }), { canvasId: id });
    assert.deepEqual(validateOutputAction(input, { open: true }), input);
    for (const wrong of [
        { canvasId: id }, { ...input, expectedTargetDigest: undefined },
        { ...input, requestId: "../escape" }, { ...input, replaceExisting: false },
        { ...input, extra: true }, { ...input, canvasId: "con" },
    ]) assert.throws(() => validateOutputAction(wrong, { open: true }), /Invalid/);
    assert.throws(() => validateOutputAction(input), /Invalid/);
});

test("installed protocol preflight and output exchange fail explicitly on incompatible packages", async () => {
    await checkGenerationProtocol(process.cwd(), async () => ({
        stdout: '{"schemaVersion":2,"publication":"open"}' }));
    await assert.rejects(checkGenerationProtocol(process.cwd(), async () => ({
        stdout: '{"schemaVersion":1}' })), /does not support deferred publication/);
    await assert.rejects(generatedOutput(process.cwd(), id, "handoff-1", process.cwd(),
        async () => ({ stdout: JSON.stringify({ status: "ready", target: paths.publicationTarget }) })),
    /Invalid generated output status/);
    await assert.rejects(generatedOutput(process.cwd(), id, "handoff-1", process.cwd(),
        async () => { throw new Error("Permission denied"); }), /Permission denied/);
});

test("bounded metadata reader rejects entry and parent replacement and oversized data", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "designer-metadata-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = join(root, "source");
    await mkdir(target);
    const path = join(target, "canvas-config.json");
    await writeFile(path, '{"canvas":{"id":"team-dashboard"}}');
    await assert.rejects(readGeneratedJson(target, "canvas-config.json", async (file, flags) => {
        const descriptor = await open(file, flags);
        await rename(path, `${path}.prior`);
        await writeFile(path, "{}");
        return descriptor;
    }), /metadata changed during read/);
    await writeFile(path, "x".repeat(1024 * 1024 + 1));
    assert.equal(await readGeneratedJson(target, "canvas-config.json"), null);
});
