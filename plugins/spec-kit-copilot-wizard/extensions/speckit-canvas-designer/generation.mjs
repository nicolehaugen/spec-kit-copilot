import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateValues } from "./settings.mjs";

const fields = ["canvas.id", "canvas.displayName", "canvas.description",
    "canvas.workflowListName", "workflowSlug.userProvided"];
const reserved = new Set(["speckit-canvas-designer", "speckit-wizard", "speckit-canvas-generator"]);
const REQUEST_LIMIT = 512 * 1024;

export function validateEssentials(model, values) {
    const setup = model.pages.find((page) => page.page === "canvas-settings-setup");
    if (!setup || setup.error || !Array.isArray(setup.fields)
        || fields.some((id) => !setup.fields.some((field) => field.id === id))) {
        throw new Error("Essentials must load with all required fields before generation");
    }
    if (!values || typeof values !== "object" || Array.isArray(values)
        || Object.keys(values).some((key) => !fields.includes(key))) {
        throw new Error("Invalid Essentials values");
    }
    const result = {};
    for (const id of fields) {
        const rule = model.constraints[id];
        const value = values[id];
        if (!rule || typeof value !== rule.type
            || (rule.type === "string" && (value.length < (rule.minLength ?? 0)
                || value.length > rule.maxLength
                || (rule.pattern && !new RegExp(rule.pattern).test(value))))) {
            throw new Error(`Invalid Essentials field: ${id}`);
        }
        result[id] = rule.type === "string" ? value.trim() : value;
    }
    if (!result["canvas.id"] || !result["canvas.displayName"]
        || reserved.has(result["canvas.id"])) throw new Error("Canvas ID and Title must be valid and non-reserved");
    return result;
}

export async function freezeGeneration({ model, values, handoff, project, workspace }) {
    validateValues(values, model.constraints);
    const essentials = validateEssentials(model,
        Object.fromEntries(fields.map((id) => [id, values[id]])));
    const generatedFields = (model.contributions ?? [])
        .filter((item) => item.generatedBinding?.presentation === "stock.readonly")
        .map((item) => ({ id: item.field.id, label: item.field.label,
            maxLength: model.constraints[item.field.id].maxLength,
            ...(item.generatedBinding.section ? { section: item.generatedBinding.section } : {}) }));
    const generatedPages = [];
    const asset = async (item) => {
        if (!item || item.strategy !== "replace") throw new Error("Missing validated replace-only generated asset");
        const bytes = await readFile(item.path);
        if (bytes.length > 32 * 1024 || await realpath(item.path) !== item.path
            || createHash("sha256").update(bytes).digest("hex") !== item.hash) {
            throw new Error(`${item.name}: generated asset changed since Designer opened; reopen Designer`);
        }
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
    const generatedControls = [];
    for (const contribution of model.contributions ?? []) {
        if (contribution.generatedBinding?.presentation !== "control") continue;
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
    const checkout = await realpath(project);
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
        values: { ...essentials,
            ...Object.fromEntries(generatedFields.map(({ id }) => [id, values[id]])),
            ...Object.fromEntries(generatedControls.map(({ id, value }) => [id, value])) },
        ...(generatedFields.length ? { generatedFields } : {}),
        ...(generatedPages.length ? { generatedPages } : {}),
        ...(generatedControls.length ? { generatedControls } : {}),
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
