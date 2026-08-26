// Pure parsing/lookup helpers for CLI `lookupId` strings emitted by
// `specify artifact info --json` / `artifact list --json` stack rows.
//
// Shape:  "preset:<presetId>:<kind>:<name>"
//         "extension:<extId>:<kind>:<name>"
//         null                                (core / built-in layer)
//
// Only the first three colons are structural; everything after the third
// colon is treated as the opaque `name`. This is intentional — contribution
// names use dotted namespaces (e.g. `speckit.plan`) and may grow additional
// structure over time. Keeping the tail opaque means we never miscount a
// legitimate colon-in-name as a delimiter.

const VALID_PROVIDER_KINDS = new Set(["preset", "extension"]);

/**
 * Parse a CLI `lookupId` into its structured parts.
 * @param {unknown} lookupId
 * @returns {{ providerKind: string, providerId: string, kind: string, name: string } | null}
 */
export function parseLookupId(lookupId) {
    if (typeof lookupId !== "string" || lookupId.length === 0) return null;
    // Only split on the first three colons; the remainder is the name.
    const parts = lookupId.split(":");
    if (parts.length < 4) return null;
    const [providerKind, providerId, kind, ...nameParts] = parts;
    if (!VALID_PROVIDER_KINDS.has(providerKind)) return null;
    if (!providerId || !kind) return null;
    const name = nameParts.join(":");
    if (!name) return null;
    return { providerKind, providerId, kind, name };
}

/**
 * Deterministic lookup of a specific stack layer by its `lookupId`.
 * Walks all `comp.artifacts[].stack[]` and returns the first layer whose
 * `lookupId` matches. Returns null for null / non-string / unknown ids.
 *
 * @param {{ artifacts?: Array<{ stack?: Array<{ lookupId?: string | null }> }> } | null | undefined} comp
 * @param {unknown} lookupId
 * @returns {object | null}
 */
export function findLayerByLookupId(comp, lookupId) {
    if (typeof lookupId !== "string" || !lookupId) return null;
    const artifacts = comp?.artifacts ?? [];
    for (const a of artifacts) {
        for (const l of a?.stack ?? []) {
            if (l && l.lookupId === lookupId) return l;
        }
    }
    return null;
}
