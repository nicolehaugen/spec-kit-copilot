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

export function mountBadgeInputAdapter(adapter, binding, context) {
    if (binding.capabilities !== undefined
        && (!Array.isArray(binding.capabilities) || binding.capabilities.length !== 1
            || binding.capabilities[0] !== "declare-markdown-output")) {
        throw new Error(`Incompatible Designer badge input capabilities ${binding.adapter}`);
    }
    const canDeclare = binding.capabilities?.includes("declare-markdown-output") === true;
    if (adapter?.controlId !== binding.control || adapter.contractVersion !== 1
        || typeof adapter.mount !== "function"
        || adapter.declaresMarkdownOutput !== (canDeclare ? true : undefined)) {
        throw new Error(`Incompatible Designer badge input adapter ${binding.adapter}`);
    }
    const { onDeclareFile: declareFile, ...options } = context;
    if (canDeclare && typeof declareFile !== "function") {
        throw new Error("Designer output declaration is unavailable in this host.");
    }
    let mounted = false;
    const onDeclareFile = canDeclare ? (phase, path) => {
        if (!mounted) throw new Error("File declaration is unavailable before control mount.");
        return declareFile(phase, path);
    } : undefined;
    const handle = adapter.mount(canDeclare ? { ...options, onDeclareFile } : options);
    if (handle?.handlesOutputDeclaration !== (canDeclare ? true : undefined)) {
        context.root.replaceChildren();
        throw new Error(`Incompatible Designer badge input declaration handle ${binding.adapter}`);
    }
    mounted = true;
    return handle;
}
