import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { bundleSelectionMembers } from "../catalog/bundles.mjs";

const execFileAsync = promisify(execFile);
const KINDS = ["presets", "extensions", "bundles"];

export async function readInstalledBundleMembers(workspacePath, bundles, run = execFileAsync) {
    const members = {};
    for (const bundle of bundles) {
        const { stdout } = await run(process.platform === "win32" ? "specify.exe" : "specify",
            ["bundle", "info", bundle.id, "--json"],
            { cwd: workspacePath, timeout: 10000, maxBuffer: 128 * 1024 });
        let info;
        try { info = JSON.parse(stdout); }
        catch { throw new Error(`Invalid installed bundle metadata for ${bundle.id}`); }
        members[bundle.id] = bundleSelectionMembers(info, bundle.id).members;
    }
    return members;
}

export function resolveRuntimeInstallLocators(installed, catalog, localSelections, bundleMembers = {},
    workspacePath) {
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
            const providers = kind === "bundles" ? [] : installed.bundles.filter((bundle) =>
                bundleMembers[bundle.id]?.some((member) =>
                    member.kind === kind && member.id === item.id));
            if (providers.length > 1) {
                throw new Error(`Ambiguous bundle source for installed ${kind} ${item.id}`);
            }
            if (providers.length) {
                locators[kind].push({ installedId: item.id, source: "bundle",
                    bundleId: providers[0].id });
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
