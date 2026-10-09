import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { readHandoff } from "./handoff.mjs";
import { startShell } from "./server.mjs";
import { assertPageCommand, loadResolvedDesignerPages } from "./pages.mjs";
import { previewModel } from "./preview.mjs";
import { freshDesignerSettings } from "./settings.mjs";
import { designerOpenInputSchema, validateDesignerOpenInput } from "./contracts/host-open.mjs";
import { loadLastOpen, replaceLastOpen } from "./open-state.mjs";
import { fetchSessionRepoPath } from "../speckit-wizard-canvas/env/workspace.mjs";

const servers = new Map();
const opening = new Map();
let inventoryQueue = Promise.resolve();
let checkout;

async function withInventoryLock(action) {
    const previous = inventoryQueue;
    let release;
    inventoryQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
        return await action();
    } finally {
        release();
    }
}

async function ensureDependencies() {
    const marker = new URL("./node_modules/es-module-lexer/package.json", import.meta.url);
    try {
        if ((await stat(marker)).isFile()) return;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    throw new Error("Designer requires es-module-lexer. Open Spec Kit Wizard and use its environment setup to install the missing dependency, or run npm ci --omit=dev in the Designer extension folder.");
}

async function getCheckout() {
    if (!checkout) {
        const path = await fetchSessionRepoPath(session);
        if (!path || !isAbsolute(path)) {
            throw new Error("Designer session checkout is unavailable in session metadata");
        }
        checkout = path;
    }
    return checkout;
}

async function reloadSessionSkills() {
    if (!session.rpc?.skills?.reload) throw new Error("Session skill reload is unavailable");
    const diagnostics = await session.rpc.skills.reload();
    if (!Array.isArray(diagnostics?.errors) || !Array.isArray(diagnostics?.warnings)
        || [...diagnostics.errors, ...diagnostics.warnings].some((message) => typeof message !== "string")) {
        throw new Error("Invalid session skill reload diagnostics");
    }
    for (const warning of diagnostics.warnings) {
        await session.log(warning, { level: "warning" });
    }
    if (diagnostics.errors.length) {
        throw new Error(`Session skill reload failed: ${diagnostics.errors.join("; ")}`);
    }
    return diagnostics;
}

const session = await joinSession({
    tools: [{
        name: "speckit_designer_reload_skills",
        description: "Reload this session's skills after package installation. Reports reload failures; does not install anything.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        handler: async () => JSON.stringify(await reloadSessionSkills()),
    }],
    canvases: [createCanvas({
        id: "speckit-canvas-designer",
        displayName: "Spec Kit Canvas Designer",
        description: "Open Designer with the complete preset-resolved page set or a nonpersistent UX preview.",
        inputSchema: designerOpenInputSchema,
        open: async (ctx) => {
            if (opening.has(ctx.instanceId)) {
                throw new CanvasError("designer_open_failed", "Designer is already opening this panel");
            }
            const token = Symbol();
            opening.set(ctx.instanceId, token);
            try {
                const previous = servers.get(ctx.instanceId);
                const requested = validateDesignerOpenInput(ctx.input);
                const restored = !requested.preview && requested.handoffId === undefined
                    ? await withInventoryLock(() => loadLastOpen(session.workspacePath)) : null;
                const { preview, handoffId, pages, templates } = restored ?? requested;
                if (!preview) await ensureDependencies();
                let handoff = null;
                let model = preview ? previewModel() : null;
                if (handoffId !== undefined) {
                    try {
                        handoff = await readHandoff(session.workspacePath, handoffId);
                    } catch (error) {
                        throw new CanvasError("designer_handoff_invalid", error.message);
                    }
                    const project = await getCheckout();
                    await assertPageCommand(project);
                    model = await loadResolvedDesignerPages(handoff, project, pages, templates);
                    model = await freshDesignerSettings(session.workspacePath, handoff, model);
                }
                const next = await startShell(handoff, model, handoff
                    ? { project: await getCheckout(), workspace: session.workspacePath, session }
                    : { preview: preview === true });
                try {
                    return await withInventoryLock(async () => {
                        const assertOpen = () => {
                            if (opening.get(ctx.instanceId) !== token) {
                                throw new CanvasError("designer_open_failed",
                                    "Designer panel closed while opening");
                            }
                        };
                        const prepare = async () => {
                            assertOpen();
                            if (previous) {
                                if (servers.get(ctx.instanceId) !== previous) {
                                    throw new CanvasError("designer_open_failed",
                                        "Designer panel closed while opening");
                                }
                                servers.delete(ctx.instanceId);
                                try {
                                    await previous.close();
                                } catch (error) {
                                    if (opening.get(ctx.instanceId) === token
                                        && !servers.has(ctx.instanceId)) {
                                        servers.set(ctx.instanceId, previous);
                                    }
                                    throw error;
                                }
                            }
                        };
                        const install = () => {
                            assertOpen();
                            servers.set(ctx.instanceId, next);
                            return { title: "Spec Kit Canvas Designer", url: next.url };
                        };
                        assertOpen();
                        if (handoff && !restored) {
                            return replaceLastOpen(session.workspacePath,
                                { handoffId, pages, templates }, prepare, install);
                        }
                        await prepare();
                        return install();
                    });
                } catch (error) {
                    await next.close();
                    throw error;
                }
            } catch (error) {
                if (error instanceof CanvasError) throw error;
                throw new CanvasError("designer_open_failed", error.message);
            } finally {
                if (opening.get(ctx.instanceId) === token) opening.delete(ctx.instanceId);
            }
        },
        onClose: async ({ instanceId }) => {
            opening.delete(instanceId);
            const entry = servers.get(instanceId);
            if (!entry) return;
            servers.delete(instanceId);
            await entry.close();
        },
    })],
});
