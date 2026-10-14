import { createHash } from "node:crypto";

export const REQUEST_LIMIT = 4 * 1024 * 1024;
export const GENERATION_PROTOCOL = Object.freeze({ schemaVersion: 2, publication: "open" });
export const RECEIPT_NAME = "generation-receipt.json";

export function generationTargets(canvasId) {
    if (typeof canvasId !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(canvasId)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|speckit-wizard|speckit-canvas-designer|speckit-canvas-generator)$/i.test(canvasId)) {
        throw new Error("Invalid generated Canvas ID");
    }
    return { target: `generated-canvases/${canvasId}/`,
        publicationTarget: `.github/extensions/${canvasId}/` };
}

export function validateGenerationRequestIntegrity(request, handoffId, requestId) {
    if (!request || typeof request !== "object" || Array.isArray(request)
        || request.schemaVersion !== GENERATION_PROTOCOL.schemaVersion) {
        throw new Error("Unsupported generation request. Prepare a new request in Designer.");
    }
    const { integrity, ...payload } = request;
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    if (integrity !== hash || request.handoffId !== handoffId || request.requestId !== requestId) {
        throw new Error("Generation request integrity mismatch");
    }
    const targets = generationTargets(request.values?.["canvas.id"]);
    if (request.target !== targets.target || request.publicationTarget !== targets.publicationTarget) {
        throw new Error("Generation target is invalid");
    }
}
