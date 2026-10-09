import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { test, expect } from "./playwright.mjs";
import { addLoopbackSpecifyExtension, serveSpecifyPackages } from "./specify-packages.mjs";
import { startShell } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/server.mjs";
import { fingerprint, handoffDirectory } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/handoff.mjs";
import { loadResolvedDesignerPages } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/pages.mjs";
import { loadDesignerSettings } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/settings.mjs";
import { previewModel } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/preview.mjs";
import { materialize } from "../../spec-kit-extensions/extension-canvas-design/scripts/generate.mjs";
import { verifyComposition } from "../../spec-kit-extensions/extension-canvas-design/scripts/verify-launch.mjs";

const templateRoot = new URL("../../spec-kit-extensions/extension-canvas-design/designer-host/tabs/", import.meta.url);
const settingsRoot = new URL("../../spec-kit-extensions/extension-canvas-design/designer-host/essentials-settings/", import.meta.url);
const extensionRoot = new URL("../../spec-kit-extensions/extension-canvas-design/", import.meta.url);
const presetRoot = new URL("../../spec-kit-presets/copilot-canvas-design-test/", import.meta.url);
const billingRoot = new URL("../../spec-kit-presets/copilot-billing-canvas-test/", import.meta.url);
const riskRoot = new URL("../../spec-kit-presets/copilot-risk-matrix-test/", import.meta.url);
const scratchRoot = fileURLToPath(new URL("../../", import.meta.url));
const minimalRoot = new URL("../../spec-kit-presets/copilot-minimal-essentials-test/", import.meta.url);

async function materializeDevSkills(project) {
    // Preset installation regenerates skills; Specify refuses to overwrite dev-linked skill files.
    for (const command of ["load-page", "generate"]) {
        const path = join(project, ".github", "skills",
            `speckit-extension-canvas-design-${command}`, "SKILL.md");
        if (!(await lstat(path)).isSymbolicLink()) continue;
        const content = await readFile(path);
        await unlink(path);
        await writeFile(path, content);
    }
}

function scalarRegistrations(resolve) {
    return [
        ["shared-controls-text", "shared.control-definition"],
        ["designer-control-adapter-text", "designer.control-adapter"],
        ["generated-control-adapter-text", "generated.control-adapter"],
        ["shared-controls-checkbox", "shared.control-definition"],
        ["designer-control-adapter-checkbox", "designer.control-adapter"],
    ].map(([name, kind]) => ({ ...resolve(name), kind, strategy: "replace" }));
}

function workflowRegistrations(resolve) {
    return [
        ["generated-workflow", "generated.workflow-page-definition"],
        ["generated-workflow-page-adapter", "generated.workflow-page-adapter"],
        ["generated-phase-control", "generated.phase-control-definition"],
        ["generated-phase-adapter", "generated.phase-control-adapter"],
    ].map(([name, kind]) => ({ ...resolve(name), kind, strategy: "replace" }));
}

async function model(revision = "first") {
    const pages = [];
    for (const name of ["essentials", "outputs", "badges", "appearance"]) {
        const document = JSON.parse(await readFile(new URL(`${name}.json`, templateRoot), "utf8"));
        pages.push({ ...document, page: document.id });
    }
    for (const name of ["description", "workflow-heading"]) {
        const { field } = JSON.parse(await readFile(new URL(`${name}.json`, settingsRoot), "utf8"));
        pages[0].fields.push(field);
    }
    return {
        pages, revision,
        workflowPage: { name: "generated-workflow", adapter: "generated-workflow-page-adapter" },
        templates: [
            { name: "generated-workflow", kind: "generated.workflow-page-definition" },
            { name: "generated-phase-control", kind: "generated.phase-control-definition" },
            { name: "generated-phase-adapter", kind: "generated.phase-control-adapter" },
        ],
        constraints: {
            "canvas.id": { type: "string", minLength: 1, maxLength: 100,
                pattern: "^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9][a-z0-9-]*$", required: true },
            "canvas.displayName": { type: "string", minLength: 1, maxLength: 120,
                required: true },
            "canvas.description": { type: "string", maxLength: 240 },
            "canvas.workflowListName": { type: "string", maxLength: 80 },
        },
        values: { "canvas.id": "", "canvas.displayName": "", "canvas.description": "",
            "canvas.workflowListName": "" },
    };
}

async function prepareScalarAdapters(project, state) {
    for (const page of state.pages) {
        for (const field of page.fields ?? []) {
            if (state.constraints[field.id]) {
                field.validation = { ...state.constraints[field.id],
                    ...(field.id === "canvas.id" ? { forbiddenValues: [
                        "speckit-canvas-designer", "speckit-wizard", "speckit-canvas-generator",
                    ] } : {}) };
            }
        }
    }
    state.controls = [...(state.controls ?? []),
        ...await Promise.all(["stock-text", "stock-checkbox"].map(async (name) =>
            JSON.parse(await readFile(new URL(`shared-controls/${name}/control.json`, extensionRoot), "utf8"))))];
    state.adapters = { ...state.adapters, "stock.text": "designer-control-adapter-text",
        "stock.checkbox": "designer-control-adapter-checkbox" };
    state.templates ??= [];
    for (const [name, file] of [
        ["designer-control-adapter-text", "stock-text"],
        ["designer-control-adapter-checkbox", "stock-checkbox"],
    ]) {
        const path = join(project, ".specify", "extensions", "extension-canvas-design",
            "controls", file, "designer.mjs");
        await mkdir(join(project, ".specify", "extensions", "extension-canvas-design",
            "controls", file), { recursive: true });
        await copyFile(new URL(`shared-controls/${file}/designer.mjs`, extensionRoot), path);
        const bytes = await readFile(path);
        state.templates.push({ name, path,
            hash: createHash("sha256").update(bytes).digest("hex"), kind: "designer.control-adapter" });
    }
}

async function startPreparedShell(state) {
    const workspace = await mkdtemp(join(scratchRoot, ".designer-pages-e2e-"));
    const workflow = { selectedPhases: Object.keys(state.outputs ?? {}),
        ...(state.outputs ? { outputEvidence: state.outputs } : {}) };
    const selections = { presets: [], extensions: [], bundles: [] };
    const handoff = { schemaVersion: 1, handoffId: "test", workflow, selections,
        sourceFingerprint: fingerprint({ workflow, selections }) };
    const folder = handoffDirectory(workspace, handoff.handoffId);
    try {
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "handoff.json"), JSON.stringify(handoff));
        const project = join(workspace, "project");
        await prepareScalarAdapters(project, state);
        state.outputs ??= {};
        state.settingsRevision ??= 0;
        if (state.adapters?.["stock.image"]) {
            const path = join(project, ".specify", "extensions", "extension-canvas-design",
                "controls", "stock-image", "designer.mjs");
            await mkdir(join(project, ".specify", "extensions", "extension-canvas-design",
                "controls", "stock-image"), { recursive: true });
            await copyFile(new URL("shared-controls/stock-image/designer.mjs", extensionRoot), path);
            const bytes = await readFile(path);
            state.templates.push({ name: "designer-control-adapter-image", path,
                hash: createHash("sha256").update(bytes).digest("hex"), kind: "designer.control-adapter" });
        }
        if (state.badgeInputControls?.length) {
            const name = "designer-badge-input-stock-adapter";
            const path = join(project, ".specify", "extensions", "extension-canvas-design",
                "badge-input-controls", "stock", "designer.mjs");
            await mkdir(join(project, ".specify", "extensions", "extension-canvas-design",
                "badge-input-controls", "stock"), { recursive: true });
            await copyFile(new URL("designer-host/badge-input-controls/stock/designer.mjs",
                extensionRoot), path);
            const bytes = await readFile(path);
            state.templates.push({ name, path,
                hash: createHash("sha256").update(bytes).digest("hex"),
                kind: "designer.badge-input-adapter" });
            const evaluator = state.badgeRules[0].adapter;
            const evaluatorPath = join(project, ".specify", "extensions", "extension-canvas-design",
                "badges", "adapters", "content.mjs");
            await mkdir(join(project, ".specify", "extensions", "extension-canvas-design",
                "badges", "adapters"), { recursive: true });
            await copyFile(new URL("generated-host/badges/adapters/content.mjs",
                extensionRoot), evaluatorPath);
            const evaluatorBytes = await readFile(evaluatorPath);
            state.templates.push({ name: evaluator, path: evaluatorPath,
                hash: createHash("sha256").update(evaluatorBytes).digest("hex"),
                kind: "generated.badge-rule-adapter" });
        }
        const shell = await startShell(handoff, state, { workspace, project });
        return { url: shell.url, close: async () => {
            await shell.close();
            await rm(workspace, { recursive: true, force: true });
        } };
    } catch (error) {
        await rm(workspace, { recursive: true, force: true });
        throw error;
    }
}

async function openDesigner(page) {
    const shell = await startPreparedShell(await model());
    await page.goto(shell.url);
    return shell;
}

async function badgeState() {
    const state = await model();
    state.outputs = { specify: {
        outputs: ["specs/<slug>/spec.md"], view: "specs/<slug>/spec.md",
    } };
    state.badgeTypes = [{ id: "work-complete", rule: "work-complete",
        title: "Work complete", description: "Tracks a phase",
        defaultText: "Complete", defaultColor: "green", enabled: true }];
    state.badgeRules = [JSON.parse(await readFile(new URL(
        "generated-host/badges/rules/work-complete.json", extensionRoot), "utf8"))];
    const adapter = "designer-badge-input-stock-adapter";
    state.badgeInputControls = [{ rule: "work-complete", control: "stock.badge-inputs", adapter }];
    return state;
}

test("Badges editor persists a configured badge through the Designer save boundary", async ({ page }) => {
    const state = await badgeState();
    const shell = await startPreparedShell(state);
    try {
        await page.goto(shell.url);
        await page.getByRole("tab", { name: "Badges" }).click();
        await page.getByRole("button", { name: "+ Add badge" }).click();
        await page.getByRole("button", { name: "Work complete" }).click();
        await page.getByRole("button", { name: "Create badge" }).click();
        await expect(page.locator(".badge-row")).toContainText("Complete");
        await page.locator("#save-settings").click();
        await expect(page.locator("#action-message")).toContainText("Settings saved.");
        const url = new URL(shell.url);
        const response = await page.request.get(new URL(
            `/api/state?token=${url.searchParams.get("token")}`, url).href);
        expect(response.ok()).toBe(true);
        const saved = await response.json();
        expect(saved.persisted).toBe(true);
        expect(saved.badges).toHaveLength(1);
        expect(saved.badges[0]).toMatchObject({
            type: "work-complete", inputs: { phase: "specify",
                artifact: { phase: "specify", output: "specs/<slug>/spec.md" } },
            text: "Complete", showIn: ["workflow-list"],
        });
        await page.reload();
        await page.getByRole("tab", { name: "Badges" }).click();
        await expect(page.locator(".badge-row")).toContainText("Complete");
    } finally {
        await shell.close();
    }
});

test("a failed badge adapter import leaves other Designer pages available", async ({ page }) => {
    const shell = await startPreparedShell(await badgeState());
    try {
        await page.route("**/adapters/designer-badge-input-stock-adapter.mjs?*", (route) => route.abort());
        await page.goto(shell.url);
        await expect(page.getByRole("tab", { name: "Essentials" })).toBeVisible();
        await page.getByRole("tab", { name: "Badges" }).click();
        await page.getByRole("button", { name: "+ Add badge" }).click();
        await page.getByRole("button", { name: "Work complete" }).click();
        await expect(page.locator(".badge-editor")).toContainText("Could not load badge input control");
        await page.getByRole("tab", { name: "Essentials" }).click();
        await expect(page.getByRole("tab", { name: "Outputs" })).toBeVisible();
    } finally {
        await shell.close();
    }
});

test("sample preview initializes visible badge input defaults before creating badges", async ({ page }) => {
    const shell = await startShell(null, previewModel(), { preview: true });
    try {
        await page.goto(shell.url);
        await page.getByRole("button", { name: "+ Add badge" }).click();
        await page.getByRole("button", { name: "Phase run complete" }).click();
        await expect(page.locator(".badge-input-controls select")).toHaveValue("constitution");
        await page.getByRole("button", { name: "Create badge" }).click();
        await expect(page.locator(".badge-row")).toContainText("Phase run complete");
        await page.getByRole("button", { name: "+ Add badge" }).click();
        await page.getByRole("button", { name: "Work complete" }).click();
        await page.getByRole("button", { name: "Create badge" }).click();
        await expect(page.locator(".badge-row")).toHaveCount(2);
    } finally {
        await shell.close();
    }
});

test("empty and partial preset inventories keep Designer open with inline generation errors", async ({ page }) => {
    const empty = await model();
    empty.pages = [];
    empty.compositionErrors = ["Generated Workflow page is not registered"];
    const emptyShell = await startPreparedShell(empty);
    let partialShell;
    try {
        await page.goto(emptyShell.url);
        await expect(page.getByRole("heading", { name: "No Designer pages registered" })).toBeVisible();
        await expect(page.getByRole("tab")).toHaveCount(0);
        await expect(page.locator("#composition-error")).toContainText("Generated Workflow page is not registered");
        await expect(page.locator("#save-settings")).toBeDisabled();
        await expect(page.locator("#generate-canvas")).toBeDisabled();
        const saveUrl = new URL(`/api/save?token=${new URL(emptyShell.url).searchParams.get("token")}`,
            emptyShell.url);
        const refusedSave = await fetch(saveUrl, { method: "POST",
            headers: { "Content-Type": "application/json" }, body: "{}" });
        expect(refusedSave.status).toBe(422);
        expect((await refusedSave.json()).error).toContain("no pages are registered");

        const partial = await model();
        partial.pages = partial.pages.filter((entry) => entry.page !== "designer-badges");
        partial.compositionErrors = ["generated-workflow (from extension:extension-canvas-design):"
            + " missing or unreferenced presentation adapter generated-workflow-page-adapter"];
        partialShell = await startPreparedShell(partial);
        await page.goto(partialShell.url);
        await expect(page.getByRole("tab")).toHaveText(["Essentials", "Outputs", "Appearance"]);
        await expect(page.locator("#composition-error")).toContainText("generated-workflow-page-adapter");
        await expect(page.locator("#generation-error")).toContainText("generated-workflow-page-adapter");
        await page.getByRole("textbox", { name: "Title (required)" }).fill("Partial designer");
        await expect(page.locator("#save-settings")).toBeEnabled();
        await page.locator("#save-settings").click();
        await expect(page.locator("#action-message")).toHaveText("Settings saved.");
    } finally {
        await partialShell?.close();
        await emptyShell.close();
    }
});

test("unchanged minimal Essentials preset composes and opens a savable partial Designer", async ({ page }) => {
    test.setTimeout(150_000);
    const available = spawnSync("specify", ["--version"], { encoding: "utf8" });
    if (available.error?.code === "ENOENT") {
        test.skip(true, "Specify CLI is unavailable for the optional integration probe");
        return;
    }
    expect(available.status, available.stderr).toBe(0);
    const version = available.stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    expect(version, available.stdout).not.toBeNull();
    const [major, minor, patch] = version.slice(1).map(Number);
    expect(major > 1 || major === 1 && (minor > 0 || patch >= 7),
        available.stdout).toBe(true);
    const workspace = await mkdtemp(join(tmpdir(), "minimal-designer-e2e-"));
    const project = join(workspace, "project");
    let packages;
    const workflow = { selectedPhases: [] };
    const selections = { presets: [], extensions: [], bundles: [] };
    const handoff = { schemaVersion: 1, handoffId: "minimal-test", workflow, selections,
        sourceFingerprint: fingerprint({ workflow, selections }) };
    let shell;
    try {
        await mkdir(project);
        const run = (...args) => {
            const result = spawnSync("specify", args, { cwd: project, encoding: "utf8",
                timeout: 120000, env: { ...process.env, COLUMNS: "500" } });
            expect(result.error, `${args.join(" ")}: ${result.error}`).toBeUndefined();
            expect(result.status, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`).toBe(0);
        };
        run("init", "--here", "--force", "--non-interactive", "--ignore-agent-tools",
            "--integration", "copilot", "--integration-options=--skills",
            "--script", process.platform === "win32" ? "ps" : "sh");
        packages = await serveSpecifyPackages(workspace, {
            "extension-canvas-design": fileURLToPath(extensionRoot),
            "copilot-minimal-essentials-test": fileURLToPath(minimalRoot),
        });
        await addLoopbackSpecifyExtension(project, "extension-canvas-design",
            packages.url("extension-canvas-design"));
        const installed = await promisify(execFile)("specify",
            ["preset", "add", "--from", packages.url("copilot-minimal-essentials-test")],
            { cwd: project, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
        expect(installed.stdout).toContain("Copilot Minimal Essentials Test");
        const inventory = await verifyComposition(project).catch((error) => {
            const resolution = spawnSync("specify", ["preset", "resolve", "designer-essentials"],
                { cwd: project, encoding: "utf8", timeout: 10_000,
                    env: { ...process.env, COLUMNS: "8192", NO_COLOR: "1" } });
            throw new Error(`${error.message}; designer-essentials resolution: `
                + `${JSON.stringify(resolution.stdout)} ${JSON.stringify(resolution.stderr)}`,
            { cause: error });
        });
        expect(inventory.pages.map((entry) => entry.name)).toEqual(
            ["designer-essentials", "designer-artifacts", "designer-appearance"]);
        expect(inventory.templates.map((entry) => entry.name)).not.toContain("generated-workflow-page-adapter");
        const folder = handoffDirectory(workspace, handoff.handoffId);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "handoff.json"), JSON.stringify(handoff));
        const resolved = await loadResolvedDesignerPages(handoff, project, inventory.pages, inventory.templates);
        expect(resolved.compositionErrors.join(" ")).toContain("generated-workflow-page-adapter");
        shell = await startShell(handoff, await loadDesignerSettings(workspace, handoff, resolved),
            { project, workspace, session: { send: async () => { throw new Error("Generation was dispatched"); } } });
        await page.goto(shell.url);
        await expect(page.getByRole("tab")).toHaveText(["Essentials", "Outputs", "Appearance"]);
        await expect(page.locator("#composition-error")).toContainText("generated-workflow-page-adapter");
        await expect(page.locator("#composition-error")).toContainText("extension:extension-canvas-design");
        await expect(page.locator("#generate-canvas")).toBeDisabled();
        await page.getByRole("textbox", { name: "Canvas ID (required)" }).fill("minimal-canvas");
        await page.getByRole("textbox", { name: "Title (required)" }).fill("Minimal Canvas");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator("#action-message")).toHaveText("Settings saved.");
        const endpoint = new URL(`/api/generate?token=${new URL(shell.url).searchParams.get("token")}`, shell.url);
        const response = await fetch(endpoint, { method: "POST",
            headers: { "Content-Type": "application/json" }, body: "{}" });
        expect(response.status).toBe(422);
        expect((await response.json()).error).toContain("generated-workflow-page-adapter");
    } finally {
        await shell?.close();
        await packages?.close();
        await rm(workspace, { recursive: true, force: true });
    }
});

test("Outputs page keeps pipeline artifacts fixed and restores the viewer default after removing an addition", async ({ page }) => {
    const state = await model();
    state.outputs = {
        constitution: { outputs: [".specify/memory/constitution.md"],
            view: ".specify/memory/constitution.md" },
        specify: { outputs: ["specs/<slug>/spec.md", "specs/<slug>/research.md"],
            view: "specs/<slug>/spec.md" },
        "speckit.assess.intake": { outputs: [], view: null },
    };
    const shell = await startPreparedShell(state);
    try {
        await page.goto(shell.url);
        await page.getByRole("tab", { name: "Outputs" }).click();
        await expect(page.locator(".output-section")).toHaveCount(1);
        await expect(page.getByRole("combobox", { name: "Phase" })).toHaveValue("specify");
        await expect(page.getByRole("combobox", { name: "Phase" }).locator("option")).toHaveCount(2);
        await expect(page.getByText("This list doesn’t change the artifacts that a pipeline creates.")).toBeVisible();
        await expect(page.locator(".output-list").first().getByRole("radio")).toHaveCount(2);
        await expect(page.locator(".output-list").first().getByRole("button", { name: "Remove" })).toHaveCount(0);
        await expect(page.getByRole("radio", { name: "Open specs/<slug>/spec.md by default" })).toBeChecked();
        await page.getByRole("textbox", { name: "Artifact path" }).fill("draft.txt");
        await expect(page.getByRole("button", { name: "Add artifact" })).toBeDisabled();
        await expect(page.locator("#artifact-path-error")).toContainText("Markdown");
        for (const path of ["../outside.md", ".GitHub/private.md", "specs//bad.md",
            "specs/<slug>/CON.md", "reports/<slug>/../bad.md"]) {
            await page.getByRole("textbox", { name: "Artifact path" }).fill(path);
            await expect(page.getByRole("button", { name: "Add artifact" })).toBeDisabled();
            await expect(page.locator("#artifact-path-error")).toContainText("safe relative");
        }
        await expect(page.getByRole("textbox", { name: "Artifact path" }))
            .toHaveAttribute("aria-describedby", "artifact-path-error artifact-path-hint");
        await page.getByRole("textbox", { name: "Artifact path" }).fill("specs/<slug>/design-notes.md");
        await page.getByRole("button", { name: "Add artifact" }).click();
        await expect(page.locator(".output-list").last().getByRole("button", { name: "Remove" })).toHaveCount(1);
        await page.getByRole("radio", { name: "Open specs/<slug>/design-notes.md by default" }).check();
        await expect(page.getByRole("radio", { name: "Open specs/<slug>/design-notes.md by default" })).toBeChecked();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
        await page.getByRole("tab", { name: "Essentials" }).click();
        await page.getByRole("tab", { name: "Outputs" }).click();
        await expect(page.getByRole("radio", { name: "Open specs/<slug>/design-notes.md by default" })).toBeChecked();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByText("Settings saved.")).toBeVisible();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        await page.reload();
        await page.getByRole("tab", { name: "Outputs" }).click();
        await expect(page.getByRole("radio", { name: "Open specs/<slug>/design-notes.md by default" })).toBeChecked();
        await page.getByRole("button", { name: "Remove specs/<slug>/design-notes.md" }).click();
        await expect(page.getByRole("radio", { name: "Open specs/<slug>/spec.md by default" })).toBeChecked();
        await expect(page.locator(".output-list").last().getByRole("button", { name: "Remove" })).toHaveCount(0);
        await page.getByRole("combobox", { name: "Phase" }).selectOption("speckit.assess.intake");
        await expect(page.getByText("No pipeline artifacts for this phase.")).toBeVisible();
        await expect(page.getByText("will not have a View artifact button", { exact: false })).toBeVisible();
        await page.getByRole("textbox", { name: "Artifact path" }).fill("specs/<slug>/assessment.md");
        await page.getByRole("button", { name: "Add artifact" }).click();
        await expect(page.getByRole("radio", { name: "Open specs/<slug>/assessment.md by default" })).toBeChecked();
        await page.getByRole("button", { name: "Remove specs/<slug>/assessment.md" }).click();
        await expect(page.getByText("will not have a View artifact button", { exact: false })).toBeVisible();
        for (const name of ["first", "second"]) {
            await page.getByRole("textbox", { name: "Artifact path" }).fill(`specs/<slug>/${name}.md`);
            await page.getByRole("button", { name: "Add artifact" }).click();
        }
        await page.getByRole("radio", { name: "Open specs/<slug>/first.md by default" }).check();
        await page.getByRole("button", { name: "Remove specs/<slug>/first.md" }).click();
        await expect(page.getByRole("radio", { name: "Open specs/<slug>/second.md by default" })).toBeChecked();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByText("Settings saved.")).toBeVisible();
    } finally {
        await shell.close();
    }
});

test("Main page Logo upload explains rejection beside the picker and clears on replacement", async ({ page }) => {
    const state = await model();
    const { field } = JSON.parse(await readFile(new URL("main-page-logo.json", settingsRoot), "utf8"));
    const logoField = field;
    const { field: headerField } = JSON.parse(await readFile(new URL("header-logo.json", settingsRoot), "utf8"));
    state.pages[0].fields.push(headerField);
    state.constraints[headerField.id] = { type: "image", maxBytes: 32768,
        mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] };
    state.values[headerField.id] = "";
    state.pages.push({ page: "main", title: "Main", description: "", fields: [logoField] });
    state.constraints[field.id] = { type: "image", maxBytes: 32768,
        mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] };
    state.values[field.id] = "";
    state.controls = [JSON.parse(await readFile(
        new URL("shared-controls/stock-image/control.json", extensionRoot), "utf8"))];
    state.adapters = { "stock.image": "designer-control-adapter-image" };
    const shell = await startPreparedShell(state);
    try {
        await page.goto(shell.url);
        await page.getByRole("tab", { name: "Main" }).click();
        const picker = page.getByRole("group", { name: field.label }).locator('input[type="file"]');
        const feedback = page.locator(`[id="${await picker.getAttribute("id")}-error"]`);
        await expect(feedback).toHaveAttribute("role", "alert");
        await expect(picker).toHaveAttribute("aria-describedby",
            `${await picker.getAttribute("id")}-hint ${await feedback.getAttribute("id")}`);

        await picker.setInputFiles({ name: "large.png", mimeType: "image/png",
            buffer: Buffer.alloc(326439) });
        await expect(feedback).toBeVisible();
        await expect(feedback).toContainText("326,439 bytes");
        await expect(feedback).toContainText("32,768 bytes (32 KiB)");
        await expect(picker).toHaveAttribute("aria-invalid", "true");

        await picker.setInputFiles({ name: "almost.png", mimeType: "image/png",
            buffer: Buffer.alloc(32988) });
        await expect(feedback).toContainText("32,988 bytes");
        await expect(feedback).toContainText("32,768 bytes (32 KiB)");

        await picker.setInputFiles({ name: "vector.svg", mimeType: "image/svg+xml",
            buffer: Buffer.from("<svg/>") });
        await expect(feedback).toContainText("must be a nonempty PNG, JPEG, GIF, or WebP");

        await picker.setInputFiles({ name: "broken.png", mimeType: "image/png",
            buffer: Buffer.from("not a PNG") });
        await expect(feedback).toContainText("Image bytes do not match the selected format");

        await picker.setInputFiles({ name: "undecodable.png", mimeType: "image/png",
            buffer: Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex") });
        await expect(feedback).toContainText("Image cannot be displayed");

        await picker.setInputFiles({ name: "good.png", mimeType: "image/png",
            buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=", "base64") });
        await expect(page.getByAltText(`${field.label} preview`)).toBeVisible();
        await expect(page.getByAltText(`${field.label} preview`)).toHaveJSProperty("naturalWidth", 1);
        await expect(feedback).toBeHidden();
        await expect(picker).not.toHaveAttribute("aria-invalid");
        await page.getByRole("button", { name: "Remove" }).click();
        await expect(feedback).toBeHidden();

        await page.getByRole("tab", { name: "Essentials" }).click();
        const headerPicker = page.getByRole("group", { name: headerField.label }).locator('input[type="file"]');
        const headerFeedback = page.locator(`[id="${await headerPicker.getAttribute("id")}-error"]`);
        await headerPicker.setInputFiles({ name: "header-too-large.png", mimeType: "image/png",
            buffer: Buffer.alloc(32988) });
        await expect(headerFeedback).toContainText("32,988 bytes");
        await expect(headerFeedback).toContainText("32,768 bytes (32 KiB)");
        await expect(headerFeedback).toBeVisible();
    } finally {
        await shell.close();
    }
});

test("an image adapter finishing after a tab switch mounts into the retained page", async ({ page }) => {
    const state = await model();
    const { field } = JSON.parse(await readFile(new URL("header-logo.json", settingsRoot), "utf8"));
    state.pages[0].fields.push(field);
    state.constraints[field.id] = { type: "image", maxBytes: 32768,
        mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] };
    state.values[field.id] = "";
    state.controls = [JSON.parse(await readFile(
        new URL("shared-controls/stock-image/control.json", extensionRoot), "utf8"))];
    state.adapters = { "stock.image": "designer-control-adapter-image" };
    const shell = await startPreparedShell(state);
    let releaseImport;
    let importArrived;
    const importHeld = new Promise((resolve) => { importArrived = resolve; });
    await page.route("**/adapters/designer-control-adapter-image.mjs?*", async (route) => {
        importArrived();
        await new Promise((release) => { releaseImport = release; });
        await route.continue();
    });
    try {
        await page.goto(shell.url, { waitUntil: "domcontentloaded" });
        await importHeld;
        await page.getByRole("textbox", { name: "Canvas ID (required)" }).fill("retained-image");
        await page.getByRole("textbox", { name: "Title (required)" }).fill("Retained image");
        await page.getByRole("tab", { name: "Outputs" }).click();
        const imported = page.waitForResponse((response) =>
            response.url().includes("/adapters/designer-control-adapter-image.mjs")
                && response.status() === 200);
        releaseImport();
        await imported;
        await page.getByRole("tab", { name: "Essentials" }).click();
        await expect(page.getByRole("group", { name: field.label })
            .locator('input[type="file"]')).toBeVisible();
        await page.getByRole("tab", { name: "Outputs" }).click();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator("#action-message")).toHaveText("Settings saved.");
    } finally {
        releaseImport?.();
        await shell.close();
    }
});

test("pending or failed image selection blocks actions until completion or cancel", async ({ page }) => {
    await page.addInitScript(() => {
        const read = Blob.prototype.arrayBuffer;
        Blob.prototype.arrayBuffer = function () {
            const file = this;
            window.uploadStarted = true;
            return new Promise((resolve, reject) => {
                window.releaseUpload = () => read.call(file).then(resolve, reject);
            });
        };
    });
    const state = await model();
    const { field } = JSON.parse(await readFile(new URL("header-logo.json", settingsRoot), "utf8"));
    state.pages[0].fields.push(field);
    state.constraints[field.id] = { type: "image", maxBytes: 32768,
        mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] };
    state.values[field.id] = "";
    state.controls = [JSON.parse(await readFile(
        new URL("shared-controls/stock-image/control.json", extensionRoot), "utf8"))];
    state.adapters = { "stock.image": "designer-control-adapter-image" };
    const shell = await startPreparedShell(state);
    try {
        await page.goto(shell.url);
        const picker = page.locator('input[type="file"]');
        const good = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=", "base64");
        await picker.setInputFiles({ name: "good.png", mimeType: "image/png", buffer: good });
        await page.waitForFunction(() => window.uploadStarted);
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
        await expect(page.getByRole("tab", { name: "Outputs" })).toBeDisabled();
        await expect(page.getByRole("tab", { name: "Essentials" })).toHaveAttribute("aria-selected", "true");
        await page.evaluate(() => window.releaseUpload());
        await expect(page.getByAltText("Header logo preview")).toBeVisible();
        await expect(page.getByRole("tab", { name: "Outputs" })).toBeEnabled();
        await page.getByRole("tab", { name: "Outputs" }).click();
        await expect(page.getByRole("tab", { name: "Outputs" })).toHaveAttribute("aria-selected", "true");
        await page.getByRole("tab", { name: "Essentials" }).click();
        await picker.setInputFiles({ name: "broken.png", mimeType: "image/png",
            buffer: Buffer.from("not a PNG") });
        await page.evaluate(() => window.releaseUpload());
        await expect(page.locator('[id="setting-field-canvas.logo-error"]'))
            .toContainText("Image bytes do not match");
        await page.getByRole("tab", { name: "Outputs" }).click();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator("#page-error")).toContainText("Header logo (canvas.logo) is still processing or needs attention");
        await expect(page.getByRole("tab", { name: "Essentials" }))
            .toHaveAttribute("aria-selected", "true");
        await expect(page.locator('[id="setting-field-canvas.logo-error"]'))
            .toContainText("Image bytes do not match");
        await page.getByRole("button", { name: "Cancel upload" }).click();
        await page.getByRole("tab", { name: "Outputs" }).click();
        await expect(page.getByRole("tab", { name: "Outputs" })).toHaveAttribute("aria-selected", "true");
    } finally {
        await shell.close();
    }
});

test("configured image reports an incompatible Designer adapter beside its field", async ({ page }) => {
    const state = await model();
    const { field } = JSON.parse(await readFile(new URL("header-logo.json", settingsRoot), "utf8"));
    state.pages[0].fields.push(field);
    state.constraints[field.id] = { type: "image", maxBytes: 32768,
        mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] };
    state.values[field.id] = "";
    state.controls = [JSON.parse(await readFile(
        new URL("shared-controls/stock-image/control.json", extensionRoot), "utf8"))];
    state.adapters = { "stock.image": "designer-control-adapter-image" };
    const shell = await startPreparedShell(state);
    try {
        await page.route(/\/adapters\/designer-control-adapter-image\.mjs/, (route) =>
            route.fulfill({ contentType: "text/javascript", body:
                'export const controlId = "wrong"; export const valueContract = { type: "image" }; export function mount() {} export function validate() { return true; }' }));
        await page.goto(shell.url);
        await expect(page.locator('[role="alert"]').filter({
            hasText: "Could not load Header logo: Incompatible control ID or value contract",
        })).toBeVisible();
    } finally {
        await shell.close();
    }
});

test("Designer CSP allows its own UI but blocks cross-origin adapter requests", async ({ page }) => {
    let requests = 0;
    const external = createServer((_request, response) => {
        requests++;
        response.writeHead(204).end();
    });
    await new Promise((resolve) => external.listen(0, "127.0.0.1", resolve));
    let shell;
    try {
        shell = await openDesigner(page);
        await expect(page.getByRole("tab", { name: "Essentials" })).toBeVisible();
        await expect(page.locator(".app-header")).toHaveCSS("display", "grid");
        const document = await page.request.get(shell.url);
        expect(document.headers()["content-security-policy"]).toBe(
            "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'");
        const target = `http://127.0.0.1:${external.address().port}/receive`;
        const result = await page.evaluate(async (url) => {
            try {
                await fetch(url, { mode: "no-cors" });
                return "sent";
            } catch (error) {
                return error.name;
            }
        }, target);
        expect(result).toBe("TypeError");
        expect(requests).toBe(0);
    } finally {
        await shell?.close();
        await new Promise((resolve) => external.close(resolve));
    }
});

test("isolated test preset resolves through Specify and renders its contributed stock field", async ({ page }) => {
    test.setTimeout(150_000);
    const available = spawnSync("specify", ["--version"], { encoding: "utf8" });
    if (available.error?.code === "ENOENT") {
        test.skip(true, "Specify CLI is unavailable for the optional integration probe");
        return;
    }
    expect(available.status, available.stderr).toBe(0);
    const workspace = await mkdtemp(join(tmpdir(), "speckit-designer-preset-e2e-"));
    const project = join(workspace, "project");
    const workflow = { selectedPhases: [] };
    const selections = { presets: [], extensions: [], bundles: [] };
    const handoff = { schemaVersion: 1, handoffId: "preset-test", workflow, selections,
        sourceFingerprint: fingerprint({ workflow, selections }) };
    let shell, reopened;
    try {
        await mkdir(project);
        const run = (...args) => {
            const result = spawnSync("specify", args, {
                cwd: project, encoding: "utf8", timeout: 120000,
                env: { ...process.env, COLUMNS: "500" },
            });

            expect(result.error, `${args.join(" ")}: ${result.error}`).toBeUndefined();
            expect(result.status, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`).toBe(0);
            return stripVTControlCharacters(result.stdout);
        };
        run("init", "--here", "--force", "--non-interactive", "--ignore-agent-tools",
            "--integration", "copilot", "--integration-options=--skills",
            "--script", process.platform === "win32" ? "ps" : "sh");
        run("extension", "add", fileURLToPath(extensionRoot), "--dev", "--force");
        await materializeDevSkills(project);
        run("preset", "add", "--dev", fileURLToPath(presetRoot));
        const command = await readFile(join(project, ".github", "skills",
            "speckit-extension-canvas-design-load-page", "SKILL.md"), "utf8");
        expect(command).toContain("## Additional Designer pages\n\n- `canvas-settings-pr1-test`");
        expect(command).toContain("## Additional Canvas Design templates\n\n"
            + "- `canvas-contribution-pr1-test` — `designer.setting-definition`, `replace`\n"
            + "- `canvas-contribution-pr1-toggle` — `designer.setting-definition`, `replace`");
        const resolve = (name) => {
            const output = run("preset", "resolve", name);
            const line = output.split(/\r?\n/).map((item) => item.trim())
                .find((item) => item.startsWith(`${name}: `));
            expect(line, output).toBeDefined();
            expect(output).not.toMatch(/not found|composition warning/i);
            const source = output.match(/\(top layer from: (\S+) v[\d.]+\)/);
            expect(source, output).not.toBeNull();
            return { name, path: line.slice(name.length + 2), sourceId: source[1] };
        };
        const pages = ["designer-essentials", "designer-artifacts",
            "designer-badges", "designer-appearance", "canvas-settings-pr1-test"]
            .map((name) => { const { sourceId: _sourceId, ...entry } = resolve(name);
                return { ...entry, kind: "designer.tab-definition", strategy: "replace" }; });
        const templates = ["canvas-contribution-pr1-test", "canvas-contribution-pr1-toggle"]
            .map((name) => ({ ...resolve(name), kind: "designer.setting-definition", strategy: "replace" }));
        templates.push(...scalarRegistrations(resolve), ...workflowRegistrations(resolve));
        expect(templates[0].sourceId).toBe("copilot-canvas-design-test");
        const folder = handoffDirectory(workspace, handoff.handoffId);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "handoff.json"), JSON.stringify(handoff));
        const resolved = await loadResolvedDesignerPages(handoff, project, pages, templates);
        expect(resolved.pages.map((item) => item.title)).toEqual(
            ["Essentials", "Outputs", "Badges", "Appearance", "Test settings"]);
        expect(resolved.pages[4].fields.map((item) => item.id)).toEqual(
            ["pr1Test.label", "pr1Test.enabled"]);
        expect(resolved.values["pr1Test.label"]).toBe("");
        expect(resolved.values["pr1Test.enabled"]).toBe(true);
        shell = await startShell(handoff,
            await loadDesignerSettings(workspace, handoff, resolved), { project, workspace });
        await page.goto(shell.url);
        await page.getByRole("tab", { name: "Test settings" }).click();
        const field = page.getByRole("textbox", { name: "Test label" });
        await expect(field).toBeVisible();
        await field.fill("Visible from preset");
        const checkbox = page.getByRole("checkbox", { name: "Test enabled" });
        await expect(checkbox).toBeChecked();
        await checkbox.uncheck();
        await page.getByRole("tab", { name: "Essentials" }).click();
        await page.getByRole("textbox", { name: "Canvas ID (required)" }).fill("pr1-test");
        await page.getByRole("textbox", { name: "Title (required)" }).fill("PR1 test");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator("#action-message")).toHaveText("Settings saved.");
        const saved = await loadDesignerSettings(workspace, handoff,
            await loadResolvedDesignerPages(handoff, project, pages, templates));
        expect(saved.values["pr1Test.label"]).toBe("Visible from preset");
        expect(saved.values["pr1Test.enabled"]).toBe(false);
        reopened = await startShell(handoff, saved, { project, workspace });
        await page.goto(reopened.url);
        await page.getByRole("tab", { name: "Test settings" }).click();
        await expect(page.getByRole("textbox", { name: "Test label" })).toHaveValue("Visible from preset");
        await expect(page.getByRole("checkbox", { name: "Test enabled" })).not.toBeChecked();
    } finally {
        await reopened?.close();
        await shell?.close();
        await rm(workspace, { recursive: true, force: true });
    }
});

test("Billing preset and built-in palette persist through Generate and render their values", async ({ page }) => {
    test.setTimeout(150_000);
    const available = spawnSync("specify", ["--version"], { encoding: "utf8" });
    if (available.error?.code === "ENOENT") {
        test.skip(true, "Specify CLI is unavailable for the optional integration probe");
        return;
    }
    expect(available.status, available.stderr).toBe(0);
    const workspace = await mkdtemp(join(tmpdir(), "speckit-billing-preset-e2e-"));
    const project = join(workspace, "project");
    const workflow = { selectedPhases: ["specify"],
        installed: { presets: [], extensions: [], bundles: [] } };
    const selections = { presets: [], extensions: [], bundles: [] };
    const handoff = { schemaVersion: 1, handoffId: "billing-test", workflow, selections,
        sourceFingerprint: fingerprint({ workflow, selections }) };
    let shell, reopened, generatedRoutes, generatedServer;
    try {
        await mkdir(project);
        const run = (...args) => {
            const result = spawnSync("specify", args, { cwd: project, encoding: "utf8",
                timeout: 120000, env: { ...process.env, COLUMNS: "500" } });
            expect(result.error, `${args.join(" ")}: ${result.error}`).toBeUndefined();
            expect(result.status, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`).toBe(0);
            return stripVTControlCharacters(result.stdout);
        };
        run("init", "--here", "--force", "--non-interactive", "--ignore-agent-tools",
            "--integration", "copilot", "--integration-options=--skills",
            "--script", process.platform === "win32" ? "ps" : "sh");
        run("extension", "add", fileURLToPath(extensionRoot), "--dev", "--force");
        await materializeDevSkills(project);
        run("preset", "add", "--dev", fileURLToPath(billingRoot));
        const command = await readFile(join(project, ".github", "skills",
            "speckit-extension-canvas-design-load-page", "SKILL.md"), "utf8");
        expect(command).toContain("- `canvas-settings-billing`");
        expect(command).toContain("- `canvas-contributions-billing`");
        const resolve = (name) => {
            const output = run("preset", "resolve", name);
            const line = output.split(/\r?\n/).map((item) => item.trim())
                .find((item) => item.startsWith(`${name}: `));
            expect(line, output).toBeDefined();
            expect(output).not.toMatch(/not found|composition warning/i);
            const source = output.match(/\(top layer from: (\S+) v[\d.]+\)/);
            expect(source, output).not.toBeNull();
            return { name, path: line.slice(name.length + 2), sourceId: source[1] };
        };
        const pages = ["designer-essentials", "designer-artifacts",
            "designer-badges", "designer-appearance", "canvas-settings-billing"]
            .map((name) => { const { sourceId: _sourceId, ...entry } = resolve(name);
                return { ...entry, kind: "designer.tab-definition", strategy: "replace" }; });
        const templates = [
            ...["designer-appearance-light-accent", "designer-appearance-dark-accent"]
                .map((name) => ({ ...resolve(name),
                    kind: "designer.setting-definition", strategy: "replace" })),
            { ...resolve("canvas-contributions-billing"),
                kind: "designer.setting-definition", strategy: "replace" },
            ...scalarRegistrations(resolve), ...workflowRegistrations(resolve),
        ];
        expect(templates[2].sourceId).toBe("copilot-billing-canvas-test");
        const folder = handoffDirectory(workspace, handoff.handoffId);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "handoff.json"), JSON.stringify(handoff));
        const resolved = await loadResolvedDesignerPages(handoff, project, pages, templates);
        expect(resolved.pages.map((item) => item.title)).toEqual(
            ["Essentials", "Outputs", "Badges", "Appearance", "Billing"]);
        const costPage = resolved.pages.find((entry) =>
            entry.fields.some((field) => field.id === "billing.costCode"));
        shell = await startShell(handoff,
            await loadDesignerSettings(workspace, handoff, resolved), { project, workspace,
                session: { send: async () => {} } });
        await page.goto(shell.url);
        await page.getByRole("tab", { name: costPage.title }).click();
        const code = page.getByRole("textbox", { name: "Cost code" });
        await expect(code).toHaveAttribute("maxlength", "64");
        await code.fill("CC-481");
        await page.getByRole("tab", { name: "Essentials" }).click();
        await page.getByRole("textbox", { name: "Canvas ID (required)" }).fill("billing-canvas");
        await page.getByRole("textbox", { name: "Title (required)" }).fill("Billing Canvas");
        await page.getByRole("tab", { name: "Appearance" }).click();
        const light = page.getByRole("textbox", { name: "Light mode accent" });
        const dark = page.getByRole("textbox", { name: "Dark mode accent" });
        await light.fill("not-a-color");
        await page.getByRole("button", { name: "Generate", exact: true }).click();
        await expect(page.locator("#page-error")).toContainText(
            "Invalid Light mode accent (canvas.accentLight)");
        await light.fill("123aBc");
        await dark.fill("#ABC123");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator("#action-message")).toHaveText("Settings saved.");
        const saved = await loadDesignerSettings(workspace, handoff,
            await loadResolvedDesignerPages(handoff, project, pages, templates));
        expect(saved.values["billing.costCode"]).toBe("CC-481");
        expect(saved.values["canvas.accentLight"]).toBe("123aBc");
        expect(saved.values["canvas.accentDark"]).toBe("#ABC123");
        reopened = await startShell(handoff, saved, { project, workspace,
            session: { send: async () => {} } });
        await page.goto(reopened.url);
        await page.getByRole("tab", { name: costPage.title }).click();
        await expect(page.getByRole("textbox", { name: "Cost code" })).toHaveValue("CC-481");
        await page.getByRole("tab", { name: "Appearance" }).click();
        await expect(page.getByRole("textbox", { name: "Light mode accent" })).toHaveValue("123aBc");
        await expect(page.getByRole("textbox", { name: "Dark mode accent" })).toHaveValue("#ABC123");
        await page.getByRole("button", { name: "Generate", exact: true }).click();
        await expect(page.locator("#conn-status")).toContainText("Generation queued:");
        await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
        const [requestId] = await readdir(join(folder, "generations"));
        await materialize(project, workspace, handoff.handoffId, requestId);
        const config = JSON.parse(await readFile(join(project, ".github", "extensions",
            "billing-canvas", "canvas-config.json"), "utf8"));
        expect(config.readOnlyFields).toEqual([{ id: "billing.costCode",
            label: "Cost code", value: "CC-481",
            section: { id: "billing", title: "Billing" } }]);
        expect(config.appearance).toMatchObject({
            light: { accent: "#123aBc" }, dark: { accent: "#ABC123" },
        });
        const { createWorkflowRoutes } = await import(pathToFileURL(join(project, ".github",
            "extensions", "billing-canvas", "server.mjs")).href);
        generatedRoutes = createWorkflowRoutes(config, {
            runtime: null, instanceId: "billing-browser", token: "billing-token",
            port: () => generatedServer.address().port,
        });
        generatedServer = createServer(generatedRoutes.handle);
        await new Promise((resolve) => generatedServer.listen(0, "127.0.0.1", resolve));
        await page.goto(`http://127.0.0.1:${generatedServer.address().port}/?token=billing-token`,
            { waitUntil: "commit" });
        await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Configured fields" })).toHaveCount(0);
        await expect(page.locator('[data-field-id="billing.costCode"]')).toHaveText("CC-481");
        await expect(page.getByRole("textbox", { name: "Cost code" })).toHaveCount(0);
    } finally {
        generatedRoutes?.close();
        if (generatedServer) {
            await new Promise((resolve) => {
                generatedServer.close(resolve);
                generatedServer.closeAllConnections();
            });
        }
        await reopened?.close();
        await shell?.close();
        await rm(workspace, { recursive: true, force: true });
    }
});

test("risk preset selects a cell by keyboard and packages its read-only adapter", async ({ page }) => {
    test.setTimeout(480_000);
    const available = spawnSync("specify", ["--version"], { encoding: "utf8" });
    expect(available.error, "Specify CLI is required for the contract integration").toBeUndefined();
    expect(available.status, available.stderr).toBe(0);
    const workspace = await mkdtemp(join(tmpdir(), "speckit-risk-preset-e2e-"));
    const project = join(workspace, "project");
    const presetCopy = join(workspace, "risk-preset");
    const handoff = {
        schemaVersion: 1, handoffId: "risk-test",
        workflow: { selectedPhases: ["specify"],
            installed: { presets: [], extensions: [], bundles: [] } },
        selections: { presets: [], extensions: [], bundles: [] },
    };
    handoff.sourceFingerprint = fingerprint({
        workflow: handoff.workflow, selections: handoff.selections,
    });
    let shell, reopened, stale, broken, incompatible, brokenContext, server, routes;
    const prompts = [];
    try {
        await mkdir(project);
        const run = (...args) => {
            const result = spawnSync("specify", args, {
                cwd: project, encoding: "utf8", timeout: 120000,
                env: { ...process.env, COLUMNS: "500" },
            });
            expect(result.error, `${args.join(" ")}: ${result.error}`).toBeUndefined();
            expect(result.status, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`).toBe(0);
            return stripVTControlCharacters(result.stdout);
        };
        run("init", "--here", "--force", "--non-interactive", "--ignore-agent-tools",
            "--integration", "copilot", "--integration-options=--skills",
            "--script", process.platform === "win32" ? "ps" : "sh");
        run("extension", "add", fileURLToPath(extensionRoot), "--dev", "--force");
        await materializeDevSkills(project);
        await cp(fileURLToPath(riskRoot), presetCopy, { recursive: true });
        run("preset", "add", "--dev", presetCopy);
        const command = await readFile(join(project, ".github", "skills",
            "speckit-extension-canvas-design-load-page", "SKILL.md"), "utf8");
        for (const name of ["canvas-control-risk-matrix", "canvas-contributions-risk-designer",
            "canvas-control-risk-matrix-designer", "canvas-control-risk-matrix-generated"]) {
            expect(command).toContain(`- \`${name}\``);
        }
        const resolve = (name) => {
            const output = run("preset", "resolve", name);
            const line = output.split(/\r?\n/).map((item) => item.trim())
                .find((item) => item.startsWith(`${name}: `));
            expect(line, output).toBeDefined();
            expect(output).not.toMatch(/not found|composition warning/i);
            const source = output.match(/\(top layer from: (\S+) v[\d.]+\)/);
            expect(source, output).not.toBeNull();
            return { name, path: line.slice(name.length + 2), sourceId: source[1] };
        };
        const pages = ["designer-essentials", "designer-artifacts", "designer-badges", "designer-appearance"]
            .map((name) => { const { sourceId: _sourceId, ...entry } = resolve(name);
                return { ...entry, kind: "designer.tab-definition", strategy: "replace" }; });
        const templates = [
            ["canvas-control-risk-matrix", "shared.control-definition"],
            ["canvas-contributions-risk-designer", "designer.setting-definition"],
            ["canvas-control-risk-matrix-designer", "designer.control-adapter"],
            ["canvas-control-risk-matrix-generated", "generated.control-adapter"],
        ].map(([name, kind]) => ({ ...resolve(name), kind, strategy: "replace" }));
        const adapterRelative = relative(await realpath(workspace), await realpath(templates[2].path));
        expect(isAbsolute(adapterRelative) || adapterRelative === ".."
            || adapterRelative.startsWith(`..${sep}`)).toBe(false);
        templates.push(...scalarRegistrations(resolve));
        templates.push(...workflowRegistrations(resolve));
        templates.push(...["designer-essentials-description", "designer-essentials-workflow-heading"]
            .map((name) => ({ ...resolve(name), kind: "designer.setting-definition", strategy: "replace" })));
        const folder = handoffDirectory(workspace, handoff.handoffId);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "handoff.json"), JSON.stringify(handoff));
        const load = async () => loadDesignerSettings(workspace, handoff,
            await loadResolvedDesignerPages(handoff, project, pages, templates));
        shell = await startShell(handoff, await load(), { project, workspace,
            session: { send: async ({ prompt }) => { prompts.push(prompt); } } });
        await page.goto(shell.url);
        const group = page.getByRole("radiogroup", { name: "Risk rating: impact by likelihood" });
        await expect(group.getByRole("radio")).toHaveCount(9);
        await group.getByRole("radio", { name: "Impact low, likelihood low" }).focus();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowDown");
        await expect(group.getByRole("radio",
            { name: "Impact medium, likelihood medium" })).toHaveAttribute("aria-checked", "true");
        await page.getByRole("textbox", { name: "Canvas ID (required)" }).fill("risk-canvas");
        await page.getByRole("textbox", { name: "Title (required)" }).fill("Risk Canvas");
        await page.getByRole("textbox", { name: "Description" }).fill("Risk workflow description");
        await page.getByRole("textbox", { name: "Workflow header" }).fill("Risk workflows");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator("#action-message")).toHaveText("Settings saved.");
        expect((await load()).values["risk.rating"]).toEqual({
            impact: "medium", likelihood: "medium",
        });
        reopened = await startShell(handoff, await load(), { project, workspace,
            session: { send: async ({ prompt }) => { prompts.push(prompt); } } });
        await page.goto(reopened.url);
        await expect(page.getByRole("radio",
            { name: "Impact medium, likelihood medium" })).toHaveAttribute("aria-checked", "true");
        await page.getByRole("button", { name: "Generate", exact: true }).click();
        await expect(page.locator("#conn-status")).toContainText("Generation queued:");
        const [requestId] = await readdir(join(folder, "generations"));
        await expect.poll(() => prompts.length).toBe(1);
        expect(prompts[0]).toContain(requestId);
        expect(prompts[0]).toContain("speckit-extension-canvas-design-generate");
        const requestPath = join(folder, "generations", requestId, "request.json");
        const requestBytes = await readFile(requestPath);
        const request = JSON.parse(requestBytes.toString("utf8"));
        const { integrity, ...payload } = request;
        expect(request.schemaVersion).toBe(1);
        expect(request.handoffId).toBe(handoff.handoffId);
        expect(request.requestId).toBe(requestId);
        expect(request.settingsRevision).toBe(1);
        expect(requestBytes.length).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(integrity).toBe(createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
        expect(request.values["risk.rating"]).toEqual({ impact: "medium", likelihood: "medium" });
        expect(request.generatedControls[0].value).toEqual(request.values["risk.rating"]);
        await writeFile(requestPath, JSON.stringify({ ...request, settingsRevision: 0 }));
        await expect(materialize(project, workspace, handoff.handoffId, requestId))
            .rejects.toThrow(/Generation request integrity mismatch/);
        await expect(readFile(join(project, request.target, "canvas-config.json")))
            .rejects.toMatchObject({ code: "ENOENT" });
        await writeFile(requestPath, requestBytes);
        await materialize(project, workspace, handoff.handoffId, requestId);
        const portable = join(workspace, "portable-risk");
        await cp(join(project, ".github", "extensions", "risk-canvas"), portable, { recursive: true });
        const { readConfig, createWorkflowRoutes } = await import(
            pathToFileURL(join(portable, "server.mjs")).href);
        const config = readConfig();
        expect(config.generatedControls[0].value).toEqual({
            impact: "medium", likelihood: "medium",
        });
        routes = createWorkflowRoutes(config, {
            runtime: null, instanceId: "risk-browser", token: "risk-token",
            port: () => server.address().port,
        });
        server = createServer(routes.handle);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        await page.goto(`http://127.0.0.1:${server.address().port}/?token=risk-token`);
        await expect(page.locator("#workflow-heading")).toContainText("Risk workflows");
        await expect(page.locator(".collection-description")).toHaveText("Risk workflow description");
        await expect(page.locator(".brand-mark")).toContainText(String.fromCodePoint(9671));
        await expect(page.getByRole("table", { name: /impact medium, likelihood medium/ })).toBeVisible();
        await expect(page.locator('[data-control-id="risk.rating"] [aria-current="true"]')).toHaveText("Selected");
        const contract = JSON.parse(await readFile(templates[0].path, "utf8")).value;
        const adapterPattern = `**/adapters/${templates[2].name}.mjs*`;
        await page.route(adapterPattern, (route) => route.fulfill({
            contentType: "text/javascript",
            body: `export const controlId = "risk-matrix";
                export const valueContract = ${JSON.stringify(contract)};
                export function validate() { return true; }
                export function mount({ root, onChange }) {
                    (globalThis.controlCallbacks ??= []).push(onChange);
                    root.textContent = "Adapter mounted";
                    return { isReady: () => true };
                }`,
        }));
        stale = await startShell(handoff, await load(), { project, workspace });
        await page.goto(stale.url);
        await page.waitForFunction(() => globalThis.controlCallbacks?.length === 1);
        await page.getByRole("tab", { name: "Outputs" }).click();
        await page.getByRole("tab", { name: "Essentials" }).click();
        await expect.poll(() => page.evaluate(() => globalThis.controlCallbacks?.length)).toBe(1);
        await page.evaluate(() => {
            globalThis.controlCallbacks[0]({ impact: "low", likelihood: "low" });
        });
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator("#action-message")).toHaveText("Settings saved.");
        expect((await loadDesignerSettings(workspace, handoff, await load())).values["risk.rating"])
            .toEqual({ impact: "low", likelihood: "low" });
        await page.unroute(adapterPattern);
        const designerAdapter = await readFile(templates[2].path, "utf8");
        await writeFile(templates[2].path, designerAdapter.replace(
            "export function mount(", "export const mount = null; function unusedMount("));
        broken = await startShell(handoff,
            await loadResolvedDesignerPages(handoff, project, pages, templates), { project, workspace });
        await page.goto(broken.url);
        await expect(page.locator('[data-field-id="risk.rating"][role="alert"]')).toContainText(
            "Could not load Risk rating: Missing mount export");
        await expect(page.getByRole("textbox", { name: "Canvas ID (required)" })).toBeVisible();
        await writeFile(templates[2].path, designerAdapter.replace(
            'export const controlId = "risk-matrix"', 'export const controlId = "wrong-control"'));
        incompatible = await startShell(handoff,
            await loadResolvedDesignerPages(handoff, project, pages, templates), { project, workspace });
        await page.goto(incompatible.url);
        await expect(page.locator('[data-field-id="risk.rating"][role="alert"]')).toContainText(
            "Could not load Risk rating: Incompatible control ID or value contract");
        const generatedAdapter = join(portable, "controls", `${templates[3].name}.mjs`);
        await writeFile(generatedAdapter, "export const mount = null;");
        const servedAdapter = await fetch(`http://127.0.0.1:${server.address().port}`
            + `/controls/${templates[3].name}.mjs?token=risk-token`,
        { signal: AbortSignal.timeout(5000) });
        expect(servedAdapter.status).toBe(200);
        expect(await servedAdapter.text()).toContain("export const mount = null;");
        brokenContext = await page.context().browser().newContext();
        const brokenPage = await brokenContext.newPage();
        await brokenPage.goto(`http://127.0.0.1:${server.address().port}/?token=risk-token`,
            { waitUntil: "commit" });
        await expect(brokenPage.locator('[data-control-id="risk.rating"][role="alert"]')).toContainText(
            "Generated control could not render: Missing mount export");
    } finally {
        await brokenContext?.close();
        routes?.close();
        if (server) {
            await new Promise((resolve) => {
                server.close(resolve);
                server.closeAllConnections();
            });
        }
        await incompatible?.close();
        await broken?.close();
        await stale?.close();
        await reopened?.close();
        await shell?.close();
        await rm(workspace, { recursive: true, force: true });
    }
});

async function openWithError(page, name) {
    const state = await model();
    const index = state.pages.findIndex((item) => item.page === name);
    state.pages[index] = { page: name, title: name, order: (index + 1) * 10,
        error: { name, path: "C:\\project\\.specify\\bad.json",
            reason: "Invalid JSON: <b>unexpected</b>" } };
    if (index === 0) {
        for (const field of ["canvas.id", "canvas.displayName", "canvas.description",
            "canvas.workflowListName"]) {
            delete state.constraints[field];
            delete state.values[field];
        }
    }
    const shell = await startPreparedShell(state);
    await page.goto(shell.url);
    return shell;
}

test("Essentials keeps the Workflow header without a slug toggle", async ({ page }) => {
    const shell = await openDesigner(page);
    try {
        await expect(page.getByRole("tab")).toHaveText(["Essentials", "Outputs", "Badges", "Appearance"]);
        const id = page.getByRole("textbox", { name: "Canvas ID (required)" });
        const title = page.getByRole("textbox", { name: "Title (required)" });
        await expect(page.getByRole("textbox")).toHaveCount(4);
        await expect(page.getByRole("checkbox")).toHaveCount(0);
        await expect(id).toHaveAttribute("pattern",
            "^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9][a-z0-9-]*$");
        const hint = page.locator(`[id="${await id.getAttribute("id")}-hint"]`);
        await expect(id).toHaveAttribute("aria-describedby", await hint.getAttribute("id"));
        await expect(hint)
            .toHaveText("Use 1–100 characters: lowercase letters (a–z), numbers (0–9), and hyphens (-). Start with a letter or number. Reserved IDs, including Windows device names like con and com1, cannot be used.");
        await expect(title).toHaveAttribute("maxlength", "120");
        await expect(page.getByRole("textbox", { name: "Description" })).toHaveAttribute("maxlength", "240");
        await expect(page.getByRole("textbox", { name: "Workflow header" })).toHaveAttribute("maxlength", "80");
        await id.fill("example-canvas");
        for (const name of ["Outputs", "Appearance"]) {
            await page.getByRole("tab", { name }).click();
            if (name === "Outputs") await expect(page.getByRole("heading", { name: "Outputs" })).toBeVisible();
            else await expect(page.getByText("This template defines no fields.")).toBeVisible();
        }
        await page.getByRole("tab", { name: "Essentials" }).click();
        await expect(id).toHaveValue("example-canvas");
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
        await expect(page.getByRole("status")).toHaveText("Ready");
    } finally {
        await shell.close();
    }
});

test("required stock text keeps incomplete drafts until Generate", async ({ page }) => {
    const state = await model();
    state.pages[0].fields.find((field) => field.id === "canvas.description").required = true;
    state.constraints["canvas.description"].required = true;
    state.settingsRevision = 0;
    state.persisted = false;
    const shell = await startPreparedShell(state);
    try {
        await page.goto(shell.url);
        const id = page.getByRole("textbox", { name: "Canvas ID (required)" });
        const title = page.getByRole("textbox", { name: "Title (required)" });
        const description = page.getByRole("textbox", { name: "Description (required)" });
        await id.fill("required-canvas");
        await title.fill("  ");
        await title.blur();
        await expect(title).not.toHaveAttribute("aria-invalid");
        await title.fill("Required Canvas");
        await description.fill("   ");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator("#action-message")).toHaveText("Settings saved.");
        await expect(page.locator("#action-message")).toBeVisible();
        await expect(description).toHaveValue("   ");
        await description.fill("A valid description");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator("#action-message")).toHaveText("Settings saved.");
        await expect(page.locator("#action-message")).toBeVisible();
    } finally {
        await shell.close();
    }
});

test("missing Generate skill explains why the action is disabled", async ({ page }) => {
    const workspace = await mkdtemp(join(scratchRoot, ".designer-generate-unavailable-"));
    const project = join(workspace, "project");
    const workflow = { selectedPhases: ["specify"],
        installed: { presets: [], extensions: [], bundles: [] } };
    const selections = { presets: [], extensions: [], bundles: [] };
    const handoff = { schemaVersion: 1, handoffId: "missing-generate", workflow, selections,
        sourceFingerprint: fingerprint({ workflow, selections }) };
    let shell;
    try {
        await mkdir(project);
        const folder = handoffDirectory(workspace, handoff.handoffId);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "handoff.json"), JSON.stringify(handoff));
        const state = await model();
        await prepareScalarAdapters(project, state);
        shell = await startShell(handoff, state, { project, workspace,
            session: { send: async () => {} } });
        await page.goto(shell.url);
        await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
        await expect(page.locator("#generation-error")).toHaveText(
            "Canvas Design does not provide Generate in this session. Launch a new Designer session with a compatible Canvas Design extension or the current local source.");
        await page.getByRole("textbox", { name: "Canvas ID (required)" }).fill("new-canvas");
        await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
        await expect(page.locator("#generation-error")).toBeVisible();
    } finally {
        await shell?.close();
        await rm(workspace, { recursive: true, force: true });
    }
});

test("failed optional page shows safe diagnostics while Essentials remains editable", async ({ page }) => {
    const shell = await openWithError(page, "designer-artifacts");
    try {
        await expect(page.getByRole("status")).toHaveText("Pages need attention (1)");
        const id = page.getByRole("textbox", { name: "Canvas ID (required)" });
        await id.fill("my-canvas");
        await page.getByRole("tab", { name: "designer-artifacts (error)" }).click();
        await expect(page.getByRole("heading", { name: "Could not load designer-artifacts" })).toBeVisible();
        await expect(page.getByText("Resolved path: C:\\project\\.specify\\bad.json")).toBeVisible();
        await expect(page.getByText("Reason: Invalid JSON: <b>unexpected</b>")).toBeVisible();
        await expect(page.locator("#settings-page b")).toHaveCount(0);
        await page.getByRole("tab", { name: "Essentials" }).click();
        await expect(id).toHaveValue("my-canvas");
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
    } finally {
        await shell.close();
    }
});

test("Save keeps incomplete drafts, persists edits and reports stale revisions", async ({ page }) => {
    const workspace = await mkdtemp(join(scratchRoot, ".designer-save-e2e-"));
    const workflow = { selectedPhases: [] };
    const selections = { presets: [], extensions: [], bundles: [] };
    const handoff = { schemaVersion: 1, handoffId: "test", workflow, selections,
        sourceFingerprint: fingerprint({ workflow, selections }) };
    const folder = handoffDirectory(workspace, handoff.handoffId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "handoff.json"), JSON.stringify(handoff));
    const initial = await model();
    initial.settingsRevision = 0;
    initial.persisted = false;
    const project = join(workspace, "project");
    await prepareScalarAdapters(project, initial);
    const shell = await startShell(handoff, initial, { project, workspace });
    const staleShell = await startShell(handoff, initial, { project, workspace });
    try {
        await page.goto(shell.url);
        const save = page.getByRole("button", { name: "Save", exact: true });
        await save.click();
        await expect(page.locator("#action-message")).toHaveText("Settings saved.");
        await expect(page.locator('[id="setting-field-canvas.id-hint"]'))
            .toContainText("lowercase letters (a–z), numbers (0–9), and hyphens (-)");
        await page.getByRole("textbox", { name: "Canvas ID (required)" }).fill("example-canvas");
        await page.getByRole("textbox", { name: "Title (required)" }).fill("Example");
        await save.click();
        await expect(page.locator("#action-message")).toHaveText("Settings saved.");
        await expect(save).toBeDisabled();
        await expect(page.locator("#save-help")).toHaveAttribute("title", "No changes to save");
        await expect(save).toHaveAttribute("aria-description", "No changes to save");
        expect(await save.evaluate((button) => getComputedStyle(button).cursor)).toBe("default");
        await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();

        const reopenedModel = await loadDesignerSettings(workspace, handoff, await model());
        await prepareScalarAdapters(project, reopenedModel);
        const reopened = await startShell(handoff, reopenedModel, { project, workspace });
        try {
            await page.goto(reopened.url);
            await expect(page.getByRole("textbox", { name: "Canvas ID (required)" }))
                .toHaveValue("example-canvas");
            await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
            await expect(page.locator("#save-help")).toHaveAttribute("title", "No changes to save");
        } finally {
            await reopened.close();
        }

        await page.goto(staleShell.url);
        await page.getByRole("textbox", { name: "Title (required)" }).fill("Changed");
        await page.getByRole("textbox", { name: "Canvas ID (required)" }).fill("stale-canvas");
        await save.click();
        await expect(page.getByRole("alert")).toContainText("close and reopen Designer before saving");
        await expect(page.getByRole("textbox", { name: "Title (required)" })).toHaveValue("Changed");
    } finally {
        await shell.close();
        await staleShell.close();
        await rm(workspace, { recursive: true, force: true });
    }
});

test("failed Essentials remains selected with no identity fields; other tabs work", async ({ page }) => {
    const shell = await openWithError(page, "designer-essentials");
    try {
        await expect(page.getByRole("tab", { name: "designer-essentials (error)" }))
            .toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("heading", { name: "Could not load designer-essentials" })).toBeVisible();
        await expect(page.getByRole("textbox")).toHaveCount(0);
        await page.getByRole("tab", { name: "Outputs" }).click();
        await expect(page.getByRole("heading", { name: "Outputs" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
    } finally {
        await shell.close();
    }
});

test("failed Essentials stays selected when a custom page sorts before it", async ({ page }) => {
    const state = await model();
    state.pages[0] = { page: "designer-essentials", title: "designer-essentials", order: 10,
        error: { name: "designer-essentials", path: "C:\\project\\.specify\\missing.json",
            reason: "resolved page file is missing" } };
    state.pages.push({ page: "custom-settings", id: "custom-settings", title: "Custom",
        order: 5, fields: [] });
    state.pages.sort((a, b) => a.order - b.order);
    const shell = await startPreparedShell(state);
    try {
        await page.goto(shell.url);
        await expect(page.getByRole("tab", { name: "designer-essentials (error)" }))
            .toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("heading", { name: "Could not load designer-essentials" }))
            .toBeVisible();
    } finally {
        await shell.close();
    }
});
