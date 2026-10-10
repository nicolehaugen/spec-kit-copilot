export const generateCanvasInputSchema = {
    type: "boolean",
    description: "Enable experimental Generate canvas. New instances use runtime settings (otherwise false) when omitted; reopening without this field preserves the current value.",
};
export const featureFlagsSchema = {
    type: "object",
    required: ["generateCanvas"],
    additionalProperties: false,
    properties: { generateCanvas: { type: "boolean" } },
};

export function validateGenerateCanvas(value) {
    if (typeof value !== "boolean") throw new Error("generateCanvas must be a boolean");
    return value;
}

export function createFeatureFlags(value) {
    return { generateCanvas: validateGenerateCanvas(value) };
}

export function readGenerateCanvas(snapshot) {
    if (!snapshot || !Object.hasOwn(snapshot, "featureFlags")) return false;
    const flags = snapshot.featureFlags;
    if (!flags || typeof flags !== "object" || Array.isArray(flags)
        || Object.keys(flags).length !== 1 || !Object.hasOwn(flags, "generateCanvas")) {
        throw new Error("Incompatible featureFlags: expected { generateCanvas: boolean }");
    }
    return validateGenerateCanvas(flags.generateCanvas);
}
