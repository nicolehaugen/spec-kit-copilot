import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isWindowsDeviceName } from "../generated-scaffold/files.mjs";

const exec = promisify(execFile);
const NAME = /^[a-z][a-z0-9-]{0,79}$/;
const KINDS = new Set(["designer.setting-definition",
    "generated.workflow-page-definition", "generated.phase-control-definition",
    "generated.phase-control-adapter",
    "generated.phase-control-placement", "generated.field-placement",
    "generated.added-page-definition", "generated.added-page-renderer",
    "shared.control-definition", "designer.control-adapter", "generated.control-adapter",
    "generated.value-definition", "generated.computed-value-provider"]);
const HEADINGS = new Set(["Pages", "Additional Designer pages",
    "Canvas Design templates", "Additional Canvas Design templates"]);
const EXECUTABLE = new Set(["generated.phase-control-adapter", "generated.added-page-renderer",
    "designer.control-adapter", "generated.control-adapter", "generated.computed-value-provider"]);

export function isInside(root, target) {
    const part = relative(root, target);
    return !!part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

export function declarations(command) {
    const result = new Map();
    let heading = "";
    for (const line of command.split(/\r?\n/)) {
        const title = line.match(/^## (.+?)\s*$/);
        if (title) { heading = title[1]; continue; }
        if (!HEADINGS.has(heading) || !/^\s*-\s/.test(line)) continue;
        const names = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
        const name = names[0];
        if (!NAME.test(name ?? "") || isWindowsDeviceName(name)) {
            throw new Error(`Invalid Canvas Design registration: ${line.trim()}`);
        }
        const page = heading === "Pages" || heading === "Additional Designer pages";
        const kind = page ? "designer.tab-definition" : names[1];
        const strategy = page ? "replace" : names[2];
        if ((!page && (names.length !== 3 || !KINDS.has(kind) || strategy !== "replace"))
            || (page && names.length !== 1
                && (names.length !== 3 || names[1] !== kind || names[2] !== strategy))) {
            throw new Error(`Invalid Canvas Design kind or strategy for ${name}.`);
        }
        const existing = result.get(name);
        if (existing && existing.kind !== kind) {
            throw new Error(`Conflicting Canvas Design registration for ${name}.`);
        }
        if (!existing) result.set(name, { name, kind, strategy: "replace" });
    }
    if (![...result.values()].some((entry) => entry.kind === "designer.tab-definition")) {
        throw new Error("Generated load-page skill is missing Designer pages.");
    }
    return [...result.values()];
}

async function cli(project, args, run) {
    const { stdout, stderr = "" } = await run(process.platform === "win32" ? "specify.exe" : "specify",
        args, { cwd: project, timeout: 10000, maxBuffer: 128 * 1024,
            env: { ...process.env, COLUMNS: "8192", NO_COLOR: "1" } });
    if (stderr.trim()) {
        throw new Error(`Specify ${args.join(" ")} reported a warning or missing result: ${stdout} ${stderr}`);
    }
    return stdout;
}

export async function verifyComposition(project, run = exec) {
    const child = await realpath(project);
    const skill = join(child, ".github", "skills", "speckit-extension-canvas-design-load-page", "SKILL.md");
    const entries = declarations(await readFile(skill, "utf8"));
    const pages = [], templates = [];
    for (const entry of entries) {
        const output = await cli(child, ["preset", "resolve", entry.name], run);
        const lines = output.trim().split(/\r?\n/).map((line) => line.trim());
        const prefix = `${entry.name}:`;
        if (lines.some((line) => /^Warning:/i.test(line))
            || lines[0] === `${prefix} not found`) {
            throw new Error(`Specify did not resolve ${entry.name}: warning or missing result.`);
        }
        if (!lines[0]?.startsWith(prefix)) throw new Error(`Specify did not resolve ${entry.name}.`);
        const path = (lines[0].slice(prefix.length).trim() || lines[1] || "").trim();
        const meta = lines.find((line) => line.startsWith("(top layer from: ")
            && line.endsWith(")"));
        if (!isAbsolute(path) || !meta || lines.length > 3
            || lines.filter((line) => line.startsWith(prefix)).length !== 1) {
            throw new Error(`Specify returned an incomplete resolution for ${entry.name}.`);
        }
        const raw = meta.slice("(top layer from: ".length, -1);
        const sourceId = raw === "project override" ? "project"
            : raw.replace(/ v[A-Za-z0-9][A-Za-z0-9._+-]*$/, "");
        if (sourceId !== "project" && !/^(?:extension:)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sourceId)) {
            throw new Error(`Specify returned an unknown source for ${entry.name}.`);
        }
        const info = JSON.parse(await cli(child,
            ["artifact", "info", `template:${entry.name}`, "--json"], run));
        const layers = info.stack;
        const winner = layers?.find((layer) => layer.active);
        const target = await realpath(path);
        const root = await realpath(join(child, ".specify"));
        if (info.kind !== "template" || info.name !== entry.name
            || !Array.isArray(layers) || !layers.length
            || layers.some((layer) => layer.strategy !== "replace")
            || !winner || layers.filter((layer) => layer.active).length !== 1
            || !isInside(root, target)
            || !winner.sourcePath || target !== await realpath(resolve(child, winner.sourcePath))) {
            throw new Error(`${entry.name}: resolution or replace-only template stack does not match Specify.`);
        }
        const expectedSource = winner.layer === "project" ? "project"
            : `${winner.layer === "extension" ? "extension:" : ""}${winner.sourceId}`;
        if (sourceId !== expectedSource) throw new Error(`${entry.name}: resolved source does not match the winner.`);
        if (EXECUTABLE.has(entry.kind)) {
            try {
                await cli(child, ["artifact", "info", `script:${entry.name}`, "--json"], run);
                throw new Error(`${entry.name}: native script collision.`);
            } catch (error) {
                if (error.code !== 1) throw error;
                let detail;
                try { detail = JSON.parse(error.stdout || error.stderr); }
                catch { throw new Error(`${entry.name}: unverified script metadata.`, { cause: error }); }
                if (detail.error !== `unknown artifact script:${entry.name}`) {
                    throw new Error(`${entry.name}: native script collision or unverified script metadata.`);
                }
            }
        }
        const verified = { ...entry, path };
        if (entry.kind === "designer.tab-definition") pages.push(verified);
        else templates.push({ ...verified, sourceId });
    }
    return { pages, templates };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { console.log(JSON.stringify(await verifyComposition(process.argv[2] ?? process.cwd()))); }
    catch (error) {
        console.error(`Designer composition verification failed: ${error.message}`);
        process.exitCode = 1;
    }
}
