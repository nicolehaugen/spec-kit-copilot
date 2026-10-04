import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { startShell } from "../../speckit-canvas-designer/server.mjs";
import { fingerprint, handoffDirectory } from "../../speckit-canvas-designer/handoff.mjs";
import { loadResolvedDesignerPages } from "../../speckit-canvas-designer/pages.mjs";
import { loadDesignerSettings } from "../../speckit-canvas-designer/settings.mjs";
import { materialize } from "../../../../../spec-kit-extensions/extension-canvas-design/scripts/generate.mjs";
import { renderHtml } from "../../../../../spec-kit-extensions/extension-canvas-design/templates/generated-canvas/server.mjs";

const templateRoot = new URL("../../../../../spec-kit-extensions/extension-canvas-design/pages/", import.meta.url);
const extensionRoot = new URL("../../../../../spec-kit-extensions/extension-canvas-design/", import.meta.url);
const presetRoot = new URL("../../../../../spec-kit-presets/copilot-canvas-design-test/", import.meta.url);
const billingRoot = new URL("../../../../../spec-kit-presets/copilot-billing-canvas-test/", import.meta.url);

function supportsSpecifyVersion(output) {
    const version = output.match(/\bspecify\s+(\d+)\.(\d+)\.(\d+)\b/);
    if (!version) return false;
    const major = Number(version[1]);
    const minor = Number(version[2]);
    const patch = Number(version[3]);
    return major > 1 || (major === 1 && (minor > 0 || patch >= 7));
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
    return {
        pages, revision,
        constraints: {
            "canvas.id": { type: "string", minLength: 1, maxLength: 100,
                pattern: "^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9][a-z0-9-]*$" },
            "canvas.displayName": { type: "string", minLength: 1, maxLength: 120 },
            "canvas.description": { type: "string", maxLength: 240 },
            "canvas.workflowListName": { type: "string", maxLength: 80 },
            "workflowSlug.userProvided": { type: "boolean" },
        },
        values: { "canvas.id": "", "canvas.displayName": "", "canvas.description": "",
            "canvas.workflowListName": "", "workflowSlug.userProvided": false },
    };
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
        const shell = await startShell(handoff, state, { workspace });
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

test("isolated test preset resolves through Specify and saves contributed stock fields", async ({ page }) => {
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
        expect(command).toContain("## Additional Canvas Design templates\n\n- `canvas-contribution-pr1-test`\n- `canvas-contribution-pr1-toggle`");
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
            .map((name) => { const { sourceId: _sourceId, ...entry } = resolve(name); return entry; });
        const templates = ["canvas-contribution-pr1-test", "canvas-contribution-pr1-toggle"]
            .map(resolve);
        expect(templates[0].sourceId).toBe("copilot-canvas-design-test");
        const folder = handoffDirectory(workspace, handoff.handoffId);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "handoff.json"), JSON.stringify(handoff));
        const resolved = await loadResolvedDesignerPages(handoff, project, pages, templates);
        expect(resolved.pages.map((item) => item.title)).toEqual(
            ["Essentials", "Artifacts", "Appearance", "Test settings"]);
        expect(resolved.pages[3].fields.map((item) => item.id)).toEqual(
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
            .map((name) => { const { sourceId: _sourceId, ...entry } = resolve(name); return entry; });
        const templates = [resolve("canvas-contributions-billing")];
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
        await expect(id).toHaveAttribute("pattern",
            "^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9][a-z0-9-]*$");
        await expect(page.locator(`[id="${await id.getAttribute("aria-describedby")}"]`))
            .toHaveText("Use 1–100 characters: lowercase letters (a–z), numbers (0–9), and hyphens (-). Start with a letter or number. Reserved IDs, including Windows device names like con and com1, cannot be used.");
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
        shell = await startShell(handoff, await model(), { project, workspace,
            session: { send: async () => {} } });
        await page.goto(shell.url);
        await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
        await expect(page.locator("#generation-error")).toHaveText(
            "Canvas Design does not provide Generate in this session. Launch a new Designer session using extension-canvas-design v0.1.5 or the current local source.");
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
    const shell = await startShell(handoff, initial, { workspace });
    const staleShell = await startShell(handoff, initial, { workspace });
    try {
        await page.goto(shell.url);
        const save = page.getByRole("button", { name: "Save", exact: true });
        await save.click();
        await expect(page.getByRole("alert")).toContainText("Enter a valid Canvas ID");
        await expect(page.getByRole("alert")).toContainText("lowercase letters (a–z), numbers (0–9), and hyphens (-)");
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
        const reopened = await startShell(handoff, reopenedModel, { workspace });
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
