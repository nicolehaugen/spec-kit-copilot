import { createHash } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const KINDS = ["preset", "extension", "bundle"];
const REQUIRED_KEYS = ["approved", "catalogFingerprint", "catalogId", "downloadUrl",
    "installedId", "kind", "source", "version"].sort().join();
const BUNDLE_KEYS = ["approved", "bundleYml", "catalogFingerprint", "catalogId",
    "downloadUrl", "installedId", "kind", "source", "version"].sort().join();

function safeUrl(value) {
    if (value === null) return true;
    if (typeof value !== "string" || value.length > 2048 || /[\s\x00-\x1f\x7f<>]/.test(value)) return false;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
    } catch { return false; }
}

export function catalogInstallFingerprint(record) {
    const identity = {
        kind: record.kind, catalogId: record.catalogId, installedId: record.installedId,
        version: record.version, source: record.source, downloadUrl: record.downloadUrl,
        ...(record.bundleYml !== undefined ? { bundleYml: record.bundleYml } : {}),
    };
    return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function validCatalogInstallSource(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)
        || ![REQUIRED_KEYS, BUNDLE_KEYS].includes(Object.keys(record).sort().join())
        || !KINDS.includes(record.kind)
        || !ID.test(record.catalogId ?? "") || !ID.test(record.installedId ?? "")
        || !VERSION.test(record.version ?? "") || !ID.test(record.source ?? "")
        || record.source === "local" || record.approved !== true
        || !safeUrl(record.downloadUrl)
        || (record.kind !== "bundle" && record.bundleYml !== undefined)
        || (record.bundleYml !== undefined
            && (typeof record.bundleYml !== "string" || !record.bundleYml.length
                || record.bundleYml.length > 16384))
        || (record.source !== "default" && record.downloadUrl === null
            && record.bundleYml === undefined)
        || typeof record.catalogFingerprint !== "string"
        || !/^[a-f0-9]{64}$/.test(record.catalogFingerprint)) return false;
    return record.catalogFingerprint === catalogInstallFingerprint(record);
}

export function makeCatalogInstallSource(kind, selected, installed, approved) {
    if (!KINDS.includes(kind) || !selected || !installed || approved !== true
        || typeof selected.id !== "string" || !ID.test(selected.id)
        || typeof selected.source !== "string" || !ID.test(selected.source)
        || selected.source === "local"
        || typeof installed.id !== "string" || !ID.test(installed.id)
        || typeof installed.version !== "string" || !VERSION.test(installed.version)) {
        throw new Error("Cannot record an unverified Wizard catalog installation");
    }
    const record = {
        kind, catalogId: selected.id, installedId: installed.id,
        version: installed.version, source: selected.source,
        downloadUrl: selected.downloadUrl ?? null, approved: true,
        ...(kind === "bundle" && selected.bundleYml ? { bundleYml: selected.bundleYml } : {}),
    };
    record.catalogFingerprint = catalogInstallFingerprint(record);
    if (!validCatalogInstallSource(record)) throw new Error("Invalid Wizard catalog installation record");
    return record;
}

export function normalizeCatalogInstallSources(value) {
    if (!Array.isArray(value) || value.length > 120) return [];
    const seen = new Set();
    return value.filter((record) => {
        if (!validCatalogInstallSource(record)) return false;
        const key = `${record.kind}:${record.installedId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).map((record) => ({ ...record }));
}

export function catalogInstallWarning(kind, id, reason = "unverified") {
    const label = kind.slice(0, -1);
    const message = reason === "local"
        ? `Local ${label} '${id}' may not work outside this checkout.`
        : `Can't verify ${label} '${id}' source. Install it via the Wizard and confirm it's Installed. Continuing may leave the generated canvas nonfunctional.`;
    return { kind: label, id, reason, message };
}

export function validCatalogInstallWarning(warning) {
    return !!warning && typeof warning === "object" && !Array.isArray(warning)
        && Object.keys(warning).sort().join() === "id,kind,message,reason"
        && ["preset", "extension", "bundle"].includes(warning.kind)
        && ID.test(warning.id ?? "")
        && ["local", "unverified"].includes(warning.reason)
        && typeof warning.message === "string" && warning.message.length <= 500;
}
