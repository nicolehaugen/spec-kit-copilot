import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const featureRoot = join(packageRoot, "templates", "generated-canvas");
const featureFiles = ["server.mjs", "runtime.mjs", "contract.mjs", "files.mjs",
    "phase-response.mjs",
    "ui/app.js", "ui/markdown.mjs", "ui/runtime.css", "ui/workflow-theme.css"];
const idPattern = /^[a-z0-9][a-z0-9-]{0,99}$/;
const reserved = new Set(["speckit-canvas-designer", "speckit-wizard", "speckit-canvas-generator"]);
const requestPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function within(root, path) {
    const part = relative(root, path);
    return part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function configuration(request) {
    const { canvas, workflow, values, installed, generatedFields } = request;
    if (!canvas || !idPattern.test(canvas.id) || reserved.has(canvas.id)
        || !["displayName", "description", "workflowListName"]
        .every((key) => typeof canvas[key] === "string" && canvas[key].trim())
        || canvas.id !== values?.["canvas.id"] || canvas.displayName !== values?.["canvas.displayName"]
        || typeof values?.["workflowSlug.userProvided"] !== "boolean"
        || !workflow || !Array.isArray(workflow.selectedPhases) || !workflow.selectedPhases.length
        || workflow.selectedPhases.length > 30 || new Set(workflow.selectedPhases).size !== workflow.selectedPhases.length
        || workflow.selectedPhases.some((phase) => typeof phase !== "string"
            || !/^(?:speckit\.)?[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(phase))
        || !installed || ["presets", "extensions", "bundles"].some((kind) =>
            !Array.isArray(installed[kind]) || installed[kind].some((item) =>
                typeof item.id !== "string" || typeof item.version !== "string"))) {
        throw new Error("Invalid frozen canvas identity, workflow or runtime inventory");
    }
    if (generatedFields !== undefined
        && (!Array.isArray(generatedFields) || generatedFields.length > 100
            || new Set(generatedFields.map((field) => field?.id)).size !== generatedFields.length
            || generatedFields.some((field) => !field || typeof field !== "object"
                || Array.isArray(field) || Object.keys(field).sort().join() !== "id,label,maxLength"
                || typeof field.id !== "string"
                || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(field.id)
                || typeof field.label !== "string" || !field.label || field.label.length > 120
                || !Number.isInteger(field.maxLength) || field.maxLength < 1
                || field.maxLength > 1000 || typeof values[field.id] !== "string"
                || values[field.id].length > field.maxLength))) {
        throw new Error("Invalid frozen generated fields");
    }
    const outputs = {
        constitution: ".specify/memory/constitution.md", specify: "specs/<slug>/spec.md",
        clarify: "specs/<slug>/spec.md", plan: "specs/<slug>/plan.md",
        tasks: "specs/<slug>/tasks.md", analyze: "specs/<slug>/analysis.md",
        checklist: "specs/<slug>/checklists/<name>.md",
    };
    return { schemaVersion: 1, canvas, userProvidesSlug: values["workflowSlug.userProvided"],
        ...(generatedFields?.length ? { readOnlyFields: generatedFields.map(({ id, label }) =>
            ({ id, label, value: values[id] })) } : {}),
        phases: workflow.selectedPhases,
        phaseOutputs: Object.fromEntries(workflow.selectedPhases.map((phase) => {
            const path = outputs[phase.replace(/^speckit\./, "")] ?? null;
            return [phase, { expectsArtifact: !!path, outputPath: path }];
        })), phaseArtifacts: {},
        installed };
}

function checkSyntax(path) {
    const check = spawnSync("node", ["--check", path], { encoding: "utf8" });
    if (check.error || check.status !== 0) throw new Error(`Generated JavaScript failed validation: ${check.stderr || check.error}`);
}

export async function materialize(project, workspace, handoffId, requestId) {
    if (!requestPattern.test(handoffId) || !requestPattern.test(requestId)) throw new Error("Invalid generation identifiers");
    const projectRoot = await realpath(project), workspaceRoot = await realpath(workspace);
    const generation = join(workspaceRoot, "speckit-canvas-designer", "handoffs", handoffId, "generations", requestId);
    if (await realpath(generation) !== generation) {
        throw new Error("Generation request escapes its session directory");
    }
    const requestPath = join(generation, "request.json");
    if (!(await lstat(requestPath)).isFile() || await realpath(requestPath) !== requestPath) {
        throw new Error("Frozen generation request must be a regular session file");
    }
    const raw = await readFile(requestPath);
    if (raw.length > 128 * 1024) throw new Error("Generation request is too large");
    const request = JSON.parse(raw.toString("utf8"));
    const { integrity, ...payload } = request;
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    if (integrity !== hash || request.handoffId !== handoffId || request.requestId !== requestId) {
        throw new Error("Generation request integrity mismatch");
    }
    if (request.project !== projectRoot) throw new Error("Generation request is bound to another checkout");
    const handoffPath = join(workspaceRoot, "speckit-canvas-designer",
        "handoffs", handoffId, "handoff.json");
    const handoffStat = await lstat(handoffPath);
    if (!handoffStat.isFile() || handoffStat.size > 64 * 1024
        || await realpath(handoffPath) !== handoffPath) {
        throw new Error("Wizard handoff must be a bounded regular session file");
    }
    const handoff = JSON.parse(await readFile(handoffPath, "utf8"));
    if (handoff.handoffId !== handoffId || handoff.sourceFingerprint !== request.sourceFingerprint
        || handoff.sourceFingerprint !== createHash("sha256").update(JSON.stringify({
            workflow: handoff.workflow, selections: handoff.selections,
            localSelections: handoff.localSelections,
        })).digest("hex")
        || JSON.stringify(handoff.workflow.selectedPhases) !== JSON.stringify(request.workflow.selectedPhases)
        || JSON.stringify(handoff.workflow.installed) !== JSON.stringify(request.installed)) {
        throw new Error("Frozen generation request differs from the Wizard handoff");
    }
    const config = configuration(request);
    const target = join(projectRoot, ".github", "extensions", config.canvas.id);
    if (!within(projectRoot, target) || request.target !== `.github/extensions/${config.canvas.id}/`) {
        throw new Error("Generation target is invalid");
    }
    const files = await Promise.all([...featureFiles, "extension.mjs"].map(async (file) =>
        [file, await readFile(join(featureRoot, file))]));
    const github = join(projectRoot, ".github");
    await mkdir(github, { recursive: true });
    if (await realpath(github) !== github) {
        throw new Error("Canvas extension directory escapes the checkout");
    }
    const parent = join(projectRoot, ".github", "extensions");
    await mkdir(parent, { recursive: true });
    if (await realpath(parent) !== parent) {
        throw new Error("Canvas extension directory escapes the checkout");
    }
    try {
        await mkdir(target);
    } catch (error) {
        if (error.code === "EEXIST") throw new Error(`Canvas extension already exists: ${target}`);
        throw error;
    }
    await mkdir(join(target, "ui"));
    for (const [file, content] of files) {
        if (file !== "extension.mjs") {
            await writeFile(join(target, file), content, { flag: "wx" });
        }
    }
    await writeFile(join(target, "canvas-config.json"), JSON.stringify(config), { flag: "wx" });
    await writeFile(join(target, "canvas-setup.json"), JSON.stringify({ values: request.values }), { flag: "wx" });
    await writeFile(join(target, "settings-provenance.json"),
        JSON.stringify({ requestId, handoffId, sourceFingerprint: request.sourceFingerprint }), { flag: "wx" });
    await writeFile(join(target, "extension.mjs"), files.at(-1)[1], { flag: "wx" });
    for (const file of [...featureFiles, "extension.mjs"]) {
        if (file.endsWith(".mjs") || file.endsWith(".js")) checkSyntax(join(target, file));
    }
    const renderer = spawnSync("node", ["--input-type=module", "-e",
        "const m=await import(process.argv[1]);m.renderHtml(m.readConfig());",
        pathToFileURL(join(target, "server.mjs")).href],
    { encoding: "utf8" });
    if (renderer.error || renderer.status !== 0) throw new Error(`Workflow renderer failed: ${renderer.stderr || renderer.error}`);
    return { target: request.target, canvasId: config.canvas.id };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    materialize(...process.argv.slice(2)).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
        .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
