import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const HANDOFF_LIMIT = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PACKAGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const KINDS = ["presets", "extensions", "bundles"];
// Local development sources: no bundles (plan explicitly excludes local
// bundles), and the path is a user-typed absolute directory rather than a
// catalog download URL.
const LOCAL_KINDS = ["presets", "extensions"];
const LOCAL_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)[^\x00-\x1f]{0,4094}$/;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// `localSelections` is an optional, additive top-level handoff key. Absent
// entirely (the hosted-catalog-only path) is valid and leaves the handoff
// byte-identical to the pre-local-dev schema.
function validLocalSelections(value) {
    if (value === undefined) return true;
    if (!record(value) || Object.keys(value).some((kind) => !LOCAL_KINDS.includes(kind))) return false;
    // A kind with no local selections is omitted entirely (not sent as an
    // empty array) to keep the handoff minimal; treat an absent kind as an
    // empty list rather than requiring every kind key to be present.
    return LOCAL_KINDS.every((kind) => {
        const list = kind in value ? value[kind] : [];
        if (!Array.isArray(list) || list.length > 20) return false;
        const seen = new Set();
        return list.every((item) => {
            if (!record(item) || Object.keys(item).some((key) =>
                !["id", "source", "approved", "path"].includes(key))) return false;
            if (typeof item.id !== "string" || !PACKAGE.test(item.id)) return false;
            if (item.source !== "local" || item.approved !== true) return false;
            if (typeof item.path !== "string" || !LOCAL_PATH.test(item.path)) return false;
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });
    });
}

function safeUrl(value) {
    if (value === null) return true;
    if (typeof value !== "string" || value.length > 2048 || /[\s\x00-\x1f\x7f<>]/.test(value)) {
        return false;
    }
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
    } catch { return false; }
}

export function validateHandoffId(id) {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid Designer handoff ID");
    return id;
}

export function fingerprint(data) {
    return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

export function validateHandoff(handoff, id) {
    validateHandoffId(id);
    if (!record(handoff)
        || Object.keys(handoff).some((key) =>
            !["schemaVersion", "handoffId", "workflow", "selections", "sourceFingerprint", "localSelections"]
                .includes(key))
        || handoff.schemaVersion !== 1 || handoff.handoffId !== id
        || !record(handoff.workflow)
        || Object.keys(handoff.workflow).some((key) => !["selectedPhases", "installed"].includes(key))
        || !Array.isArray(handoff.workflow.selectedPhases)
        || handoff.workflow.selectedPhases.length > 30
        || !handoff.workflow.selectedPhases.every((phase) => typeof phase === "string" && PACKAGE.test(phase))
        || (handoff.workflow.installed !== undefined
            && (!record(handoff.workflow.installed)
                || KINDS.some((kind) => !Array.isArray(handoff.workflow.installed[kind])
                    || handoff.workflow.installed[kind].length > 40
                    || handoff.workflow.installed[kind].some((item) => !record(item)
                        || Object.keys(item).some((key) =>
                            !["id", "version", "source", "priority", "path", "downloadUrl", "catalogId"].includes(key))
                        || typeof item.id !== "string" || !PACKAGE.test(item.id)
                        || (kind !== "bundles"
                            && !Number.isSafeInteger(item.priority))
                        || (kind === "bundles" && item.priority !== undefined)
                        || (item.catalogId !== undefined
                            && (kind !== "bundles" || item.source !== "default"
                                || typeof item.catalogId !== "string" || !PACKAGE.test(item.catalogId)))
                        || (item.source !== undefined
                            && (typeof item.source !== "string" || !PACKAGE.test(item.source)))
                        || (item.path !== undefined
                            && (kind === "bundles" || item.source === undefined || !LOCAL_PATH.test(item.path)
                                || item.downloadUrl !== undefined))
                        || (item.downloadUrl !== undefined
                            && (item.source === "local" || item.path !== undefined
                                || (item.downloadUrl === null
                                    ? kind !== "bundles" || item.source !== "default"
                                    : typeof item.downloadUrl !== "string" || !safeUrl(item.downloadUrl))))
                        || typeof item.version !== "string" || !item.version || item.version.length > 64))))
        || !record(handoff.selections)
        || Object.keys(handoff.selections).some((kind) => !KINDS.includes(kind))
        || KINDS.some((kind) => !Array.isArray(handoff.selections[kind])
            || handoff.selections[kind].length > 40
            || new Set(handoff.selections[kind].map((item) =>
                `${item?.source}:${item?.id}`)).size !== handoff.selections[kind].length
            || !handoff.selections[kind].every((item) => record(item)
                && Object.keys(item).every((key) =>
                    ["id", "source", "approved", "version", "downloadUrl"].includes(key))
                && typeof item.id === "string" && PACKAGE.test(item.id)
                && typeof item.source === "string" && PACKAGE.test(item.source)
                && item.approved === true
                && (item.version === null || (typeof item.version === "string"
                    && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(item.version)))
                && safeUrl(item.downloadUrl)))
        || !validLocalSelections(handoff.localSelections)
        || typeof handoff.sourceFingerprint !== "string"
        || !/^[a-f0-9]{64}$/.test(handoff.sourceFingerprint)
        || Buffer.byteLength(JSON.stringify(handoff)) > HANDOFF_LIMIT) {
        throw new Error("Invalid Designer handoff");
    }
    const expected = Buffer.from(fingerprint({
        workflow: handoff.workflow, selections: handoff.selections, localSelections: handoff.localSelections,
    }), "hex");
    if (!timingSafeEqual(expected, Buffer.from(handoff.sourceFingerprint, "hex"))) {
        throw new Error("Designer handoff fingerprint mismatch");
    }
    return handoff;
}

export async function readHandoff(workspacePath, handoffId, openFile = open) {
    const id = validateHandoffId(handoffId);
    if (typeof workspacePath !== "string" || !workspacePath.trim()) {
        throw new Error("Designer session workspace is unavailable");
    }
    const root = await realpath(workspacePath);
    const folder = join(root, "speckit-canvas-designer", "handoffs", id);
    const actual = await realpath(folder);
    const rel = relative(root, actual);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)
        || isAbsolute(rel) || actual !== folder) {
        throw new Error("Designer handoff escapes session artifacts");
    }
    const path = join(folder, "handoff.json");
    let file;
    try {
        file = await openFile(path, constants.O_RDONLY
            | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
        if (error.code === "ELOOP") throw new Error("Invalid Designer handoff file", { cause: error });
        throw error;
    }
    let text;
    try {
        const [stat, pathStat, currentFolder] = await Promise.all([
            file.stat(), lstat(path), realpath(folder),
        ]);
        if (currentFolder !== folder) throw new Error("Designer handoff escapes session artifacts");
        if (!stat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink()
            || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino
            || stat.size > HANDOFF_LIMIT) {
            throw new Error("Invalid Designer handoff file");
        }
        const bytes = Buffer.alloc(HANDOFF_LIMIT + 1);
        let length = 0;
        while (length < bytes.length) {
            const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
            if (bytesRead === 0) break;
            length += bytesRead;
        }
        if (length > HANDOFF_LIMIT) throw new Error("Oversized Designer handoff");
        text = bytes.toString("utf8", 0, length);
    } finally {
        await file.close();
    }
    let handoff;
    try { handoff = JSON.parse(text); }
    catch { throw new Error("Malformed Designer handoff"); }
    return validateHandoff(handoff, id);
}

export function handoffDirectory(workspacePath, id) {
    validateHandoffId(id);
    if (typeof workspacePath !== "string" || !workspacePath.trim()) {
        throw new Error("Designer session workspace is unavailable");
    }
    return resolve(workspacePath, "speckit-canvas-designer", "handoffs", id);
}
