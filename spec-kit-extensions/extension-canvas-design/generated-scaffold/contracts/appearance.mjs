export const APPEARANCE_PROPERTIES = Object.freeze({
    accent: "--accent-color",
    background: "--background-color-default",
});
export const OPTIONAL_COLOR = Object.freeze({
    type: "string", maxLength: 7, pattern: "^(?:#?[0-9A-Fa-f]{6})?$",
});
export const APPEARANCE_RULES = Object.freeze(Object.fromEntries(
    ["Light", "Dark"].flatMap((suffix) => Object.keys(APPEARANCE_PROPERTIES)
        .map((key) => [`canvas.${key}${suffix}`, OPTIONAL_COLOR]))));

export function validateAppearanceField(id) {
    if (/^canvas\.(?:surface|secondary|text)(?:Light|Dark)$/.test(id)) {
        throw new Error(`Unsupported appearance field: ${id}`);
    }
}

export function validAppearance(appearance) {
    if (appearance === undefined) return true;
    return appearance !== null && typeof appearance === "object" && !Array.isArray(appearance)
        && Object.keys(appearance).length > 0
        && Object.entries(appearance).every(([mode, colors]) =>
            ["light", "dark"].includes(mode)
            && (typeof colors === "string" ? /^#[0-9a-fA-F]{6}$/.test(colors)
                : colors !== null && typeof colors === "object" && !Array.isArray(colors)
                    && Object.keys(colors).length > 0
                    && Object.entries(colors).every(([key, value]) =>
                        Object.hasOwn(APPEARANCE_PROPERTIES, key)
                        && typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value))));
}
