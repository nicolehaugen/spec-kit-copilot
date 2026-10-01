import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startShell } from "../../speckit-canvas-designer/server.mjs";
import { fingerprint, handoffDirectory } from "../../speckit-canvas-designer/handoff.mjs";
import { loadDesignerSettings } from "../../speckit-canvas-designer/settings.mjs";

const templateRoot = new URL("../../../../../spec-kit-extensions/extension-canvas-design/pages/", import.meta.url);

async function model(revision = "first") {
    const pages = [];
    for (const name of ["setup", "artifacts", "appearance", "results"]) {
        const document = JSON.parse(await readFile(new URL(`${name}.json`, templateRoot), "utf8"));
        pages.push({ ...document, page: document.id });
    }
    return {
        pages, revision,
        constraints: {
            "canvas.id": { type: "string", minLength: 1, maxLength: 100,
                pattern: "^[a-z0-9][a-z0-9-]*$" },
            "canvas.displayName": { type: "string", minLength: 1, maxLength: 120 },
            "canvas.description": { type: "string", maxLength: 240 },
            "canvas.workflowListName": { type: "string", maxLength: 80 },
            "workflowSlug.userProvided": { type: "boolean" },
        },
        values: { "canvas.id": "", "canvas.displayName": "", "canvas.description": "",
            "canvas.workflowListName": "", "workflowSlug.userProvided": false },
    };
}

async function openDesigner(page) {
    const shell = await startShell({ handoffId: "test" }, await model());
    await page.goto(shell.url);
    return shell;
}

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
    const shell = await startShell({ handoffId: "test" }, state);
    await page.goto(shell.url);
    return shell;
}

test("Essentials renders the five registered controls; other pages and actions remain empty", async ({ page }) => {
    const shell = await openDesigner(page);
    try {
        await expect(page.getByRole("tab")).toHaveText(["Essentials", "Artifacts", "Appearance", "Result Badges"]);
        const id = page.getByRole("textbox", { name: "Canvas ID (required)" });
        const title = page.getByRole("textbox", { name: "Title (required)" });
        const slug = page.getByRole("checkbox", { name: "Show slug field" });
        await expect(page.getByRole("textbox")).toHaveCount(4);
        await expect(id).toHaveAttribute("pattern", "^[a-z0-9][a-z0-9-]*$");
        await expect(title).toHaveAttribute("maxlength", "120");
        await expect(page.getByRole("textbox", { name: "Description" })).toHaveAttribute("maxlength", "240");
        await expect(page.getByRole("textbox", { name: "Workflow header" })).toHaveAttribute("maxlength", "80");
        await id.fill("example-canvas");
        await slug.check();
        for (const name of ["Artifacts", "Appearance", "Result Badges"]) {
            await page.getByRole("tab", { name }).click();
            await expect(page.getByText("This template defines no fields.")).toBeVisible();
        }
        await page.getByRole("tab", { name: "Essentials" }).click();
        await expect(id).toHaveValue("example-canvas");
        await expect(slug).toBeChecked();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
        await expect(page.getByRole("status")).toHaveText("Ready");
    } finally {
        await shell.close();
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
    const shell = await startShell(handoff, initial, workspace);
    const staleShell = await startShell(handoff, initial, workspace);
    try {
        await page.goto(shell.url);
        const save = page.getByRole("button", { name: "Save", exact: true });
        await save.click();
        await expect(page.getByRole("alert")).toContainText("Enter a valid Canvas ID");
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
        const reopened = await startShell(handoff, reopenedModel, workspace);
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
    const shell = await startShell({ handoffId: "test" }, state);
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
