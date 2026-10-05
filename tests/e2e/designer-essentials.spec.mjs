import { readFile } from "node:fs/promises";
import { test, expect } from "./playwright.mjs";

const ui = new URL("../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/ui/",
    import.meta.url);
const stockControls = new URL("../../spec-kit-extensions/extension-canvas-design/controls/",
    import.meta.url);

async function openDesigner(page, fields, extraPage) {
    const controls = await Promise.all(["stock-text", "stock-checkbox"].map(async (name) =>
        JSON.parse(await readFile(new URL(`${name}/control.json`, stockControls), "utf8"))));
    const constraints = {
        "canvas.id": { type: "string", minLength: 1, maxLength: 100,
            pattern: "^[a-z0-9][a-z0-9-]*$" },
        "canvas.displayName": { type: "string", minLength: 1, maxLength: 120 },
        "canvas.description": { type: "string", maxLength: 240 },
        "canvas.workflowListName": { type: "string", maxLength: 80 },
        "workflowSlug.userProvided": { type: "boolean" },
        "billing.costCode": { type: "string", maxLength: 64 },
    };
    const values = { "canvas.id": "", "canvas.displayName": "",
        "canvas.description": "", "canvas.workflowListName": "",
        "workflowSlug.userProvided": false, "billing.costCode": "" };
    const ids = [...fields, ...(extraPage?.fields ?? [])].map((field) => field.id);
    const state = { handoffId: "test", revision: "test", generationAvailable: true,
        settingsRevision: 0, persisted: false, controls,
        adapters: { "stock.text": "canvas-stock-text-designer",
            "stock.checkbox": "canvas-stock-checkbox-designer" }, templates: [],
        pages: [{ page: "canvas-settings-setup", title: "Essentials", order: 10,
            description: "Configure your canvas.", fields },
        ...(extraPage ? [extraPage] : [])],
        constraints: Object.fromEntries(ids.map((id) => [id, constraints[id]])),
        values: Object.fromEntries(ids.map((id) => [id, values[id]])) };
    const requests = [];
    await page.route("**/*", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/state") {
            await route.fulfill({ json: state });
        } else if (path === "/api/generate") {
            requests.push(route.request().postDataJSON());
            await route.fulfill({ status: 202, json: { target: ".github/extensions/test/" } });
        } else if (path.startsWith("/adapters/")) {
            const type = path.match(/^\/adapters\/canvas-stock-(text|checkbox)-designer\.mjs$/)?.[1];
            if (!type) throw new Error(`Unexpected Designer adapter request: ${path}`);
            await route.fulfill({ body: await readFile(new URL(`stock-${type}/designer.mjs`, stockControls)),
                contentType: "text/javascript" });
        } else if (path === "/" || path === "/ui/app.js" || path === "/ui/styles.css") {
            const file = path === "/" ? "index.html" : path.slice(4);
            await route.fulfill({ body: await readFile(new URL(file, ui)), contentType:
                file.endsWith(".html") ? "text/html" : file.endsWith(".css")
                    ? "text/css" : "text/javascript" });
        } else await route.continue();
    });
    await page.goto("/?token=designer-essentials-test");
    await expect(page.getByRole("heading", { name: "Essentials" })).toBeVisible();
    return requests;
}

const core = [{ id: "canvas.id", label: "Canvas ID" },
    { id: "canvas.displayName", label: "Title" }];
const stock = [{ id: "canvas.description", label: "Description" },
    { id: "canvas.workflowListName", label: "Workflow header" },
    { id: "workflowSlug.userProvided", label: "Allow custom slug", type: "boolean" }];

test("stock Essentials keep five ordered controls and Generate submits all enabled values", async ({ page }) => {
    const requests = await openDesigner(page, [...core, ...stock]);
    await expect(page.locator(".settings-field label")).toHaveText([
        "Canvas ID (required)", "Title (required)", "Description",
        "Workflow header", "Allow custom slug",
    ]);
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect(page.locator("#page-error")).toContainText("valid Canvas ID before generating");
    await page.getByRole("textbox", { name: /Canvas ID/ }).fill("stock-canvas");
    await page.getByRole("textbox", { name: /Title/ }).fill("Stock Canvas");
    await page.getByRole("textbox", { name: "Description" }).fill("A description");
    await page.getByRole("textbox", { name: "Workflow header" }).fill("My workflows");
    await page.getByRole("checkbox", { name: "Allow custom slug" }).check();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].values).toEqual({
        "canvas.id": "stock-canvas", "canvas.displayName": "Stock Canvas",
        "canvas.description": "A description", "canvas.workflowListName": "My workflows",
        "workflowSlug.userProvided": true,
    });
});

test("minimal Essentials work, while an invalid additional page visibly blocks Generate", async ({ page }) => {
    const requests = await openDesigner(page, core, { page: "canvas-settings-billing",
        title: "Billing", order: 20, error: { name: "canvas-settings-billing",
            path: "billing.json", reason: "Invalid Designer JSON" } });
    await expect(page.locator(".settings-field")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
    await expect(page.locator("#generation-error"))
        .toContainText("Cannot generate: canvas-settings-billing could not load. Invalid Designer JSON");
    await page.getByRole("tab", { name: /Billing/ }).click();
    await expect(page.getByText("Could not load canvas-settings-billing")).toBeVisible();
    expect(requests).toHaveLength(0);
});

test("minimal Essentials submit only identity and invalid enabled Billing values block Generate", async ({ page }) => {
    const requests = await openDesigner(page, core, { page: "canvas-settings-billing",
        title: "Billing", order: 20, fields: [{ id: "billing.costCode", label: "Cost code" }] });
    await page.getByRole("textbox", { name: /Canvas ID/ }).fill("minimal-canvas");
    await page.getByRole("textbox", { name: /Title/ }).fill("Minimal Canvas");
    await page.getByRole("tab", { name: "Billing" }).click();
    await page.locator('[name="billing.costCode"]').evaluate((input) => {
        input.maxLength = 100;
        input.value = "x".repeat(65);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect(page.locator("#page-error")).toContainText("valid Cost code before generating");
    expect(requests).toHaveLength(0);
    await page.getByRole("textbox", { name: "Cost code" }).fill("CC-481");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].values).toEqual({
        "canvas.id": "minimal-canvas", "canvas.displayName": "Minimal Canvas",
        "billing.costCode": "CC-481",
    });
});
