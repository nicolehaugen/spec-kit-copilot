import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fingerprint } from "./handoff.mjs";

export const PAGE_NAME = "^[a-z][a-z0-9-]{0,79}$";
const REQUIRED_PAGES = ["canvas-settings-setup", "canvas-settings-artifacts",
    "canvas-settings-appearance", "canvas-settings-results"];
const FILE_LIMIT = 256 * 1024;
const MODEL_LIMIT = 2 * 1024 * 1024;
const PAGE_PATTERN = new RegExp(PAGE_NAME);
const ERROR_LIMIT = 512;
class PageContentError extends Error {}
const RULES = {
    "canvas.id": { type: "string", minLength: 1, maxLength: 100, pattern: "^[a-z0-9][a-z0-9-]*$" },
    "canvas.displayName": { type: "string", minLength: 1, maxLength: 120 },
    "canvas.description": { type: "string", maxLength: 240 },
    "canvas.workflowListName": { type: "string", maxLength: 80 },
    "workflowSlug.userProvided": { type: "boolean" },
};

function inside(root, path) {
    const rel = relative(root, path);
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function boundedJson(path, root, limit, openFile = open) {
    const target = await realpath(path);
    if (!inside(root, target)) throw new Error(`Designer file escapes its allowed directory: ${path}`);
    const file = await openFile(target, constants.O_RDONLY
        | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const before = await file.stat();
        const stat = await lstat(target);
        if (!before.isFile() || !stat.isFile() || stat.isSymbolicLink()
            || stat.dev !== before.dev || stat.ino !== before.ino
            || await realpath(path) !== target || await realpath(target) !== target) {
            throw new Error(`Invalid Designer file: ${path}`);
        }
        if (before.size > limit) throw new PageContentError(`Designer file exceeds its size limit: ${path}`);
        const buffer = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
        }
        const after = await file.stat();
        const current = await lstat(target);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs
            || before.ctimeMs !== after.ctimeMs || current.dev !== before.dev || current.ino !== before.ino
            || await realpath(path) !== target || await realpath(target) !== target) {
            throw new Error(`Designer file changed during loading: ${path}`);
        }
        if (length > limit) throw new PageContentError(`Designer file exceeds its size limit: ${path}`);
        const bytes = buffer.subarray(0, length);
        let document;
        try { document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch (error) { throw new PageContentError(`Invalid Designer JSON in ${path}: ${error.message}`); }
        return { document, path: target, hash: createHash("sha256").update(bytes).digest("hex") };
    } finally {
        await file.close();
    }
}

function checkSchema(value, schema, location) {
    if (Object.hasOwn(schema, "const") && value !== schema.const) {
        throw new Error(`${location}: unsupported schema version`);
    }
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${location}: unsupported value`);
    const type = schema.type;
    const valid = type === undefined || (type === "array" ? Array.isArray(value)
        : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
        : type === "integer" ? Number.isInteger(value) : typeof value === type);
    if (!valid) throw new Error(`${location}: expected ${type}`);
    if (type === "object") {
        for (const key of schema.required ?? []) {
            if (!Object.hasOwn(value, key)) throw new Error(`${location}: missing ${key}`);
        }
        for (const [key, entry] of Object.entries(value)) {
            if (!Object.hasOwn(schema.properties, key)) throw new Error(`${location}: unsupported property ${key}`);
            checkSchema(entry, schema.properties[key], `${location}.${key}`);
        }
    } else if (type === "array") {
        if (value.length > schema.maxItems) throw new Error(`${location}: too many items`);
        value.forEach((item, i) => checkSchema(item, schema.items, `${location}[${i}]`));
    } else if (type === "string") {
        if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? FILE_LIMIT)
            || (schema.pattern && !new RegExp(schema.pattern).test(value))) {
            throw new Error(`${location}: invalid text length or identifier`);
        }
    } else if (type === "integer" && (value < schema.minimum || value > schema.maximum)) {
        throw new Error(`${location}: out of range`);
    }
}

function buildModel(entries, schema) {
    const pages = [], constraints = Object.create(null), values = Object.create(null);
    for (const [index, entry] of entries.entries()) {
        const { name, path, document, hash, error } = entry;
        const fallbackOrder = REQUIRED_PAGES.includes(name)
            ? (REQUIRED_PAGES.indexOf(name) + 1) * 10 : 100001 + index;
        const fail = (reason) => {
            pages.push({ page: name, title: name, order: fallbackOrder,
                error: { name, path, reason: reason.slice(0, ERROR_LIMIT) } });
        };
        if (error) { fail(error); continue; }
        try {
            checkSchema(document, schema, name);
            if (document.id !== name) throw new Error(`${name}: page id does not match template name`);
            const ids = new Set();
            for (const field of document.fields) {
                const type = field.type ?? "string";
                if (ids.has(field.id) || (Object.hasOwn(field, "default") && type !== "boolean")
                    || (Object.hasOwn(RULES, field.id) && RULES[field.id].type !== type)) {
                    throw new Error(`${name}: duplicate or invalid field ${field.id}`);
                }
                ids.add(field.id);
                if (document.enabled !== false && Object.hasOwn(constraints, field.id)) {
                    throw new Error(`${name}: duplicate enabled field ${field.id}`);
                }
            }
        } catch (cause) {
            fail(cause.message);
            continue;
        }
        if (document.enabled === false) continue;
        for (const field of document.fields) {
            const type = field.type ?? "string";
            constraints[field.id] = Object.hasOwn(RULES, field.id) ? RULES[field.id]
                : { type, ...(type === "string" ? { maxLength: 1000 } : {}) };
            values[field.id] = type === "boolean" ? (field.default ?? false) : "";
        }
        pages.push({ ...document, page: name, provenance: { template: name, path, fingerprint: hash } });
    }
    pages.sort((a, b) => a.order - b.order || a.page.localeCompare(b.page));
    return { pages, constraints, values };
}

async function context(project) {
    const checkout = await realpath(project);
    const specify = join(checkout, ".specify");
    if (await realpath(specify) !== specify) throw new Error("Designer .specify directory escapes the project");
    const schemaPath = join(specify, "extensions", "extension-canvas-design", "schemas", "page.schema.json");
    let schema;
    try {
        // Presets replace page content; the installed extension supplies the evolving validation contract.
        ({ document: schema } = await boundedJson(schemaPath, specify, FILE_LIMIT));
        if (schema?.type !== "object" || !Array.isArray(schema.required)
            || !schema.required.includes("fields") || !schema.required.includes("id")
            || schema.properties?.fields?.type !== "array"
            || schema.properties.fields.items?.type !== "object"
            || !schema.properties.fields.items.properties) {
            throw new Error("Invalid shared Designer page schema");
        }
        checkSchema({ schemaVersion: 1, id: "canvas-settings-setup", title: "Essentials",
            order: 10, fields: [{ id: "canvas.id", label: "Canvas ID" }] }, schema, "Designer page schema");
    } catch (error) {
        throw new Error(`Cannot load Canvas Design page schema at ${schemaPath}: ${error.message}. `
            + "Repair or reinstall extension-canvas-design and try again.", { cause: error });
    }
    return { checkout, schema };
}

export async function assertPageCommand(project) {
    const checkout = await realpath(project);
    const registry = await boundedJson(join(checkout, ".specify", "extensions", ".registry"),
        checkout, FILE_LIMIT);
    if (registry.document.extensions?.["extension-canvas-design"]?.enabled !== true) {
        throw new Error("Canvas Design is not enabled; install it through the Spec Kit extension skill");
    }
    const skill = join(checkout, ".github", "skills",
        "speckit-extension-canvas-design-load-page", "SKILL.md");
    const path = await realpath(skill);
    if (!inside(checkout, path) || !(await lstat(path)).isFile()) {
        throw new Error("The generated speckit-extension-canvas-design-load-page skill is unavailable");
    }
}

export async function loadResolvedDesignerPages(handoff, project, input) {
    const { checkout, schema } = await context(project);
    if (!Array.isArray(input) || !input.length || input.length > 100) {
        throw new Error("Designer requires between 1 and 100 resolved page paths");
    }
    const specify = join(checkout, ".specify");
    if (await realpath(specify) !== specify) throw new Error("Designer .specify directory escapes the project");
    const names = new Set();
    const paths = input.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)
            || Object.keys(item).some((key) => !["name", "path"].includes(key))
            || typeof item.name !== "string" || !PAGE_PATTERN.test(item.name)
            || typeof item.path !== "string" || !item.path || item.path.length > 4096
            || /[\x00-\x1f\x7f]/.test(item.path)) throw new Error("Invalid Designer page name/path");
        if (names.has(item.name)) throw new Error(`Invalid or duplicate Designer page name: ${item.name}`);
        names.add(item.name);
        const path = resolve(checkout, item.path);
        if (!inside(specify, path) || extname(path).toLowerCase() !== ".json") {
            throw new Error(`${item.name}: Designer pages must be .json files inside .specify`);
        }
        return { name: item.name, path };
    });
    if (REQUIRED_PAGES.some((name) => !names.has(name))) {
        throw new Error("Designer load must include all four Canvas Design pages");
    }
    const entries = [];
    let size = 0;
    for (const { name, path } of paths) {
        let parent = dirname(path);
        while (true) {
            try {
                const actual = await realpath(parent);
                if (actual !== specify && !inside(specify, actual)) {
                    throw new Error(`${name}: Designer file escapes its allowed directory: ${path}`);
                }
                break;
            } catch (error) {
                if (error.code !== "ENOENT" || parent === specify) throw error;
                parent = dirname(parent);
            }
        }
        let entry;
        try {
            if (extname(await realpath(path)).toLowerCase() !== ".json") {
                throw new Error(`${name}: Designer pages must be .json files; use a local preset for overrides`);
            }
            entry = { name, ...await boundedJson(path, specify, FILE_LIMIT) };
        } catch (error) {
            if (!(error instanceof PageContentError) && error.code !== "ENOENT") throw error;
            entry = { name, path, error: error.code === "ENOENT"
                ? `${name}: resolved page file is missing` : error.message };
        }
        entries.push(entry);
        size += Buffer.byteLength(JSON.stringify(entries.at(-1)));
        if (size > MODEL_LIMIT - 8192) throw new Error("Designer page model exceeds its size limit");
    }
    const model = buildModel(entries, schema);
    return { ...model, revision: fingerprint({
        handoffId: handoff.handoffId, sourceFingerprint: handoff.sourceFingerprint, checkout, entries,
    }) };
}
