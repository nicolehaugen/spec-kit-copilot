import { createServer } from "node:http";

// A resume may await an open callback before joinSession returns. Return a
// loading URL immediately rather than awaiting that same registration promise.
export function createSessionStartup(title = "Spec Kit Canvas Designer") {
    let initialized = false;
    let failure = null;
    let release;
    const ready = new Promise((resolve) => { release = resolve; });
    const panels = new Map();
    return {
        ready() { initialized = true; release(); },
        fail(error) { failure = error; initialized = true; release(); },
        async open(ctx, open, closed) {
            if (initialized) {
                if (failure) throw failure;
                return open();
            }
            if (panels.has(ctx.instanceId)) throw new Error("Designer panel is already initializing");
            const panel = { cancelled: false, result: null, error: null };
            panel.server = createServer((_request, response) => {
                response.setHeader("Cache-Control", "no-store");
                response.setHeader("Content-Security-Policy", "default-src 'none'");
                if (panel.result) {
                    response.writeHead(302, { Location: panel.result.url }).end();
                } else {
                    const text = panel.error ? `${title} startup failed: ${panel.error.message}` : `Starting ${title}...`;
                    const escaped = text.replace(/[&<>"']/g, (character) =>
                        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
                    response.writeHead(panel.error ? 500 : 200, { "Content-Type": "text/html; charset=utf-8" })
                        .end(`<!doctype html><html><head>${panel.error ? "" : '<meta http-equiv="refresh" content="0.5">'}</head><body><p>${escaped}</p></body></html>`);
                }
            });
            await new Promise((resolve, reject) => {
                panel.server.once("error", reject);
                panel.server.listen(0, "127.0.0.1", resolve);
            });
            panels.set(ctx.instanceId, panel);
            void ready.then(async () => {
                if (panel.cancelled) return;
                if (failure) throw failure;
                const result = await open();
                if (panel.cancelled) await closed();
                else panel.result = result;
            }).catch((error) => {
                panel.error = error;
                console.error(`${title} startup: ${error.message}`);
            });
            return { title,
                url: `http://127.0.0.1:${panel.server.address().port}/` };
        },
        async close(instanceId) {
            const panel = panels.get(instanceId);
            if (!panel) return;
            panel.cancelled = true;
            panels.delete(instanceId);
            await new Promise((resolve, reject) => {
                panel.server.close((error) => error ? reject(error) : resolve());
                panel.server.closeAllConnections();
            });
        },
    };
}
