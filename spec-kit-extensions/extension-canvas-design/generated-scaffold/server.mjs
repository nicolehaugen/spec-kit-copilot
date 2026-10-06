import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isWindowsDeviceName, UserError } from "./files.mjs";
import { phaseContract, valueContract } from "./contract.mjs";
import { validControlValue } from "./control-contract.mjs";

const styles = readFileSync(new URL("./ui/workflow-theme.css", import.meta.url), "utf8");
const script = readFileSync(new URL("./ui/app.js", import.meta.url), "utf8");
const markdown = readFileSync(new URL("./ui/markdown.mjs", import.meta.url), "utf8");
const pageAssets = readFileSync(new URL("./ui/page-assets.mjs", import.meta.url), "utf8");
const runtimeStyles = readFileSync(new URL("./ui/runtime.css", import.meta.url), "utf8");
const packageRoot = realpathSync(new URL(".", import.meta.url));
const RESERVED_GENERATED_PAGE_ID = "workflow";
const WORKFLOW_REGIONS = ["collection", "details", "values", "controls",
    "pages", "constitution", "message", "pipeline"];
const imageValueContract = { type: "image", maxBytes: 32768,
    mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] };

const escapeHtml = (value) => String(value).replace(/[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function validImageAsset(asset, basename) {
    return asset && typeof asset === "object" && !Array.isArray(asset)
        && Object.keys(asset).sort().join() === "file,hash,mime"
        && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(asset.mime)
        && asset.file === `${basename}.${{
            "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
            "image/webp": "webp",
        }[asset.mime]}`
        && /^[a-f0-9]{64}$/.test(asset.hash);
}

function readOnlySections(fields, textPlacements = []) {
    const groups = new Map();
    const ungrouped = Symbol("ungrouped");
    for (const field of fields ?? []) {
        const key = field.section?.id ?? ungrouped;
        if (!groups.has(key)) groups.set(key, { title: field.section?.title ?? "Configured fields", fields: [] });
        groups.get(key).fields.push(field);
    }
    return [...groups.values()].map(({ title, fields: entries }) =>
        `<section class="phase-card" aria-label="${escapeHtml(title)}"><h2>${escapeHtml(title)}</h2><dl class="phase-facts">${entries.map(({ id, label, value }) =>
            `<dt>${escapeHtml(label)}</dt><dd data-field-id="${escapeHtml(id)}"${textPlacements.some((item) =>
                item.id === id && item.slot === "details.content") ? ` data-stock-text="details.content" data-text-label="${escapeHtml(label)}"` : ""}>${escapeHtml(value)}</dd>`).join("")}</dl></section>`).join("");
}

function validReadOnlyFields(fields) {
    return fields === undefined || (Array.isArray(fields) && fields.length <= 100
        && new Set(fields.map((field) => field?.id)).size === fields.length
        && fields.every((field) => field && typeof field === "object"
            && !Array.isArray(field)
            && Object.keys(field).every((key) => ["id", "label", "value", "section"].includes(key))
            && typeof field.id === "string"
            && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(field.id)
            && typeof field.label === "string" && !!field.label && field.label.length <= 120
            && typeof field.value === "string" && field.value.length <= 1000
            && (field.section === undefined || (field.section
                && typeof field.section === "object" && !Array.isArray(field.section)
                && Object.keys(field.section).sort().join() === "id,title"
                && typeof field.section.id === "string"
                && /^[a-z][a-z0-9.-]{0,79}$/.test(field.section.id)
                && typeof field.section.title === "string"
                && !!field.section.title.trim() && field.section.title.length <= 120))));
}

function validGeneratedPages(pages) {
    return pages === undefined || (Array.isArray(pages) && pages.length <= 30
        && new Set(pages.map((page) => page?.id)).size === pages.length
        && pages.every((page) => page && typeof page === "object" && !Array.isArray(page)
            && Object.keys(page).every((key) => ["id", "renderer", "title", "order", "values", "slots"].includes(key))
            && typeof page.id === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(page.id)
            && page.id !== RESERVED_GENERATED_PAGE_ID && !isWindowsDeviceName(page.id)
            && typeof page.renderer === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(page.renderer)
            && !isWindowsDeviceName(page.renderer)
            && typeof page.title === "string" && !!page.title.trim() && page.title.length <= 120
            && (page.order === undefined || Number.isInteger(page.order)
                && page.order >= -100000 && page.order <= 100000)
            && (page.values === undefined || Array.isArray(page.values)
                && page.values.length <= 100 && new Set(page.values).size === page.values.length
                && page.values.every((id) => typeof id === "string"
                    && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(id)))
            && (page.slots === undefined || Array.isArray(page.slots)
                && page.slots.length <= 30
                && new Set(page.slots.map((slot) => slot?.id)).size === page.slots.length
                && page.slots.every((slot) => slot && typeof slot === "object"
                    && !Array.isArray(slot) && Object.keys(slot).join() === "id"
                    && typeof slot.id === "string" && /^[a-z][a-z0-9.-]{0,79}$/.test(slot.id)))));
}

function validGeneratedControls(controls) {
    return controls === undefined || (Array.isArray(controls) && controls.length <= 30
        && new Set(controls.map((item) => item?.id)).size === controls.length
        && controls.every((item) => item && typeof item === "object" && !Array.isArray(item)
            && Object.keys(item).sort().join() === "adapter,control,id,label,properties,slot,value"
            && typeof item.id === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(item.id)
            && typeof item.adapter === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(item.adapter)
            && typeof item.control === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(item.control)
            && typeof item.label === "string" && !!item.label && item.label.length <= 120
            && item.slot === "details.content"
            && validControlValue(item.value, { type: "object", properties: item.properties })));
}

function validFieldPlacements(config) {
    const placements = config.fieldPlacements ?? [];
    if (!Array.isArray(placements) || placements.length > 100
        || new Set(placements.map((item) => item?.id)).size !== placements.length
        || new Set(placements.map((item) =>
            `${item?.page}:${item?.slot}:${item?.field}`)).size !== placements.length) return false;
    return placements.every((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)
            || Object.keys(item).some((key) => !["id", "page", "slot", "field", "order",
                "control", "label", "schema", "editable", "value", "asset", "adapter", "hash",
                "adapterHash", "definition", "definitionHash"].includes(key))
            || typeof item.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(item.id)
            || !/^[a-f0-9]{64}$/.test(item.hash)
            || typeof item.field !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(item.field)
            || typeof item.label !== "string" || !item.label.trim() || item.label.length > 120
            || !Number.isInteger(item.order) || item.order < -100000 || item.order > 100000
            || !item.schema || !["string", "boolean", "object", "image"].includes(item.schema.type)
            || typeof item.editable !== "boolean" || item.editable && item.value !== undefined
            || item.slot === "workflow.phases"
            || !(item.page === "workflow" ? config.workflowPage.slots
                : config.generatedPages?.find((page) => page.id === item.page)?.slots)
                ?.some((slot) => slot.id === item.slot)) return false;
        const value = config.valueSources?.find((source) => source.id === item.field);
        if (value && (value.label !== item.label || JSON.stringify(value.schema) !== JSON.stringify(item.schema)
            || item.editable !== (value.presentation === "stock.editable")
            || value.presentation === "processing-only" || item.value !== undefined)) return false;
        if (item.schema.type === "image") {
            return item.control === "stock.image" && !item.editable
                && (item.asset === undefined || ["image/png", "image/jpeg", "image/gif", "image/webp"]
                    .includes(item.asset.mime)
                    && /^[a-z0-9-]+\.(?:png|jpg|gif|webp)$/.test(item.asset.file)
                    && validImageAsset(item.asset, item.asset.file.split(".")[0]));
        }
        if (!value && (item.value === undefined || item.editable)) return false;
        if (item.schema.type === "string" || item.schema.type === "boolean") {
            return item.control === (item.schema.type === "string" ? "stock.text" : "stock.checkbox")
                && item.adapter === undefined
                && (value || typeof item.value === item.schema.type);
        }
        return item.schema.type === "object" && typeof item.adapter === "string"
            && /^[a-z][a-z0-9-]{0,79}$/.test(item.adapter)
            && /^[a-z][a-z0-9-]{0,79}$/.test(item.control)
            && /^[a-f0-9]{64}$/.test(item.adapterHash)
            && typeof item.definition === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(item.definition)
            && /^[a-f0-9]{64}$/.test(item.definitionHash)
            && (value || validControlValue(item.value, item.schema));
    });
}

function validRuntimeConfig(config) {
    return config.phaseOutputs && typeof config.phaseOutputs === "object"
        && !Array.isArray(config.phaseOutputs)
        && Object.values(config.phaseOutputs).every((output) => output
            && typeof output.expectsArtifact === "boolean"
            && (output.outputPath === null || typeof output.outputPath === "string"))
        && (config.theme === undefined || ["light", "dark"].includes(config.theme))
        && (config.appearance === undefined || (config.appearance
            && typeof config.appearance === "object" && !Array.isArray(config.appearance)
            && Object.keys(config.appearance).length > 0
            && Object.keys(config.appearance).every((mode) => ["light", "dark"].includes(mode)
                && (typeof config.appearance[mode] === "string"
                    ? /^#[0-9a-fA-F]{6}$/.test(config.appearance[mode])
                    : config.appearance[mode] && typeof config.appearance[mode] === "object"
                        && !Array.isArray(config.appearance[mode])
                        && Object.keys(config.appearance[mode]).length > 0
                        && Object.keys(config.appearance[mode]).every((key) =>
                            Object.hasOwn(APPEARANCE_PROPERTIES, key)
                            && typeof config.appearance[mode][key] === "string"
                            && /^#[0-9a-fA-F]{6}$/.test(config.appearance[mode][key]))))))
        && config.installed && ["presets", "extensions", "bundles"].every((kind) =>
            Array.isArray(config.installed[kind]) && config.installed[kind].every((item) =>
                item && typeof item === "object" && !Array.isArray(item)
                && typeof item.id === "string" && typeof item.version === "string"));
}

export function readConfig() {
    const config = JSON.parse(readFileSync(new URL("./canvas-config.json", import.meta.url), "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)
        || config.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(config.canvas?.id)
        || isWindowsDeviceName(config.canvas.id)
        || ["displayName", "description", "workflowListName"].some((key) =>
            typeof config.canvas[key] !== "string" || !config.canvas[key].trim())
        || !Array.isArray(config.phases) || !config.phases.length
        || config.phases.some((phase) => typeof phase !== "string" || !phase)
        || typeof config.userProvidesSlug !== "boolean"
        || (config.readOnlyFields !== undefined
            && (!Array.isArray(config.readOnlyFields) || config.readOnlyFields.length > 100
                || new Set(config.readOnlyFields.map((field) => field?.id)).size !== config.readOnlyFields.length
                || config.readOnlyFields.some((field) => !field || typeof field !== "object"
                    || Array.isArray(field)
                    || Object.keys(field).some((key) => !["id", "label", "value", "section"].includes(key))
                    || typeof field.id !== "string"
                    || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(field.id)
                    || typeof field.label !== "string" || !field.label || field.label.length > 120
                    || typeof field.value !== "string" || field.value.length > 1000
                    || (field.section !== undefined
                        && (!field.section || typeof field.section !== "object"
                            || Array.isArray(field.section)
                            || Object.keys(field.section).sort().join() !== "id,title"
                            || typeof field.section.id !== "string"
                            || !/^[a-z][a-z0-9.-]{0,79}$/.test(field.section.id)
                            || typeof field.section.title !== "string"
                            || !field.section.title.trim() || field.section.title.length > 120)))))
        || !config.workflowPage || typeof config.workflowPage.title !== "string"
        || !config.workflowPage.title.trim() || config.workflowPage.title.length > 120
        || config.workflowPage.order !== 0
        || !Array.isArray(config.workflowPage.slots) || config.workflowPage.slots.length > 30
        || !config.workflowPage.slots.some((slot) => slot?.id === "workflow.phases")
        || new Set(config.workflowPage.slots.map((slot) => slot?.id)).size !== config.workflowPage.slots.length
        || config.workflowPage.slots.some((slot) => !slot || Object.keys(slot).join() !== "id"
            || typeof slot.id !== "string" || !/^[a-z][a-z0-9.-]{0,79}$/.test(slot.id))
        || config.workflowPage.phaseControl !== "generated-phase-control"
        || config.workflowPage.adapter !== "generated-phase-adapter"
        || !/^[a-f0-9]{64}$/.test(config.workflowPage.hash)
        || !/^[a-f0-9]{64}$/.test(config.workflowPage.definitionHash)
        || !/^[a-f0-9]{64}$/.test(config.workflowPage.controlHash)
        || typeof config.workflowPage.managedRun !== "boolean"
        || Object.keys(config.workflowPage).sort().join() !== "adapter,controlHash,definitionHash,hash,managedRun,order,phaseControl,slots,title"
        || (config.generatedPages !== undefined
            && (!Array.isArray(config.generatedPages) || config.generatedPages.length > 30
                || new Set(config.generatedPages.map((page) => page?.id)).size !== config.generatedPages.length
                || config.generatedPages.some((page) => !page || typeof page !== "object"
                            || Array.isArray(page) || Object.keys(page).some((key) =>
                                !["id", "renderer", "title", "order", "values", "slots"].includes(key))
                            || typeof page.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(page.id)
                            || page.id === RESERVED_GENERATED_PAGE_ID
                            || typeof page.renderer !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(page.renderer)
                            || page.renderer === config.workflowPage.adapter
                            || typeof page.title !== "string" || !page.title.trim() || page.title.length > 120
                            || (page.order !== undefined && (!Number.isInteger(page.order)
                                || page.order < -100000 || page.order > 100000))
                            || (page.slots !== undefined && (!Array.isArray(page.slots)
                                || page.slots.length > 30
                                || new Set(page.slots.map((slot) => slot?.id)).size !== page.slots.length
                                || page.slots.some((slot) => !slot || typeof slot !== "object"
                                    || Object.keys(slot).join() !== "id"
                                    || typeof slot.id !== "string"
                                    || !/^[a-z][a-z0-9.-]{0,79}$/.test(slot.id)))))))
        || (config.generatedPageAssets !== undefined
            && (!Array.isArray(config.generatedPageAssets)
                || config.generatedPageAssets.length > 10
                || new Set(config.generatedPageAssets.map((asset) => asset?.id)).size
                    !== config.generatedPageAssets.length
                || new Set(config.generatedPageAssets.map((asset) =>
                    `${asset?.page}:${asset?.slot}`)).size !== config.generatedPageAssets.length
                || config.generatedPageAssets.some((asset) => !asset
                    || Object.keys(asset).sort().join() !== "file,hash,id,label,mime,page,slot"
                    || typeof asset.id !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(asset.id)
                    || typeof asset.label !== "string" || !asset.label.trim() || asset.label.length > 120
                    || typeof asset.page !== "string" || typeof asset.slot !== "string"
                    || !config.generatedPages?.some((page) => page.id === asset.page
                        && page.slots?.some((slot) => slot.id === asset.slot))
                    || !validImageAsset({ file: asset.file, hash: asset.hash, mime: asset.mime },
                        `asset-${createHash("sha256").update(asset.id).digest("hex").slice(0,24)}`))))
        || (config.generatedControls !== undefined
            && (!Array.isArray(config.generatedControls) || config.generatedControls.length > 30
                || new Set(config.generatedControls.map((item) => item?.id)).size !== config.generatedControls.length
                || config.generatedControls.some((item) => !item
                    || Object.keys(item).sort().join() !== "adapter,control,id,label,properties,slot,value"
                    || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(item.id)
                    || !/^[a-z][a-z0-9-]{0,79}$/.test(item.adapter)
                    || !/^[a-z][a-z0-9-]{0,79}$/.test(item.control)
                    || typeof item.label !== "string" || !item.label || item.label.length > 120
                    || item.slot !== "details.content"
                    || !item.properties || typeof item.properties !== "object"
                    || Array.isArray(item.properties) || !Object.keys(item.properties).length
                    || !item.value || typeof item.value !== "object" || Array.isArray(item.value)
                    || Object.keys(item.value).sort().join() !== Object.keys(item.properties).sort().join()
                    || Object.entries(item.properties).some(([key, allowed]) =>
                        !/^[a-z][A-Za-z0-9]{0,39}$/.test(key)
                        || !Array.isArray(allowed) || !allowed.length || allowed.length > 20
                        || !allowed.includes(item.value[key])))))
        || !config.phaseOutputs || typeof config.phaseOutputs !== "object" || Array.isArray(config.phaseOutputs)
        || Object.values(config.phaseOutputs).some((output) => !output
            || typeof output.expectsArtifact !== "boolean"
            || (output.outputPath !== null && typeof output.outputPath !== "string"))
        || (config.brandAsset !== undefined && !validImageAsset(config.brandAsset, "logo"))
        || (config.mainPageAsset !== undefined && !validImageAsset(config.mainPageAsset, "main-page-logo"))
        || (config.imageControl !== undefined && (!config.imageControl
            || Object.keys(config.imageControl).sort().join() !== "adapter,definition,definitionHash,hash"
            || !/^[a-z][a-z0-9-]{0,79}$/.test(config.imageControl.adapter)
            || !/^[a-z][a-z0-9-]{0,79}$/.test(config.imageControl.definition)
            || !/^[a-f0-9]{64}$/.test(config.imageControl.hash)
            || !/^[a-f0-9]{64}$/.test(config.imageControl.definitionHash)))
        || (!config.imageControl && !!(config.brandAsset || config.mainPageAsset
            || config.generatedPageAssets?.length
            || config.fieldPlacements?.some((item) => item.asset)))
        || (config.imageControl && config.generatedControls?.some((item) =>
            item.adapter === config.imageControl.adapter))
        || (config.textControl !== undefined && (!config.textControl
            || Object.keys(config.textControl).sort().join() !== "adapter,definition,definitionHash,hash"
            || !/^[a-z][a-z0-9-]{0,79}$/.test(config.textControl.adapter)
            || !/^[a-z][a-z0-9-]{0,79}$/.test(config.textControl.definition)
            || !/^[a-f0-9]{64}$/.test(config.textControl.hash)
            || !/^[a-f0-9]{64}$/.test(config.textControl.definitionHash)))
        || (!!config.textControl !== !!config.textPlacements?.length)
        || (config.textPlacements !== undefined && (!Array.isArray(config.textPlacements)
            || config.textPlacements.length > 100
            || new Set(config.textPlacements.map((item) => item?.id)).size
                !== config.textPlacements.length
            || config.textPlacements.filter((item) => item?.presentation === "text").length
                !== new Set(config.textPlacements.filter((item) =>
                    item?.presentation === "text").map((item) => item.slot)).size
            || config.textPlacements.some((item) => !item
                || Object.keys(item).sort().join() !== "id,label,presentation,slot"
                || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(item.id)
                || typeof item.label !== "string" || !item.label.trim() || item.label.length > 120
                || (item.presentation === "text"
                    ? !((item.slot === "workflow.description" && item.id === "canvas.description")
                        || (item.slot === "workflow.heading" && item.id === "canvas.workflowListName"))
                    : item.presentation !== "stock.readonly" || item.slot !== "details.content"
                        || !config.readOnlyFields?.some((field) =>
                            field.id === item.id && field.label === item.label)))))
        || (config.textControl && (config.generatedControls?.some((item) =>
            item.adapter === config.textControl.adapter)
            || config.imageControl?.adapter === config.textControl.adapter))
        || (config.theme !== undefined && !["light", "dark"].includes(config.theme))
        || !validGeneratedPages(config.generatedPages)
        || !validReadOnlyFields(config.readOnlyFields)
        || !validGeneratedControls(config.generatedControls)
        || !validFieldPlacements(config)
        || !validRuntimeConfig(config)) {
        throw new Error("Invalid generated canvas configuration");
    }
    for (const asset of [config.brandAsset, config.mainPageAsset, ...(config.generatedPageAssets ?? [])]) {
        if (asset) readImageAsset(asset);
    }
    if (config.imageControl) readImageControl(config.imageControl);
    if (config.textControl) readTextControl(config.textControl);
    readWorkflowPage(config.workflowPage);
    for (const item of config.fieldPlacements ?? []) {
        readFieldPlacement(item);
        if (item.adapter) readPlacementControl(item);
        if (item.asset) readImageAsset(item.asset);
    }
    const sections = new Map();
    for (const { section } of config.readOnlyFields ?? []) {
        if (!section) continue;
        if (sections.has(section.id) && sections.get(section.id) !== section.title) {
            throw new Error(`Conflicting generated canvas section: ${section.id}`);
        }
        sections.set(section.id, section.title);
    }
    phaseContract(config);
    valueContract(config);
    return config;
}

function readFieldPlacement(placement) {
    const bytes = readPackagedFile(new URL(`./pages/${placement.id}.json`, import.meta.url));
    const { $schema, ...definition } = JSON.parse(bytes);
    if (createHash("sha256").update(bytes).digest("hex") !== placement.hash
        || !isDeepStrictEqual(definition, { schemaVersion: 1,
            id: placement.id, page: placement.page, slot: placement.slot,
            field: placement.field, order: placement.order,
            ...(definition.control === undefined ? {} : { control: placement.control }) })) {
        throw new Error(`Packaged field placement ${placement.id} differs from its frozen contract`);
    }
}

function readPlacementControl(item) {
    const bytes = readPackagedFile(new URL(`./controls/${item.adapter}.mjs`, import.meta.url));
    const definition = readPackagedFile(new URL(`./controls/${item.definition}.json`, import.meta.url));
    const { $schema, ...document } = JSON.parse(definition);
    if (createHash("sha256").update(bytes).digest("hex") !== item.adapterHash
        || createHash("sha256").update(definition).digest("hex") !== item.definitionHash
        || document.id !== item.control || document.adapters?.generated !== item.adapter
        || !isDeepStrictEqual(document.value, item.schema)) {
        throw new Error(`Packaged placement control ${item.control} differs from its frozen contract`);
    }
    return bytes;
}

function readWorkflowPage(page) {
    const definition = readPackagedFile(new URL("./pages/workflow.json", import.meta.url));
    if (createHash("sha256").update(definition).digest("hex") !== page.definitionHash) {
        throw new Error("Packaged Workflow page definition does not match its frozen hash");
    }
    const parsed = JSON.parse(definition);
    if (parsed.schemaVersion !== 1 || parsed.id !== "workflow"
        || Object.keys(parsed).filter((key) => key !== "$schema").sort().join() !== "id,order,schemaVersion,slots,title"
        || parsed.title !== page.title || parsed.order !== page.order
        || JSON.stringify(parsed.slots) !== JSON.stringify(page.slots)) {
        throw new Error("Packaged Workflow page definition differs from its frozen contract");
    }
    const control = readPackagedFile(new URL("./pages/phase-control.json", import.meta.url));
    if (createHash("sha256").update(control).digest("hex") !== page.controlHash) {
        throw new Error("Packaged phase control definition does not match its frozen hash");
    }
    const registration = JSON.parse(control);
    if (registration.schemaVersion !== 1 || registration.id !== "workflow-phases"
        || registration.adapter !== page.adapter
        || Object.keys(registration).filter((key) => key !== "$schema").sort().join() !== (registration.managedRun === undefined
            ? "adapter,id,placement,schemaVersion" : "adapter,id,managedRun,placement,schemaVersion")
        || (registration.managedRun !== undefined && typeof registration.managedRun !== "boolean")
        || page.managedRun !== (registration.managedRun === true)
        || !registration.placement || Object.keys(registration.placement).sort().join() !== "page,slot"
        || registration.placement.page !== "workflow" || registration.placement.slot !== "workflow.phases") {
        throw new Error("Packaged phase control definition differs from its frozen contract");
    }
    const bytes = readPackagedFile(new URL(`./pages/${page.adapter}.mjs`, import.meta.url));
    if (!bytes.length || bytes.length > 32 * 1024
        || createHash("sha256").update(bytes).digest("hex") !== page.hash) {
        throw new Error("Packaged phase control adapter does not match its frozen hash");
    }
    return bytes;
}
function readPackagedFile(url) {
    const parent = dirname(fileURLToPath(url));
    const checkParent = () => {
        if (realpathSync(new URL(".", import.meta.url)) !== packageRoot
            || realpathSync(parent) !== join(packageRoot, basename(parent))) {
            throw new Error("Packaged asset directory escapes the generated canvas");
        }
    };
    checkParent();
    const before = lstatSync(url);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 32 * 1024) {
        throw new Error("Packaged asset must be a regular file under 32 KiB");
    }
    const fd = openSync(url, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
        | (constants.O_NONBLOCK ?? 0));
    try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.size > 32 * 1024
            || opened.dev !== before.dev || opened.ino !== before.ino) {
            throw new Error("Packaged asset changed or exceeds 32 KiB");
        }
        const buffer = Buffer.alloc(32 * 1024 + 1);
        let size = 0;
        while (size < buffer.length) {
            const count = readSync(fd, buffer, size, buffer.length - size, null);
            if (!count) break;
            size += count;
        }
        const after = fstatSync(fd);
        const current = lstatSync(url);
        if (size > 32 * 1024 || size !== opened.size || after.size !== opened.size
            || after.mtimeMs !== opened.mtimeMs || current.dev !== opened.dev
            || current.ino !== opened.ino || current.size !== opened.size
            || current.mtimeMs !== opened.mtimeMs) {
            throw new Error("Packaged asset changed or exceeds 32 KiB");
        }
        checkParent();
        return buffer.subarray(0, size);
    } finally { closeSync(fd); }
}

function readImageAsset(asset) {
    const bytes = readPackagedFile(new URL(`./assets/${asset.file}`, import.meta.url));
    if (!bytes.length || bytes.length > 32 * 1024
        || createHash("sha256").update(bytes).digest("hex") !== asset.hash) {
        throw new Error("Packaged image does not match its frozen hash");
    }
    return bytes;
}

function readImageControl(control) {
    const bytes = readPackagedFile(new URL(`./controls/${control.adapter}.mjs`, import.meta.url));
    if (!bytes.length || bytes.length > 32 * 1024
        || createHash("sha256").update(bytes).digest("hex") !== control.hash) {
        throw new Error("Packaged stock.image adapter does not match its frozen hash");
    }
    const definition = readPackagedFile(new URL(`./controls/${control.definition}.json`, import.meta.url));
    const parsed = JSON.parse(definition);
    if (createHash("sha256").update(definition).digest("hex") !== control.definitionHash
        || parsed.id !== "stock.image" || parsed.adapters?.generated !== control.adapter
        || JSON.stringify(Object.entries(parsed.value ?? {}).sort())
            !== JSON.stringify(Object.entries(imageValueContract).sort())) {
        throw new Error("Packaged stock.image definition does not match its frozen contract");
    }
    return bytes;
}
function readTextControl(control) {
    const bytes = readPackagedFile(new URL(`./controls/${control.adapter}.mjs`, import.meta.url));
    if (!bytes.length || bytes.length > 32 * 1024
        || createHash("sha256").update(bytes).digest("hex") !== control.hash) {
        throw new Error("Packaged stock.text adapter does not match its frozen hash");
    }
    const definition = readPackagedFile(new URL(`./controls/${control.definition}.json`, import.meta.url));
    const parsed = JSON.parse(definition);
    if (createHash("sha256").update(definition).digest("hex") !== control.definitionHash
        || parsed.id !== "stock.text" || parsed.adapters?.generated !== control.adapter
        || JSON.stringify(parsed.value) !== JSON.stringify({ type: "string" })) {
        throw new Error("Packaged stock.text definition does not match its frozen contract");
    }
    return bytes;
}
const APPEARANCE_PROPERTIES = {
    accent: "--accent-color",
    background: "--background-color-default",
    surface: "--background-color-elevated",
    secondary: "--background-color-secondary",
    text: "--text-color-default",
};

export function renderHtml(config, token = "") {
    if (!validRuntimeConfig(config)) throw new Error("Invalid generated canvas configuration");
    const appearanceCss = Object.entries(config.appearance ?? {}).map(([mode, options]) => {
        const colors = typeof options === "string" ? { accent: options } : options;
        const rule = Object.entries(colors).map(([key, value]) =>
            `${APPEARANCE_PROPERTIES[key]}: ${value};`).join(" ")
            + (colors.accent
                ? ` --grad-primary: linear-gradient(135deg, ${colors.accent}, color-mix(in srgb, ${colors.accent} 75%, black));`
                : "");
        return `:root[data-theme="${mode}"] { ${rule} }
@media (prefers-color-scheme: ${mode}) { :root:not([data-theme]) { ${rule} } }`;
    }).join("\n");
    const { canvas } = config;
    const isConstitution = (phase) => phase.replace(/^speckit\./, "") === "constitution";
    const phases = config.phases.filter((phase) => !isConstitution(phase));
    const hasConstitution = config.phases.some(isConstitution);
    const headingAdapter = config.textPlacements?.find((item) => item.id === "canvas.workflowListName"
        && item.slot === "workflow.heading");
    const descriptionAdapter = config.textPlacements?.find((item) => item.id === "canvas.description"
        && item.slot === "workflow.description");
    const intro = `<div><h2 id="workflow-heading">${headingAdapter
        ? `<span data-stock-text="workflow.heading" data-field-id="canvas.workflowListName" data-text-label="${escapeHtml(headingAdapter.label)}">${escapeHtml(canvas.workflowListName)}</span>`
        : escapeHtml(canvas.workflowListName)} <span class="muted" id="workflow-count">(0)</span></h2><p class="collection-description muted"${descriptionAdapter
        ? ` data-stock-text="workflow.description" data-field-id="canvas.description" data-text-label="${escapeHtml(descriptionAdapter.label)}"` : ""}>${escapeHtml(canvas.description)}</p></div>`;
    const regions = {
        collection: `<section id="instance-collection" class="instance-collection" aria-labelledby="workflow-heading">
        <div class="instance-collection-head">
            ${config.mainPageAsset
                ? `<div class="collection-intro"><span data-stock-image="workflow.intro" data-image-file="${escapeHtml(config.mainPageAsset.file)}" data-image-alt="${escapeHtml(canvas.displayName)} logo" data-image-class="collection-logo generated-image"></span>${intro}</div>`
                : intro}
            <button class="btn btn-secondary" id="new-workflow" type="button">+ New</button>
        </div>
        <div id="workflow-identity" class="workflow-identity-fields"${phases.length ? "" : " hidden"}>
            <label class="field" for="workflow-name">
                <span class="field-label" id="workflow-name-label">Workflow name <span class="muted">(optional)</span></span>
                <input class="phase-input-control" id="workflow-name" type="text" maxlength="120" placeholder="My workflow">
            </label>
            ${config.userProvidesSlug ? `<label class="field" for="workflow-slug">
                <span class="field-label" id="workflow-slug-label">Artifact directory slug <span class="muted">(optional)</span></span>
                <input class="phase-input-control" id="workflow-slug" type="text" maxlength="100" placeholder="your-slug">
            </label>` : ""}
        </div>
        <label id="workflow-search-field" class="workflow-search" for="workflow-search" hidden><span class="visually-hidden">Search workflows</span><input id="workflow-search" type="search" placeholder="Search workflows by name or directory"></label>
        <div id="workflow-list" class="instance-list" role="list" aria-label="Existing workflows" hidden></div>
        <div id="workflow-empty" class="instance-list" hidden><button id="create-first-workflow" class="instance-select empty-workflow" type="button"><span class="empty-workflow-mark" aria-hidden="true">+</span><span class="instance-select-main"><strong>No workflows yet</strong><span class="muted">Create a workflow to see it here.</span></span><span class="empty-workflow-action" aria-hidden="true">Create workflow &#8594;</span></button></div>
        <p id="workflow-list-status" class="muted" role="status" hidden></p>
    </section>`,
        details: readOnlySections(config.readOnlyFields, config.textPlacements),
        values: config.valueSources?.length ? '<section id="canvas-values" class="phase-card" aria-label="Canvas values"><h2>Canvas values</h2><div id="canvas-value-list"></div><p id="canvas-value-errors" role="alert"></p></section>' : "",
        controls: config.generatedControls?.map(({ id, label, adapter, control, properties, value }) =>
            `<section class="phase-card" aria-label="${escapeHtml(label)}">
                <h2>${escapeHtml(label)}</h2><div data-control-id="${escapeHtml(id)}"
                    data-field-label="${escapeHtml(label)}"
                    data-control-type="${escapeHtml(control)}"
                    data-contract="${escapeHtml(JSON.stringify({ type: "object", properties }))}"
                    data-module="/controls/${escapeHtml(adapter)}.mjs"
                    data-value="${escapeHtml(JSON.stringify(value))}"></div></section>`).join("") ?? "",
        pages: config.generatedPages?.length ? `<nav class="phase-navigation" aria-label="Canvas pages">
            <button class="btn btn-secondary" type="button" data-canvas-page="workflow" aria-current="page">${escapeHtml(config.workflowPage.title)}</button>
            ${config.generatedPages.map(({ id, title }) =>
                `<button class="btn btn-secondary" type="button" data-canvas-page="${escapeHtml(id)}">${escapeHtml(title)}</button>`).join("")}
        </nav>
        <section id="generated-page" class="phase-card" data-canvas-id="${escapeHtml(canvas.id)}"
            data-canvas-title="${escapeHtml(canvas.displayName)}" hidden></section>` : "",
        constitution: hasConstitution ? `<details id="constitution-card" class="constitution-card" aria-label="Project constitution" open>
            <summary><strong>Constitution</strong><span class="muted" id="constitution-status">Not run</span></summary>
            <div class="constitution-details"><p id="constitution-prerequisite">Project principles apply to every workflow.</p><p id="constitution-artifact-status" class="muted" role="status"></p>
            <div class="constitution-actions"><button class="btn btn-secondary" id="view-constitution" type="button" aria-describedby="constitution-artifact-status" hidden>View</button><button class="btn btn-secondary" id="run-constitution" type="button">Create / update</button></div></div>
        </details>` : "",
        message: '<p id="canvas-message" role="status"></p>',
        pipeline: `<div id="workflow-pipeline" data-module="/pages/${escapeHtml(config.workflowPage.adapter)}.mjs"
            data-phases="${escapeHtml(JSON.stringify(phaseContract(config).filter((step) => !step.project)
                .map((step) => ({ id: step.id, label: step.label, output: step.output,
                    outputs: step.outputs }))))}"></div>`,
    };
    const workflowContributions = config.workflowPage.slots.filter(({ id }) => id !== "workflow.phases"
        && config.fieldPlacements?.some((item) => item.page === "workflow" && item.slot === id))
        .map(({ id }) => `<section class="phase-card" data-workflow-slot="${escapeHtml(id)}"></section>`).join("");
    return `<!doctype html>
<html lang="en"${config.theme ? ` data-theme="${escapeHtml(config.theme)}"` : ""}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(canvas.displayName)}</title><style>${styles}\n${runtimeStyles}\n${appearanceCss}</style></head>
<body>
<header class="app-header">
    <div class="brand"><span class="brand-mark${config.brandAsset ? " brand-image" : ""}"${config.brandAsset
        ? ` data-stock-image="header.brand" data-image-file="${escapeHtml(config.brandAsset.file)}" data-image-alt="" data-image-class="generated-image"`
        : ' aria-hidden="true"'}>${config.brandAsset ? "" : "&#9671;"}</span><span class="brand-text">${escapeHtml(canvas.displayName)}</span></div>
    <div class="header-status"><button class="btn-icon" id="theme-toggle" type="button" title="Toggle theme" aria-label="Toggle theme">&#9680;</button><button class="btn btn-secondary" id="refresh-state" type="button">Refresh</button><span id="connection-status" class="conn conn-connecting" role="status">Connecting</span></div>
</header>
<main class="app-body workflow-surface">
    ${config.generatedPages?.length ? regions.pages : ""}
    ${config.generatedPages?.length ? '<div id="workflow-content" class="workflow-content">' : ""}
    ${WORKFLOW_REGIONS.filter((region) => !config.generatedPages?.length
        || (region !== "pages" && region !== "message")).map((region) =>
        regions[region] + (region === "pipeline" ? workflowContributions : "")).join("")}
    ${config.generatedPages?.length ? `</div>${regions.message}` : ""}
    ${config.generatedPages?.map(({ id, renderer, slots, values }) =>
        `<span hidden data-generated-renderer="${escapeHtml(id)}" data-module="/pages/${escapeHtml(renderer)}.mjs"
            data-values="${escapeHtml(JSON.stringify(Object.fromEntries((config.readOnlyFields ?? [])
                .filter((field) => values?.includes(field.id))
                .map(({ id, value }) => [id, value]))))}"
            data-asset-slots="${escapeHtml(JSON.stringify(slots ?? []))}"
            data-assets="${escapeHtml(JSON.stringify((config.generatedPageAssets ?? [])
                .filter((asset) => asset.page === id)))}"></span>`).join("") ?? ""}
    ${config.imageControl ? `<span hidden id="stock-image-registration"
        data-module="/controls/${escapeHtml(config.imageControl.adapter)}.mjs"
        data-assets="${escapeHtml(JSON.stringify([config.brandAsset, config.mainPageAsset,
            ...(config.generatedPageAssets ?? []),
            ...(config.fieldPlacements ?? []).map((item) => item.asset)].filter(Boolean)
            .map((asset) => asset.file)))}"></span>` : ""}
    ${config.textControl ? `<span hidden id="stock-text-registration"
        data-module="/controls/${escapeHtml(config.textControl.adapter)}.mjs"></span>` : ""}
    <span hidden id="generated-field-placements"
        data-placements="${escapeHtml(JSON.stringify(config.fieldPlacements ?? []))}"></span>
</main>
<dialog id="artifact-viewer" class="artifact-viewer" aria-labelledby="artifact-title"><header class="artifact-viewer-header"><button class="btn btn-secondary artifact-viewer-back" id="close-artifact" type="button">&#8592; Canvas</button><div class="artifact-viewer-title"><h2 id="artifact-title">Artifact</h2><code id="artifact-path" class="muted"></code></div></header><div class="artifact-viewer-body"><p id="artifact-message" role="status"></p><article id="artifact-content" class="artifact-viewer-md"></article></div></dialog>
<dialog id="delete-workflow-dialog" aria-labelledby="delete-workflow-title"><h2 id="delete-workflow-title">Delete <span id="delete-workflow-name"></span>?</h2><p>This permanently deletes the selected workflow directory and everything in it:</p><p><code id="delete-workflow-directory"></code></p><footer class="viewer-head"><button class="btn btn-secondary" id="cancel-delete-workflow" type="button">Cancel</button><button class="btn btn-danger" id="confirm-delete-workflow" type="button">Delete workflow</button></footer></dialog>
${hasConstitution ? `<dialog id="constitution-dialog" aria-labelledby="constitution-dialog-title"><h2 id="constitution-dialog-title">Create / update Constitution</h2><label class="field" for="constitution-args"><span class="field-label">Guidance (optional)</span><textarea class="phase-input-control" id="constitution-args"></textarea></label><p id="constitution-message" role="status"></p><footer class="viewer-head"><button class="btn btn-secondary" id="cancel-constitution" type="button">Cancel</button><button class="btn btn-primary" id="send-constitution" type="button">Run phase</button></footer></dialog>` : ""}
<script type="module" src="/ui/app.js?token=${escapeHtml(encodeURIComponent(token))}"></script>
</body></html>`;
}

export function createWorkflowRoutes(config, { runtime, instanceId, token, port, log = () => {} }) {
    const html = renderHtml(config, token);
    const clients = new Set();
    const json = (response, status, value) => response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value));
    const handle = async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
        let url;
        try { url = new URL(request.url, "http://127.0.0.1"); }
        catch { response.writeHead(400).end("Invalid URL"); return; }
        const supplied = request.headers["x-canvas-token"] ?? url.searchParams.get("token");
        const candidate = Buffer.from(typeof supplied === "string" ? supplied : "");
        const expected = Buffer.from(token);
        if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
            response.writeHead(401).end("Unauthorized"); return;
        }
        try {
            if (request.method === "GET" && ["/", "/ui/app.js", "/ui/markdown.mjs",
                "/ui/page-assets.mjs"].includes(url.pathname)) {
                const body = url.pathname === "/" ? html : url.pathname === "/ui/app.js"
                    ? script : url.pathname === "/ui/markdown.mjs" ? markdown : pageAssets;
                response.writeHead(200, { "Content-Type": `${url.pathname === "/" ? "text/html" : "text/javascript"}; charset=utf-8` }).end(body);
                return;
            }
            const imageAsset = [config.brandAsset, config.mainPageAsset,
                ...(config.generatedPageAssets ?? []),
                ...(config.fieldPlacements ?? []).map((item) => item.asset).filter(Boolean)]
                .find((asset) => asset && url.pathname === `/assets/${asset.file}`);
            if (request.method === "GET" && imageAsset) {
                const bytes = readImageAsset(imageAsset);
                response.writeHead(200, { "Content-Type": imageAsset.mime,
                    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
                    .end(bytes);
                return;
            }
            const moduleName = /^\/pages\/([a-z][a-z0-9-]{0,79})\.mjs$/.exec(url.pathname)?.[1];
            if (request.method === "GET" && moduleName
                && (config.workflowPage.adapter === moduleName
                    || config.generatedPages?.some((page) => page.renderer === moduleName))) {
                const module = config.workflowPage.adapter === moduleName
                    ? readWorkflowPage(config.workflowPage)
                    : readFileSync(new URL(`./pages/${moduleName}.mjs`, import.meta.url));
                response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(module);
                return;
            }
            const controlName = /^\/controls\/([a-z][a-z0-9-]{0,79})\.mjs$/.exec(url.pathname)?.[1];
            if (request.method === "GET" && controlName
                && (config.generatedControls?.some((item) => item.adapter === controlName)
                    || config.imageControl?.adapter === controlName
                    || config.textControl?.adapter === controlName
                    || config.fieldPlacements?.some((item) => item.adapter === controlName))) {
                const module = config.imageControl?.adapter === controlName
                    ? readImageControl(config.imageControl)
                    : config.textControl?.adapter === controlName
                        ? readTextControl(config.textControl)
                        : config.fieldPlacements?.find((item) => item.adapter === controlName)
                            ? readPlacementControl(config.fieldPlacements.find((item) => item.adapter === controlName))
                            : readFileSync(new URL(`./controls/${controlName}.mjs`, import.meta.url));
                response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" })
                    .end(module);
                return;
            }
            if (!runtime) throw new UserError("The Copilot session runtime is unavailable. Reopen the canvas.", 503);
            if (request.method === "GET" && url.pathname === "/api/events") {
                response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
                response.write("data: refresh\n\n");
                clients.add(response);
                request.on("close", () => clients.delete(response));
                return;
            }
            if (request.method === "GET" && url.pathname === "/api/state") return json(response, 200, await runtime.snapshot());
            if (request.method === "GET" && url.pathname === "/api/artifact") return json(response, 200, await runtime.artifact({
                phase: url.searchParams.get("phase"), itemId: url.searchParams.get("itemId"),
                ...(url.searchParams.has("output") ? { output: url.searchParams.get("output") } : {}),
            }));
            if (request.method !== "POST" || !["/api/run", "/api/autopilot/start", "/api/autopilot/stop", "/api/state", "/api/values", "/api/refresh", "/api/reveal", "/api/workflow/delete"].includes(url.pathname)) return json(response, 404, { error: "Not found" });
            const origin = request.headers.origin;
            if (origin && origin !== `http://127.0.0.1:${port()}`) throw new UserError("Untrusted request origin.", 403);
            if (!request.headers["content-type"]?.startsWith("application/json")) throw new UserError("Expected a JSON request.", 415);
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
                size += chunk.length;
                if (size > 128 * 1024) throw new UserError("Request is too large.", 413);
                chunks.push(chunk);
            }
            let input;
            try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new UserError("Invalid JSON request."); }
            if (!input || typeof input !== "object" || Array.isArray(input)) throw new UserError("Expected a JSON object.");
            const result = url.pathname === "/api/run" ? await runtime.run(input, instanceId)
                : url.pathname === "/api/autopilot/start" ? await runtime.startAutopilot(input, instanceId)
                    : url.pathname === "/api/autopilot/stop" ? await runtime.stopAutopilot(input, instanceId)
                : url.pathname === "/api/state" ? await runtime.save(input)
                    : url.pathname === "/api/values" ? await runtime.saveValue(input)
                    : url.pathname === "/api/reveal" ? await runtime.reveal(input)
                        : url.pathname === "/api/workflow/delete" ? await runtime.deleteWorkflow(input)
                            : await runtime.refresh();
            return json(response, ["/api/run", "/api/autopilot/start"].includes(url.pathname) ? 202 : 200, result);
        } catch (error) {
            if (!(error instanceof UserError)) await log("Generated canvas request failed. Check the local runtime and state permissions.");
            json(response, error instanceof UserError ? error.status : 500, {
                error: error instanceof UserError ? error.message : "Could not complete this action. Check the file and state permissions, then refresh.",
            });
        }
    };
    return {
        handle,
        broadcast: () => { for (const client of clients) client.write("data: refresh\n\n"); },
        close: () => {
            for (const client of clients) client.end();
            clients.clear();
        },
    };
}
