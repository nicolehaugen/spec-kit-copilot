import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { declarations, verifyComposition } from "../extension-canvas-design/scripts/verify-launch.mjs";

const source = fileURLToPath(new URL("../extension-canvas-design/", import.meta.url));

test("generated command declarations include appended pages and templates anywhere", async () => {
    const base = await readFile(join(source, "commands", "load-page.md"), "utf8");
    const appended = `${base}\n## Additional Canvas Design templates\n- \`sample-renderer\` — \`generated.renderer\`, \`replace\`\n`
        + "## Additional Designer pages\n- `sample-page`\n";
    const names = declarations(appended).map((entry) => entry.name);
    assert.ok(names.includes("canvas-settings-setup"));
    assert.ok(names.includes("canvas-stock-description"));
    assert.ok(names.includes("sample-renderer"));
    assert.ok(names.includes("sample-page"));
    assert.throws(() => declarations(`${appended}\n## Additional Canvas Design templates\n- \`sample-page\` — \`value.provider\`, \`replace\``),
        /Conflicting Canvas Design registration/);
    assert.throws(() => declarations(`${base}\n## Additional Canvas Design templates\n- \`bad\` — \`generated.renderer\`, \`append\``),
        /Invalid Canvas Design kind or strategy/);
    assert.throws(() => declarations(`${base}\n## Additional Canvas Design templates\n- \`bad\` — \`generated.renderer\`, \`replace\`, \`append\``),
        /Invalid Canvas Design kind or strategy/);
});

test("composed verification resolves every name, rejects warnings and native scripts before open", async (t) => {
    const project = await mkdtemp(join(tmpdir(), "canvas-composition-"));
    t.after(() => rm(project, { recursive: true, force: true }));
    const installed = join(project, ".specify", "extensions", "extension-canvas-design");
    await cp(source, installed, { recursive: true });
    const preset = join(project, ".specify", "presets", "sample");
    const contribution = "## Additional Designer pages\n- `sample-page`\n\n"
        + "## Additional Canvas Design templates\n- `sample-renderer` — `generated.renderer`, `replace`\n";
    await mkdir(join(preset, "commands"), { recursive: true });
    await mkdir(join(preset, "pages"), { recursive: true });
    await writeFile(join(preset, "commands", "load-page.md"), contribution);
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
        "canvas-settings-setup": join(installed, "pages", "essentials.json"),
        "canvas-settings-artifacts": join(installed, "pages", "artifacts.json"),
        "canvas-settings-appearance": join(installed, "pages", "appearance.json"),
        "canvas-stock-description": join(installed, "pages", "stock-description.json"),
        "canvas-stock-workflow-heading": join(installed, "pages", "stock-workflow-heading.json"),
        "canvas-stock-custom-slug": join(installed, "pages", "stock-custom-slug.json"),
    };
    const minimum = join(project, ".specify", "presets", "minimum", "commands", "load-page.md");
    await mkdir(join(project, ".specify", "presets", "minimum", "commands"),
        { recursive: true });
    const minimalBase = base.replace(/## Canvas Design templates[\s\S]*?(?=## Steps)/, "");
    await writeFile(minimum, minimalBase);
    let warning = false, collision = false, strategy = "replace", replacedBase = false;
    const run = async (_binary, args) => {
        if (args[2] === "command:speckit.extension-canvas-design.load-page") {
            return { stdout: JSON.stringify({ kind: "command", stack: [
                { strategy: "append", layer: "preset", sourceId: "sample" },
                { strategy: "replace", layer: replacedBase ? "preset" : "extension",
                    sourceId: replacedBase ? "minimum" : "extension-canvas-design",
                    sourcePath: replacedBase ? minimum : join(installed, "commands", "load-page.md") },
                ...(replacedBase ? [{ strategy: "replace", layer: "extension",
                    sourceId: "extension-canvas-design",
                    sourcePath: join(installed, "commands", "load-page.md") }] : []),
            ] }) };
        }
        const name = args[0] === "preset" ? args[2] : args[2].split(":")[1];
        if (args[0] === "preset") return { stdout: warning
            ? `${name}: not found`
            : `${name}: ${paths[name]}\n(top layer from: ${name.startsWith("sample-")
                ? "sample v1.0.0" : "extension:extension-canvas-design v0.1.10"})` };
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
    assert.equal(result.pages.length, 4);
    assert.equal(result.templates.length, 4);
    assert.deepEqual(result.templates.find((entry) => entry.name === "sample-renderer").sourceId, "sample");
    await writeFile(skill, base);
    await assert.rejects(verifyComposition(project, run), /missing sample-page from sample/);
    await writeFile(skill, `${base}\n${contribution}`);
    warning = true;
    await assert.rejects(verifyComposition(project, run), /warning or missing result/);
    warning = false;
    collision = true;
    await assert.rejects(verifyComposition(project, run), /native script collision/);
    collision = false;
    strategy = "append";
    await assert.rejects(verifyComposition(project, run), /replace-only template stack/);
    strategy = "replace";
    replacedBase = true;
    await writeFile(skill, `${minimalBase}\n${contribution}`);
    const intentionalReplacement = await verifyComposition(project, run);
    assert.equal(intentionalReplacement.pages.length, 4);
    assert.equal(intentionalReplacement.templates.length, 1);
});
