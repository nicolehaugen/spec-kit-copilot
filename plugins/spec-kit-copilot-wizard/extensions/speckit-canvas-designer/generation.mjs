import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isWindowsDeviceName, readFrozenAsset } from "./pages.mjs";
import { validateValues } from "./settings.mjs";

const required = ["canvas.id", "canvas.displayName"];
const reserved = new Set(["speckit-canvas-designer", "speckit-wizard", "speckit-canvas-generator"]);
const REQUEST_LIMIT = 4 * 1024 * 1024;

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
    if (typeof values?.["canvas.id"] === "string"
        && (reserved.has(values["canvas.id"]) || isWindowsDeviceName(values["canvas.id"]))) {
        throw new Error("Canvas ID must be non-reserved");
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
    if (!result["canvas.id"] || !result["canvas.displayName"]
        || reserved.has(result["canvas.id"]) || isWindowsDeviceName(result["canvas.id"])) {
        throw new Error("Canvas ID and Title must be valid and non-reserved");
    }
    return result;
}

export async function freezeGeneration({ model, values, handoff, project, workspace }) {
    const essentials = validateEssentials(model, values);
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
        generatedPages.push({ id: page.id, title: page.title, renderer: page.renderer, assets });
    }
    const generatedFields = [];
    const generatedControls = [];
    const controlAssets = new Map();
    for (const contribution of model.contributions ?? []) {
        const binding = contribution.generatedBinding;
        if (!binding) continue;
        const { id, label } = contribution.field;
        const rule = model.constraints[id];
        if (binding.presentation === "stock.readonly") {
            if (rule?.type !== "string") {
                throw new Error(`${id}: generated stock field requires a string constraint`);
            }
            generatedFields.push({ id, label, maxLength: rule.maxLength,
                ...(binding.section ? { section: binding.section } : {}) });
            continue;
        }
        if (binding.presentation !== "control" || rule?.type !== "object") {
            throw new Error(`${id}: incompatible generated binding`);
        }
        if (generatedControls.length >= 30) {
            throw new Error("Generated controls exceed the 30-control limit");
        }
        const control = model.controls.find((entry) => entry.id === contribution.field.control);
        if (!control) throw new Error(`${contribution.name}: missing shared control`);
        const definition = model.templates.find((entry) => entry.name === control.template
            && entry.kind === "control.definition");
        if (!definition || contribution.requires?.length !== 1
            || contribution.requires[0] !== definition.name) {
            throw new Error(`${contribution.name}: missing matching shared control definition`);
        }
        const names = [
            definition,
            model.templates.find((entry) => entry.name === control.adapters.generated
                && entry.kind === "generated.adapter"),
        ];
        if (!controlAssets.has(control.id)) {
            controlAssets.set(control.id, { control: control.id,
                assets: await Promise.all(names.map(asset)) });
        }
        generatedControls.push({ id, label, control: control.id, slot: binding.slot,
            value: essentials[id] });
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
        sourceFingerprint: handoff.sourceFingerprint, settingsRevision: model.settingsRevision,
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
        ...(controlAssets.size ? { controlAssets: [...controlAssets.values()] } : {}),
    };
    const payload = JSON.stringify(request);
    request.integrity = createHash("sha256").update(payload).digest("hex");
    const serialized = JSON.stringify(request);
    if (Buffer.byteLength(serialized) > REQUEST_LIMIT) {
        throw new Error("Frozen generation request exceeds 4 MiB");
    }
    const folder = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId,
        "generations", requestId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "request.json"), serialized, { flag: "wx" });
    return { requestId, target: request.target };
}
