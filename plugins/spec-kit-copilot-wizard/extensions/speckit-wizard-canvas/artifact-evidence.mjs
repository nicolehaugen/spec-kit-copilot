import { createHash } from "node:crypto";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { effectivePipelinePhases, stripCommandsPrefix } from "./pipeline/effective-phases.mjs";
import { parseCommandFile } from "./composition/preset-loader.mjs";
import { CORE_OUTPUTS } from "./pipeline/canonical.mjs";
import { PHASE_ORDER } from "./canvas-runtime/wizard-phases.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
export const commandId = (id) => stripCommandsPrefix(
    typeof id === "string" ? id.replace(/^command:/, "") : id);
const validId = (id) => typeof id === "string" && /^[\w.-]{1,100}$/.test(id);

export function artifactPath(value, kind = "file") {
    if (typeof value !== "string" || value.length > 1000) return null;
    const path = value.replaceAll("\\", "/");
    if (kind === "folder" && !path) return "";
    const parts = (kind === "folder" ? path.replace(/\/$/, "") : path).split("/");
    if ((kind === "file" && !path.endsWith(".md"))
        || parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part)
            || (part !== "<slug>" && /[<>:"|?*\x00-\x1f\x7f]/.test(part))
            || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))
        || parts.filter((part) => part === "<slug>").length > 1 || parts[0] === "<slug>"
        || [".git", ".github", "node_modules", ".speckit-wizard"].includes(parts[0].toLowerCase())
        || /^\.specify\/(extensions|presets|templates)\//i.test(path)) return null;
    return kind === "folder" ? `${parts.join("/")}/` : path;
}

export function pathEvidence(path, source) {
    if (typeof path !== "string") return null;
    const portable = path.replaceAll("\\", "/");
    const variableFile = portable.endsWith("/<name>.md");
    const kind = portable.endsWith("/") || variableFile ? "folder" : "file";
    const safe = artifactPath(variableFile ? portable.slice(0, -9) : portable, kind);
    return safe === null ? null : { kind, path: safe, source, effect: "unknown" };
}

export function validateCandidates(value, { inference = false } = {}) {
    if (!Array.isArray(value) || value.length > 12) throw new Error("Invalid artifact evidence candidates");
    return value.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)
            || Object.keys(item).some((key) => !["kind", "path", "relativeTo", "root", "source", "effect", "evidence", "contributors"].includes(key))
            || !["file", "folder", "none", "unknown"].includes(item.kind)
            || !["manual", "declaration", "inference", "core", "observed"].includes(item.source)
            || (inference && item.source !== "inference")
            || !["creates", "updates", "unknown"].includes(item.effect)) throw new Error("Invalid artifact evidence candidate");
        const result = { kind: item.kind, source: item.source, effect: item.effect };
        if (["file", "folder"].includes(item.kind)) {
            result.path = artifactPath(item.path, item.kind);
            if (result.path === null) throw new Error("Unsafe artifact evidence path");
        } else if (item.path != null) throw new Error("Non-file evidence cannot declare a path");
        if (item.relativeTo !== undefined) {
            if (item.relativeTo !== "feature" || !result.path || item.source !== "inference"
                || result.path.includes("<slug>") || item.root !== undefined) throw new Error("Invalid feature-relative artifact evidence");
            result.relativeTo = "feature";
        }
        if (item.root !== undefined) {
            const root = item.root;
            if (!result.path || item.source !== "inference" || item.relativeTo !== undefined
                || result.path.includes("<slug>") || !root || typeof root !== "object" || Array.isArray(root)
                || Object.keys(root).some((key) => !["name", "path"].includes(key))
                || typeof root.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(root.name)) {
                throw new Error("Invalid named output root");
            }
            const path = root.path === undefined ? null : artifactPath(root.path, "folder");
            if (root.path !== undefined && (!path || path.split("/").filter((part) => part === "<slug>").length > 1)) {
                throw new Error("Unsafe named output root path");
            }
            result.root = { name: root.name, ...(path ? { path: path.slice(0, -1) } : {}) };
        }
        if (item.evidence !== undefined) {
            if (typeof item.evidence !== "string" || !item.evidence.trim() || item.evidence.length > 500
                || /[\x00-\x1f\x7f]/.test(item.evidence)) throw new Error("Invalid artifact supporting evidence");
            result.evidence = item.evidence;
        }
        if (inference && !result.evidence) throw new Error("Artifact inference requires supporting evidence");
        if (item.contributors !== undefined) {
            if (!["file", "folder"].includes(item.kind) || !Array.isArray(item.contributors)
                || item.contributors.length < 1 || item.contributors.length > 6
                || item.contributors.some((contributor) => !contributor
                    || typeof contributor !== "object" || Array.isArray(contributor)
                    || Object.keys(contributor).some((key) => !["layer", "id"].includes(key))
                    || !["core", "preset", "extension"].includes(contributor.layer)
                    || (contributor.id !== undefined && (contributor.layer === "core"
                        || !validId(contributor.id))))) throw new Error("Invalid contributors");
            result.contributors = item.contributors.map(({ layer, id }) => ({ layer, ...(id ? { id } : {}) }));
            if (new Set(result.contributors.map(({ layer, id }) => `${layer}:${id ?? ""}`)).size !== result.contributors.length) {
                throw new Error("Duplicate contributors");
            }
        }
        return result;
    });
}

export function validatePrimaryIndex(value, candidates) {
    if (value === undefined || value === null) return value;
    if (!Number.isInteger(value) || value < 0 || candidates[value]?.kind !== "file") {
        throw new Error("Artifact primary must reference a file candidate");
    }
    return value;
}

export function normalizeInferredEvidence(candidates, primaryIndex) {
    const unique = [], indexes = new Map();
    let selected = primaryIndex;
    for (const [index, candidate] of candidates.entries()) {
        const key = ["file", "folder"].includes(candidate.kind)
            ? `${candidate.kind}:${candidate.root?.name ?? candidate.relativeTo ?? "repo"}:${candidate.root?.path ?? ""}:${candidate.path}` : null;
        if (key === null || !indexes.has(key)) {
            if (key !== null) indexes.set(key, unique.length);
            if (index === primaryIndex) selected = unique.length;
            unique.push(candidate);
        } else {
            const target = indexes.get(key);
            unique[target] = { ...unique[target],
                effect: unique[target].effect === candidate.effect ? candidate.effect : "unknown",
                ...(candidate.contributors || unique[target].contributors ? {
                    contributors: [...new Map([...(unique[target].contributors ?? []),
                        ...(candidate.contributors ?? [])].map((item) =>
                        [`${item.layer}:${item.id ?? ""}`, item])).values()],
                } : {}) };
            if (index === primaryIndex) selected = target;
        }
    }
    return { candidates: unique, primaryIndex: selected };
}

async function sourceFile(cwd, path) {
    if (typeof path !== "string" || !/^(?:\.github\/skills\/|\.specify\/scripts\/)/.test(path)
        || path.split("/").some((part) => !part || part === "." || part === "..")
        || /[\\<>:"|?*\x00-\x1f\x7f]/.test(path)) throw new Error("Unsafe artifact evidence source");
    const root = await realpath(cwd);
    let current = root;
    for (const part of path.split("/")) {
        current = join(current, part);
        try {
            const stat = await lstat(current);
            if (stat.isSymbolicLink()) throw new Error("Linked artifact evidence source");
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
    }
    const actual = await realpath(current);
    if (resolve(actual) !== resolve(current) || relative(root, actual).startsWith("..")) {
        throw new Error("Artifact evidence source escapes checkout");
    }
    const stat = await lstat(actual);
    if (!stat.isFile() || stat.size > 512 * 1024) throw new Error("Invalid artifact evidence source");
    const text = await readFile(actual, "utf8");
    return { path, text, sha256: digest(text) };
}

export async function effectiveSource(cwd, id) {
    if (!validId(id)) throw new Error("Invalid evidence command ID");
    const full = id.startsWith("speckit.") ? id : `speckit.${id}`;
    const skillPath = `.github/skills/${full.replaceAll(".", "-")}/SKILL.md`;
    const skill = await sourceFile(cwd, skillPath);
    if (!skill) return null;
    const paths = new Set(skill.text.match(/\.specify\/scripts\/[\w./-]+\.(?:ps1|sh|py)\b/g) ?? []);
    for (const path of [...paths]) {
        if (path.endsWith(".ps1")) paths.add(`${dirname(path).replaceAll("\\", "/")}/common.ps1`);
        if (path.endsWith(".sh")) paths.add(`${dirname(path).replaceAll("\\", "/")}/common.sh`);
    }
    if (paths.size > 24) throw new Error("Too many script dependencies");
    const files = [skill];
    for (const path of [...paths].sort()) {
        files.push(await sourceFile(cwd, path) ?? { path, sha256: null });
    }
    const sources = files.map(({ path, sha256 }) => ({ path, sha256 }));
    return { skillPath, sources, fingerprint: digest(JSON.stringify({ version: 1, sources })) };
}

export async function readEvidenceCache(cwd) {
    const root = await realpath(cwd);
    const directory = join(root, ".speckit-wizard");
    const path = join(directory, "artifact-targets.json");
    try {
        const parent = await lstat(directory);
        if (!parent.isDirectory() || parent.isSymbolicLink()
            || resolve(await realpath(directory)) !== resolve(directory)) throw new Error("Linked artifact cache directory");
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024
            || resolve(await realpath(path)) !== resolve(path)) throw new Error("Unsafe artifact cache");
        const cache = JSON.parse(await readFile(path, "utf8"));
        if (!cache || !cache.entries || typeof cache.entries !== "object" || Array.isArray(cache.entries)) {
            throw new Error("Invalid artifact cache");
        }
        return cache;
    } catch (error) {
        if (error.code === "ENOENT") return { version: 1, entries: {} };
        throw error;
    }
}

export async function collectArtifactEvidence(cwd, snapshot) {
    const evidence = {}, requests = [], warnings = [];
    let cache;
    try { cache = await readEvidenceCache(cwd); }
    catch (error) { warnings.push(error.message); cache = { entries: {} }; }
    const ids = new Set(effectivePipelinePhases(snapshot).map(({ id }) => commandId(id)));
    for (const id of PHASE_ORDER) {
        if (id !== "setup") ids.add(id);
    }
    for (const command of snapshot.commands ?? []) ids.add(commandId(command.id));
    const extensions = await readdir(join(cwd, ".specify", "extensions"), { withFileTypes: true })
        .catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
    for (const extension of extensions) {
        if (!extension.isDirectory() || !validId(extension.name)) continue;
        const files = await readdir(join(cwd, ".specify", "extensions", extension.name, "commands"),
            { withFileTypes: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
        for (const file of files) {
            if (file.isFile() && file.name.endsWith(".md")) ids.add(commandId(file.name.slice(0, -3)));
        }
    }
    for (const id of ids) {
        if (!validId(id)) continue;
        const candidates = [];
        try {
            const source = await effectiveSource(cwd, id);
            const parsed = source ? await sourceFile(cwd, source.skillPath) : null;
            const declaration = parsed ? pathEvidence(
                (await parseCommandFile(parsed.text, warnings, "effective", id)).artifact, "declaration") : null;
            if (declaration) candidates.push(declaration);
            const cached = Object.entries(cache.entries).find(([key]) => commandId(key) === id)?.[1];
            const legacy = ["manual", "author"].includes(cached?.source)
                ? pathEvidence(cached.writesTo, cached.source === "manual" ? "manual" : "declaration") : null;
            if (legacy && !candidates.some((item) => item.path === legacy.path)) candidates.push(legacy);
            const current = source && cached?.outputEvidence?.fingerprint === source.fingerprint;
            if (!current && !candidates.length) {
                for (const path of CORE_OUTPUTS[id] ?? []) {
                    const candidate = pathEvidence(path, "core");
                    if (candidate) candidates.push(candidate);
                }
            }
            if (current) {
                const inferred = normalizeInferredEvidence(
                    validateCandidates(cached.outputEvidence.candidates, { inference: true }),
                    validatePrimaryIndex(cached.outputEvidence.primaryIndex, cached.outputEvidence.candidates));
                for (const candidate of inferred.candidates) {
                    if (!candidates.some((item) => item.path && item.path === candidate.path
                        && item.relativeTo === candidate.relativeTo && item.root?.name === candidate.root?.name)) {
                        candidates.push(candidate);
                    }
                }
            } else if (source) {
                requests.push({ commandId: id.startsWith("speckit.") ? id : `speckit.${id}`,
                    skillPath: source.skillPath, fingerprint: source.fingerprint, sources: source.sources });
            }
            let primaryIndex = current ? cached.outputEvidence.primaryIndex : undefined;
            if (current && Number.isInteger(primaryIndex)) {
                const target = cached.outputEvidence.candidates[primaryIndex];
                primaryIndex = candidates.findIndex((candidate) => candidate.kind === "file"
                    && candidate.path === target?.path && candidate.relativeTo === target?.relativeTo
                    && candidate.root?.name === target?.root?.name);
                if (primaryIndex < 0) primaryIndex = null;
            }
            if (current && candidates.some((candidate) => candidate.source === "manual" && candidate.kind === "file")) {
                primaryIndex = candidates.findIndex((candidate) => candidate.source === "manual" && candidate.kind === "file");
            }
            evidence[id] = { candidates, ...(source ? { fingerprint: source.fingerprint } : {}),
                ...(current ? { primaryIndex } : {}) };
        } catch (error) {
            warnings.push(`${id}: ${error.message}`);
            evidence[id] = { candidates };
        }
    }
    return { evidence, requests, warnings };
}
