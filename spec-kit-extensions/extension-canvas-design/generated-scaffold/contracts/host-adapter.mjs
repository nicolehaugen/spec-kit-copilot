export const phaseControlInterface = Object.freeze({
    controlId: "workflow-phases",
    contractVersion: 1,
    capabilities: Object.freeze(["workflow.rows.v1", "workflow.managed-run.v1"]),
});

export function validatePhaseAdapter(adapter) {
    if (adapter.controlId !== phaseControlInterface.controlId
        || adapter.contractVersion !== phaseControlInterface.contractVersion
        || typeof adapter.mount !== "function") {
        throw new Error("Incompatible phase control adapter");
    }
    const required = adapter.requiredCapabilities ?? [];
    if (!Array.isArray(required)
        || required.some((name) => !phaseControlInterface.capabilities.includes(name))
        || new Set(required).size !== required.length) {
        throw new Error("Phase control adapter requires unavailable host capabilities");
    }
    return adapter.mount;
}

export function validatePhaseMount(instance) {
    if (!instance || typeof instance.update !== "function" || typeof instance.dispose !== "function") {
        throw new Error("Phase control adapter must return update and dispose");
    }
    return instance;
}

export function requiresManagedRun(adapter) {
    return Array.isArray(adapter.requiredCapabilities)
        && adapter.requiredCapabilities.includes("workflow.managed-run.v1");
}
