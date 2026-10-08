import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { readHandoff } from "./handoff.mjs";
import { startShell } from "./server.mjs";
import { assertPageCommand, loadResolvedDesignerPages } from "./pages.mjs";
import { loadDesignerSettings } from "./settings.mjs";
import { designerOpenInputSchema, validateDesignerOpenInput } from "./contracts/host-open.mjs";
import { fetchSessionRepoPath } from "../speckit-wizard-canvas/env/workspace.mjs";

const servers = new Map();
const opening = new Map();
let checkout;

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
        description: "Open Designer with the complete preset-resolved page set.",
        inputSchema: designerOpenInputSchema,
        open: async (ctx) => {
            if (opening.has(ctx.instanceId)) {
                throw new CanvasError("designer_open_failed", "Designer is already opening this panel");
            }
            const token = Symbol();
            opening.set(ctx.instanceId, token);
            try {
                const previous = servers.get(ctx.instanceId);
                if (previous) {
                    servers.delete(ctx.instanceId);
                    await previous.close();
                }
                await ensureDependencies();
                const { handoffId, pages, templates } = validateDesignerOpenInput(ctx.input);
                let handoff = null;
                let model = null;
                if (handoffId !== undefined) {
                    try {
                        handoff = await readHandoff(session.workspacePath, handoffId);
                    } catch (error) {
                        throw new CanvasError("designer_handoff_invalid", error.message);
                    }
                    const project = await getCheckout();
                    await assertPageCommand(project);
                    model = await loadResolvedDesignerPages(handoff, project, pages, templates);
                    model = await loadDesignerSettings(session.workspacePath, handoff, model);
                }
                const next = await startShell(handoff, model, handoff
                    ? { project: await getCheckout(), workspace: session.workspacePath, session }
                    : {});
                if (opening.get(ctx.instanceId) !== token) {
                    await next.close();
                    throw new CanvasError("designer_open_failed", "Designer panel closed while opening");
                }
                servers.set(ctx.instanceId, next);
                return { title: "Spec Kit Canvas Designer", url: next.url };
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
