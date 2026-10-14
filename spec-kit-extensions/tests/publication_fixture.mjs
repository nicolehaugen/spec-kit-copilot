import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { freezeGeneration } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/generation.mjs";
import { materialize } from "../extension-canvas-design/scripts/generate.mjs";
import { addWorkflowFixture } from "./workflow_fixture.mjs";
import { addDesignerAdapterFixture } from "./designer_adapter_fixture.mjs";

export async function publicationFixture(t) {
    const root = await mkdtemp(join(process.cwd(), ".publication-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const project = join(root, "project"), workspace = join(root, "workspace");
    const model = { revision: "publication-test", settingsRevision: 1,
        pages: [{ page: "designer-essentials", fields: [
            { id: "canvas.id" }, { id: "canvas.displayName" },
        ] }],
        constraints: {
            "canvas.id": { type: "string", minLength: 1, maxLength: 100,
                pattern: "^[a-z0-9][a-z0-9-]*$" },
            "canvas.displayName": { type: "string", minLength: 1, maxLength: 120 },
        } };
    const handoff = { schemaVersion: 1, handoffId: "publication-handoff",
        selections: { presets: [], extensions: [], bundles: [] },
        workflow: { selectedPhases: ["specify"],
            installed: { presets: [], extensions: [], bundles: [] } } };
    handoff.sourceFingerprint = createHash("sha256").update(JSON.stringify({
        workflow: handoff.workflow, selections: handoff.selections })).digest("hex");
    await mkdir(project);
    await mkdir(workspace);
    await addDesignerAdapterFixture(project, model);
    await addWorkflowFixture(project, model);
    const folder = join(workspace, "speckit-canvas-designer", "handoffs", handoff.handoffId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "handoff.json"), JSON.stringify(handoff));
    const values = { "canvas.id": "publication-test", "canvas.displayName": "First" };
    const freeze = (title = "First", replaceExisting = false) => freezeGeneration({
        model, handoff, project, workspace, replaceExisting,
        values: { ...values, "canvas.displayName": title } });
    const first = await freeze();
    const source = join(project, first.target), runtime = join(project, first.publicationTarget);
    const generate = (request = first, prior = false) =>
        materialize(project, workspace, handoff.handoffId, request.requestId, prior);
    const requestFolder = (id) => join(folder, "generations", id);
    const readRequest = async (id = first.requestId) =>
        JSON.parse(await readFile(join(requestFolder(id), "request.json"), "utf8"));
    return { root, project, workspace, handoff, model, values, folder, first, source, runtime,
        freeze, generate, requestFolder, readRequest };
}

export async function installPublicationScripts(project) {
    const installed = join(project, ".specify", "extensions", "extension-canvas-design");
    for (const folder of ["scripts", "generated-scaffold"]) {
        await cp(new URL(`../extension-canvas-design/${folder}/`, import.meta.url),
            join(installed, folder), { recursive: true });
    }
}
