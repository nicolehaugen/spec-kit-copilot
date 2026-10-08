import { createHash } from "node:crypto";

export const REQUEST_LIMIT = 4 * 1024 * 1024;

export function serializeGenerationRequest(request) {
    const payload = JSON.stringify(request);
    request.integrity = createHash("sha256").update(payload).digest("hex");
    const serialized = JSON.stringify(request);
    if (Buffer.byteLength(serialized) > REQUEST_LIMIT) {
        throw new Error("Frozen generation request exceeds 4 MiB");
    }
    return serialized;
}
