export const phaseControlInterface = Object.freeze({
    controlId: "workflow-phases",
    contractVersion: 1,
    capabilities: Object.freeze(["workflow.rows.v1", "workflow.managed-run.v1"]),
});

export function validatePhaseState(state) {
    // false leaves a pending <slug> path unresolved; true allows a user-entered preview.
    if (!state || typeof state.slugEditable !== "boolean") {
        throw new Error("Incompatible phase control state: slugEditable must be a boolean");
    }
    return state;
}

export function validateWorkflowPageState(state) {
    if (!state || typeof state !== "object") throw new Error("Incompatible Workflow page state");
    validatePhaseState(state.phaseState);
    // false hides the slug field; true shows it, but a blank value remains valid.
    if (state.model !== null && (!state.model
        || typeof state.model.userProvidesSlug !== "boolean")) {
        throw new Error("Incompatible Workflow page state: userProvidesSlug must be a boolean");
    }
    if (state.model && state.model.userProvidesSlug !== state.phaseState.slugEditable) {
        throw new Error("Incompatible Workflow page state: slug settings disagree");
    }
    return state;
}

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
