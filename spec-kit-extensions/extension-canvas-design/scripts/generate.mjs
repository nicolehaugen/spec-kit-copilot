import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isWindowsDeviceName } from "../templates/generated-canvas/files.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const featureRoot = join(packageRoot, "templates", "generated-canvas");
const featureFiles = ["server.mjs", "runtime.mjs", "contract.mjs", "files.mjs",
    "phase-response.mjs",
    "ui/app.js", "ui/markdown.mjs", "ui/runtime.css", "ui/workflow-theme.css"];
const idPattern = /^[a-z0-9][a-z0-9-]{0,99}$/;
const reserved = new Set(["speckit-canvas-designer", "speckit-wizard", "speckit-canvas-generator"]);
const RESERVED_GENERATED_PAGE_ID = "workflow";
const requestPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REQUEST_LIMIT = 4 * 1024 * 1024;
const fieldPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const essentialFields = new Set(["canvas.id", "canvas.displayName", "canvas.description",
    "canvas.workflowListName", "workflowSlug.userProvided"]);

function validateFrozenValues(values, constraints) {
    if (!values || typeof values !== "object" || Array.isArray(values)
        || !constraints || typeof constraints !== "object" || Array.isArray(constraints)
        || Object.keys(constraints).length > 10000
        || Object.keys(values).length !== Object.keys(constraints).length
        || Object.keys(values).some((id) => !Object.hasOwn(constraints, id))) {
        throw new Error("Invalid frozen Designer fields");
    }
    for (const [id, rule] of Object.entries(constraints)) {
        if (!fieldPattern.test(id) || !rule || typeof rule !== "object"
            || Array.isArray(rule)) throw new Error(`Invalid frozen Designer field: ${id}`);
        const value = values[id];
        if (rule.type === "string") {
            if (Object.keys(rule).some((key) =>
                !["type", "maxLength", "minLength", "pattern"].includes(key))
                || !Number.isInteger(rule.maxLength) || rule.maxLength < 1
                || rule.maxLength > 1000
                || (rule.minLength !== undefined && (!Number.isInteger(rule.minLength)
                    || rule.minLength < 0 || rule.minLength > rule.maxLength))
                || (id === "canvas.id"
                    ? rule.pattern !== "^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9][a-z0-9-]*$"
                    : rule.pattern !== undefined)
                || typeof value !== "string" || value.length > rule.maxLength
                || value.length < (rule.minLength ?? 0)
                || (id === "canvas.id" && !idPattern.test(value))) {
                throw new Error(`Invalid frozen Designer field: ${id}`);
            }
        } else if (rule.type === "boolean") {
            if (Object.keys(rule).sort().join() !== "type" || typeof value !== "boolean") {
                throw new Error(`Invalid frozen Designer field: ${id}`);
            }
        } else if (rule.type === "object") {
            const properties = rule.properties;
            if (Object.keys(rule).sort().join() !== "properties,type"
                || !properties || typeof properties !== "object" || Array.isArray(properties)
                || !Object.keys(properties).length || Object.keys(properties).length > 10
                || Object.entries(properties).some(([key, allowed]) =>
                    !/^[a-z][A-Za-z0-9]{0,39}$/.test(key)
                    || !Array.isArray(allowed) || !allowed.length || allowed.length > 20
                    || new Set(allowed).size !== allowed.length
                    || allowed.some((option) => typeof option !== "string"
                        || !option || option.length > 80))
                || !value || typeof value !== "object" || Array.isArray(value)
                || Object.keys(value).sort().join() !== Object.keys(properties).sort().join()
                || Object.entries(properties).some(([key, allowed]) =>
                    !allowed.includes(value[key]))) {
                throw new Error(`Invalid frozen Designer field: ${id}`);
            }
        } else throw new Error(`Invalid frozen Designer field: ${id}`);
    }
}

function within(root, path) {
    const part = relative(root, path);
    return part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function configuration(request) {
    const { canvas, workflow, values, fieldConstraints, installed, generatedFields,
        generatedPages, generatedControls } = request;
    validateFrozenValues(values, fieldConstraints);
    if (!canvas || !idPattern.test(canvas.id) || reserved.has(canvas.id)
        || isWindowsDeviceName(canvas.id)
        || !["displayName", "description", "workflowListName"]
        .every((key) => typeof canvas[key] === "string" && canvas[key].trim())
        || canvas.id !== values?.["canvas.id"] || canvas.displayName !== values?.["canvas.displayName"]
        || fieldConstraints["canvas.id"]?.type !== "string"
        || fieldConstraints["canvas.displayName"]?.type !== "string"
        || !values["canvas.displayName"].trim()
        || (Object.hasOwn(values, "canvas.description")
            && fieldConstraints["canvas.description"]?.type !== "string")
        || (Object.hasOwn(values, "canvas.workflowListName")
            && fieldConstraints["canvas.workflowListName"]?.type !== "string")
        || (Object.hasOwn(values, "workflowSlug.userProvided")
            && fieldConstraints["workflowSlug.userProvided"]?.type !== "boolean")
        || canvas.description !== (values["canvas.description"] || "Spec Kit workflow canvas.")
        || canvas.workflowListName !== (values["canvas.workflowListName"] || "Workflows")
        || (values["workflowSlug.userProvided"] !== undefined
            && typeof values["workflowSlug.userProvided"] !== "boolean")
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
                || Array.isArray(field)
                || Object.keys(field).some((key) => !["id", "label", "maxLength", "section"].includes(key))
                || typeof field.id !== "string"
                || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(field.id)
                || typeof field.label !== "string" || !field.label || field.label.length > 120
                || !Number.isInteger(field.maxLength) || field.maxLength < 1
                || field.maxLength > 1000 || typeof values[field.id] !== "string"
                || values[field.id].length > field.maxLength
                || (field.section !== undefined
                    && (!field.section || typeof field.section !== "object"
                        || Array.isArray(field.section)
                        || Object.keys(field.section).sort().join() !== "id,title"
                        || typeof field.section.id !== "string"
                        || !/^[a-z][a-z0-9.-]{0,79}$/.test(field.section.id)
                        || typeof field.section.title !== "string"
                        || !field.section.title.trim() || field.section.title.length > 120))))) {
        throw new Error("Invalid frozen generated fields");
    }
    if (generatedFields?.some(({ id }) => essentialFields.has(id))) {
        throw new Error("Invalid frozen generated values");
    }
    const sections = new Map();
    for (const { section } of generatedFields ?? []) {
        if (!section) continue;
        if (sections.has(section.id) && sections.get(section.id) !== section.title) {
            throw new Error(`Conflicting frozen generated section: ${section.id}`);
        }
        sections.set(section.id, section.title);
    }
    if (generatedPages !== undefined
        && (!Array.isArray(generatedPages) || generatedPages.length > 30
            || new Set(generatedPages.map((page) => page?.id)).size !== generatedPages.length
            || new Set(generatedPages.map((page) => page?.renderer)).size !== generatedPages.length)) {
        throw new Error("Invalid frozen generated pages");
    }
    for (const page of generatedPages ?? []) {
        if (!page || typeof page !== "object" || Array.isArray(page)
            || Object.keys(page).sort().join() !== "assets,id,renderer,title"
            || typeof page.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(page.id)
            || page.id === RESERVED_GENERATED_PAGE_ID || isWindowsDeviceName(page.id)
            || typeof page.renderer !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(page.renderer)
            || isWindowsDeviceName(page.renderer)
            || typeof page.title !== "string" || !page.title.trim() || page.title.length > 120
            || !Array.isArray(page.assets) || page.assets.length !== 2
            || page.assets[0]?.name !== page.id || page.assets[0]?.kind !== "generated.page"
            || page.assets[1]?.name !== page.renderer || page.assets[1]?.kind !== "generated.renderer"
            || page.assets.some((asset) => !asset || typeof asset !== "object"
                || Object.keys(asset).sort().join() !== "content,hash,kind,name,sourceId"
                || typeof asset.sourceId !== "string"
                || !/^[A-Za-z0-9_.:-]{1,160}$/.test(asset.sourceId)
                || typeof asset.content !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.content)
                || asset.content.length > 44 * 1024
                || Buffer.from(asset.content, "base64").length > 32 * 1024
                || typeof asset.hash !== "string"
                || createHash("sha256").update(Buffer.from(asset.content, "base64")).digest("hex") !== asset.hash)) {
            throw new Error("Invalid frozen generated page assets");
        }
        let definition;
        try { definition = JSON.parse(Buffer.from(page.assets[0].content, "base64").toString("utf8")); }
        catch { throw new Error(`${page.id}: invalid frozen generated page definition`); }
        if (!definition || Object.keys(definition).sort().join() !== "id,renderer,schemaVersion,title"
            || definition.schemaVersion !== 1 || definition.id !== page.id
            || definition.renderer !== page.renderer || definition.title !== page.title) {
            throw new Error(`${page.id}: frozen generated page definition differs from registration`);
        }
    }
    if (generatedControls !== undefined
        && (!Array.isArray(generatedControls) || generatedControls.length > 30
            || new Set(generatedControls.map((item) => item?.id)).size !== generatedControls.length
            || generatedControls.some((item) => generatedFields?.some((field) => field.id === item.id)))) {
        throw new Error("Invalid frozen generated controls");
    }
    for (const item of generatedControls ?? []) {
        if (!item || Object.keys(item).sort().join() !== "assets,control,id,label,slot,value"
            || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(item.id)
            || !/^[a-z][a-z0-9-]{0,79}$/.test(item.control)
            || !item.label || typeof item.label !== "string" || item.label.length > 120
            || item.slot !== "details.content" || !Array.isArray(item.assets)
            || item.assets.length !== 2
            || item.assets[0]?.kind !== "control.definition"
            || item.assets[1]?.kind !== "generated.adapter") {
            throw new Error("Invalid frozen generated control registration");
        }
        for (const asset of item.assets) {
            if (!asset || Object.keys(asset).sort().join() !== "content,hash,kind,name,sourceId"
                || !/^[a-z][a-z0-9-]{0,79}$/.test(asset.name)
                || typeof asset.sourceId !== "string"
                || !/^[A-Za-z0-9_.:-]{1,160}$/.test(asset.sourceId)
                || typeof asset.content !== "string"
                || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.content)
                || asset.content.length > 44 * 1024
                || Buffer.from(asset.content, "base64").length > 32 * 1024
                || createHash("sha256").update(Buffer.from(asset.content, "base64")).digest("hex") !== asset.hash) {
                throw new Error("Invalid frozen generated control asset");
            }
        }
        let definition;
        try { definition = JSON.parse(Buffer.from(item.assets[0].content, "base64").toString("utf8")); }
        catch { throw new Error(`${item.id}: invalid control definition`); }
        if (definition?.schemaVersion !== 1 || definition.id !== item.control
            || definition.adapters?.generated !== item.assets[1].name
            || !definition.adapters?.designer
            || item.assets[0].name === item.assets[1].name
            || definition.value?.type !== "object"
            || !definition.value.properties
            || typeof definition.value.properties !== "object"
            || Array.isArray(definition.value.properties)
            || !Object.keys(definition.value.properties).length
            || Object.keys(definition.value.properties).length > 10
            || Object.entries(definition.value.properties).some(([key, allowed]) =>
                !/^[a-z][A-Za-z0-9]{0,39}$/.test(key)
                || !Array.isArray(allowed) || !allowed.length || allowed.length > 20
                || new Set(allowed).size !== allowed.length
                || allowed.some((value) => typeof value !== "string" || !value || value.length > 80))
            || !item.value || typeof item.value !== "object" || Array.isArray(item.value)
            || Object.keys(item.value).sort().join() !== Object.keys(definition.value.properties).sort().join()
            || Object.entries(definition.value.properties).some(([key, allowed]) =>
                !allowed.includes(item.value[key]))
            || JSON.stringify(values[item.id]) !== JSON.stringify(item.value)) {
            throw new Error(`${item.id}: incompatible frozen control value or adapters`);
        }
    }
    const outputs = {
        constitution: ".specify/memory/constitution.md", specify: "specs/<slug>/spec.md",
        clarify: "specs/<slug>/spec.md", plan: "specs/<slug>/plan.md",
        tasks: "specs/<slug>/tasks.md", analyze: "specs/<slug>/analysis.md",
        checklist: "specs/<slug>/checklists/<name>.md",
    };
    return { schemaVersion: 1, canvas, userProvidesSlug: values["workflowSlug.userProvided"] ?? false,
        ...(generatedPages?.length ? { generatedPages: generatedPages.map(({ id, title, renderer }) =>
            ({ id, title, renderer })) } : {}),
        ...(generatedFields?.length ? { readOnlyFields: generatedFields.map(({ id, label, section }) =>
            ({ id, label, value: values[id], ...(section ? { section } : {}) })) } : {}),
        ...(generatedControls?.length ? { generatedControls: generatedControls.map(
            ({ id, label, control, slot, value, assets }) =>
                ({ id, label, control, slot, value, adapter: assets[1].name,
                    properties: JSON.parse(Buffer.from(assets[0].content, "base64").toString("utf8"))
                        .value.properties })) } : {}),
        phases: workflow.selectedPhases,
        phaseOutputs: Object.fromEntries(workflow.selectedPhases.map((phase) => {
            const path = outputs[phase.replace(/^speckit\./, "")] ?? null;
            return [phase, { expectsArtifact: !!path, outputPath: path }];
        })), phaseArtifacts: {},
        installed: {
            presets: installed.presets.map(({ id, version, priority }) => ({ id, version, priority })),
            extensions: installed.extensions.map(({ id, version, priority }) => ({ id, version, priority })),
            bundles: installed.bundles.map(({ id, version }) => ({ id, version })),
        } };
}

function checkSyntax(path) {
    const check = spawnSync("node", ["--check", path], { encoding: "utf8" });
    if (check.error || check.status !== 0) throw new Error(`Generated JavaScript failed validation: ${check.stderr || check.error}`);
}

export async function readBoundedSessionFile(parent, name, limit, label, openFile = open) {
    const invalid = `${label} must be a bounded regular session file`;
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || await realpath(parent) !== parent) {
        throw new Error(invalid);
    }
    const path = join(parent, name);
    let file;
    try {
        file = await openFile(path, constants.O_RDONLY
            | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
        if (error.code === "ELOOP") throw new Error(invalid, { cause: error });
        throw error;
    }
    try {
        const [stat, pathStat, currentParent, currentParentStat] = await Promise.all([
            file.stat(), lstat(path), realpath(parent), lstat(parent),
        ]);
        if (currentParent !== parent || !currentParentStat.isDirectory()
            || parentStat.dev !== currentParentStat.dev || parentStat.ino !== currentParentStat.ino
            || !stat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink()
            || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
            throw new Error(invalid);
        }
        if (stat.size > limit) throw new Error(`${label} is too large`);
        const bytes = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < bytes.length) {
            const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
            if (bytesRead === 0) break;
            length += bytesRead;
        }
        if (length > limit) throw new Error(`${label} is too large`);
        return bytes.toString("utf8", 0, length);
    } finally {
        await file.close();
    }
}

export async function materialize(project, workspace, handoffId, requestId) {
    if (!requestPattern.test(handoffId) || !requestPattern.test(requestId)) throw new Error("Invalid generation identifiers");
    const projectRoot = await realpath(project), workspaceRoot = await realpath(workspace);
    const generation = join(workspaceRoot, "speckit-canvas-designer", "handoffs", handoffId, "generations", requestId);
    if (await realpath(generation) !== generation) {
        throw new Error("Generation request escapes its session directory");
    }
    const request = JSON.parse(await readBoundedSessionFile(
        generation, "request.json", REQUEST_LIMIT, "Generation request"));
    const { integrity, ...payload } = request;
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    if (integrity !== hash || request.handoffId !== handoffId || request.requestId !== requestId) {
        throw new Error("Generation request integrity mismatch");
    }
    if (request.project !== projectRoot) throw new Error("Generation request is bound to another checkout");
    const handoffFolder = join(workspaceRoot, "speckit-canvas-designer", "handoffs", handoffId);
    const handoff = JSON.parse(await readBoundedSessionFile(
        handoffFolder, "handoff.json", 64 * 1024, "Wizard handoff"));
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
    const pageFiles = (request.generatedPages ?? []).flatMap((page) => [
        { filename: `${page.id}.json`, bytes: Buffer.from(page.assets[0].content, "base64") },
        { filename: `${page.renderer}.mjs`, bytes: Buffer.from(page.assets[1].content, "base64") },
    ]);
    const controlFiles = (request.generatedControls ?? []).flatMap((item) => [
        { filename: `${item.assets[0].name}.json`, bytes: Buffer.from(item.assets[0].content, "base64") },
        { filename: `${item.assets[1].name}.mjs`, bytes: Buffer.from(item.assets[1].content, "base64") },
    ]);
    const distinctControlFiles = new Map();
    for (const file of controlFiles) {
        if (distinctControlFiles.has(file.filename)
            && !distinctControlFiles.get(file.filename).equals(file.bytes)) {
            throw new Error(`Conflicting generated control asset: ${file.filename}`);
        }
        distinctControlFiles.set(file.filename, file.bytes);
    }
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
    if (pageFiles.length) await mkdir(join(target, "pages"));
    if (controlFiles.length) await mkdir(join(target, "controls"));
    for (const { filename, bytes } of pageFiles) {
        const path = join(target, "pages", filename);
        await writeFile(path, bytes, { flag: "wx" });
        if (filename.endsWith(".mjs")) checkSyntax(path);
    }
    for (const [filename, bytes] of distinctControlFiles) {
        const path = join(target, "controls", filename);
        await writeFile(path, bytes, { flag: "wx" });
        if (filename.endsWith(".mjs")) checkSyntax(path);
    }
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
