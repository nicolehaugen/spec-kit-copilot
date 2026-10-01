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

async function openDesigner(page, reload) {
    const shell = await startShell({ handoffId: "test" }, await model(), { reload });
    await page.goto(shell.url);
    return shell;
}

test("Essentials renders the five registered controls; other pages and actions remain empty", async ({ page }) => {
    const shell = await openDesigner(page, async () => ({ queued: true }));
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
        await expect(page.getByRole("status")).toHaveText("Live");
    } finally {
        await page.close();
        await shell.close();
    }
});

test("explicit reload preserves drafts on error and replaces them only after success", async ({ page }) => {
    let shell, attempts = 0;
    shell = await openDesigner(page, async () => {
        attempts += 1;
        if (attempts === 1) {
            setImmediate(() => shell.update(undefined,
                { pending: false, error: "canvas-settings-extra: not found" }));
        } else {
            const next = await model("second");
            next.pages[0].fields[1].label = "Custom title";
            setImmediate(() => shell.update(next, { pending: false, error: "" }));
        }
        return { queued: true };
    });
    try {
        const id = page.getByRole("textbox", { name: "Canvas ID (required)" });
        await id.fill("keep-draft");
        await page.getByRole("button", { name: "Reload pages", exact: true }).click();
        await expect(page.getByRole("alertdialog")).toBeVisible();
        await page.getByRole("button", { name: "Cancel" }).click();
        expect(attempts).toBe(0);
        await expect(id).toHaveValue("keep-draft");
        await page.getByRole("button", { name: "Reload pages", exact: true }).click();
        await page.getByRole("button", { name: "Discard and reload" }).click();
        await expect(page.getByRole("alert")).toContainText("not found");
        await expect(id).toHaveValue("keep-draft");
        await page.getByRole("button", { name: "Reload pages", exact: true }).click();
        await page.getByRole("button", { name: "Discard and reload" }).click();
        await expect(page.getByRole("textbox", { name: "Custom title (required)" })).toBeVisible();
        await expect(id).toHaveValue("");
        expect(attempts).toBe(2);
    } finally {
        await page.close();
        await shell.close();
    }
});
