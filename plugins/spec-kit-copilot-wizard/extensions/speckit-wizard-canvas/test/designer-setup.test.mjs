import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildDesignerHandoff } from "../server/handlers-designer.mjs";
import { finalizeDesignerSetup, installDesignerSetup, runSpecify,
    verifyComposedLoadPage } from "../server/designer-setup.mjs";
import { designerOpenInputSchema, validateDesignerOpenInput } from
    "../../speckit-canvas-designer/contracts/host-open.mjs";
import { checkSchema } from "../../speckit-canvas-designer/contracts/design-contributions.mjs";

const baseUrl = "https://example.org/canvas.zip?x=1&y=2";
const baseCatalog = {
    presets: [], bundles: [],
    extensions: [{ id: "extension-canvas-design", source: "copilot",
        version: "1.0.0", downloadUrl: baseUrl, tags: ["canvas-design"] }],
};
const empty = { presets: [], extensions: [], bundles: [] };

async function fixture(t, { installed = empty, selections = empty,
    localSelections, locators = empty, verifier = true } = {}) {
    const project = await mkdtemp(join(tmpdir(), "designer-setup-child-"));
    const root = await mkdtemp(join(tmpdir(), "designer-setup-session-"));
    t.after(() => Promise.all([rm(project, { recursive: true, force: true }),
        rm(root, { recursive: true, force: true })]));
    await mkdir(join(project, ".specify"));
    const id = randomUUID();
    const handoff = buildDesignerHandoff({ catalog: baseCatalog, pipeline: [{ id: "plan" }] },
        selections, localSelections, installed, id, locators);
    const json = JSON.stringify(handoff);
    const hash = createHash("sha256").update(json).digest("hex");
    const handoffDir = join(root, "speckit-canvas-designer", "handoffs", id);
    await mkdir(handoffDir, { recursive: true });
    await writeFile(join(handoffDir, "handoff.json"), json);
    const packages = { extensions: [], presets: [], bundles: [] };
    const calls = [];
    const skill = join(project, ".github", "skills", "speckit-extension-canvas-design-load-page", "SKILL.md");
    async function run(binary, args, options) {
        calls.push(args);
        if (binary === process.execPath) {
            return { stdout: JSON.stringify({
                pages: [{ name: "designer-essentials", path: join(project, "page.json"),
                    kind: "designer.tab-definition", strategy: "replace" }],
                templates: [],
            }), stderr: "" };
        }
        const [group, verb] = args;
        if (group === "artifact") return { stdout: JSON.stringify([{
            id: "command:speckit.extension-canvas-design.load-page",
            name: "speckit.extension-canvas-design.load-page", kind: "command",
            stack: [{ active: true, layer: "extension", sourceId: "extension-canvas-design" }],
        }]) };
        if (verb === "list") return { stdout: JSON.stringify(group === "bundle"
            ? packages.bundles : packages[group === "extension" ? "extensions" : "presets"]) };
        if (verb === "catalog") return { stdout: "" };
        if (group === "bundle" && verb === "install") {
            packages.bundles.push({ bundle_id: "kit", version: "2.0.0" });
            return { stdout: "" };
        }
        if (["extension", "preset"].includes(group) && verb === "remove") {
            const items = packages[group === "extension" ? "extensions" : "presets"];
            items.splice(items.findIndex((item) => item.id === args[2]), 1);
            return { stdout: "" };
        }
        if (["extension", "preset"].includes(group) && ["enable", "disable", "set-priority"].includes(verb)) {
            const item = packages[group === "extension" ? "extensions" : "presets"]
                .find((entry) => entry.id === args[2]);
            if (verb === "set-priority") item.priority = Number(args[3]);
            else item.enabled = verb === "enable";
            return { stdout: "" };
        }
        if (["extension", "preset"].includes(group) && verb === "add") {
            const kind = group === "extension" ? "extensions" : "presets";
            const local = args.includes("--dev");
            const name = group === "preset" && args.includes("--dev") ? "pirate-full"
                : args[2] === "pirate" ? "pirate-full" : "extension-canvas-design";
            const version = name === "pirate-full" ? "1.1.0" : "1.0.0";
            const item = { id: name, version, priority: 10, enabled: true,
                source: { kind: "local" } };
            const old = packages[kind].findIndex((entry) => entry.id === name);
            if (old !== -1) {
                if (group === "preset") throw new Error(`Preset '${name}' is already installed`);
                packages[kind].splice(old, 1);
            }
            packages[kind].push(item);
            const folder = join(project, ".specify", kind, name);
            await mkdir(folder, { recursive: true });
            await writeFile(join(folder, `${group}.yml`),
                `${group}:\n  id: ${name}\n  name: Test\n  version: ${version}\n`);
            if (name === "extension-canvas-design") {
                await mkdir(join(project, ".github", "skills", "speckit-extension-canvas-design-load-page"),
                    { recursive: true });
                await writeFile(skill, "## Pages\n- `designer-essentials`\n");
                if (verifier) {
                    await mkdir(join(folder, "scripts"), { recursive: true });
                    await writeFile(join(folder, "scripts", "verify-launch.mjs"), "");
                }
            }
            return { stdout: "" };
        }
        throw new Error(`Unexpected ${args.join(" ")}`);
    }
    return { project, root, id, hash, handoff, calls, packages, skill, run,
        deps: { run, check: async () => ({ initialized: true, checkout: project }),
            verifyBase: async () => ({ warnings: [] }),
            verifyLocal: async () => ({ id: "extension-canvas-design" }) } };
}

test("scripted setup keeps Specify installation order and uses frozen catalog keys", async (t) => {
    const installed = { extensions: [], presets: [{ id: "pirate-full", version: "1.0.0",
        priority: 4, enabled: false, source: "community" }],
    bundles: [{ id: "kit", version: "2.0.0" }] };
    const locators = { extensions: [], presets: [{
        installedId: "pirate-full", source: "community", catalogId: "pirate",
        downloadUrl: "https://example.org/pirate.zip",
    }], bundles: [{ installedId: "kit", source: "community", catalogId: "kit",
        downloadUrl: "https://example.org/kit.zip" }] };
    const f = await fixture(t, { installed, locators });
    const result = await installDesignerSetup(f.project, f.root, f.id, f.hash, {
        ...f.deps, download: async (_url, path) => writeFile(path, "zip"),
    });
    assert.equal(result.stage, "installed");
    assert.ok(result.warnings.some((warning) => /pirate-full version drift/.test(warning)));
    const actions = f.calls.filter((args) => ["install", "add"].includes(args[1]));
    assert.deepEqual(actions.map((args) => args.slice(0, 3)), [
        ["extension", "add", "extension-canvas-design"],
        ["bundle", "install", actions[1][2]],
        ["extension", "add", "extension-canvas-design"],
        ["preset", "add", "pirate"],
    ]);
    assert.match(actions[1][2], /bundle\.zip$/);
    assert.equal(f.packages.presets[0].enabled, false);
    assert.equal(f.packages.presets[0].priority, 4);
    assert.equal(f.calls.filter((args) => args[0] === "artifact").length, 1);
    const finalized = await finalizeDesignerSetup(f.project, f.root, f.id, f.hash, f.deps);
    assert.equal(finalized.stage, "ready");
    assert.deepEqual(Object.keys(finalized.openInput),
        ["handoffId", "pages", "templates"]);
    assert.equal(finalized.openInput.handoffId, f.id);
    assert.equal(finalized.openInput.pages[0].name, "designer-essentials");
    assert.equal(finalized.openInput.templates.length, 0);
    assert.deepEqual(validateDesignerOpenInput(finalized.openInput),
        { preview: undefined, ...finalized.openInput });
    assert.doesNotThrow(() => checkSchema(finalized.openInput,
        designerOpenInputSchema, "Designer open input"));
    assert.throws(() => checkSchema({ ...finalized.openInput, timings: finalized.timings },
        designerOpenInputSchema, "Designer open input"), /unsupported property timings/);
    assert.throws(() => checkSchema({ ...finalized.openInput, warnings: finalized.warnings },
        designerOpenInputSchema, "Designer open input"), /unsupported property warnings/);
    assert.ok(!Object.hasOwn(finalized.openInput, "timings"));
    assert.ok(!Object.hasOwn(finalized.openInput, "warnings"));
    assert.ok(Object.hasOwn(finalized, "timings"));
    assert.ok(Object.hasOwn(finalized, "warnings"));
    assert.equal(f.calls.filter((args) => args[0] === process.execPath).length, 0);
    assert.equal(f.calls.filter((args) => args[0]?.endsWith("verify-launch.mjs")).length, 1);
});

test("finalize rejects a verifier payload incompatible with the Designer open schema", async (t) => {
    const f = await fixture(t);
    await installDesignerSetup(f.project, f.root, f.id, f.hash, f.deps);
    await assert.rejects(finalizeDesignerSetup(f.project, f.root, f.id, f.hash, {
        ...f.deps,
        run: async (binary, args, options) => {
            const result = await f.run(binary, args, options);
            if (binary !== process.execPath) return result;
            const payload = JSON.parse(result.stdout);
            payload.pages[0].timings = { finalize: 1 };
            return { ...result, stdout: JSON.stringify(payload) };
        },
    }), /Designer open input.pages\[0\]: unsupported property timings/);
});

test("older package requires manual Specify resolution, never an empty open input", async (t) => {
    const f = await fixture(t, { verifier: false });
    await installDesignerSetup(f.project, f.root, f.id, f.hash, f.deps);
    const result = await finalizeDesignerSetup(f.project, f.root, f.id, f.hash, f.deps);
    assert.equal(result.stage, "manual-resolution");
    assert.equal(Object.hasOwn(result, "pages"), false);
    assert.equal(Object.hasOwn(result, "openInput"), false);
});

test("setup rejects a changed handoff before any installation", async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.root, "speckit-canvas-designer", "handoffs", f.id, "handoff.json"),
        `${JSON.stringify(f.handoff)}changed`);
    await assert.rejects(installDesignerSetup(f.project, f.root, f.id, f.hash, f.deps),
        /handoff bytes changed/);
    assert.deepEqual(f.calls, []);
});

test("Specify command composition must resolve through its active artifact stack", async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.project, ".github", "skills", "speckit-extension-canvas-design-load-page"),
        { recursive: true });
    await writeFile(f.skill, "## Pages\n- `designer-essentials`\n");
    await assert.rejects(verifyComposedLoadPage(f.project, async () =>
        JSON.stringify([{ id: "command:speckit.extension-canvas-design.load-page",
            name: "speckit.extension-canvas-design.load-page", kind: "command",
            stack: [{ active: false }] }])), /did not resolve/);
});

test("Specify subprocess treats zero-exit composition warnings as errors", async () => {
    await assert.rejects(runSpecify(process.cwd(), ["preset", "add", "test"],
        async () => ({ stdout: "Warning: no base command layer", stderr: "" })),
    /composition warning/);
    await assert.rejects(runSpecify(process.cwd(), ["preset", "add", "test"],
        async () => ({ stdout: "\u26a0 Command composition incomplete", stderr: "" })),
    /composition warning/);
    assert.match(await runSpecify(process.cwd(), ["init", "--here", "--force"],
        async () => ({ stdout: "Warning: Current directory is not empty (18 items)\nProject ready.",
            stderr: "" })), /Project ready/);
});

test("only frozen URL installs receive the Specify untrusted-source confirmation", async () => {
    const inputs = [];
    const run = (_binary, _args, options) => {
        assert.equal(options.shell, process.platform === "win32" ? false : undefined);
        const execution = Promise.resolve({ stdout: "" });
        execution.child = { stdin: { end: (value) => inputs.push(value) } };
        return execution;
    };
    await runSpecify(process.cwd(), ["extension", "add", "approved",
        "--from", "https://example.org/approved.zip"], run);
    await runSpecify(process.cwd(), ["extension", "list", "--json"], run);
    await runSpecify(process.cwd(), ["bundle", "install", "approved.zip"], run,
        { confirmApprovedSource: true });
    assert.deepEqual(inputs, ["y\n", "y\n"]);
});

test("approved local override supersedes the frozen runtime source and retains state", async (t) => {
    const source = await mkdtemp(join(tmpdir(), "designer-local-preset-"));
    t.after(() => rm(source, { recursive: true, force: true }));
    await writeFile(join(source, "preset.yml"),
        "preset:\n  id: pirate-full\n  name: Local override\n  version: 1.1.0\n");
    const installed = { extensions: [], presets: [{ id: "pirate-full", version: "0.9.0",
        source: "community", priority: 4, enabled: false }], bundles: [] };
    const locators = { extensions: [], presets: [{ installedId: "pirate-full",
        source: "local", path: source }], bundles: [] };
    const localSelections = { presets: [{ id: "pirate-full", approved: true, source: "local",
        path: source, version: "1.1.0" }] };
    const f = await fixture(t, { installed, locators, localSelections });
    const result = await installDesignerSetup(f.project, f.root, f.id, f.hash, f.deps);
    assert.equal(result.stage, "installed");
    assert.ok(f.calls.some((args) => args[0] === "preset" && args.includes("--dev")
        && args.includes(source)));
    assert.ok(!f.calls.some((args) => args.includes("community")));
    assert.equal(f.packages.presets[0].priority, 4);
    assert.equal(f.packages.presets[0].enabled, false);
});

test("selected catalog key may install a different manifest ID", async (t) => {
    const selections = { extensions: [], bundles: [], presets: [{
        id: "pirate", source: "community", approved: true,
        version: "1.0.0", downloadUrl: "https://example.org/pirate.zip",
    }] };
    const f = await fixture(t, { selections });
    const installed = await installDesignerSetup(f.project, f.root, f.id, f.hash, f.deps);
    assert.equal(installed.stage, "installed");
    assert.ok(f.calls.some((args) => args[0] === "preset" && args[1] === "add"
        && args[2] === "pirate"));
    assert.equal(f.packages.presets[0].id, "pirate-full");
    assert.ok(installed.warnings.some((warning) => /pirate-full version drift/.test(warning)));
});

test("incompatible catalog configuration and absent CLI stop before installation", async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.project, ".specify", "extension-catalogs.yml"),
        "catalogs:\n- name: spec-kit-copilot\n  url: https://example.org/other.json\n  install_allowed: true\n");
    await assert.rejects(installDesignerSetup(f.project, f.root, f.id, f.hash, f.deps),
        /differs from the approved source/);
    assert.ok(!f.calls.some((args) => args[1] === "add"));
    const missing = await fixture(t);
    await assert.rejects(installDesignerSetup(missing.project, missing.root, missing.id,
        missing.hash, { ...missing.deps, check: async () => {
            const error = new Error("not found");
            error.code = "ENOENT";
            throw error;
        } }), /invoke speckit-cli-setup and retry/);
    assert.deepEqual(missing.calls, []);
});

test("a catalog source mismatch blocks even a URL-based package install", async (t) => {
    const f = await fixture(t);
    await assert.rejects(installDesignerSetup(f.project, f.root, f.id, f.hash, {
        ...f.deps, run: async (binary, args, options) => {
            const result = await f.run(binary, args, options);
            if (args[0] === "extension" && args[1] === "list") {
                const list = JSON.parse(result.stdout);
                return { stdout: JSON.stringify(list.map((item) => ({
                    ...item, source: { kind: "catalog", catalog: "wrong-source" },
                }))) };
            }
            return result;
        },
    }), /differs from the frozen catalog source/);
});

test("bundle install failure cleans up its temporary download", async (t) => {
    const installed = { extensions: [], presets: [], bundles: [{ id: "kit", version: "2.0.0" }] };
    const locators = { extensions: [], presets: [], bundles: [{
        installedId: "kit", catalogId: "kit", source: "community",
        downloadUrl: "https://example.org/kit.zip",
    }] };
    const f = await fixture(t, { installed, locators });
    let path;
    await assert.rejects(installDesignerSetup(f.project, f.root, f.id, f.hash, {
        ...f.deps,
        download: async (_url, target) => {
            path = target;
            await writeFile(target, "zip");
        },
        run: async (binary, args, options) => {
            if (args[0] === "bundle" && args[1] === "install") throw new Error("bundle rejected");
            return f.run(binary, args, options);
        },
    }), /bundle rejected/);
    await assert.rejects(access(path), { code: "ENOENT" });
});

test("real Specify composes commands and resolves templates in a fresh child", {
    skip: process.env.SPECIFY_E2E !== "1",
}, async (t) => {
    const project = await mkdtemp(join(tmpdir(), "designer-real-child-"));
    const root = await mkdtemp(join(tmpdir(), "designer-real-session-"));
    t.after(() => Promise.all([rm(project, { recursive: true, force: true }),
        rm(root, { recursive: true, force: true })]));
    const source = fileURLToPath(new URL("../../../../../spec-kit-extensions/extension-canvas-design/", import.meta.url))
        .replace(/[\\/]$/, "");
    const preset = fileURLToPath(new URL("../../../../../spec-kit-presets/copilot-canvas-design-test/", import.meta.url))
        .replace(/[\\/]$/, "");
    const id = randomUUID();
    const handoff = buildDesignerHandoff({
        catalog: baseCatalog, pipeline: [{ id: "plan" }],
    }, empty, { extensions: [{ id: "extension-canvas-design", source: "local",
        path: source, approved: true }],
    presets: [{ id: "copilot-canvas-design-test", source: "local",
        path: preset, approved: true }] }, empty, id, empty);
    const json = JSON.stringify(handoff);
    const hash = createHash("sha256").update(json).digest("hex");
    const directory = join(root, "speckit-canvas-designer", "handoffs", id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "handoff.json"), json);
    const installed = await installDesignerSetup(project, root, id, hash);
    assert.equal(installed.stage, "installed");
    assert.ok(installed.timings.init >= 0);
    const ready = await finalizeDesignerSetup(project, root, id, hash);
    assert.equal(ready.stage, "ready");
    assert.ok(ready.openInput.pages.some((entry) => entry.name === "designer-essentials"));
    assert.ok(ready.openInput.pages.some((entry) => entry.name === "canvas-settings-pr1-test"));
    assert.ok(ready.openInput.templates.some((entry) => entry.name === "canvas-contribution-pr1-test"));
    assert.ok(ready.openInput.templates.some((entry) => entry.name === "generated-workflow"));
    t.diagnostic(`Specify child stages (ms): ${JSON.stringify({
        ...installed.timings, ...ready.timings,
    })}`);
    const skill = join(project, ".github", "skills", "speckit-extension-canvas-design-load-page", "SKILL.md");
    await writeFile(skill, (await readFile(skill, "utf8"))
        .replace("`canvas-settings-pr1-test`", "`missing-page`"));
    await assert.rejects(finalizeDesignerSetup(project, root, id, hash),
        /registration canvas-settings-pr1-test is missing from Specify's composed command/);
});
