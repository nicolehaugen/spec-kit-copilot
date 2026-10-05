import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function addWorkflowFixture(project, model) {
    const directory = join(project, ".specify", "templates");
    await mkdir(directory, { recursive: true });
    const assets = [
        ["generated-workflow", "generated.workflow-page-definition", "workflow.json"],
        ["generated-pipeline", "generated.pipeline-renderer", "generated-pipeline.mjs"],
    ];
    model.templates = (model.templates ?? []).filter((entry) =>
        !assets.some(([name]) => name === entry.name));
    for (const [name, kind, filename] of assets) {
        const bytes = await readFile(new URL(`../extension-canvas-design/generated/pages/${filename}`, import.meta.url));
        const path = join(directory, filename);
        await writeFile(path, bytes);
        model.templates.push({ name, kind, sourceId: "extension:extension-canvas-design",
            strategy: "replace", path: await realpath(path),
            hash: createHash("sha256").update(bytes).digest("hex") });
    }
    model.workflowPage = { name: "generated-workflow",
        ...JSON.parse(await readFile(new URL("../extension-canvas-design/generated/pages/workflow.json", import.meta.url))) };
    return model;
}
