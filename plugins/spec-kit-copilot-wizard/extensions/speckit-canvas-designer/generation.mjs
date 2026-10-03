import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFrozenAsset } from "./pages.mjs";
import { validateValues } from "./settings.mjs";
import { decodeImage } from "./image.mjs";

const required = ["canvas.id", "canvas.displayName"];
const reserved = new Set(["speckit-canvas-designer", "speckit-wizard", "speckit-canvas-generator"]);
const REQUEST_LIMIT = 512 * 1024;

export function validateEssentials(model, values) {
    const setup = model.pages.find((page) => page.page === "canvas-settings-setup");
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
        const rule = model.constraints[id];
        const value = values[id];
        if (rule?.type !== "string" || !value.trim()) {
            throw new Error(`Invalid Essentials field: ${id}`);
        }
        result[id] = value.trim();
    }
    for (const id of ["canvas.description", "canvas.workflowListName"]) {
        if (Object.hasOwn(result, id)) result[id] = result[id].trim();
    }
    if (reserved.has(result["canvas.id"])) throw new Error("Canvas ID must be non-reserved");
    return result;
}

export async function freezeGeneration({ model, values, handoff, project, workspace }) {
    const essentials = validateEssentials(model, values);
    const generatedFields = (model.contributions ?? [])
        .filter((item) => item.generatedBinding?.presentation === "stock.readonly")
        .map((item) => ({ id: item.field.id, label: item.field.label,
            maxLength: model.constraints[item.field.id].maxLength,
            ...(item.generatedBinding.section ? { section: item.generatedBinding.section } : {}) }));
    const imageContributions = (model.contributions ?? [])
        .filter((item) => item.field.type === "image"
            && item.generatedBinding?.presentation === "asset");
    if (imageContributions.length > 1) throw new Error("Generated header accepts only one image asset");
    const generatedAssets = imageContributions.flatMap((item) => {
        const image = decodeImage(values[item.field.id]);
        return image ? [{ id: item.field.id, slot: item.generatedBinding.slot,
            mime: image.mime, hash: createHash("sha256").update(image.bytes).digest("hex"),
            content: image.bytes.toString("base64") }] : [];
    });
    const controlContributions = (model.contributions ?? [])
        .filter((item) => item.generatedBinding?.presentation === "control");
    if (controlContributions.length > 30) {
        throw new Error("Generated controls exceed the 30-control limit");
    }
    const checkout = await realpath(project);
    const specify = join(checkout, ".specify");
    const generatedPages = [];
    const asset = async (item) => {
        if (!item || item.strategy !== "replace") throw new Error("Missing validated replace-only generated asset");
        const bytes = await readFrozenAsset(item, specify);
        return { name: item.name, kind: item.kind, sourceId: item.sourceId,
            hash: item.hash, content: bytes.toString("base64") };
    };
    for (const page of model.generatedPages ?? []) {
        const definition = model.templates.find((item) => item.name === page.name
            && item.kind === "generated.page");
        const renderer = model.templates.find((item) => item.name === page.renderer
            && item.kind === "generated.renderer");
        if (!definition || !renderer) throw new Error(`${page.name}: missing validated generated page assets`);
        const assets = await Promise.all([definition, renderer].map(asset));
        generatedPages.push({ id: page.id, title: page.title, renderer: page.renderer,
            ...(page.values ? { values: page.values } : {}), assets });
    }
    const valueSources = [];
    for (const value of model.valueSources ?? []) {
        const definition = model.templates.find((entry) => entry.name === value.name
            && entry.kind === "value.definition");
        if (!definition) throw new Error(`${value.name}: missing validated value definition`);
        const provider = value.source.kind === "provider"
            ? model.templates.find((entry) => entry.name === value.source.module
                && entry.kind === "value.provider") : null;
        if (value.source.kind === "provider" && !provider) {
            throw new Error(`${value.name}: missing validated value provider`);
        }
        valueSources.push({ id: value.id, label: value.label, schema: value.schema,
            source: value.source, presentation: value.presentation,
            ...(value.section ? { section: value.section } : {}),
            assets: await Promise.all([definition, ...(provider ? [provider] : [])].map(asset)) });
    }
    const generatedControls = [];
    for (const contribution of controlContributions) {
        const control = model.controls.find((entry) => entry.id === contribution.field.control);
        if (!control) throw new Error(`${contribution.name}: missing shared control`);
        const names = [
            model.templates.find((entry) => entry.kind === "control.definition"
                && entry.name === contribution.requires.find((name) =>
                    model.templates.some((item) => item.name === name && item.kind === "control.definition"))),
            model.templates.find((entry) => entry.name === control.adapters.generated
                && entry.kind === "generated.adapter"),
        ];
        generatedControls.push({ id: contribution.field.id, label: contribution.field.label,
            control: control.id, slot: contribution.generatedBinding.slot,
            value: values[contribution.field.id], assets: await Promise.all(names.map(asset)) });
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
        ...(generatedControls.length ? { generatedControls } : {}),
        ...(generatedAssets.length ? { generatedAssets } : {}),
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
