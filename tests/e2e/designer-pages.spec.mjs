import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, expect } from "./playwright.mjs";
import { startShell } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/server.mjs";
import { fingerprint, handoffDirectory } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/handoff.mjs";
import { loadResolvedDesignerPages } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/pages.mjs";
import { loadDesignerSettings } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/settings.mjs";
import { materialize } from "../../spec-kit-extensions/extension-canvas-design/scripts/generate.mjs";
import { renderHtml } from "../../spec-kit-extensions/extension-canvas-design/templates/generated-canvas/server.mjs";

const templateRoot = new URL("../../spec-kit-extensions/extension-canvas-design/pages/", import.meta.url);
const extensionRoot = new URL("../../spec-kit-extensions/extension-canvas-design/", import.meta.url);
const presetRoot = new URL("../../spec-kit-presets/copilot-canvas-design-test/", import.meta.url);
const billingRoot = new URL("../../spec-kit-presets/copilot-billing-canvas-test/", import.meta.url);
const riskRoot = new URL("../../spec-kit-presets/copilot-risk-matrix-test/", import.meta.url);

function supportsSpecifyVersion(output) {
    const version = output.match(/\bspecify\s+(\d+)\.(\d+)\.(\d+)\b/);
    if (!version) return false;
    const major = Number(version[1]);
    const minor = Number(version[2]);
    const patch = Number(version[3]);
    return major > 1 || (major === 1 && (minor > 0 || patch >= 7));
}

function scalarRegistrations(resolve) {
    return [
        ["canvas-stock-text", "control.definition"],
        ["canvas-stock-text-designer", "designer.adapter"],
        ["canvas-stock-text-generated", "generated.adapter"],
        ["canvas-stock-checkbox", "control.definition"],
        ["canvas-stock-checkbox-designer", "designer.adapter"],
    ].map(([name, kind]) => ({ ...resolve(name), kind, strategy: "replace" }));
}

test("Specify integration probe accepts all versions from 1.0.7 onward", () => {
    for (const [version, supported] of [
        ["0.99.99", false], ["1.0.6", false], ["1.0.7", true],
        ["1.1.0", true], ["2.0.0", true], ["10.0.0", true],
    ]) {
        expect(supportsSpecifyVersion(`specify ${version}`), version).toBe(supported);
    }
    expect(supportsSpecifyVersion("unexpected version output")).toBe(false);
});

async function model(revision = "first") {
    const pages = [];
    for (const name of ["essentials", "artifacts", "appearance"]) {
        const document = JSON.parse(await readFile(new URL(`${name}.json`, templateRoot), "utf8"));
        pages.push({ ...document, page: document.id });
    }
    for (const name of ["description", "workflow-heading", "custom-slug"]) {
        const { field } = JSON.parse(await readFile(new URL(`stock-${name}.json`, templateRoot), "utf8"));
        pages[0].fields.push(field);
    }
    return {
        pages, revision,
        constraints: {
            "canvas.id": { type: "string", minLength: 1, maxLength: 100,
                pattern: "^[a-z0-9][a-z0-9-]*$", required: true },
            "canvas.displayName": { type: "string", minLength: 1, maxLength: 120,
                required: true },
            "canvas.description": { type: "string", maxLength: 240 },
            "canvas.workflowListName": { type: "string", maxLength: 80 },
            "workflowSlug.userProvided": { type: "boolean" },
        },
        values: { "canvas.id": "", "canvas.displayName": "", "canvas.description": "",
            "canvas.workflowListName": "", "workflowSlug.userProvided": false },
    };
}

async function prepareScalarAdapters(project, state) {
    state.controls = [...(state.controls ?? []),
        ...await Promise.all(["stock-text", "stock-checkbox"].map(async (name) =>
            JSON.parse(await readFile(new URL(`controls/${name}/control.json`, extensionRoot), "utf8"))))];
    state.adapters = { ...state.adapters, "stock.text": "canvas-stock-text-designer",
        "stock.checkbox": "canvas-stock-checkbox-designer" };
    state.templates ??= [];
    for (const [name, file] of [
        ["canvas-stock-text-designer", "stock-text"],
        ["canvas-stock-checkbox-designer", "stock-checkbox"],
    ]) {
        const path = join(project, ".specify", "extensions", "extension-canvas-design",
            "controls", file, "designer.mjs");
        await mkdir(join(project, ".specify", "extensions", "extension-canvas-design",
            "controls", file), { recursive: true });
        await copyFile(new URL(`controls/${file}/designer.mjs`, extensionRoot), path);
        const bytes = await readFile(path);
        state.templates.push({ name, path,
            hash: createHash("sha256").update(bytes).digest("hex"), kind: "designer.adapter" });
    }
}

async function startPreparedShell(state) {
    const workspace = await mkdtemp(join(tmpdir(), "designer-pages-e2e-"));
    const workflow = { selectedPhases: [] };
    const selections = { presets: [], extensions: [], bundles: [] };
    const handoff = { schemaVersion: 1, handoffId: "test", workflow, selections,
        sourceFingerprint: fingerprint({ workflow, selections }) };
    const folder = handoffDirectory(workspace, handoff.handoffId);
    try {
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "handoff.json"), JSON.stringify(handoff));
        const project = join(workspace, "project");
        await prepareScalarAdapters(project, state);
        if (state.adapters?.["stock.image"]) {
            const path = join(project, ".specify", "extensions", "extension-canvas-design",
                "controls", "stock-image", "designer.mjs");
            await mkdir(join(project, ".specify", "extensions", "extension-canvas-design",
                "controls", "stock-image"), { recursive: true });
            await copyFile(new URL("controls/stock-image/designer.mjs", extensionRoot), path);
            const bytes = await readFile(path);
            state.templates.push({ name: "canvas-stock-image-designer", path,
                hash: createHash("sha256").update(bytes).digest("hex"), kind: "designer.adapter" });
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

test("Main page Logo upload explains rejection beside the picker and clears on replacement", async ({ page }) => {
    const state = await model();
    const { field } = JSON.parse(await readFile(new URL("stock-logo-main-page.json", templateRoot), "utf8"));
    const logoField = field;
    const { field: headerField } = JSON.parse(await readFile(new URL("stock-logo.json", templateRoot), "utf8"));
    state.pages[0].fields.push(headerField);
    state.constraints[headerField.id] = { type: "image", maxBytes: 32768,
        mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] };
    state.values[headerField.id] = "";
    state.pages.push({ page: "main", title: "Main", description: "", fields: [logoField] });
    state.constraints[field.id] = { type: "image", maxBytes: 32768,
        mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] };
    state.values[field.id] = "";
    state.controls = [JSON.parse(await readFile(
        new URL("controls/stock-image/control.json", extensionRoot), "utf8"))];
    state.adapters = { "stock.image": "canvas-stock-image-designer" };
    const shell = await startPreparedShell(state);
    try {
        await page.goto(shell.url);
        await page.getByRole("tab", { name: "Main" }).click();
        const picker = page.getByLabel(field.label);
        const feedback = page.locator(`#${await picker.getAttribute("id")}-error`);
        await expect(feedback).toHaveAttribute("role", "alert");
        await expect(picker).toHaveAttribute("aria-describedby", await feedback.getAttribute("id"));

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
        await expect(feedback).toBeHidden();
        await expect(picker).not.toHaveAttribute("aria-invalid");
        await page.getByRole("button", { name: "Remove" }).click();
        await expect(feedback).toBeHidden();

        await page.getByRole("tab", { name: "Essentials" }).click();
        const headerPicker = page.getByLabel(headerField.label);
        const headerFeedback = page.locator(`#${await headerPicker.getAttribute("id")}-error`);
        await headerPicker.setInputFiles({ name: "header-too-large.png", mimeType: "image/png",
            buffer: Buffer.alloc(32988) });
        await expect(headerFeedback).toContainText("32,988 bytes");
        await expect(headerFeedback).toContainText("32,768 bytes (32 KiB)");
        await expect(headerFeedback).toBeVisible();
    } finally {
        await shell.close();
    }
});

test("configured image reports an incompatible Designer adapter beside its field", async ({ page }) => {
    const state = await model();
    const { field } = JSON.parse(await readFile(new URL("stock-logo.json", templateRoot), "utf8"));
    state.pages[0].fields.push(field);
    state.constraints[field.id] = { type: "image", maxBytes: 32768,
        mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] };
    state.values[field.id] = "";
    state.controls = [JSON.parse(await readFile(
        new URL("controls/stock-image/control.json", extensionRoot), "utf8"))];
    state.adapters = { "stock.image": "canvas-stock-image-designer" };
    const shell = await startPreparedShell(state);
    try {
        await page.route(/\/adapters\/canvas-stock-image-designer\.mjs/, (route) =>
            route.fulfill({ contentType: "text/javascript", body:
                'export const controlId = "wrong"; export const valueContract = { type: "image" }; export function mount() {}' }));
        await page.goto(shell.url);
        await expect(page.locator('[role="alert"]').filter({
            hasText: "Could not load Header logo: Incompatible control ID or value contract",
        })).toBeVisible();
    } finally {
        await shell.close();
    }
});

test("isolated test preset resolves through Specify and renders its contributed stock field", async ({ page }) => {
    const available = spawnSync("specify", ["--version"], { encoding: "utf8" });
    if (available.error?.code === "ENOENT") {
        test.skip(true, "Specify CLI is unavailable for the optional integration probe");
        return;
    }
    expect(available.status, available.stderr).toBe(0);
    expect(supportsSpecifyVersion(available.stdout), available.stdout).toBe(true);
    const workspace = await mkdtemp(join(tmpdir(), "designer-preset-e2e-"));
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
            return result.stdout;
        };
        run("init", "--here", "--force", "--non-interactive", "--ignore-agent-tools",
            "--integration", "copilot", "--integration-options=--skills",
            "--script", process.platform === "win32" ? "ps" : "sh");
        run("extension", "add", fileURLToPath(extensionRoot), "--dev", "--force");
        run("preset", "add", "--dev", fileURLToPath(presetRoot));
        const command = await readFile(join(project, ".github", "skills",
            "speckit-extension-canvas-design-load-page", "SKILL.md"), "utf8");
        expect(command).toContain("## Additional Designer pages\n\n- `canvas-settings-pr1-test`");
        expect(command).toContain("## Additional Canvas Design templates\n\n- `canvas-contribution-pr1-test`");
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
        const pages = ["canvas-settings-setup", "canvas-settings-artifacts",
            "canvas-settings-appearance", "canvas-settings-pr1-test"]
            .map((name) => { const { sourceId: _sourceId, ...entry } = resolve(name);
                return { ...entry, kind: "designer.page", strategy: "replace" }; });
        const templates = [{ ...resolve("canvas-contribution-pr1-test"),
            kind: "designer.field", strategy: "replace" },
        ...scalarRegistrations(resolve)];
        expect(templates[0].sourceId).toBe("copilot-canvas-design-test");
        const folder = handoffDirectory(workspace, handoff.handoffId);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "handoff.json"), JSON.stringify(handoff));
        const resolved = await loadResolvedDesignerPages(handoff, project, pages, templates);
        expect(resolved.pages.map((item) => item.title)).toEqual(
            ["Essentials", "Artifacts", "Appearance", "Test settings"]);
        expect(resolved.pages[3].fields.map((item) => item.id)).toEqual(["pr1Test.label"]);
        expect(resolved.values["pr1Test.label"]).toBe("");
        shell = await startShell(handoff,
            await loadDesignerSettings(workspace, handoff, resolved), { project, workspace });
        await page.goto(shell.url);
        await page.getByRole("tab", { name: "Test settings" }).click();
        const field = page.getByRole("textbox", { name: "Test label" });
        await expect(field).toBeVisible();
        await field.fill("Visible from preset");
        await page.getByRole("tab", { name: "Essentials" }).click();
        await page.getByRole("textbox", { name: "Canvas ID (required)" }).fill("pr1-test");
        await page.getByRole("textbox", { name: "Title (required)" }).fill("PR1 test");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator("#action-message")).toHaveText("Settings saved.");
        const saved = await loadDesignerSettings(workspace, handoff,
            await loadResolvedDesignerPages(handoff, project, pages, templates));
        expect(saved.values["pr1Test.label"]).toBe("Visible from preset");
        reopened = await startShell(handoff, saved, { project, workspace });
        await page.goto(reopened.url);
        await page.getByRole("tab", { name: "Test settings" }).click();
        await expect(page.getByRole("textbox", { name: "Test label" })).toHaveValue("Visible from preset");
    } finally {
        await reopened?.close();
        await shell?.close();
        await rm(workspace, { recursive: true, force: true });
    }
});

test("Billing preset resolves, saves and reopens Cost code, then generates its read-only value", async ({ page }) => {
    const available = spawnSync("specify", ["--version"], { encoding: "utf8" });
    if (available.error?.code === "ENOENT") {
        test.skip(true, "Specify CLI is unavailable for the optional integration probe");
        return;
    }
    expect(available.status, available.stderr).toBe(0);
    const workspace = await mkdtemp(join(tmpdir(), "billing-preset-e2e-"));
    const project = join(workspace, "project");
    const workflow = { selectedPhases: ["specify"],
        installed: { presets: [], extensions: [], bundles: [] } };
    const selections = { presets: [], extensions: [], bundles: [] };
    const handoff = { schemaVersion: 1, handoffId: "billing-test", workflow, selections,
        sourceFingerprint: fingerprint({ workflow, selections }) };
    let shell, reopened;
    try {
        await mkdir(project);
        const run = (...args) => {
            const result = spawnSync("specify", args, { cwd: project, encoding: "utf8",
                timeout: 120000, env: { ...process.env, COLUMNS: "500" } });
            expect(result.error, `${args.join(" ")}: ${result.error}`).toBeUndefined();
            expect(result.status, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`).toBe(0);
            return result.stdout;
        };
        run("init", "--here", "--force", "--non-interactive", "--ignore-agent-tools",
            "--integration", "copilot", "--integration-options=--skills",
            "--script", process.platform === "win32" ? "ps" : "sh");
        run("extension", "add", fileURLToPath(extensionRoot), "--dev", "--force");
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
        const pages = ["canvas-settings-setup", "canvas-settings-artifacts",
            "canvas-settings-appearance", "canvas-settings-billing"]
            .map((name) => { const { sourceId: _sourceId, ...entry } = resolve(name);
                return { ...entry, kind: "designer.page", strategy: "replace" }; });
        const templates = [{ ...resolve("canvas-contributions-billing"),
            kind: "designer.field", strategy: "replace" },
        ...scalarRegistrations(resolve)];
        expect(templates[0].sourceId).toBe("copilot-billing-canvas-test");
        const folder = handoffDirectory(workspace, handoff.handoffId);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "handoff.json"), JSON.stringify(handoff));
        const resolved = await loadResolvedDesignerPages(handoff, project, pages, templates);
        expect(resolved.pages.map((item) => item.title)).toEqual(
            ["Essentials", "Artifacts", "Appearance", "Billing"]);
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
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator("#action-message")).toHaveText("Settings saved.");
        const saved = await loadDesignerSettings(workspace, handoff,
            await loadResolvedDesignerPages(handoff, project, pages, templates));
        expect(saved.values["billing.costCode"]).toBe("CC-481");
        reopened = await startShell(handoff, saved, { project, workspace,
            session: { send: async () => {} } });
        await page.goto(reopened.url);
        await page.getByRole("tab", { name: costPage.title }).click();
        await expect(page.getByRole("textbox", { name: "Cost code" })).toHaveValue("CC-481");
        await page.getByRole("button", { name: "Generate", exact: true }).click();
        await expect(page.locator("#conn-status")).toContainText("Generation queued:");
        const [requestId] = await readdir(join(folder, "generations"));
        await materialize(project, workspace, handoff.handoffId, requestId);
        const config = JSON.parse(await readFile(join(project, ".github", "extensions",
            "billing-canvas", "canvas-config.json"), "utf8"));
        expect(config.readOnlyFields).toEqual([{ id: "billing.costCode",
            label: "Cost code", value: "CC-481",
            section: { id: "billing", title: "Billing" } }]);
        await page.setContent(renderHtml(config));
        await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Configured fields" })).toHaveCount(0);
        await expect(page.locator('[data-field-id="billing.costCode"]')).toHaveText("CC-481");
        await expect(page.getByRole("textbox", { name: "Cost code" })).toHaveCount(0);
    } finally {
        await reopened?.close();
        await shell?.close();
        await rm(workspace, { recursive: true, force: true });
    }
});

test("risk preset selects a cell by keyboard and packages its read-only adapter", async ({ page }) => {
    test.setTimeout(150_000);
    const available = spawnSync("specify", ["--version"], { encoding: "utf8" });
    if (available.error?.code === "ENOENT") {
        test.skip(true, "Specify CLI is unavailable for the optional integration probe");
        return;
    }
    expect(available.status, available.stderr).toBe(0);
    const workspace = await mkdtemp(join(tmpdir(), "risk-preset-e2e-"));
    const project = join(workspace, "project");
    const handoff = {
        schemaVersion: 1, handoffId: "risk-test",
        workflow: { selectedPhases: ["specify"],
            installed: { presets: [], extensions: [], bundles: [] } },
        selections: { presets: [], extensions: [], bundles: [] },
    };
    handoff.sourceFingerprint = fingerprint({
        workflow: handoff.workflow, selections: handoff.selections,
    });
    let shell, reopened, broken, incompatible, brokenContext, server;
    try {
        await mkdir(project);
        const run = (...args) => {
            const result = spawnSync("specify", args, {
                cwd: project, encoding: "utf8", timeout: 120000,
                env: { ...process.env, COLUMNS: "500" },
            });
            expect(result.error, `${args.join(" ")}: ${result.error}`).toBeUndefined();
            expect(result.status, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`).toBe(0);
            return result.stdout;
        };
        run("init", "--here", "--force", "--non-interactive", "--ignore-agent-tools",
            "--integration", "copilot", "--integration-options=--skills",
            "--script", process.platform === "win32" ? "ps" : "sh");
        run("extension", "add", fileURLToPath(extensionRoot), "--dev", "--force");
        run("preset", "add", "--dev", fileURLToPath(riskRoot));
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
        const pages = ["canvas-settings-setup", "canvas-settings-artifacts", "canvas-settings-appearance"]
            .map((name) => { const { sourceId: _sourceId, ...entry } = resolve(name);
                return { ...entry, kind: "designer.page", strategy: "replace" }; });
        const templates = [
            ["canvas-control-risk-matrix", "control.definition"],
            ["canvas-contributions-risk-designer", "designer.field"],
            ["canvas-control-risk-matrix-designer", "designer.adapter"],
            ["canvas-control-risk-matrix-generated", "generated.adapter"],
        ].map(([name, kind]) => ({ ...resolve(name), kind, strategy: "replace" }));
        templates.push(...scalarRegistrations(resolve));
        templates.push(...["canvas-stock-description", "canvas-stock-workflow-heading"]
            .map((name) => ({ ...resolve(name), kind: "designer.field", strategy: "replace" })));
        const folder = handoffDirectory(workspace, handoff.handoffId);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "handoff.json"), JSON.stringify(handoff));
        const load = async () => loadDesignerSettings(workspace, handoff,
            await loadResolvedDesignerPages(handoff, project, pages, templates));
        shell = await startShell(handoff, await load(), { project, workspace,
            session: { send: async () => {} } });
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
            session: { send: async () => {} } });
        await page.goto(reopened.url);
        await expect(page.getByRole("radio",
            { name: "Impact medium, likelihood medium" })).toHaveAttribute("aria-checked", "true");
        await page.getByRole("button", { name: "Generate", exact: true }).click();
        await expect(page.locator("#conn-status")).toContainText("Generation queued:");
        const [requestId] = await readdir(join(folder, "generations"));
        await materialize(project, workspace, handoff.handoffId, requestId);
        const portable = join(workspace, "portable-risk");
        await cp(join(project, ".github", "extensions", "risk-canvas"), portable, { recursive: true });
        const { readConfig, createWorkflowRoutes } = await import(
            pathToFileURL(join(portable, "server.mjs")).href);
        const config = readConfig();
        expect(config.generatedControls[0].value).toEqual({
            impact: "medium", likelihood: "medium",
        });
        const routes = createWorkflowRoutes(config, {
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
        const designerAdapter = await readFile(templates[2].path, "utf8");
        await writeFile(templates[2].path, "export const mount = null;");
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
        brokenContext = await page.context().browser().newContext();
        const brokenPage = await brokenContext.newPage();
        await brokenPage.goto(`http://127.0.0.1:${server.address().port}/?token=risk-token`);
        await expect(brokenPage.getByRole("alert")).toContainText(
            "Generated control could not render: Missing mount export");
    } finally {
        await brokenContext?.close();
        if (server) await new Promise((resolve) => server.close(resolve));
        await incompatible?.close();
        await broken?.close();
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
            "canvas.workflowListName", "workflowSlug.userProvided"]) {
            delete state.constraints[field];
            delete state.values[field];
        }
    }
    const shell = await startPreparedShell(state);
    await page.goto(shell.url);
    return shell;
}

test("Essentials offers a default-off custom slug toggle independently of Workflow header", async ({ page }) => {
    const shell = await openDesigner(page);
    try {
        await expect(page.getByRole("tab")).toHaveText(["Essentials", "Artifacts", "Appearance"]);
        const id = page.getByRole("textbox", { name: "Canvas ID (required)" });
        const title = page.getByRole("textbox", { name: "Title (required)" });
        await expect(page.getByRole("textbox")).toHaveCount(4);
        const customSlug = page.getByRole("checkbox", { name: "Allow custom slug" });
        await expect(customSlug).toHaveCount(1);
        await expect(customSlug).not.toBeChecked();
        await expect(customSlug).toHaveAttribute("aria-description",
            "Lets users specify the slug used as the directory name for generated artifacts. Otherwise, Spec Kit chooses a default.");
        await expect(id).toHaveAttribute("pattern", "^[a-z0-9][a-z0-9-]*$");
        await expect(id).toHaveAttribute("aria-describedby", "setting-field-0-hint setting-field-0-error");
        await expect(page.locator("#setting-field-0-hint"))
            .toHaveText("Use 1–100 characters: lowercase letters (a–z), numbers (0–9), and hyphens (-). Start with a letter or number. Reserved IDs cannot be used.");
        await expect(title).toHaveAttribute("maxlength", "120");
        await expect(page.getByRole("textbox", { name: "Description" })).toHaveAttribute("maxlength", "240");
        await expect(page.getByRole("textbox", { name: "Workflow header" })).toHaveAttribute("maxlength", "80");
        await customSlug.check();
        await id.fill("example-canvas");
        for (const name of ["Artifacts", "Appearance"]) {
            await page.getByRole("tab", { name }).click();
            await expect(page.getByText("This template defines no fields.")).toBeVisible();
        }
        await page.getByRole("tab", { name: "Essentials" }).click();
        await expect(id).toHaveValue("example-canvas");
        await expect(customSlug).toBeChecked();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
        await expect(page.getByRole("status")).toHaveText("Ready");
    } finally {
        await shell.close();
    }
});

test("required stock text reports nonblank errors alongside its field and rejects Save", async ({ page }) => {
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
        const titleError = page.locator("#setting-field-1-error");
        await expect(titleError).toHaveText("Enter a nonblank Title.");
        await expect(title).toHaveAttribute("aria-invalid", "true");
        await title.fill("Required Canvas");
        await expect(titleError).toBeHidden();
        await description.fill("   ");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(description).toBeFocused();
        await expect(page.locator("#setting-field-2-error"))
            .toHaveText("Enter a nonblank Description.");
        await expect(page.locator("#page-error")).toContainText("Enter a valid Description");
        await description.fill("A valid description");
        await expect(page.locator("#setting-field-2-error")).toBeHidden();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator("#action-message")).toHaveText("Settings saved.");
    } finally {
        await shell.close();
    }
});

test("missing Generate skill explains why the action is disabled", async ({ page }) => {
    const workspace = await mkdtemp(join(tmpdir(), "designer-generate-unavailable-"));
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
            "Canvas Design does not provide Generate in this session. Launch a new Designer session using extension-canvas-design v0.1.14 or the current local source.");
        await page.getByRole("textbox", { name: "Canvas ID (required)" }).fill("new-canvas");
        await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
        await expect(page.locator("#generation-error")).toBeVisible();
    } finally {
        await shell?.close();
        await rm(workspace, { recursive: true, force: true });
    }
});

test("handoff cannot serve a loading shell without validated pages", async () => {
    await expect(startShell({ handoffId: "test" })).rejects.toThrow(/validated before opening/);
});

test("failed optional page shows safe diagnostics while Essentials remains editable", async ({ page }) => {
    const shell = await openWithError(page, "canvas-settings-artifacts");
    try {
        await expect(page.getByRole("status")).toHaveText("Pages need attention (1)");
        const id = page.getByRole("textbox", { name: "Canvas ID (required)" });
        await id.fill("my-canvas");
        await page.getByRole("tab", { name: "canvas-settings-artifacts (error)" }).click();
        await expect(page.getByRole("heading", { name: "Could not load canvas-settings-artifacts" })).toBeVisible();
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

test("Save validates values, persists edits and reports stale revisions", async ({ page }) => {
    const workspace = await mkdtemp(join(tmpdir(), "designer-save-e2e-"));
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
        await expect(page.locator("#page-error")).toContainText("Enter a valid Canvas ID");
        await expect(page.locator('[name="canvas.id"]')).toBeFocused();
        await expect(page.locator("#page-error")).toContainText("lowercase letters (a–z), numbers (0–9), and hyphens (-)");
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
    const shell = await openWithError(page, "canvas-settings-setup");
    try {
        await expect(page.getByRole("tab", { name: "canvas-settings-setup (error)" }))
            .toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("heading", { name: "Could not load canvas-settings-setup" })).toBeVisible();
        await expect(page.getByRole("textbox")).toHaveCount(0);
        await page.getByRole("tab", { name: "Artifacts" }).click();
        await expect(page.getByText("This template defines no fields.")).toBeVisible();
        await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
    } finally {
        await shell.close();
    }
});

test("failed Essentials stays selected when a custom page sorts before it", async ({ page }) => {
    const state = await model();
    state.pages[0] = { page: "canvas-settings-setup", title: "canvas-settings-setup", order: 10,
        error: { name: "canvas-settings-setup", path: "C:\\project\\.specify\\missing.json",
            reason: "resolved page file is missing" } };
    state.pages.push({ page: "custom-settings", id: "custom-settings", title: "Custom",
        order: 5, fields: [] });
    state.pages.sort((a, b) => a.order - b.order);
    const shell = await startPreparedShell(state);
    try {
        await page.goto(shell.url);
        await expect(page.getByRole("tab", { name: "canvas-settings-setup (error)" }))
            .toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("heading", { name: "Could not load canvas-settings-setup" }))
            .toBeVisible();
    } finally {
        await shell.close();
    }
});
