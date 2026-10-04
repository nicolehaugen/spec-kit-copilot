import { join } from "node:path";

const KINDS = ["presets", "extensions", "bundles"];

export function resolveRuntimeInstallLocators(installed, catalog, localSelections, workspacePath) {
    const locators = { presets: [], extensions: [], bundles: [] };
    for (const kind of KINDS) {
        for (const item of installed[kind]) {
            const local = localSelections?.[kind]?.find((entry) => entry.id === item.id);
            if (local) {
                if (local.version !== item.version) {
                    throw new Error(`Local ${kind} ${item.id} version differs from the installed version`);
                }
                locators[kind].push({ installedId: item.id, source: "local", path: local.path });
                continue;
            }
            if (item.source === "local" && kind !== "bundles" && workspacePath) {
                locators[kind].push({ installedId: item.id, source: "local",
                    path: join(workspacePath, ".specify", kind, item.id) });
                continue;
            }
            if (!item.source || item.source === "local") {
                throw new Error(`Cannot verify the installed source for ${kind} ${item.id}; ${kind === "bundles"
                    ? "Specify's bundle inventory does not include install provenance"
                    : "select an approved local development path in the Wizard before launching Designer"}`);
            }
            const candidates = (catalog?.[kind] ?? []).filter((entry) =>
                entry?.installedId === item.id && entry.version === item.version
                && entry.source === item.source
                && typeof entry.id === "string" && typeof entry.source === "string");
            if (candidates.length !== 1) {
                throw new Error(`Cannot identify a unique approved install source for installed ${kind} ${item.id} v${item.version}; resolve it in the Wizard before launching Designer`);
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
