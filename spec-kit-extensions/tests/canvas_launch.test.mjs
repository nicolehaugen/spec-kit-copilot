import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { declarations, isInside, verifyComposition } from "../extension-canvas-design/scripts/verify-launch.mjs";

const source = fileURLToPath(new URL("../extension-canvas-design/", import.meta.url));

test("template containment rejects outside paths and other Windows drives", () => {
    const root = join(tmpdir(), "canvas-check", ".specify");
    assert.equal(isInside(root, join(root, "pages", "template.json")), true);
    assert.equal(isInside(root, root), false);
    assert.equal(isInside(root, join(root, "..", "template.json")), false);
    if (process.platform === "win32") {
        const otherDrive = root[0].toLowerCase() === "c" ? "D" : "C";
        assert.equal(isInside(root, `${otherDrive}:\\outside\\template.json`), false);
    }
});

test("generated skill declarations include appended pages and templates anywhere", async () => {
    const base = await readFile(join(source, "commands", "load-page.md"), "utf8");
    const entries = new Map(declarations(base).map((entry) => [entry.name, entry]));
    const settings = JSON.parse(await readFile(join(source, "designer-host",
        "badges-settings", "badge-types.json"), "utf8"));
    const ruleFiles = await readdir(join(source, "generated-host", "badges", "rules"));
    for (const { rule } of settings.types) {
        assert.equal(entries.get(`badge-rule-${rule}`)?.kind,
            "generated.badge-rule-definition", `${rule} must be registered in the composed skill`);
    }
    for (const filename of ruleFiles.filter((name) => name.endsWith(".json"))) {
        const id = filename.slice(0, -".json".length);
        assert.equal(entries.get(`badge-rule-${id}`)?.kind,
            "generated.badge-rule-definition", `${id} must be registered in the composed skill`);
    }
    const appended = `${base}\n## Additional Canvas Design templates\n- \`sample-renderer\` — \`generated.added-page-renderer\`, \`replace\`\n`
        + "## Additional Designer pages\n- `sample-page`\n";
    const names = declarations(appended).map((entry) => entry.name);
    assert.deepEqual(declarations("## Pages\n\nNo pages selected.\n"), []);
    assert.ok(names.includes("designer-essentials"));
    assert.ok(names.includes("designer-essentials-description"));
    assert.ok(names.includes("generated-phase-control"));
    assert.ok(names.includes("generated-phase-adapter"));
    assert.ok(names.includes("sample-renderer"));
    assert.ok(names.includes("sample-page"));
    assert.throws(() => declarations(`${appended}\n## Additional Canvas Design templates\n- \`sample-page\` — \`generated.computed-value-provider\`, \`replace\``),
        /Conflicting Canvas Design registration/);
    assert.throws(() => declarations(`${base}\n## Additional Canvas Design templates\n- \`bad\` — \`generated.added-page-renderer\`, \`append\``),
        /Invalid Canvas Design kind or strategy/);
    assert.throws(() => declarations(`${base}\n## Additional Canvas Design templates\n- \`bad\` — \`generated.added-page-renderer\`, \`replace\`, \`append\``),
        /Invalid Canvas Design kind or strategy/);
    assert.throws(() => declarations(`${base}\n## Additional Canvas Design templates\n- \`con\` — \`generated.phase-control-adapter\`, \`replace\``),
        /Invalid Canvas Design registration/);
});

test("composed verification resolves every name, rejects warnings and native scripts before open", async (t) => {
    const project = await mkdtemp(join(tmpdir(), "canvas-warning-ambiguous-"));
    t.after(() => rm(project, { recursive: true, force: true }));
    const installed = join(project, ".specify", "extensions", "extension-canvas-design");
    await cp(source, installed, { recursive: true });
    const preset = join(project, ".specify", "presets", "sample");
    const contribution = "## Additional Designer pages\n- `sample-page`\n\n"
        + "## Additional Canvas Design templates\n- `sample-renderer` — `generated.added-page-renderer`, `replace`\n";
    await mkdir(join(preset, "pages"), { recursive: true });
    await writeFile(join(preset, "pages", "sample.json"), "{}");
    await writeFile(join(preset, "pages", "renderer.mjs"), "export function renderPage() {}");
    const base = await readFile(join(installed, "commands", "load-page.md"), "utf8");
    const skill = join(project, ".github", "skills",
        "speckit-extension-canvas-design-load-page", "SKILL.md");
    await mkdir(join(project, ".github", "skills", "speckit-extension-canvas-design-load-page"),
        { recursive: true });
    await writeFile(skill, `${base}\n${contribution}`);
    const paths = {
        "sample-page": join(preset, "pages", "sample.json"),
        "sample-renderer": join(preset, "pages", "renderer.mjs"),
        "designer-essentials": join(installed, "designer-host", "tabs", "essentials.json"),
        "designer-artifacts": join(installed, "designer-host", "tabs", "outputs.json"),
        "designer-badges": join(installed, "designer-host", "tabs", "badges.json"),
        "designer-appearance": join(installed, "designer-host", "tabs", "appearance.json"),
        "designer-essentials-description": join(installed, "designer-host", "essentials-settings", "description.json"),
        "designer-essentials-workflow-heading": join(installed, "designer-host", "essentials-settings", "workflow-heading.json"),
        "designer-essentials-show-setup": join(installed, "designer-host", "essentials-settings", "show-setup.json"),
        "designer-essentials-header-logo": join(installed, "designer-host", "essentials-settings", "header-logo.json"),
        "designer-essentials-main-page-logo": join(installed, "designer-host", "essentials-settings", "main-page-logo.json"),
        ...Object.fromEntries(["light", "dark"].flatMap((mode) =>
            ["accent", "background", "surface", "secondary", "text"].map((color) =>
                [`designer-appearance-${mode}-${color}`,
                    join(installed, "designer-host", "appearance-settings", `${mode}-${color}.json`)]))),
        "generated-workflow": join(installed, "generated-host", "workflow-page", "workflow.json"),
        "generated-workflow-page-adapter": join(installed, "generated-host", "workflow-page",
            "generated-workflow-page-adapter.mjs"),
        "generated-phase-control": join(installed, "generated-host", "phase-control", "phase-control.json"),
        "generated-phase-adapter": join(installed, "generated-host", "phase-control", "generated-phase-adapter.mjs"),
        "generated-setup-dialog": join(installed, "generated-host", "dialog", "setup.json"),
        "generated-dialog-adapter": join(installed, "generated-host", "dialog", "generated-dialog-adapter.mjs"),
        "generated-setup-button-control": join(installed, "generated-host", "setup-button-control", "control.json"),
        "generated-setup-button-adapter": join(installed, "generated-host", "setup-button-control", "generated-setup-button-adapter.mjs"),
        "generated-setup-button": join(installed, "generated-host", "setup-button-control", "setup.json"),
        "badges-settings": join(installed, "designer-host", "badges-settings", "badge-types.json"),
        ...Object.fromEntries(["value-match", "artifact-current", "markdown-file-count", "checklist-progress",
            "checklist-complete", "work-complete", "phase-run-complete", "artifact-stale",
            "phase-artifact-complete"].map((id) =>
            [`badge-rule-${id}`, join(installed, "generated-host", "badges", "rules", `${id}.json`)])),
        ...Object.fromEntries(["content", "artifact-state", "run"].map((id) =>
            [`badge-rule-${id}-adapter`, join(installed, "generated-host", "badges", "adapters", `${id}.mjs`)])),
        "badge-rule-phase-artifact-complete-adapter": join(installed, "generated-host",
            "badges", "adapters", "phase-artifact-complete.mjs"),
        "shared-controls-image": join(installed, "shared-controls", "stock-image", "control.json"),
        "designer-control-adapter-image": join(installed, "shared-controls", "stock-image", "designer.mjs"),
        "generated-control-adapter-image": join(installed, "shared-controls", "stock-image", "generated.mjs"),
        "shared-controls-text": join(installed, "shared-controls", "stock-text", "control.json"),
        "designer-control-adapter-text": join(installed, "shared-controls", "stock-text", "designer.mjs"),
        "generated-control-adapter-text": join(installed, "shared-controls", "stock-text", "generated.mjs"),
        "shared-controls-checkbox": join(installed, "shared-controls", "stock-checkbox", "control.json"),
        "designer-control-adapter-checkbox": join(installed, "shared-controls", "stock-checkbox", "designer.mjs"),
    };
    const stockTemplateCount = declarations(base).filter((entry) => entry.kind !== "designer.tab-definition").length;
    const minimalBase = base.replace(/## Canvas Design templates[\s\S]*?(?=## Steps)/, "");
    let warning = "", collision = false, strategy = "replace";
    const run = async (_binary, args) => {
        const name = args[0] === "preset" ? args[2] : args[2].split(":")[1];
        if (args[0] === "preset") return { stdout: warning === "missing"
            ? `${name}: not found`
            : `${name}: ${paths[name]}\n(top layer from: ${name.startsWith("sample-")
                ? "sample v1.0.0" : "extension:extension-canvas-design v0.1.11"})`
                + (warning === "composition" ? "\nWarning: composition cannot produce output" : "") };
        if (args[2].startsWith("script:")) {
            if (collision) return { stdout: '{"kind":"script"}' };
            throw Object.assign(new Error("Unknown script"), { code: 1,
                stdout: JSON.stringify({ error: `unknown artifact script:${name}` }) });
        }
        const example = name.startsWith("sample-");
        return { stdout: JSON.stringify({
            kind: "template", name, stack: [{ active: true, strategy,
                layer: example ? "preset" : "extension",
                sourceId: example ? "sample" : "extension-canvas-design",
                sourcePath: paths[name] }],
        }) };
    };
    const result = await verifyComposition(project, run);
    assert.equal(result.pages.length, 5);
    assert.equal(result.templates.length, stockTemplateCount + 1);
    assert.deepEqual(result.templates.find((entry) => entry.name === "sample-renderer").sourceId, "sample");
    await writeFile(skill, base);
    const baseOnly = await verifyComposition(project, run);
    assert.equal(baseOnly.pages.length, 4);
    assert.equal(baseOnly.templates.length, stockTemplateCount);
    await writeFile(skill, `${base}\n${contribution}`);
    warning = "missing";
    await assert.rejects(verifyComposition(project, run), /warning or missing result/);
    warning = "composition";
    await assert.rejects(verifyComposition(project, run), /warning or missing result/);
    warning = "";
    collision = true;
    await assert.rejects(verifyComposition(project, run), /native script collision/);
    collision = false;
    strategy = "append";
    await assert.rejects(verifyComposition(project, run), /replace-only template stack/);
    strategy = "replace";
    await writeFile(skill, `${minimalBase}\n${contribution}`);
    const intentionalReplacement = await verifyComposition(project, run);
    assert.equal(intentionalReplacement.pages.length, 5);
    assert.equal(intentionalReplacement.templates.length, 1);
    await writeFile(skill, "## Pages\n\nNo pages selected.\n");
    assert.deepEqual(await verifyComposition(project, run), { pages: [], templates: [] });
});
