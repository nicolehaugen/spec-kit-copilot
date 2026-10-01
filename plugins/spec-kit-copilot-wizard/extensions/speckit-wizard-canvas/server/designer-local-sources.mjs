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

// Windows Explorer's "Copy as path" (and many shells' drag-and-drop) wraps
// the whole path in a single balanced pair of double quotes, e.g.
// `"C:\Users\name\dir"`, which users often paste verbatim. Strip exactly one
// such surrounding pair (double, or less commonly single) before validating
// the path. Anything else involving a quote character — an unmatched
// leading/trailing quote, or one embedded mid-path — is rejected explicitly
// rather than left to fail the `isAbsolute` check with a confusing message.
export function stripSurroundingQuotes(value) {
    const first = value[0];
    const last = value[value.length - 1];
    const wrapped = value.length >= 2 && first === last && (first === "\"" || first === "'");
    const unwrapped = wrapped ? value.slice(1, -1) : value;
    if (unwrapped.includes("\"") || unwrapped.includes("'")) {
        throw new Error("Remove the surrounding or embedded quotes from the path.");
    }
    return unwrapped;
}

/**
 * Resolve a user-typed path to a canonical, realpath'd absolute directory.
 * Kind-independent: shared by both the explicit-kind and auto-detect paths
 * through `validateLocalSource`.
 */
async function resolveCanonicalPath(rawPath) {
    if (typeof rawPath !== "string" || !rawPath.trim()) {
        throw new Error("Enter a local directory path.");
    }
    const trimmed = rawPath.trim();
    if (trimmed.length > PATH_LIMIT || /[\x00-\x1f]/.test(trimmed)) {
        throw new Error("That path looks invalid.");
    }
    const unquoted = stripSurroundingQuotes(trimmed).trim();
    if (!isAbsolute(unquoted)) {
        throw new Error("Local development paths must be absolute (e.g. C:\\path\\to\\dir or /path/to/dir).");
    }
    try {
        return await realpath(unquoted);
    } catch {
        throw new Error(`Directory not found: ${unquoted}`);
    }
}

/**
 * Does `canonical` contain a given kind's manifest file (as a regular
 * file, not a directory of the same name)? Used both to auto-detect kind
 * and to report a clear "missing manifest" error for an explicit kind.
 */
async function hasManifestFile(canonical, manifest) {
    try {
        const fileStat = await stat(join(canonical, manifest.file));
        return fileStat.isFile();
    } catch {
        return false;
    }
}

/**
 * Detect which kind `canonical` is by checking for `preset.yml` /
 * `extension.yml`. The two manifests are mutually exclusive and
 * self-identifying, so a directory with neither or both is rejected
 * explicitly rather than guessed at.
 */
async function detectLocalKind(canonical) {
    const present = [];
    for (const [kind, manifest] of Object.entries(MANIFEST)) {
        if (await hasManifestFile(canonical, manifest)) present.push(kind);
    }
    if (present.length === 0) {
        throw new Error(`No preset.yml or extension.yml found in ${canonical}`);
    }
    if (present.length > 1) {
        throw new Error(`Found both preset.yml and extension.yml in ${canonical}; a local source must be exactly one.`);
    }
    return present[0];
}

/**
 * Parse and validate the manifest for an already-known `kind` at
 * `canonical`. Resolves with `{ kind, id, name, version, path }`.
 */
async function validateManifest(kind, canonical) {
    const manifest = MANIFEST[kind];
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

/**
 * Validate a user-typed absolute directory as a local preset/extension
 * source. Resolves with `{ kind, id, name, version, path }` (the canonical,
 * realpath'd directory) or throws an `Error` with an explicit, user-facing
 * message describing exactly what failed.
 *
 * `kind` may be an explicit `"presets"` / `"extensions"` (checks only that
 * manifest, preserving every existing error message verbatim), or omitted /
 * `null` / `""` / `"auto"` to auto-detect the kind from whichever manifest
 * file (`preset.yml` or `extension.yml`) is present in the directory.
 */
export async function validateLocalSource(kind, rawPath) {
    const auto = kind === undefined || kind === null || kind === "" || kind === "auto";
    if (!auto && !MANIFEST[kind]) {
        throw new Error("Local development only supports presets and extensions.");
    }
    const canonical = await resolveCanonicalPath(rawPath);
    const resolvedKind = auto ? await detectLocalKind(canonical) : kind;
    return validateManifest(resolvedKind, canonical);
}
