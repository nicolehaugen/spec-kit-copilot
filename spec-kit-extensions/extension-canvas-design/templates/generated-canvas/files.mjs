import { constants } from "node:fs";
import { lstat, open, realpath, readdir, mkdir, rename, unlink } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export class UserError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}
export const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function safePath(value, template = false) {
    if (typeof value !== "string" || !value || value.length > 2048) throw new UserError("Invalid artifact path.");
    const parts = value.replaceAll("\\", "/").split("/");
    if (parts.some((part) => !part || part === "." || part === ".."
        || (!(template && ["<slug>", "<name>.md"].includes(part)) && /[<>:"|?*\x00-\x1f]/.test(part))
        || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) {
        throw new UserError("This path is outside the supported artifact locations.");
    }
    return parts.join("/");
}

export async function confined(root, path, { createDirectories = false } = {}) {
    root = await realpath(root);
    let target = root;
    for (const part of safePath(path).split("/")) {
        target = resolve(target, part);
        if (createDirectories) {
            try { await mkdir(target); } catch (error) { if (error.code !== "EEXIST") throw error; }
        }
        const info = await lstat(target);
        const actual = await realpath(target);
        const rel = relative(root, actual);
        if (info.isSymbolicLink() || rel.startsWith("..") || isAbsolute(rel) || relative(target, actual)) {
            throw new UserError("This path contains a link or leaves the current checkout.");
        }
    }
    return target;
}

export async function readBoundedBytes(root, path, cap = 512 * 1024) {
    const target = await confined(root, path);
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > cap) throw new UserError("Artifact is unavailable or exceeds the 512 KiB limit.", 413);
        const buffer = Buffer.alloc(cap + 1);
        let size = 0;
        while (size < buffer.length) {
            const result = await handle.read(buffer, size, buffer.length - size, size);
            if (!result.bytesRead) break;
            size += result.bytesRead;
        }
        const after = await lstat(await confined(root, path));
        if (size > cap) throw new UserError("Artifact exceeds the supported size limit.", 413);
        if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs
            || before.size !== after.size || before.size !== size) {
            throw new UserError("Artifact changed while reading. Refresh to try again.", 409);
        }
        return buffer.subarray(0, size);
    } finally { await handle.close(); }
}

export async function readBounded(root, path, cap = 512 * 1024) {
    return new TextDecoder("utf-8", { fatal: true })
        .decode(await readBoundedBytes(root, path, cap));
}

export async function directories(root, path) {
    try {
        const entries = await readdir(await confined(root, path), { withFileTypes: true });
        const result = [];
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.isSymbolicLink() && slugPattern.test(entry.name)) {
                await confined(root, `${path}/${entry.name}`);
                result.push(entry.name);
            }

        }
        return result.sort();
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
}

export async function atomicJson(root, path, data) {
    const directory = await confined(root, dirname(path).replaceAll("\\", "/"), { createDirectories: true });
    const target = join(directory, path.split("/").at(-1));
    try { await confined(root, path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(data)); } finally { await handle.close(); }
        await rename(temporary, target);
    } finally {
        try { await unlink(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
}
