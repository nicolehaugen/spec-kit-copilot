const idPattern = /^[a-z0-9][a-z0-9-]{0,99}$/;
const reserved = new Set(["speckit-canvas-designer", "speckit-wizard", "speckit-canvas-generator"]);
const deviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const requestPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const statuses = new Set(["absent", "foreign", "incomplete", "ready", "modified"]);

export function validateCanvasId(id) {
    if (typeof id !== "string" || !idPattern.test(id) || reserved.has(id)
        || deviceName.test(id)) throw new Error("Invalid generated Canvas ID");
    return id;
}

export function outputTarget(id) {
    return `generated-canvases/${validateCanvasId(id)}/`;
}

export const publicationTarget = (id) => `.github/extensions/${validateCanvasId(id)}/`;

function exactKeys(value, keys) {
    return value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).sort().join() === keys.sort().join();
}

export function validateOutputStatusResponse(value, id) {
    if (!statuses.has(value?.status)
        || !exactKeys(value, ["status", "target", "publicationTarget", "publication",
            ...(["ready", "modified"].includes(value?.status) ? ["requestId"] : []),
            ...(value?.error === undefined ? [] : ["error"])])
        || value.target !== outputTarget(id)
        || value.publicationTarget !== publicationTarget(id)
        || (["ready", "modified"].includes(value.status)
            && (typeof value.requestId !== "string" || !requestPattern.test(value.requestId)))
        || (value.error !== undefined && (typeof value.error !== "string" || !value.error.trim()))) {
        throw new Error("Invalid generated output status");
    }
    const published = value.publication;
    if (!published || !["absent", "ready", "modified", "blocked"].includes(published.status)
        || !exactKeys(published, published.status === "absent" ? ["status"]
            : published.status === "blocked" ? ["status", "error"] : ["status", "requestId", "digest"])
        || (published.status === "blocked" && (typeof published.error !== "string" || !published.error.trim()))
        || (["ready", "modified"].includes(published.status)
            && (!requestPattern.test(published.requestId ?? "")
                || !/^[a-f0-9]{64}$/.test(published.digest ?? "")))) {
        throw new Error("Invalid publication status");
    }
    return value;
}

export function validateRevealResponse(value, id) {
    if (!exactKeys(value, ["target"])
        || !["generated-canvases/", outputTarget(id)].includes(value.target)) {
        throw new Error("Invalid generated canvas folder response");
    }
    return value;
}

export function validateOpenResponse(value, id) {
    if (!exactKeys(value, ["status", "target", "publicationTarget"])
        || value.status !== "opening" || value.target !== outputTarget(id)
        || value.publicationTarget !== publicationTarget(id)) {
        throw new Error("Invalid generated canvas opening response");
    }
    return value;
}

export function validateGenerateResponse(value, id) {
    if (!exactKeys(value, value?.warnings === undefined
        ? ["target", "publicationTarget", "requestId"] : ["target", "publicationTarget", "requestId", "warnings"])
        || value.target !== outputTarget(id)
        || value.publicationTarget !== publicationTarget(id)
        || typeof value.requestId !== "string" || !requestPattern.test(value.requestId)
        || (value.warnings !== undefined
            && (!Array.isArray(value.warnings)
                || value.warnings.some((warning) => typeof warning !== "string" || !warning.trim())))) {
        throw new Error("Invalid generated canvas submission response");
    }
    return value;
}

export function validateOutputError(value) {
    if (!exactKeys(value, ["error"])
        || typeof value.error !== "string" || !value.error.trim()) {
        throw new Error("Invalid generated canvas error response");
    }
    return value;
}
