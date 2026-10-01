import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

// A real, valid preset directory in this repo — used to exercise the
// "Local development" add flow against an actual manifest on disk, matching
// how e2e/server.mjs wires getInstance() to the real repo root rather than a
// fixture workspace.
const LOCAL_PRESET_PATH = fileURLToPath(
    new URL("../../../../../spec-kit-presets/copilot-sub-agents", import.meta.url),
).replace(/[\\/]$/, "");

test.beforeEach(async ({ page }) => {
    await page.goto("/?token=e2e-token");
    await page.getByRole("tab", { name: "Phases" }).click();
    await page.getByRole("button", { name: "Generate canvas" }).click();
});

test("opens a design-only dialog with an available launch", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: "Canvas designer setup" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /Design preset/ })).toBeVisible();
    await expect(dialog.getByText("Other preset")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /Launch designer/ })).toBeEnabled();
    const presetsTab = dialog.getByRole("tab", { name: "Presets" });
    const extensionsTab = dialog.getByRole("tab", { name: "Extensions" });
    const bundlesTab = dialog.getByRole("tab", { name: "Bundles" });
    await expect(presetsTab).toHaveAttribute("tabindex", "0");
    await expect(extensionsTab).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("Tab");
    await expect(presetsTab).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(extensionsTab).toBeFocused();
    await expect(dialog.getByRole("tabpanel", { name: "Extensions" })).toBeVisible();
    await page.keyboard.press("End");
    await expect(bundlesTab).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(presetsTab).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(bundlesTab).toBeFocused();
    await page.keyboard.press("Home");
    await expect(presetsTab).toBeFocused();
    await bundlesTab.click();
    await expect(bundlesTab).toHaveAttribute("tabindex", "0");
    await expect(presetsTab).toHaveAttribute("tabindex", "-1");
    await expect(dialog.getByRole("checkbox", { name: /Design bundle/ })).toBeVisible();
    await dialog.getByRole("checkbox", { name: /Default bundle/ }).check();
    await expect(dialog.getByRole("checkbox", { name: /Default bundle/ })).toBeChecked();
    await expect(dialog.getByText("Other bundle")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Generate canvas" }).click();
    await expect(page.getByRole("dialog", { name: "Canvas designer setup" })
        .getByRole("checkbox", { name: /Design preset/ })).not.toBeChecked();
});

test("confirms community selection and checks only listed design bundle members", async ({ page }) => {
    const writes = [];
    page.on("request", (request) => {
        if (request.method() !== "GET") writes.push(request.url());
    });
    const dialog = page.getByRole("dialog", { name: "Canvas designer setup" });
    await dialog.getByRole("tab", { name: "Bundles" }).click();
    const community = dialog.getByRole("checkbox", { name: /Community bundle/ });
    await community.check();
    const warning = page.getByRole("dialog", { name: "Select community bundle?" });
    await expect(warning.getByText(/not reviewed, audited, or endorsed/)).toBeVisible();
    await expect(page.locator(".designer-backdrop")).toHaveJSProperty("inert", true);
    await expect(page.locator(".designer-backdrop")).toHaveAttribute("aria-hidden", "true");
    await expect(dialog).toHaveCount(0);
    await warning.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".designer-backdrop")).toHaveJSProperty("inert", false);
    await expect(page.locator(".designer-backdrop")).not.toHaveAttribute("aria-hidden", "true");
    await expect(dialog).toBeVisible();
    await expect(community).toBeFocused();
    await expect(community).not.toBeChecked();
    await community.check();
    await warning.getByRole("button", { name: "Select anyway" }).click();
    await expect(page.locator(".designer-backdrop")).toHaveJSProperty("inert", false);
    await expect(page.locator(".designer-backdrop")).not.toHaveAttribute("aria-hidden", "true");
    await expect(community).toBeFocused();
    await expect(community).toBeChecked();

    await dialog.getByRole("checkbox", { name: /Design bundle/ }).check();
    await warning.getByRole("button", { name: "Select anyway" }).click();
    await dialog.getByRole("tab", { name: "Presets" }).click();
    const presets = dialog.getByRole("tabpanel", { name: "Presets" });
    const preset = presets.getByRole("checkbox", { name: /Design preset/ });
    await expect(preset).toBeChecked();
    await expect(presets.getByText("Included by bundle: Design bundle")).toBeVisible();
    await expect(presets.getByText("Unlisted preset")).toHaveCount(0);
    await expect(presets.getByRole("checkbox", { name: /Copilot preset/ })).not.toBeChecked();
    await preset.uncheck();
    await expect(preset).not.toBeChecked();
    await dialog.getByRole("tab", { name: "Extensions" }).click();
    await expect(dialog.getByRole("checkbox", { name: /Design extension/ })).toBeChecked();
    await expect(dialog.getByText("Unlisted extension")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /Launch designer/ })).toBeEnabled();
    expect(writes).toEqual([]);
});

test("community presets and extensions retain their selection warnings", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: "Canvas designer setup" });
    for (const [tab, name, kind] of [
        ["Presets", "Design preset", "preset"],
        ["Extensions", "Design extension", "extension"],
    ]) {
        await dialog.getByRole("tab", { name: tab }).click();
        const choice = dialog.getByRole("checkbox", { name });
        await choice.check();
        const warning = page.getByRole("dialog", { name: `Select community ${kind}?` });
        await expect(warning.getByText(/not reviewed, audited, or endorsed/)).toBeVisible();
        await expect(warning.getByText("This selection will be installed in the launched Canvas designer session.")).toBeVisible();
        await warning.getByRole("button", { name: "Cancel" }).click();
        await expect(choice).not.toBeChecked();
        await expect(choice).toBeFocused();
        await choice.check();
        await warning.getByRole("button", { name: "Select anyway" }).click();
        await expect(choice).toBeChecked();
        await expect(choice).toBeFocused();
    }
});

test("launch queues a session and closes the dialog", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: "Canvas designer setup" });
    const responsePromise = page.waitForResponse((response) =>
        response.url().includes("/api/designer/launch") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Launch designer" }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(202);
    expect(await response.json()).toEqual({ queued: true });
    expect(response.request().postDataJSON()).toMatchObject({
        selections: { presets: [], extensions: [], bundles: [] },
        catalogFingerprint: "e2e-catalog",
    });

    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Generate canvas" }).click();
    await expect(page.getByRole("dialog", { name: "Canvas designer setup" })
        .getByRole("checkbox", { name: /Copilot preset/ })).not.toBeChecked();
});

test("activation failure preserves selections for a one-click retry", async ({ page }) => {
    const requests = [];
    await page.route("**/api/designer/launch?*", async (route) => {
        const body = route.request().postDataJSON();
        requests.push(body);
        await route.fulfill({
            status: requests.length === 1 ? 503 : 202,
            contentType: "application/json",
            body: JSON.stringify(requests.length === 1
                ? { error: "Designer activation timed out" } : { queued: true }),
        });
    });
    const dialog = page.getByRole("dialog", { name: "Canvas designer setup" });
    const preset = dialog.getByRole("checkbox", { name: /Copilot preset/ });
    await preset.check();
    await dialog.getByRole("button", { name: "Launch designer" }).click();
    await expect(dialog.getByRole("alert")).toContainText("activation timed out");
    await expect(preset).toBeChecked();
    await dialog.getByRole("button", { name: "Launch designer" }).click();
    await expect(dialog).toHaveCount(0);
    expect(requests.map((body) => body.enableProvider ?? false)).toEqual([false, false]);
    expect(requests.map((body) => body.selections.presets)).toEqual(Array(2).fill([
        { id: "foreign-preset", source: "copilot", approved: true },
    ]));
});

test("local development section is collapsed, additive, and only on Presets/Extensions", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: "Canvas designer setup" });
    const presets = dialog.getByRole("tabpanel", { name: "Presets" });
    const localSection = presets.locator('[data-designer-local="presets"]');
    await expect(localSection).toBeVisible();
    await expect(localSection.locator("summary")).toHaveText("Local development");
    await expect(localSection).not.toHaveJSProperty("open", true);
    await expect(presets.getByText(/takes precedence over a hosted selection/)).toBeHidden();
    await localSection.locator("summary").click();
    await expect(presets.getByText(/takes precedence over a hosted selection/)).toBeVisible();
    // Hosted copy, tabs, and bundle behavior are untouched: no local section
    // on Bundles, and the hosted preset checkbox is still present and
    // unaffected by the local section existing.
    await dialog.getByRole("tab", { name: "Bundles" }).click();
    const bundles = dialog.getByRole("tabpanel", { name: "Bundles" });
    await expect(bundles.locator('[data-designer-local]')).toHaveCount(0);
    await dialog.getByRole("tab", { name: "Presets" }).click();
    await expect(presets.getByRole("checkbox", { name: /Design preset/ })).toBeVisible();
});

test("adds a local preset via typed absolute path, checks it in automatically, and it wins over a hosted id", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: "Canvas designer setup" });
    const presets = dialog.getByRole("tabpanel", { name: "Presets" });
    await presets.locator('[data-designer-local="presets"] summary').click();
    await presets.locator('[data-designer-local-path="presets"]').fill(LOCAL_PRESET_PATH);
    await presets.locator('[data-designer-local-add="presets"]').click();
    const localItem = presets.locator(".designer-local-item");
    await expect(localItem).toHaveCount(1);
    await expect(localItem.getByText("Copilot Sub-Agent Delegation")).toBeVisible();
    await expect(localItem.getByText("copilot-sub-agents · v1.0.0")).toBeVisible();
    await expect(localItem.getByRole("checkbox")).toBeChecked();

    const responsePromise = page.waitForResponse((response) =>
        response.url().includes("/api/designer/launch") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Launch designer" }).click();
    const response = await responsePromise;
    expect(response.request().postDataJSON()).toMatchObject({
        localSelections: { presets: [{ id: "copilot-sub-agents", path: LOCAL_PRESET_PATH }] },
    });
});

test("rejects an invalid local path with an explicit error and lets the user retry", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: "Canvas designer setup" });
    const presets = dialog.getByRole("tabpanel", { name: "Presets" });
    await presets.locator('[data-designer-local="presets"] summary').click();
    const pathInput = presets.locator('[data-designer-local-path="presets"]');
    await pathInput.fill("relative/not-absolute");
    await presets.locator('[data-designer-local-add="presets"]').click();
    await expect(presets.locator('[data-designer-local-error="presets"]')).toContainText("must be absolute");
    await expect(presets.locator(".designer-local-item")).toHaveCount(0);

    await pathInput.fill(LOCAL_PRESET_PATH);
    await presets.locator('[data-designer-local-add="presets"]').click();
    await expect(presets.locator(".designer-local-item")).toHaveCount(1);
});

test("local sources reset on dialog close/reopen but are retained after a launch failure", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: "Canvas designer setup" });
    const presets = dialog.getByRole("tabpanel", { name: "Presets" });
    await presets.locator('[data-designer-local="presets"] summary').click();
    await presets.locator('[data-designer-local-path="presets"]').fill(LOCAL_PRESET_PATH);
    await presets.locator('[data-designer-local-add="presets"]').click();
    await expect(presets.locator(".designer-local-item")).toHaveCount(1);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Generate canvas" }).click();
    const reopened = page.getByRole("dialog", { name: "Canvas designer setup" });
    const reopenedPresets = reopened.getByRole("tabpanel", { name: "Presets" });
    await expect(reopenedPresets.locator('[data-designer-local="presets"]')).not.toHaveJSProperty("open", true);
    await expect(reopenedPresets.locator(".designer-local-item")).toHaveCount(0);

    await reopenedPresets.locator('[data-designer-local="presets"] summary').click();
    await reopenedPresets.locator('[data-designer-local-path="presets"]').fill(LOCAL_PRESET_PATH);
    await reopenedPresets.locator('[data-designer-local-add="presets"]').click();
    await expect(reopenedPresets.locator(".designer-local-item")).toHaveCount(1);

    await page.route("**/api/designer/launch?*", async (route) => {
        await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Designer activation timed out" }),
        });
    });
    await reopened.getByRole("button", { name: "Launch designer" }).click();
    await expect(reopened.getByRole("alert")).toContainText("activation timed out");
    await expect(reopenedPresets.locator(".designer-local-item")).toHaveCount(1);
    await expect(reopenedPresets.locator(".designer-local-item").getByRole("checkbox")).toBeChecked();
});
