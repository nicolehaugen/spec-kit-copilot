import { createHash } from "node:crypto";

export const REQUEST_LIMIT = 4 * 1024 * 1024;
export const GENERATION_PENDING = "Generation is already queued for this Designer panel";
export const GENERATION_EXISTS = "Canvas already exists; choose and save a different Canvas ID.";

export function generationAvailability(pending, exists) {
    if (typeof pending !== "boolean" || typeof exists !== "boolean") {
        throw new Error("Invalid Designer generation availability");
    }
    return { available: !pending && !exists,
        error: pending ? GENERATION_PENDING : exists ? GENERATION_EXISTS : null };
}

export function validateGenerateSubmission(input, model) {
    const expectedKeys = ["modelRevision", "settingsRevision", "values",
        ...(Object.hasOwn(input ?? {}, "outputs") ? ["outputs"] : []),
        ...(Object.hasOwn(input ?? {}, "badges") ? ["badges"] : []),
        ...(model.templates?.some((item) => item.kind === "generated.computed-value-provider")
            ? ["approvedProviders"] : [])];
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).sort().join() !== expectedKeys.sort().join()
        || input.modelRevision !== model.revision
        || !Number.isSafeInteger(input.settingsRevision) || input.settingsRevision < 0) {
        throw new Error("Invalid Designer generation request");
    }
    return input;
}

export function serializeGenerationRequest(request) {
    const payload = JSON.stringify(request);
    request.integrity = createHash("sha256").update(payload).digest("hex");
    const serialized = JSON.stringify(request);
    if (Buffer.byteLength(serialized) > REQUEST_LIMIT) {
        throw new Error("Frozen generation request exceeds 4 MiB");
    }
    return serialized;
}
