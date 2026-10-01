import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { startShell } from "../../speckit-canvas-designer/server.mjs";

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
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
        await expect(page.getByRole("status")).toHaveText("Ready");
    } finally {
        await page.close();
        await shell.close();
    }
});

test("handoff cannot serve a loading shell without validated pages", async () => {
    await expect(startShell({ handoffId: "test" })).rejects.toThrow(/validated before opening/);
});
