import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Script } from "node:vm";
import { fingerprint } from "./handoff.mjs";
import { validControlContract } from "./control-contract.mjs";
import { specifySpawnOptions } from "../speckit-wizard-canvas/env/specify-invocation.mjs";

export const PAGE_NAME = "^[a-z][a-z0-9-]{0,79}$";
const REQUIRED_PAGES = ["designer-essentials", "designer-artifacts",
    "designer-appearance"];
const FILE_LIMIT = 256 * 1024;
const MODEL_LIMIT = 2 * 1024 * 1024;
const PAGE_PATTERN = new RegExp(PAGE_NAME);
const contractKeys = (document) => Object.keys(document).filter((key) => key !== "$schema");
function schemaMetadata(document, name) {
    if (document && typeof document === "object"
        && Object.hasOwn(document, "$schema") && typeof document.$schema !== "string") {
        throw new Error(`${name}: invalid $schema reference`);
    }
}
// The generated shell uses "workflow" for its built-in page navigation.
const RESERVED_GENERATED_PAGE_ID = "workflow";
export const isWindowsDeviceName = (name) =>
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
const ERROR_LIMIT = 512;
class PageContentError extends Error {}
class ContributionCollisionError extends Error {}
const RULES = {
    "canvas.id": { type: "string", minLength: 1, maxLength: 100,
        pattern: "^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9][a-z0-9-]*$",
        required: true },
    "canvas.displayName": { type: "string", minLength: 1, maxLength: 120, required: true },
    "canvas.description": { type: "string", maxLength: 240 },
    "canvas.workflowListName": { type: "string", maxLength: 80 },
    "workflowSlug.userProvided": { type: "boolean" },
};
const RESERVED_CANVAS_IDS = ["speckit-canvas-designer", "speckit-wizard", "speckit-canvas-generator"];
function resolvedField(field, rule) {
    return { ...field, validation: { ...rule,
        ...(field.id === "canvas.id" ? { forbiddenValues: RESERVED_CANVAS_IDS } : {}) } };
}

function inside(root, path) {
    const rel = relative(root, path);
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function boundedJson(path, root, limit, openFile = open, parse = true) {
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
        try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            if (parse) document = JSON.parse(text);
            else document = text;
        }
        catch (error) {
            throw new PageContentError(`Invalid Designer ${parse ? "JSON" : "UTF-8"} in ${path}: ${error.message}`);
        }
        return { document, ...(parse ? {} : { bytes }), path: target, size: length,
            hash: createHash("sha256").update(bytes).digest("hex") };
    } finally {
        await file.close();
    }
}

export async function readFrozenAsset(item, root) {
    if (await realpath(root) !== root) {
        throw new Error("Designer .specify directory changed since opening");
    }
    const result = await boundedJson(item.path, root, 32 * 1024, open, false);
    if (result.path !== item.path || await realpath(dirname(item.path)) !== dirname(item.path)
        || await realpath(root) !== root || result.hash !== item.hash) {
        throw new Error(`${item.name}: generated asset changed since Designer opened; reopen Designer`);
    }
    return result.bytes;
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
    const fieldOrigins = new Map();
    for (const [index, entry] of entries.entries()) {
        const { name, path, document, hash, error } = entry;
        const fallbackOrder = REQUIRED_PAGES.includes(name)
            ? (REQUIRED_PAGES.indexOf(name) + 1) * 10 : 100001 + index;
        const fail = (reason) => {
            pages.push({ page: name, title: name, order: fallbackOrder,
                error: { name, path, reason: reason.slice(0, ERROR_LIMIT) } });
        };
        if (error) { fail(error); continue; }
        if (document?.enabled === false) continue;
        try {
            checkSchema(document, schema, name);
            if (document.id !== name) throw new Error(`${name}: page id does not match template name`);
            const ids = new Set();
            for (const field of document.fields) {
                const type = field.type ?? "string";
                const scalarControl = type === "boolean" ? "stock.checkbox" : "stock.text";
                if (ids.has(field.id) || (Object.hasOwn(field, "default") && type !== "boolean")
                    || (Object.hasOwn(RULES, field.id) && RULES[field.id].type !== type)
                    || (field.control !== undefined && field.control !== scalarControl)
                    || (field.required !== undefined && (type !== "string" || field.required !== true))) {
                    throw new Error(`${name}: duplicate or invalid field ${field.id}`);
                }
                ids.add(field.id);
                if (fieldOrigins.has(field.id)) {
                    throw new ContributionCollisionError(`${name}: duplicate enabled field ${field.id} also defined by ${fieldOrigins.get(field.id)}`);
                }
            }
            const slotIds = new Set();
            for (const slot of document.slots ?? []) {
                if (!slot || typeof slot !== "object" || Array.isArray(slot)
                    || Object.keys(slot).join() !== "id" || slotIds.has(slot.id)) {
                    throw new Error(`${name}: invalid or duplicate slot ${slot?.id}`);
                }
                slotIds.add(slot.id);
            }
        } catch (cause) {
            if (cause instanceof ContributionCollisionError) throw cause;
            fail(cause.message);
            continue;
        }
        for (const field of document.fields) {
            const type = field.type ?? "string";
            constraints[field.id] = Object.hasOwn(RULES, field.id) ? RULES[field.id]
                : { type, ...(type === "string"
                    ? { maxLength: 1000, ...(field.required ? { required: true } : {}) } : {}) };
            values[field.id] = type === "boolean" ? (field.default ?? false) : "";
            fieldOrigins.set(field.id, name);
        }
        pages.push({ ...document, fields: document.fields.map((field) => resolvedField({
            ...field, control: field.control ?? (field.type === "boolean"
                ? "stock.checkbox" : "stock.text") }, constraints[field.id])),
            page: name, provenance: { template: name, path, fingerprint: hash } });
    }
    pages.sort((a, b) => a.order - b.order || a.page.localeCompare(b.page));
    return { pages, constraints, values, fieldOrigins };
}

function validateContribution(document, name, slots, fieldOrigins) {
    schemaMetadata(document, name);
    const keys = ["schemaVersion", "id", "host", "slot", "order", "field", "requires",
        "generatedBinding"];
    if (!document || typeof document !== "object" || Array.isArray(document)
        || contractKeys(document).some((key) => !keys.includes(key))
        || document.schemaVersion !== 1 || typeof document.id !== "string"
        || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(document.id)
        || document.host !== "designer" || !Number.isInteger(document.order)
        || document.order < -100000 || document.order > 100000
        || typeof document.slot !== "string") {
        throw new Error(`${name}: invalid Canvas Design contribution`);
    }
    const slot = slots.get(document.slot)?.slot;
    if (!slot) {
        throw new Error(`${name}: unknown Designer slot ${document.slot}`);
    }
    const field = document.field;
    if (!field || typeof field !== "object" || Array.isArray(field)
        || Object.keys(field).some((key) =>
            !["id", "label", "description", "type", "default", "control", "maxLength", "required"].includes(key))
        || typeof field.id !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(field.id)
        || typeof field.label !== "string" || !field.label || field.label.length > 120
        || (field.description !== undefined
            && (typeof field.description !== "string" || field.description.length > 1000))
        || !["string", "boolean", "object", "image"].includes(field.type)
        || (Object.hasOwn(RULES, field.id) && RULES[field.id].type !== field.type)
        || (field.type === "object"
            ? !PAGE_PATTERN.test(field.control)
            : field.control !== (field.type === "boolean" ? "stock.checkbox"
                : field.type === "image" ? "stock.image" : "stock.text"))
        || (field.maxLength !== undefined && (field.type !== "string"
            || !Number.isInteger(field.maxLength) || field.maxLength < 1
            || field.maxLength > 1000))
        || (field.required !== undefined && (field.type !== "string" || field.required !== true))
        || (Object.hasOwn(field, "default")
            && (field.type !== "boolean" || typeof field.default !== "boolean"))) {
        throw new Error(`${name}: incompatible field or control definition`);
    }
    if (document.requires !== undefined
        && (!Array.isArray(document.requires)
            || document.requires.length !== 1
            || typeof document.requires[0] !== "string")) {
        throw new Error(`${name}: requires must name exactly one control definition template`);
    }
    const binding = document.generatedBinding;
    if (field.type === "image" && binding === undefined) {
        throw new Error(`${name}: image asset requires a generated placement`);
    }
    if (binding !== undefined
        && (!binding
            || typeof binding !== "object" || Array.isArray(binding)
            || (["object", "image"].includes(field.type)
                ? (field.type === "image"
                    ? Object.keys(binding).sort().join() !== (binding.page === undefined
                        ? "presentation,slot" : "page,presentation,slot")
                        || (binding.page !== undefined && !PAGE_PATTERN.test(binding.page))
                    : Object.keys(binding).sort().join() !== "presentation,slot")
                    || binding.presentation !== (field.type === "image" ? "asset" : "control")
                    || (field.type === "image"
                        ? binding.page === undefined
                            ? !["header.brand", "workflow.intro"].includes(binding.slot)
                            : typeof binding.slot !== "string"
                                || !/^[a-z][a-z0-9.-]{0,79}$/.test(binding.slot)
                        : binding.slot !== "details.content")
                : field.type !== "string"
                    || !(binding.presentation === "stock.readonly"
                        && Object.keys(binding).every((key) => ["presentation", "section"].includes(key))
                        || binding.presentation === "text"
                        && Object.keys(binding).sort().join() === "presentation,slot"
                        && ((field.id === "canvas.description" && binding.slot === "workflow.description")
                            || (field.id === "canvas.workflowListName" && binding.slot === "workflow.heading"))))
            || (binding.section !== undefined
                && (!binding.section || typeof binding.section !== "object"
                    || Array.isArray(binding.section)
                    || Object.keys(binding.section).sort().join() !== "id,title"
                    || typeof binding.section.id !== "string"
                    || !/^[a-z][a-z0-9.-]{0,79}$/.test(binding.section.id)
                    || typeof binding.section.title !== "string"
                    || !binding.section.title.trim() || binding.section.title.length > 120)))) {
        throw new Error(`${name}: incompatible generated binding`);
    }
    if (fieldOrigins.has(field.id)) {
        throw new Error(`${name}: duplicate field ${field.id} also defined by ${fieldOrigins.get(field.id)}`);
    }
    fieldOrigins.set(field.id, name);
}

function validateControl(document, name) {
    schemaMetadata(document, name);
    const properties = document?.value?.properties;
    const image = document?.value?.type === "image";
    const scalar = document?.value?.type === "string"
        || document?.value?.type === "boolean";
    const checkbox = document?.id === "stock.checkbox";
    if (!document || typeof document !== "object" || Array.isArray(document)
        || contractKeys(document).sort().join() !== "adapters,id,schemaVersion,value"
        || document.schemaVersion !== 1
        || (image ? document.id !== "stock.image"
            : scalar ? document.id !== (checkbox ? "stock.checkbox" : "stock.text")
                : !PAGE_PATTERN.test(document.id) || isWindowsDeviceName(document.id))
        || !document.value || (image
            ? Object.keys(document.value).sort().join() !== "maxBytes,mimeTypes,type"
                || document.value.maxBytes !== 32 * 1024
                || JSON.stringify(document.value.mimeTypes)
                    !== '["image/png","image/jpeg","image/gif","image/webp"]'
            : scalar
                ? Object.keys(document.value).sort().join() !== "type"
                    || document.value.type !== (checkbox ? "boolean" : "string")
                : !validControlContract(document.value))
        || !document.adapters || Object.keys(document.adapters).sort().join() !== "designer,generated"
            && !(checkbox && Object.keys(document.adapters).sort().join() === "designer")
        || !PAGE_PATTERN.test(document.adapters.designer)
        || (!checkbox && !PAGE_PATTERN.test(document.adapters.generated))) {
        throw new Error(`${name}: invalid shared control value contract or adapter references`);
    }
}

function validateGeneratedPage(document, name) {
    schemaMetadata(document, name);
    if (!document || typeof document !== "object" || Array.isArray(document)
        || contractKeys(document).some((key) => !["id", "renderer", "schemaVersion", "title", "order", "values", "slots"].includes(key))
        || document.schemaVersion !== 1 || document.id !== name
        || document.id === RESERVED_GENERATED_PAGE_ID || isWindowsDeviceName(document.id)
        || typeof document.title !== "string" || !document.title.trim()
        || (document.order !== undefined && (!Number.isInteger(document.order)
            || document.order < -100000 || document.order > 100000))
        || document.title.length > 120 || typeof document.renderer !== "string"
        || !PAGE_PATTERN.test(document.renderer)
        || isWindowsDeviceName(document.renderer)
        || (document.values !== undefined && (!Array.isArray(document.values)
            || document.values.length > 100 || new Set(document.values).size !== document.values.length
            || document.values.some((id) => typeof id !== "string"
                || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(id))))
        || (document.slots !== undefined && (!Array.isArray(document.slots)
            || document.slots.length > 30
            || new Set(document.slots.map((slot) => slot?.id)).size !== document.slots.length
            || document.slots.some((slot) => !slot || typeof slot !== "object"
                || Array.isArray(slot) || Object.keys(slot).join() !== "id"
                || typeof slot.id !== "string" || !/^[a-z][a-z0-9.-]{0,79}$/.test(slot.id)
                || slot.id === "workflow.phases")))) {
        throw new Error(`${name}: invalid generated page definition`);
    }
}

function validateWorkflowPage(document, name) {
    schemaMetadata(document, name);
    if (!document || typeof document !== "object" || Array.isArray(document)
        || contractKeys(document).sort().join() !== "id,order,schemaVersion,slots,title"
        || document.schemaVersion !== 1 || document.id !== "workflow" || name !== "generated-workflow"
        || typeof document.title !== "string" || !document.title.trim()
        || document.title.length > 120 || document.order !== 0
        || !Array.isArray(document.slots) || document.slots.length < 1 || document.slots.length > 30
        || document.slots[0]?.id !== "workflow.phases"
        || new Set(document.slots.map((slot) => slot?.id)).size !== document.slots.length
        || document.slots.some((slot) => !slot || typeof slot !== "object"
            || Array.isArray(slot) || Object.keys(slot).join() !== "id"
            || typeof slot.id !== "string" || !/^[a-z][a-z0-9.-]{0,79}$/.test(slot.id))) {
        throw new Error(`${name}: invalid Workflow page definition`);
    }
}

function validatePhasePlacement(document, name) {
    schemaMetadata(document, name);
    if (!document || typeof document !== "object" || Array.isArray(document)
        || contractKeys(document).sort().join() !== "control,id,page,schemaVersion,slot"
        || document.schemaVersion !== 1 || document.id !== "generated-phase-placement"
        || document.page !== "workflow" || document.slot !== "workflow.phases"
        || document.control !== "generated-phase-control") {
        throw new Error(`${name}: invalid phase control placement`);
    }
}

function validateFieldPlacement(document, name) {
    schemaMetadata(document, name);
    if (!document || typeof document !== "object" || Array.isArray(document)
        || contractKeys(document).some((key) =>
            !["schemaVersion", "id", "page", "slot", "field", "order", "control"].includes(key))
        || document.schemaVersion !== 1 || document.id !== name
        || typeof document.page !== "string" || !PAGE_PATTERN.test(document.page)
        || typeof document.slot !== "string" || !/^[a-z][a-z0-9.-]{0,79}$/.test(document.slot)
        || document.slot === "workflow.phases"
        || typeof document.field !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(document.field)
        || !Number.isInteger(document.order) || document.order < -100000 || document.order > 100000
        || (document.control !== undefined && (typeof document.control !== "string"
            || !/^[a-z][a-z0-9.-]{0,79}$/.test(document.control)))) {
        throw new Error(`${name}: invalid generated field placement`);
    }
}

function validatePhaseControl(document, name) {
    schemaMetadata(document, name);
    if (!document || typeof document !== "object" || Array.isArray(document)
        || contractKeys(document).sort().join() !== "adapter,id,schemaVersion"
        || document.schemaVersion !== 1 || document.id !== "workflow-phases"
        || typeof document.adapter !== "string" || !PAGE_PATTERN.test(document.adapter)
        || isWindowsDeviceName(document.adapter)) {
        throw new Error(`${name}: invalid phase control definition`);
    }
}

function validateValueSource(document, name, fieldOrigins) {
    schemaMetadata(document, name);
    const schema = document?.schema;
    const source = document?.source;
    const section = document?.section;
    if (!document || typeof document !== "object" || Array.isArray(document)
        || contractKeys(document).some((key) => !["schemaVersion", "id", "label", "schema",
            "source", "presentation", "section"].includes(key))
        || document.schemaVersion !== 1
        || typeof document.id !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(document.id)
        || typeof document.label !== "string" || !document.label.trim() || document.label.length > 120
        || !schema || typeof schema !== "object" || Array.isArray(schema)
        || !(schema.type === "string"
            && Object.keys(schema).every((key) => ["type", "maxLength"].includes(key))
            && Number.isInteger(schema.maxLength) && schema.maxLength >= 1 && schema.maxLength <= 1000
            || schema.type === "boolean" && Object.keys(schema).sort().join() === "type"
            || schema.type === "object" && Object.keys(schema).sort().join() === "properties,type"
                && schema.properties && typeof schema.properties === "object"
                && !Array.isArray(schema.properties)
                && Object.keys(schema.properties).length >= 1 && Object.keys(schema.properties).length <= 10
                && Object.entries(schema.properties).every(([key, allowed]) =>
                    /^[a-z][A-Za-z0-9]{0,39}$/.test(key)
                    && Array.isArray(allowed) && allowed.length >= 1 && allowed.length <= 20
                    && new Set(allowed).size === allowed.length
                    && allowed.every((value) => typeof value === "string" && value.length >= 1 && value.length <= 80)))
        || !source || typeof source !== "object" || Array.isArray(source)
        || !(source.kind === "constant" && Object.keys(source).sort().join() === "kind,value"
            || source.kind === "computed" && Object.keys(source).sort().join() === "kind,module"
                && PAGE_PATTERN.test(source.module) && !isWindowsDeviceName(source.module))
        || !["stock.readonly", "stock.editable", "processing-only"].includes(document.presentation)
        || (source.kind === "computed" && document.presentation === "stock.editable")
        || (section !== undefined && (!section || typeof section !== "object"
            || Object.keys(section).sort().join() !== "id,title"
            || typeof section.id !== "string" || !/^[a-z][a-z0-9.-]{0,79}$/.test(section.id)
            || typeof section.title !== "string" || !section.title.trim() || section.title.length > 120))) {
        throw new Error(`${name}: invalid Canvas Design value source`);
    }
    if (source.kind === "constant") {
        const value = source.value;
        if (schema.type === "string" && (typeof value !== "string" || value.length > schema.maxLength)
            || schema.type === "boolean" && typeof value !== "boolean"
            || schema.type === "object" && (!value || typeof value !== "object" || Array.isArray(value)
                || Object.keys(value).sort().join() !== Object.keys(schema.properties).sort().join()
                || Object.entries(schema.properties).some(([key, allowed]) => !allowed.includes(value[key])))) {
            throw new Error(`${name}: invalid typed constant value`);
        }
    }
    if (fieldOrigins.has(document.id)) {
        throw new Error(`${name}: duplicate field ${document.id} also defined by ${fieldOrigins.get(document.id)}`);
    }
    fieldOrigins.set(document.id, name);
}

async function executableRegistration(project, name) {
    const options = await specifySpawnOptions(project, { encoding: "utf8", maxBuffer: 128 * 1024 });
    const result = spawnSync("specify", ["artifact", "info", `template:${name}`, "--json"],
        options);
    if (result.error || result.status !== 0) {
        throw new Error(`${name}: cannot verify replace-only Specify template registration: ${result.stderr || result.error || result.stdout}`);
    }
    try {
        const info = JSON.parse(result.stdout);
        const script = spawnSync("specify", ["artifact", "info", `script:${name}`, "--json"],
            options);
        if (script.error || ![0, 1].includes(script.status)) {
            throw new Error(`${name}: cannot verify native script registration: ${script.stderr || script.error}`);
        }
        const scriptInfo = JSON.parse(script.stdout || script.stderr);
        if (script.status === 1 && scriptInfo.error !== `unknown artifact script:${name}`) {
            throw new Error(`${name}: cannot verify native script registration: ${scriptInfo.error || script.stderr}`);
        }
        if (script.status === 0 && scriptInfo.kind !== "script") {
            throw new Error(`${name}: unexpected native script registration metadata`);
        }
        if (scriptInfo.kind === "script") {
            throw new Error(`${name}: native Specify script registrations are not supported for executable adapters/renderers`);
        }
        return info;
    }
    catch (error) {
        if (error.message.startsWith(`${name}:`)) throw error;
        throw new Error(`${name}: invalid Specify registration metadata`, { cause: error });
    }
}

async function loadTemplates(templates, pageEntries, pageNames, fieldOrigins, specify, remainingBytes,
    registration) {
    if (!Array.isArray(templates) || templates.length > 100) {
        throw new Error("Invalid Canvas Design template inventory");
    }
    if (templates.filter((item) => item?.kind === "generated.added-page-definition").length > 30) {
        throw new Error("Designer supports at most 30 generated pages");
    }
    const names = new Set(pageNames);
    const loaded = [];
    const slots = new Map();
    for (const page of pageEntries.filter((entry) => !entry.error)) {
        for (const slot of page.slots ?? []) {
            if (slots.has(slot.id)) {
                throw new Error(`${page.page}: duplicate Designer slot ${slot.id} also defined by ${slots.get(slot.id).page.page}`);
            }
            slots.set(slot.id, { page, slot });
        }
    }
    const ids = new Set();
    let size = 0;
    for (const item of templates) {
        if (!item || typeof item !== "object" || Array.isArray(item)
            || Object.keys(item).some((key) => !["name", "path", "sourceId", "kind", "strategy"].includes(key))
            || typeof item.name !== "string" || !PAGE_PATTERN.test(item.name)
            || isWindowsDeviceName(item.name)
            || names.has(item.name) || typeof item.path !== "string"
            || !item.path || item.path.length > 4096 || /[\x00-\x1f\x7f]/.test(item.path)
            || typeof item.sourceId !== "string"
            || !/^[A-Za-z0-9_.:-]{1,160}$/.test(item.sourceId)
            || !["designer.setting-definition", "generated.added-page-definition", "generated.added-page-renderer",
                "generated.workflow-page-definition", "generated.phase-control-definition",
                "generated.phase-control-adapter", "generated.phase-control-placement",
                "generated.field-placement",
                "shared.control-definition", "designer.control-adapter", "generated.control-adapter",
                "generated.value-definition", "generated.computed-value-provider"].includes(item.kind)
            || item.strategy !== "replace") {
            throw new Error(`Invalid or duplicate Canvas Design template: ${item?.name ?? ""}`);
        }
        names.add(item.name);
        const path = resolve(dirname(specify), item.path);
        const extension = extname(path).toLowerCase();
        const executable = ["generated.added-page-renderer", "generated.phase-control-adapter",
            "designer.control-adapter", "generated.control-adapter",
            "generated.computed-value-provider"].includes(item.kind);
        const expected = executable ? ".mjs" : ".json";
        if (!inside(specify, path) || extension !== expected) {
            throw new Error(`${item.name}: ${item.kind} must be a ${expected} replace-only template inside .specify`);
        }
        const { document, hash, size: bytes } = await boundedJson(
            path, specify, FILE_LIMIT, open, !executable);
        size += bytes;
        if (size > remainingBytes) throw new Error("Designer template inventory exceeds its size limit");
        if (item.kind === "designer.setting-definition") {
            validateContribution(document, item.name, slots, fieldOrigins);
            if (ids.has(document.id)) throw new Error(`${item.name}: duplicate contribution item ${document.id}`);
            ids.add(document.id);
        } else if (item.kind === "generated.value-definition") {
            validateValueSource(document, item.name, fieldOrigins);
        }
        if (item.kind !== "designer.setting-definition") {
            const info = await registration(dirname(specify), item.name);
            const layers = info?.stack;
            const winner = layers?.find((layer) => layer.active);
            const sourceLayer = item.sourceId === "project" ? "project"
                : item.sourceId.startsWith("extension:") ? "extension" : "preset";
            const sourceId = sourceLayer === "project" ? "_"
                : sourceLayer === "extension" ? item.sourceId.slice("extension:".length) : item.sourceId;
            if (info.kind !== "template" || !Array.isArray(layers) || !layers.length
                || layers.some((layer) => layer.strategy !== "replace")
                || !winner || winner.sourceId !== sourceId || winner.layer !== sourceLayer) {
                throw new Error(`${item.name}: generated asset registration must be a replace-only Specify template from ${item.sourceId}`);
            }
            if (item.kind === "generated.added-page-definition") {
                validateGeneratedPage(document, item.name);
                if (bytes > 32 * 1024) throw new Error(`${item.name}: generated page definition exceeds 32 KiB`);
            } else if (item.kind === "generated.workflow-page-definition") {
                validateWorkflowPage(document, item.name);
                if (bytes > 32 * 1024) throw new Error(`${item.name}: Workflow page definition exceeds 32 KiB`);
            } else if (item.kind === "generated.phase-control-definition") {
                validatePhaseControl(document, item.name);
                if (bytes > 32 * 1024) throw new Error(`${item.name}: phase control definition exceeds 32 KiB`);
            } else if (item.kind === "generated.phase-control-placement") {
                validatePhasePlacement(document, item.name);
                if (bytes > 32 * 1024) throw new Error(`${item.name}: phase placement exceeds 32 KiB`);
            } else if (item.kind === "generated.field-placement") {
                validateFieldPlacement(document, item.name);
                if (bytes > 32 * 1024) throw new Error(`${item.name}: field placement exceeds 32 KiB`);
            } else if (item.kind === "shared.control-definition") {
                validateControl(document, item.name);
                if (bytes > 32 * 1024) throw new Error(`${item.name}: control definition exceeds 32 KiB`);
            } else if (item.kind === "generated.value-definition") {
                if (bytes > 32 * 1024) throw new Error(`${item.name}: value definition exceeds 32 KiB`);
            } else {
                if (bytes > 32 * 1024) throw new Error(`${item.name}: executable module exceeds 32 KiB`);
                const { init, parse } = await import("es-module-lexer/minimal");
                await init();
                let imports, exports;
                try {
                    [imports, exports] = parse(document);
                } catch (error) {
                    throw new Error(`${item.name}: invalid ${item.kind === "generated.added-page-renderer"
                        ? "generated renderer" : item.kind}: ${error.message}`, { cause: error });
                }
                if (imports.some((entry) => entry.d !== -2)) {
                    throw new Error(`${item.name}: ${item.kind === "generated.added-page-renderer"
                        ? "generated renderer" : item.kind === "generated.computed-value-provider"
                            ? "computed value provider" : "control adapter"} must be self-contained; module imports are not packaged`);
                }
                const requiredExport = item.kind === "generated.added-page-renderer" ? "renderPage"
                    : item.kind === "generated.phase-control-adapter" ? "mount"
                    : item.kind === "generated.computed-value-provider" ? "provideValue" : "mount";
                const check = spawnSync("node", ["--check", "--input-type=module"],
                    { input: document, encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024 });
                if (check.error || check.status !== 0) {
                    throw new Error(`${item.name}: invalid ${item.kind === "generated.added-page-renderer"
                        ? "generated renderer" : item.kind}: ${check.stderr || check.error || "module validation failed"}`);
                }
                if (!exports.some((entry) => entry.n === requiredExport)) {
                    throw new Error(`${item.name}: invalid ${item.kind === "generated.added-page-renderer"
                        ? "generated renderer" : item.kind}: missing ${requiredExport} export`);
                }
                if (item.kind === "generated.phase-control-adapter"
                    && (!exports.some((entry) => entry.n === "controlId")
                        || !exports.some((entry) => entry.n === "contractVersion"))) {
                    throw new Error(`${item.name}: phase control adapter is missing controlId or contractVersion export`);
                }
                if (item.kind === "designer.control-adapter"
                    && !exports.some((entry) => entry.n === "validate")) {
                    throw new Error(`${item.name}: Designer adapter is missing validate export`);
                }
                if (item.kind === "generated.computed-value-provider") {
                    const declarations = [...document.matchAll(/(^|\n)\s*export\s+(?:(?:async\s+)?function|const)\s+provideValue\b/g)];
                    if (exports.length !== 1 || declarations.length !== 1
                        || declarations[0].index + declarations[0][0].lastIndexOf("provideValue")
                            !== exports[0].s) {
                        throw new Error(`${item.name}: value provider must use a direct export function provideValue or export const provideValue declaration; named re-exports are not supported`);
                    }
                    const body = document.replace(
                        /(^|\n)\s*export\s+(?=(?:async\s+)?function\s+provideValue\b|const\s+provideValue\b)/g, "$1");
                    try {
                        new Script(`"use strict"; const workflow = null;\nconst provide = (() => {\n${body}\n`
                            + "return provideValue;\n})();\n"
                            + "if (typeof provide !== 'function') throw new Error('provideValue must be a function');\n"
                            + "const result = provide({ workflow });\n"
                            + "if (result && typeof result.then === 'function') throw new Error('Async providers are not supported');\n"
                            + "JSON.stringify(result);");
                    } catch (error) {
                        throw new Error(`${item.name}: value provider cannot run as a generated script: ${error.message}`,
                            { cause: error });
                    }
                }
            }
        }
        loaded.push({ ...item, path, hash, ...(document === undefined ? {} : { document }) });
    }
    for (const entry of loaded.filter((item) => item.kind === "generated.added-page-definition")) {
        const renderer = loaded.find((item) => item.name === entry.document.renderer);
        if (!renderer || renderer.kind !== "generated.added-page-renderer") {
            throw new Error(`${entry.name}: missing generated renderer ${entry.document.renderer}`);
        }
    }
    for (const entry of loaded.filter((item) => item.kind === "generated.added-page-renderer")) {
        const uses = loaded.filter((item) => item.kind === "generated.added-page-definition"
            && item.document.renderer === entry.name);
        if (uses.length !== 1) {
            throw new Error(`${entry.name}: generated renderer must belong to exactly one page`);
        }
    }
    const workflowPages = loaded.filter((item) => item.kind === "generated.workflow-page-definition");
    if (workflowPages.length !== 1) throw new Error("Exactly one generated Workflow page definition is required");
    const phasePlacements = loaded.filter((item) => item.kind === "generated.phase-control-placement");
    if (phasePlacements.length !== 1 || phasePlacements[0].name !== "generated-phase-placement") {
        throw new Error("Exactly one generated phase placement is required");
    }
    const phaseControls = loaded.filter((item) => item.kind === "generated.phase-control-definition");
    if (phaseControls.length !== 1 || phaseControls[0].name !== phasePlacements[0].document.control) {
        throw new Error(`${workflowPages[0].name}: missing or unreferenced phase control definition`);
    }
    const phaseAdapters = loaded.filter((item) => item.kind === "generated.phase-control-adapter");
    if (phaseAdapters.length !== 1 || phaseAdapters[0].name !== phaseControls[0].document.adapter) {
        throw new Error(`${phaseControls[0].name}: missing or unreferenced phase control adapter`);
    }
    const sources = loaded.filter((entry) => entry.kind === "generated.value-definition");
    const addedPages = loaded.filter((entry) => entry.kind === "generated.added-page-definition");
    const fieldPlacements = loaded.filter((entry) => entry.kind === "generated.field-placement");
    const placed = new Set();
    const placementIds = new Set();
    const placementControls = new Map();
    for (const entry of fieldPlacements) {
        const { page: pageId, slot, field: fieldId, control: controlId } = entry.document;
        if (placementIds.has(entry.document.id)) {
            throw new Error(`${entry.name}: duplicate generated field placement ID ${entry.document.id}`);
        }
        placementIds.add(entry.document.id);
        const page = pageId === "workflow" ? workflowPages[0]
            : addedPages.find((candidate) => candidate.document.id === pageId);
        if (!page?.document.slots?.some((candidate) => candidate.id === slot)) {
            throw new Error(`${entry.name}: unknown generated page slot ${pageId}.${slot}`);
        }
        const key = `${pageId}:${slot}:${fieldId}`;
        if (placed.has(key)) throw new Error(`${entry.name}: duplicate generated field placement ${key}`);
        placed.add(key);
        const setting = loaded.find((candidate) =>
            candidate.kind === "designer.setting-definition" && candidate.document.field.id === fieldId);
        const baseField = pageEntries.filter((candidate) => !candidate.error)
            .flatMap((candidate) => candidate.fields ?? []).find((candidate) => candidate.id === fieldId);
        const value = sources.find((candidate) => candidate.document.id === fieldId);
        if (!setting && !baseField && !value) {
            throw new Error(`${entry.name}: missing generated field ${fieldId}`);
        }
        if (value?.document.presentation === "processing-only") {
            throw new Error(`${entry.name}: processing-only value cannot be placed`);
        }
        const field = setting?.document.field ?? baseField;
        const type = field ? field.type ?? "string" : value.document.schema.type;
        const requiredControl = controlId ?? field?.control
            ?? (type === "string" ? "stock.text" : type === "boolean" ? "stock.checkbox"
                : type === "image" ? "stock.image" : undefined);
        if (!requiredControl || type === "object" && !controlId
            || field && controlId && controlId !== field.control) {
            throw new Error(`${entry.name}: incompatible generated field control`);
        }
        const shared = loaded.find((candidate) => candidate.kind === "shared.control-definition"
            && candidate.document.id === requiredControl);
        if (!shared || shared.document.value.type !== type
            || type === "object" && !field
                && !isDeepStrictEqual(shared.document.value.properties, value.document.schema.properties)
            || requiredControl !== "stock.checkbox" && !shared.document.adapters.generated) {
            throw new Error(`${entry.name}: missing or incompatible shared generated control`);
        }
        placementControls.set(entry.name, requiredControl);
    }
    for (const entry of sources) {
        const module = entry.document.source.kind === "computed" && entry.document.source.module;
        if (module && !loaded.some((item) => item.name === module && item.kind === "generated.computed-value-provider")) {
            throw new Error(`${entry.name}: missing registered value provider ${module}`);
        }
    }
    for (const entry of loaded.filter((item) => item.kind === "generated.computed-value-provider")) {
        if (!sources.some((source) => source.document.source.module === entry.name)) {
            throw new Error(`${entry.name}: unreferenced value provider`);
        }
    }
    const generatedIds = new Set([
        ...sources.map((entry) => entry.document.id),
        ...loaded.filter((entry) => entry.kind === "designer.setting-definition"
            && entry.document.generatedBinding?.presentation === "stock.readonly")
            .map((entry) => entry.document.field.id),
    ]);
    for (const page of loaded.filter((entry) => entry.kind === "generated.added-page-definition")) {
        for (const id of page.document.values ?? []) {
            if (!generatedIds.has(id)) throw new Error(`${page.name}: undeclared generated value ${id}`);
        }
    }
    const occupiedAssetSlots = new Set();
    for (const entry of loaded.filter((item) => item.kind === "designer.setting-definition"
        && item.document.generatedBinding?.presentation === "asset")) {
        const binding = entry.document.generatedBinding;
        if (binding.page) {
            const page = loaded.find((item) => item.kind === "generated.added-page-definition"
                && item.document.id === binding.page);
            if (!page?.document.slots?.some((slot) => slot.id === binding.slot)) {
                throw new Error(`${entry.name}: unknown generated page asset slot ${binding.page}.${binding.slot}`);
            }
        }
        const key = `${binding.page ?? "workflow"}:${binding.slot}`;
        if (occupiedAssetSlots.has(key)) {
            throw new Error(`${entry.name}: duplicate generated asset slot ${key}`);
        }
        occupiedAssetSlots.add(key);
    }
    for (const entry of fieldPlacements) {
        const { page, slot } = entry.document;
        if (occupiedAssetSlots.has(`${page}:${slot}`)) {
            throw new Error(`${entry.name}: generated field slot is reserved for an image asset`);
        }
    }
    const occupiedTextSlots = new Set();
    for (const entry of loaded.filter((item) => item.kind === "designer.setting-definition"
        && item.document.generatedBinding?.presentation === "text")) {
        const slot = entry.document.generatedBinding.slot;
        if (occupiedTextSlots.has(slot)) {
            throw new Error(`${entry.name}: duplicate generated text slot ${slot}`);
        }
        occupiedTextSlots.add(slot);
    }
    const controls = loaded.filter((entry) => entry.kind === "shared.control-definition");
    const adapterOwners = new Map();
    for (const control of controls) {
        const fields = loaded.filter((entry) => entry.kind === "designer.setting-definition"
            && entry.document.field.control === control.document.id);
        const pageFields = pageEntries.filter((page) => !page.error)
            .flatMap((page) => page.fields ?? [])
            .filter((field) => field.control === control.document.id);
        const placedFields = fieldPlacements.filter((entry) =>
            entry.document.control === control.document.id);
        if ((!fields.length && !pageFields.length && !placedFields.length
            && !["stock.text", "stock.checkbox"].includes(control.document.id))
            || controls.some((other) => other !== control
            && other.document.id === control.document.id)) {
            throw new Error(`${control.name}: unreferenced or duplicate control definition`);
        }
        for (const [host, name] of Object.entries(control.document.adapters)) {
            const kind = host === "designer" ? "designer.control-adapter"
                : "generated.control-adapter";
            const adapter = loaded.find((item) => item.name === name);
            if (!adapter || adapter.kind !== kind) {
                throw new Error(`${control.name}: missing ${host} adapter ${name}`);
            }
            const owner = adapterOwners.get(adapter.name);
            if (owner) {
                throw new Error(`${adapter.name}: ${host} adapter belongs to both ${owner} and ${control.document.id}`);
            }
            adapterOwners.set(adapter.name, control.document.id);
        }
        for (const field of fields) {
            if (field.document.field.type !== control.document.value.type
                || (["object", "image"].includes(field.document.field.type)
                    && !field.document.generatedBinding)
                || (field.document.generatedBinding?.presentation === "control"
                    && !control.document.adapters.generated)) {
                throw new Error(`${field.name}: incompatible shared control value or generated placement`);
            }
        }
    }
    for (const entry of loaded.filter((item) => ["designer.control-adapter", "generated.control-adapter"].includes(item.kind))) {
        if (!controls.some((control) => Object.values(control.document.adapters).includes(entry.name))) {
            throw new Error(`${entry.name}: unreferenced control adapter`);
        }
    }
    for (const entry of loaded.filter((item) => item.kind === "designer.setting-definition")) {
        const { field, requires } = entry.document;
        const control = controls.find((item) => item.document.id === field.control);
        if (!control || control.document.id !== field.control
            || control.document.value.type !== field.type
            || (requires && control.name !== requires[0])) {
            throw new Error(`${entry.name}: missing or incompatible shared control definition`);
        }
    }
    for (const page of pageEntries.filter((entry) => !entry.error)) {
        for (const field of page.fields ?? []) {
            if (!controls.some((control) => control.document.id === field.control
                && control.document.value.type === (field.type ?? "string"))) {
                throw new Error(`${page.page}: missing shared control definition for ${field.id}`);
            }
        }
    }
    const ordered = loaded.filter((entry) => entry.kind === "designer.setting-definition");
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    ordered.sort((a, b) => a.document.order - b.document.order
        || compare(a.sourceId.split(":").at(-1), b.sourceId.split(":").at(-1))
        || compare(a.document.id, b.document.id));
    const sections = new Map();
    for (const entry of [...ordered, ...sources]) {
        const section = entry.kind === "generated.value-definition"
            ? entry.document.section : entry.document.generatedBinding?.section;
        if (!section) continue;
        if (sections.has(section.id) && sections.get(section.id) !== section.title) {
            throw new Error(`${entry.name}: conflicting generated section ${section.id}`);
        }
        sections.set(section.id, section.title);
    }
    return { loaded, ordered, controls, placementControls };
}

async function context(project) {
    const checkout = await realpath(project);
    const specify = join(checkout, ".specify");
    if (await realpath(specify) !== specify) throw new Error("Designer .specify directory escapes the project");
    const schemaPath = join(specify, "extensions", "extension-canvas-design", "schemas",
        "designer.tab-definition.schema.json");
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
        checkSchema({ schemaVersion: 1, id: "designer-essentials", title: "Essentials",
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

export async function loadResolvedDesignerPages(handoff, project, input, templates = [],
    registration = executableRegistration) {
    const { checkout, schema } = await context(project);
    if (!Array.isArray(input) || !input.length || input.length > 100) {
        throw new Error("Designer requires between 1 and 100 resolved page paths");
    }
    const specify = join(checkout, ".specify");
    if (await realpath(specify) !== specify) throw new Error("Designer .specify directory escapes the project");
    const names = new Set();
    const paths = input.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)
            || Object.keys(item).some((key) => !["name", "path", "kind", "strategy"].includes(key))
            || typeof item.name !== "string" || !PAGE_PATTERN.test(item.name)
            || item.kind !== "designer.tab-definition"
            || item.strategy !== "replace"
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
        throw new Error("Designer load must include all three Canvas Design pages");
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
    const { fieldOrigins, ...model } = buildModel(entries, schema);
    const { loaded, ordered, controls, placementControls } = await loadTemplates(
        templates, model.pages, names, fieldOrigins, specify, MODEL_LIMIT - size - 8192, registration);
    model.contributions = ordered.map(({ name, sourceId, document }) =>
        ({ name, sourceId, ...document }));
    model.generatedPages = loaded.filter((entry) => entry.kind === "generated.added-page-definition")
        .map(({ name, document }) => ({ name, ...document }));
    const workflowPage = loaded.find((entry) => entry.kind === "generated.workflow-page-definition");
    model.workflowPage = { name: workflowPage.name, ...workflowPage.document };
    const phasePlacement = loaded.find((entry) => entry.kind === "generated.phase-control-placement");
    model.phasePlacement = { name: phasePlacement.name, ...phasePlacement.document };
    model.fieldPlacements = loaded.filter((entry) => entry.kind === "generated.field-placement")
        .map(({ name, sourceId, document }) =>
            ({ name, sourceId, ...document, control: placementControls.get(name) }))
        .sort((a, b) => a.order - b.order || a.sourceId.localeCompare(b.sourceId)
            || a.id.localeCompare(b.id));
    model.valueSources = loaded.filter((entry) => entry.kind === "generated.value-definition")
        .map(({ name, sourceId, document }) => ({ name, sourceId, ...document }));
    model.controls = controls.map(({ name, document }) => ({ ...document, template: name }));
    model.adapters = Object.fromEntries(controls.map(({ document }) =>
        [document.id, document.adapters.designer]));
    for (const page of model.pages) {
        if (page.error) continue;
        for (const slot of page.slots ?? []) {
            for (const { document } of ordered.filter((entry) => entry.document.slot === slot.id)) {
                if (page.fields.length >= 100) throw new Error(`${page.page}: too many resolved fields`);
                const field = document.field;
                model.constraints[field.id] = Object.hasOwn(RULES, field.id)
                    ? { ...RULES[field.id], ...(field.required ? { required: true } : {}) }
                    : { type: field.type, ...(field.type === "string"
                        ? { maxLength: field.maxLength ?? 1000,
                            ...(field.required ? { required: true } : {}) } : field.type === "object"
                            ? { properties: controls.find((item) =>
                                item.document.id === field.control).document.value.properties }
                            : field.type === "image" ? {
                                maxBytes: controls.find((item) =>
                                    item.document.id === field.control).document.value.maxBytes,
                                mimeTypes: controls.find((item) =>
                                    item.document.id === field.control).document.value.mimeTypes,
                            } : {}) };
                page.fields.push(resolvedField(field, model.constraints[field.id]));
                model.values[field.id] = field.type === "boolean" ? (field.default ?? false)
                    : field.type === "object" ? null : "";
            }
        }
    }
    for (const placement of model.fieldPlacements) {
        const field = model.pages.flatMap((page) => page.fields ?? [])
            .find((entry) => entry.id === placement.field);
        placement.label = field?.label ?? model.valueSources.find((entry) =>
            entry.id === placement.field)?.label;
        if (!placement.label) throw new Error(`${placement.name}: missing resolved field label`);
    }
    model.templates = loaded.map(({ name, path, hash, sourceId, kind, strategy }) =>
        ({ name, path, hash, sourceId, kind, strategy }));
    const result = { ...model, revision: fingerprint({
        handoffId: handoff.handoffId, sourceFingerprint: handoff.sourceFingerprint, checkout, entries,
        templates: loaded,
    }) };
    if (Buffer.byteLength(JSON.stringify(result)) > MODEL_LIMIT) {
        throw new Error("Designer page model exceeds its size limit");
    }
    return result;
}
