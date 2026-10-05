import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readHandoff } from "../../speckit-canvas-designer/handoff.mjs";
import { specifySpawnOptions } from "../env/specify-invocation.mjs";
import { validateLocalSource } from "./designer-local-sources.mjs";

const exec = promisify(execFile);
const manifestName = { presets: "preset.yml", extensions: "extension.yml" };

function localEntries(handoff) {
    return Object.entries(manifestName).flatMap(([kind]) =>
        (handoff.localSelections?.[kind] ?? []).map((entry) => ({ ...entry, kind })));
}

export async function preflight(project, sessionRoot, handoffId, expectedHash, run = exec) {
    const child = await realpath(project);
    const root = await realpath(sessionRoot);
    if (child === root || !/^[a-f0-9]{64}$/.test(expectedHash)) {
        throw new Error("Invalid child checkout, session root, or handoff hash.");
    }
    const handoff = await readHandoff(root, handoffId, undefined, expectedHash);
    const path = join(root, "speckit-canvas-designer", "handoffs", handoffId, "handoff.json");
    const { stdout } = await run(process.platform === "win32" ? "specify.exe" : "specify",
        ["--version"], await specifySpawnOptions(child, { timeout: 10000, maxBuffer: 4096 }));
    const version = stdout.match(/\bspecify\s+(\d+)\.(\d+)\.(\d+)\b/);
    if (!version || Number(version[1]) < 1
        || (Number(version[1]) === 1 && Number(version[2]) === 0 && Number(version[3]) < 7)) {
        throw new Error("Designer launch requires Specify CLI >=1.0.7.");
    }
    const setup = join(child, ".specify");
    let initialized = false;
    try {
        initialized = (await lstat(setup)).isDirectory();
        if (!initialized) throw new Error(`Child setup is not a directory: ${setup}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const locals = [];
    for (const entry of localEntries(handoff)) {
        const checked = await validateLocalSource(entry.kind, entry.path);
        if (checked.id !== entry.id || checked.path !== entry.path) {
            throw new Error(`Approved local ${entry.kind} ${entry.id} changed path or manifest.`);
        }
        locals.push({ kind: entry.kind, id: entry.id, path: checked.path });
    }
    return { checkout: child, sessionRoot: root, handoffPath: path,
        initialized, specifyVersion: version[0], locals };
}

export async function verifyLocalInstall(project, handoff, kind, id, run = exec) {
    if (!manifestName[kind] || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)) {
        throw new Error("Invalid local package verification request.");
    }
    const entry = handoff.localSelections?.[kind]?.find((item) => item.id === id);
    if (!entry) throw new Error(`Local ${kind} ${id} was not approved in the handoff.`);
    const source = await validateLocalSource(kind, entry.path);
    if (source.path !== entry.path || source.id !== id) {
        throw new Error(`Approved local ${kind} ${id} has a different path or manifest id.`);
    }
    const child = await realpath(project);
    const installedPath = join(child, ".specify", kind, id);
    const installed = await validateLocalSource(kind, installedPath);
    const installedRel = relative(join(child, ".specify"), installedPath);
    if (installed.id !== id || installedRel.startsWith("..") || resolve(installedPath) !== installedPath
        || (installed.path !== installedPath && installed.path !== source.path)) {
        throw new Error(`Installed local ${kind} ${id} has an unexpected path or manifest id.`);
    }
    const { stdout } = await run(process.platform === "win32" ? "specify.exe" : "specify",
        [kind === "presets" ? "preset" : "extension", "list", "--json"],
        await specifySpawnOptions(child, { timeout: 10000, maxBuffer: 128 * 1024 }));
    const inventory = JSON.parse(stdout);
    const actual = inventory.find((item) => item.id === id);
    if (!actual || actual.source?.kind !== "local") {
        throw new Error(`Installed local ${kind} ${id} is missing or is not a local installation.`);
    }
    return { kind, id, source: source.path, installed: installed.path };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const [, , mode, project, root, handoffId, ...rest] = process.argv;
        const result = mode === "preflight"
            ? await preflight(project, root, handoffId, rest[0])
            : mode === "verify-local"
                ? await verifyLocalInstall(project, await readHandoff(root, handoffId),
                    rest[0], rest[1])
                : (() => { throw new Error("Expected preflight or verify-local mode."); })();
        console.log(JSON.stringify(result));
    } catch (error) {
        console.error(`Designer launch verification failed: ${error.message}`);
        process.exitCode = 1;
    }
}
