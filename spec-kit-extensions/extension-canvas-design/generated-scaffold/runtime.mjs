import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createContext, runInContext } from "node:vm";
import { UserError, confined, readBounded, readBoundedBytes, directories, atomicJson, safePath, slugPattern,
    deleteConfinedDirectory } from "./files.mjs";
import { phaseContract, valueContract, validateValue } from "./contract.mjs";
import { phaseResponse } from "./phase-response.mjs";
import { createSetup } from "./setup.mjs";
import { freshState, validateWorkflowState, pendingId, newItem } from "./contracts/workflow-state.mjs";
import { createChild, inspectChild, sendChild } from "./contracts/child-session.mjs";
import { evaluateBadges, verifyBadgeModules } from "./badge-runtime.mjs";

function staleRevision(message) {
    const error = new UserError(message, 409);
    error.code = "STALE_REVISION";
    return error;
}

export async function existingOutputFolder(root, path) {
    let candidate = path === "." ? "." : safePath(path);
    while (candidate !== ".") {
        try {
            const folder = await confined(root, candidate);
            if (!(await lstat(folder)).isDirectory()) throw new UserError("The output path is not a folder.");
            return folder;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            candidate = posix.dirname(candidate);
        }
    }
    return realpath(root);
}

const PROVIDER_REFRESH_LIMIT_MS = 3000;
const PROVIDER_EVALUATION_LIMIT_MS = 300;
const PROVIDER_REFRESH_ERROR = "Value provider refresh time limit exceeded. Refresh to retry.";

if (!isMainThread && workerData?.canvasValueProvider) {
    try {
        const { source, workflow } = workerData.canvasValueProvider;
        const body = source.replace(/(^|\n)\s*export\s+(?=(?:async\s+)?function\s+provideValue\b|const\s+provideValue\b)/g, "$1");
        const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
        const serialized = runInContext(
            `"use strict"; const workflow = Object.freeze(JSON.parse(${JSON.stringify(JSON.stringify(workflow))}));\n`
            + "const provide = (() => {\n"
            + `${body}\n`
            + "return provideValue;\n})();\n"
            + "if (typeof provide !== 'function') throw new Error('provideValue must be a function');\n"
            + "const result = provide({ workflow });\n"
            + "if (result && typeof result.then === 'function') throw new Error('Async providers are not supported');\n"
            + "JSON.stringify(result);",
            context, { timeout: PROVIDER_EVALUATION_LIMIT_MS });
        if (typeof serialized !== "string" || serialized.length > 8192) throw new Error("Invalid provider result");
        parentPort.postMessage({ value: JSON.parse(serialized) });
    } catch (error) {
        parentPort.postMessage({ error: error.message });
    }
}

async function evaluateProvider(module, hash, workflow, deadline) {
    if (performance.now() >= deadline) throw new UserError(PROVIDER_REFRESH_ERROR);
    const bytes = await readBoundedBytes(fileURLToPath(new URL(".", import.meta.url)),
        `providers/${module}.mjs`, 32 * 1024);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) {
        throw new UserError(`Packaged provider ${module} changed; restore the generated canvas files.`);
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining < PROVIDER_EVALUATION_LIMIT_MS) throw new UserError(PROVIDER_REFRESH_ERROR);
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), {
            workerData: { canvasValueProvider: { source, workflow } },
            execArgv: [],
            resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 16 },
        });
        let finished = false;
        // The VM bounds execution; do not terminate it at the shared refresh deadline.
        const timer = setTimeout(() => finish(performance.now() >= deadline
            ? new UserError(PROVIDER_REFRESH_ERROR) : new Error("Provider exceeded its execution limit")), 2000);
        async function finish(error, value, stopWorker = true) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (stopWorker) {
                try { await worker.terminate(); }
                catch (cause) {
                    reject(new Error("Value provider worker could not stop.", { cause }));
                    return;
                }
            }
            if (error) reject(error);
            else if (performance.now() >= deadline) reject(new UserError(PROVIDER_REFRESH_ERROR));
            else resolve(value);
        }
        worker.once("message", (result) => finish(result.error ? new Error(result.error) : null,
            result.value, false));
        worker.once("error", (error) => finish(error));
        worker.once("exit", (code) => finish(new Error(`Provider exited before returning a value (${code}).`),
            undefined, false));
    });
}

export async function createRuntime({ config, cwd, workspace, session, notify = () => {}, reportToolName }) {
    if (config.badges?.instances?.length) await verifyBadgeModules(config.badges);
    const phases = phaseContract(config);
    const valueFields = valueContract(config);
    const setup = createSetup({ config, cwd, session, phases, notify,
        approvedSources: () => state.approvedUrlSources ?? [],
        saveApprovedSources: (receipts) => update((next) => {
            next.approvedUrlSources = [...new Set([...(next.approvedUrlSources ?? []), ...receipts])]
                .slice(-80);
        }) });
    const key = createHash("sha256").update(JSON.stringify([cwd, config.canvas.id])).digest("hex");
    const statePath = `generated-canvases/${key}/state.json`;
    let state;
    try {
        state = JSON.parse(await readBounded(workspace, statePath, 2 * 1024 * 1024));
        validateWorkflowState(state, phases, valueFields);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        state = freshState();
    }
    let writes = Promise.resolve();
    let dispatching = false;
    let deleting = false;
    let closed = false;
    const liveRuns = new Set();
    const busy = { value: false };
    const subscriptions = [];
    const observedMessages = new Set();
    const workflowSteps = phases.filter((step) => !step.project);
    let autopilotDispatching = false;
    const diagnostic = async (message) => { await session.log(message, { level: "warn" }); };
    const cleanupDiagnostic = async (message) => {
        try { await diagnostic(message); } catch { /* Cleanup reporting must not mask the original failure. */ }
    };
    async function restoreMode(automation, log = diagnostic) {
        if (!automation?.previousMode || automation.previousMode === "autopilot") return;
        if (await session.rpc.mode.get() !== "autopilot") return;
        const result = await session.rpc.mode.set({ mode: automation.previousMode, expectedMode: "autopilot" });
        if (result.modeApplied === false) await log("Copilot session mode changed; Autopilot did not restore the previous mode.");
    }
    const update = (fn, uiChange = false, announce = true) => {
        const pending = writes.then(async () => {
            const next = structuredClone(state);
            if (await fn(next) === false) return;
            if (uiChange) next.revision++;
            if (Buffer.byteLength(JSON.stringify(next)) > 2 * 1024 * 1024) throw new UserError("Canvas state is full. Preserve its state file before clearing old runs.", 413);
            await atomicJson(workspace, statePath, next);
            state = next;
            if (announce) notify();
        });
        writes = pending.catch(() => {});
        return pending;
    };
    if (state.autopilot && !state.autopilot.managed
        && ["Request sent", "Running", "Finishing"].includes(state.autopilot.status)) {
        await update((next) => {
            next.autopilot.status = "Blocked";
            next.autopilot.error = "Autopilot was interrupted. Check chat and outputs before resuming.";
            for (const run of next.runs.filter((run) => run.autopilotId === next.autopilot.id
                && run.status === "Running")) {
                run.status = "Unconfirmed";
                run.error = "This step was interrupted before verification. Check its output before retrying.";
            }
        }, false, false);
    }
    const phaseFor = (id) => {
        const step = phases.find((phase) => phase.id === id);
        if (!step) throw new UserError("Select a configured phase.");
        return step;
    };
    function validSlug(value) {
        if (typeof value !== "string" || !value || value.length > 100 || !slugPattern.test(value)) return false;
        try { safePath(value); return true; } catch (error) {
            if (error instanceof UserError) return false;
            throw error;
        }
    }
    async function hasConstitution() {
        const step = phases.find((phase) => phase.project);
        if (!step) return true;
        const output = await outputPath(step, "project");
        if (!output) return false;
        try {
            if (!(await lstat(await confined(cwd, output))).isFile()) {
                throw new UserError("The constitution is not a regular file.");
            }
            return true;
        } catch (error) {
            if (error.code === "ENOENT") return false;
            throw error;
        }
    }
    async function requireConstitution() {
        if (!(await hasConstitution())) {
            throw new UserError("Create a constitution before starting a workflow.");
        }
    }
    const roots = [...new Set(["specs", ...phases.flatMap((step) => step.configuredArtifacts
        ? [config.phaseOutputs?.[step.id]?.outputPath].filter(Boolean) : step.outputs)
        .filter((path) => path.includes("<slug>")).map((path) => path.split("/<slug>")[0])])];
    const childFor = (item, view = state) => view.children?.find((child) => child.item === item);
    const rootFor = (step, item, view = state) => step.project
        && runFor(step, item, view)?.status === "Completed" ? cwd
        : runFor(step, item, view)?.childPath ?? childFor(item, view)?.path ?? cwd;
    async function verifiedChild(child) {
        const observed = await inspectChild({ session, id: child.id,
            projectId: child.projectId, parentPath: cwd });
        if (observed.path !== child.path
            || resolve(await realpath(child.path)).toLowerCase() !== resolve(child.path).toLowerCase()) {
            throw new UserError("Workflow child checkout changed; artifact access was refused.", 409);
        }
        return observed.path;
    }
    async function verifiedRoot(step, item, view = state) {
        const path = rootFor(step, item, view);
        if (path === cwd) return cwd;
        const run = runFor(step, item, view);
        const owner = run?.childId
            ? view.children?.find((child) => child.id === run.childId)
            : childFor(item, view);
        if (!owner || owner.path !== path) throw new UserError("Workflow child ownership is invalid.", 409);
        return verifiedChild(owner);
    }
    async function items(view = state) {
        const found = [];
        for (const root of roots) {
            if (root.includes("<") || root.startsWith(".git")) continue;
            for (const slug of await directories(cwd, root)) {
                const id = `${root}/${slug}`;
                found.push({ id, slug, label: view.names?.[id] || slug });
            }
        }
        for (const child of view.children ?? []) {
            if (child.item === "project" || child.item.startsWith("project:")
                || newItem(child.item) || found.some((entry) => entry.id === child.item)) continue;
            const slug = child.item.split("/").at(-1);
            const root = child.item.slice(0, -(slug.length + 1));
            if (!roots.includes(root)) continue;
            if ((await directories(await verifiedChild(child), root)).includes(slug)) {
                found.push({ id: child.item, slug, label: view.names?.[child.item] || slug });
            }
        }
        return found;
    }
    const pendingFor = (id, view = state) => view.pendingWorkflows?.find((entry) => entry.id === id);
    function runFor(step, item, view = state) {
        return view.runs.findLast((run) => run.phase === step.id && run.item === (step.project ? "project" : item));
    }
    function authorizeReport(step, path, item) {
        safePath(path);
        if (!path.endsWith(".md")) throw new UserError("Reported artifact must be Markdown.");
        if (step.configuredArtifacts && step.outputs.some((output) =>
            output.replace("<slug>", item.split("/").at(-1)) === path)) {
            return;
        }
        if (step.project || (step.output && !step.output.includes("<"))) {
            if (path !== step.output) throw new UserError("Constitution report does not match its declared output.");
        } else {
            if (!roots.some((root) => item.startsWith(`${root}/`)) || !path.startsWith(`${item}/`)) throw new UserError("Reported artifact is outside this workflow.");
            if (step.output) {
                const expected = step.output.replace("<slug>", item.split("/").at(-1));
                if (expected.endsWith("<name>.md")) {
                    if (posix.dirname(path) !== posix.dirname(expected)) throw new UserError("Reported artifact differs from the declared phase output.");
                } else if (path !== expected && phases.some((other) => other.id !== step.id
                    && other.outputs.some((output) => output.replace("<slug>", item.split("/").at(-1)) === path))) {
                    throw new UserError("Reported artifact belongs to another declared phase output.");
                }
            }
        }
    }
    async function outputPath(step, item, view = state, entries, directory = false) {
        const run = runFor(step, item, view);
        if (!step.configuredArtifacts && run?.artifact) {
            authorizeReport(step, run.artifact, run.item);
            return directory ? posix.dirname(run.artifact) : run.artifact;
        }
        if (!step.output) return null;
        let path = step.output;
        if (path.includes("<slug>")) {
            const selected = (entries ?? await items(view)).find((entry) => entry.id === item);
            const draftSlug = item === "__new__" ? view.slug : pendingFor(item, view)?.slug;
            const slug = validSlug(selected?.slug) ? selected.slug
                : selected ? null : validSlug(draftSlug) ? draftSlug : null;
            if (!slug) return null;
            path = path.replace("<slug>", slug);
            if (selected && !newItem(item) && !step.configuredArtifacts && !path.startsWith(`${selected.id}/`)) {
                throw new UserError("This phase output belongs to a different workflow.");
            }
        }
        if (directory) return posix.dirname(safePath(path, true));
        if (path.endsWith("<name>.md")) {
            const parent = posix.dirname(path);
            try {
                const root = await verifiedRoot(step, item, view);
                const entries = await readdir(await confined(root, parent), { withFileTypes: true });
                const candidates = [];
                for (const entry of entries) {
                    if (!entry.isFile() || !/^[a-z0-9][a-z0-9._-]*\.md$/i.test(entry.name)) continue;
                    const path = `${parent}/${entry.name}`;
                    candidates.push({ path, mtime: (await lstat(await confined(root, path))).mtimeMs });
                }
                candidates.sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path));
                if (!candidates.length) throw new UserError("No artifact is available yet. Run the phase, then refresh.", 404);
                path = candidates[0].path;
            } catch (error) { if (error.code === "ENOENT") return null; throw error; }
        }
        return safePath(path);
    }
    async function artifact(input) {
        const step = phaseFor(input.phase);
        if (input.output !== undefined && !step.outputs.includes(input.output)) {
            throw new UserError("This output is not declared for the selected phase.", 403);
        }
        const path = input.output === undefined
            ? await outputPath(step, input.itemId)
            : await outputPath({ ...step, output: input.output, configuredArtifacts: true },
                input.itemId);
        if (!path) throw new UserError(step.output
            ? "No artifact is available yet. Run the phase or select an existing workflow to view its artifact."
            : "No artifact is available for this phase yet. Run the phase, then refresh to check again.", 404);
        try {
            const content = await readBounded(await verifiedRoot(step, input.itemId), path);
            return { path, content, message: content.trim() ? null : "Artifact is empty or still being written. Refresh to try again." };
        } catch (error) {
            if (error.code === "ENOENT") throw new UserError("Could not load the artifact. It may not have been created yet. Run the phase or check its output path.", 404);
            throw error;
        }
    }
    async function snapshot() {
        const view = structuredClone(state);
        const entries = await items(view);
        const item = view.selected;
        const selectedWorkflow = newItem(item) ? null : entries.find((entry) => entry.id === item);
        const visibleValues = [], pageValues = Object.create(null), valueErrors = {};
        const providerDeadline = performance.now() + PROVIDER_REFRESH_LIMIT_MS;
        let reportedDeadline = false;
        for (const field of valueFields) {
            if (field.source.kind === "computed" && !selectedWorkflow) continue;
            let value;
            try {
                if (field.source.kind === "computed") {
                    value = await evaluateProvider(field.source.module, field.source.hash, {
                        id: selectedWorkflow.id, slug: selectedWorkflow.slug,
                        label: selectedWorkflow.label,
                    }, providerDeadline);
                } else if (field.presentation === "stock.editable") {
                    value = Object.hasOwn(view.values ?? {}, field.id) ? view.values[field.id] : field.source.value;
                } else value = field.source.value;
                value = validateValue(field.schema, value, field.id);
            } catch (error) {
                const contractError = field.source.kind === "computed"
                    && (error.message === "provideValue must be a function"
                        || error.message === "Async providers are not supported");
                valueErrors[field.id] = error instanceof UserError || contractError
                    ? error.message : `Value ${field.label} could not be evaluated or failed validation.`;
                if (error.message !== PROVIDER_REFRESH_ERROR || !reportedDeadline) {
                    await diagnostic(`Generated canvas value ${field.id} failed: ${error.message}`);
                }
                if (error.message === PROVIDER_REFRESH_ERROR) reportedDeadline = true;
                continue;
            }
            const entry = { id: field.id, label: field.label, schema: field.schema, value,
                editable: field.presentation === "stock.editable",
                ...(field.provenance ? { provenance: field.provenance } : {}),
                ...(field.section ? { section: field.section } : {}) };
            if (field.presentation !== "processing-only") visibleValues.push(entry);
            for (const page of config.generatedPages ?? []) {
                if (page.values?.includes(field.id)) (pageValues[page.id] ??= {})[field.id] = value;
            }
        }
        const statuses = {};
        for (const step of phases) {
            const run = runFor(step, item, view);
            let output = null, artifactError = null, artifactAvailability = "unknown";
            try {
                output = await outputPath(step, item, view, entries);
                if (output) {
                    const info = await lstat(await confined(await verifiedRoot(step, item, view), output));
                    if (!info.isFile()) throw new UserError("The artifact path is not a regular file.");
                    artifactAvailability = "available";
                }
            }
            catch (error) {
                artifactAvailability = error.code === "ENOENT" || error.status === 404 ? "missing" : "error";
                if (artifactAvailability === "error") {
                    artifactError = error instanceof UserError ? error.message : "Could not check the artifact safely. Refresh to retry.";
                    await diagnostic(`Generated canvas artifact availability failed: ${artifactError}`);
                }
            }
            const status = run && !run.managed && !liveRuns.has(run.runId) && !["Completed", "Failed"].includes(run.status)
                ? "Unconfirmed" : run?.status ?? "Not run";
            statuses[step.id] = { status, output, artifactAvailability, artifactError,
                error: run?.error ?? null };
        }
        const selectedAutomation = view.autopilots?.findLast((entry) => entry.item === item)
            ?? (!view.autopilots?.length && !view.autopilot?.managed ? view.autopilot : null);
        const automation = selectedAutomation
            ? { ...selectedAutomation, message: selectedAutomation.error
                ?? `${selectedAutomation.status}: step ${Math.min(selectedAutomation.current + 1, workflowSteps.length)} of ${workflowSteps.length}` }
            : null;
        if (automation && !automation.managed && ["Request sent", "Running", "Finishing"].includes(automation.status)
            && (automation.sessionId !== session.sessionId || !liveRuns.has(automation.id))) {
            automation.status = "Blocked";
            automation.message = "Autopilot outcome is unconfirmed. Check chat before resuming.";
        }
        let badges;
        if (config.badges?.instances?.length) {
            const projectPhase = phases.find((phase) => phase.project)?.id;
            const projectInput = (value) => value && typeof value === "object"
                && (value.phase === projectPhase || Object.values(value).some(projectInput));
            const childBadgesUnsupported = projectPhase
                && (view.children ?? []).some((child) => !child.item.startsWith("project:"))
                && config.badges.instances.some((instance) => projectInput(instance.inputs));
            if (childBadgesUnsupported) {
                badges = { items: {}, selected: [], summary: [],
                    diagnostics: ["Badges using parent-scoped evidence cannot be verified in isolated workflow children."] };
            } else {
                const started = performance.now();
                badges = { items: {}, selected: [], summary: [], diagnostics: [] };
                for (const entry of entries.length ? entries : [{ id: null }]) {
                    const owner = entry.id && childFor(entry.id, view);
                    const badgeRoot = owner ? await verifiedChild(owner) : cwd;
                    const evaluated = await evaluateBadges(config.badges, {
                        cwd: badgeRoot, workflows: entry.id ? [entry.id] : [], phases,
                        budgetMs: Math.max(0, 4000 - (performance.now() - started)),
                        outputPath: async ({ phase, output }, workflow, options = {}) => {
                            const step = phaseFor(phase);
                            return outputPath(output === undefined ? step : {
                                ...step, output, configuredArtifacts: true,
                            }, step.project ? "project" : workflow, view, entries, options.directory === true);
                        },
                        runFor: (step, workflow) => runFor(step, workflow, view),
                        log: (message) => { void diagnostic(message); },
                    });
                    Object.assign(badges.items, evaluated.items);
                    for (const result of evaluated.summary) {
                        const aggregate = badges.summary.find((item) => item.id === result.id);
                        if (aggregate) aggregate.count += result.count;
                        else badges.summary.push({ ...result });
                    }
                    badges.diagnostics.push(...evaluated.diagnostics);
                }
                for (const result of badges.summary) {
                    const instance = config.badges.instances.find((entry) => entry.id === result.id);
                    const template = instance?.summaryText;
                    const title = config.badges.types.find((type) => type.id === instance?.type)?.title;
                    result.text = template
                        ? template.replace(/\{workflows\}/g, String(result.count)).slice(0, 160)
                        : `${title} (${result.count})`;
                }
            }
        }
        if (badges) badges.selected = badges.items[item] ?? [];
        const project = phases.find((phase) => phase.project);
        const pending = (view.pendingWorkflows ?? []).map(({ id, name, slug }) => {
            const run = view.runs.findLast((entry) => entry.item === id);
            return { id, slug, label: name.trim() || slug || "Unstarted workflow", pending: true,
                status: run && !run.managed && !liveRuns.has(run.runId) && !["Completed", "Failed"].includes(run.status)
                    ? "Unconfirmed" : run?.status ?? "Not started" };
        });
        const legacyDraft = (view.name || view.slug
            || Object.keys(view.drafts).some((key) => key.startsWith('["__new__",')))
            ? [{ id: "__new__", slug: view.slug,
                label: view.name?.trim() || view.slug || "Unstarted workflow", pending: true }] : [];
        return { ...view, userProvidesSlug: true,
            constitutionReady: !project || statuses[project.id].artifactAvailability === "available",
            autopilot: automation, showSetup: config.showSetup === true,
            selected: item, runs: undefined, tagMatches: undefined, values: undefined,
            name: pendingFor(item, view)?.name ?? view.name,
            slug: pendingFor(item, view)?.slug ?? view.slug,
            phases, items: [...entries, ...legacyDraft, ...pending],
            statuses, valueFields: visibleValues, pageValues, valueErrors,
            ...(badges ? { badges } : {}),
            setup: config.runtimeSetup !== undefined || config.showSetup ? await setup.status()
                : { stage: "legacy", ready: true, pending: [], planId: null, error: null } };
    }
    async function saveValue(input) {
        if (!input || Object.keys(input).sort().join() !== "id,revision,value"
            || typeof input.id !== "string" || !Number.isSafeInteger(input.revision)) {
            throw new UserError("Invalid value update.");
        }
        const field = valueFields.find((entry) => entry.id === input.id && entry.presentation === "stock.editable");
        if (!field) throw new UserError("This value is not editable.");
        const value = validateValue(field.schema, input.value, field.id);
        await update((next) => {
            if (input.revision !== next.revision) throw staleRevision("Canvas state changed in another panel. Refresh before saving.");
            (next.values ??= {})[field.id] = value;
        }, true);
        return { revision: state.revision };
    }
    async function save(input) {
        if (deleting) throw new UserError("A workflow is being deleted. Refresh and try again.", 409);
        if (!input || Object.keys(input).some((key) => !["revision", "selected", "phase", "slug", "name", "draft"].includes(key))) throw new UserError("Invalid canvas state update.");
        if (input.selected !== undefined && input.selected !== "__new__"
            && !pendingFor(input.selected) && !(await items()).some((item) => item.id === input.selected)) {
            throw new UserError("That workflow is no longer available. Refresh the workflow list.");
        }
        if (input.phase !== undefined) phaseFor(input.phase);
        if (input.slug !== undefined && (typeof input.slug !== "string" || input.slug.length > 100)) throw new UserError("Artifact folder name (slug) is too long.");
        if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 120
            || /[\x00-\x1f\x7f]/.test(input.name))) throw new UserError("Workflow name must be text of at most 120 characters.");
        if (input.name !== undefined && !newItem(input.selected ?? state.selected)) {
            throw new UserError("Only a new workflow can be given a display name.");
        }
        if (input.slug !== undefined && !newItem(input.selected ?? state.selected)) {
            throw new UserError("Only a new workflow can change its artifact folder name.");
        }
        if (input.draft && (typeof input.draft.value !== "string" || input.draft.value.length > 32000
            || typeof input.draft.item !== "string"
            || (!newItem(input.draft.item) && input.draft.item !== "project"
                && !(await items()).some((item) => item.id === input.draft.item))
            || (pendingId(input.draft.item) && !pendingFor(input.draft.item)))) throw new UserError("Invalid phase draft.");
        if (input.draft) phaseFor(input.draft.phase);
        await update((next) => {
            if (input.revision !== next.revision) throw staleRevision("Canvas state changed in another panel. Refresh before saving.");
            for (const key of ["selected", "phase"]) if (input[key] !== undefined) next[key] = input[key];
            for (const key of ["slug", "name"]) {
                if (input[key] === undefined) continue;
                const pending = pendingFor(next.selected, next);
                if (pending) pending[key] = input[key];
                else next[key] = input[key];
            }
            if (input.draft) next.drafts[JSON.stringify([input.draft.item, input.draft.phase])] = input.draft.value;
        }, true);
        return { revision: state.revision };
    }
    async function createPending(input) {
        if (!input || Object.keys(input).sort().join() !== "revision"
            || !Number.isSafeInteger(input.revision)) throw new UserError("Invalid new workflow request.");
        const existing = await items();
        let id;
        await update((next) => {
            if (input.revision !== next.revision) throw staleRevision("Canvas state changed in another panel. Refresh before creating a workflow.");
            const drafts = next.pendingWorkflows ??= [];
            if (drafts.length >= 100) throw new UserError("Too many unstarted workflows. Remove one before adding another.");
            let number = next.workflowSerial ?? 0;
            let slug;
            do {
                if (number >= Number.MAX_SAFE_INTEGER) throw new UserError("Workflow numbering has reached its limit.");
                number++;
                slug = `workflow-${number}`;
            } while (existing.some((entry) => entry.slug === slug || new RegExp(`^\\d+-${slug}$`).test(entry.slug))
                || drafts.some((entry) => entry.slug === slug));
            next.workflowSerial = number;
            id = `__new__:${number}`;
            drafts.push({ id, name: `Workflow ${number}`, slug });
            next.selected = id;
            next.phase = workflowSteps[0]?.id ?? next.phase;
        }, true);
        return { revision: state.revision, id };
    }
    async function removePending(input) {
        if (!input || Object.keys(input).sort().join() !== "itemId,revision"
            || !pendingId(input.itemId) || !Number.isSafeInteger(input.revision)) {
            throw new UserError("Invalid unstarted workflow removal.");
        }
        const existing = await items();
        await update((next) => {
            if (input.revision !== next.revision) throw staleRevision("Canvas state changed in another panel. Refresh before removing this workflow.");
            const index = (next.pendingWorkflows ?? []).findIndex((entry) => entry.id === input.itemId);
            if (index < 0) throw new UserError("This unstarted workflow no longer exists.");
            if (next.runs.some((run) => run.item === input.itemId && run.status !== "Failed")) {
                throw new UserError("This row cannot be removed: a run may have created a workflow directory without reporting it, even if completed. Check chat and artifacts.");
            }
            if (next.runs.some((run) => run.item === input.itemId && run.status === "Failed"
                && existing.some((entry) => !run.before.includes(entry.id)
                    && (entry.slug === run.slug || new RegExp(`^\\d+-${run.slug}$`).test(entry.slug))))) {
                throw new UserError("A workflow directory may have been created by the failed run. Check its artifacts before removing this row.");
            }
            if (next.autopilot?.item === input.itemId
                && (["Request sent", "Running", "Finishing"].includes(next.autopilot.status)
                    || (next.autopilot.status === "Blocked" && liveRuns.has(next.autopilot.id)))) {
                throw new UserError("Stop Autopilot before removing this workflow.");
            }
            next.pendingWorkflows.splice(index, 1);
            next.runs = next.runs.filter((run) => run.item !== input.itemId);
            for (const key of Object.keys(next.drafts)) {
                if (key.startsWith(`[${JSON.stringify(input.itemId)},`)) delete next.drafts[key];
            }
            if (next.selected === input.itemId) next.selected =
                next.pendingWorkflows.at(-1)?.id ?? existing[0]?.id ?? "__new__";
        }, true);
        return { revision: state.revision };
    }
    async function skill(step) {
        let source;
        try { source = await readBounded(cwd, `.github/skills/${step.skill}/SKILL.md`); }
        catch (error) {
            if (error.code === "ENOENT") throw new UserError(`Installed skill ${step.skill} is unavailable. Check this checkout's Spec Kit setup; nothing was sent.`);
            throw error;
        }
        const name = source.match(/^name:\s*["']?([a-z0-9-]+)["']?\s*$/m)?.[1];
        if (name !== step.skill) throw new UserError(`Installed skill name does not match ${step.skill}. Nothing was sent.`);
        if (!session.rpc?.skills?.reload) throw new UserError("Session skill reload is unavailable. Reload skills in Copilot before retrying.");
        const result = await session.rpc.skills.reload();
        if (result?.errors?.length) throw new UserError("Session skills could not reload. Check Copilot's skill diagnostics and retry.");
    }
    async function enabledAutopilot() {
        if (!config.workflowPage.managedRun) {
            throw new UserError("This phase control does not provide Autopilot.");
        }
        const module = config.workflowPage.adapter;
        const bytes = await readBoundedBytes(fileURLToPath(new URL(".", import.meta.url)),
            `pages/${module}.mjs`, 128 * 1024);
        if (createHash("sha256").update(bytes).digest("hex") !== config.workflowPage.hash) {
            throw new UserError("Packaged phase control changed; restore the generated canvas files.");
        }
    }
    async function parentProject() {
        const execute = session.rpc?.tools?.execute;
        if (typeof execute !== "function") throw new UserError("App-native child sessions are unavailable; nothing was sent.");
        const response = await execute.call(session.rpc.tools, {
            name: "get_session", arguments: { project_session_id: session.sessionId },
        });
        let details;
        try { details = JSON.parse(response?.textResultForLlm); } catch {
            throw new UserError("Could not verify the parent project session; nothing was sent.");
        }
        if (response?.resultType !== "success" || typeof details?.project_id !== "string"
            || !details.project_id || typeof details.path !== "string"
            || resolve(details.path).toLowerCase() !== resolve(cwd).toLowerCase()) {
            throw new UserError("The parent project or checkout does not match this canvas; nothing was sent.");
        }
        return { projectId: details.project_id, branch: details.branch };
    }
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    async function digestAt(root, path) {
        try { return digest(await readBoundedBytes(root, path)); }
        catch (error) { if (error.code === "ENOENT") return null; throw error; }
    }
    async function collectTree(source, optional = false) {
        let origin;
        try { origin = await confined(cwd, source); }
        catch (error) { if (optional && error.code === "ENOENT") return []; throw error; }
        const root = await realpath(cwd);
        let count = 0, total = 0;
        const files = [];
        async function visit(path, depth) {
            if (depth > 16 || ++count > 2000) throw new UserError("Project setup exceeds child provisioning limits.");
            const sourcePath = await confined(root, path);
            const info = await lstat(sourcePath);
            if (info.isDirectory()) {
                for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
                    if (entry.isSymbolicLink()) throw new UserError("Project setup contains a link; child provisioning stopped.");
                    await visit(`${path}/${entry.name}`, depth + 1);
                }
            } else if (info.isFile()) {
                total += info.size;
                if (total > 32 * 1024 * 1024) throw new UserError("Project setup exceeds child provisioning limits.");
                const bytes = await readBoundedBytes(root, path, 512 * 1024);
                files.push({ path, bytes, hash: digest(bytes) });
            } else throw new UserError("Project setup contains unsupported files.");
        }
        if (!(await lstat(origin)).isDirectory() && !(await lstat(origin)).isFile()) {
            throw new UserError("Project setup contains unsupported files.");
        }
        await visit(source, 0);
        return files;
    }
    async function applyFiles(destination, files, pins) {
        const manifest = Object.fromEntries(files.map(({ path, hash }) => [path, hash]));
        if (pins && JSON.stringify(Object.entries(pins).sort()) !== JSON.stringify(Object.entries(manifest).sort())) {
            throw new UserError("Parent setup changed since this child was created. Review it before another run.", 409);
        }
        for (const { path, hash } of files) {
            const present = await digestAt(destination, path);
            if (present !== null && present !== hash) {
                throw new UserError(`Child file ${path} differs from the pinned setup; refusing to overwrite it.`, 409);
            }
            if (pins && present === null) {
                throw new UserError(`Pinned child file ${path} is missing; refusing an incomplete setup.`, 409);
            }
        }
        for (const { path, bytes, hash } of files) {
            if (await digestAt(destination, path) !== null) continue;
            await confined(destination, posix.dirname(path), { createDirectories: true });
            const target = resolve(destination, ...path.split("/"));
            const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
            try { await handle.writeFile(bytes); }
            finally { await handle.close(); }
            if (await digestAt(destination, path) !== hash) {
                throw new UserError(`Child file ${path} changed during setup.`, 409);
            }
        }
        for (const { path, hash } of files) {
            if (await digestAt(destination, path) !== hash) {
                throw new UserError(`Child file ${path} changed during setup.`, 409);
            }
        }
        return manifest;
    }
    async function checkedAtomicFile(root, path, bytes, expected) {
        const parent = posix.dirname(path);
        await confined(root, parent, { createDirectories: true });
        const target = resolve(root, ...path.split("/"));
        const temporary = `${target}.${randomUUID()}.pending`;
        const lockPath = `${target}.publish.lock`;
        let handle, lock;
        try {
            try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
            catch (error) {
                if (error.code === "EEXIST") throw new UserError("Constitution publication is already in progress.", 409);
                throw error;
            }
            if (await digestAt(root, path) !== expected) {
                throw new UserError("Constitution changed since this run began; the parent was not modified.", 409);
            }
            await confined(root, parent);
            handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
            await handle.writeFile(bytes);
            await handle.sync();
            await handle.close();
            handle = null;
            if (await digestAt(root, path) !== expected) {
                throw new UserError("Constitution changed during publication; the parent was not modified.", 409);
            }
            await confined(root, parent);
            await rename(temporary, target);
        } finally {
            if (handle) await handle.close();
            await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
            if (lock) {
                await lock.close();
                await unlink(lockPath);
            }
        }
    }
    async function provision(child, steps, existing, recovering = false) {
        let initialized;
        try { initialized = (await lstat(await confined(cwd, ".specify"))).isDirectory(); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!initialized) throw new UserError("Project Spec Kit setup is missing; nothing was sent.");
        await confined(child.path, ".specify", { createDirectories: true });
        const files = [];
        for (const step of phases) {
            files.push(...await collectTree(`.github/skills/${step.skill}`));
        }
        for (const folder of [".specify/scripts", ".specify/templates", ".specify/extensions",
            ".specify/presets", ".specify/init-options.json"]) files.push(...await collectTree(folder, true));
        if (existing && !existing.setupPins) {
            throw new UserError("This child has no pinned setup; inspect it before retrying.", 409);
        }
        const pins = await applyFiles(child.path, files, existing?.setupPins);
        for (const { path, hash } of files) {
            if (await digestAt(cwd, path) !== hash) {
                throw new UserError(`Parent setup file ${path} changed during child provisioning.`, 409);
            }
        }
        for (const step of steps) {
            const text = await readBounded(child.path, `.github/skills/${step.skill}/SKILL.md`, 64 * 1024);
            if (text.match(/^name:\s*["']?([a-z0-9-]+)["']?\s*$/m)?.[1] !== step.skill) {
                throw new UserError(`Child skill ${step.skill} is not ready; nothing was sent.`);
            }
        }
        const constitution = ".specify/memory/constitution.md";
        const canonical = await digestAt(cwd, constitution);
        const pinned = existing?.constitutionDigest ?? null;
        const childDigest = await digestAt(child.path, constitution);
        if (existing && childDigest !== pinned && childDigest !== canonical) {
            throw new UserError("Child constitution was changed; refusing to overwrite it.", 409);
        }
        if (canonical !== null && childDigest !== canonical) {
            if (existing && !recovering && state.runs.some((run) => run.childId === child.id
                && ["Request sent", "Running", "Unconfirmed"].includes(run.status))) {
                throw new UserError("Cannot synchronize the constitution while the child run is active.", 409);
            }
            await checkedAtomicFile(child.path, constitution,
                await readBoundedBytes(cwd, constitution), childDigest);
        } else if (canonical === null && !steps.some((step) => step.project)) {
            throw new UserError("Project constitution is unavailable; nothing was sent.", 409);
        } else if (canonical === null && childDigest !== null) {
            throw new UserError("Child constitution differs from the missing parent constitution.", 409);
        }
        return { setupPins: pins, constitutionDigest: canonical };
    }
    async function artifactBaseline(childPath) {
        const hashes = {};
        let seen = 0;
        for (const root of [...new Set([...roots, ".specify/memory"])]) {
            async function walk(path, depth) {
                if (depth > 16 || ++seen > 2500) throw new UserError("Child artifacts exceed baseline limits.");
                let directory;
                try { directory = await confined(childPath, path); }
                catch (error) { if (error.code === "ENOENT") return; throw error; }
                for (const entry of await readdir(directory, { withFileTypes: true })) {
                    const next = `${path}/${entry.name}`;
                    safePath(next);
                    if (entry.isSymbolicLink()) throw new UserError("Child artifact directory contains a link.", 409);
                    if (entry.isDirectory()) await walk(next, depth + 1);
                    else if (entry.isFile() && next.endsWith(".md")) {
                        hashes[next] = await digestAt(childPath, next);
                    }
                }
            }
            await walk(root, 0);
        }
        return hashes;
    }
    async function staleChildIsIdle(conflicts, existing) {
        if (!existing || conflicts.some((run) => !Number.isFinite(Date.parse(run.startedAt))
            || Date.now() - Date.parse(run.startedAt) < 5 * 60 * 1000)) return false;
        const inspected = await verifiedChild(existing);
        const response = await session.rpc.tools.execute({
            name: "get_session", arguments: { project_session_id: existing.id },
        });
        let metadata;
        try { metadata = JSON.parse(response?.textResultForLlm); }
        catch { return false; }
        if (response?.resultType !== "success"
            || metadata?.project_id !== existing.projectId || metadata?.path !== inspected) return false;
        const direct = metadata?.activity_status ?? metadata?.activity?.status ?? metadata?.status;
        if (direct === "idle") return true;
        if (direct === "busy") return false;
        let snapshot;
        try {
            snapshot = await session.rpc.tools.execute({
                name: "get_sessions_status", arguments: {},
            });
        } catch { return false; }
        let details;
        try {
            if (snapshot?.resultType !== "success" || snapshot.textResultForLlm.length > 512 * 1024) return false;
            details = JSON.parse(snapshot.textResultForLlm);
        } catch { return false; }
        const sessions = Array.isArray(details) ? details : details?.sessions;
        const item = Array.isArray(sessions) ? sessions.find((entry) =>
            [existing.id, metadata.id, metadata.active_session_id].includes(entry?.id)) : null;
        return (item?.activity_status ?? item?.activity?.status ?? item?.status) === "idle";
    }
    function childInstructions(runs, item, instanceId, name, slug) {
        const steps = runs.map((run) => ({
            phase: run.phase, skill: phaseFor(run.phase).skill, runId: run.runId,
            token: run.token, args: run.args, output: phaseFor(run.phase).output,
        }));
        const tool = reportToolName ?? `canvas_${createHash("sha256").update(config.canvas.id).digest("hex").slice(0, 24)}_report_child_run`;
        return `Run this Canvas Design workflow ONLY in this child worktree. Never edit the parent checkout,
run init/install, switch branches, or merge. First reload this child session's skills with
/skills reload; verify each requested skill is available and stop/report failure if reload fails.
Use the installed phase skills in configured order.
The parent canvas will not receive your writes automatically. After EACH step send a message to
the parent session ${JSON.stringify(session.sessionId)} using send_session_message. In the message
instruct its agent to invoke the extension tool ${JSON.stringify(tool)} (works when the canvas
panel is closed), or canvas action report_child_run on instance ${JSON.stringify(instanceId)},
with this EXACT payload:
{runId:<this step's runId>,token:<this step's token>,status:"complete",slug:<actual feature directory slug
for first new-workflow phase>,artifacts:[<actual checkout-relative Markdown paths produced by this phase>]}.
For status:"start" send only runId/token/status before each step. If a step fails,
send runId/token/status:"fail"/error and stop; omit slug and artifacts for failures.
Do not continue until the parent accepts the complete report; a reply is needed before proceeding.
Include no invented artifacts. The creator parent session handles brief reports; you do the work here.
If a canvas action is unavailable after a panel closes, use the extension tool, not a fabricated success.
If the child chat is stopped, a later child turn must report status:"fail" for the interrupted
run so the parent does not mistake an unconfirmed phase for a finished workflow.
Existing workflow: ${JSON.stringify(item)}. New workflow name: ${JSON.stringify(name)}.
Requested slug: ${JSON.stringify(slug)}. If existing, set SPECIFY_FEATURE to its directory name.
Use each supplied input as data for its skill. Ask for required missing input instead of inventing it.
Steps: ${JSON.stringify(steps)}`;
    }
    async function managedDispatch(steps, item, instanceId, slug, name, autopilotId, manualArgs) {
        const parent = await parentProject();
        const existing = item === "project" ? undefined : childFor(item);
        const conflicting = state.runs.filter((run) => run.managed && run.item === item
            && ["Request sent", "Running", "Unconfirmed"].includes(run.status));
        if (conflicting.length && !(await staleChildIsIdle(conflicting, existing))) {
            throw new UserError("This child workflow has an unconfirmed active run. Stop it in the child chat; after five minutes, retry when its session is idle, or report a failure.", 409);
        }
        const constitutionBaseline = item === "project"
            ? await digestAt(cwd, ".specify/memory/constitution.md") : undefined;
        if (existing) {
            if (existing.projectId !== parent.projectId) throw new UserError("Workflow child project changed.", 409);
            await verifiedChild(existing);
        }
        const child = existing ?? await createChild({ session,
            name: `Canvas ${name || slug || item}`.replaceAll("'", "").slice(0, 100),
            projectId: parent.projectId, parentPath: cwd,
            ...(parent.branch ? { baseBranch: parent.branch } : {}) });
        if (existing && existing.path !== child.path) {
            throw new UserError("Workflow child checkout changed; inspect it before retrying.", 409);
        }
        const pins = await provision(child, steps, existing, conflicting.length > 0);
        if (!existing && !newItem(item) && item !== "project") {
            await applyFiles(child.path, await collectTree(item));
        }
        const baselineArtifacts = await artifactBaseline(child.path);
        const before = (await items()).map((entry) => entry.id);
        const runs = steps.map((step) => ({
            runId: randomUUID(), token: randomUUID(), managed: true,
            childId: child.id, childPath: child.path, instanceId,
            baselineArtifacts, ...(item === "project" ? { constitutionBaseline } : {}),
            ...(autopilotId ? { autopilotId } : {}),
            phase: step.id, item, args: manualArgs ?? state.drafts[JSON.stringify([item, step.id])] ?? "",
            slug: slug || null, name, before, sessionId: session.sessionId,
            startedAt: new Date().toISOString(), messageId: null,
            status: "Request sent", artifact: null, artifacts: [], error: null,
        }));
        const prompt = childInstructions(runs, item, instanceId, name, slug);
        if (Buffer.byteLength(prompt) > 128 * 1024) throw new UserError("Workflow inputs are too large.");
        await update((next) => {
            if (conflicting.length) {
                for (const active of next.autopilots ?? []) {
                    if (active.item !== item || !["Request sent", "Running"].includes(active.status)) continue;
                    active.status = "Blocked";
                    active.error = "Previous child run timed out while idle; inspect its chat.";
                    if (next.autopilot?.id === active.id) Object.assign(next.autopilot, active);
                }
                for (const prior of next.runs.filter((run) => conflicting.some((entry) => entry.runId === run.runId))) {
                    prior.status = "Failed";
                    prior.error = "Child was verified idle after the report timeout. Its unreported outcome was not accepted.";
                }
                for (const pending of next.runs.filter((run) => run.item === item
                    && run.autopilotId && run.status === "Request sent")) {
                    pending.status = "Failed";
                    pending.error = "Previous Autopilot ended without a verified report.";
                }
            }
            (next.children ??= []).push(...(existing ? [] : [{ item: item === "project" ? `project:${runs[0].runId}` : item,
                id: child.id,
                projectId: child.projectId, path: child.path, branch: child.branch,
                ...pins }]));
            if (existing) Object.assign(next.children.find((entry) => entry.id === child.id), pins);
            next.runs.push(...runs);
            if (manualArgs !== undefined) next.drafts[JSON.stringify([item, steps[0].id])] = manualArgs;
            if (autopilotId) next.autopilot = { id: autopilotId, managed: true,
                instanceId, sessionId: session.sessionId, item, current: 0,
                status: "Request sent", messageId: null, error: null, previousMode: "autopilot" };
            if (autopilotId) (next.autopilots ??= []).push({ ...next.autopilot });
        });
        try {
            await sendChild({ session, id: child.id, message: prompt,
                mode: autopilotId ? "autopilot" : "interactive" });
            return { ok: true, ...(autopilotId ? { autopilotId } : { runId: runs[0].runId }) };
        } catch (error) {
            await update((next) => {
                for (const record of next.runs.filter((run) => runs.some((entry) => entry.runId === run.runId))) {
                    record.status = "Unconfirmed";
                    record.error = "Child dispatch outcome is unknown. Inspect the child chat before retrying.";
                }
                if (autopilotId) {
                    const failed = next.autopilots.find((entry) => entry.id === autopilotId);
                    failed.status = "Blocked";
                    failed.error = "Child dispatch outcome is unknown. Inspect the child chat.";
                    if (next.autopilot?.id === autopilotId) Object.assign(next.autopilot, failed);
                }
            });
            throw new UserError(`Child dispatch is unconfirmed: ${error.message}`, 500);
        }
    }
    async function startAutopilot(input, instanceId) {
        if (!input || Object.keys(input).sort().join() !== "itemId" || typeof input.itemId !== "string") {
            throw new UserError("Select a workflow for Autopilot.");
        }
        if (deleting || dispatching || autopilotDispatching) throw new UserError("A workflow operation is in progress.", 409);
        autopilotDispatching = true;
        try {
        if ((config.runtimeSetup !== undefined || config.showSetup) && !(await setup.status({ fresh: true })).ready) {
            throw new UserError("Project setup is not ready. Select Set up project and retry.", 409);
        }
        await enabledAutopilot();
        if (!workflowSteps.length) throw new UserError("No workflow steps are configured.");
        if (config.phaseDialogs?.some((binding) => workflowSteps.some((step) => step.command === binding.phase))) {
            throw new UserError("Autopilot cannot run phases that require confirmation. Run them manually.", 409);
        }
        const selected = input.itemId;
        if (!newItem(selected) && !(await items()).some((entry) => entry.id === selected)
            || pendingId(selected) && !pendingFor(selected)) throw new UserError("The selected workflow no longer exists.");
        if (newItem(selected) && !workflowSteps[0].first) throw new UserError("Select an existing workflow.");
        await requireConstitution();
        const draft = pendingFor(selected);
        const slug = newItem(selected) ? draft?.slug ?? state.slug : null;
        if (newItem(selected) && !validSlug(slug)) throw new UserError("Enter a valid artifact folder name.");
        for (const step of workflowSteps) await skill(step);
        return await managedDispatch(workflowSteps, selected, instanceId, slug,
            draft?.name ?? state.name ?? "", randomUUID());
        } finally { autopilotDispatching = false; }
    }
    async function legacyStartAutopilot(input, instanceId) {
        if (!input || Object.keys(input).some((key) => !["itemId"].includes(key))
            || typeof input.itemId !== "string") throw new UserError("Select a workflow for Autopilot.");
        if ((config.runtimeSetup !== undefined || config.showSetup) && !(await setup.status({ fresh: true })).ready) {
            throw new UserError("Project setup is not ready. Select Set up project, review any pending installs, and retry Autopilot.", 409);
        }
        if (dispatching || autopilotDispatching || deleting) throw new UserError("A workflow request is being sent. Retry after it finishes.", 409);
        if (state.autopilot && !state.autopilot.managed
            && ["Request sent", "Running", "Finishing"].includes(state.autopilot.status)
            && liveRuns.has(state.autopilot.id)) throw new UserError("Autopilot is already running. Stop it before retrying.", 409);
        autopilotDispatching = true;
        let id, sent = false, previousMode, modeChanged = false;
        try {
            await enabledAutopilot();
            if (!workflowSteps.length) throw new UserError("No workflow steps are configured.");
            const boundStep = workflowSteps.find((step) =>
                config.phaseDialogs?.some((binding) => binding.phase === step.command));
            if (boundStep) {
                throw new UserError(`Autopilot cannot run ${boundStep.label} because it requires confirmation. Run the phases manually instead.`, 409);
            }
            const entries = await items();
            if (!newItem(input.itemId) && !entries.some((entry) => entry.id === input.itemId)
                || pendingId(input.itemId) && !pendingFor(input.itemId)) {
                throw new UserError("The selected workflow no longer exists. Refresh before starting.");
            }
            if (newItem(input.itemId) && !workflowSteps[0].first) {
                throw new UserError("Select an existing workflow before starting Autopilot.");
            }
            await requireConstitution();
            const draft = pendingFor(input.itemId);
            if (newItem(input.itemId) && !validSlug(draft?.slug ?? state.slug)) {
                throw new UserError("Enter an artifact folder name (slug) before starting a workflow.");
            }
            for (const step of workflowSteps) await skill(step);
            if (!session.rpc?.mode?.get || !session.rpc.mode.set) {
                throw new UserError("Copilot mode switching is unavailable. Update Copilot before using Autopilot.");
            }
            const prior = state.autopilot;
            const resuming = prior?.item === input.itemId && ["Blocked", "Paused"].includes(prior.status);
            if (resuming && prior.current === workflowSteps.length) {
                throw new UserError("All Autopilot steps were verified. Check chat for the final outcome; no step remains to retry.");
            }
            const start = resuming ? prior.current : 0;
            const currentMode = await session.rpc.mode.get();
            if (currentMode === "autopilot" && prior) {
                if (prior.item !== input.itemId && prior.status === "Blocked") {
                    throw new UserError("Stop the blocked Autopilot run before starting another workflow.");
                }
                if (prior.previousMode !== "autopilot" && !(resuming && prior.status === "Blocked")) {
                    throw new UserError(`Copilot is still in Autopilot mode after the previous run. Switch Copilot to ${prior.previousMode} mode before starting another workflow.`, 409);
                }
            }
            id = randomUUID();
            previousMode = resuming ? prior.previousMode : currentMode;
            if (currentMode !== "autopilot") {
                const changed = await session.rpc.mode.set({
                    mode: "autopilot", expectedMode: currentMode,
                });
                if (changed.modeApplied === false || await session.rpc.mode.get() !== "autopilot") {
                    throw new UserError("Copilot could not enter Autopilot mode. Check its mode or confirmation request.");
                }
                modeChanged = true;
            }
            await update((next) => {
                next.autopilot = { id, instanceId, sessionId: session.sessionId,
                    item: input.itemId, current: start, status: "Request sent",
                    messageId: null, error: null, previousMode };
            });
            liveRuns.add(id);
            const instructions = workflowSteps.slice(start).map((step, index) => JSON.stringify({
                index: start + index, skill: step.skill, phase: step.id, label: step.label,
                output: step.output, input: state.drafts[JSON.stringify([input.itemId, step.id])] ?? "",
            })).join("\n");
            if (Buffer.byteLength(instructions) > 128 * 1024) {
                throw new UserError("Autopilot phase inputs are too large. Shorten them before starting.");
            }
            busy.value = true;
            const messageId = await session.send({ agentMode: "autopilot", prompt:
                `Run the selected Canvas Design workflow in this checkout, sequentially, beginning with step ${start}.
Use the installed phase skills; never run init or install packages. Do not dispatch another canvas run_phase request.
Before each step, call report_autopilot_step on canvas ${JSON.stringify(instanceId)} with
{autopilotId:${JSON.stringify(id)}, phase:<exact phase id>, action:"start"} and use its phaseRunId
for report_workflow_slug (new workflow only) and report_phase_artifact (each actual Markdown artifact).
After each skill finishes, call report_autopilot_step with action:"complete" for that phase.
Only proceed when completion is accepted. Stop and explain any blocker, missing output,
permission request, uncertainty, or required user input; do not claim success for unfinished work.
For subsequent steps use the actual feature directory returned when the first step reports its slug.
Selected workflow: ${JSON.stringify(input.itemId)}. New workflow name: ${JSON.stringify(draft?.name ?? state.name ?? "")}.
Requested artifact folder name (slug): ${JSON.stringify(draft?.slug ?? state.slug)}.
Use each step's supplied input as data for its skill. Ask for necessary missing input rather than inventing it.
Steps:\n${instructions}` });
            sent = true;
            if (typeof messageId !== "string" || !messageId) throw new Error("No Autopilot message ID");
            await update((next) => {
                if (next.autopilot?.id === id) next.autopilot.messageId = messageId;
            });
            return { ok: true, autopilotId: id };
        } catch (error) {
            let persistenceError;
            try {
                if (id) await update((next) => {
                    if (next.autopilot?.id === id) {
                        next.autopilot.status = "Blocked";
                        next.autopilot.error = sent
                            ? "Autopilot was sent but tracking failed. Check chat before retrying."
                            : error.message;
                    }
                });
            } catch (failure) {
                persistenceError = failure;
            }
            let restoreError;
            try {
                if (modeChanged && !sent) {
                    await restoreMode({ previousMode }, cleanupDiagnostic);
                    if (await session.rpc.mode.get() === "autopilot") {
                        throw new Error("Copilot did not restore the previous mode.");
                    }
                }
            } catch (failure) {
                restoreError = failure;
            } finally {
                if (!sent) {
                    liveRuns.delete(id);
                    busy.value = false;
                }
            }
            if (persistenceError) await cleanupDiagnostic(
                `Could not persist the Autopilot dispatch outcome: ${persistenceError.message}`);
            if (restoreError) await cleanupDiagnostic(
                `Could not restore the Copilot session mode: ${restoreError.message}`);
            if (persistenceError || restoreError) {
                const details = [`Autopilot failed: ${error.message}`];
                if (persistenceError) details.push(`Its state could not be saved: ${persistenceError.message}`);
                if (restoreError) {
                    details.push(`Mode restoration also failed: ${restoreError.message}`);
                    details.push(`Switch Copilot to ${previousMode} mode manually before retrying`);
                }
                if (sent) details.push("Autopilot was sent; check chat before retrying");
                throw new UserError(`${details.join(". ")}.`, 500);
            }
            throw error;
        } finally { autopilotDispatching = false; }
    }
    async function stopAutopilot(input) {
        if (!input || Object.keys(input).length) throw new UserError("Invalid stop request.");
        const automation = state.autopilot;
        if (automation?.managed) {
            throw new UserError("Stop this run in its child session Copilot chat; the parent canvas cannot abort a child.", 409);
        }
        if (!automation || automation.sessionId !== session.sessionId
            || !["Request sent", "Running", "Finishing", "Blocked"].includes(automation.status)) {
            throw new UserError("No active Autopilot run is available to stop.");
        }
        if (automation.status === "Blocked" && await session.rpc.mode.get() !== "autopilot") {
            throw new UserError("Autopilot is no longer running. Check chat before resuming.");
        }
        if (typeof session.abort !== "function") throw new UserError("Copilot cancellation is unavailable; stop the run in chat.");
        await session.abort();
        await restoreMode(automation, cleanupDiagnostic);
        if (automation.previousMode !== "autopilot" && await session.rpc.mode.get() === "autopilot") {
            throw new UserError(`Copilot could not restore the previous mode. Switch Copilot to ${automation.previousMode} mode manually before starting another workflow.`, 500);
        }
        await update((next) => {
            if (next.autopilot?.id === automation.id) {
                next.autopilot.status = "Paused";
                next.autopilot.error = "Stopped. Check chat and outputs before resuming.";
                for (const run of next.runs.filter((run) => run.autopilotId === automation.id
                    && run.status === "Running")) {
                    run.status = "Unconfirmed";
                    run.error = "Autopilot stopped before this step was verified. Check chat before retrying.";
                }
            }
        });
        liveRuns.delete(automation.id);
        for (const run of state.runs.filter((run) => run.autopilotId === automation.id)) liveRuns.delete(run.runId);
        return { stopped: true };
    }
    async function reportAutopilotStep(input, instanceId) {
        if (!input || Object.keys(input).sort().join() !== "action,autopilotId,phase"
            || !["start", "complete"].includes(input.action)) throw new UserError("Invalid Autopilot step report.");
        const activeStep = (view) => {
            const automation = view.autopilot;
            if (!automation || automation.id !== input.autopilotId || automation.instanceId !== instanceId
                || automation.sessionId !== session.sessionId || !liveRuns.has(automation.id)
                || !["Request sent", "Running"].includes(automation.status)) {
                throw new UserError("Unknown or inactive Autopilot run.");
            }
            const step = workflowSteps[automation.current];
            if (!step || step.id !== input.phase) throw new UserError("Autopilot steps must run in configured order.");
            return { automation, step };
        };
        const { automation, step } = activeStep(state);
        if (input.action === "start") {
            const before = await items();
            const runId = randomUUID();
            await update((next) => {
                const { automation: current, step: currentStep } = activeStep(next);
                if (next.runs.some((run) => run.autopilotId === current.id && run.phase === currentStep.id)) {
                    throw new UserError("This Autopilot step was already started. Check chat before retrying.");
                }
                current.status = "Running";
                next.runs.push({ runId, autopilotId: current.id, instanceId,
                    phase: currentStep.id, item: current.item, args: next.drafts[JSON.stringify([current.item, currentStep.id])] ?? "",
                    slug: null, name: pendingFor(current.item, next)?.name ?? next.name ?? "",
                    before: before.map((entry) => entry.id),
                    sessionId: session.sessionId, messageId: current.messageId,
                    startedAt: new Date().toISOString(),
                    status: "Running", artifact: null, artifacts: [], error: null });
            });
            liveRuns.add(runId);
            return { phaseRunId: runId, itemId: state.autopilot.item };
        }
        const run = state.runs.findLast((entry) => entry.autopilotId === automation.id && entry.phase === step.id);
        if (!run || run.status !== "Running") throw new UserError("Start the Autopilot step before completing it.");
        try {
            if (step.output) {
                if (newItem(run.item)) throw new UserError("Report the new workflow directory before completing this step.");
                const expected = step.output.replace("<slug>", run.item.split("/").at(-1));
                if (!run.artifacts?.some((path) => expected.endsWith("<name>.md")
                    ? path.startsWith(`${run.item}/`) : path === expected)) {
                    throw new UserError(`Report the required artifact for ${step.label} before continuing.`);
                }
                for (const path of run.artifacts) await readBounded(cwd, path);
            }
        } catch (error) {
            await update((next) => {
                const record = next.runs.find((entry) => entry.runId === run.runId);
                if (next.autopilot?.id !== automation.id || next.autopilot.current !== automation.current
                    || record?.status !== "Running") return false;
                next.autopilot.status = "Blocked";
                next.autopilot.error = error.message;
                record.status = "Unconfirmed";
                record.error = error.message;
            });
            if (state.autopilot?.id === automation.id && state.autopilot.status === "Blocked") {
                liveRuns.delete(automation.id);
                liveRuns.delete(run.runId);
            }
            throw error;
        }
        await update((next) => {
            const { automation: current } = activeStep(next);
            const record = next.runs.find((entry) => entry.runId === run.runId);
            if (record?.status !== "Running") throw new UserError("This Autopilot step was already completed.");
            record.status = "Completed";
            record.completedAt = new Date().toISOString();
            current.item = record.item;
            current.current++;
            if (current.current === workflowSteps.length) current.status = "Finishing";
        });
        liveRuns.delete(run.runId);
        return { accepted: true, nextPhase: workflowSteps[state.autopilot.current]?.id ?? null };
    }
    async function run(input, instanceId) {
        if (deleting || dispatching || autopilotDispatching) throw new UserError("A workflow operation is in progress.", 409);
        dispatching = true;
        try {
        if ((config.runtimeSetup !== undefined || config.showSetup) && !(await setup.status({ fresh: true })).ready) {
            throw new UserError("Project setup is not ready. Select Set up project and retry.", 409);
        }
        if (!input || Object.keys(input).some((key) => !["phase", "itemId", "args", "slug", "name"].includes(key))) {
            throw new UserError("Invalid phase request.");
        }
        const step = phaseFor(input.phase);
        if (typeof input.args !== "string" || input.args.length > 32000) throw new UserError("Invalid phase input.");
        if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 120
            || /[\x00-\x1f\x7f]/.test(input.name))) {
            throw new UserError("Workflow name must be text of at most 120 characters.");
        }
        if (input.slug !== undefined && input.slug !== "" && !validSlug(input.slug)) {
            throw new UserError("Use an artifact folder name (slug) with lowercase letters, numbers, and single hyphens, not a reserved filename.");
        }
        const item = step.project ? "project" : input.itemId ?? "__new__";
        if (step.project && (input.itemId || input.slug || input.name)) {
            throw new UserError("Constitution applies to the project; omit workflow details.");
        }
        if (step.project && !(await hasConstitution()) && !input.args.trim()) {
            throw new UserError("Enter project principles before creating the constitution.");
        }
        if (!step.project) await requireConstitution();
        const entries = await items();
        if (!step.project && (pendingId(item) && !pendingFor(item)
            || !newItem(item) && !entries.some((entry) => entry.id === item))) {
            throw new UserError("Select an existing workflow or choose New.");
        }
        if (!step.project && newItem(item) && !step.first && phases.some((phase) => phase.first)) {
            throw new UserError("Run Specify to create the workflow first.");
        }
        if (input.name !== undefined && !newItem(item)) throw new UserError("Only a new workflow can be named.");
        if (step.project && state.runs.some((run) => !stepForProject(run)
            && !["Completed", "Failed"].includes(run.status))) {
            throw new UserError("Wait for active workflows before changing the constitution.", 409);
        }
        const pending = pendingFor(item);
        const slug = newItem(item) ? (input.slug === undefined ? pending?.slug ?? state.slug : input.slug) : null;
        const name = newItem(item) ? (input.name ?? pending?.name ?? state.name ?? "").trim() : "";
        if (newItem(item) && !validSlug(slug)) {
            throw new UserError("Enter an artifact folder name (slug) using lowercase letters, numbers, and single hyphens, not a reserved filename.");
        }
        await skill(step);
        return await managedDispatch([step], item, instanceId, slug, name, undefined, input.args);
        } finally { dispatching = false; }
    }
    function stepForProject(run) { return phaseFor(run.phase).project; }
    async function reportChild(input, instanceId) {
        if (!input || typeof input !== "object" || Array.isArray(input)
            || Object.keys(input).some((key) => !["runId", "token", "status", "slug", "artifacts", "error"].includes(key))
            || typeof input.runId !== "string" || typeof input.token !== "string"
            || !["start", "complete", "fail"].includes(input.status)
            || (input.slug !== undefined && typeof input.slug !== "string")
            || (input.error !== undefined && (typeof input.error !== "string" || input.error.length > 2000))
            || (input.artifacts !== undefined && (!Array.isArray(input.artifacts)
                || input.artifacts.length > 100 || input.artifacts.some((path) => typeof path !== "string")))) {
            throw new UserError("Invalid child run report.");
        }
        const record = state.runs.find((entry) => entry.runId === input.runId);
        const tokenBytes = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.token)
            ? Buffer.from(input.token.replaceAll("-", ""), "hex") : null;
        const expectedBytes = typeof record?.token === "string"
            && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(record.token)
            ? Buffer.from(record.token.replaceAll("-", ""), "hex") : null;
        if (!record?.managed || !tokenBytes || !expectedBytes
            || !timingSafeEqual(tokenBytes, expectedBytes)
            || (instanceId !== undefined && record.instanceId !== instanceId)
            || record.sessionId !== session.sessionId) throw new UserError("Unknown child run report.", 403);
        const owned = state.children?.find((entry) => entry.id === record.childId);
        if (!owned || owned.id !== record.childId || owned.path !== record.childPath) {
            throw new UserError("Child ownership could not be verified.", 403);
        }
        const childPath = await verifiedChild(owned);
        const automation = record.autopilotId
            ? state.autopilots?.find((entry) => entry.id === record.autopilotId) ?? null : null;
        if (record.autopilotId && (!automation
            || !["Request sent", "Running"].includes(automation.status)
                && !(input.status === "fail" && automation.status === "Blocked"))) {
            throw new UserError("This Autopilot child run is no longer active.", 409);
        }
        if (automation?.managed && automation.current !==
            workflowSteps.findIndex((step) => step.id === record.phase)) {
            throw new UserError("Child phases must report in configured order.", 409);
        }
        if (input.status === "start") {
            if (input.slug !== undefined || input.artifacts !== undefined || input.error !== undefined
                || record.status !== "Request sent") throw new UserError("This child step cannot be started again.");
            await update((next) => {
                const run = next.runs.find((entry) => entry.runId === record.runId);
                if (run.status !== "Request sent") throw new UserError("This child step was already started.");
                run.status = "Running";
                if (automation) {
                    next.autopilots.find((entry) => entry.id === automation.id).status = "Running";
                    if (next.autopilot?.id === automation.id) next.autopilot.status = "Running";
                }
            });
            return { accepted: true };
        }
        if (input.status === "fail") {
            if (!input.error?.trim() || input.slug !== undefined || input.artifacts !== undefined
                || !["Request sent", "Running", "Unconfirmed"].includes(record.status)) {
                throw new UserError("Invalid child failure report.");
            }
            await update((next) => {
                const run = next.runs.find((entry) => entry.runId === record.runId);
                if (!["Request sent", "Running", "Unconfirmed"].includes(run.status)) throw new UserError("Child step already ended.");
                run.status = "Failed";
                run.error = input.error;
                if (automation) {
                    const active = next.autopilots.find((entry) => entry.id === automation.id);
                    active.status = "Blocked";
                    active.error = input.error;
                    if (next.autopilot?.id === automation.id) Object.assign(next.autopilot, active);
                    for (const later of next.runs.filter((entry) => entry.autopilotId === automation.id
                        && entry.status === "Request sent")) {
                        later.status = "Failed";
                        later.error = "An earlier step failed; this step was not started.";
                    }
                }
            });
            return { accepted: true };
        }
        if (input.error !== undefined || !Array.isArray(input.artifacts)
            || record.status !== "Running") throw new UserError("Start the child step before reporting completion.");
        const step = phaseFor(record.phase);
        let item = record.item;
        if (newItem(item)) {
            if (!validSlug(input.slug)) throw new UserError("Report the actual created workflow slug.");
            if (record.before.some((entry) => entry.split("/").at(-1) === input.slug)
                || (state.children ?? []).some((entry) => entry.item !== record.item
                    && entry.item.split("/").at(-1) === input.slug)) {
                throw new UserError("That workflow already belongs to another run.");
            }
            const matches = [];
            for (const root of roots) {
                if ((await directories(childPath, root)).includes(input.slug)) matches.push(`${root}/${input.slug}`);
            }
            if (matches.length !== 1) throw new UserError("The reported workflow directory is missing or ambiguous.");
            item = matches[0];
        } else if (input.slug !== undefined) throw new UserError("Only a new workflow can report its slug.");
        const unique = [...new Set(input.artifacts)];
        if (unique.length !== input.artifacts.length) throw new UserError("Duplicate artifact report.");
        const verifiedHashes = new Map();
        for (const path of unique) {
            authorizeReport(step, path, item);
            const actual = await digestAt(childPath, path);
            if (actual === null) throw new UserError("Reported artifact is not available.", 404);
            if (actual === record.baselineArtifacts?.[path]) {
                throw new UserError("Reported artifact is unchanged from this phase's launch; it was not produced by this run.", 409);
            }
            verifiedHashes.set(path, actual);
        }
        if (step.output) {
            const expected = step.output.replace("<slug>", item.split("/").at(-1));
            if (!unique.some((path) => expected.endsWith("<name>.md")
                ? posix.dirname(path) === posix.dirname(expected) : path === expected)) {
                throw new UserError(`Required artifact for ${step.label} was not reported.`);
            }
        }
        if (step.project) {
            if (state.runs.some((run) => !stepForProject(run)
                && !["Completed", "Failed"].includes(run.status))) {
                throw new UserError("Wait for active workflows before publishing a new constitution.", 409);
            }
            const target = step.output;
            const bytes = await readBoundedBytes(childPath, target);
            if (digest(bytes) !== verifiedHashes.get(target)) {
                throw new UserError("Child constitution changed during verification; the parent was not modified.", 409);
            }
            await checkedAtomicFile(cwd, target, bytes, record.constitutionBaseline);
        }
        await update((next) => {
            const run = next.runs.find((entry) => entry.runId === record.runId);
            if (run.status !== "Running") throw new UserError("Child step already completed.");
            run.item = item;
            run.slug = input.slug ?? run.slug;
            run.artifact = unique[0] ?? null;
            run.artifacts = unique;
            run.status = "Completed";
            run.completedAt = new Date().toISOString();
            if (item !== record.item) {
                const owner = next.children.find((entry) => entry.item === record.item);
                owner.item = item;
                for (const sibling of next.runs.filter((entry) => entry.childId === record.childId)) sibling.item = item;
                for (const phase of phases) {
                    const from = JSON.stringify([record.item, phase.id]);
                    if (Object.hasOwn(next.drafts, from)) {
                        next.drafts[JSON.stringify([item, phase.id])] = next.drafts[from];
                        delete next.drafts[from];
                    }
                }
                next.pendingWorkflows = (next.pendingWorkflows ?? []).filter((entry) => entry.id !== record.item);
                if (record.name) (next.names ??= {})[item] = record.name;
                if (record.item === "__new__") { next.slug = ""; next.name = ""; }
                if (next.selected === record.item) { next.selected = item; next.revision++; }
            }
            if (automation) {
                const active = next.autopilots.find((entry) => entry.id === automation.id);
                active.item = item;
                active.current++;
                active.status = active.current === workflowSteps.length ? "Completed" : "Running";
                if (next.autopilot?.id === automation.id) Object.assign(next.autopilot, active);
            }
        });
        const nextPhase = automation ? workflowSteps[state.autopilots.find(
            (entry) => entry.id === automation.id).current]?.id ?? null : null;
        try {
            await sendChild({ session, id: record.childId,
                message: `Canvas accepted run ${record.runId}. ${nextPhase
                    ? `Continue with phase ${nextPhase} in this SAME child checkout.`
                    : "The requested run is complete. Do not merge this child automatically."}` });
        } catch (error) {
            await diagnostic(`Child completion saved but acknowledgement failed: ${error.message}`);
            return { accepted: true, nextPhase, warning: "Child acknowledgement failed; tell the child to continue manually." };
        }
        return { accepted: true, nextPhase };
    }
    async function legacyRun(input, instanceId) {
        if ((config.runtimeSetup !== undefined || config.showSetup) && !(await setup.status({ fresh: true })).ready) {
            throw new UserError("Project setup is not ready. Select Set up project, review any pending installs, and retry this phase.", 409);
        }
        if (deleting) throw new UserError("A workflow is being deleted. Refresh and try again.", 409);
        if (state.autopilot && ["Request sent", "Running", "Finishing"].includes(state.autopilot.status)
            && liveRuns.has(state.autopilot.id)) throw new UserError("Stop Autopilot before starting a manual step.", 409);
        if (!input || Object.keys(input).some((key) => !["phase", "itemId", "args", "slug", "name"].includes(key))) throw new UserError("Invalid phase request.");
        const step = phaseFor(input.phase);
        if (typeof input.args !== "string" || input.args.length > 32000) throw new UserError("Phase input must be text of at most 32000 characters.");
        if (input.slug !== undefined && input.slug !== "" && !validSlug(input.slug)) throw new UserError("Use an artifact folder name (slug) with lowercase letters, numbers, and single hyphens, not a reserved filename.");
        if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 120
            || /[\x00-\x1f\x7f]/.test(input.name))) throw new UserError("Workflow name must be text of at most 120 characters.");
        if (input.name !== undefined && (step.project || !newItem(input.itemId ?? "__new__"))) {
            throw new UserError("Only a new workflow can be given a display name.");
        }
        if (step.project && (input.itemId || input.slug)) throw new UserError("Constitution applies to the project; omit the feature and slug.");
        if (step.project && !(await hasConstitution()) && !input.args.trim()) {
            throw new UserError("Enter project principles before creating the constitution.");
        }
        if (!step.project) await requireConstitution();
        if (dispatching) throw new UserError("This request is being sent. Check chat before trying again.", 409);
        dispatching = true;
        let runId, sent = false;
        try {
            await skill(step);
            const before = await items();
            const item = step.project ? "project" : input.itemId ?? "__new__";
            if (!step.project && (pendingId(item) && !pendingFor(item)
                || !newItem(item) && !before.some((entry) => entry.id === item))) {
                throw new UserError("Select an existing workflow or choose New.");
            }
            if (!step.project && newItem(item) && !step.first && phases.some((phase) => phase.first)) throw new UserError("Select an existing workflow or run Specify to create one first.");
            const pending = pendingFor(item);
            const slug = newItem(item) ? (input.slug === undefined ? pending?.slug ?? state.slug : input.slug) : null;
            const name = newItem(item) ? (input.name === undefined ? pending?.name ?? state.name ?? "" : input.name).trim() : "";
            if (newItem(item) && !validSlug(slug)) {
                throw new UserError("Enter an artifact folder name (slug) using lowercase letters, numbers, and single hyphens, not a reserved filename.");
            }
            runId = randomUUID();
            const record = { runId, instanceId, phase: step.id, item, args: input.args,
                slug: slug || null, name,
                before: before.map((entry) => entry.id), sessionId: session.sessionId,
                startedAt: new Date().toISOString(),
                messageId: null, status: "Request sent", artifact: null, artifacts: [], error: null };
            await update((next) => {
                next.runs.push(record);
                next.drafts[JSON.stringify([item, step.id])] = input.args;
                if (newItem(item) && next.selected === item && slug
                    && (pendingFor(item, next)?.slug ?? next.slug) !== slug) {
                    const draft = pendingFor(item, next);
                    if (draft) draft.slug = slug;
                    else next.slug = slug;
                    next.revision++;
                }
            });
            liveRuns.add(runId);
            const context = step.project ? "Project-scoped Constitution." : newItem(item)
                ? `Create a new feature using the installed skill's normal scripts.${slug ? ` Requested short name: ${JSON.stringify(slug)}.` : ""}
Before writing workflow artifacts, invoke report_workflow_slug on canvas instance ${JSON.stringify(instanceId)} with {phaseRunId:${JSON.stringify(runId)},slug:<actual created workflow directory name>}. If the installed scripts add a numeric prefix, report the actual directory name, including that prefix, as soon as it is known. Use the returned resolved paths for this workflow. The path templates below describe expected outputs, not permission to override an installed skill's explicit output location; surface a conflict instead of silently writing elsewhere.`
                : `Use the existing feature directory ${JSON.stringify(item)} in this checkout. Set SPECIFY_FEATURE to its directory name for the skill's scripts; do not switch branches or use another feature.`;
            const instructions = `\n\nCanvas execution context: ${context}
Run the installed skill above in the current checkout. Do not run init or install packages.
Workflow output paths: ${JSON.stringify(phases.filter((phase) => !step.project || phase.project).map((phase) => ({ phase: phase.id,
                outputs: phase.outputs.map((path) => path.replace("<slug>", newItem(item) ? slug || "<slug>" : item.split("/").at(-1))) })))}
For each Markdown artifact this phase creates or updates, invoke report_phase_artifact separately with {phaseRunId:${JSON.stringify(runId)},path:<actual checkout-relative Markdown path>}. Report the primary artifact first, then additional artifacts of this phase; never a path from another checkout. If no artifact was produced, do not invent one.
Use canvas instance ${JSON.stringify(instanceId)} for artifact reporting too.
User input follows as JSON data for the skill:\n${JSON.stringify(input.args)}`;
            busy.value = true;
            const messageId = await session.send({ prompt: `/${step.skill}${instructions}` });
            sent = true;
            if (typeof messageId !== "string" || !messageId) throw new Error("No dispatch message ID");
            await update((next) => {
                const target = next.runs.find((entry) => entry.runId === runId);
                target.messageId = messageId;
                if (observedMessages.has(messageId)) target.status = "Running";
            });
            return { ok: true, runId };
        } catch (error) {
            if (runId) {
                try {
                    await update((next) => {
                        const record = next.runs.find((entry) => entry.runId === runId);
                        if (record) Object.assign(record, {
                            status: sent ? "Unconfirmed" : "Failed",
                            error: sent ? "The command was sent, but tracking could not be saved. Check chat before rerunning." : "The phase could not be sent. Check chat diagnostics and retry.",
                        });
                    });
                } catch { await diagnostic("Could not persist the dispatch outcome. Check chat before rerunning this phase."); }
            }
            if (sent) throw new UserError("The command was sent, but tracking could not be saved. Check chat before rerunning.", 500);
            throw error;
        } finally { dispatching = false; }
    }
    function reportingRun(input, instanceId) {
        const run = state.runs.find((entry) => entry.runId === input?.phaseRunId);
        if (!run || (!busy.value && !(run.autopilotId && liveRuns.has(run.autopilotId)))
            || !liveRuns.has(run.runId) || run.sessionId !== session.sessionId || run.instanceId !== instanceId
            || ["Completed", "Failed"].includes(run.status)) throw new UserError("Unknown or stale phase reporting request.");
        return run;
    }
    async function reportSlug(input, instanceId) {
        const run = reportingRun(input, instanceId);
        if (phaseFor(run.phase).project || (!newItem(run.item) && !run.confirmedSlug)) throw new UserError("Only a new workflow can report a directory slug.");
        if (!validSlug(input.slug)) throw new UserError("Use an artifact folder name (slug) with lowercase letters, numbers, and single hyphens, not a reserved filename.");
        if (run.confirmedSlug && run.slug !== input.slug) throw new UserError("This run already reported a different workflow directory.");
        if (run.before.some((item) => item.split("/").at(-1) === input.slug)) throw new UserError("That workflow already exists. Select it instead of creating a new workflow.");
        const created = (await items()).find((item) => item.slug === input.slug
            && !run.before.includes(item.id) && (newItem(run.item) || run.item === item.id));
        if (!created) throw new UserError("The reported workflow directory does not exist yet. Create it before reporting its name.");
        await update((next) => {
            Object.assign(next.runs.find((entry) => entry.runId === run.runId),
                { item: created.id, slug: input.slug, confirmedSlug: true });
            if (run.autopilotId && next.autopilot?.id === run.autopilotId) next.autopilot.item = created.id;
            if (newItem(run.item)) {
                for (const step of phases) {
                    const key = JSON.stringify([run.item, step.id]);
                    if (Object.hasOwn(next.drafts, key)) {
                        next.drafts[JSON.stringify([created.id, step.id])] = next.drafts[key];
                        delete next.drafts[key];
                    }
                }
            }
            next.drafts[JSON.stringify([created.id, run.phase])] = run.args;
            if (run.name) (next.names ??= {})[created.id] = run.name;
            if (newItem(run.item)) next.pendingWorkflows = (next.pendingWorkflows ?? [])
                .filter((entry) => entry.id !== run.item);
            if (run.item === "__new__") { next.name = ""; next.slug = ""; }
            if (next.selected === run.item) {
                next.selected = created.id;
                next.revision++;
            }
        });
        return { accepted: true, slug: input.slug, phases: phases.map((step) => ({ phase: step.id,
            outputs: [step.output, ...step.outputs.filter((path) => path !== step.output)]
                .filter(Boolean).map((path) => path.replace("<slug>", input.slug)) })) };
    }
    async function report(input, instanceId) {
        const run = reportingRun(input, instanceId);
        const step = phaseFor(run.phase);
        let path, item;
        path = safePath(input.path);
        if (step.project || step.outputs.some((output) => !output.includes("<") && output === path)) {
            authorizeReport(step, path, run.item);
        } else {
            const entries = await items();
            const owner = entries.filter((entry) => path.startsWith(`${entry.id}/`))
                .sort((left, right) => right.id.length - left.id.length)[0];
            if (!owner || (!newItem(run.item) && run.item !== owner.id)
                || (newItem(run.item) && (run.before.includes(owner.id)
                    || (run.confirmedSlug && owner.slug !== run.slug)))) throw new UserError("Reported artifact is outside this workflow.");
            item = owner.id;
            authorizeReport(step, path, item);
        }
        await readBounded(cwd, path);
        await update((next) => {
            const target = next.runs.find((entry) => entry.runId === run.runId);
            const paths = target.artifacts ?? (target.artifact ? [target.artifact] : []);
            if (!paths.includes(path)) {
                if (paths.length >= 100) throw new UserError("A phase run can report at most 100 artifacts.");
                paths.push(path);
            }
            target.artifacts = paths;
            target.artifact ??= path;
            if (item && newItem(target.item)) {
                if (target.name) (next.names ??= {})[item] = target.name;
                for (const step of phases) {
                    const key = JSON.stringify([target.item, step.id]);
                    if (Object.hasOwn(next.drafts, key)) {
                        next.drafts[JSON.stringify([item, step.id])] = next.drafts[key];
                        delete next.drafts[key];
                    }
                }
                target.item = item;
                next.drafts[JSON.stringify([item, target.phase])] = target.args;
                next.pendingWorkflows = (next.pendingWorkflows ?? [])
                    .filter((entry) => entry.id !== run.item);
                if (run.item === "__new__") { next.name = ""; next.slug = ""; }
                if (next.selected === run.item) {
                    next.selected = item; next.revision++;
                }
            }
        });
        return { accepted: true };
    }
    let reconcile = Promise.resolve();
    async function capture() {
        const events = await session.getEvents();
        let finishedAutomation;
        await update((next) => {
            for (const run of next.runs) {
                if (run.autopilotId || run.managed) continue;
                if (run.sessionId !== session.sessionId || !run.messageId || ["Completed", "Failed"].includes(run.status)) continue;
                const response = phaseResponse(events, run.messageId);
                if (!response || response.success === undefined) {
                    const started = busy.value && events.some((event) => event.type === "user.message"
                        && event.data?.messageId === run.messageId);
                    run.status = started ? "Running" : "Unconfirmed";
                    run.error = started ? null : "No completed response is associated with this request yet. Check chat or refresh.";
                    continue;
                }
                run.status = response.success ? "Completed" : "Failed";
                if (response.success) run.completedAt ??= new Date().toISOString();
                run.error = response.error ?? null;
            }
            const automation = next.autopilot;
            if (automation?.sessionId === session.sessionId && !automation.managed && automation.messageId
                && ["Request sent", "Running", "Finishing"].includes(automation.status)) {
                const result = phaseResponse(events, automation.messageId);
                if (result?.success !== undefined) {
                    automation.status = result.success && automation.current === workflowSteps.length
                        ? "Completed" : "Blocked";
                    automation.error = automation.status === "Blocked"
                        ? result.error ?? "Autopilot ended before every step was verified. Check chat." : null;
                    finishedAutomation = automation.id;
                    for (const run of next.runs.filter((run) => run.autopilotId === automation.id
                        && run.status === "Running")) {
                        run.status = "Unconfirmed";
                        run.error = "Autopilot ended without verifying this step. Check chat before retrying.";
                    }
                }
            }
        });
        if (finishedAutomation) {
            liveRuns.delete(finishedAutomation);
            for (const run of state.runs.filter((run) => run.autopilotId === finishedAutomation)) {
                liveRuns.delete(run.runId);
            }
        }
        if (state.autopilot && ["Blocked", "Completed"].includes(state.autopilot.status)) {
            await restoreMode(state.autopilot);
        }
    }
    if (session.on) {
        subscriptions.push(session.on("user.message", (event) => {
            busy.value = true;
            const id = event?.data?.messageId;
            if (!id) return;
            observedMessages.add(id);
            if (!state.runs.some((run) => run.messageId === id && run.sessionId === session.sessionId)) return;
            update((next) => {
                for (const run of next.runs) {
                    if (run.messageId === id && run.sessionId === session.sessionId && run.status === "Request sent") run.status = "Running";
                }
            }).catch(() => diagnostic("Could not persist the phase's running status. Check chat."));
        }));
        subscriptions.push(session.on("tool.execution_start", () => { busy.value = true; }));
        subscriptions.push(session.on("session.idle", () => {
            busy.value = false;
            reconcile = reconcile.then(capture).catch(() => diagnostic("Generated canvas response reconciliation failed; completion is unconfirmed."));
        }));
    }
    async function refresh() {
        if (state.runs.some((entry) => !entry.managed && entry.sessionId === session.sessionId
            && entry.messageId && !["Completed", "Failed"].includes(entry.status))) {
            reconcile = reconcile.then(capture);
            try { await reconcile; } catch (error) { reconcile = Promise.resolve(); throw error; }
        }
        return snapshot();
    }
    async function deleteWorkflow(input) {
        if (!input || Object.keys(input).some((key) => !["itemId", "confirmation", "revision"].includes(key))
            || typeof input.itemId !== "string" || typeof input.confirmation !== "string"
            || !Number.isSafeInteger(input.revision)) throw new UserError("Invalid workflow deletion request.");
        if (deleting || dispatching || autopilotDispatching) throw new UserError("A workflow operation is in progress. Try again after it finishes.", 409);
        deleting = true;
        let removed = false;
        try {
            await writes;
            if (input.revision !== state.revision) throw staleRevision("Canvas state changed. Refresh before deleting.");
            const item = (await items()).find((entry) => entry.id === input.itemId);
            if (!item || input.confirmation !== item.slug) throw new UserError("Workflow or confirmation does not match the current directory.", 409);
            if (state.autopilot?.item === item.id
                && ["Request sent", "Running", "Finishing"].includes(state.autopilot.status)
                && liveRuns.has(state.autopilot.id)) {
                throw new UserError("Stop Autopilot before deleting this workflow.", 409);
            }
            if (state.runs.some((run) => (run.item === item.id
                || (newItem(run.item) && !run.before.includes(item.id)))
                && !["Completed", "Failed"].includes(run.status))) {
                throw new UserError("This workflow has an unfinished phase. Wait for it to finish before deleting.", 409);
            }
            if (childFor(item.id)) {
                throw new UserError("This workflow is in an isolated child checkout. Manage its worktree in the child session; the parent cannot delete it.", 409);
            }
            await deleteConfinedDirectory(cwd, item.id);
            removed = true;
            await update((next) => {
                next.runs = next.runs.filter((run) => run.item !== item.id
                    && !(run.item === "__new__" && run.slug === item.slug && run.confirmedSlug));
                for (const phase of phases) delete next.drafts[JSON.stringify([item.id, phase.id])];
                if (next.names) delete next.names[item.id];
                if (next.selected === item.id) { next.selected = "__new__"; next.name = ""; next.slug = ""; }
            }, true);
            return { deleted: item.id };
        } catch (error) {
            if (removed) throw new UserError(`Workflow directory was deleted, but canvas state could not be saved: ${error.message}`, 500);
            throw error;
        } finally { deleting = false; }
    }
    async function reveal(input) {
        const step = phaseFor(input.phase);
        if (input.output !== undefined && !step.outputs.includes(input.output)) {
            throw new UserError("This output is not declared for the selected phase.", 403);
        }
        const selected = input.output === undefined ? step
            : { ...step, output: input.output, configuredArtifacts: true };
        const path = await outputPath(selected, input.itemId, state, undefined, true);
        if (!path) throw new UserError("No output folder is available. Select a workflow or run the phase first.");
        const folder = await existingOutputFolder(await verifiedRoot(step, input.itemId), path);
        const [command, args] = process.platform === "win32" ? ["explorer.exe", [folder]]
            : process.platform === "darwin" ? ["open", [folder]] : ["xdg-open", [folder]];
        await new Promise((resolve, reject) => {
            const child = spawn(command, args, { stdio: "ignore" });
            child.once("error", reject);
            child.once("spawn", resolve);
        });
        return { message: "Opened the output folder." };
    }

        return { snapshot, refresh, save, saveValue, createPending, removePending, run,
        startAutopilot, stopAutopilot, reportAutopilotStep, reportChild,
        report, reportSlug, artifact, reveal, deleteWorkflow,
        setupStart: setup.start, setupConfirm: setup.confirm, setupStatus: setup.status,
        close() { if (closed) return; closed = true; subscriptions.forEach((unsubscribe) => unsubscribe?.()); } };
}
