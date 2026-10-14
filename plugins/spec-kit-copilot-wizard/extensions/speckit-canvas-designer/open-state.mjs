import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validateLastOpen } from "./contracts/host-open.mjs";

const LIMIT = 1024 * 1024;

async function statePath(workspace) {
    const root = await realpath(workspace);
    const folder = join(root, "speckit-canvas-designer");
    await mkdir(folder, { recursive: true });
    if (await realpath(folder) !== folder) {
        throw new Error("Designer open inventory escapes session artifacts");
    }
    return join(folder, "last-open.json");
}

async function loadStateFile(path, validate, openFile = open, limit = LIMIT) {
    let file;
    try {
        file = await openFile(path, constants.O_RDONLY
            | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
        if (error.code === "ENOENT") {
            if (await realpath(dirname(path)) !== dirname(path)) {
                throw new Error("Designer open inventory escapes session artifacts");
            }
            return null;
        }
        throw error;
    }
    try {
        const [opened, current, folder] = await Promise.all([
            file.stat(), lstat(path), realpath(dirname(path)),
        ]);
        if (folder !== dirname(path) || !opened.isFile() || !current.isFile()
            || current.isSymbolicLink() || opened.dev !== current.dev
            || opened.ino !== current.ino || opened.size > limit) {
            throw new Error("Invalid saved Designer open inventory file");
        }
        const bytes = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < bytes.length) {
            const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length > limit) throw new Error("Saved Designer open inventory exceeds the size limit");
        const [after, currentAfter, parentAfter] = await Promise.all([
            file.stat(), lstat(path), realpath(dirname(path)),
        ]);
        if (parentAfter !== dirname(path) || currentAfter.isSymbolicLink()
            || currentAfter.dev !== opened.dev || currentAfter.ino !== opened.ino
            || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
            throw new Error("Saved Designer open inventory changed during read");
        }
        let record;
        try {
            record = JSON.parse(new TextDecoder("utf-8", { fatal: true })
                .decode(bytes.subarray(0, length)));
        } catch (error) {
            throw new Error("Invalid saved Designer open inventory JSON", { cause: error });
        }
        return validate(record);
    } finally {
        await file.close();
    }
}

export async function loadLastOpen(workspace, openFile = open) {
    return loadStateFile(await statePath(workspace), validateLastOpen, openFile);
}

async function saveStateFile(path, record, openFile = open) {
    const bytes = JSON.stringify(record);
    if (Buffer.byteLength(bytes) > LIMIT) {
        throw new Error("Designer open inventory exceeds the size limit");
    }
    const folder = dirname(path);
    const temporary = join(folder, `last-open-${randomUUID()}.tmp`);
    try {
        const file = await openFile(temporary, "wx", 0o600);
        try {
            const [opened, current, actual] = await Promise.all([
                file.stat(), lstat(temporary), realpath(folder),
            ]);
            if (actual !== folder || !opened.isFile() || !current.isFile()
                || current.isSymbolicLink() || opened.dev !== current.dev
                || opened.ino !== current.ino) {
                throw new Error("Designer open inventory escapes session artifacts");
            }
            await file.writeFile(bytes);
            const [written, atPath, currentFolder] = await Promise.all([
                file.stat(), lstat(temporary), realpath(folder),
            ]);
            if (currentFolder !== folder || !written.isFile() || !atPath.isFile()
                || atPath.isSymbolicLink() || written.dev !== atPath.dev
                || written.ino !== atPath.ino) {
                throw new Error("Designer open inventory changed while saving");
            }
        } finally {
            await file.close();
        }
        if (await realpath(folder) !== folder) {
            throw new Error("Designer open inventory escapes session artifacts");
        }
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}

export async function saveLastOpen(workspace, input, openFile = open) {
    const record = { schemaVersion: 1, handoffId: input.handoffId,
        pages: input.pages, templates: input.templates };
    validateLastOpen(record);
    return saveStateFile(await statePath(workspace), record, openFile);
}

function validateActiveGeneration(record) {
    if (!record || Object.keys(record).sort().join() !== "handoffId,requestId,schemaVersion"
        || record.schemaVersion !== 2
        || ![record.handoffId, record.requestId].every((id) =>
            typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))) {
        throw new Error("Invalid active Designer generation");
    }
    return record;
}

async function activePath(workspace, handoffId) {
    validateActiveGeneration({ schemaVersion: 2, handoffId, requestId: "validate" });
    const root = await realpath(workspace);
    const folder = join(root, "speckit-canvas-designer", "handoffs", handoffId);
    if (await realpath(folder) !== folder) throw new Error("Active generation escapes session artifacts");
    return join(folder, "active-generation.json");
}

export async function saveActiveGeneration(workspace, handoffId, requestId) {
    const record = validateActiveGeneration({ schemaVersion: 2, handoffId, requestId });
    return saveStateFile(await activePath(workspace, handoffId), record);
}

export async function loadActiveGeneration(workspace, handoffId) {
    const record = await loadStateFile(await activePath(workspace, handoffId), validateActiveGeneration);
    if (!record) return null;
    if (record.handoffId !== handoffId) throw new Error("Active generation belongs to another handoff");
    const folder = join(dirname(await activePath(workspace, handoffId)), "generations", record.requestId);
    if (await realpath(folder) !== folder) throw new Error("Active request escapes session artifacts");
    const request = await loadStateFile(join(folder, "request.json"), (request) => {
        if (!request || request.schemaVersion !== 2 || request.requestId !== record.requestId
            || request.handoffId !== handoffId) throw new Error("Invalid active generation request");
        return request;
    }, open, 4 * 1024 * 1024);
    if (!request) throw new Error("Tracked generation request is missing");
    return request;
}

export async function replaceLastOpen(workspace, input, prepare, install) {
    const path = await statePath(workspace);
    const backup = join(dirname(path), `last-open-${randomUUID()}.backup`);
    let backedUp = false;
    try {
        await rename(path, backup);
        backedUp = true;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    try {
        await saveLastOpen(workspace, input);
        await prepare();
        const result = install();
        if (backedUp) {
            void rm(backup, { force: true }).catch((error) =>
                process.emitWarning(`Could not remove saved Designer inventory backup: ${error.message}`));
        }
        return result;
    } catch (error) {
        try {
            if (await realpath(dirname(path)) !== dirname(path)) {
                throw new Error("Designer open inventory escapes session artifacts");
            }
            await rm(path, { force: true });
            if (backedUp) await rename(backup, path);
        } catch (rollbackError) {
            throw new AggregateError([error, rollbackError],
                "Could not restore saved Designer open inventory");
        }
        throw error;
    }
}
