import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { handoffDirectory } from "./handoff.mjs";
import { decodeImage } from "./image.mjs";
import { validControlValue } from "./control-contract.mjs";

export const SETTINGS_LIMIT = 1024 * 1024;
export const SAVE_REQUEST_LIMIT = SETTINGS_LIMIT - 8 * 1024;
const saves = new Map();

export function validateValues(values, constraints) {
    if (!values || typeof values !== "object" || Array.isArray(values)
        || Object.keys(values).length !== Object.keys(constraints).length
        || Object.keys(values).some((key) => !Object.hasOwn(constraints, key))) {
        throw new Error("Designer settings contain unexpected or missing fields");
    }
    for (const [key, rule] of Object.entries(constraints)) {
        const value = values[key];
        if (rule.type === "boolean") {
            if (typeof value !== "boolean") throw new Error(`Invalid Designer setting: ${key}`);
        } else if (rule.type === "image") {
            if (Object.keys(rule).sort().join() !== "maxBytes,mimeTypes,type"
                || rule.maxBytes !== 32 * 1024
                || JSON.stringify(rule.mimeTypes)
                    !== '["image/png","image/jpeg","image/gif","image/webp"]') {
                throw new Error(`Invalid Designer image constraint: ${key}`);
            }
            try { decodeImage(value, rule.maxBytes); }
            catch (error) { throw new Error(`Invalid Designer setting: ${key}: ${error.message}`, { cause: error }); }
        } else if (rule.type === "object") {
            if (!validControlValue(value, rule)) {
                throw new Error(`Invalid Designer setting: ${key}`);
            }
        } else if (typeof value !== "string" || value.length > rule.maxLength
            || value.length < (rule.minLength ?? 0)
            || (rule.required && !value.trim())
            || (rule.pattern && !new RegExp(rule.pattern).test(value))) {
            throw new Error(`Invalid Designer setting: ${key}`);
        }
    }
}

async function settingsPath(workspacePath, handoff) {
    const folder = handoffDirectory(await realpath(workspacePath), handoff.handoffId);
    if (await realpath(folder) !== folder) throw new Error("Designer settings escape session artifacts");
    return join(folder, "settings.json");
}

async function readSettings(path, handoff, model, openFile = open) {
    let file;
    try {
        file = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
            | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
        if (error.code === "ENOENT") {
            if (await realpath(dirname(path)) !== dirname(path)) {
                throw new Error("Designer settings escape session artifacts");
            }
            return null;
        }
        throw error;
    }
    let record;
    try {
        const [stat, current, folder] = await Promise.all([
            file.stat(), lstat(path), realpath(dirname(path)),
        ]);
        if (folder !== dirname(path)) throw new Error("Designer settings escape session artifacts");
        if (!stat.isFile() || !current.isFile() || current.isSymbolicLink()
            || stat.dev !== current.dev || stat.ino !== current.ino || stat.size > SETTINGS_LIMIT) {
            throw new Error("Invalid saved Designer settings file");
        }
        const bytes = Buffer.alloc(SETTINGS_LIMIT + 1);
        let length = 0;
        while (length < bytes.length) {
            const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length > SETTINGS_LIMIT) throw new Error("Saved Designer settings exceed the size limit");
        record = JSON.parse(new TextDecoder("utf-8", { fatal: true })
            .decode(bytes.subarray(0, length)));
    } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError) {
            throw new Error("Invalid saved Designer settings JSON", { cause: error });
        }
        throw error;
    } finally {
        await file.close();
    }
    if (!record || typeof record !== "object" || Array.isArray(record)
        || Object.keys(record).sort().join() !== "handoffId,modelRevision,revision,schemaVersion,values"
        || record.schemaVersion !== 1 || record.handoffId !== handoff.handoffId
        || !Number.isSafeInteger(record.revision) || record.revision < 1
        || record.modelRevision !== model.revision) {
        throw new Error("Saved Designer settings do not match the current handoff or pages");
    }
    validateValues(record.values, model.constraints);
    return record;
}

async function assertTemporaryFile(file, path, folder) {
    const [opened, current, actualFolder] = await Promise.all([
        file.stat(), lstat(path), realpath(folder),
    ]);
    if (actualFolder !== folder || !opened.isFile() || !current.isFile()
        || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
        throw new Error("Designer settings escape session artifacts");
    }
}

export async function loadDesignerSettings(workspacePath, handoff, model, openFile = open) {
    const record = await readSettings(await settingsPath(workspacePath, handoff),
        handoff, model, openFile);
    return { ...model, values: record?.values ?? model.values,
        settingsRevision: record?.revision ?? 0, persisted: Boolean(record) };
}

export async function saveDesignerSettings(workspacePath, handoff, model, request, openFile = open) {
    if (!request || typeof request !== "object" || Array.isArray(request)
        || Object.keys(request).sort().join() !== "modelRevision,revision,values"
        || request.modelRevision !== model.revision
        || !Number.isSafeInteger(request.revision) || request.revision < 0) {
        throw new Error("Invalid Designer save request");
    }
    validateValues(request.values, model.constraints);
    const path = await settingsPath(workspacePath, handoff);
    const prior = saves.get(path) ?? Promise.resolve();
    const work = prior.catch(() => {}).then(async () => {
        const current = await readSettings(path, handoff, model);
        if (request.revision !== (current?.revision ?? 0)) {
            throw new Error("Designer settings changed elsewhere. Copy any unsaved edits, then close and reopen Designer before saving.");
        }
        const record = { schemaVersion: 1, handoffId: handoff.handoffId,
            modelRevision: model.revision, revision: request.revision + 1, values: request.values };
        const bytes = JSON.stringify(record);
        if (Buffer.byteLength(bytes) > SETTINGS_LIMIT) throw new Error("Designer settings exceed the size limit");
        const folder = dirname(path);
        const temporary = join(folder, `settings-${randomUUID()}.tmp`);
        try {
            const file = await openFile(temporary, "wx", 0o600);
            try {
                await assertTemporaryFile(file, temporary, folder);
                await file.writeFile(bytes);
                await assertTemporaryFile(file, temporary, folder);
            }
            finally { await file.close(); }
            // This check cannot pin the directory through rename; a same-user process could swap it between calls.
            // The local session-artifact directory is not a security boundary against such processes.
            if (await realpath(folder) !== folder) {
                throw new Error("Designer settings escape session artifacts");
            }
            await rename(temporary, path);
        } finally {
            await rm(temporary, { force: true });
        }
        return { ...model, values: record.values, settingsRevision: record.revision, persisted: true };
    });
    saves.set(path, work);
    try { return await work; }
    finally { if (saves.get(path) === work) saves.delete(path); }
}
