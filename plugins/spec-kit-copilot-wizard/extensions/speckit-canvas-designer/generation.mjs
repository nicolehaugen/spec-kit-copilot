import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const fields = ["canvas.id", "canvas.displayName", "canvas.description",
    "canvas.workflowListName", "workflowSlug.userProvided"];
const reserved = new Set(["speckit-canvas-designer", "speckit-wizard", "speckit-canvas-generator"]);
const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

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
        || reserved.has(result["canvas.id"]) || windowsDeviceName.test(result["canvas.id"])) {
        throw new Error("Canvas ID and Title must be valid and non-reserved");
    }
    return result;
}

export async function freezeGeneration({ model, values, handoff, project, workspace }) {
    const essentials = validateEssentials(model, values);
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
        values: essentials,
    };
    request.integrity = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const folder = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId,
        "generations", requestId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "request.json"), JSON.stringify(request), { flag: "wx" });
    return { requestId, target: request.target };
}
