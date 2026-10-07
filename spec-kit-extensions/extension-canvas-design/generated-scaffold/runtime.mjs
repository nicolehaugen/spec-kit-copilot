import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { posix } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createContext, runInContext } from "node:vm";
import { UserError, confined, readBounded, readBoundedBytes, directories, atomicJson, safePath, slugPattern,
    deleteConfinedDirectory } from "./files.mjs";
import { phaseContract, valueContract, validateValue } from "./contract.mjs";
import { phaseResponse, RESPONSE_LIMIT } from "./phase-response.mjs";
import { createSetup } from "./setup.mjs";

const PROVIDER_REFRESH_LIMIT_MS = 3000;
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
            context, { timeout: 300 });
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
    if (remaining <= 0) throw new UserError(PROVIDER_REFRESH_ERROR);
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), {
            workerData: { canvasValueProvider: { source, workflow } },
            execArgv: [],
            resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 16 },
        });
        let finished = false;
        const timer = setTimeout(() => finish(remaining < 2000
            ? new UserError(PROVIDER_REFRESH_ERROR) : new Error("Provider exceeded its execution limit")),
        Math.min(2000, remaining));
        function finish(error, value) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            void worker.terminate();
            if (error) reject(error);
            else resolve(value);
        }
        worker.once("message", (result) => finish(result.error ? new Error(result.error) : null, result.value));
        worker.once("error", (error) => finish(error));
        worker.once("exit", (code) => finish(new Error(`Provider exited before returning a value (${code}).`)));
    });
}

const fresh = () => ({ version: 1, revision: 0, selected: "__new__", phase: null, slug: "",
    name: "", names: {}, drafts: {}, runs: [], values: {} });
export async function createRuntime({ config, cwd, workspace, session, notify = () => {} }) {
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
        if (state.version !== 1 || !Number.isSafeInteger(state.revision) || !Array.isArray(state.runs)
            || typeof state.drafts !== "object" || !state.drafts || Array.isArray(state.drafts)
            || typeof state.selected !== "string" || typeof state.slug !== "string"
            || (state.approvedUrlSources !== undefined
                && (!Array.isArray(state.approvedUrlSources) || state.approvedUrlSources.length > 80
                    || state.approvedUrlSources.some((receipt) =>
                        typeof receipt !== "string" || receipt.length > 8192)))
            || (state.name !== undefined && (typeof state.name !== "string" || state.name.length > 120))
            || (state.names !== undefined && (!state.names || typeof state.names !== "object"
                || Array.isArray(state.names) || Object.values(state.names).some((name) =>
                    typeof name !== "string" || name.length > 120)))
            || state.runs.some((run) => !run || typeof run.runId !== "string" || typeof run.item !== "string"
                || !phases.some((phase) => phase.id === run.phase) || typeof run.sessionId !== "string"
                || typeof run.instanceId !== "string" || typeof run.args !== "string" || !Array.isArray(run.before)
                || (run.name !== undefined && (typeof run.name !== "string" || run.name.length > 120
                    || /[\x00-\x1f\x7f]/.test(run.name)))
                || !["Request sent", "Running", "Unconfirmed", "Completed", "Failed"].includes(run.status)
                || (run.artifact !== null && typeof run.artifact !== "string")
                || (run.artifacts !== undefined && (!Array.isArray(run.artifacts)
                    || run.artifacts.length > 100 || run.artifacts.some((path) => typeof path !== "string")))
                || (run.response !== undefined && run.response !== null
                    && (typeof run.response !== "string" || Buffer.byteLength(run.response) > RESPONSE_LIMIT))
                || (run.responseError !== undefined && run.responseError !== null && typeof run.responseError !== "string")
                || (run.messageId !== null && typeof run.messageId !== "string"))
            || Object.values(state.drafts).some((draft) => typeof draft !== "string" || draft.length > 32000)
            || (state.values !== undefined && (!state.values || typeof state.values !== "object"
                || Array.isArray(state.values) || Object.entries(state.values).some(([id, value]) => {
                    const field = valueFields.find((entry) => entry.id === id && entry.presentation === "stock.editable");
                    if (!field) return true;
                    try { validateValue(field.schema, value, id); return false; } catch { return true; }
                })))
            || (state.autopilot !== undefined && (!state.autopilot
                || typeof state.autopilot.id !== "string" || typeof state.autopilot.item !== "string"
                || typeof state.autopilot.instanceId !== "string" || typeof state.autopilot.sessionId !== "string"
                || !Number.isInteger(state.autopilot.current) || state.autopilot.current < 0
                || state.autopilot.current > phases.filter((step) => !step.project).length
                || !["Request sent", "Running", "Finishing", "Completed", "Blocked", "Paused"].includes(state.autopilot.status)
                || (state.autopilot.messageId !== null && typeof state.autopilot.messageId !== "string")
                || !["interactive", "plan", "autopilot", "shell"].includes(state.autopilot.previousMode)))) {
            throw new UserError("Saved canvas state is invalid. Restore its state.json before continuing.");
        }
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        state = fresh();
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
    if (state.autopilot && ["Request sent", "Running", "Finishing"].includes(state.autopilot.status)) {
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
    const roots = [...new Set(["specs", ...phases.flatMap((step) => step.configuredArtifacts
        ? [config.phaseOutputs?.[step.id]?.outputPath].filter(Boolean) : step.outputs)
        .filter((path) => path.includes("<slug>")).map((path) => path.split("/<slug>")[0])])];
    async function items(view = state) {
        const found = [];
        for (const root of roots) {
            if (root.includes("<") || root.startsWith(".git")) continue;
            for (const slug of await directories(cwd, root)) {
                const id = `${root}/${slug}`;
                found.push({ id, slug, label: view.names?.[id] || slug });
            }
        }
        return found;
    }
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
    async function outputPath(step, item, view = state, entries) {
        const run = runFor(step, item, view);
        if (!step.configuredArtifacts && run?.artifact) { authorizeReport(step, run.artifact, run.item); return run.artifact; }
        if (!step.output) return null;
        let path = step.output;
        if (path.includes("<slug>")) {
            const selected = (entries ?? await items(view)).find((entry) => entry.id === item);
            const slug = selected?.slug ?? (item === "__new__" && config.userProvidesSlug && validSlug(view.slug) ? view.slug : null);
            if (!slug) return null;
            path = path.replace("<slug>", slug);
            if (selected && !step.configuredArtifacts && !path.startsWith(`${selected.id}/`)) {
                throw new UserError("This phase output belongs to a different workflow.");
            }
        }
        if (path.endsWith("<name>.md")) {
            const parent = posix.dirname(path);
            try {
                const entries = await readdir(await confined(cwd, parent), { withFileTypes: true });
                const candidates = [];
                for (const entry of entries) {
                    if (!entry.isFile() || !/^[a-z0-9][a-z0-9._-]*\.md$/i.test(entry.name)) continue;
                    const path = `${parent}/${entry.name}`;
                    candidates.push({ path, mtime: (await lstat(await confined(cwd, path))).mtimeMs });
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
            const content = await readBounded(cwd, path);
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
        const selectedWorkflow = item === "__new__" ? null : entries.find((entry) => entry.id === item);
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
                    const info = await lstat(await confined(cwd, output));
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
            const status = run && !liveRuns.has(run.runId) && !["Completed", "Failed"].includes(run.status)
                ? "Unconfirmed" : run?.status ?? "Not run";
            statuses[step.id] = { status, output, artifactAvailability, artifactError,
                error: run?.error ?? null };
        }
        const automation = view.autopilot
            ? { ...view.autopilot, message: view.autopilot.error
                ?? `${view.autopilot.status}: step ${Math.min(view.autopilot.current + 1, workflowSteps.length)} of ${workflowSteps.length}` }
            : null;
        if (automation && ["Request sent", "Running", "Finishing"].includes(automation.status)
            && (automation.sessionId !== session.sessionId || !liveRuns.has(automation.id))) {
            automation.status = "Blocked";
            automation.message = "Autopilot outcome is unconfirmed. Check chat before resuming.";
        }
        return { ...view, userProvidesSlug: config.userProvidesSlug, autopilot: automation,
            showSetup: config.showSetup === true,
            selected: item, runs: undefined, tagMatches: undefined, values: undefined,
            phases, items: entries, statuses, valueFields: visibleValues, pageValues, valueErrors,
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
            if (input.revision !== next.revision) throw new UserError("Canvas state changed in another panel. Refresh before saving.", 409);
            (next.values ??= {})[field.id] = value;
        }, true);
        return { revision: state.revision };
    }
    async function save(input) {
        if (deleting) throw new UserError("A workflow is being deleted. Refresh and try again.", 409);
        if (!input || Object.keys(input).some((key) => !["revision", "selected", "phase", "slug", "name", "draft"].includes(key))) throw new UserError("Invalid canvas state update.");
        if (input.selected !== undefined && input.selected !== "__new__" && !(await items()).some((item) => item.id === input.selected)) throw new UserError("That workflow is no longer available. Refresh the workflow list.");
        if (input.phase !== undefined) phaseFor(input.phase);
        if (input.slug !== undefined && (typeof input.slug !== "string" || input.slug.length > 100)) throw new UserError("Workflow slug is too long.");
        if (input.slug !== undefined && !config.userProvidesSlug) throw new UserError("Custom workflow slugs are disabled for this canvas.");
        if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 120
            || /[\x00-\x1f\x7f]/.test(input.name))) throw new UserError("Workflow name must be text of at most 120 characters.");
        if (input.name !== undefined && (input.selected ?? state.selected) !== "__new__") {
            throw new UserError("Only a new workflow can be given a display name.");
        }
        if (input.draft && (typeof input.draft.value !== "string" || input.draft.value.length > 32000
            || typeof input.draft.item !== "string"
            || (input.draft.item !== "__new__" && input.draft.item !== "project" && !(await items()).some((item) => item.id === input.draft.item)))) throw new UserError("Invalid phase draft.");
        if (input.draft) phaseFor(input.draft.phase);
        await update((next) => {
            if (input.revision !== next.revision) throw new UserError("Canvas state changed in another panel. Refresh before saving.", 409);
            for (const key of ["selected", "phase", "slug", "name"]) if (input[key] !== undefined) next[key] = input[key];
            if (input.draft) next.drafts[JSON.stringify([input.draft.item, input.draft.phase])] = input.draft.value;
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
    async function startAutopilot(input, instanceId) {
        if (!input || Object.keys(input).some((key) => !["itemId"].includes(key))
            || typeof input.itemId !== "string") throw new UserError("Select a workflow for Autopilot.");
        if ((config.runtimeSetup !== undefined || config.showSetup) && !(await setup.status({ fresh: true })).ready) {
            throw new UserError("Project setup is not ready. Select Set up project, review any pending installs, and retry Autopilot.", 409);
        }
        if (dispatching || autopilotDispatching || deleting) throw new UserError("A workflow request is being sent. Retry after it finishes.", 409);
        if (state.autopilot && ["Request sent", "Running", "Finishing"].includes(state.autopilot.status)
            && liveRuns.has(state.autopilot.id)) throw new UserError("Autopilot is already running. Stop it before retrying.", 409);
        autopilotDispatching = true;
        let id, sent = false, previousMode, modeChanged = false;
        try {
            await enabledAutopilot();
            if (!workflowSteps.length) throw new UserError("No workflow steps are configured.");
            const entries = await items();
            if (input.itemId !== "__new__" && !entries.some((entry) => entry.id === input.itemId)) {
                throw new UserError("The selected workflow no longer exists. Refresh before starting.");
            }
            if (input.itemId === "__new__" && !workflowSteps[0].first) {
                throw new UserError("Select an existing workflow before starting Autopilot.");
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
Selected workflow: ${JSON.stringify(input.itemId)}. New workflow name: ${JSON.stringify(state.name ?? "")}.
Requested slug: ${JSON.stringify(config.userProvidesSlug ? state.slug : "")}.
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
                    slug: null, name: next.name ?? "", before: before.map((entry) => entry.id),
                    sessionId: session.sessionId, messageId: current.messageId,
                    status: "Running", artifact: null, artifacts: [], error: null });
            });
            liveRuns.add(runId);
            return { phaseRunId: runId, itemId: state.autopilot.item };
        }
        const run = state.runs.findLast((entry) => entry.autopilotId === automation.id && entry.phase === step.id);
        if (!run || run.status !== "Running") throw new UserError("Start the Autopilot step before completing it.");
        try {
            if (step.output) {
                if (run.item === "__new__") throw new UserError("Report the new workflow directory before completing this step.");
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
            current.item = record.item;
            current.current++;
            if (current.current === workflowSteps.length) current.status = "Finishing";
        });
        liveRuns.delete(run.runId);
        return { accepted: true, nextPhase: workflowSteps[state.autopilot.current]?.id ?? null };
    }
    async function run(input, instanceId) {
        if ((config.runtimeSetup !== undefined || config.showSetup) && !(await setup.status({ fresh: true })).ready) {
            throw new UserError("Project setup is not ready. Select Set up project, review any pending installs, and retry this phase.", 409);
        }
        if (deleting) throw new UserError("A workflow is being deleted. Refresh and try again.", 409);
        if (state.autopilot && ["Request sent", "Running", "Finishing"].includes(state.autopilot.status)
            && liveRuns.has(state.autopilot.id)) throw new UserError("Stop Autopilot before starting a manual step.", 409);
        if (!input || Object.keys(input).some((key) => !["phase", "itemId", "args", "slug", "name"].includes(key))) throw new UserError("Invalid phase request.");
        const step = phaseFor(input.phase);
        if (typeof input.args !== "string" || input.args.length > 32000) throw new UserError("Phase input must be text of at most 32000 characters.");
        if (input.slug !== undefined && input.slug !== "" && !validSlug(input.slug)) throw new UserError("Use a workflow slug with lowercase letters, numbers, and single hyphens, not a reserved filename.");
        if (input.slug !== undefined && !config.userProvidesSlug) throw new UserError("Custom workflow slugs are disabled for this canvas.");
        if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 120
            || /[\x00-\x1f\x7f]/.test(input.name))) throw new UserError("Workflow name must be text of at most 120 characters.");
        if (input.name !== undefined && (step.project || (input.itemId ?? "__new__") !== "__new__")) {
            throw new UserError("Only a new workflow can be given a display name.");
        }
        if (step.project && (input.itemId || input.slug)) throw new UserError("Constitution applies to the project; omit the feature and slug.");
        if (dispatching) throw new UserError("This request is being sent. Check chat before trying again.", 409);
        dispatching = true;
        let runId, sent = false;
        try {
            await skill(step);
            const before = await items();
            const item = step.project ? "project" : input.itemId ?? "__new__";
            if (!step.project && item !== "__new__" && !before.some((entry) => entry.id === item)) throw new UserError("Select an existing workflow or choose New.");
            if (!step.project && item === "__new__" && !step.first && phases.some((phase) => phase.first)) throw new UserError("Select an existing workflow or run Specify to create one first.");
            const slug = item === "__new__" && config.userProvidesSlug
                ? (input.slug === undefined ? state.slug : input.slug) : null;
            const name = item === "__new__" ? (input.name === undefined ? state.name ?? "" : input.name).trim() : "";
            if (slug && !validSlug(slug)) throw new UserError("Use a workflow slug with lowercase letters, numbers, and single hyphens, not a reserved filename.");
            runId = randomUUID();
            const record = { runId, instanceId, phase: step.id, item, args: input.args,
                slug: slug || null, name,
                before: before.map((entry) => entry.id), sessionId: session.sessionId,
                messageId: null, status: "Request sent", artifact: null, artifacts: [], error: null };
            await update((next) => {
                next.runs.push(record);
                next.drafts[JSON.stringify([item, step.id])] = input.args;
                if (item === "__new__" && next.selected === "__new__" && slug && next.slug !== slug) {
                    next.slug = slug;
                    next.revision++;
                }
            });
            liveRuns.add(runId);
            const context = step.project ? "Project-scoped Constitution." : item === "__new__"
                ? `Create a new feature using the installed skill's normal scripts.${slug ? ` Requested short name: ${JSON.stringify(slug)}.` : ""}
Before writing workflow artifacts, invoke report_workflow_slug on canvas instance ${JSON.stringify(instanceId)} with {phaseRunId:${JSON.stringify(runId)},slug:<actual created workflow directory name>}. If the installed scripts add a numeric prefix, report the actual directory name, including that prefix, as soon as it is known. Use the returned resolved paths for this workflow. The path templates below describe expected outputs, not permission to override an installed skill's explicit output location; surface a conflict instead of silently writing elsewhere.`
                : `Use the existing feature directory ${JSON.stringify(item)} in this checkout. Set SPECIFY_FEATURE to its directory name for the skill's scripts; do not switch branches or use another feature.`;
            const instructions = `\n\nCanvas execution context: ${context}
Run the installed skill above in the current checkout. Do not run init or install packages.
Workflow output paths: ${JSON.stringify(phases.filter((phase) => !step.project || phase.project).map((phase) => ({ phase: phase.id,
                outputs: phase.outputs.map((path) => path.replace("<slug>", item === "__new__" ? slug || "<slug>" : item.split("/").at(-1))) })))}
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
        if (phaseFor(run.phase).project || (run.item !== "__new__" && !run.confirmedSlug)) throw new UserError("Only a new workflow can report a directory slug.");
        if (!validSlug(input.slug)) throw new UserError("Use a workflow slug with lowercase letters, numbers, and single hyphens, not a reserved filename.");
        if (run.confirmedSlug && run.slug !== input.slug) throw new UserError("This run already reported a different workflow directory.");
        if (run.before.some((item) => item.split("/").at(-1) === input.slug)) throw new UserError("That workflow already exists. Select it instead of creating a new workflow.");
        const created = (await items()).find((item) => item.slug === input.slug
            && !run.before.includes(item.id) && (run.item === "__new__" || run.item === item.id));
        if (!created) throw new UserError("The reported workflow directory does not exist yet. Create it before reporting its name.");
        await update((next) => {
            Object.assign(next.runs.find((entry) => entry.runId === run.runId),
                { item: created.id, slug: input.slug, confirmedSlug: true });
            if (run.autopilotId && next.autopilot?.id === run.autopilotId) next.autopilot.item = created.id;
            next.drafts[JSON.stringify([created.id, run.phase])] = run.args;
            if (run.name) (next.names ??= {})[created.id] = run.name;
            if (next.selected === "__new__") {
                next.selected = created.id;
                next.slug = input.slug;
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
            if (!owner || (run.item !== "__new__" && run.item !== owner.id)
                || (run.item === "__new__" && (run.before.includes(owner.id)
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
            if (item && target.item === "__new__") {
                if (target.name) (next.names ??= {})[item] = target.name;
                target.item = item;
                next.drafts[JSON.stringify([item, target.phase])] = target.args;
                if (next.selected === "__new__") { next.selected = item; next.slug = item.split("/").at(-1); next.revision++; }
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
                if (run.autopilotId) continue;
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
                run.error = response.error ?? null;
            }
            const automation = next.autopilot;
            if (automation?.sessionId === session.sessionId && automation.messageId
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
        if (state.runs.some((entry) => entry.sessionId === session.sessionId && entry.messageId && !["Completed", "Failed"].includes(entry.status))) {
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
            if (input.revision !== state.revision) throw new UserError("Canvas state changed. Refresh before deleting.", 409);
            const item = (await items()).find((entry) => entry.id === input.itemId);
            if (!item || input.confirmation !== item.slug) throw new UserError("Workflow or confirmation does not match the current directory.", 409);
            if (state.autopilot?.item === item.id
                && ["Request sent", "Running", "Finishing"].includes(state.autopilot.status)
                && liveRuns.has(state.autopilot.id)) {
                throw new UserError("Stop Autopilot before deleting this workflow.", 409);
            }
            if (state.runs.some((run) => (run.item === item.id
                || (run.item === "__new__" && !run.before.includes(item.id)))
                && !["Completed", "Failed"].includes(run.status))) {
                throw new UserError("This workflow has an unfinished phase. Wait for it to finish before deleting.", 409);
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
        const path = await outputPath(phaseFor(input.phase), input.itemId);
        if (!path) throw new UserError("No output folder is available. Select a workflow or run the phase first.");
        let folder;
        try { folder = posix.dirname(path) === "." ? await realpath(cwd) : await confined(cwd, posix.dirname(path)); }
        catch (error) {
            if (error.code === "ENOENT") throw new UserError("The output folder does not exist yet. Run the phase, then try again.", 404);
            throw error;
        }
        const [command, args] = process.platform === "win32" ? ["explorer.exe", [folder]]
            : process.platform === "darwin" ? ["open", [folder]] : ["xdg-open", [folder]];
        await new Promise((resolve, reject) => {
            const child = spawn(command, args, { stdio: "ignore" });
            child.once("error", reject);
            child.once("spawn", resolve);
        });
        return { message: "Opened the output folder." };
    }
    return { snapshot, refresh, save, saveValue, run, startAutopilot, stopAutopilot, reportAutopilotStep,
        report, reportSlug, artifact, reveal, deleteWorkflow,
        setupStart: setup.start, setupConfirm: setup.confirm, setupStatus: setup.status,
        close() { if (closed) return; closed = true; subscriptions.forEach((unsubscribe) => unsubscribe?.()); } };
}
