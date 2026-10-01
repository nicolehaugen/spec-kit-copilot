// Validation for Designer "Local development" sources: user-typed absolute
// directory paths pointing at an uninstalled preset/extension on disk
// (`preset.yml` / `extension.yml`), used instead of a hosted catalog entry.
//
// This is NOT the workspace-sandboxed path helper in http-utils.mjs —
// local-dev paths are expected to be absolute and can point anywhere on the
// user's machine, so there is no "escapes the workspace" concept here.
// Validation is limited to: path well-formedness, directory existence, a
// parseable manifest, and a well-formed id/name/version extracted from it.

import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

// js-yaml (deferred import, mirrors composition/preset-loader.mjs and
// composition/collect.mjs): the wizard auto-runs `npm install` on first
// open of a fresh worktree, so a static top-level import would crash the
// extension process before that install can run. The safe schema rejects
// custom YAML tags (`!!js/function`, `!!js/regexp`, ...) that would
// otherwise let an untrusted local preset.yml/extension.yml execute code
// when parsed — local-dev paths point anywhere on disk, so this manifest
// content is never more trusted than a hosted catalog download.
let _yamlPromise = null;
function getYaml() {
    if (!_yamlPromise) {
        _yamlPromise = import("js-yaml").then(
            (m) => {
                const mod = m.default ?? m;
                const schema = mod.JSON_SCHEMA ?? mod.FAILSAFE_SCHEMA;
                return { load: (raw, opts = {}) => mod.load(raw, { schema, ...opts }) };
            },
            (err) => {
                _yamlPromise = null;
                throw err;
            },
        );
    }
    return _yamlPromise;
}

const PATH_LIMIT = 4096;
// Manifests are small, hand-authored YAML files; cap the read so an
// unbounded/adversarial file (e.g. a symlink to /dev/zero, or a huge
// generated file) cannot be read into memory wholesale before parsing.
const MANIFEST_SIZE_LIMIT = 65536;
// Same id pattern the Designer handoff schema already uses for catalog ids
// (handoff.mjs's PACKAGE regex), so local ids round-trip through the same
// schema without needing a second pattern downstream.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

const MANIFEST = {
    presets: { file: "preset.yml", key: "preset", label: "preset" },
    extensions: { file: "extension.yml", key: "extension", label: "extension" },
};

export function isSupportedLocalKind(kind) {
    return Object.prototype.hasOwnProperty.call(MANIFEST, kind);
}

/**
 * Validate a user-typed absolute directory as a local preset/extension
 * source. Resolves with `{ kind, id, name, version, path }` (the canonical,
 * realpath'd directory) or throws an `Error` with an explicit, user-facing
 * message describing exactly what failed.
 */
export async function validateLocalSource(kind, rawPath) {
    const manifest = MANIFEST[kind];
    if (!manifest) throw new Error("Local development only supports presets and extensions.");
    if (typeof rawPath !== "string" || !rawPath.trim()) {
        throw new Error("Enter a local directory path.");
    }
    const trimmed = rawPath.trim();
    if (trimmed.length > PATH_LIMIT || /[\x00-\x1f]/.test(trimmed)) {
        throw new Error("That path looks invalid.");
    }
    if (!isAbsolute(trimmed)) {
        throw new Error("Local development paths must be absolute (e.g. C:\\path\\to\\dir or /path/to/dir).");
    }
    let canonical;
    try {
        canonical = await realpath(trimmed);
    } catch {
        throw new Error(`Directory not found: ${trimmed}`);
    }
    const manifestPath = join(canonical, manifest.file);
    let fileStat;
    try {
        fileStat = await stat(manifestPath);
    } catch {
        throw new Error(`Missing ${manifest.file} in ${canonical}`);
    }
    if (!fileStat.isFile()) {
        throw new Error(`Missing ${manifest.file} in ${canonical}`);
    }
    if (fileStat.size > MANIFEST_SIZE_LIMIT) {
        throw new Error(`${manifest.file} is too large (max ${MANIFEST_SIZE_LIMIT} bytes)`);
    }
    let text;
    try {
        text = await readFile(manifestPath, "utf8");
    } catch {
        throw new Error(`Missing ${manifest.file} in ${canonical}`);
    }
    if (Buffer.byteLength(text, "utf8") > MANIFEST_SIZE_LIMIT) {
        throw new Error(`${manifest.file} is too large (max ${MANIFEST_SIZE_LIMIT} bytes)`);
    }
    let data;
    try {
        const yaml = await getYaml();
        data = yaml.load(text);
    } catch (err) {
        throw new Error(`Could not parse ${manifest.file}: ${err.message}`);
    }
    const section = data?.[manifest.key];
    const id = section?.id;
    const name = section?.name;
    const version = section?.version;
    if (typeof id !== "string" || !ID.test(id)) {
        throw new Error(`${manifest.file} is missing a valid ${manifest.key}.id`);
    }
    if (typeof name !== "string" || !name.trim()) {
        throw new Error(`${manifest.file} is missing a ${manifest.key}.name`);
    }
    if (version !== undefined && version !== null
        && (typeof version !== "string" || !VERSION.test(version))) {
        throw new Error(`${manifest.file} has an invalid ${manifest.key}.version`);
    }
    return {
        kind,
        id,
        name: name.trim(),
        version: typeof version === "string" ? version : null,
        path: canonical,
    };
}
