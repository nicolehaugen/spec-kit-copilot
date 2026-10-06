import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { isWindowsDeviceName, readFrozenAsset } from "./pages.mjs";
import { initialOutputs, validateValues } from "./settings.mjs";
import { decodeImage } from "./image.mjs";
import { validateConfirmedOutputs } from "./handoff.mjs";
import { specifySpawnOptions } from "../speckit-wizard-canvas/env/specify-invocation.mjs";

const required = ["canvas.id", "canvas.displayName"];
const reserved = new Set(["speckit-canvas-designer", "speckit-wizard", "speckit-canvas-generator"]);
const canvasIdPattern = /^[a-z0-9][a-z0-9-]{0,99}$/;
const REQUEST_LIMIT = 4 * 1024 * 1024;
const execFileAsync = promisify(execFile);

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
    if (typeof values?.["canvas.id"] === "string"
        && (reserved.has(values["canvas.id"]) || isWindowsDeviceName(values["canvas.id"]))) {
        throw new Error("Canvas ID (canvas.id) must be non-reserved");
    }
    validateValues(values, model.constraints);
    const result = { ...values };
    for (const id of required) {
        result[id] = values[id].trim();
    }
    for (const id of ["canvas.description", "canvas.workflowListName"]) {
        if (Object.hasOwn(result, id)) result[id] = result[id].trim();
    }
    if (!result["canvas.id"] || !result["canvas.displayName"]
        || !canvasIdPattern.test(result["canvas.id"])
        || result["canvas.displayName"].length > 120
        || reserved.has(result["canvas.id"]) || isWindowsDeviceName(result["canvas.id"])) {
        throw new Error("Canvas ID and Title must be valid and non-reserved");
    }
    return result;
}

async function validateAdapterValues(model, values, project) {
    const specify = join(await realpath(project), ".specify");
    const modules = new Map();
    for (const page of model.pages) {
        for (const field of page.fields ?? []) {
            if (page.fixedControl === "designer.identity"
                && ["canvas.id", "canvas.displayName"].includes(field.id)) continue;
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

export async function readCurrentInstalledVersions(project, frozen, run = execFileAsync) {
    const inventory = { presets: [], extensions: [], bundles: [] };
    const warnings = [];
    for (const [kind, command] of [["presets", "preset"], ["extensions", "extension"], ["bundles", "bundle"]]) {
        const relevantIds = new Set(frozen[kind].map((entry) => entry.id));
        if (!relevantIds.size) continue;
        try {
            const { stdout } = await run(process.platform === "win32" ? "specify.exe" : "specify",
                [command, "list", "--json"],
                await specifySpawnOptions(project, { timeout: 10000, maxBuffer: 128 * 1024 }));
            let entries;
            try { entries = JSON.parse(stdout); }
            catch { throw new Error(`Invalid ${kind} JSON from Specify`); }
            if (!Array.isArray(entries)) {
                throw new Error(`Invalid ${kind} inventory from Specify`);
            }
            entries = entries.filter((entry) =>
                relevantIds.has(kind === "bundles" ? entry?.bundle_id : entry?.id));
            if (entries.length > 40) {
                throw new Error(`Invalid ${kind} inventory from Specify`);
            }
            const seen = new Set();
            inventory[kind] = entries.map((entry) => {
                const id = kind === "bundles" ? entry?.bundle_id : entry?.id;
                if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)
                    || typeof entry.version !== "string"
                    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(entry.version)
                    || (kind !== "bundles" && !Number.isSafeInteger(entry.priority))
                    || seen.has(id)) {
                    throw new Error(`Invalid ${kind} package identity or version from Specify`);
                }
                seen.add(id);
                return { id, version: entry.version,
                    ...(kind === "bundles" ? {} : { priority: entry.priority }) };
            });
        } catch (error) {
            inventory[kind] = [];
            warnings.push(`Could not read ${kind} inventory from Specify: ${error.message}.`);
        }
    }
    return { inventory, warnings };
}

export function reconcileInstalledVersions(frozen, inventory) {
    const installed = { presets: [], extensions: [], bundles: [] };
    const warnings = [];
    for (const kind of ["presets", "extensions", "bundles"]) {
        for (const entry of frozen[kind]) {
            const current = inventory[kind].find((item) => item.id === entry.id);
            const version = current?.version ?? "unverified";
            installed[kind].push(kind === "bundles" ? { id: entry.id, version }
                : { id: entry.id, version,
                    ...(Number.isSafeInteger(current?.priority) ? { priority: current.priority } : {}) });
            if (version !== entry.version) {
                warnings.push(`${kind} ${entry.id}: Wizard version ${entry.version}, installed version ${version}.`);
            }
        }
    }
    return { installed, warnings };
}

export async function freezeGeneration({ model, values, outputs = model.outputs, handoff, project, workspace,
    runtimeInventory, inventoryWarning }) {
    const essentials = validateEssentials(model, values);
    if (outputs !== undefined) validateConfirmedOutputs(outputs, handoff.workflow.selectedPhases,
        initialOutputs(handoff));
    await validateAdapterValues(model, essentials, project);
    if (!canvasIdPattern.test(essentials["canvas.id"])
        || reserved.has(essentials["canvas.id"]) || isWindowsDeviceName(essentials["canvas.id"])) {
        throw new Error("Invalid frozen Canvas ID for generated extension path");
    }
    const textContributions = (model.contributions ?? []).filter((item) =>
        item.field.control === "stock.text"
        && (item.generatedBinding?.presentation === "text"
            || item.generatedBinding?.presentation === "stock.readonly"
                && !["canvas.description", "canvas.workflowListName"].includes(item.field.id)));
    const imageContributions = (model.contributions ?? [])
        .filter((item) => item.field.type === "image"
            && item.generatedBinding?.presentation === "asset");
    if (new Set(imageContributions.map((item) =>
            `${item.generatedBinding.page ?? "workflow"}:${item.generatedBinding.slot}`)).size
            !== imageContributions.length) {
        throw new Error("Generated asset slots must be unique");
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
    if (generatedAssets.length > 10) {
        throw new Error("Generated images exceed the 10-image limit");
    }
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
        generatedPages.push({ id: page.id, title: page.title,
            ...(page.order !== undefined ? { order: page.order } : {}),
            renderer: page.renderer,
            ...(page.values ? { values: page.values } : {}),
            ...(page.slots ? { slots: page.slots } : {}), assets });
    }
    const defaultPageOrder = new Map(generatedPages.map((page, index) => [page.id, index + 1]));
    generatedPages.sort((a, b) => (a.order ?? defaultPageOrder.get(a.id))
        - (b.order ?? defaultPageOrder.get(b.id)) || a.id.localeCompare(b.id));
    const workflowDefinition = model.templates?.find((item) =>
        item.name === model.workflowPage?.name && item.kind === "generated.workflow-page-definition");
    const controlDefinition = model.templates?.find((item) =>
        item.name === "generated-phase-control" && item.kind === "generated.phase-control-definition");
    const controlBytes = controlDefinition && await readFrozenAsset(controlDefinition, specify);
    let phaseControl;
    try { phaseControl = controlBytes && JSON.parse(controlBytes.toString("utf8")); }
    catch { throw new Error("Invalid frozen phase control definition"); }
    const adapter = model.templates?.find((item) =>
        item.name === phaseControl?.adapter && item.kind === "generated.phase-control-adapter");
    if (!workflowDefinition || !controlDefinition || !adapter
        || phaseControl?.id !== "workflow-phases"
        || phaseControl?.placement?.page !== "workflow"
        || phaseControl?.placement?.slot !== "workflow.phases") {
        throw new Error("Missing validated Workflow page, phase control, or adapter");
    }
    const workflowPage = { id: "workflow", title: model.workflowPage.title,
        order: model.workflowPage.order, slots: model.workflowPage.slots,
        assets: await Promise.all([workflowDefinition, controlDefinition, adapter].map(asset)) };
    const designerFields = new Map();
    const fieldPlacements = await Promise.all((model.fieldPlacements ?? []).map(async (placement) => {
        const definition = model.templates.find((item) => item.name === placement.name
            && item.kind === "generated.field-placement");
        if (!definition) throw new Error(`${placement.name}: missing validated field placement`);
        const field = model.pages.flatMap((page) => page.fields ?? [])
            .find((candidate) => candidate.id === placement.field);
        const value = model.valueSources?.find((candidate) => candidate.id === placement.field);
        if (!field && !value) throw new Error(`${placement.name}: missing resolved field`);
        if (field) {
            designerFields.set(field.id, { id: field.id, label: field.label,
                control: field.control });
        }
        return { id: placement.id, page: placement.page, slot: placement.slot,
            field: placement.field, label: (field ?? value).label,
            order: placement.order, control: placement.control,
            assets: [await asset(definition)] };
    }));
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
    const generatedFields = [];
    const generatedControls = [];
    const controlAssets = new Map();
    for (const contribution of model.contributions ?? []) {
        const binding = contribution.generatedBinding;
        if (!binding) continue;
        const { id, label } = contribution.field;
        const rule = model.constraints[id];
        if (binding.presentation === "stock.readonly") {
            if (["canvas.description", "canvas.workflowListName"].includes(id)) continue;
            if (rule?.type !== "string") {
                throw new Error(`${id}: generated stock field requires a string constraint`);
            }
            generatedFields.push({ id, label, maxLength: rule.maxLength,
                ...(binding.section ? { section: binding.section } : {}) });
            continue;
        }
        if (binding.presentation === "text" || binding.presentation === "asset") continue;
        if (binding.presentation !== "control" || rule?.type !== "object") {
            throw new Error(`${id}: incompatible generated binding`);
        }
        if (generatedControls.length >= 30) {
            throw new Error("Generated controls exceed the 30-control limit");
        }
        const control = model.controls.find((entry) => entry.id === contribution.field.control);
        if (!control) throw new Error(`${contribution.name}: missing shared control`);
        const definition = model.templates.find((entry) => entry.name === control.template
            && entry.kind === "shared.control-definition");
        if (!definition || (contribution.requires !== undefined
            && (contribution.requires.length !== 1
                || contribution.requires[0] !== definition.name))) {
            throw new Error(`${contribution.name}: missing matching shared control definition`);
        }
        if (!controlAssets.has(control.id)) {
            const paired = await generatedControl(control.id);
            if (paired.definition.name !== definition.name) {
                throw new Error(`${contribution.name}: mismatched shared control definition`);
            }
            controlAssets.set(control.id, { control: control.id,
                assets: await Promise.all([paired.definition, paired.adapter].map(asset)) });
        }
        generatedControls.push({ id, label, control: control.id, slot: binding.slot,
            value: essentials[id] });
    }
    for (const placement of model.fieldPlacements ?? []) {
        if (model.controls.find((control) => control.id === placement.control)?.value.type !== "object"
            || controlAssets.has(placement.control)) continue;
        const paired = await generatedControl(placement.control);
        controlAssets.set(placement.control, { control: placement.control,
            assets: await Promise.all([paired.definition, paired.adapter].map(asset)) });
    }
    if (!handoff?.workflow?.installed) throw new Error("Workflow runtime inventory is not available in this handoff");
    const target = join(checkout, ".github", "extensions", essentials["canvas.id"]);
    try {
        await stat(target);
        throw new Error(`Canvas already exists: ${target}`);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    const actual = runtimeInventory === undefined ? undefined
        : reconcileInstalledVersions(handoff.workflow.installed, runtimeInventory);
    const requestId = randomUUID();
    const request = {
        schemaVersion: 1, requestId, handoffId: handoff.handoffId,
        project: checkout, target: `.github/extensions/${essentials["canvas.id"]}/`,
        sourceFingerprint: handoff.sourceFingerprint, settingsRevision: model.settingsRevision,
        canvas: { id: essentials["canvas.id"], displayName: essentials["canvas.displayName"],
            description: essentials["canvas.description"] || "Spec Kit workflow canvas.",
            workflowListName: essentials["canvas.workflowListName"] || "Workflows" },
        workflow: { selectedPhases: handoff.workflow.selectedPhases,
            ...(outputs !== undefined ? { phaseArtifacts: outputs } : {}) },
        installed: handoff.workflow.installed,
        ...(actual ? { actualInstalled: actual.installed } : {}),
        values: essentials,
        fieldConstraints: model.constraints,
        ...(generatedFields.length ? { generatedFields } : {}),
        ...(generatedPages.length ? { generatedPages } : {}),
        workflowPage,
        ...(fieldPlacements.length ? { fieldPlacements } : {}),
        ...(designerFields.size ? { designerFields: [...designerFields.values()] } : {}),
        ...(generatedControls.length ? { generatedControls } : {}),
        ...(generatedAssets.length ? { generatedAssets } : {}),
        ...(generatedImageControl ? { generatedImageControl } : {}),
        ...(generatedTextControl ? { generatedTextControl, generatedTextPlacements } : {}),
        ...(valueSources.length ? { valueSources } : {}),
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
    return { requestId, target: request.target,
        ...((inventoryWarning || actual?.warnings.length)
            ? { warnings: [inventoryWarning, ...(actual?.warnings ?? [])].filter(Boolean) } : {}) };
}
