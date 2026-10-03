import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { readHandoff } from "./handoff.mjs";
import { SAVE_REQUEST_LIMIT, saveDesignerSettings } from "./settings.mjs";
import { freezeGeneration } from "./generation.mjs";

export function shellHtml() {
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Canvas Designer</title>
<style>
    body { margin: 0; background: var(--background-color-default, #fff);
        color: var(--text-color-default, #1f2328);
        font: var(--text-body-medium, 14px)/var(--leading-body-medium, 20px)
            var(--font-sans, system-ui, sans-serif); }
    main { padding: 28px; max-width: 560px; }
    h1 { font-size: var(--text-title-large, 26px); line-height: var(--leading-title-large, 32px); }
    p { color: var(--text-color-muted, #59636e); }
</style>
</head>
<body><main><h1>Canvas Designer</h1>
<p>No Wizard handoff is attached yet.</p>
<p>Launch Designer from the Wizard to prepare a project and load its settings pages.</p>
</main></body></html>`;
}

const ASSETS = {
    "/": ["index.html", "text/html"],
    "/ui/styles.css": ["styles.css", "text/css"],
    "/ui/app.js": ["app.js", "text/javascript"],
};
const GENERATE_SKILL = "speckit-extension-canvas-design-generate";
const GENERATE_UNAVAILABLE = "Canvas Design does not provide Generate in this session. Launch a new Designer session using extension-canvas-design v0.1.5 or the current local source.";

async function hasGenerateSkill(project) {
    try {
        return (await stat(join(project, ".github", "skills", GENERATE_SKILL, "SKILL.md"))).isFile();
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
}

export async function startShell(handoff = null, model = null, { project, workspace, session } = {}) {
    if (handoff && !model) throw new Error("Designer pages must be validated before opening");
    if (handoff && (typeof workspace !== "string" || !workspace.trim())) {
        throw new Error("Designer session workspace is required to save settings");
    }
    const assets = handoff
        ? new Map(await Promise.all(Object.entries(ASSETS).map(async ([path, [file, type]]) =>
            [path, { type, content: await readFile(new URL(`./ui/${file}`, import.meta.url), "utf8") }])))
        : new Map([["/", { type: "text/html", content: shellHtml() }]]);
    const token = randomBytes(24).toString("hex");
    const skillAvailable = project ? await hasGenerateSkill(project) : false;
    const generationError = handoff?.workflow?.installed && project && !skillAvailable
        ? GENERATE_UNAVAILABLE : null;
    const state = () => ({ ...model, handoffId: handoff?.handoffId,
        generationAvailable: !!handoff?.workflow?.installed && !!session?.send
            && !!project && skillAvailable,
        generationError });
    let generating = false;
    let queued = false;
    const server = createServer(async (req, res) => {
        let url;
        try {
            url = new URL(req.url, "http://127.0.0.1");
        } catch {
            res.writeHead(404).end();
            return;
        }
        const supplied = url.searchParams.get("token");
        const actual = typeof supplied === "string" ? Buffer.from(supplied) : Buffer.alloc(0);
        const expected = Buffer.from(token);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
            res.writeHead(404).end();
            return;
        }
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (handoff && workspace && req.method === "POST" && url.pathname === "/api/save") {
            const sendError = (status, message) => {
                res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: message }));
            };
            if (!req.headers["content-type"]?.startsWith("application/json")) {
                sendError(415, "Expected application/json");
                return;
            }
            try {
                const chunks = [];
                let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > SAVE_REQUEST_LIMIT) {
                        sendError(413, "Designer save request is too large");
                        return;
                    }
                    chunks.push(chunk);
                }
                const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                const currentHandoff = await readHandoff(workspace, handoff.handoffId);
                if (currentHandoff.sourceFingerprint !== handoff.sourceFingerprint) {
                    throw new Error("Designer handoff changed; reopen before saving");
                }
                model = await saveDesignerSettings(workspace, handoff, model, request);
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(state()));
            } catch (error) {
                const invalid = error instanceof SyntaxError || /Invalid Designer|unexpected or missing fields/.test(error.message);
                const conflict = [
                    "Designer handoff changed; reopen before saving",
                    "Designer settings changed elsewhere. Copy any unsaved edits, then close and reopen Designer before saving.",
                    "Saved Designer settings do not match the current handoff or pages",
                ].includes(error.message);
                const oversized = error.message === "Designer settings exceed the size limit";
                sendError(conflict ? 409 : oversized ? 413 : invalid ? 422 : 500, error.message);
            }
            return;
        }
        if (handoff && req.method === "POST" && url.pathname === "/api/generate") {
            if (!session?.send || !project || !workspace) {
                res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" })
                    .end(JSON.stringify({ error: "Generation dispatch is unavailable" }));
                return;
            }
            if (generating || queued) {
                res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" })
                    .end(JSON.stringify({ error: "Generation is already queued for this Designer panel" }));
                return;
            }
            generating = true;
            try {
                if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${server.address().port}`) {
                    throw new Error("Untrusted generation request origin");
                }
                if (!req.headers["content-type"]?.startsWith("application/json")) {
                    throw new Error("Expected JSON Essentials values");
                }
                const chunks = [];
                let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 16 * 1024) throw new Error("Generation request exceeds 16KB");
                    chunks.push(chunk);
                }
                const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (!input || typeof input !== "object" || Array.isArray(input)
                    || Object.keys(input).some((key) => !["revision", "values"].includes(key))
                    || input.revision !== model.revision) throw new Error("Designer settings changed; reload and retry");
                if (!await hasGenerateSkill(project)) {
                    res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" })
                        .end(JSON.stringify({ error: GENERATE_UNAVAILABLE }));
                    return;
                }
                const result = await freezeGeneration({ model, values: input.values, handoff, project, workspace });
                try {
                    await session.send({ prompt: `Invoke the installed speckit-extension-canvas-design-generate skill with handoffId "${handoff.handoffId}" and requestId "${result.requestId}". Follow its entire composed command. The prepared request is immutable; do not change settings or substitute another checkout. Report publication or the exact failure to the user.` });
                } catch (cause) {
                    throw new Error(`Generation dispatch failed: ${cause.message}`, { cause });
                }
                queued = true;
                res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" })
                    .end(JSON.stringify(result));
            } catch (error) {
                const status = error.code ? 500 : error.message.startsWith("Generation dispatch failed:") ? 503 : 422;
                res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
                    .end(JSON.stringify({ error: error.message }));
            } finally {
                generating = false;
            }
            return;
        }
        if (req.method !== "GET") { res.writeHead(404).end(); return; }
        if (handoff && url.pathname === "/api/state") {
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(state()));
        } else if (assets.has(url.pathname)) {
            const { type, content } = assets.get(url.pathname);
            res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
            res.end(url.pathname === "/" ? content.replaceAll("__TOKEN__", token) : content);
        } else {
            res.writeHead(404).end();
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return {
        url: `http://127.0.0.1:${server.address().port}/?token=${token}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeAllConnections();
        }),
    };
}
