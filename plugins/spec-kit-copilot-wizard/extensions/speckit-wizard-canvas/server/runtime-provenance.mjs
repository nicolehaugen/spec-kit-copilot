import { validCatalogInstallSource, catalogInstallFingerprint,
    catalogInstallWarning } from "../contracts/catalog-install-source.mjs";

const KINDS = ["presets", "extensions", "bundles"];
const PACKAGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function safeDownloadUrl(value) {
    if (value == null) return true;
    if (typeof value !== "string" || value.length > 2048 || /[\s\x00-\x1f\x7f<>]/.test(value)) return false;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
    } catch { return false; }
}

function recordMatchesCatalog(record, kind, catalog) {
    if (!validCatalogInstallSource(record) || record.kind !== kind.slice(0, -1)) return null;
    const matches = (catalog?.[kind] ?? []).filter((entry) =>
        entry?.id === record.catalogId && entry.source === record.source
        && (entry.installedId ?? entry.id) === record.installedId
        && entry.version === record.version
        && (entry.downloadUrl ?? null) === record.downloadUrl
        && (entry.bundleYml ?? undefined) === record.bundleYml
        && catalogInstallFingerprint({
            kind: record.kind, catalogId: entry.id, installedId: entry.installedId ?? entry.id,
            version: entry.version, source: entry.source,
            downloadUrl: entry.downloadUrl ?? null,
            ...(entry.bundleYml ? { bundleYml: entry.bundleYml } : {}),
        }) === record.catalogFingerprint);
    return matches.length === 1 ? matches[0] : null;
}

function catalogLocator(kind, item, entry) {
    if (!entry || !PACKAGE.test(entry.id ?? "") || !PACKAGE.test(entry.source ?? "")
        || entry.source === "local" || !safeDownloadUrl(entry.downloadUrl)
        || (entry.downloadUrl == null && entry.source !== "default"
            && !(kind === "bundles" && typeof entry.bundleYml === "string" && entry.bundleYml))) {
        return null;
    }
    return { installedId: item.id, source: entry.source, catalogId: entry.id,
        downloadUrl: entry.downloadUrl ?? null,
        ...(kind === "bundles" && entry.bundleYml ? { bundleYml: entry.bundleYml } : {}) };
}

export function resolveRuntimeInstallLocators(installed, catalog, localSelections, _workspacePath,
    _selectedBundles = [], installRecords = []) {
    const locators = { presets: [], extensions: [], bundles: [] };
    for (const kind of KINDS) {
        for (const item of installed[kind]) {
            const localSelection = localSelections?.[kind]?.find((entry) => entry.id === item.id);
            if (localSelection) {
                locators[kind].push({ installedId: item.id, source: "local", path: localSelection.path });
                continue;
            }

            const localPath = item.source === "local" && typeof item.path === "string" ? item.path : null;
            if (localPath) {
                locators[kind].push({ installedId: item.id, source: "local", path: localPath });
                continue;
            }

            const record = installRecords.find((entry) =>
                entry.kind === kind.slice(0, -1) && entry.installedId === item.id
                && entry.version === item.version);
            const recordedEntry = record && recordMatchesCatalog(record, kind, catalog);
            const cliSourceMatches = item.source === "local"
                ? !localPath
                : item.source === undefined || item.source === record?.source;
            if (recordedEntry && cliSourceMatches && safeDownloadUrl(record.downloadUrl)) {
                const locator = catalogLocator(kind, item, recordedEntry);
                if (locator) {
                    locators[kind].push(locator);
                    continue;
                }
            }

            if (kind !== "bundles" && item.source && item.source !== "local") {
                const matches = (catalog?.[kind] ?? []).filter((entry) =>
                    entry?.source === item.source
                    && (entry.installedId ?? entry.id) === item.id
                    && entry.version === item.version);
                const locator = matches.length === 1 && matches[0].installAllowed !== false
                    ? catalogLocator(kind, item, matches[0]) : null;
                if (locator) {
                    locators[kind].push(locator);
                    continue;
                }
            }
            locators[kind].push({ installedId: item.id, source: "unverified" });
        }
    }
    return locators;
}

export function verifiedCatalogInstallEvidence(installed, installLocators, catalog, installRecords = []) {
    const evidence = [];
    for (const kind of KINDS) {
        for (const record of installRecords) {
            if (record.kind !== kind.slice(0, -1)) continue;
            const item = installed[kind].find((entry) =>
                entry.id === record.installedId && entry.version === record.version);
            const locator = installLocators[kind].find((entry) =>
                entry.installedId === record.installedId);
            if (!item || !locator || locator.source !== record.source
                || locator.catalogId !== record.catalogId || locator.downloadUrl !== record.downloadUrl
                || locator.bundleYml !== record.bundleYml
                || !recordMatchesCatalog(record, kind, catalog)) continue;
            evidence.push(record);
        }
    }
    return evidence;
}

export function buildPortableRuntimeSetup(installed, installLocators, catalog, selections, localSelections) {
    const designIds = { presets: new Set(), extensions: new Set() };
    designIds.extensions.add("extension-canvas-design");
    for (const kind of ["presets", "extensions"]) {
        for (const entry of localSelections?.[kind] ?? []) designIds[kind].add(entry.id);
        for (const selected of selections?.[kind] ?? []) {
            const entry = (catalog?.[kind] ?? []).find((candidate) =>
                candidate.id === selected.id && candidate.source === selected.source
                && candidate.tags?.includes("canvas-design"));
            if (entry) designIds[kind].add(entry.installedId ?? entry.id);
        }
    }

    const setup = { presets: [], extensions: [], bundles: [] };
    const warnings = [];
    for (const kind of KINDS) {
        for (const item of installed[kind]) {
            const locator = installLocators[kind].find((entry) => entry.installedId === item.id);
            if (!locator) {
                warnings.push(catalogInstallWarning(kind, item.id));
                continue;
            }
            if (kind !== "bundles") {
                const taggedEntries = (catalog?.[kind] ?? []).filter((entry) =>
                    (entry.installedId ?? entry.id) === item.id && entry.version === item.version);
                const catalogDesign = taggedEntries.length > 0
                    && taggedEntries.every((entry) => entry.tags?.includes("canvas-design"));
                if (designIds[kind].has(item.id) || catalogDesign) continue;
            }
            if (locator.source === "unverified") {
                warnings.push(catalogInstallWarning(kind, item.id));
                continue;
            }
            if (locator.source === "local") {
                warnings.push(catalogInstallWarning(kind, item.id, "local"));
                if (kind === "bundles" || item.source !== "local" || !locator.path) continue;
                setup[kind].push({ id: item.id, version: item.version,
                    enabled: item.enabled, priority: item.priority, locator });
                continue;
            }
            if (kind !== "bundles") {
                setup[kind].push({ id: item.id, version: item.version,
                    enabled: item.enabled, priority: item.priority, locator });
            }
        }
    }
    if (warnings.length) setup.warnings = warnings;
    return setup;
}
