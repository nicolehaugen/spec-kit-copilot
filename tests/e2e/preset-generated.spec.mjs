import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "./playwright.mjs";
import { startPresetJourney } from "./preset-journey.mjs";

const fixture = (suffix) => `copilot-${suffix}-test`;

async function journeyFor(page, suffix, { phases = ["specify"], registrations = [] } = {}) {
    const presetId = fixture(suffix);
    const dispatched = [];
    const journey = await startPresetJourney(page, {
        presetId, selectedPhases: phases,
        onGenerate: async (message) => dispatched.push(message),
    });
    try {
        for (const [name, kind] of registrations) {
            expect(journey.composedSkill).toContain(`- \`${name}\``);
            expect(journey.templates).toContainEqual(expect.objectContaining({
                name, kind, sourceId: presetId,
            }));
        }
        return { journey, dispatched };
    } catch (error) {
        await journey.close();
        throw error;
    }
}

async function generate(page, journey, dispatched, id, {
    workflowEvidence = false, completedSpecify = false,
} = {}) {
    await page.getByRole("tab", { name: "Essentials" }).click();
    await page.getByRole("textbox", { name: "Canvas ID (required)" }).fill(id);
    await page.getByRole("textbox", { name: "Title (required)" }).fill(`Test ${id}`);
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    const approval = page.getByRole("dialog", { name: "Approve generated value providers" });
    if (await approval.isVisible()) {
        const provider = journey.templates.find((entry) =>
            entry.kind === "generated.computed-value-provider");
        const bytes = await readFile(provider.path);
        await expect(approval).toContainText(provider.name);
        await expect(approval).toContainText(`Source: ${provider.sourceId}`);
        await expect(approval).toContainText(createHash("sha256").update(bytes).digest("hex"));
        await approval.getByRole("button", { name: "Approve and Generate" }).click();
    }
    await expect(page.locator("#conn-status")).toContainText("Generation queued:");
    await expect.poll(() => dispatched.length).toBe(1);
    const folder = join(journey.workspace, "speckit-canvas-designer", "handoffs",
        journey.handoff.handoffId, "generations");
    const [requestId] = await readdir(folder);
    expect(dispatched[0].prompt).toContain(requestId);
    expect(dispatched[0].prompt).toContain("speckit-extension-canvas-design-generate");
    const request = JSON.parse(await readFile(join(folder, requestId, "request.json"), "utf8"));
    expect(request.requestId).toBe(requestId);
    expect(request.handoffId).toBe(journey.handoff.handoffId);
    expect(request.target).toContain(id);
    await journey.generate(requestId);
    if (workflowEvidence) {
        const feature = join(journey.project, "specs", "preset-feature");
        await mkdir(feature, { recursive: true });
        await writeFile(join(feature, "spec.md"), "# Preset feature\n");
        await writeFile(join(feature, "plan.md"), "# Preset plan\n");
    }
    const served = await journey.serveGenerated(id);
    const { createRuntime } = await import(pathToFileURL(join(journey.project,
        ".github", "extensions", id, "runtime.mjs")).href);
    const events = [];
    const session = {
        sessionId: "preset-generated-e2e", mode: "interactive",
        on: () => () => {}, getEvents: async () => events, log: async () => {},
        send: async () => "preset-generated-message", abort: async () => {},
        rpc: { skills: { reload: async () => ({ errors: [] }) },
            mode: { get: async () => "interactive",
                set: async () => ({ modeApplied: true }) } },
    };
    const runtime = await createRuntime({
        config: served.config, cwd: journey.project, workspace: journey.project, session,
    });
    journey.generatedRuntime = runtime;
    if (completedSpecify) {
        const run = await runtime.run({
            phase: "specify", itemId: "specs/preset-feature", args: "Preset feature",
        }, "preset-generated-e2e");
        await runtime.report({
            phaseRunId: run.runId, path: "specs/preset-feature/spec.md",
        }, "preset-generated-e2e");
        events.push(
            { type: "user.message", data: {
                messageId: "preset-generated-message", interactionId: "preset-interaction",
            } },
            { type: "assistant.turn_start", data: {
                interactionId: "preset-interaction", turnId: "preset-turn",
            } },
            { type: "assistant.message", data: {
                interactionId: "preset-interaction", turnId: "preset-turn",
                phase: "final", content: "Completed preset phase",
            } },
            { type: "assistant.turn_end", data: {
                interactionId: "preset-interaction", turnId: "preset-turn",
            } },
        );
        await runtime.refresh();
    }
    await page.route(/\/api\//, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/events") {
            await route.fulfill({ status: 200,
                contentType: "text/event-stream", body: "data: refresh\n\n" });
            return;
        }
        const input = route.request().method() === "POST"
            ? route.request().postDataJSON() : undefined;
        const state = path === "/api/state" ? input === undefined
            ? await runtime.snapshot() : await runtime.save(input)
            : path === "/api/refresh" ? await runtime.refresh()
                : path === "/api/workflow/new" ? await runtime.createPending(input)
                    : path === "/api/values" ? await runtime.saveValue(input)
                        : path === "/api/artifact" ? await runtime.artifact({
                            phase: new URL(route.request().url()).searchParams.get("phase"),
                            itemId: new URL(route.request().url()).searchParams.get("itemId"),
                        }) : undefined;
        if (state === undefined) { await route.continue(); return; }
        await route.fulfill({ json: state });
    });
    await page.reload();
    return { request, ...served };
}

async function closeJourney(journey) {
    await journey.generatedRuntime?.close();
    await journey.close();
}

test("risk matrix keyboard selection becomes the generated read-only selected cell", async ({ page }) => {
    test.setTimeout(480_000);
    const { journey, dispatched } = await journeyFor(page, "risk-matrix", { registrations: [
        ["canvas-control-risk-matrix", "shared.control-definition"],
        ["canvas-contributions-risk-designer", "designer.setting-definition"],
        ["canvas-control-risk-matrix-designer", "designer.control-adapter"],
        ["canvas-control-risk-matrix-generated", "generated.control-adapter"],
    ] });
    try {
        const group = page.getByRole("radiogroup", { name: "Risk rating: impact by likelihood" });
        await expect(group.getByRole("radio")).toHaveCount(9);
        await group.getByRole("radio", { name: "Impact low, likelihood low" }).focus();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowDown");
        await expect(group.getByRole("radio", { name: "Impact medium, likelihood medium" }))
            .toHaveAttribute("aria-checked", "true");
        const { request, config } = await generate(page, journey, dispatched, "preset-risk");
        expect(request.values["risk.rating"]).toEqual({ impact: "medium", likelihood: "medium" });
        expect(config.generatedControls).toContainEqual(expect.objectContaining({
            id: "risk.rating", value: { impact: "medium", likelihood: "medium" },
        }));
        await expect(page.getByRole("table", { name: /impact medium, likelihood medium/ })).toBeVisible();
        await expect(page.locator('[data-control-id="risk.rating"] [aria-current="true"]'))
            .toHaveText("Selected");
    } finally { await closeJourney(journey); }
});

test("badge input control saves phase choice and packages a rule evaluated from run evidence", async ({ page }) => {
    test.setTimeout(480_000);
    const { journey, dispatched } = await journeyFor(page, "badge-input", { registrations: [
        ["badge-rule-test-phase", "generated.badge-rule-definition"],
        ["badge-rule-test-phase-adapter", "generated.badge-rule-adapter"],
        ["designer-badge-test-control", "designer.badge-input-control"],
        ["designer-badge-test-adapter", "designer.badge-input-adapter"],
        ["designer-badge-test-binding", "designer.badge-input-binding"],
    ] });
    try {
        await page.getByRole("tab", { name: "Badges" }).click();
        await page.getByRole("button", { name: "+ Add badge" }).click();
        await page.getByRole("button", { name: "Phase confirmed" }).click();
        await expect(page.getByText("This badge appears only after the selected phase's latest run completes."))
            .toBeVisible();
        await expect(page.getByRole("combobox", { name: "Phase to confirm" })).toHaveValue("specify");
        await page.getByRole("button", { name: "Create badge" }).click();
        await expect(page.locator(".badge-row")).toContainText("Phase confirmed");
        const { request, config } = await generate(page, journey, dispatched, "preset-badge", {
            workflowEvidence: true, completedSpecify: true,
        });
        expect(request.badges.instances).toContainEqual(expect.objectContaining({
            type: "test-phase", inputs: { phase: "specify" },
        }));
        expect(config.badges.rules).toContainEqual(expect.objectContaining({
            id: "test-phase", adapter: "badge-rule-test-phase-adapter",
        }));
        await expect(page.getByRole("button", { name: /preset-feature Phase confirmed/ }))
            .toBeVisible({ timeout: 15_000 });
        await page.getByRole("button", { name: /preset-feature Phase confirmed/ }).click();
        await expect(page.locator(".canvas-badge").filter({ hasText: "Phase confirmed" }))
            .toBeVisible();
        await expect(page.locator("#workflow-content")).toBeVisible();
    } finally { await closeJourney(journey); }
});

test("uploaded gallery logo renders in the added generated page hero slot", async ({ page }) => {
    test.setTimeout(480_000);
    const { journey, dispatched } = await journeyFor(page, "logo-gallery", { registrations: [
        ["canvas-logo-gallery-image", "designer.setting-definition"],
        ["canvas-generated-logo-gallery", "generated.added-page-definition"],
        ["canvas-generated-logo-gallery-renderer", "generated.added-page-renderer"],
    ] });
    try {
        await expect(page.getByRole("tab", { name: "Logo gallery" })).toBeVisible();
        await page.getByRole("tab", { name: "Logo gallery" }).click();
        const image = Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64");
        await page.locator('input[type="file"][id="setting-field-gallery.logo"]').setInputFiles({
            name: "gallery.gif", mimeType: "image/gif", buffer: image,
        });
        const { config } = await generate(page, journey, dispatched, "preset-gallery");
        expect(config.generatedPageAssets).toContainEqual(expect.objectContaining({
            id: "gallery.logo", page: "canvas-generated-logo-gallery", slot: "hero.logo",
        }));
        await page.locator('[data-canvas-page="canvas-generated-logo-gallery"]').click();
        await expect(page.locator("#generated-page").getByRole("heading", { name: "Logo gallery" }))
            .toBeVisible();
        await expect(page.locator("#generated-page").getByRole("img", { name: "Gallery logo" }))
            .toBeVisible();
    } finally { await closeJourney(journey); }
});

test("generated-only Overview is a navigable page without an extra Designer tab", async ({ page }) => {
    test.setTimeout(480_000);
    const { journey, dispatched } = await journeyFor(page, "generated-page", { registrations: [
        ["canvas-generated-overview", "generated.added-page-definition"],
        ["canvas-generated-overview-renderer", "generated.added-page-renderer"],
    ] });
    try {
        await expect(page.getByRole("tab")).toHaveText([
            "Essentials", "Outputs", "Badges", "Appearance",
        ]);
        const { config } = await generate(page, journey, dispatched, "preset-overview");
        expect(config.generatedPages).toContainEqual(expect.objectContaining({
            id: "canvas-generated-overview", renderer: "canvas-generated-overview-renderer",
        }));
        await page.locator('[data-canvas-page="canvas-generated-overview"]').click();
        await expect(page.locator("#generated-page")).toContainText(
            "Test preset-overview has a generated-only Overview page.");
        await expect(page.locator("#workflow-content")).toBeHidden();
        await page.locator('[data-canvas-page="workflow"]').click();
        await expect(page.locator("#workflow-content")).toBeVisible();
    } finally { await closeJourney(journey); }
});

test("canvas values render typed fields while processing-only value stays on its page", async ({ page }) => {
    test.setTimeout(480_000);
    const { journey, dispatched } = await journeyFor(page, "canvas-values", { registrations: [
        ["canvas-value-heading", "generated.value-definition"],
        ["canvas-value-workflow-provider", "generated.computed-value-provider"],
        ["canvas-value-processing", "generated.value-definition"],
        ["canvas-generated-values", "generated.added-page-definition"],
        ["canvas-generated-values-renderer", "generated.added-page-renderer"],
    ] });
    try {
        const { request, config } = await generate(page, journey, dispatched, "preset-values", {
            workflowEvidence: true,
        });
        expect(request.valueSources).toContainEqual(expect.objectContaining({
            id: "demo.workflow", source: expect.objectContaining({
                module: "canvas-value-workflow-provider",
            }),
        }));
        expect(config.valueSources.map(({ id }) => id)).toEqual(expect.arrayContaining([
            "demo.heading", "demo.enabled", "demo.choice", "demo.note", "demo.workflow",
            "demo.processing",
        ]));
        const values = page.locator("#canvas-values");
        await expect(values.locator('[data-field-id="demo.heading"]')).toHaveText("Sample heading");
        await expect(values.locator('[data-edit-value="demo.note"] input')).toHaveValue("Initial note");
        await expect(values.getByText("private hint")).toHaveCount(0);
        await expect(values.locator('[data-field-id="demo.workflow"]')).toHaveCount(0);
        await page.getByRole("button", { name: "preset-feature", exact: true }).click();
        await expect(values.locator('[data-field-id="demo.workflow"]'))
            .toHaveText("preset-feature (preset-feature)");
        await page.locator('[data-canvas-page="canvas-generated-values"]').click();
        await expect(page.locator("#generated-page")).toHaveText("private hint");
    } finally { await closeJourney(journey); }
});

test("dialog-only button confirms locally without dispatching a workflow run", async ({ page }) => {
    test.setTimeout(480_000);
    const { journey, dispatched } = await journeyFor(page, "dialog-buttons", {
        phases: ["specify", "plan", "tasks", "implement"], registrations: [
        ["canvas-dialog-buttons-test", "generated.dialog-definition"],
        ["canvas-button-dialog-test", "generated.dialog-definition"],
        ["canvas-dialog-trigger-control", "generated.button-control-definition"],
        ["canvas-dialog-trigger-adapter", "generated.button-adapter"],
        ["canvas-implement-dialog-test", "generated.phase-dialog-binding"],
        ["canvas-workflow-button-test", "generated.button-placement"],
        ],
    });
    try {
        const runRequests = [];
        page.on("request", (request) => {
            if (new URL(request.url()).pathname === "/api/run") runRequests.push(request);
        });
        const { config } = await generate(page, journey, dispatched, "preset-dialog");
        expect(config.buttons).toContainEqual(expect.objectContaining({
            id: "canvas-workflow-button-test", action: { type: "dialog.result" },
        }));
        await page.getByRole("button", { name: "Preview confirmation" }).click();
        const dialog = page.getByRole("dialog", { name: "Preview confirmation" });
        await expect(dialog).toContainText("No workflow phase will run.");
        await dialog.getByRole("button", { name: "Not now" }).click();
        await expect(dialog).toBeHidden();
        await page.getByRole("button", { name: "Preview confirmation" }).click();
        const before = await journey.generatedRuntime.snapshot();
        await dialog.getByRole("button", { name: "Confirm" }).click();
        await expect(dialog).toBeHidden();
        expect((await journey.generatedRuntime.snapshot()).runs).toEqual(before.runs);
        expect(runRequests).toHaveLength(0);
    } finally { await closeJourney(journey); }
});

test("Plan phase view label is rendered by the packaged phase adapter", async ({ page }) => {
    test.setTimeout(480_000);
    const { journey, dispatched } = await journeyFor(page, "phase-view-label", {
        phases: ["specify", "plan"],
        registrations: [["generated-phase-control", "generated.phase-control-definition"]],
    });
    try {
        const { request, config } = await generate(page, journey, dispatched, "preset-phase-view", {
            workflowEvidence: true,
        });
        expect(request.workflow.selectedPhases).toEqual(["specify", "plan"]);
        expect(config.workflowPage.viewLabels).toEqual({ plan: "View Plan" });
        await expect(page.getByRole("button", { name: "preset-feature", exact: true }))
            .toBeVisible({ timeout: 15_000 });
        await page.getByRole("button", { name: "preset-feature", exact: true }).click();
        await expect(page.locator("#phase-navigation")).toBeVisible();
        await page.locator('[data-phase-index="1"]').click();
        await expect(page.locator("#view-artifact")).toHaveText("View Plan");
    } finally { await closeJourney(journey); }
});
