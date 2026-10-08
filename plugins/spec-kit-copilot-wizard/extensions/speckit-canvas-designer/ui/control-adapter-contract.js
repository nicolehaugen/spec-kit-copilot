export function validateAdapterModule(adapter, controlId, expected, image, object) {
    if (typeof adapter.mount !== "function") throw new Error("Missing mount export");
    if (typeof adapter.validate !== "function") throw new Error("Missing validate export");
    const valueContract = adapter.valueContract;
    if (adapter.controlId !== controlId || valueContract?.type !== expected?.type
        || (image
            ? valueContract.maxBytes !== expected.maxBytes
                || JSON.stringify(valueContract.mimeTypes) !== JSON.stringify(expected.mimeTypes)
            : object
                ? JSON.stringify(Object.entries(valueContract.properties ?? {}).sort())
                    !== JSON.stringify(Object.entries(expected.properties).sort())
                : Object.keys(valueContract).sort().join() !== "type")) {
        throw new Error("Incompatible control ID or value contract");
    }
}

export function validateAdapterChange(value, rules, id) {
    if (rules.type === "image" ? typeof value !== "string"
        || value.length > Math.ceil(rules.maxBytes / 3) * 4 + 64
        : rules.type === "boolean" ? typeof value !== "boolean"
            : rules.type === "string" ? typeof value !== "string"
                : value !== null && (typeof value !== "object" || Array.isArray(value))) {
        throw new Error(`Invalid Designer setting: ${id}`);
    }
}

export function validateAdapterHandle(handle) {
    if (typeof handle?.isReady !== "function") throw new Error("Missing isReady handle");
}
