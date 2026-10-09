import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { confined, countMarkdownDirectory, readBoundedWithMetadata, readRegularFileMetadata,
    safePath } from "./files.mjs";

const adapterId = /^[a-z][a-z0-9-]{0,79}$/;
const identifier = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const instanceId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const colors = (color) => /^(?:theme|red|green|amber|blue|purple|pink|orange|#[0-9a-fA-F]{6})$/.test(color);
const placements = new Set(["workflow-list", "workflow-summary", "phase-card"]);
const inputTypes = new Set(["artifact", "artifact-set", "ordered-artifacts", "phase", "text"]);

if (!isMainThread && workerData?.badgeEvaluation) {
    try {
        const { adapter, hash, ruleId, inputs, evidence: data, workflowId } = workerData.badgeEvaluation;
        const bytes = await readFile(new URL(`./badges/${adapter}.mjs`, import.meta.url));
        if (!bytes.length || bytes.length > 32 * 1024
            || createHash("sha256").update(bytes).digest("hex") !== hash)
            throw new Error("Packaged badge evaluator changed after startup");
        const evaluator = await import(`data:text/javascript;base64,${bytes.toString("base64")}`);
        if (evaluator.contractVersion !== 1 || typeof evaluator.evaluate !== "function")
            throw new Error("Incompatible badge evaluator");
        const evidence = {
            readArtifact: async ({ phase, output }) =>
                data.files[JSON.stringify([phase, output])] ?? {
                    state: "unknown", diagnostic: "Artifact was not declared for badge evaluation.",
                },
            getRun: async (phase) => data.runs[phase] ?? null,
            countMarkdownFiles: async ({ phase, output }) =>
                data.directories[JSON.stringify([phase, output])] ?? {
                    state: "unknown", diagnostic: "Badge directory was not declared for evaluation.",
                },
        };
        const result = await evaluator.evaluate({ ruleId, inputs, evidence, workflowId });
        if (!result || typeof result.match !== "boolean"
            || (result.values !== undefined && (typeof result.values !== "object" || !result.values
                || Array.isArray(result.values)))
            || (result.summaryCount !== undefined && (!Number.isSafeInteger(result.summaryCount)
                || result.summaryCount < 0 || result.summaryCount > 1_000_000))
            || (result.diagnostics !== undefined && (!Array.isArray(result.diagnostics)
                || result.diagnostics.some((text) => typeof text !== "string"))))
            throw new Error("Invalid badge evaluator result");
        if (JSON.stringify(result).length > 8192) throw new Error("Badge evaluator result exceeds limit");
        parentPort.postMessage({ result });
    } catch (error) { parentPort.postMessage({ error: error.message }); }
}

function validArtifact(value) {
    return value && typeof value === "object" && typeof value.phase === "string"
        && (value.output === undefined || typeof value.output === "string");
}

export function validateBadges(config, phases = []) {
    if (config === undefined) return;
    const phaseIds = phases.map((phase) => typeof phase === "string" ? phase : phase.id);
    const declared = ({ phase, output }) => {
        const step = phases.find((entry) => typeof entry !== "string" && entry.id === phase);
        return phaseIds.includes(phase) && typeof output === "string"
            && (!step || step.outputs.includes(output));
    };
    if (!config || !Array.isArray(config.instances) || !Array.isArray(config.types)
        || !Array.isArray(config.rules) || config.instances.length > 100
        || config.types.length > 100 || config.rules.length > 100
        || Object.keys(config).some((key) => !["instances", "types", "rules"].includes(key)))
        throw new Error("Invalid generated badge configuration");
    const unique = (list) => new Set(list.map((entry) => entry.id)).size === list.length;
    if (!unique(config.instances) || !unique(config.types) || !unique(config.rules))
        throw new Error("Duplicate generated badge ID");
    for (const rule of config.rules) {
        if (!rule || Object.hasOwn(rule, "module") || !identifier.test(rule.id)
            || typeof rule.adapter !== "string" || !adapterId.test(rule.adapter)
            || !hashPattern.test(rule.hash) || typeof rule.label !== "string"
            || typeof rule.description !== "string" || !Array.isArray(rule.textPlaceholders)
            || rule.textPlaceholders.some((placeholder) => !identifier.test(
                typeof placeholder === "string" ? placeholder : placeholder?.id))
            || !Array.isArray(rule.inputs) || rule.inputs.length > 10
            || !unique(rule.inputs) || rule.inputs.some(({ id, type }) =>
                !identifier.test(id) || !inputTypes.has(type))
            || (rule.placementPhaseInput !== undefined
                && !rule.inputs.some((input) => input.id === rule.placementPhaseInput
                    && input.type === "artifact"))
            || rule.inputs.some(({ label }) => label !== undefined
                && (typeof label !== "string" || !label.trim() || label.length > 80))
            || rule.inputs.some(({ type, scope, before }) =>
                scope !== undefined && !(type === "artifact" && ["directory", "metadata"].includes(scope)
                    || type === "ordered-artifacts" && scope === "metadata")
                || type === "ordered-artifacts" && (before === undefined || scope !== "metadata")
                || before !== undefined && (type !== "ordered-artifacts"
                    || !rule.inputs.some((input) => input.id === before && input.type === "artifact"
                        && input.scope === "metadata"))))
            throw new Error("Invalid generated badge rule");
    }
    for (const type of config.types) {
        if (!type || !identifier.test(type.id) || !config.rules.some((rule) => rule.id === type.rule)
            || typeof type.title !== "string" || typeof type.description !== "string"
            || typeof type.defaultText !== "string" || type.defaultText.length > 160
            || !colors(type.defaultColor) || typeof type.enabled !== "boolean")
            throw new Error("Invalid generated badge type");
    }
    for (const instance of config.instances) {
        const type = config.types.find((entry) => entry.id === instance?.type);
        const rule = config.rules.find((entry) => entry.id === type?.rule);
        if (!instance || !instanceId.test(instance.id) || !type || !rule
            || !instance.inputs || typeof instance.inputs !== "object"
            || Array.isArray(instance.inputs)
            || Object.keys(instance.inputs).sort().join() !== rule.inputs.map(({ id }) => id).sort().join()
            || (instance.text !== undefined && (typeof instance.text !== "string" || instance.text.length > 160))
            || (instance.phaseText !== undefined && (typeof instance.phaseText !== "string"
                || !instance.phaseText.trim() || instance.phaseText.length > 120
                || !(instance.targets?.length || instance.showIn?.includes("phase-card"))))
            || (instance.summaryText !== undefined && (typeof instance.summaryText !== "string"
                || !instance.summaryText.trim() || instance.summaryText.length > 120
                || !instance.showIn?.includes("workflow-summary")))
            || (instance.color !== undefined && !colors(instance.color))
            || !Array.isArray(instance.showIn)
            || instance.showIn.some((place) => !placements.has(place))
            || (instance.targets === undefined
                ? (instance.showIn.includes("phase-card")
                    ? !phaseIds.includes(instance.phase)
                        || instance.phase.replace(/^speckit\./, "") === "constitution"
                    : instance.phase != null)
                : instance.phase != null || instance.showIn.includes("phase-card")
                    || !Array.isArray(instance.targets) || instance.targets.length > 100
                    || new Set(instance.targets.map((target) =>
                        JSON.stringify([target?.phase, target?.output]))).size !== instance.targets.length
                    || instance.targets.some((target) => !target
                        || !phaseIds.includes(target.phase)
                        || target.phase.replace(/^speckit\./, "") === "constitution"
                        || (target.output !== null
                            && (!rule.inputs.some((input) =>
                                input.type === "artifact" || input.type === "artifact-set")
                                || !declared(target))))))
            throw new Error("Invalid generated badge instance");
        for (const input of rule.inputs) {
            const value = instance.inputs[input.id];
            if (input.type === "phase" ? typeof value !== "string" || !phaseIds.includes(value)
                : input.type === "text" ? typeof value !== "string" || !value.trim()
                    || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)
                : input.type === "artifact" ? !validArtifact(value) || !declared(value)
                : input.type === "ordered-artifacts"
                    ? !Array.isArray(value) || value.length > 100 || value.some((entry) =>
                        !validArtifact(entry) || Object.keys(entry).sort().join() !== "output,phase"
                            || !declared(entry))
                    : !Array.isArray(value) || value.length > 100 || value.some((entry) =>
                        !entry || !phaseIds.includes(entry.phase) || !Array.isArray(entry.outputs)
                        || entry.outputs.length > 100 || entry.outputs.some((path) =>
                            !declared({ phase: entry.phase, output: path }))))
                throw new Error("Invalid generated badge input");
            if (input.type === "ordered-artifacts") {
                const target = instance.inputs[input.before];
                const chain = [...value, target];
                if (!target || !declared(target)
                    || chain.some((entry, index) => index
                        && phaseIds.indexOf(chain[index - 1].phase) >= phaseIds.indexOf(entry.phase))
                    || new Set(chain.map((entry) => entry.output.toLowerCase())).size !== chain.length) {
                    throw new Error("Invalid generated badge evidence order");
                }
            }
        }
        if (rule.id === "checklist-complete"
            && rule.inputs.some((input) => input.id === "prerequisite")
            && (phaseIds.indexOf(instance.inputs.prerequisite.phase)
                >= phaseIds.indexOf(instance.inputs.artifact.phase)
                || instance.inputs.prerequisite.output.toLowerCase()
                    === instance.inputs.artifact.output.toLowerCase())) {
            throw new Error("Invalid generated badge prerequisite");
        }
        if (rule.placementPhaseInput
            && (instance.targets?.length
                ? instance.targets.length !== 1 || instance.targets[0].output !== null
                    || instance.targets[0].phase !== instance.inputs[rule.placementPhaseInput].phase
                : instance.showIn.includes("phase-card")
                    && instance.phase !== instance.inputs[rule.placementPhaseInput].phase)) {
            throw new Error("Invalid generated badge phase-card destination");
        }
    }
}

export async function verifyBadgeModules(badges) {
    const checked = new Map();
    for (const { adapter, hash } of badges?.rules ?? []) {
        if (checked.has(adapter)) {
            if (checked.get(adapter) !== hash) throw new Error(`Conflicting frozen badge evaluator ${adapter}`);
            continue;
        }
        checked.set(adapter, hash);
        const bytes = await readFile(new URL(`./badges/${adapter}.mjs`, import.meta.url));
        if (!bytes.length || bytes.length > 32 * 1024
            || createHash("sha256").update(bytes).digest("hex") !== hash)
            throw new Error(`Packaged badge evaluator ${adapter} differs from its frozen hash`);
    }
}

function runRule(rule, inputs, evidence, workflowId) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), {
            execArgv: [], workerData: { badgeEvaluation: { adapter: rule.adapter, hash: rule.hash,
                ruleId: rule.id, inputs, evidence, workflowId } },
            resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 16 },
        });
        let finished = false;
        const timer = setTimeout(() => finish(new Error("Badge evaluation timed out")), 1500);
        function finish(error, result) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            void worker.terminate();
            if (error) reject(error);
            else resolve(result);
        }
        worker.once("message", ({ error, result }) => finish(error ? new Error(error) : null, result));
        worker.once("error", (error) => finish(error));
        worker.once("exit", (code) => finish(new Error(`Badge evaluator exited (${code})`)));
    });
}

function text(template, values) {
    return template.replace(/\{([A-Za-z][A-Za-z0-9_.-]*)\}/g, (placeholder, name) =>
        Object.hasOwn(values, name) && ["number", "string"].includes(typeof values[name])
            ? String(values[name]).slice(0, 80) : placeholder).slice(0, 160);
}

export async function evaluateBadges(badges, { cwd, workflows, phases, outputPath, runFor,
    log = () => {}, budgetMs = 4000 }) {
    if (!badges?.instances?.length) return { items: {}, selected: [], summary: [], diagnostics: [] };
    const result = { items: {}, selected: [], summary: [], diagnostics: [] };
    const summaryById = new Map();
    for (const instance of badges.instances.filter((badge) => badge.showIn.includes("workflow-summary")
        && badges.types.find((type) => type.id === badge.type)?.enabled)) {
        const type = badges.types.find((entry) => entry.id === instance.type);
        const item = { id: instance.id, title: type.title, count: 0,
            ...(instance.summaryText ? { template: instance.summaryText } : {}),
            color: instance.color ?? type.defaultColor };
        result.summary.push(item);
        summaryById.set(instance.id, item);
    }
    const deadline = performance.now() + (Number.isFinite(budgetMs)
        ? Math.min(4000, Math.max(0, budgetMs)) : 4000);
    let totalReads = 0;
    for (const workflow of workflows) {
        const cache = new Map();
        const artifactReads = new Map();
        const directoryReads = new Map();
        const rendered = [];
        for (const instance of badges.instances) {
            if (performance.now() >= deadline) {
                if (!result.diagnostics.length) {
                    const message = "Badge evaluation time limit reached; some badges were not evaluated. Refresh to retry.";
                    result.diagnostics.push(message);
                    log(message);
                }
                break;
            }
            const type = badges.types.find((entry) => entry.id === instance.type);
            if (!type.enabled) continue;
            const rule = badges.rules.find((entry) => entry.id === type.rule);
            const evidence = { files: {}, directories: {}, runs: {} };
            const getRun = (phaseId) => {
                if (!Object.hasOwn(evidence.runs, phaseId)) {
                    const run = runFor(phases.find((phase) => phase.id === phaseId), workflow);
                    if (run) {
                        const status = ["completed", "complete", "success"].includes(
                            String(run.status).toLowerCase()) ? "completed" : String(run.status).toLowerCase();
                        evidence.runs[phaseId] = {
                            status, ...(run.startedAt ? { startedAt: run.startedAt } : {}),
                            ...(run.completedAt ? { completedAt: run.completedAt } : {}),
                        };
                    } else evidence.runs[phaseId] = null;
                }
                return evidence.runs[phaseId];
            };
            const readArtifact = async (descriptor, metadataOnly = false) => {
                const step = phases.find((phase) => phase.id === descriptor.phase);
                if (!step || (descriptor.output !== undefined && !step.outputs.includes(descriptor.output)))
                    return { state: "unknown", diagnostic: "Badge output is not declared for this phase." };
                if (!metadataOnly) getRun(step.id);
                try {
                    const path = await outputPath(descriptor, workflow);
                    if (!path) return { state: "missing" };
                    if (++totalReads > 128 || performance.now() >= deadline)
                        return { state: "unknown", diagnostic: "Badge artifact read limit reached." };
                    safePath(path);
                    if (metadataOnly) {
                        return { state: "ok", ...await readRegularFileMetadata(cwd, path) };
                    }
                    const target = await confined(cwd, path);
                    const { text, mtimeMs } = await readBoundedWithMetadata(cwd, path, 128 * 1024);
                    return { state: "ok", path: target, text, mtimeMs };
                } catch (error) {
                    if (error.code === "ENOENT" || error.status === 404) return { state: "missing" };
                    log(`Badge artifact ${step.id} could not be read: ${error.message}`);
                    return { state: "unknown", diagnostic: "Artifact could not be read safely." };
                }
            };
            const countDirectory = async (descriptor) => {
                const step = phases.find((phase) => phase.id === descriptor.phase);
                if (!step || !step.outputs.includes(descriptor.output)) {
                    return { state: "unknown", diagnostic: "Badge directory anchor is not declared." };
                }
                try {
                    const path = await outputPath(descriptor, workflow, { directory: true });
                    if (!path) return { state: "unknown", diagnostic: "Badge directory path is unavailable." };
                    if (++totalReads > 128 || performance.now() >= deadline) {
                        return { state: "unknown", diagnostic: "Badge directory read limit reached." };
                    }
                    return { state: "ok", count: await countMarkdownDirectory(cwd, path) };
                } catch (error) {
                    log(`Badge directory ${step.id} could not be counted: ${error.message}`);
                    return { state: "unknown", diagnostic: "Badge directory could not be counted safely." };
                }
            };
            try {
                for (const input of rule.inputs) {
                    const value = instance.inputs[input.id];
                    if (input.type === "phase") getRun(value);
                    else if (input.type === "text") continue;
                    else {
                        const descriptors = input.type === "artifact" ? [value]
                            : input.type === "ordered-artifacts" ? value : value.flatMap(
                            ({ phase, outputs }) => outputs.map((output) => ({ phase, output })));
                        for (const descriptor of descriptors) {
                            const key = JSON.stringify([descriptor.phase, descriptor.output]);
                            if (input.scope === "directory") {
                                if (!directoryReads.has(key)) directoryReads.set(key, countDirectory(descriptor));
                                evidence.directories[key] = await directoryReads.get(key);
                            } else {
                                const readKey = JSON.stringify([key, input.scope === "metadata"]);
                                if (!artifactReads.has(readKey)) {
                                    artifactReads.set(readKey, readArtifact(descriptor,
                                        input.scope === "metadata"));
                                }
                                evidence.files[key] = await artifactReads.get(readKey);
                            }
                        }
                    }
                }
                const key = JSON.stringify([rule.id, instance.inputs, evidence]);
                if (!cache.has(key)) cache.set(key, await runRule(rule, instance.inputs, evidence, workflow));
                const evaluated = cache.get(key);
                const summary = summaryById.get(instance.id);
                if (summary) summary.count += evaluated.summaryCount ?? Number(evaluated.match);
                if (evaluated.match) rendered.push({ id: instance.id, text: text(instance.text ?? type.defaultText,
                    evaluated.values ?? {}),
                    ...(instance.phaseText
                        ? { phaseText: text(instance.phaseText, evaluated.values ?? {}) } : {}),
                    color: instance.color ?? type.defaultColor,
                    showIn: instance.showIn, ...(instance.phase ? { phase: instance.phase } : {}),
                    ...(instance.targets ? { targets: instance.targets } : {}) });
                for (const message of evaluated.diagnostics ?? []) {
                    const warning = `Badge ${instance.id}: ${String(message).slice(0, 300)}`;
                    if (!result.diagnostics.includes(warning)) result.diagnostics.push(warning);
                    log(warning);
                }
            } catch (error) {
                const warning = `Badge ${instance.id} could not be evaluated: ${error.message}`;
                if (!result.diagnostics.includes(warning)) result.diagnostics.push(warning);
                log(warning);
            }
        }
        result.items[workflow] = rendered;
    }
    result.summary = result.summary.map(({ title, template, count, ...item }) =>
        ({ ...item, count, text: template ? text(template, { workflows: count })
            : `${title} (${count})` }));
    return result;
}
