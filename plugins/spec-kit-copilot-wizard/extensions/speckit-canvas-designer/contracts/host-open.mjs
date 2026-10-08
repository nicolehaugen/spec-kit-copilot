export const PAGE_NAME = "^[a-z][a-z0-9-]{0,79}$";
export const isWindowsDeviceName = (name) =>
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
export const handoffIdSchema = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" };

export const designerOpenInputSchema = {
    type: "object", additionalProperties: false,
    properties: {
        handoffId: handoffIdSchema,
        pages: { type: "array", minItems: 3, maxItems: 100, items: {
            type: "object", additionalProperties: false, required: ["name", "path", "kind", "strategy"],
            properties: { name: { type: "string", pattern: PAGE_NAME },
                path: { type: "string", minLength: 1, maxLength: 4096 },
                kind: { const: "designer.tab-definition" }, strategy: { const: "replace" } },
        } },
        templates: { type: "array", maxItems: 100, items: {
            type: "object", additionalProperties: false,
            required: ["name", "path", "sourceId", "kind", "strategy"],
            properties: { name: { type: "string", pattern: PAGE_NAME },
                path: { type: "string", minLength: 1, maxLength: 4096 },
                sourceId: { type: "string", minLength: 1, maxLength: 160 },
                kind: { type: "string", enum: ["designer.setting-definition",
                    "generated.workflow-page-definition", "generated.phase-control-definition",
                    "generated.phase-control-adapter", "generated.field-placement",
                    "generated.added-page-definition", "generated.added-page-renderer",
                    "shared.control-definition", "designer.control-adapter", "generated.control-adapter",
                    "generated.value-definition", "generated.computed-value-provider",
                    "generated.dialog-definition", "generated.dialog-adapter",
                    "generated.phase-dialog-binding", "generated.button-control-definition",
                    "generated.button-adapter", "generated.button-placement"] },
                strategy: { const: "replace" } },
        } },
    },
};

export function validateDesignerOpenInput(input) {
    const { handoffId, pages, templates } = input ?? {};
    if ((handoffId === undefined) !== (pages === undefined)
        || (handoffId === undefined) !== (templates === undefined)) {
        throw new Error("Designer handoff and complete resolved inventory are required together");
    }
    return { handoffId, pages, templates };
}
