import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "./playwright.mjs";

const workflowSource = new URL("../../spec-kit-extensions/extension-canvas-design/generated-host/workflow-page/", import.meta.url);
const phaseControlSource = new URL("../../spec-kit-extensions/extension-canvas-design/generated-host/phase-control/", import.meta.url);
const scaffoldSource = new URL("../../spec-kit-extensions/extension-canvas-design/generated-scaffold/", import.meta.url);
const workflowDefinition = await readFile(new URL("workflow.json", workflowSource));
const phaseControlDefinition = await readFile(new URL("phase-control.json", phaseControlSource));
const phaseAdapter = await readFile(new URL("generated-phase-adapter.mjs", phaseControlSource));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { title, order, slots } = JSON.parse(workflowDefinition);
const workflowPage = { title, order, slots, phaseControl: "generated-phase-control",
    adapter: "generated-phase-adapter", definitionHash: digest(workflowDefinition),
    controlHash: digest(phaseControlDefinition), hash: digest(phaseAdapter) };

test("phase actions report connecting before the first state refresh", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false);
    let releaseState;
    const waiting = new Promise((resolve) => { releaseState = resolve; });
    try {
        await page.route("**/api/state", async (route) => {
            if (route.request().method() === "GET") await waiting;
            await route.continue();
        });
        await page.goto(canvas.url, { waitUntil: "commit" });
        await expect(page.locator("#run-phase")).toBeVisible();
        await expect(page.locator("#browse-output-folder")).toBeDisabled();
        for (const selector of ["#run-phase", '[data-phase-index="1"]']) {
            await page.locator(selector).click();
            await expect(page.locator("#canvas-message")).toHaveText(
                "The canvas is connecting. Use Refresh to try again.");
        }
        await expect(page.locator("#phase-card h2")).toHaveText("Specify");
    } finally {
        releaseState();
        await canvas.close();
    }
});

test("vertical phase adapter keeps the numbered step list and manual retry accessible", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false, ["specify", "plan"]);
    try {
        const vertical = await readFile(new URL(
            "../../spec-kit-presets/copilot-vertical-phase-control/generated/phase-adapter.mjs", import.meta.url));
        await page.route("**/pages/generated-phase-adapter.mjs*", (route) => route.fulfill({
            contentType: "text/javascript", body: vertical,
        }));
        await page.goto(canvas.url);
        await expect(page.locator(".vertical-phase-list [data-phase-index]")).toHaveCount(2);
        await expect(page.locator('[data-action="autopilot"]')).toBeVisible();
        await expect(page.locator('[data-action="start"]')).toHaveCount(2);
        await page.locator('.vertical-phase-list [data-phase-index="1"]').click();
        await expect(page.locator(".phase-card h2")).toHaveText("Plan");
        await expect(page.locator('[data-action="start"]').first()).toBeEnabled();
        await page.locator('[data-action="previous"]').click();
        await expect(page.locator(".phase-card h2")).toHaveText("Specify");
        await page.locator("[data-phase-draft]").fill("Vertical proof");
        const skill = join(canvas.root, ".github", "skills", "speckit-specify");
        await mkdir(skill, { recursive: true });
        await writeFile(join(skill, "SKILL.md"), "---\nname: speckit-specify\n---\n");
        await page.locator('[data-action="start"]').first().click();
        await expect(page.locator('[data-action="start"]').first()).toBeEnabled();
        await page.setViewportSize({ width: 390, height: 760 });
        await expect(page.locator(".vertical-phase-list [data-phase-index]")).toHaveCount(2);
        await page.locator("#theme-toggle").click();
        await expect(page.locator(".vertical-phase-list [data-phase-index]").first()).toBeVisible();
        await expect(page.locator("#canvas-message")).not.toContainText("Pipeline could not render");
    } finally { await canvas.close(); }
});

test("vertical Autopilot initiates the first step through the packaged Copilot session", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false, ["specify", "plan"],
        undefined, undefined, undefined, undefined, true);
    try {
        for (const name of ["specify", "plan"]) {
            const skill = join(canvas.root, ".github", "skills", `speckit-${name}`);
            await mkdir(skill, { recursive: true });
            await writeFile(join(skill, "SKILL.md"), `---\nname: speckit-${name}\n---\n`);
        }
        await page.goto(canvas.url);
        await page.locator('[data-action="autopilot"]').click();
        await expect(page.locator('[data-action="stop"]')).toBeVisible();
        await expect(page.locator(".vertical-phase-toolbar")).toContainText("step 1 of 2");
        assert.equal(canvas.sent[0].agentMode, "autopilot");
        assert.match(canvas.sent[0].prompt, /beginning with step 0/);
        await page.locator('[data-action="stop"]').click();
        await expect(page.locator(".vertical-phase-toolbar")).toContainText("Stopped");
        await expect(page.locator('[data-action="autopilot"]')).toBeEnabled();
    } finally { await canvas.close(); }
});

test("a different phase adapter uses the same row and managed-run capabilities", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false, ["specify", "plan"],
        undefined, undefined, undefined, undefined, true);
    try {
        for (const name of ["specify", "plan"]) {
            const skill = join(canvas.root, ".github", "skills", `speckit-${name}`);
            await mkdir(skill, { recursive: true });
            await writeFile(join(skill, "SKILL.md"), `---\nname: speckit-${name}\n---\n`);
        }
        const alternate = `export const controlId = "workflow-phases";
            export const contractVersion = 1;
            export const requiredCapabilities = ["workflow.rows.v1", "workflow.managed-run.v1"];
            export function mount({ root, actions }) {
                root.innerHTML = '<button type="button" id="other-auto">Automate</button><button type="button" id="other-step">Run second</button>';
                const click = (event) => {
                    if (event.target.id === "other-auto") actions.startManagedRun().catch(actions.error);
                    if (event.target.id === "other-step") actions.runAt(1).catch(actions.error);
                };
                root.addEventListener("click", click);
                return { update() {}, dispose() { root.removeEventListener("click", click); root.replaceChildren(); } };
            }`;
        await page.route("**/pages/generated-phase-adapter.mjs*", (route) => route.fulfill({
            contentType: "text/javascript", body: alternate,
        }));
        await page.goto(canvas.url);
        await page.locator("#other-auto").click();
        await expect.poll(() => canvas.sent.length).toBe(1);
        assert.equal(canvas.sent[0].agentMode, "autopilot");
        await page.locator("#other-step").click();
        await expect(page.locator("#canvas-message")).toContainText("Stop Autopilot before starting a manual step");
        await expect(page.locator("#canvas-message")).not.toContainText("Pipeline could not render");
    } finally { await canvas.close(); }
});

for (const [scenario, module, error] of [
    ["wrong control identity", `export const controlId = "wrong";
        export const contractVersion = 1; export function mount() {}`, "Incompatible phase control adapter"],
    ["wrong contract version", `export const controlId = "workflow-phases";
        export const contractVersion = 2; export function mount() {}`, "Incompatible phase control adapter"],
    ["missing mount function", `export const controlId = "workflow-phases";
        export const contractVersion = 1;`, "Incompatible phase control adapter"],
    ["missing update", `export const controlId = "workflow-phases";
        export const contractVersion = 1;
        export function mount() { return { dispose() {} }; }`,
    "Phase control adapter must return update and dispose"],
    ["missing dispose", `export const controlId = "workflow-phases";
        export const contractVersion = 1;
        export function mount() { return { update() {} }; }`,
    "Phase control adapter must return update and dispose"],
    ["mount failure", `export const controlId = "workflow-phases";
        export const contractVersion = 1;
        export function mount() { throw new Error("adapter unavailable"); }`, "adapter unavailable"],
    ["unavailable capability", `export const controlId = "workflow-phases";
        export const contractVersion = 1;
        export const requiredCapabilities = ["workflow.unknown.v1"];
        export function mount() { throw new Error("must not mount"); }`,
    "Phase control adapter requires unavailable host capabilities"],
]) {
    test(`invalid phase adapter reports ${scenario}`, async ({ page }) => {
        const canvas = await openGeneratedCanvas(false, ["specify", "plan"]);
        try {
            await page.route("**/pages/generated-phase-adapter.mjs*", (route) => route.fulfill({
                contentType: "text/javascript", body: module,
            }));
            await page.goto(canvas.url);
            await expect(page.locator("#canvas-message")).toContainText(
                `Pipeline could not render: ${error}`);
        } finally { await canvas.close(); }
    });
}

test("phase adapter mobile navigation selects phases", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false, ["specify", "plan"]);
    try {
        await page.setViewportSize({ width: 390, height: 780 });
        await page.goto(canvas.url);
        await expect(page.locator("#phase-card h2")).toHaveText("Specify");
        await expect(page.locator("#mobile-next-phase")).toHaveText("Next: Plan");
        await page.locator("#mobile-phase-select").selectOption("1");
        await expect(page.locator("#phase-card h2")).toHaveText("Plan");
        await expect(page.locator("#mobile-next-phase")).toHaveText("Final phase");
        await expect(page.locator("#canvas-message")).not.toContainText("Pipeline could not render");
    } finally { await canvas.close(); }
});

async function openGeneratedCanvas(userProvidesSlug, phases = ["specify", "plan"],
    generatedPages, readOnlyFields, generatedControls, valueSources, vertical = false, phaseArtifacts = {}) {
    const root = await mkdtemp(join(tmpdir(), "generated-slug-e2e-"));
    const selectedAdapter = vertical ? await readFile(new URL(
        "../../spec-kit-presets/copilot-vertical-phase-control/generated/phase-adapter.mjs", import.meta.url))
        : phaseAdapter;
    const selectedControl = vertical ? await readFile(new URL(
        "../../spec-kit-presets/copilot-vertical-phase-control/generated/phase-control.json", import.meta.url))
        : phaseControlDefinition;
    const config = {
        schemaVersion: 1, userProvidesSlug,
        workflowPage: { ...workflowPage, controlHash: digest(selectedControl),
            hash: digest(selectedAdapter), managedRun: vertical },
        canvas: { id: "sample-canvas", displayName: "Sample Canvas",
            description: "Workflow canvas.", workflowListName: "Workflows" },
        phases,
        phaseOutputs: {
            constitution: { expectsArtifact: true, outputPath: ".specify/memory/constitution.md" },
            specify: { expectsArtifact: true, outputPath: "specs/<slug>/spec.md" },
            plan: { expectsArtifact: true, outputPath: "specs/<slug>/plan.md" },
            ...Object.fromEntries(phases.filter((phase) => !["constitution", "specify", "plan"].includes(phase))
                .map((phase) => [phase, { expectsArtifact: false, outputPath: null }])),
        },
        phaseArtifacts,
        installed: { presets: [], extensions: [], bundles: [] },
        ...(generatedPages ? { generatedPages } : {}),
        ...(readOnlyFields ? { readOnlyFields } : {}),
        ...(generatedControls ? { generatedControls } : {}),
        ...(valueSources ? { valueSources } : {}),
    };
    let runtime, routes, server, sdkRoot;
    try {
        sdkRoot = await mkdtemp(join(tmpdir(), "generated-sdk-e2e-"));
        const sdk = join(sdkRoot, "generated-canvas");
        await cp(scaffoldSource, sdk, { recursive: true });
        await mkdir(join(sdk, "pages"), { recursive: true });
        await Promise.all([
            ["workflow.json", workflowSource],
        ].map(([file, source]) => copyFile(new URL(file, source), join(sdk, "pages", file))));
        await writeFile(join(sdk, "pages", "phase-control.json"), selectedControl);
        await writeFile(join(sdk, "pages", "generated-phase-adapter.mjs"), selectedAdapter);
        const { createWorkflowRoutes } = await import(pathToFileURL(join(sdk, "server.mjs")).href);
        const { createRuntime } = await import(pathToFileURL(join(sdk, "runtime.mjs")).href);
        const sent = [];
        const session = { sessionId: "slug-browser-test", mode: "interactive", on: () => () => {},
            getEvents: async () => [], log: async () => {},
            send: async (options) => { sent.push(options); return "sent-message-id"; },
            abort: async () => {},
            rpc: { skills: { reload: async () => ({ errors: [] }) },
                mode: { get: async () => session.mode,
                    set: async ({ mode }) => { session.mode = mode; return { modeApplied: true }; } } } };
        runtime = await createRuntime({ config, cwd: root, workspace: root, session });
        const token = randomBytes(32).toString("hex");
        routes = createWorkflowRoutes(config, { runtime, instanceId: "slug-test", token,
            port: () => server.address().port });
        server = createServer((request, response) => {
            void routes.handle(request, response).catch((error) => response.destroy(error));
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        return {
            url: `http://127.0.0.1:${server.address().port}/?token=${token}`,
            root,
            runtime, sent,
            broadcast: () => routes.broadcast(),
            close: async () => {
                routes.close();
                runtime.close();
                await new Promise((resolve) => {
                    server.close(resolve);
                    server.closeAllConnections();
                });
                await Promise.all([root, sdkRoot].map((path) =>
                    rm(path, { recursive: true, force: true })));
            },
        };
    } catch (error) {
        routes?.close();
        runtime?.close();
        if (server?.listening) await new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
        });
        await rm(root, { recursive: true, force: true });
        if (sdkRoot) await rm(sdkRoot, { recursive: true, force: true });
        throw error;
    }
}

function sampleValueSources() {
    const section = { id: "demo", title: "Demo values" };
    return [
        { id: "demo.heading", label: "Heading", section,
            schema: { type: "string", maxLength: 80 },
            source: { kind: "constant", value: "Read-only heading" },
            presentation: "stock.readonly" },
        { id: "demo.note", label: "Note", section,
            schema: { type: "string", maxLength: 80 },
            source: { kind: "constant", value: "Initial note" },
            presentation: "stock.editable" },
        { id: "demo.enabled", label: "Enabled", section,
            schema: { type: "boolean" },
            source: { kind: "constant", value: true },
            presentation: "stock.editable" },
        { id: "demo.choice", label: "Choice", section,
            schema: { type: "object", properties: { level: ["one", "two"] } },
            source: { kind: "constant", value: { level: "one" } },
            presentation: "stock.editable" },
        { id: "demo.processing", label: "Processing only",
            schema: { type: "string", maxLength: 80 },
            source: { kind: "constant", value: "Not displayed" },
            presentation: "processing-only" },
    ];
}

test("generated value editors render typed controls without exposing processing-only values", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false, ["specify"], undefined, undefined, undefined, sampleValueSources());
    try {
        await page.goto(canvas.url);
        const values = page.locator("#canvas-values");
        await expect(values).toBeVisible();
        await expect(values.getByRole("heading", { name: "Demo values" })).toBeVisible();
        await expect(values.locator('[data-field-id="demo.heading"]')).toHaveText("Read-only heading");
        await expect(values.locator('[data-edit-value="demo.heading"]')).toHaveCount(0);
        await expect(values.locator('[data-edit-value="demo.note"] input'))
            .toHaveValue("Initial note");
        await expect(values.locator('[data-edit-value="demo.note"] input'))
            .toHaveAttribute("maxlength", "80");
        await expect(values.locator('[data-edit-value="demo.enabled"] input[type="checkbox"]'))
            .toBeChecked();
        await expect(values.locator('[data-edit-value="demo.choice"] select[data-property="level"]'))
            .toHaveValue("one");
        await expect(values.locator('[data-edit-value="demo.choice"] option')).toHaveText(["one", "two"]);
        await expect(values.getByText("Processing only")).toHaveCount(0);
        await expect(values.getByText("Not displayed")).toHaveCount(0);
    } finally {
        await canvas.close();
    }
});

test("object value properties have distinct accessible names across values", async ({ page }) => {
    const sources = sampleValueSources();
    sources.push({ id: "demo.priority", label: "Priority",
        schema: { type: "object", properties: { level: ["one", "two"] } },
        source: { kind: "constant", value: { level: "two" } },
        presentation: "stock.editable" });
    const canvas = await openGeneratedCanvas(false, ["specify"], undefined, undefined, undefined, sources);
    try {
        await page.goto(canvas.url);
        await expect(page.getByRole("combobox", { name: "Choice: level" })).toHaveValue("one");
        await expect(page.getByRole("combobox", { name: "Priority: level" })).toHaveValue("two");
    } finally {
        await canvas.close();
    }
});

test("generated value editors save typed changes canvas-wide and retain failed edits", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false, ["specify"], undefined, undefined, undefined, sampleValueSources());
    let otherPanel;
    try {
        await mkdir(join(canvas.root, "specs", "first"), { recursive: true });
        await mkdir(join(canvas.root, "specs", "second"), { recursive: true });
        await page.goto(canvas.url);
        const note = page.locator('[data-edit-value="demo.note"] input');
        const enabled = page.locator('[data-edit-value="demo.enabled"] input');
        const choice = page.locator('[data-edit-value="demo.choice"] select[data-property="level"]');

        const textSave = page.waitForResponse((response) =>
            response.url().includes("/api/values") && response.request().postDataJSON().id === "demo.note");
        await note.fill("Saved across workflows");
        await note.press("Tab");
        expect((await textSave).status()).toBe(200);
        await expect(note).toHaveValue("Saved across workflows");

        const booleanSave = page.waitForResponse((response) =>
            response.url().includes("/api/values") && response.request().postDataJSON().id === "demo.enabled");
        await enabled.uncheck();
        expect((await booleanSave).status()).toBe(200);
        await expect(enabled).not.toBeChecked();

        const objectSave = page.waitForResponse((response) =>
            response.url().includes("/api/values") && response.request().postDataJSON().id === "demo.choice");
        await choice.selectOption("two");
        expect((await objectSave).status()).toBe(200);
        await expect(choice).toHaveValue("two");
        await page.reload();
        await expect(note).toHaveValue("Saved across workflows");
        await expect(enabled).not.toBeChecked();
        await expect(choice).toHaveValue("two");

        for (const workflow of ["first", "second"]) {
            await page.getByRole("button", { name: workflow, exact: true }).click();
            await expect(note).toHaveValue("Saved across workflows");
            await expect(enabled).not.toBeChecked();
            await expect(choice).toHaveValue("two");
        }

        await page.route("**/api/values", async (route) => {
            if (route.request().postDataJSON().value === "Unsaved draft") {
                await route.fulfill({ status: 409, contentType: "application/json",
                    body: JSON.stringify({ error: "Canvas state changed in another panel. Refresh before saving." }) });
            } else await route.continue();
        });
        const rejectedSave = page.waitForResponse((response) =>
            response.url().includes("/api/values")
            && response.request().postDataJSON().value === "Unsaved draft");
        await note.fill("Unsaved draft");
        await note.press("Tab");
        expect((await rejectedSave).status()).toBe(409);
        await expect(page.locator("#canvas-message")).toContainText("Value could not be saved");
        await expect(note).toHaveValue("Unsaved draft");
        expect(await page.evaluate(() => {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        })).toBe(true);
        otherPanel = await page.context().newPage();
        await otherPanel.goto(canvas.url);
        await page.locator("#refresh-state").focus();
        await expect(page.locator("#connection-status")).toHaveText("Live");
        const externalSave = otherPanel.waitForResponse((response) =>
            response.url().includes("/api/values")
            && response.request().postDataJSON().id === "demo.enabled");
        await otherPanel.locator('[data-edit-value="demo.enabled"] input').check();
        expect((await externalSave).status()).toBe(200);
        const refreshed = page.waitForResponse((response) =>
            response.url().includes("/api/state") && response.request().method() === "GET");
        canvas.broadcast();
        expect((await refreshed).status()).toBe(200);
        await expect(enabled).toBeChecked();
        await expect(note).toHaveValue("Unsaved draft");
        const separateSave = page.waitForResponse((response) =>
            response.url().includes("/api/values")
            && response.request().postDataJSON().id === "demo.enabled");
        await enabled.uncheck();
        expect((await separateSave).status()).toBe(200);
        await expect(note).toHaveValue("Unsaved draft");
        expect(await page.evaluate(() => {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        })).toBe(true);
        const retry = page.waitForResponse((response) =>
            response.url().includes("/api/values")
            && response.request().postDataJSON().value === "Recovered edit");
        await note.fill("Recovered edit");
        await note.press("Tab");
        expect((await retry).status()).toBe(200);
        await expect(note).toHaveValue("Recovered edit");
        expect(await page.evaluate(() => {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        })).toBe(false);
    } finally {
        await otherPanel?.close();
        await canvas.close();
    }
});

test("generated value edits serialize revisions and block navigation while saving", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false, ["specify"], undefined, undefined, undefined, sampleValueSources());
    let releaseFirst;
    try {
        await mkdir(join(canvas.root, "specs", "first"), { recursive: true });
        let firstStarted;
        const started = new Promise((resolve) => { firstStarted = resolve; });
        const held = new Promise((resolve) => { releaseFirst = resolve; });
        const requests = [];
        await page.route("**/api/values", async (route) => {
            const input = route.request().postDataJSON();
            requests.push(input);
            if (input.id === "demo.note") {
                firstStarted();
                await held;
            }
            await route.continue();
        });
        await page.goto(canvas.url);
        const firstSave = page.waitForResponse((response) =>
            response.url().includes("/api/values") && response.request().postDataJSON().id === "demo.note");
        await page.locator('[data-edit-value="demo.note"] input').fill("First edit");
        await page.locator('[data-edit-value="demo.note"] input').press("Tab");
        await started;
        const secondSave = page.waitForResponse((response) =>
            response.url().includes("/api/values") && response.request().postDataJSON().id === "demo.enabled");
        await page.locator('[data-edit-value="demo.enabled"] input').uncheck();
        await page.getByRole("button", { name: "first", exact: true }).click();
        expect(requests).toHaveLength(1);
        await expect(page.locator("#workflow-identity")).toBeVisible();
        expect(await page.evaluate(() => {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        })).toBe(true);
        releaseFirst();
        expect((await firstSave).status()).toBe(200);
        expect((await secondSave).status()).toBe(200);
        await expect(page.locator("#workflow-list .instance-row.active")).toContainText("first");
        expect(requests.map(({ id, revision }) => [id, revision])).toEqual([
            ["demo.note", requests[0].revision],
            ["demo.enabled", requests[0].revision + 1],
        ]);
        expect(await page.evaluate(() => {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        })).toBe(false);
        await expect(page.locator('[data-edit-value="demo.note"] input')).toHaveValue("First edit");
        await expect(page.locator('[data-edit-value="demo.enabled"] input')).not.toBeChecked();
    } finally {
        releaseFirst?.();
        await canvas.close();
    }
});

test("slow control mount leaves other controls and the workflow shell interactive", async ({ page }) => {
    const control = (id) => ({
        id, label: id, control: id, adapter: id, slot: "details.content",
        properties: { choice: ["yes"] }, value: { choice: "yes" },
    });
    const canvas = await openGeneratedCanvas(false, ["specify"],
        [{ id: "extra", title: "Extra", renderer: "extra" }],
        undefined, ["slow", "broken"].map(control));
    try {
        await page.route("**/controls/slow.mjs*", (route) => route.fulfill({
            contentType: "text/javascript",
            body: 'export const controlId = "slow";'
                + 'export const valueContract = { type: "object", properties: { choice: ["yes"] } };'
                + 'export async function mount() { globalThis.slowControlStarted = true;'
                + 'await new Promise(() => {}); }',
        }));
        await page.route("**/controls/broken.mjs*", (route) => route.fulfill({
            contentType: "text/javascript",
            body: 'export const controlId = "broken";'
                + 'export const valueContract = { type: "object", properties: { choice: ["yes"] } };'
                + 'export function mount() { throw new Error("control unavailable"); }',
        }));
        await page.route("**/pages/extra.mjs*", (route) => route.fulfill({
            contentType: "text/javascript",
            body: 'export function renderPage({ root }) { root.textContent = "Extra is available"; }',
        }));
        await page.goto(canvas.url);
        await page.waitForFunction(() => globalThis.slowControlStarted);
        await expect(page.locator('[data-control-id="broken"][role="alert"]'))
            .toContainText("Generated control could not render: control unavailable");
        await expect(page.locator("#connection-status")).toHaveText("Live");
        const priorTheme = await page.locator("html").getAttribute("data-theme");
        await page.locator("#theme-toggle").click();
        await expect(page.locator("html")).toHaveAttribute("data-theme",
            priorTheme === "dark" ? "light" : "dark");
        await page.locator('[data-canvas-page="extra"]').click();
        await expect(page.locator("#generated-page")).toHaveText("Extra is available");
        await expect(page.locator('section[aria-label="slow"]')).toBeHidden();
        await expect(page.locator('[data-control-id="slow"]')).not.toHaveAttribute("role", "alert");
        await page.locator('[data-canvas-page="workflow"]').click();
        await expect(page.locator('section[aria-label="slow"]')).toBeVisible();
    } finally {
        await canvas.close();
    }
});

test("generated page hides all Workflow content and restores it on return", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false, ["constitution", "specify"],
        [{ id: "overview", title: "Overview", renderer: "overview" }],
        [{ id: "billing.costCode", label: "Cost code", value: "CC-481" }]);
    try {
        await page.route("**/pages/overview.mjs*", (route) => route.fulfill({
            contentType: "text/javascript",
            body: 'export function renderPage({ root }) { root.textContent = "Overview"; }',
        }));
        await page.goto(canvas.url);
        await page.locator("#workflow-name").fill("Draft workflow");
        await expect(page.locator("#instance-collection")).toBeVisible();
        await expect(page.locator('[data-field-id="billing.costCode"]')).toBeVisible();
        await expect(page.locator("#constitution-card")).toBeVisible();
        await expect(page.locator("#phase-navigation")).toBeVisible();
        await expect(page.locator("#phase-card")).toBeVisible();

        await page.locator('[data-canvas-page="overview"]').click();
        await expect(page.locator("#generated-page")).toHaveText("Overview");
        await expect(page.locator("#workflow-content")).toBeHidden();
        for (const selector of ["#instance-collection", '[data-field-id="billing.costCode"]',
            "#constitution-card", "#phase-navigation", "#phase-card"]) {
            await expect(page.locator(selector)).toBeHidden();
        }
        await expect(page.locator("#refresh-state")).toBeVisible();
        await expect(page.locator('[data-canvas-page="workflow"]')).toBeVisible();

        await page.locator('[data-canvas-page="workflow"]').click();
        await expect(page.locator("#generated-page")).toBeHidden();
        await expect(page.locator("#workflow-content")).toBeVisible();
        await expect(page.locator("#instance-collection")).toBeVisible();
        await expect(page.locator('[data-field-id="billing.costCode"]')).toBeVisible();
        await expect(page.locator("#constitution-card")).toBeVisible();
        await expect(page.locator("#phase-navigation")).toBeVisible();
        await expect(page.locator("#phase-card")).toBeVisible();
        await expect(page.locator("#workflow-name")).toHaveValue("Draft workflow");
    } finally {
        await canvas.close();
    }
});

test("generated page selection ignores stale imports and async renderers", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false, ["specify"], [
        { id: "slow", title: "Slow", renderer: "slow" },
        { id: "fast", title: "Fast", renderer: "fast" },
    ]);
    try {
        await page.route("**/pages/slow.mjs*", async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 250));
            await route.fulfill({ contentType: "text/javascript", body: `
                globalThis.slowModuleLoaded = true;
                export async function renderPage({ root }) {
                    globalThis.slowRenderStarted = true;
                    await new Promise((resolve) => setTimeout(resolve, 250));
                    root.textContent = "Slow";
                    globalThis.slowRenderDone = true;
                }
            ` });
        });
        await page.route("**/pages/fast.mjs*", (route) => route.fulfill({
            contentType: "text/javascript",
            body: 'export function renderPage({ root }) { root.textContent = "Fast"; }',
        }));
        await page.goto(canvas.url);
        const root = page.locator("#generated-page");
        await page.locator('[data-canvas-page="slow"]').click();
        await page.locator('[data-canvas-page="fast"]').click();
        await expect(root).toHaveText("Fast");
        await page.waitForFunction(() => globalThis.slowModuleLoaded);
        await expect(root).toHaveText("Fast");
        await page.locator('[data-canvas-page="slow"]').click();
        await page.waitForFunction(() => globalThis.slowRenderStarted);
        await page.locator('[data-canvas-page="fast"]').click();
        await expect(root).toHaveText("Fast");
        await page.waitForFunction(() => globalThis.slowRenderDone);
        await expect(root).toHaveText("Fast");
        await expect(page.locator('[data-canvas-page="fast"]')).toHaveAttribute("aria-current", "page");
    } finally {
        await canvas.close();
    }
});

test("new workflow run follows its confirmed slug and blocks deletion while active", async () => {
    const canvas = await openGeneratedCanvas(false);
    try {
        const skill = join(canvas.root, ".github", "skills", "speckit-specify");
        await mkdir(skill, { recursive: true });
        await writeFile(join(skill, "SKILL.md"), "---\nname: speckit-specify\n---\n");
        const run = await canvas.runtime.run({ phase: "specify", itemId: "__new__", args: "Feature" }, "slug-test");
        await mkdir(join(canvas.root, "specs", "new-feature"), { recursive: true });
        const before = await canvas.runtime.snapshot();
        await expect(canvas.runtime.deleteWorkflow({
            itemId: "specs/new-feature", confirmation: "new-feature", revision: before.revision,
        })).rejects.toThrow(/unfinished phase/);
        await canvas.runtime.reportSlug({ phaseRunId: run.runId, slug: "new-feature" }, "slug-test");
        await canvas.runtime.reportSlug({ phaseRunId: run.runId, slug: "new-feature" }, "slug-test");
        const after = await canvas.runtime.snapshot();
        expect(after.selected).toBe("specs/new-feature");
        expect(after.statuses.specify.status).toBe("Request sent");
        await expect(canvas.runtime.deleteWorkflow({
            itemId: "specs/new-feature", confirmation: "new-feature", revision: after.revision,
        })).rejects.toThrow(/unfinished phase/);
        await writeFile(join(canvas.root, "specs", "new-feature", "spec.md"), "# Feature\n");
        await canvas.runtime.report({
            phaseRunId: run.runId, path: "specs/new-feature/spec.md",
        }, "slug-test");
        expect((await canvas.runtime.snapshot()).statuses.specify.status).toBe("Request sent");
    } finally {
        await canvas.close();
    }
});

test("enabled slug previews the View target folder and persists across phases", async ({ page }) => {
    const canvas = await openGeneratedCanvas(true);
    try {
        await page.goto(canvas.url);
        const target = page.locator("#browse-output-folder");
        await expect(target).toBeDisabled();
        await expect(target.locator("code")).toHaveText("specs/<slug>/spec.md");
        await page.locator("#workflow-name").fill("Customer dashboard");
        await expect(page.locator("#workflow-name")).toHaveValue("Customer dashboard");
        await expect(page.locator("#feature-select")).toHaveCount(0);
        await page.locator("#workflow-slug").fill("sample-feature");
        await expect(target.locator("code")).toHaveText("specs/sample-feature/spec.md");
        await expect(target).toHaveAttribute("title", "Open specs/sample-feature in file explorer");
        await expect(target).toBeEnabled();
        await page.locator('[data-phase-index="1"]').click();
        await expect(page.locator("#workflow-name")).toBeVisible();
        await expect(page.locator("#workflow-slug")).toBeVisible();
        await expect(target.locator("code")).toHaveText("specs/sample-feature/plan.md");
        await page.locator('[data-phase-index="0"]').click();
        await expect(page.locator("#workflow-name")).toHaveValue("Customer dashboard");
        await expect(page.locator("#workflow-slug")).toHaveValue("sample-feature");
    } finally {
        await canvas.close();
    }
});

test("failed autosave retains workflow identity through SSE and Refresh for retry", async ({ page }) => {
    const canvas = await openGeneratedCanvas(true);
    let rejectSaves = true;
    try {
        await page.route("**/api/state", (route) => {
            if (route.request().method() === "POST" && rejectSaves) {
                return route.fulfill({ status: 503, contentType: "application/json",
                    body: JSON.stringify({ error: "Temporary save failure" }) });
            }
            return route.continue();
        });
        await page.goto(canvas.url);
        await expect(page.locator("#workflow-empty")).toBeVisible();
        await page.locator("#workflow-name").fill("Unsaved workflow");
        await page.locator("#workflow-slug").fill("unsaved-slug");
        await page.locator("#phase-args").focus();
        await expect(page.locator("#canvas-message")).toContainText("Your draft is retained");
        await mkdir(join(canvas.root, "specs", "other-workflow"), { recursive: true });
        canvas.broadcast();
        await expect(page.locator("#workflow-count")).toHaveText("(1)");
        await expect(page.locator("#workflow-name")).toHaveValue("Unsaved workflow");
        await expect(page.locator("#workflow-slug")).toHaveValue("unsaved-slug");
        await page.locator("#refresh-state").click();
        await expect(page.locator("#canvas-message")).toContainText("Temporary save failure");
        await expect(page.locator("#workflow-name")).toHaveValue("Unsaved workflow");
        await expect(page.locator("#workflow-slug")).toHaveValue("unsaved-slug");
        rejectSaves = false;
        await page.locator("#refresh-state").click();
        await expect(page.locator("#canvas-message")).toHaveText("Canvas refreshed.");
        const saved = await canvas.runtime.snapshot();
        expect(saved.name).toBe("Unsaved workflow");
        expect(saved.slug).toBe("unsaved-slug");
    } finally {
        await canvas.close();
    }
});

test("failed New selection replays its selection with identity on Refresh", async ({ page }) => {
    const canvas = await openGeneratedCanvas(true);
    const saves = [];
    let rejectNew = true;
    try {
        await mkdir(join(canvas.root, "specs", "existing"), { recursive: true });
        await page.route("**/api/state", (route) => {
            if (route.request().method() === "POST") {
                const patch = JSON.parse(route.request().postData());
                saves.push(patch);
                if (rejectNew && patch.selected === "__new__") {
                    return route.fulfill({ status: 503, contentType: "application/json",
                        body: JSON.stringify({ error: "Temporary selection failure" }) });
                }
            }
            return route.continue();
        });
        await page.goto(canvas.url);
        await page.getByRole("button", { name: "existing", exact: true }).click();
        await expect.poll(async () => (await canvas.runtime.snapshot()).selected).toBe("specs/existing");
        await page.locator("#new-workflow").click();
        await expect(page.locator("#canvas-message")).toContainText("Temporary selection failure");
        rejectNew = false;
        await page.locator("#refresh-state").click();
        await expect(page.locator("#canvas-message")).toHaveText("Canvas refreshed.");
        expect(saves.at(-1)).toMatchObject({ selected: "__new__", name: "", slug: "" });
        await expect.poll(async () => (await canvas.runtime.snapshot()).selected).toBe("__new__");
        await expect(page.locator("#workflow-name")).toBeVisible();
    } finally {
        await canvas.close();
    }
});

test("disabled slug option omits the field and leaves View target unresolved until creation", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false);
    try {
        await page.goto(canvas.url);
        await expect(page.locator("#workflow-name")).toBeVisible();
        await expect(page.locator("#workflow-slug")).toHaveCount(0);
        await expect(page.locator("#constitution-card")).toHaveCount(0);
        expect(await page.evaluate(() => {
            const collection = document.querySelector("#instance-collection").getBoundingClientRect();
            const navigation = document.querySelector("#phase-navigation").getBoundingClientRect();
            return navigation.top - collection.bottom;
        })).toBeLessThanOrEqual(28);
        await expect(page.locator("#browse-output-folder")).toBeDisabled();
        await expect(page.locator("#browse-output-folder code")).toHaveText("specs/<slug>/spec.md");
    } finally {
        await canvas.close();
    }
});

test("empty workflow list offers a list-shaped path to the first workflow", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false);
    try {
        await page.goto(canvas.url);
        await expect(page.locator("#workflow-list")).toBeHidden();
        await expect(page.locator("#workflow-empty")).toBeVisible();
        await expect(page.locator("#workflow-empty")).toContainText("No workflows yet");
        await expect(page.locator("#workflow-list-status")).toBeHidden();
        await page.locator("#workflow-name").fill("Old draft");
        await page.locator("#create-first-workflow").click();
        await expect(page.locator("#workflow-name")).toBeFocused();
        await expect(page.locator("#workflow-name")).toHaveValue("");
        await page.setViewportSize({ width: 390, height: 780 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await mkdir(join(canvas.root, "specs", "first-workflow"), { recursive: true });
        await page.locator("#refresh-state").click();
        await expect(page.locator("#workflow-empty")).toBeHidden();
        await expect(page.locator("#workflow-list .instance-row")).toHaveCount(1);
    } finally {
        await canvas.close();
    }
});

test("sending a phase keeps the navigation free of run states and clears the dispatch notice", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false);
    try {
        const skill = join(canvas.root, ".github", "skills", "speckit-specify");
        await mkdir(skill, { recursive: true });
        await writeFile(join(skill, "SKILL.md"), "---\nname: speckit-specify\n---\n");
        await page.goto(canvas.url);
        const dispatched = page.waitForResponse((response) => response.url().endsWith("/api/run"));
        await page.locator("#run-phase").click();
        const result = await (await dispatched).json();
        expect(result).toEqual({ ok: true, runId: expect.any(String) });
        await expect(page.locator("#run-phase")).toHaveText("Request sent...");
        await expect(page.locator("#phase-card .phase-notice")).toHaveText("Request sent");
        await expect(page.locator("#phase-message")).toBeEmpty();
        await expect(page.locator("#canvas-message")).toBeEmpty();
        await expect(page.locator(".stepper .phase-run-state")).toHaveCount(0);
        await expect(page.locator('[data-phase-index="0"]')).toHaveAttribute("aria-label", "Phase 1 of 2: Specify");
        await expect(page.locator('[data-phase-index="0"]')).not.toHaveAttribute("title", /Request sent|Running/);
    } finally {
        await canvas.close();
    }
});

test("refresh clears resolved phase and Constitution errors", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false, ["constitution", "specify"]);
    let phaseError = true;
    const withStatus = async (route) => {
        const response = await route.fetch();
        const state = await response.json();
        state.statuses.specify.error = phaseError ? "Phase failed" : null;
        await route.fulfill({ response, json: state });
    };
    try {
        await page.route("**/api/state", withStatus);
        await page.route("**/api/refresh", withStatus);
        await page.goto(canvas.url);
        await expect(page.locator("#phase-message")).toHaveText("Phase failed");
        await page.locator("#refresh-state").click();
        await expect(page.locator("#phase-message")).toHaveText("Phase failed");
        phaseError = false;
        await page.locator("#refresh-state").click();
        await expect(page.locator("#phase-message")).toBeEmpty();

        await page.route("**/api/run", (route) => route.fulfill({
            status: 503, contentType: "application/json",
            body: JSON.stringify({ error: "Constitution could not be sent" }),
        }));
        await page.locator("#run-constitution").click();
        await page.locator("#send-constitution").click();
        await expect(page.locator("#constitution-message")).toHaveText("Constitution could not be sent");
        await page.locator("#cancel-constitution").click();
        await page.locator("#refresh-state").click();
        await page.locator("#run-constitution").click();
        await expect(page.locator("#constitution-message")).toBeEmpty();
    } finally {
        await canvas.close();
    }
});

test("a later successful save does not hide a failed phase draft", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false, ["constitution", "specify"]);
    const saves = [];
    let failPhase = true;
    try {
        await page.route("**/api/state", (route) => {
            if (route.request().method() === "POST") {
                const patch = JSON.parse(route.request().postData());
                saves.push(patch);
                if (failPhase && patch.draft?.phase === "specify") {
                    failPhase = false;
                    return route.fulfill({ status: 503, contentType: "application/json",
                        body: JSON.stringify({ error: "Phase draft save failed" }) });
                }
            }
            return route.continue();
        });
        await page.goto(canvas.url);
        await expect(page.locator("#workflow-empty")).toBeVisible();
        await page.locator("#phase-args").fill("Keep this draft");
        await expect(page.locator("#canvas-message")).toContainText("Phase draft save failed");
        await page.locator("#run-constitution").click();
        await page.locator("#constitution-args").fill("Constitution guidance");
        await expect.poll(() => saves.some((patch) => patch.draft?.phase === "constitution")).toBe(true);
        expect((await canvas.runtime.snapshot()).drafts[JSON.stringify(["__new__", "specify"])]).toBeUndefined();
        await page.locator("#cancel-constitution").click();
        await page.locator("#refresh-state").click();
        await expect(page.locator("#canvas-message")).toHaveText("Canvas refreshed.");
        expect((await canvas.runtime.snapshot()).drafts[JSON.stringify(["__new__", "specify"])])
            .toBe("Keep this draft");
    } finally {
        await canvas.close();
    }
});

test("Constitution guidance saves once after typing and flushes before sending", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false, ["constitution", "specify"]);
    const saves = [];
    let draftBeforeRun;
    let rejectDraft = false;
    try {
        await page.route("**/api/state", (route) => {
            if (route.request().method() === "POST") {
                saves.push(JSON.parse(route.request().postData()));
                if (rejectDraft) return route.fulfill({ status: 503, contentType: "application/json",
                    body: JSON.stringify({ error: "Temporary draft failure" }) });
            }
            return route.continue();
        });
        await page.route("**/api/run", async (route) => {
            draftBeforeRun = (await canvas.runtime.snapshot())
                .drafts[JSON.stringify(["project", "constitution"])];
            await route.fulfill({ status: 503, contentType: "application/json",
                body: JSON.stringify({ error: "Test dispatch stopped" }) });
        });
        await page.goto(canvas.url);
        await page.locator("#run-constitution").click();
        await page.locator("#constitution-args").pressSequentially("first draft", { delay: 10 });
        await expect.poll(() => saves.length).toBe(1);
        expect(saves[0].draft).toEqual({
            item: "project", phase: "constitution", value: "first draft",
        });
        await page.locator("#constitution-args").fill("latest draft");
        await page.locator("#send-constitution").click();
        await expect(page.locator("#constitution-message")).toHaveText("Test dispatch stopped");
        expect(saves).toHaveLength(2);
        expect(saves[1].draft.value).toBe("latest draft");
        expect(draftBeforeRun).toBe("latest draft");
        rejectDraft = true;
        await page.locator("#constitution-args").fill("retry draft");
        await expect(page.locator("#canvas-message")).toContainText("Temporary draft failure");
        rejectDraft = false;
        await page.locator("#cancel-constitution").click();
        await page.locator("#refresh-state").click();
        await expect(page.locator("#canvas-message")).toHaveText("Canvas refreshed.");
        expect((await canvas.runtime.snapshot()).drafts[JSON.stringify(["project", "constitution"])])
            .toBe("retry draft");
    } finally {
        await canvas.close();
    }
});

test("one workflow header, compact constitution and legible narrow phase navigation", async ({ page }) => {
    const canvas = await openGeneratedCanvas(true,
        ["constitution", "specify", "clarify", "plan", "tasks", "taskstoissues", "analyze", "checklist", "implement"]);
    try {
        await page.setViewportSize({ width: 390, height: 780 });
        await page.goto(canvas.url);
        expect(await page.evaluate(() => {
            const body = document.querySelector("main");
            return [...body.children].slice(0, 2).map((child) => child.id);
        })).toEqual(["instance-collection", "constitution-card"]);
        await expect(page.locator("#instance-collection .collection-description")).toHaveText("Workflow canvas.");
        await expect(page.locator("#current-workflow-title")).toHaveCount(0);
        await expect(page.locator("#feature-select")).toHaveCount(0);
        await expect(page.locator("#new-workflow")).toBeVisible();
        await expect(page.locator("#workflow-name")).toBeVisible();
        await expect(page.locator("#workflow-slug")).toBeVisible();
        await expect(page.locator("#constitution-card")).toHaveAttribute("open", "");
        expect(await page.evaluate(() => {
            const constitution = document.querySelector("#constitution-card").getBoundingClientRect();
            const navigation = document.querySelector("#phase-navigation").getBoundingClientRect();
            return navigation.top - constitution.bottom;
        })).toBeLessThanOrEqual(28);
        await expect(page.locator("#canvas-message")).toBeHidden();
        await expect(page.locator("#view-constitution")).toBeHidden();
        await expect(page.locator(".stepper")).toBeHidden();
        await expect(page.locator("#mobile-phase-select")).toHaveValue("0");
        await expect(page.locator("#mobile-next-phase")).toHaveText("Next: Clarify");
        await page.locator("#mobile-phase-select").selectOption("3");
        await expect(page.locator("#mobile-next-phase")).toHaveText("Next: Create issues");
        await expect(page.locator("#next-phase")).toHaveText("Next: Create issues ▶");
        await page.locator("#next-phase").click();
        await expect(page.locator("#mobile-phase-select")).toHaveValue("4");
        await expect(page.locator("#mobile-phase-select option:checked")).toContainText("Create issues");
        await page.locator("#constitution-card summary").click();
        await expect(page.locator("#constitution-card")).not.toHaveAttribute("open", "");
        await mkdir(join(canvas.root, ".specify", "memory"), { recursive: true });
        await writeFile(join(canvas.root, ".specify", "memory", "constitution.md"), "# Constitution");
        await page.locator("#refresh-state").click();
        await expect(page.locator("#constitution-card")).not.toHaveAttribute("open", "");
        await page.locator("#constitution-card summary").click();
        await expect(page.locator("#view-constitution")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
        await canvas.close();
    }
});

test("confirmed phase outputs link to their files and View artifact opens the selected default", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false, ["specify", "plan"], undefined, undefined,
        undefined, undefined, false, {
            specify: { outputs: ["specs/<slug>/spec.md", "specs/<slug>/research.md"],
                view: "specs/<slug>/research.md" },
            plan: { outputs: [], view: null },
        });
    try {
        const folder = join(canvas.root, "specs", "sample-feature");
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "spec.md"), "# Spec");
        await writeFile(join(folder, "research.md"), "# Research");
        await page.goto(canvas.url);
        await page.getByRole("button", { name: "sample-feature", exact: true }).click();
        await expect(page.locator("#phase-other-outputs [data-output]")).toHaveCount(2);
        await page.locator('#phase-other-outputs [data-output="specs/<slug>/spec.md"]').click();
        await expect(page.locator("#artifact-path")).toHaveText("specs/sample-feature/spec.md");
        await page.locator("#close-artifact").click();
        await page.locator("#view-artifact").click();
        await expect(page.locator("#artifact-path")).toHaveText("specs/sample-feature/research.md");
        await page.locator("#close-artifact").click();
        await page.locator("#next-phase").click();
        await expect(page.locator("#view-artifact")).toBeHidden();
        await expect(page.locator("#phase-other-outputs [data-output]")).toHaveCount(0);
    } finally { await canvas.close(); }
});

test("artifact viewer matches the Wizard full-page layout and returns to the canvas", async ({ page }) => {
    const canvas = await openGeneratedCanvas(false);
    try {
        await mkdir(join(canvas.root, "specs", "sample-feature"), { recursive: true });
        const artifact = join(canvas.root, "specs", "sample-feature", "spec.md");
        await writeFile(artifact,
            "# Sample feature\n\nDetails. <!-- hidden -->\n\n```html\n<!-- important -->\n<div>Example</div>\n```\n");
        await page.goto(canvas.url);
        await page.getByRole("button", { name: "sample-feature", exact: true }).click();
        await expect(page.locator("#view-artifact")).toBeVisible();
        await page.locator("#view-artifact").click();
        const viewer = page.locator("#artifact-viewer");
        await expect(viewer).toBeVisible();
        await expect(viewer.locator("#artifact-title")).toHaveText("Specify");
        await expect(viewer.locator("#artifact-path")).toHaveText("specs/sample-feature/spec.md");
        await expect(viewer.locator("#artifact-content h1")).toHaveText("Sample feature");
        await expect(viewer.locator("#artifact-content")).not.toContainText("hidden");
        await expect(viewer.locator("#artifact-content pre code"))
            .toHaveText("<!-- important -->\n<div>Example</div>");
        await writeFile(artifact, "");
        canvas.broadcast();
        await expect(viewer.locator("#artifact-message"))
            .toHaveText("Artifact is empty or still being written. Refresh to try again.");
        await expect(viewer.locator("#artifact-content")).toBeEmpty();
        await expect(viewer.getByRole("button", { name: "Refresh" })).toHaveCount(0);
        expect(await viewer.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.left === 0 && bounds.top === 0
                && bounds.width === innerWidth && bounds.height === innerHeight;
        })).toBe(true);
        await viewer.getByRole("button", { name: "Canvas" }).click();
        await expect(viewer).not.toBeVisible();
        await expect(page.locator("#instance-collection")).toBeVisible();
    } finally {
        await canvas.close();
    }
});

test("workflow list stays bounded and searchable across selection and refresh", async ({ page }) => {
    const canvas = await openGeneratedCanvas(true);
    try {
        for (let index = 1; index <= 12; index++) {
            await mkdir(join(canvas.root, "specs", `feature-${String(index).padStart(2, "0")}`),
                { recursive: true });
        }
        const artifact = join(canvas.root, "specs", "feature-11", "spec.md");
        const neighbor = join(canvas.root, "specs", "feature-12", "spec.md");
        await writeFile(artifact, "# Keep until confirmed");
        await writeFile(neighbor, "# Keep always");
        await page.setViewportSize({ width: 390, height: 780 });
        await page.goto(canvas.url);
        await expect(page.locator("#workflow-list .instance-select")).toHaveCount(12);
        await expect(page.locator("#workflow-search")).toBeVisible();
        await expect(page.locator("#workflow-count")).toHaveText("(12)");
        expect(await page.locator("#workflow-list").evaluate((list) =>
            list.scrollHeight > list.clientHeight && list.clientHeight <= 320)).toBe(true);
        await page.locator("#workflow-search").fill("FEATURE-11");
        await expect(page.locator("#workflow-list .instance-row:visible")).toHaveCount(1);
        await expect(page.locator("#workflow-list-status")).toHaveText("1 of 12 workflows match.");
        const invalid = await page.evaluate(async () => {
            const response = await fetch("/api/workflow/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-canvas-token": new URL(location.href).searchParams.get("token") },
                body: JSON.stringify({ itemId: "specs", confirmation: "specs", revision: 0 }),
            });
            return { status: response.status, message: (await response.json()).error };
        });
        expect(invalid.status).toBe(409);
        await expect(page.locator("#workflow-list .instance-select")).toHaveCount(12);
        await page.getByRole("button", { name: "feature-11", exact: true }).click();
        await expect(page.locator("#workflow-list .instance-row.active")).toContainText("feature-11");
        await expect(page.locator("#workflow-identity")).toBeHidden();
        await page.locator("#refresh-state").click();
        await expect(page.locator("#workflow-search")).toHaveValue("FEATURE-11");
        await expect(page.locator("#workflow-list .instance-row:visible")).toHaveCount(1);
        await page.getByRole("button", { name: "Delete feature-11" }).click();
        await expect(page.locator("#delete-workflow-dialog")).toBeVisible();
        await expect(page.locator("#delete-workflow-directory")).toHaveText("specs/feature-11");
        await page.getByRole("button", { name: "Cancel" }).click();
        expect(await readFile(artifact, "utf8")).toBe("# Keep until confirmed");
        await page.getByRole("button", { name: "Delete feature-11" }).click();
        await page.getByRole("button", { name: "Delete workflow" }).click();
        await expect(page.locator("#workflow-count")).toHaveText("(11)");
        await expect(page.locator("#workflow-list .instance-row.active")).toHaveCount(0);
        await expect(page.locator("#workflow-identity")).toBeVisible();
        await expect(readFile(artifact, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(neighbor, "utf8")).toBe("# Keep always");
        await page.locator("#workflow-search").fill("missing-workflow");
        await expect(page.locator("#workflow-list-status")).toHaveText("0 of 11 workflows match.");
        await page.locator("#new-workflow").click();
        await expect(page.locator("#workflow-identity")).toBeVisible();
        await page.setViewportSize({ width: 1100, height: 800 });
        await expect(page.locator("#workflow-list")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
        await canvas.close();
    }
});
