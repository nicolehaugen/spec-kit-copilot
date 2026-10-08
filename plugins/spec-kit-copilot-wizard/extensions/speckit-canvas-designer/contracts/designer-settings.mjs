import { isWindowsDeviceName } from "./host-open.mjs";

export const SETTINGS_LIMIT = 1024 * 1024;
export const SAVE_REQUEST_LIMIT = SETTINGS_LIMIT - 8 * 1024;

export function validateValues(values, constraints) {
    if (!values || typeof values !== "object" || Array.isArray(values)
        || Object.keys(values).length !== Object.keys(constraints).length
        || Object.keys(values).some((key) => !Object.hasOwn(constraints, key))) {
        throw new Error("Designer settings contain unexpected or missing fields");
    }
    for (const [key, rule] of Object.entries(constraints)) {
        const value = values[key];
        const invalidType = rule.type === "boolean" ? typeof value !== "boolean"
            : rule.type === "string" ? typeof value !== "string"
                : rule.type === "image" ? typeof value !== "string"
                    || value.length > Math.ceil(rule.maxBytes / 3) * 4 + 64
                    : rule.type === "object" ? value !== null
                        && (typeof value !== "object" || Array.isArray(value))
                        : true;
        if (invalidType || key === "canvas.id" && typeof value === "string"
            && (/[/\\]/.test(value) || isWindowsDeviceName(value))) {
            throw new Error(`Invalid Designer setting: ${key}`);
        }
    }
}

export function validateSavedSettings(record, handoff, model) {
    if (!record || typeof record !== "object" || Array.isArray(record)
        || Object.keys(record).sort().join() !== (record.outputs === undefined
            ? "handoffId,modelRevision,revision,schemaVersion,values"
            : "handoffId,modelRevision,outputs,revision,schemaVersion,values")
        || record.schemaVersion !== 1 || record.handoffId !== handoff.handoffId
        || !Number.isSafeInteger(record.revision) || record.revision < 1
        || record.modelRevision !== model.revision) {
        throw new Error("Saved Designer settings do not match the current handoff or pages");
    }
    validateValues(record.values, model.constraints);
}

export function validateSaveRequest(request, model) {
    if (!request || typeof request !== "object" || Array.isArray(request)
        || Object.keys(request).sort().join() !== (request.outputs === undefined
            ? "modelRevision,revision,values" : "modelRevision,outputs,revision,values")
        || request.modelRevision !== model.revision
        || !Number.isSafeInteger(request.revision) || request.revision < 0) {
        throw new Error("Invalid Designer save request");
    }
    validateValues(request.values, model.constraints);
}
