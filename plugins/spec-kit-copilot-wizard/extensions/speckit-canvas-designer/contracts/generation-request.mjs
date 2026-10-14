import { createHash } from "node:crypto";

export { GENERATION_PENDING, GENERATION_EXISTS, generationAvailability } from "../ui/generation-state.js";

export const REQUEST_LIMIT = 4 * 1024 * 1024;
export const GENERATION_PROTOCOL = Object.freeze({ schemaVersion: 2, publication: "open" });

export function validateGenerationProtocol(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join() !== "publication,schemaVersion"
        || value.schemaVersion !== GENERATION_PROTOCOL.schemaVersion
        || value.publication !== GENERATION_PROTOCOL.publication) {
        throw new Error("Canvas Design does not support deferred publication. Launch with the current local Canvas Design source.");
    }
    return value;
}

export function validateGenerateSubmission(input, model) {
    const expectedKeys = ["modelRevision", "settingsRevision", "values",
        ...(input?.replaceExisting === true ? ["replaceExisting", "replaceRequestId"] : []),
        ...(Object.hasOwn(input ?? {}, "outputs") ? ["outputs"] : []),
        ...(Object.hasOwn(input ?? {}, "badges") ? ["badges"] : []),
        ...(model.templates?.some((item) => item.kind === "generated.computed-value-provider")
            ? ["approvedProviders"] : [])];
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).sort().join() !== expectedKeys.sort().join()
        || input.modelRevision !== model.revision
        || !Number.isSafeInteger(input.settingsRevision) || input.settingsRevision < 0
        || (input.replaceExisting === true
            && (typeof input.replaceRequestId !== "string"
                || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.replaceRequestId)))) {
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
