import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

const idPattern = /^[a-z0-9][a-z0-9-]{0,99}$/;
const reserved = new Set(["speckit-canvas-designer", "speckit-wizard", "speckit-canvas-generator"]);
const deviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function validateCanvasId(id) {
    if (typeof id !== "string" || !idPattern.test(id) || reserved.has(id)
        || deviceName.test(id)) throw new Error("Invalid generated Canvas ID");
    return id;
}

export function validateOutputAction(input, { replace = false } = {}) {
    const keys = replace && input?.replaceExisting === true
        ? ["canvasId", "replaceExisting"] : ["canvasId"];
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).sort().join() !== keys.sort().join()) {
        throw new Error("Invalid generated canvas action");
    }
    validateCanvasId(input.canvasId);
    return input;
}

async function regularJson(path) {
    let info;
    try { info = await lstat(path); }
    catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
    if (!info.isFile() || info.size > 1024 * 1024) return null;
    return JSON.parse(await readFile(path, "utf8"));
}

export async function generatedOutput(project, id, handoffId) {
    validateCanvasId(id);
    const root = await realpath(project);
    const parent = join(root, ".github", "extensions");
    const target = join(parent, id);
    try {
        if (await realpath(parent) !== parent) {
            throw new Error("Generated extension parent escapes the checkout");
        }
    } catch (error) {
        if (error.code === "ENOENT") return { status: "absent", target: `.github/extensions/${id}/` };
        throw error;
    }
    let folder;
    try { folder = await lstat(target); }
    catch (error) {
        if (error.code === "ENOENT") return { status: "absent", target: `.github/extensions/${id}/` };
        throw error;
    }
    const result = { status: "foreign", target: `.github/extensions/${id}/` };
    if (!folder.isDirectory() || await realpath(target) !== target) return result;
    try {
        const config = await regularJson(join(target, "canvas-config.json"));
        const provenance = await regularJson(join(target, "settings-provenance.json"));
        if (config?.canvas?.id !== id || provenance?.handoffId !== handoffId
            || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(provenance.requestId)) return result;
        const entry = await lstat(join(target, "extension.mjs"));
        return entry.isFile() ? { ...result, status: "ready", requestId: provenance.requestId }
            : { ...result, status: "incomplete" };
    } catch (error) {
        if (error.code === "ENOENT") return { ...result, status: "incomplete" };
        if (error instanceof SyntaxError) return result;
        throw error;
    }
}
