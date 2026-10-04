import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readFrozenAsset } from "./pages.mjs";
import { validateValues } from "./settings.mjs";
import { decodeImage } from "./image.mjs";

const required = ["canvas.id", "canvas.displayName"];
const reserved = new Set(["speckit-canvas-designer", "speckit-wizard", "speckit-canvas-generator"]);
const canvasIdPattern = /^[a-z0-9][a-z0-9-]{0,99}$/;
const REQUEST_LIMIT = 512 * 1024;

export function validateEssentials(model, values) {
    const setup = model.pages.find((page) => page.page === "designer-essentials");
    if (!setup || setup.error || !Array.isArray(setup.fields)
        || required.some((id) => !setup.fields.some((field) => field.id === id))) {
        throw new Error("Essentials must load with Canvas ID and Title before generation");
    }
    const failed = model.pages.find((page) => page.error);
    if (failed) {
        throw new Error(`Cannot generate while ${failed.page} is invalid: ${failed.error.reason}`);
    }
    validateValues(values, model.constraints);
    const result = { ...values };
    for (const id of required) {
        result[id] = values[id].trim();
    }
    for (const id of ["canvas.description", "canvas.workflowListName"]) {
        if (Object.hasOwn(result, id)) result[id] = result[id].trim();
    }
    return result;
}

async function validateAdapterValues(model, values, project) {
    const specify = join(await realpath(project), ".specify");
    const modules = new Map();
    for (const page of model.pages) {
        for (const field of page.fields ?? []) {
            const name = model.adapters[field.control];
            const asset = model.templates.find((item) =>
                item.name === name && item.kind === "designer.control-adapter");
            const control = model.controls.find((item) => item.id === field.control);
            if (!asset || !control) throw new Error(`Missing Designer adapter for ${field.label} (${field.id})`);
            if (!modules.has(name)) {
                const bytes = await readFrozenAsset(asset, specify);
                const module = await import(`data:text/javascript;base64,${bytes.toString("base64")}`);
                if (module.controlId !== control.id
                    || !isDeepStrictEqual(module.valueContract, control.value)
                    || typeof module.validate !== "function") {
                    throw new Error(`${name}: incompatible Designer adapter exports`);
                }
                modules.set(name, module);
            }
            let valid;
            try {
                valid = modules.get(name).validate(values[field.id], field);
            } catch (error) {
                throw new Error(`${field.label} (${field.id}) validator failed: ${error.message}`, { cause: error });
            }
            if (typeof valid !== "boolean") {
                throw new Error(`${field.label} (${field.id}) validator must return a boolean`);
            }
            if (!valid) throw new Error(`Invalid ${field.label} (${field.id})`);
        }
    }
}

export async function freezeGeneration({ model, values, handoff, project, workspace }) {
    const essentials = validateEssentials(model, values);
    await validateAdapterValues(model, essentials, project);
    if (!canvasIdPattern.test(essentials["canvas.id"]) || reserved.has(essentials["canvas.id"])) {
        throw new Error("Invalid frozen Canvas ID for generated extension path");
    }
    const generatedFields = (model.contributions ?? [])
        .filter((item) => item.generatedBinding?.presentation === "stock.readonly"
            && !["canvas.description", "canvas.workflowListName"].includes(item.field.id))
        .map((item) => ({ id: item.field.id, label: item.field.label,
            maxLength: model.constraints[item.field.id].maxLength,
            ...(item.generatedBinding.section ? { section: item.generatedBinding.section } : {}) }));
    const textContributions = (model.contributions ?? []).filter((item) =>
        item.field.control === "stock.text"
        && (item.generatedBinding?.presentation === "text"
            || item.generatedBinding?.presentation === "stock.readonly"
                && !["canvas.description", "canvas.workflowListName"].includes(item.field.id)));
    const imageContributions = (model.contributions ?? [])
        .filter((item) => item.field.type === "image"
            && item.generatedBinding?.presentation === "asset");
    if (imageContributions.length > 10
        || new Set(imageContributions.map((item) =>
            `${item.generatedBinding.page ?? "workflow"}:${item.generatedBinding.slot}`)).size
            !== imageContributions.length) {
        throw new Error("Generated asset slots must be unique and at most ten");
    }
    const checkout = await realpath(project);
    const specify = join(checkout, ".specify");
    const asset = async (item) => {
        if (!item || item.strategy !== "replace") throw new Error("Missing validated replace-only generated asset");
        const bytes = await readFrozenAsset(item, specify);
        return { name: item.name, kind: item.kind, sourceId: item.sourceId,
            hash: item.hash, content: bytes.toString("base64") };
    };
    let definitions;
    const generatedControl = async (id) => {
        const controls = model.controls?.filter((entry) => entry.id === id) ?? [];
        definitions ??= Promise.all((model.templates ?? [])
            .filter((entry) => entry.kind === "shared.control-definition").map(async (entry) => {
                const bytes = await readFrozenAsset(entry, specify);
                let document;
                try { document = JSON.parse(bytes.toString("utf8")); }
                catch { throw new Error(`${entry.name}: invalid frozen control definition`); }
                return { entry, document };
            }));
        const matches = (await definitions).filter(({ document }) => document?.id === id);
        const control = controls[0];
        const adapter = model.templates?.find((entry) => entry.kind === "generated.control-adapter"
            && entry.name === control?.adapters?.generated);
        if (controls.length !== 1 || matches.length !== 1 || !adapter
            || matches[0].document.adapters?.generated !== adapter.name) {
            throw new Error(`Missing paired ${id} definition or generated adapter`);
        }
        return { control, definition: matches[0].entry, adapter };
    };
    let generatedImageControl;
    if (imageContributions.length) {
        const { control, definition, adapter } = await generatedControl("stock.image");
        if (imageContributions.some((item) => item.field.control !== control.id)) {
            throw new Error("Image contribution uses an incompatible shared control");
        }
        generatedImageControl = { control: control.id,
            assets: await Promise.all([definition, adapter].map(asset)) };
    }
    const generatedAssets = imageContributions.flatMap((item) => {
        const image = decodeImage(values[item.field.id]);
        return image ? [{ id: item.field.id, label: item.field.label,
            slot: item.generatedBinding.slot,
            ...(item.generatedBinding.page ? { page: item.generatedBinding.page } : {}),
            mime: image.mime, hash: createHash("sha256").update(image.bytes).digest("hex"),
            content: image.bytes.toString("base64") }] : [];
    });
    const controlContributions = (model.contributions ?? [])
        .filter((item) => item.generatedBinding?.presentation === "control");
    if (controlContributions.length > 30) {
        throw new Error("Generated controls exceed the 30-control limit");
    }
    const generatedPages = [];
    let generatedTextControl;
    let generatedTextPlacements;
    if (textContributions.length) {
        generatedTextPlacements = textContributions.map((item) => ({
            id: item.field.id, label: item.field.label,
            presentation: item.generatedBinding.presentation,
            slot: item.generatedBinding.slot ?? "details.content",
        }));
        const visual = generatedTextPlacements.filter((item) => item.presentation === "text");
        if (generatedTextPlacements.length > 100
            || new Set(generatedTextPlacements.map((item) => item.id)).size
                !== generatedTextPlacements.length
            || new Set(visual.map((item) => item.slot)).size !== visual.length
            || generatedTextPlacements.some((item) => item.presentation === "text"
                ? !((item.id === "canvas.description" && item.slot === "workflow.description")
                    || (item.id === "canvas.workflowListName" && item.slot === "workflow.heading"))
                : item.slot !== "details.content")) {
            throw new Error("Invalid or duplicate generated stock.text placement");
        }
        const { control, definition, adapter } = await generatedControl("stock.text");
        generatedTextControl = { control: control.id,
            assets: await Promise.all([definition, adapter].map(asset)) };
    }
    for (const page of model.generatedPages ?? []) {
        const definition = model.templates.find((item) => item.name === page.name
            && item.kind === "generated.added-page-definition");
        const renderer = model.templates.find((item) => item.name === page.renderer
            && item.kind === "generated.added-page-renderer");
        if (!definition || !renderer) throw new Error(`${page.name}: missing validated generated page assets`);
        const assets = await Promise.all([definition, renderer].map(asset));
        generatedPages.push({ id: page.id, title: page.title, renderer: page.renderer,
            ...(page.values ? { values: page.values } : {}),
            ...(page.slots ? { slots: page.slots } : {}), assets });
    }
    const workflowDefinition = model.templates?.find((item) =>
        item.name === model.workflowPage?.name && item.kind === "generated.workflow-page-definition");
    const pipelineRenderer = model.templates?.find((item) =>
        item.name === model.workflowPage?.pipeline && item.kind === "generated.pipeline-renderer");
    if (!workflowDefinition || !pipelineRenderer) {
        throw new Error("Missing validated Workflow page definition or pipeline renderer");
    }
    const workflowPage = { id: "workflow", regions: model.workflowPage.regions,
        pipeline: model.workflowPage.pipeline,
        assets: await Promise.all([workflowDefinition, pipelineRenderer].map(asset)) };
    const valueSources = [];
    for (const value of model.valueSources ?? []) {
        const definition = model.templates.find((entry) => entry.name === value.name
            && entry.kind === "generated.value-definition");
        if (!definition) throw new Error(`${value.name}: missing validated value definition`);
        const provider = value.source.kind === "computed"
            ? model.templates.find((entry) => entry.name === value.source.module
                && entry.kind === "generated.computed-value-provider") : null;
        if (value.source.kind === "computed" && !provider) {
            throw new Error(`${value.name}: missing validated value provider`);
        }
        valueSources.push({ id: value.id, label: value.label, schema: value.schema,
            source: value.source, presentation: value.presentation,
            ...(value.section ? { section: value.section } : {}),
            assets: await Promise.all([definition, ...(provider ? [provider] : [])].map(asset)) });
    }
    const generatedControls = [];
    for (const contribution of controlContributions) {
        const { control, definition, adapter } = await generatedControl(contribution.field.control);
        generatedControls.push({ id: contribution.field.id, label: contribution.field.label,
            control: control.id, slot: contribution.generatedBinding.slot,
            value: values[contribution.field.id],
            assets: await Promise.all([definition, adapter].map(asset)) });
    }
    if (!handoff?.workflow?.installed) throw new Error("Workflow runtime inventory is not available in this handoff");
    const target = join(checkout, ".github", "extensions", essentials["canvas.id"]);
    try {
        await stat(target);
        throw new Error(`Canvas already exists: ${target}`);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    const requestId = randomUUID();
    const request = {
        schemaVersion: 1, requestId, handoffId: handoff.handoffId,
        project: checkout, target: `.github/extensions/${essentials["canvas.id"]}/`,
        sourceFingerprint: handoff.sourceFingerprint, settingsRevision: model.revision,
        canvas: { id: essentials["canvas.id"], displayName: essentials["canvas.displayName"],
            description: essentials["canvas.description"] || "Spec Kit workflow canvas.",
            workflowListName: essentials["canvas.workflowListName"] || "Workflows" },
        workflow: { selectedPhases: handoff.workflow.selectedPhases },
        installed: handoff.workflow.installed,
        values: essentials,
        fieldConstraints: model.constraints,
        ...(generatedFields.length ? { generatedFields } : {}),
        ...(generatedPages.length ? { generatedPages } : {}),
        workflowPage,
        ...(generatedControls.length ? { generatedControls } : {}),
        ...(generatedAssets.length ? { generatedAssets } : {}),
        ...(generatedImageControl ? { generatedImageControl } : {}),
        ...(generatedTextControl ? { generatedTextControl, generatedTextPlacements } : {}),
        ...(valueSources.length ? { valueSources } : {}),
    };
    const payload = JSON.stringify(request);
    request.integrity = createHash("sha256").update(payload).digest("hex");
    const serialized = JSON.stringify(request);
    if (Buffer.byteLength(serialized) > REQUEST_LIMIT) {
        throw new Error("Frozen generation request exceeds 512KB");
    }
    const folder = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId,
        "generations", requestId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "request.json"), serialized, { flag: "wx" });
    return { requestId, target: request.target };
}
