import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test, expect } from "./playwright.mjs";
import { validateLocalSource } from "../../plugins/spec-kit-copilot-wizard/extensions/speckit-wizard-canvas/server/designer-local-sources.mjs";

const ui = new URL("../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/ui/",
    import.meta.url);
const extension = new URL("../../spec-kit-extensions/extension-canvas-design/", import.meta.url);
const stockControls = new URL("../../spec-kit-extensions/extension-canvas-design/shared-controls/",
    import.meta.url);
const subAgents = await validateLocalSource("presets", fileURLToPath(
    new URL("../../spec-kit-presets/copilot-sub-agents/", import.meta.url)));

async function openDesigner(page, fields, extraPage, warnings = [], templates = []) {
    const controls = await Promise.all(["stock-text", "stock-checkbox"].map(async (name) =>
        JSON.parse(await readFile(new URL(`${name}/control.json`, stockControls), "utf8"))));
    const constraints = {
        "canvas.id": { type: "string", minLength: 1, maxLength: 100,
            pattern: "^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9][a-z0-9-]*$" },
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
    for (const field of [...fields, ...(extraPage?.fields ?? [])]) {
        field.validation = { ...constraints[field.id],
            ...(field.id === "canvas.id" ? { forbiddenValues: [
                "speckit-canvas-designer", "speckit-wizard", "speckit-canvas-generator",
            ] } : {}) };
    }
    const state = { handoffId: "test", revision: "test", generationAvailable: true,
        settingsRevision: 0, persisted: false, templates, controls,
        adapters: { "stock.text": "designer-control-adapter-text",
            "stock.checkbox": "designer-control-adapter-checkbox" },
        pages: [{ page: "designer-essentials", title: "Essentials", order: 10,
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
            const request = route.request().postDataJSON();
            requests.push(request);
            const invalid = !/^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9][a-z0-9-]*$/.test(request.values["canvas.id"])
                ? "Canvas ID (canvas.id)"
                : !request.values["canvas.displayName"]?.trim() ? "Title (canvas.displayName)"
                    : request.values["billing.costCode"]?.length > 64
                        ? "Cost code (billing.costCode)" : null;
            await route.fulfill(invalid
                ? { status: 400, json: { error: `Invalid ${invalid}` } }
                : { status: 202, json: { target: ".github/extensions/test/", warnings } });
        } else if (path === "/adapters/designer-control-adapter-text.mjs"
            || path === "/adapters/designer-control-adapter-checkbox.mjs") {
            const name = path.includes("checkbox") ? "stock-checkbox" : "stock-text";
            await route.fulfill({ body: await readFile(new URL(`shared-controls/${name}/designer.mjs`, extension)),
                contentType: "text/javascript" });
        } else if (path === "/" || path === "/ui/app.js" || path === "/ui/styles.css"
            || path === "/ui/identity-control.js" || path === "/ui/outputs-control.js"
            || path === "/ui/control-adapter-contract.js"
            || path === "/ui/badges-control.js" || path === "/ui/badge-duplicates.js") {
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

test("Generate remains queued and displays installed-version warnings", async ({ page }) => {
    const warning = `presets ${subAgents.id}: Wizard version ${subAgents.version}, installed version unverified.`;
    const requests = await openDesigner(page, core, undefined,
        [warning]);
    await page.getByRole("textbox", { name: /Canvas ID/ }).fill("stock-canvas");
    await page.getByRole("textbox", { name: /Title/ }).fill("Stock Canvas");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect(page.locator("#action-message"))
        .toContainText(`Warning: ${warning}`);
    expect(requests).toHaveLength(1);
});

test("computed provider approval cancels without sending and submits the approved source and hash", async ({ page }) => {
    const provider = await readFile(new URL(
        "../fixtures/test-presets/copilot-canvas-values-test/values/workflow.mjs", import.meta.url));
    const approved = { name: "canvas-value-workflow-provider",
        sourceId: "copilot-canvas-values-test",
        hash: createHash("sha256").update(provider).digest("hex") };
    const requests = await openDesigner(page, core, undefined, [], [
        { ...approved, kind: "generated.computed-value-provider" },
    ]);
    await page.getByRole("textbox", { name: /Canvas ID/ }).fill("provider-canvas");
    await page.getByRole("textbox", { name: /Title/ }).fill("Provider Canvas");
    const generate = page.getByRole("button", { name: "Generate", exact: true });
    await generate.click();
    const dialog = page.getByRole("dialog", { name: "Approve generated value providers" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(approved.name);
    await expect(dialog).toContainText(`Source: ${approved.sourceId}`);
    await expect(dialog).toContainText(`SHA-256: ${approved.hash}`);
    await expect(generate).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(generate).toBeEnabled();
    expect(requests).toHaveLength(0);
    await generate.click();
    await dialog.getByRole("button", { name: "Approve and Generate" }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].approvedProviders).toEqual([approved]);
    await expect(generate).toBeDisabled();
    await expect(page.locator("#conn-status")).toContainText("Generation queued:");
});

test("stock Essentials keep five ordered controls and Generate submits all enabled values", async ({ page }) => {
    const requests = await openDesigner(page, [...core, ...stock]);
    await expect(page.locator(".settings-field label")).toHaveText([
        "Canvas ID (required)", "Title (required)", "Description",
        "Workflow header", "Allow custom slug",
    ]);
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect(page.locator("#page-error")).toContainText("Invalid Canvas ID (canvas.id)");
    await page.getByRole("textbox", { name: /Canvas ID/ }).fill("stock-canvas");
    await page.getByRole("textbox", { name: /Title/ }).fill("Stock Canvas");
    await page.getByRole("textbox", { name: "Description" }).fill("A description");
    await page.getByRole("textbox", { name: "Workflow header" }).fill("My workflows");
    await page.getByRole("checkbox", { name: "Allow custom slug" }).check();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].values).toEqual({
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
    await expect(page.locator("#page-error")).toContainText("Invalid Cost code (billing.costCode)");
    expect(requests).toHaveLength(1);
    await page.getByRole("textbox", { name: "Cost code" }).fill("CC-481");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].values).toEqual({
        "canvas.id": "minimal-canvas", "canvas.displayName": "Minimal Canvas",
        "billing.costCode": "CC-481",
    });
});

test("Generate focuses a field whose label contains parentheses", async ({ page }) => {
    await openDesigner(page, core, { page: "canvas-settings-billing",
        title: "Billing", order: 20, fields: [{ id: "billing.costCode", label: "Risk (high)" }] });
    await page.route("**/api/generate?*", (route) => route.fulfill({
        status: 400, json: { error: "Invalid Risk (high) (billing.costCode)" },
    }));
    await page.getByRole("textbox", { name: /Canvas ID/ }).fill("risk-canvas");
    await page.getByRole("textbox", { name: /Title/ }).fill("Risk Canvas");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Billing" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".settings-field-error")).toBeVisible();
    await expect(page.locator(".settings-field")).toBeFocused();
    await expect(page.locator("#page-error")).toHaveText("Invalid Risk (high) (billing.costCode)");
});
