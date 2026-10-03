import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const featureRoot = join(packageRoot, "templates", "generated-canvas");
const featureFiles = ["server.mjs", "runtime.mjs", "contract.mjs", "files.mjs",
    "phase-response.mjs",
    "ui/app.js", "ui/markdown.mjs", "ui/page-assets.mjs", "ui/runtime.css", "ui/workflow-theme.css"];
const idPattern = /^[a-z0-9][a-z0-9-]{0,99}$/;
const reserved = new Set(["speckit-canvas-designer", "speckit-wizard", "speckit-canvas-generator"]);
const RESERVED_GENERATED_PAGE_ID = "workflow";
const requestPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REQUEST_LIMIT = 512 * 1024;
const fieldPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;

function validateFrozenValues(values, constraints) {
    if (!values || typeof values !== "object" || Array.isArray(values)
        || !constraints || typeof constraints !== "object" || Array.isArray(constraints)
        || Object.keys(constraints).length > 10000
        || Object.keys(values).length !== Object.keys(constraints).length
        || Object.keys(values).some((id) => !Object.hasOwn(constraints, id))) {
        throw new Error("Invalid frozen Designer fields");
    }
    for (const [id, rule] of Object.entries(constraints)) {
        if (!fieldPattern.test(id) || !rule || typeof rule !== "object"
            || Array.isArray(rule)) throw new Error(`Invalid frozen Designer field: ${id}`);
        const value = values[id];
        if (rule.type === "string") {
            if (Object.keys(rule).some((key) =>
                !["type", "maxLength", "minLength", "pattern"].includes(key))
                || !Number.isInteger(rule.maxLength) || rule.maxLength < 1
                || rule.maxLength > 1000
                || (rule.minLength !== undefined && (!Number.isInteger(rule.minLength)
                    || rule.minLength < 0 || rule.minLength > rule.maxLength))
                || (rule.pattern !== undefined && (typeof rule.pattern !== "string"
                    || rule.pattern.length > 120))
                || typeof value !== "string" || value.length > rule.maxLength
                || value.length < (rule.minLength ?? 0)
                || (rule.pattern && !new RegExp(rule.pattern).test(value))) {
                throw new Error(`Invalid frozen Designer field: ${id}`);
            }
        } else if (rule.type === "boolean") {
            if (Object.keys(rule).sort().join() !== "type" || typeof value !== "boolean") {
                throw new Error(`Invalid frozen Designer field: ${id}`);
            }
        } else if (rule.type === "image") {
            if (Object.keys(rule).sort().join() !== "maxBytes,mimeTypes,type"
                || rule.maxBytes !== 32 * 1024
                || !isDeepStrictEqual(rule.mimeTypes,
                    ["image/png", "image/jpeg", "image/gif", "image/webp"])
                || typeof value !== "string"
                || value.length > 44 * 1024) {
                throw new Error(`Invalid frozen Designer image: ${id}`);
            }
        } else if (rule.type === "object") {
            const properties = rule.properties;
            if (Object.keys(rule).sort().join() !== "properties,type"
                || !properties || typeof properties !== "object" || Array.isArray(properties)
                || !Object.keys(properties).length || Object.keys(properties).length > 10
                || Object.entries(properties).some(([key, allowed]) =>
                    !/^[a-z][A-Za-z0-9]{0,39}$/.test(key)
                    || !Array.isArray(allowed) || !allowed.length || allowed.length > 20
                    || new Set(allowed).size !== allowed.length
                    || allowed.some((option) => typeof option !== "string"
                        || !option || option.length > 80))
                || !value || typeof value !== "object" || Array.isArray(value)
                || Object.keys(value).sort().join() !== Object.keys(properties).sort().join()
                || Object.entries(properties).some(([key, allowed]) =>
                    !allowed.includes(value[key]))) {
                throw new Error(`Invalid frozen Designer field: ${id}`);
            }
        } else throw new Error(`Invalid frozen Designer field: ${id}`);
    }
}

function within(root, path) {
    const part = relative(root, path);
    return part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function frozenImage(item, values, constraints) {
    if (!item || Object.keys(item).sort().join() !== (item.page === undefined
        ? "content,hash,id,label,mime,slot" : "content,hash,id,label,mime,page,slot")
        || !fieldPattern.test(item.id)
        || typeof item.label !== "string" || !item.label.trim() || item.label.length > 120
        || (item.page === undefined ? !["header.brand", "workflow.intro"].includes(item.slot)
            : typeof item.page !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(item.page)
                || typeof item.slot !== "string" || !/^[a-z][a-z0-9.-]{0,79}$/.test(item.slot))
        || constraints[item.id]?.type !== "image" || constraints[item.id]?.maxBytes !== 32 * 1024
        || !isDeepStrictEqual(constraints[item.id]?.mimeTypes,
            ["image/png", "image/jpeg", "image/gif", "image/webp"])
        || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(item.mime)
        || typeof item.content !== "string" || item.content.length > 44 * 1024
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.content)
        || values[item.id] !== `data:${item.mime};base64,${item.content}`) {
        throw new Error("Invalid frozen image asset registration");
    }
    const bytes = Buffer.from(item.content, "base64");
    const signatures = {
        "image/png": [137, 80, 78, 71, 13, 10, 26, 10],
        "image/jpeg": [255, 216, 255],
        "image/gif": [71, 73, 70, 56],
        "image/webp": [82, 73, 70, 70],
    };
    if (!bytes.length || bytes.length > 32 * 1024
        || bytes.toString("base64") !== item.content
        || !signatures[item.mime].every((part, index) => bytes[index] === part)
        || (item.mime === "image/png" && (bytes.length < 24
            || bytes.toString("ascii", 12, 16) !== "IHDR"))
        || (item.mime === "image/jpeg" && (bytes.length < 5
            || bytes.at(-2) !== 255 || bytes.at(-1) !== 217))
        || (item.mime === "image/gif" && (bytes.length < 14
            || !["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))))
        || (item.mime === "image/webp" && (bytes.length < 16
            || bytes.toString("ascii", 8, 12) !== "WEBP"
            || bytes.readUInt32LE(4) + 8 !== bytes.length))
        || createHash("sha256").update(bytes).digest("hex") !== item.hash) {
        throw new Error("Invalid frozen image bytes or hash");
    }
    return bytes;
}

const imageContract = { type: "image", maxBytes: 32768,
    mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] };

function frozenImageControl(item) {
    if (!item || Object.keys(item).sort().join() !== "assets,control"
        || item.control !== "stock.image" || !Array.isArray(item.assets) || item.assets.length !== 2
        || item.assets[0]?.kind !== "control.definition"
        || item.assets[1]?.kind !== "generated.adapter") {
        throw new Error("Invalid frozen stock.image control registration");
    }
    for (const asset of item.assets) {
        if (!asset || Object.keys(asset).sort().join() !== "content,hash,kind,name,sourceId"
            || !/^[a-z][a-z0-9-]{0,79}$/.test(asset.name)
            || !/^[A-Za-z0-9_.:-]{1,160}$/.test(asset.sourceId)
            || typeof asset.content !== "string" || asset.content.length > 44 * 1024
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.content)
            || Buffer.from(asset.content, "base64").length > 32 * 1024
            || Buffer.from(asset.content, "base64").toString("base64") !== asset.content
            || createHash("sha256").update(Buffer.from(asset.content, "base64")).digest("hex") !== asset.hash) {
            throw new Error("Invalid frozen stock.image control asset or hash");
        }
    }
    let definition;
    try { definition = JSON.parse(Buffer.from(item.assets[0].content, "base64").toString("utf8")); }
    catch { throw new Error("Invalid stock.image control definition"); }
    if (!definition || Object.keys(definition).sort().join() !== "adapters,id,schemaVersion,value"
        || definition.schemaVersion !== 1 || definition.id !== item.control
        || Object.keys(definition.adapters ?? {}).sort().join() !== "designer,generated"
        || !/^[a-z][a-z0-9-]{0,79}$/.test(definition.adapters.designer)
        || definition.adapters.generated !== item.assets[1].name
        || item.assets[0].name === item.assets[1].name
        || !isDeepStrictEqual(definition.value, imageContract)) {
        throw new Error("Incompatible frozen stock.image value contract or adapters");
    }
    const module = Buffer.from(item.assets[1].content, "base64").toString("utf8");
    if (/\bimport\b|\bexport\s+(?:\*|\{[^}]*\})\s+from\b/.test(module)) {
        throw new Error("Frozen stock.image adapter must be self-contained");
    }
    return { adapter: item.assets[1].name, definition: item.assets[0].name,
        hash: item.assets[1].hash,
        definitionHash: item.assets[0].hash };
}

function frozenTextControl(item) {
    if (!item || Object.keys(item).sort().join() !== "assets,control"
        || item.control !== "stock.text" || !Array.isArray(item.assets) || item.assets.length !== 2
        || item.assets[0]?.kind !== "control.definition"
        || item.assets[1]?.kind !== "generated.adapter") {
        throw new Error("Invalid frozen stock.text control registration");
    }
    for (const asset of item.assets) {
        if (!asset || Object.keys(asset).sort().join() !== "content,hash,kind,name,sourceId"
            || !/^[a-z][a-z0-9-]{0,79}$/.test(asset.name)
            || !/^[A-Za-z0-9_.:-]{1,160}$/.test(asset.sourceId)
            || typeof asset.content !== "string" || asset.content.length > 44 * 1024
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.content)
            || Buffer.from(asset.content, "base64").length > 32 * 1024
            || Buffer.from(asset.content, "base64").toString("base64") !== asset.content
            || createHash("sha256").update(Buffer.from(asset.content, "base64")).digest("hex") !== asset.hash) {
            throw new Error("Invalid frozen stock.text control asset or hash");
        }
    }
    let definition;
    try { definition = JSON.parse(Buffer.from(item.assets[0].content, "base64").toString("utf8")); }
    catch { throw new Error("Invalid stock.text control definition"); }
    if (!definition || Object.keys(definition).sort().join() !== "adapters,id,schemaVersion,value"
        || definition.schemaVersion !== 1 || definition.id !== "stock.text"
        || Object.keys(definition.adapters ?? {}).sort().join() !== "designer,generated"
        || !/^[a-z][a-z0-9-]{0,79}$/.test(definition.adapters.designer)
        || definition.adapters.generated !== item.assets[1].name
        || item.assets[0].name === item.assets[1].name
        || !isDeepStrictEqual(definition.value, { type: "string" })) {
        throw new Error("Incompatible frozen stock.text value contract or adapters");
    }
    const module = Buffer.from(item.assets[1].content, "base64").toString("utf8");
    if (/\bimport\b|\bexport\s+(?:\*|\{[^}]*\})\s+from\b/.test(module)) {
        throw new Error("Frozen stock.text adapter must be self-contained");
    }
    return { adapter: item.assets[1].name, definition: item.assets[0].name,
        hash: item.assets[1].hash, definitionHash: item.assets[0].hash };
}

const imageFile = (item) => `${item.page
    ? `asset-${createHash("sha256").update(item.id).digest("hex").slice(0,24)}`
    : item.slot === "header.brand" ? "logo" : "main-page-logo"}.${{
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
    "image/webp": "webp",
}[item.mime]}`;

function configuration(request) {
    const { canvas, workflow, values, fieldConstraints, installed, generatedFields,
        generatedPages, generatedControls, generatedAssets, generatedImageControl,
        generatedTextControl, generatedTextPlacements, valueSources } = request;
    validateFrozenValues(values, fieldConstraints);
    if (!canvas || !idPattern.test(canvas.id) || reserved.has(canvas.id)
        || !["displayName", "description", "workflowListName"]
        .every((key) => typeof canvas[key] === "string" && canvas[key].trim())
        || canvas.id !== values?.["canvas.id"] || canvas.displayName !== values?.["canvas.displayName"]
        || fieldConstraints["canvas.id"]?.type !== "string"
        || fieldConstraints["canvas.displayName"]?.type !== "string"
        || !values["canvas.displayName"].trim()
        || (Object.hasOwn(values, "canvas.description")
            && fieldConstraints["canvas.description"]?.type !== "string")
        || (Object.hasOwn(values, "canvas.workflowListName")
            && fieldConstraints["canvas.workflowListName"]?.type !== "string")
        || (Object.hasOwn(values, "workflowSlug.userProvided")
            && fieldConstraints["workflowSlug.userProvided"]?.type !== "boolean")
        || canvas.description !== (values["canvas.description"] || "Spec Kit workflow canvas.")
        || canvas.workflowListName !== (values["canvas.workflowListName"] || "Workflows")
        || (values["workflowSlug.userProvided"] !== undefined
            && typeof values["workflowSlug.userProvided"] !== "boolean")
        || !workflow || !Array.isArray(workflow.selectedPhases) || !workflow.selectedPhases.length
        || workflow.selectedPhases.length > 30 || new Set(workflow.selectedPhases).size !== workflow.selectedPhases.length
        || workflow.selectedPhases.some((phase) => typeof phase !== "string"
            || !/^(?:speckit\.)?[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(phase))
        || !installed || ["presets", "extensions", "bundles"].some((kind) =>
            !Array.isArray(installed[kind]) || installed[kind].some((item) =>
                typeof item.id !== "string" || typeof item.version !== "string"))) {
        throw new Error("Invalid frozen canvas identity, workflow or runtime inventory");
    }
    if (generatedAssets !== undefined && (!Array.isArray(generatedAssets)
        || generatedAssets.length > 10
        || new Set(generatedAssets.map((item) => item?.id)).size !== generatedAssets.length
        || new Set(generatedAssets.map((item) =>
            `${item?.page ?? "workflow"}:${item?.slot}`)).size !== generatedAssets.length)) {
        throw new Error("Invalid frozen image assets");
    }
    for (const [id, rule] of Object.entries(fieldConstraints)) {
        if (rule.type !== "image") continue;
        if (Object.keys(rule).sort().join() !== "maxBytes,mimeTypes,type" || rule.maxBytes !== 32 * 1024
            || !isDeepStrictEqual(rule.mimeTypes, imageContract.mimeTypes)
            || typeof values[id] !== "string"
            || values[id] !== "" && !generatedAssets?.some((item) => item.id === id)) {
            throw new Error(`Invalid frozen image field: ${id}`);
        }
    }
    for (const item of generatedAssets ?? []) frozenImage(item, values, fieldConstraints);
    const imageControl = generatedImageControl && frozenImageControl(generatedImageControl);
    if (!!imageControl !== Object.values(fieldConstraints).some((rule) => rule.type === "image")) {
        throw new Error("Image fields require a frozen stock.image control");
    }
    if (imageControl && generatedControls?.some((item) =>
        item.assets?.[1]?.name === imageControl.adapter
        || item.assets?.[0]?.name === imageControl.definition)) {
        throw new Error("Stock image assets conflict with another generated control");
    }
    const textControl = generatedTextControl && frozenTextControl(generatedTextControl);
    if (!!textControl !== !!generatedTextPlacements?.length
        || generatedTextPlacements !== undefined && (!Array.isArray(generatedTextPlacements)
            || generatedTextPlacements.length > 100
            || new Set(generatedTextPlacements.map((item) => item?.id)).size
                !== generatedTextPlacements.length
            || generatedTextPlacements.filter((item) => item?.presentation === "text")
                .length !== new Set(generatedTextPlacements.filter((item) =>
                    item?.presentation === "text").map((item) => item.slot)).size
            || generatedTextPlacements.some((item) => !item
                || Object.keys(item).sort().join() !== "id,label,presentation,slot"
                || !fieldPattern.test(item.id)
                || typeof item.label !== "string" || !item.label.trim() || item.label.length > 120
                || fieldConstraints[item.id]?.type !== "string"
                || (item.presentation === "text"
                    ? !((item.id === "canvas.description" && item.slot === "workflow.description")
                        || (item.id === "canvas.workflowListName" && item.slot === "workflow.heading"))
                    : item.presentation !== "stock.readonly" || item.slot !== "details.content"
                        || !generatedFields?.some((field) => field.id === item.id
                            && field.label === item.label))))) {
        throw new Error("Invalid frozen stock.text placements");
    }
    if (textControl && (generatedControls?.some((item) =>
        [textControl.adapter, textControl.definition].includes(item.assets?.[1]?.name)
        || [textControl.adapter, textControl.definition].includes(item.assets?.[0]?.name))
        || imageControl && [imageControl.adapter, imageControl.definition]
            .some((name) => [textControl.adapter, textControl.definition].includes(name)))) {
        throw new Error("Stock text assets conflict with another generated control");
    }
    if (generatedFields !== undefined
        && (!Array.isArray(generatedFields) || generatedFields.length > 100
            || new Set(generatedFields.map((field) => field?.id)).size !== generatedFields.length
            || generatedFields.some((field) => !field || typeof field !== "object"
                || Array.isArray(field)
                || Object.keys(field).some((key) => !["id", "label", "maxLength", "section"].includes(key))
                || typeof field.id !== "string"
                || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(field.id)
                || typeof field.label !== "string" || !field.label || field.label.length > 120
                || !Number.isInteger(field.maxLength) || field.maxLength < 1
                || field.maxLength > 1000 || typeof values[field.id] !== "string"
                || values[field.id].length > field.maxLength
                || (field.section !== undefined
                    && (!field.section || typeof field.section !== "object"
                        || Array.isArray(field.section)
                        || Object.keys(field.section).sort().join() !== "id,title"
                        || typeof field.section.id !== "string"
                        || !/^[a-z][a-z0-9.-]{0,79}$/.test(field.section.id)
                        || typeof field.section.title !== "string"
                        || !field.section.title.trim() || field.section.title.length > 120))))) {
        throw new Error("Invalid frozen generated fields");
    }
    const sections = new Map();
    for (const { section } of generatedFields ?? []) {
        if (!section) continue;
        if (sections.has(section.id) && sections.get(section.id) !== section.title) {
            throw new Error(`Conflicting frozen generated section: ${section.id}`);
        }
        sections.set(section.id, section.title);
    }
    if (valueSources !== undefined && (!Array.isArray(valueSources) || valueSources.length > 100
        || new Set(valueSources.map((item) => item?.id)).size !== valueSources.length)) {
        throw new Error("Invalid frozen value sources");
    }
    const frozenIds = new Set([...Object.keys(fieldConstraints), ...(valueSources ?? []).map((item) => item?.id)]);
    if (frozenIds.size !== Object.keys(fieldConstraints).length + (valueSources?.length ?? 0)) {
        throw new Error("Frozen value source collides with a Designer field");
    }
    const generatedIds = new Set([
        ...(generatedFields ?? []).map((item) => item.id),
        ...(valueSources ?? []).map((item) => item?.id),
    ]);
    const valueModules = new Map();
    for (const item of valueSources ?? []) {
        if (!item || typeof item !== "object" || Array.isArray(item)
            || Object.keys(item).some((key) => !["id", "label", "schema", "source",
                "presentation", "section", "assets"].includes(key))
            || !fieldPattern.test(item.id)
            || typeof item.label !== "string" || !item.label.trim() || item.label.length > 120
            || !["stock.readonly", "stock.editable", "processing-only"].includes(item.presentation)
            || !item.source || typeof item.source !== "object" || Array.isArray(item.source)
            || !(item.source.kind === "constant" && Object.keys(item.source).sort().join() === "kind,value"
                || item.source.kind === "provider" && Object.keys(item.source).sort().join() === "kind,module"
                    && typeof item.source.module === "string"
                    && /^[a-z][a-z0-9-]{0,79}$/.test(item.source.module))
            || (item.section !== undefined && (!item.section || typeof item.section !== "object"
                || Object.keys(item.section).sort().join() !== "id,title"
                || typeof item.section.id !== "string" || !/^[a-z][a-z0-9.-]{0,79}$/.test(item.section.id)
                || typeof item.section.title !== "string" || !item.section.title.trim()
                || item.section.title.length > 120))
            || !Array.isArray(item.assets) || item.assets.length !== (item.source?.kind === "provider" ? 2 : 1)
            || item.assets[0]?.kind !== "value.definition"
            || item.assets[1] && (item.assets[1].kind !== "value.provider"
                || item.assets[1].name !== item.source.module)
            || item.source?.kind === "provider" && item.presentation === "stock.editable") {
            throw new Error("Invalid frozen value source registration");
        }
        for (const asset of item.assets) {
            if (!asset || Object.keys(asset).sort().join() !== "content,hash,kind,name,sourceId"
                || typeof asset.name !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(asset.name)
                || typeof asset.sourceId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(asset.sourceId)
                || typeof asset.content !== "string"
                || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.content)
                || asset.content.length > 44 * 1024
                || createHash("sha256").update(Buffer.from(asset.content, "base64")).digest("hex") !== asset.hash) {
                throw new Error(`Invalid frozen value source asset: ${item.id}`);
            }
        }
        let definition;
        try { definition = JSON.parse(Buffer.from(item.assets[0].content, "base64").toString("utf8")); }
        catch { throw new Error(`${item.id}: invalid frozen value definition`); }
        if (!isDeepStrictEqual(definition, {
            schemaVersion: 1, id: item.id, label: item.label, schema: item.schema,
            source: item.source, presentation: item.presentation,
            ...(item.section ? { section: item.section } : {}),
        })) throw new Error(`${item.id}: frozen value definition differs from registration`);
        validateFrozenValues({ [item.id]: item.source.kind === "constant"
            ? item.source.value : item.schema.type === "string" ? ""
                : item.schema.type === "boolean" ? false
                    : Object.fromEntries(Object.entries(item.schema.properties ?? {})
                        .map(([key, allowed]) => [key, allowed[0]])) },
        { [item.id]: item.schema });
        if (item.source.kind === "provider") {
            const prior = valueModules.get(item.source.module);
            if (prior && prior !== item.assets[1].hash) {
                throw new Error(`Conflicting frozen value provider: ${item.source.module}`);
            }
            valueModules.set(item.source.module, item.assets[1].hash);
        }
        if (item.section) {
            if (sections.has(item.section.id) && sections.get(item.section.id) !== item.section.title) {
                throw new Error(`Conflicting frozen generated section: ${item.section.id}`);
            }
            sections.set(item.section.id, item.section.title);
        }
    }
    if (generatedPages !== undefined
        && (!Array.isArray(generatedPages) || generatedPages.length > 30
            || new Set(generatedPages.map((page) => page?.id)).size !== generatedPages.length
            || new Set(generatedPages.map((page) => page?.renderer)).size !== generatedPages.length)) {
        throw new Error("Invalid frozen generated pages");
    }
    for (const page of generatedPages ?? []) {
        if (!page || typeof page !== "object" || Array.isArray(page)
            || Object.keys(page).some((key) => !["assets", "id", "renderer", "title", "values", "slots"].includes(key))
            || typeof page.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(page.id)
            || page.id === RESERVED_GENERATED_PAGE_ID
            || typeof page.renderer !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(page.renderer)
            || typeof page.title !== "string" || !page.title.trim() || page.title.length > 120
            || (page.values !== undefined && (!Array.isArray(page.values)
                || page.values.length > 100 || new Set(page.values).size !== page.values.length
                || page.values.some((id) => !generatedIds.has(id))))
            || (page.slots !== undefined && (!Array.isArray(page.slots)
                || page.slots.length > 30
                || new Set(page.slots.map((slot) => slot?.id)).size !== page.slots.length
                || page.slots.some((slot) => !slot || typeof slot !== "object"
                    || Object.keys(slot).sort().join() !== "accepts,id"
                    || typeof slot.id !== "string" || !/^[a-z][a-z0-9.-]{0,79}$/.test(slot.id)
                    || JSON.stringify(slot.accepts) !== '["asset"]')))
            || !Array.isArray(page.assets) || page.assets.length !== 2
            || page.assets[0]?.name !== page.id || page.assets[0]?.kind !== "generated.page"
            || page.assets[1]?.name !== page.renderer || page.assets[1]?.kind !== "generated.renderer"
            || page.assets.some((asset) => !asset || typeof asset !== "object"
                || Object.keys(asset).sort().join() !== "content,hash,kind,name,sourceId"
                || typeof asset.sourceId !== "string"
                || !/^[A-Za-z0-9_.:-]{1,160}$/.test(asset.sourceId)
                || typeof asset.content !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.content)
                || asset.content.length > 44 * 1024
                || Buffer.from(asset.content, "base64").length > 32 * 1024
                || typeof asset.hash !== "string"
                || createHash("sha256").update(Buffer.from(asset.content, "base64")).digest("hex") !== asset.hash)) {
            throw new Error("Invalid frozen generated page assets");
        }
        let definition;
        try { definition = JSON.parse(Buffer.from(page.assets[0].content, "base64").toString("utf8")); }
        catch { throw new Error(`${page.id}: invalid frozen generated page definition`); }
        if (!definition || Object.keys(definition).some((key) =>
            !["id", "renderer", "schemaVersion", "title", "values", "slots"].includes(key))
            || definition.schemaVersion !== 1 || definition.id !== page.id
            || definition.renderer !== page.renderer || definition.title !== page.title
            || JSON.stringify(definition.values) !== JSON.stringify(page.values)
            || JSON.stringify(definition.slots) !== JSON.stringify(page.slots)) {
            throw new Error(`${page.id}: frozen generated page definition differs from registration`);
        }
    }
    for (const image of generatedAssets ?? []) {
        if (image.page && !generatedPages?.some((page) => page.id === image.page
            && page.slots?.some((slot) => slot.id === image.slot && slot.accepts.includes("asset")))) {
            throw new Error(`${image.id}: unknown generated page asset slot`);
        }
    }
    if (generatedControls !== undefined
        && (!Array.isArray(generatedControls) || generatedControls.length > 30
            || new Set(generatedControls.map((item) => item?.id)).size !== generatedControls.length
            || generatedControls.some((item) => generatedFields?.some((field) => field.id === item.id)))) {
        throw new Error("Invalid frozen generated controls");
    }
    for (const item of generatedControls ?? []) {
        if (!item || Object.keys(item).sort().join() !== "assets,control,id,label,slot,value"
            || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(item.id)
            || !/^[a-z][a-z0-9-]{0,79}$/.test(item.control)
            || !item.label || typeof item.label !== "string" || item.label.length > 120
            || item.slot !== "details.content" || !Array.isArray(item.assets)
            || item.assets.length !== 2
            || item.assets[0]?.kind !== "control.definition"
            || item.assets[1]?.kind !== "generated.adapter") {
            throw new Error("Invalid frozen generated control registration");
        }
        for (const asset of item.assets) {
            if (!asset || Object.keys(asset).sort().join() !== "content,hash,kind,name,sourceId"
                || !/^[a-z][a-z0-9-]{0,79}$/.test(asset.name)
                || typeof asset.sourceId !== "string"
                || !/^[A-Za-z0-9_.:-]{1,160}$/.test(asset.sourceId)
                || typeof asset.content !== "string"
                || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.content)
                || asset.content.length > 44 * 1024
                || Buffer.from(asset.content, "base64").length > 32 * 1024
                || createHash("sha256").update(Buffer.from(asset.content, "base64")).digest("hex") !== asset.hash) {
                throw new Error("Invalid frozen generated control asset");
            }
        }
        let definition;
        try { definition = JSON.parse(Buffer.from(item.assets[0].content, "base64").toString("utf8")); }
        catch { throw new Error(`${item.id}: invalid control definition`); }
        if (definition?.schemaVersion !== 1 || definition.id !== item.control
            || definition.adapters?.generated !== item.assets[1].name
            || !definition.adapters?.designer
            || item.assets[0].name === item.assets[1].name
            || definition.value?.type !== "object"
            || !definition.value.properties
            || typeof definition.value.properties !== "object"
            || Array.isArray(definition.value.properties)
            || !Object.keys(definition.value.properties).length
            || Object.keys(definition.value.properties).length > 10
            || Object.entries(definition.value.properties).some(([key, allowed]) =>
                !/^[a-z][A-Za-z0-9]{0,39}$/.test(key)
                || !Array.isArray(allowed) || !allowed.length || allowed.length > 20
                || new Set(allowed).size !== allowed.length
                || allowed.some((value) => typeof value !== "string" || !value || value.length > 80))
            || !item.value || typeof item.value !== "object" || Array.isArray(item.value)
            || Object.keys(item.value).sort().join() !== Object.keys(definition.value.properties).sort().join()
            || Object.entries(definition.value.properties).some(([key, allowed]) =>
                !allowed.includes(item.value[key]))
            || JSON.stringify(values[item.id]) !== JSON.stringify(item.value)) {
            throw new Error(`${item.id}: incompatible frozen control value or adapters`);
        }
    }
    const outputs = {
        constitution: ".specify/memory/constitution.md", specify: "specs/<slug>/spec.md",
        clarify: "specs/<slug>/spec.md", plan: "specs/<slug>/plan.md",
        tasks: "specs/<slug>/tasks.md", analyze: "specs/<slug>/analysis.md",
        checklist: "specs/<slug>/checklists/<name>.md",
    };
    const headerImage = generatedAssets?.find((item) => !item.page && item.slot === "header.brand");
    const mainImage = generatedAssets?.find((item) => !item.page && item.slot === "workflow.intro");
    const imageConfig = (item) => ({ file: imageFile(item), mime: item.mime, hash: item.hash });
    const pageImages = generatedAssets?.filter((item) => item.page) ?? [];
    return { schemaVersion: 1, canvas, userProvidesSlug: values["workflowSlug.userProvided"] ?? false,
        ...(headerImage ? { brandAsset: imageConfig(headerImage) } : {}),
        ...(mainImage ? { mainPageAsset: imageConfig(mainImage) } : {}),
        ...(pageImages.length ? { generatedPageAssets: pageImages.map((item) =>
            ({ id: item.id, label: item.label, page: item.page, slot: item.slot,
                ...imageConfig(item) })) } : {}),
        ...(imageControl ? { imageControl } : {}),
        ...(textControl ? { textControl, textPlacements: generatedTextPlacements } : {}),
        ...(generatedPages?.length ? { generatedPages: generatedPages.map(({ id, title, renderer,
            values: declared, slots }) => ({ id, title, renderer,
            ...(declared ? { values: declared } : {}), ...(slots ? { slots } : {}) })) } : {}),
        ...(valueSources?.length ? { valueSources: valueSources.map(
            ({ id, label, schema, source, presentation, section, assets }) => ({
                id, label, schema, source: source.kind === "provider"
                    ? { ...source, hash: assets[1].hash } : source,
                presentation, provenance: assets[0].sourceId,
                ...(section ? { section } : {}),
            })) } : {}),
        ...(generatedFields?.length ? { readOnlyFields: generatedFields.map(({ id, label, section }) =>
            ({ id, label, value: values[id], ...(section ? { section } : {}) })) } : {}),
        ...(generatedControls?.length ? { generatedControls: generatedControls.map(
            ({ id, label, control, slot, value, assets }) =>
                ({ id, label, control, slot, value, adapter: assets[1].name,
                    properties: JSON.parse(Buffer.from(assets[0].content, "base64").toString("utf8"))
                        .value.properties })) } : {}),
        phases: workflow.selectedPhases,
        phaseOutputs: Object.fromEntries(workflow.selectedPhases.map((phase) => {
            const path = outputs[phase.replace(/^speckit\./, "")] ?? null;
            return [phase, { expectsArtifact: !!path, outputPath: path }];
        })), phaseArtifacts: {},
        installed };
}

function checkSyntax(path) {
    const check = spawnSync("node", ["--check", path], { encoding: "utf8" });
    if (check.error || check.status !== 0) throw new Error(`Generated JavaScript failed validation: ${check.stderr || check.error}`);
}

export async function materialize(project, workspace, handoffId, requestId) {
    if (!requestPattern.test(handoffId) || !requestPattern.test(requestId)) throw new Error("Invalid generation identifiers");
    const projectRoot = await realpath(project), workspaceRoot = await realpath(workspace);
    const generation = join(workspaceRoot, "speckit-canvas-designer", "handoffs", handoffId, "generations", requestId);
    if (await realpath(generation) !== generation) {
        throw new Error("Generation request escapes its session directory");
    }
    const requestPath = join(generation, "request.json");
    if (!(await lstat(requestPath)).isFile() || await realpath(requestPath) !== requestPath) {
        throw new Error("Frozen generation request must be a regular session file");
    }
    const raw = await readFile(requestPath);
    if (raw.length > REQUEST_LIMIT) throw new Error("Generation request is too large");
    const request = JSON.parse(raw.toString("utf8"));
    const { integrity, ...payload } = request;
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    if (integrity !== hash || request.handoffId !== handoffId || request.requestId !== requestId) {
        throw new Error("Generation request integrity mismatch");
    }
    if (request.project !== projectRoot) throw new Error("Generation request is bound to another checkout");
    const handoffPath = join(workspaceRoot, "speckit-canvas-designer",
        "handoffs", handoffId, "handoff.json");
    const handoffStat = await lstat(handoffPath);
    if (!handoffStat.isFile() || handoffStat.size > 64 * 1024
        || await realpath(handoffPath) !== handoffPath) {
        throw new Error("Wizard handoff must be a bounded regular session file");
    }
    const handoff = JSON.parse(await readFile(handoffPath, "utf8"));
    if (handoff.handoffId !== handoffId || handoff.sourceFingerprint !== request.sourceFingerprint
        || handoff.sourceFingerprint !== createHash("sha256").update(JSON.stringify({
            workflow: handoff.workflow, selections: handoff.selections,
            localSelections: handoff.localSelections,
        })).digest("hex")
        || JSON.stringify(handoff.workflow.selectedPhases) !== JSON.stringify(request.workflow.selectedPhases)
        || JSON.stringify(handoff.workflow.installed) !== JSON.stringify(request.installed)) {
        throw new Error("Frozen generation request differs from the Wizard handoff");
    }
    const config = configuration(request);
    const pageFiles = (request.generatedPages ?? []).flatMap((page) => [
        { filename: `${page.id}.json`, bytes: Buffer.from(page.assets[0].content, "base64") },
        { filename: `${page.renderer}.mjs`, bytes: Buffer.from(page.assets[1].content, "base64") },
    ]);
    const controlFiles = (request.generatedControls ?? []).flatMap((item) => [
        { filename: `${item.assets[0].name}.json`, bytes: Buffer.from(item.assets[0].content, "base64") },
        { filename: `${item.assets[1].name}.mjs`, bytes: Buffer.from(item.assets[1].content, "base64") },
    ]);
    if (request.generatedImageControl) {
        controlFiles.push(...request.generatedImageControl.assets.map((asset) => ({
            filename: `${asset.name}.${asset.kind === "control.definition" ? "json" : "mjs"}`,
            bytes: Buffer.from(asset.content, "base64"),
        })));
    }
    if (request.generatedTextControl) {
        controlFiles.push(...request.generatedTextControl.assets.map((asset) => ({
            filename: `${asset.name}.${asset.kind === "control.definition" ? "json" : "mjs"}`,
            bytes: Buffer.from(asset.content, "base64"),
        })));
    }
    const providerFiles = [...new Map((request.valueSources ?? []).filter(
        (item) => item.source.kind === "provider").map((item) => [
        item.source.module, { filename: `${item.source.module}.mjs`,
            bytes: Buffer.from(item.assets[1].content, "base64") },
    ])).values()];
    const imageFiles = (request.generatedAssets ?? []).map((item) => ({
        filename: imageFile(item), bytes: frozenImage(item, request.values, request.fieldConstraints),
    }));
    const distinctControlFiles = new Map();
    for (const file of controlFiles) {
        if (distinctControlFiles.has(file.filename)
            && !distinctControlFiles.get(file.filename).equals(file.bytes)) {
            throw new Error(`Conflicting generated control asset: ${file.filename}`);
        }
        distinctControlFiles.set(file.filename, file.bytes);
    }
    const target = join(projectRoot, ".github", "extensions", config.canvas.id);
    if (!within(projectRoot, target) || request.target !== `.github/extensions/${config.canvas.id}/`) {
        throw new Error("Generation target is invalid");
    }
    const files = await Promise.all([...featureFiles, "extension.mjs"].map(async (file) =>
        [file, await readFile(join(featureRoot, file))]));
    const github = join(projectRoot, ".github");
    await mkdir(github, { recursive: true });
    if (await realpath(github) !== github) {
        throw new Error("Canvas extension directory escapes the checkout");
    }
    const parent = join(projectRoot, ".github", "extensions");
    await mkdir(parent, { recursive: true });
    if (await realpath(parent) !== parent) {
        throw new Error("Canvas extension directory escapes the checkout");
    }
    try {
        await mkdir(target);
    } catch (error) {
        if (error.code === "EEXIST") throw new Error(`Canvas extension already exists: ${target}`);
        throw error;
    }
    await mkdir(join(target, "ui"));
    if (pageFiles.length) await mkdir(join(target, "pages"));
    if (controlFiles.length) await mkdir(join(target, "controls"));
    if (providerFiles.length) await mkdir(join(target, "providers"));
    if (imageFiles.length) await mkdir(join(target, "assets"));
    for (const { filename, bytes } of imageFiles) {
        await writeFile(join(target, "assets", filename), bytes, { flag: "wx" });
    }
    for (const { filename, bytes } of pageFiles) {
        const path = join(target, "pages", filename);
        await writeFile(path, bytes, { flag: "wx" });
        if (filename.endsWith(".mjs")) checkSyntax(path);
    }
    for (const [filename, bytes] of distinctControlFiles) {
        const path = join(target, "controls", filename);
        await writeFile(path, bytes, { flag: "wx" });
        if (filename.endsWith(".mjs")) checkSyntax(path);
    }
    for (const { filename, bytes } of providerFiles) {
        const path = join(target, "providers", filename);
        await writeFile(path, bytes, { flag: "wx" });
        checkSyntax(path);
    }
    for (const [file, content] of files) {
        if (file !== "extension.mjs") {
            await writeFile(join(target, file), content, { flag: "wx" });
        }
    }
    await writeFile(join(target, "canvas-config.json"), JSON.stringify(config), { flag: "wx" });
    await writeFile(join(target, "canvas-setup.json"), JSON.stringify({ values: request.values }), { flag: "wx" });
    await writeFile(join(target, "settings-provenance.json"),
        JSON.stringify({ requestId, handoffId, sourceFingerprint: request.sourceFingerprint }), { flag: "wx" });
    await writeFile(join(target, "extension.mjs"), files.at(-1)[1], { flag: "wx" });
    for (const file of [...featureFiles, "extension.mjs"]) {
        if (file.endsWith(".mjs") || file.endsWith(".js")) checkSyntax(join(target, file));
    }
    const renderer = spawnSync("node", ["--input-type=module", "-e",
        "const m=await import(process.argv[1]);m.renderHtml(m.readConfig());",
        pathToFileURL(join(target, "server.mjs")).href],
    { encoding: "utf8" });
    if (renderer.error || renderer.status !== 0) throw new Error(`Workflow renderer failed: ${renderer.stderr || renderer.error}`);
    return { target: request.target, canvasId: config.canvas.id };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    materialize(...process.argv.slice(2)).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
        .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
