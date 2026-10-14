import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { generationTargets, RECEIPT_NAME } from "./contracts/generation-request.mjs";

export const TREE_LIMIT = 32 * 1024 * 1024;
export const FILE_LIMIT = 8 * 1024 * 1024;
export const RECEIPT_LIMIT = 1024 * 1024;

export async function safeDirectory(path, optional = false) {
    let value;
    try { value = await lstat(path); }
    catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
    if (!value.isDirectory() || value.isSymbolicLink() || await realpath(path) !== resolve(path)) {
        throw new Error(`Unsafe generated directory: ${path}`);
    }
    return value;
}

export async function unchangedDirectory(path, before) {
    const current = await safeDirectory(path);
    if (before.dev !== current.dev || before.ino !== current.ino) {
        throw new Error(`Generated directory changed: ${path}`);
    }
}

export async function readGeneratedFile(parent, name, limit = FILE_LIMIT, openFile = open) {
    const before = await safeDirectory(parent);
    const path = join(parent, name);
    const file = await openFile(path, constants.O_RDONLY
        | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const [opened, atPath] = await Promise.all([file.stat(), lstat(path)]);
        if (!opened.isFile() || !atPath.isFile() || atPath.isSymbolicLink()
            || opened.dev !== atPath.dev || opened.ino !== atPath.ino || opened.size > limit) {
            throw new Error(`Generated file must be a bounded regular file: ${path}`);
        }
        const bytes = Buffer.alloc(Math.min(opened.size, limit) + 1);
        let size = 0;
        while (size < bytes.length) {
            const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
            if (!bytesRead) break;
            size += bytesRead;
        }
        const after = await file.stat();
        if (size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
            throw new Error(`Generated file changed while reading: ${path}`);
        }
        const current = await lstat(path);
        if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
            throw new Error(`Generated file changed while reading: ${path}`);
        }
        await unchangedDirectory(parent, before);
        return bytes.subarray(0, size);
    } finally { await file.close(); }
}

function validRelativePath(path) {
    return typeof path === "string" && path.length <= 1024 && !isAbsolute(path)
        && path.split("/").length <= 8
        && path.split("/").every((part) => /^[A-Za-z0-9_.-]{1,160}$/.test(part)
            && ![".", ".."].includes(part)
            && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export async function snapshotGeneratedTree(root, includeReceipt = false) {
    const entries = [];
    let total = 0;
    const seen = new Set();
    async function visit(parent, depth) {
        if (depth > 8) throw new Error("Generated directory nesting exceeds the limit");
        const before = await safeDirectory(parent);
        for (const entry of await readdir(parent, { withFileTypes: true })) {
            const path = join(parent, entry.name);
            const key = relative(root, path).split(sep).join("/");
            if (!validRelativePath(key) || seen.has(key.toLowerCase()) || entry.isSymbolicLink()) {
                throw new Error(`Unsafe or duplicate generated path: ${key}`);
            }
            seen.add(key.toLowerCase());
            if (seen.size > 4096) throw new Error("Generated file inventory exceeds the limit");
            if (entry.isDirectory()) await visit(path, depth + 1);
            else if (!entry.isFile()) throw new Error(`Special generated file: ${key}`);
            else if (includeReceipt || key !== RECEIPT_NAME) {
                const bytes = await readGeneratedFile(parent, entry.name);
                total += bytes.length;
                if (total > TREE_LIMIT) throw new Error("Generated output exceeds 32 MiB");
                entries.push({ path: key, size: bytes.length,
                    hash: createHash("sha256").update(bytes).digest("hex") });
            }
        }
        await unchangedDirectory(parent, before);
    }
    await visit(root, 0);
    return entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

export const treeDigest = (files) => createHash("sha256").update(JSON.stringify(files)).digest("hex");

export function validateReceipt(receipt, request = null) {
    const keys = ["schemaVersion", "project", "canvasId", "handoffId", "requestId",
        "requestIntegrity", "sourceFingerprint", "target", "publicationTarget", "files"];
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
        || Object.keys(receipt).sort().join() !== keys.sort().join()
        || receipt.schemaVersion !== 2 || !isAbsolute(receipt.project ?? "")
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(receipt.handoffId ?? "")
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(receipt.requestId ?? "")
        || !/^[a-f0-9]{64}$/.test(receipt.requestIntegrity ?? "")
        || !/^[a-f0-9]{64}$/.test(receipt.sourceFingerprint ?? "")
        || !Array.isArray(receipt.files) || !receipt.files.length || receipt.files.length > 4096) {
        throw new Error("Invalid generation receipt");
    }
    const targets = generationTargets(receipt.canvasId);
    if (receipt.target !== targets.target || receipt.publicationTarget !== targets.publicationTarget) {
        throw new Error("Invalid receipt targets");
    }
    const seen = new Set();
    let total = 0;
    for (const file of receipt.files) {
        if (!file || Object.keys(file).sort().join() !== "hash,path,size"
            || !validRelativePath(file.path) || file.path === RECEIPT_NAME
            || seen.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size)
            || file.size < 0 || file.size > FILE_LIMIT || !/^[a-f0-9]{64}$/.test(file.hash ?? "")) {
            throw new Error("Invalid receipt file inventory");
        }
        seen.add(file.path.toLowerCase());
        total += file.size;
    }
    if (total > TREE_LIMIT || !["extension.mjs", "canvas-config.json", "canvas-setup.json",
        "settings-provenance.json"].every((path) => seen.has(path))) {
        throw new Error("Incomplete or oversized generation receipt");
    }
    if (request && (receipt.project !== request.project || receipt.requestId !== request.requestId
        || receipt.handoffId !== request.handoffId || receipt.requestIntegrity !== request.integrity
        || receipt.canvasId !== request.values?.["canvas.id"]
        || receipt.sourceFingerprint !== request.sourceFingerprint
        || receipt.target !== request.target || receipt.publicationTarget !== request.publicationTarget)) {
        throw new Error("Generation receipt differs from the frozen request");
    }
    return receipt;
}

export async function readReceipt(root, request = null, verify = true) {
    const receipt = validateReceipt(JSON.parse(await readGeneratedFile(root, RECEIPT_NAME,
        RECEIPT_LIMIT)), request);
    const provenance = JSON.parse(await readGeneratedFile(root, "settings-provenance.json", RECEIPT_LIMIT));
    const config = JSON.parse(await readGeneratedFile(root, "canvas-config.json", FILE_LIMIT));
    if (Object.keys(provenance).sort().join() !== "handoffId,requestId,sourceFingerprint"
        || provenance.requestId !== receipt.requestId || provenance.handoffId !== receipt.handoffId
        || provenance.sourceFingerprint !== receipt.sourceFingerprint
        || config?.canvas?.id !== receipt.canvasId) {
        throw new Error("Generated provenance differs from its receipt");
    }
    if (verify && treeDigest(await snapshotGeneratedTree(root)) !== treeDigest(receipt.files)) {
        throw new Error("Generated files differ from their receipt");
    }
    return receipt;
}

export async function renameDirectoryWithoutReplacement(source, destination) {
    if (process.platform === "win32") {
        const staged = await safeDirectory(source);
        for (let attempt = 0; ; attempt++) {
            try { await rename(source, destination); break; }
            catch (error) {
                if (error.code !== "EPERM" || attempt >= 5) throw error;
                await new Promise((done) => setTimeout(done, 100 * (attempt + 1)));
                await unchangedDirectory(source, staged);
                if (await safeDirectory(destination, true)) {
                    throw new Error("Canvas destination changed before publication");
                }
            }
        }
        return;
    }
    await mkdir(destination);
    const claim = await lstat(destination);
    try {
        await unchangedDirectory(destination, claim);
        await rename(source, destination);
    } catch (error) {
        const current = await safeDirectory(destination, true);
        if (current?.dev === claim.dev && current.ino === claim.ino) {
            try { await rmdir(destination); }
            catch (cleanup) {
                throw new AggregateError([error, cleanup], "Canvas destination could not be released");
            }
        }
        throw error;
    }
}
