import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

test("closing the last started panel while another opens retains the shared runtime", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "generated-lifecycle-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = join(root, "generated");
    await cp(new URL("../extension-canvas-design/templates/generated-canvas/", import.meta.url),
        target, { recursive: true });
    await writeFile(join(target, "canvas-config.json"), JSON.stringify({
        schemaVersion: 1, userProvidesSlug: false,
        canvas: { id: "lifecycle", displayName: "Lifecycle",
            description: "Test canvas", workflowListName: "Workflows" },
        phases: ["specify"],
        phaseOutputs: { specify: { expectsArtifact: true, outputPath: "specs/<slug>/spec.md" } },
        phaseArtifacts: {}, installed: { presets: [], extensions: [], bundles: [] },
    }));
    const sdk = join(target, "node_modules", "@github", "copilot-sdk");
    await mkdir(sdk, { recursive: true });
    await writeFile(join(sdk, "package.json"), JSON.stringify({
        name: "@github/copilot-sdk", type: "module", exports: { "./extension": "./extension.mjs" },
    }));
    await writeFile(join(sdk, "extension.mjs"), `
        export const createCanvas = (options) => options;
        export async function joinSession({ canvases }) {
            globalThis.__lifecycleCanvas = canvases[0];
            return { sessionId: "lifecycle", workspacePath: ${JSON.stringify(root)},
                rpc: { metadata: { snapshot: async () => ({ workingDirectory: ${JSON.stringify(root)} }) } },
                on: () => () => {}, getEvents: async () => [], log: async () => {} };
        }
    `);
    await import(pathToFileURL(join(target, "extension.mjs")).href);
    const canvas = globalThis.__lifecycleCanvas;
    delete globalThis.__lifecycleCanvas;
    const first = await canvas.open({ instanceId: "first" });
    try {
        const opening = canvas.open({ instanceId: "second" });
        await canvas.onClose({ instanceId: "first" });
        const second = await opening;
        try {
            assert.match(await (await fetch(second.url)).text(), /Lifecycle/);
            const action = canvas.actions.find((entry) => entry.name === "report_phase_artifact");
            await assert.rejects(async () => action.handler({ instanceId: "second",
                input: { phaseRunId: "missing", path: "specs/missing/spec.md" } }),
            /Unknown or stale phase reporting request/);
        } finally {
            await canvas.onClose({ instanceId: "second" });
        }
    } finally {
        await canvas.onClose({ instanceId: "first" });
    }
    assert.match(first.url, /^http:/);
});
