import { join } from "node:path";

const KINDS = ["presets", "extensions", "bundles"];

export function resolveRuntimeInstallLocators(installed, catalog, localSelections, workspacePath,
    selectedBundles = []) {
    const locators = { presets: [], extensions: [], bundles: [] };
    for (const kind of KINDS) {
        for (const item of installed[kind]) {
            const local = localSelections?.[kind]?.find((entry) => entry.id === item.id);
            if (local) {
                locators[kind].push({ installedId: item.id, source: "local", path: local.path });
                continue;
            }
            if (item.source === "local" && kind !== "bundles" && workspacePath) {
                locators[kind].push({ installedId: item.id, source: "local",
                    path: item.path ?? join(workspacePath, ".specify", kind, item.id) });
                continue;
            }
            if ((!item.source && kind !== "bundles") || item.source === "local") {
                throw new Error(`Cannot verify the installed source for ${kind} ${item.id}; ${kind === "bundles"
                    ? "local bundles cannot be reproduced from the catalog"
                    : "select an approved local development path in the Wizard before launching Designer"}`);
            }
            let candidates = (catalog?.[kind] ?? []).filter((entry) =>
                entry?.installedId === item.id && entry.version === item.version
                && ((kind === "bundles" && !item.source) || entry.source === item.source)
                && typeof entry.id === "string" && typeof entry.source === "string");
            if (kind === "bundles") {
                const selected = candidates.filter((entry) => selectedBundles.some((choice) =>
                    choice.id === entry.id && choice.source === entry.source));
                if (selected.length) candidates = selected;
            }
            if (candidates.length !== 1) {
                throw new Error(`Cannot identify a unique ${kind === "bundles" ? "catalog" : "approved install"} source for installed ${kind} ${item.id} v${item.version}; resolve it in the Wizard before launching Designer`);
            }
            const entry = candidates[0];
            if (entry.downloadUrl == null && entry.source !== "default"
                && !(kind === "bundles" && typeof entry.bundleYml === "string"
                    && entry.bundleYml.length > 0)) {
                throw new Error(`Installed ${kind} ${item.id} has no approved download URL or local path`);
            }
            locators[kind].push({ installedId: item.id, source: entry.source,
                catalogId: entry.id, downloadUrl: entry.downloadUrl ?? null,
                ...(kind === "bundles" && entry.bundleYml ? { bundleYml: entry.bundleYml } : {}) });
        }
    }
    return locators;
}

export function buildPortableRuntimeSetup(installed, installLocators, catalog, selections, localSelections) {
    const designIds = { presets: new Set(), extensions: new Set() };
    designIds.extensions.add("extension-canvas-design");
    for (const kind of ["presets", "extensions"]) {
        for (const entry of catalog?.[kind] ?? []) {
            if (entry.tags?.includes("canvas-design")) {
                designIds[kind].add(entry.id);
                if (entry.installedId) designIds[kind].add(entry.installedId);
            }
        }
        for (const entry of [...(selections?.[kind] ?? []), ...(localSelections?.[kind] ?? [])]) {
            designIds[kind].add(entry.id);
        }
    }
    const setup = { presets: [], extensions: [], bundles: [] };
    for (const kind of ["presets", "extensions"]) {
        for (const item of installed[kind]) {
            const locator = installLocators[kind].find((entry) => entry.installedId === item.id);
            if (!locator) throw new Error(`Missing verified runtime source for ${kind} ${item.id}`);
            if (designIds[kind].has(item.id) || designIds[kind].has(locator.catalogId)) continue;
            if (locator.source === "local" && item.source === "local"
                && (!item.path || item.path !== locator.path)) {
                throw new Error(`Cannot reproduce local runtime ${kind} ${item.id}: verified installed path is unavailable`);
            }
            setup[kind].push({ id: item.id, version: item.version,
                enabled: item.enabled, priority: item.priority, locator });
        }
    }
    // A bundle ZIP can contain design-time members even when the bundle itself
    // has no design tag. Reinstall its verified runtime members individually.
    return setup;
}
