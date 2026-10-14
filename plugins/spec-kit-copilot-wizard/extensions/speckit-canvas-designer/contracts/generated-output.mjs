import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { validateCanvasId } from "../ui/generated-output-state.js";
import { validateOutputStatusResponse } from "../ui/generated-output-state.js";
import { validateGenerationProtocol } from "./generation-request.mjs";

export { validateCanvasId };

export function validateOutputAction(input, { open: opening = false } = {}) {
    const keys = ["canvasId", ...(opening ? ["requestId"] : []),
        ...(opening && input?.replaceExisting === true
            ? ["replaceExisting", "replaceRequestId", "expectedTargetDigest"] : [])];
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).sort().join() !== keys.sort().join()) {
        throw new Error("Invalid generated canvas action");
    }
    validateCanvasId(input.canvasId);
    if (opening && (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.requestId ?? "")
        || input.replaceExisting === true
            && (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.replaceRequestId ?? "")
                || !/^[a-f0-9]{64}$/.test(input.expectedTargetDigest ?? "")))) {
        throw new Error("Invalid generated canvas Open authorization");
    }
    return input;
}

const METADATA_LIMIT = 1024 * 1024;

export async function readGeneratedJson(parent, name, openFile = open, expectedParent = null) {
    const path = join(parent, name);
    const before = await lstat(parent);
    if (!before.isDirectory() || (expectedParent
        && (before.dev !== expectedParent.dev || before.ino !== expectedParent.ino))) {
        throw new Error("Generated canvas metadata parent changed during read");
    }
    let file;
    try {
        file = await openFile(path, constants.O_RDONLY
            | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    }
    catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
    try {
        const [opened, atPath, actualParent, parentStat] = await Promise.all([
            file.stat(), lstat(path), realpath(parent), lstat(parent),
        ]);
        if (actualParent !== parent || !parentStat.isDirectory()
            || before.dev !== parentStat.dev || before.ino !== parentStat.ino || !opened.isFile()
            || !atPath.isFile() || atPath.isSymbolicLink()
            || opened.dev !== atPath.dev || opened.ino !== atPath.ino) {
            throw new Error("Generated canvas metadata changed during read");
        }
        if (opened.size > METADATA_LIMIT) return null;
        const bytes = Buffer.alloc(METADATA_LIMIT + 1);
        let length = 0;
        while (length < bytes.length) {
            const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length > METADATA_LIMIT) return null;
        return JSON.parse(bytes.toString("utf8", 0, length));
    } finally {
        await file.close();
    }
}

const execFileAsync = promisify(execFile);
const scripts = (project) => join(project, ".specify", "extensions", "extension-canvas-design", "scripts");

export async function checkGenerationProtocol(project, run = execFileAsync) {
    try {
        const { stdout } = await run(process.execPath,
            [join(scripts(project), "generate.mjs"), "--describe-contract"],
            { cwd: project, timeout: 10000, maxBuffer: 128 * 1024 });
        return validateGenerationProtocol(JSON.parse(stdout));
    } catch (error) {
        throw new Error(`Canvas Design does not support deferred publication. Launch with the current local Canvas Design source. ${error.message}`, { cause: error });
    }
}

export async function generatedOutput(project, id, handoffId, workspace, run = execFileAsync) {
    validateCanvasId(id);
    const { stdout } = await run(process.execPath, [join(scripts(project), "validate-generated-open.mjs"),
        "status", project, workspace, handoffId, id],
    { cwd: project, timeout: 10000, maxBuffer: 128 * 1024 });
    return validateOutputStatusResponse(JSON.parse(stdout), id);
}
