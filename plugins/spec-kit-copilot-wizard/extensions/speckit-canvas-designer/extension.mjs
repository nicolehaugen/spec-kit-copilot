import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import { isAbsolute } from "node:path";
import { readHandoff, validateHandoffId } from "./handoff.mjs";
import { startShell } from "./server.mjs";
import { assertPageCommand, loadDesignerPages, PAGE_NAME, storeDesignerPages } from "./pages.mjs";
import { fetchSessionRepoPath } from "../speckit-wizard-canvas/env/workspace.mjs";

const servers = new Map();
const writing = new Set();
const handoffIdSchema = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" };
let checkout;

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

async function acceptPages(ctx) {
    const input = ctx.input;
    let id, entry, acquired = false;
    try {
        id = validateHandoffId(input.handoffId);
        entry = servers.get(ctx.instanceId);
        if (!entry || entry.handoffId !== id) {
            throw new Error("Open this Designer handoff before loading its pages");
        }
        if (writing.has(id)) throw new Error("Designer is already applying a page load");
        const handoff = await readHandoff(session.workspacePath, id);
        if (writing.has(id)) throw new Error("Designer is already applying a page load");
        writing.add(id);
        acquired = true;
        const project = await getCheckout();
        await assertPageCommand(project);
        const model = await storeDesignerPages(handoff, session.workspacePath, project, input.pages,
            () => servers.get(ctx.instanceId) === entry);
        for (const panel of servers.values()) {
            if (panel.handoffId === id) panel.update(model, { pending: false, error: "" });
        }
        return { loaded: true, handoffId: id,
            pages: model.pages.map((page) => ({ name: page.id, title: page.title })),
            revision: model.revision };
    } catch (error) {
        if (entry?.handoffId === id) entry.update(null, { pending: false, error: error.message });
        throw new CanvasError("designer_page_load_failed", error.message);
    } finally {
        if (acquired) writing.delete(id);
    }
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
        description: "Open Designer after resolving its pages, then load them through the canvas action.",
        inputSchema: {
            type: "object", additionalProperties: false,
            properties: { handoffId: handoffIdSchema },
        },
        actions: [{
            name: "loadPages",
            description: "Validate and load the complete preset-resolved page set for this open handoff.",
            inputSchema: {
                type: "object", additionalProperties: false, required: ["handoffId", "pages"],
                properties: {
                    handoffId: handoffIdSchema,
                    pages: { type: "array", minItems: 1, maxItems: 100, items: {
                        type: "object", additionalProperties: false, required: ["name", "path"],
                        properties: { name: { type: "string", pattern: PAGE_NAME },
                            path: { type: "string", minLength: 1, maxLength: 4096 } },
                    } },
                },
            },
            handler: acceptPages,
        }],
        open: async (ctx) => {
            const handoffId = ctx.input?.handoffId;
            let handoff = null;
            if (handoffId !== undefined) {
                try {
                    handoff = await readHandoff(session.workspacePath, handoffId);
                } catch (error) {
                    throw new CanvasError("designer_handoff_invalid", error.message);
                }
            }
            const previous = servers.get(ctx.instanceId);
            if (previous && previous.handoffId === handoffId) {
                return { title: "Spec Kit Canvas Designer", url: previous.url };
            }
            try {
                let model = null;
                if (handoff) {
                    const project = await getCheckout();
                    await assertPageCommand(project);
                    model = await loadDesignerPages(handoff, session.workspacePath, project,
                        { allowMissing: true });
                }
                const next = await startShell(handoff, model);
                servers.set(ctx.instanceId, { ...next, handoffId });
                if (previous) await previous.close();
                return { title: "Spec Kit Canvas Designer", url: next.url };
            } catch (error) {
                throw new CanvasError("designer_open_failed", error.message);
            }
        },
        onClose: async ({ instanceId }) => {
            const entry = servers.get(instanceId);
            if (!entry) return;
            servers.delete(instanceId);
            await entry.close();
        },
    })],
});
