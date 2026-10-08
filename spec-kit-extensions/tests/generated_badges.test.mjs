import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { evaluate as checklist } from
    "../extension-canvas-design/generated-host/badges/adapters/content.mjs";
import { evaluate as valueMatch } from
    "../extension-canvas-design/generated-host/badges/adapters/content.mjs";

const generated = await mkdtemp(join(process.cwd(), ".generated-badge-package-"));
after(() => rm(generated, { recursive: true, force: true }));
await cp(new URL("../extension-canvas-design/generated-scaffold/", import.meta.url),
    generated, { recursive: true });
await mkdir(join(generated, "badges"), { recursive: true });
for (const name of ["content", "artifact-state", "run"]) {
    await cp(new URL(`../extension-canvas-design/generated-host/badges/adapters/${name}.mjs`,
        import.meta.url), join(generated, "badges", `badge-rule-${name}-adapter.mjs`));
}
await cp(new URL("../extension-canvas-design/generated-host/badges/adapters/phase-artifact-complete.mjs",
    import.meta.url), join(generated, "badges", "badge-rule-phase-artifact-complete-adapter.mjs"));
const { evaluateBadges, validateBadges, verifyBadgeModules } =
    await import(pathToFileURL(join(generated, "badge-runtime.mjs")).href);
const { createRuntime } = await import(pathToFileURL(join(generated, "runtime.mjs")).href);
const { countMarkdownDirectory } = await import(pathToFileURL(join(generated, "files.mjs")).href);
const { readBoundedWithMetadata } = await import(pathToFileURL(join(generated, "files.mjs")).href);

test("badge text and freshness metadata come from the same validated artifact", async (t) => {
    const cwd = await mkdtemp(join(process.cwd(), ".badge-artifact-version-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await writeFile(join(cwd, "artifact.md"), "old");
    const replacement = join(cwd, "replacement.md");
    await writeFile(replacement, "new");
    await utimes(replacement, new Date("2024-01-01"), new Date("2024-01-01"));
    await rename(replacement, join(cwd, "artifact.md"));
    const evidence = await readBoundedWithMetadata(cwd, "artifact.md", 128 * 1024);
    assert.deepEqual(evidence, { text: "new", mtimeMs: (await stat(join(cwd, "artifact.md"))).mtimeMs });
});

const moduleFile = new URL("../extension-canvas-design/generated-host/badges/adapters/content.mjs",
    import.meta.url);
const hash = createHash("sha256").update(await readFile(moduleFile)).digest("hex");
const rule = { id: "checklist-progress", label: "Progress", description: "Progress",
    inputs: [{ id: "artifact", type: "artifact" }], textPlaceholders: ["completed", "total", "percent"],
    module: "badge-rule-content-adapter", hash };
const type = { id: "progress", title: "Progress", description: "Progress",
    rule: rule.id, defaultText: "{completed}/{total} complete", defaultColor: "blue", enabled: true };
const instance = { id: "work", type: type.id, inputs: { artifact: {
    phase: "tasks", output: "specs/<slug>/tasks.md",
} }, text: "{completed}/{total} complete", color: "blue",
    showIn: ["workflow-list", "workflow-summary", "phase-card"], phase: "tasks" };
const badges = { instances: [instance], types: [type], rules: [rule] };
const fileRule = { ...rule, id: "markdown-file-count",
    inputs: [{ id: "artifact", type: "artifact", scope: "directory" }],
    textPlaceholders: ["count"] };
const fileType = { ...type, id: "markdown-file-count", title: "Markdown files",
    rule: fileRule.id, defaultText: "Files ({count})" };
const fileInstance = { id: "files", type: fileType.id,
    inputs: { artifact: { phase: "review", output: "work/<slug>/review/<name>.md" } },
    text: "Files ({count})", color: "blue",
    showIn: ["workflow-list", "workflow-summary"], phase: null };
const fileBadges = { instances: [fileInstance], types: [fileType], rules: [fileRule] };
const completeRule = { ...rule, id: "checklist-complete",
    inputs: [{ id: "artifact", type: "artifact", label: "Checklist output" },
        { id: "prerequisite", type: "artifact", label: "Earlier output" }],
    textPlaceholders: [] };
const completeType = { ...type, id: "checklist-complete", title: "Checklist complete",
    rule: completeRule.id, defaultText: "Checklist complete" };
const completeInstance = { ...instance, id: "completed", type: completeType.id,
    inputs: { artifact: { phase: "tasks", output: "specs/<slug>/tasks.md" },
        prerequisite: { phase: "plan", output: "specs/<slug>/plan.md" } },
    text: "Checklist complete" };
const completeBadges = { instances: [completeInstance], types: [completeType],
    rules: [completeRule] };
const phaseArtifactAdapter = new URL(
    "../extension-canvas-design/generated-host/badges/adapters/phase-artifact-complete.mjs",
    import.meta.url);
const phaseArtifactRule = { id: "phase-artifact-complete", label: "Phase artifact complete",
    description: "Ordered phase outputs", placementPhaseInput: "target",
    inputs: [{ id: "target", type: "artifact", scope: "metadata" },
        { id: "prerequisites", type: "ordered-artifacts", scope: "metadata", before: "target" }],
    textPlaceholders: [], module: "badge-rule-phase-artifact-complete-adapter",
    hash: createHash("sha256").update(await readFile(phaseArtifactAdapter)).digest("hex") };
const phaseArtifactType = { ...type, id: "phase-artifact-complete",
    title: "Phase artifact complete", rule: phaseArtifactRule.id,
    defaultText: "Phase complete" };
const phaseArtifactInstance = { ...instance, id: "phase-artifact",
    type: phaseArtifactType.id, text: "List ready", phase: null,
    showIn: ["workflow-list", "workflow-summary"],
    phaseText: "Card ready", summaryText: "{workflows} workflows ready",
    targets: [{ phase: "tasks", output: null }],
    inputs: { target: { phase: "tasks", output: "specs/<slug>/tasks.md" },
        prerequisites: [{ phase: "specify", output: "specs/<slug>/spec.md" },
            { phase: "plan", output: "specs/<slug>/plan.md" }] } };
const phaseArtifactBadges = { instances: [phaseArtifactInstance],
    types: [phaseArtifactType], rules: [phaseArtifactRule] };

test("ordered phase badge uses metadata only, compares neighbors and counts matching workflows", async (t) => {
    const cwd = await mkdtemp(join(process.cwd(), ".generated-phase-artifact-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const phases = ["specify", "plan", "tasks"].map((id) =>
        ({ id, outputs: [`specs/<slug>/${id === "specify" ? "spec" : id}.md`] }));
    for (const name of ["alpha", "beta"]) {
        await mkdir(join(cwd, "specs", name), { recursive: true });
        for (const file of ["spec.md", "plan.md", "tasks.md"]) {
            await writeFile(join(cwd, "specs", name, file), Buffer.alloc(128 * 1024 + 1, 0xff));
        }
    }
    const path = (name, file) => join(cwd, "specs", name, file);
    for (const name of ["alpha", "beta"]) {
        for (const [offset, file] of ["spec.md", "plan.md", "tasks.md"].entries()) {
            await utimes(path(name, file), new Date(1_600_000_000_000 + 2000 * offset),
                new Date(1_600_000_000_000 + 2000 * offset));
        }
    }
    validateBadges(phaseArtifactBadges, phases);
    await verifyBadgeModules(phaseArtifactBadges);
    const evaluate = (config = phaseArtifactBadges) => evaluateBadges(config, { cwd,
        workflows: ["specs/alpha", "specs/beta"], phases,
        outputPath: async ({ output }, workflow) => output.replace("specs/<slug>", workflow),
        runFor: () => { throw new Error("Metadata rule must not consult phase runs"); } });
    const result = await evaluate();
    assert.deepEqual(result.summary, [{ id: "phase-artifact", color: "blue", count: 2,
        text: "2 workflows ready" }]);
    assert.deepEqual(result.items["specs/alpha"][0], {
        id: "phase-artifact", text: "List ready", phaseText: "Card ready", color: "blue",
        showIn: phaseArtifactInstance.showIn, targets: [{ phase: "tasks", output: null }],
    });
    for (const file of ["spec.md", "plan.md", "tasks.md"]) {
        await utimes(path("alpha", file), new Date(1_600_000_000_000),
            new Date(1_600_000_000_000));
    }
    assert.equal((await evaluate()).summary[0].count, 2);
    await utimes(path("beta", "plan.md"), new Date(1_600_000_000_000 - 2000),
        new Date(1_600_000_000_000 - 2000));
    assert.equal((await evaluate()).summary[0].count, 1);
    await rm(path("alpha", "plan.md"));
    assert.equal((await evaluate()).summary[0].count, 0);
    await mkdir(path("alpha", "plan.md"));
    const unsafe = await evaluate();
    assert.equal(unsafe.summary[0].count, 0);
    assert.ok(unsafe.diagnostics.some((message) => /could not be read safely/.test(message)));
    await rm(path("alpha", "plan.md"), { recursive: true });
    let hasLink = false;
    try {
        await symlink(path("alpha", "spec.md"), path("alpha", "plan.md"), "file");
        hasLink = true;
    } catch (error) {
        if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
        t.diagnostic("Symlink creation is unavailable in this environment");
    }
    if (hasLink) {
        const linked = await evaluate();
        assert.equal(linked.summary[0].count, 0);
        assert.ok(linked.diagnostics.some((message) => /could not be read safely/.test(message)));
        await rm(path("alpha", "plan.md"));
    }
    const targetOnly = { ...phaseArtifactBadges, instances: [{ ...phaseArtifactInstance,
        inputs: { target: { phase: "specify", output: "specs/<slug>/spec.md" },
            prerequisites: [] }, targets: [{ phase: "specify", output: null }] }] };
    assert.equal((await evaluate(targetOnly)).summary[0].count, 2);
    const skipPlan = { ...phaseArtifactBadges, instances: [{ ...phaseArtifactInstance,
        inputs: { ...phaseArtifactInstance.inputs,
            prerequisites: [phaseArtifactInstance.inputs.prerequisites[0]] } }] };
    assert.equal((await evaluate(skipPlan)).summary[0].count, 2);
    for (const invalid of [
        { ...phaseArtifactInstance.inputs, prerequisites: [phaseArtifactInstance.inputs.target] },
        { ...phaseArtifactInstance.inputs, prerequisites: [
            phaseArtifactInstance.inputs.prerequisites[1],
            phaseArtifactInstance.inputs.prerequisites[0]] },
    ]) {
        assert.throws(() => validateBadges({ ...phaseArtifactBadges,
            instances: [{ ...phaseArtifactInstance, inputs: invalid }] }, phases),
        /Invalid generated badge/);
    }
    assert.throws(() => validateBadges({ ...phaseArtifactBadges,
        instances: [{ ...phaseArtifactInstance, targets: [{ phase: "plan", output: null }] }] },
    phases), /phase-card destination/);
});

test("badge evaluator counts checkboxes outside fences and ignores empty checklists", async () => {
    assert.deepEqual(await checklist({ ruleId: "checklist-progress", inputs: { artifact: {
        phase: "tasks", output: "tasks.md" } },
        evidence: { readArtifact: async () => ({
            state: "ok", text: "- [x] done\n- [ ] later\n```\n- [x] fake\n```",
        }) } }),
    { match: true, values: { completed: 1, total: 2, percent: 50 } });
    assert.equal((await checklist({ ruleId: "checklist-complete",
        inputs: { artifact: { phase: "tasks", output: "tasks.md" } },
        evidence: { readArtifact: async () => ({ state: "ok", text: "No work" }) } })).match, false);
    assert.deepEqual(await valueMatch({ ruleId: "value-match", inputs: {
        artifact: { phase: "tasks", output: "tasks.md" }, value: "VERDICT: NEEDS-CLARIFICATION",
    }, evidence: { readArtifact: async () => ({
        state: "ok", text: "Verdict: needs-clarification",
    }) } }), { match: true });
});

test("resolved badge instances evaluate per workflow using confined artifact reads", async (t) => {
    const cwd = await mkdtemp(join(process.cwd(), ".generated-badge-test-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, "specs", "alpha"), { recursive: true });
    await writeFile(join(cwd, "specs", "alpha", "tasks.md"),
        "- [x] first\n- [ ] second\n");
    validateBadges(badges, ["tasks"]);
    assert.throws(() => validateBadges({ ...badges, instances: [{
        ...instance, showIn: ["list", "summary", "phase"],
    }] }, ["tasks"]), /Invalid generated badge instance/);
    await verifyBadgeModules(badges);
    const phases = [{ id: "tasks", outputs: ["specs/<slug>/tasks.md"] }];
    const result = await evaluateBadges(badges, { cwd,
        workflows: ["specs/alpha", "specs/beta"], phases,
        outputPath: async (_, workflow) => `${workflow}/tasks.md`,
        runFor: () => null });
    assert.deepEqual(result.items["specs/alpha"], [{
        id: "work", text: "1/2 complete", color: "blue",
        showIn: ["workflow-list", "workflow-summary", "phase-card"], phase: "tasks",
    }]);
    assert.deepEqual(result.items["specs/beta"], []);
    assert.deepEqual(result.summary, [{ id: "work", color: "blue", count: 1,
        text: "Progress (1)" }]);
    const differentlyLabeled = { ...badges, instances: [instance, {
        ...instance, id: "other", text: "Tasks: {completed} of {total}",
    }] };
    validateBadges(differentlyLabeled, phases);
    const repeated = await evaluateBadges(differentlyLabeled, { cwd,
        workflows: ["specs/alpha"], phases,
        outputPath: async (_, workflow) => `${workflow}/tasks.md`,
        runFor: () => null });
    assert.deepEqual(repeated.items["specs/alpha"].map(({ id, text }) => ({ id, text })), [
        { id: "work", text: "1/2 complete" },
        { id: "other", text: "Tasks: 1 of 2" },
    ]);
    assert.throws(() => validateBadges({ ...badges,
        instances: [{ ...instance, inputs: { artifact: { phase: "not-declared" } } }] },
    ["tasks"]), /Invalid generated badge input/);
    await assert.rejects(() => verifyBadgeModules({ rules: [{ ...rule,
        hash: "0".repeat(64) }] }), /frozen hash/);
});

test("generated Checklist complete badges require a current checklist and earlier output", async (t) => {
    const cwd = await mkdtemp(join(process.cwd(), ".generated-badge-checklist-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const directory = join(cwd, "specs", "alpha");
    await mkdir(directory, { recursive: true });
    const plan = join(directory, "plan.md");
    const tasks = join(directory, "tasks.md");
    await writeFile(plan, "# Plan");
    await writeFile(tasks, "- [x] first\n- [x] second");
    const phases = [{ id: "plan", outputs: ["specs/<slug>/plan.md"] },
        { id: "tasks", outputs: ["specs/<slug>/tasks.md"] }];
    validateBadges(completeBadges, phases);
    for (const input of [
        { artifact: completeInstance.inputs.artifact },
        { ...completeInstance.inputs, prerequisite: completeInstance.inputs.artifact },
        { artifact: completeInstance.inputs.prerequisite,
            prerequisite: completeInstance.inputs.artifact },
    ]) {
        assert.throws(() => validateBadges({ ...completeBadges,
            instances: [{ ...completeInstance, inputs: input }] }, phases),
        /Invalid generated badge/);
    }
    const evaluate = async () => evaluateBadges(completeBadges, { cwd,
        workflows: ["specs/alpha"], phases,
        outputPath: async ({ output }, workflow) => output.replace("specs/<slug>", workflow),
        runFor: () => null });
    await utimes(plan, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    await utimes(tasks, new Date(1_600_000_000_001), new Date(1_600_000_000_001));
    assert.equal((await evaluate()).summary[0].count, 1);
    await utimes(plan, new Date(1_600_000_000_002), new Date(1_600_000_000_002));
    assert.equal((await evaluate()).summary[0].count, 0);
    await rm(plan);
    assert.equal((await evaluate()).summary[0].count, 0);
    await writeFile(plan, "# Plan");
    await writeFile(tasks, "- [x] first\n- [ ] second");
    assert.equal((await evaluate()).summary[0].count, 0);
});

test("directory-scoped output counts regular Markdown files across workflows and seeds zero", async (t) => {
    const cwd = await mkdtemp(join(process.cwd(), ".generated-badge-folders-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const first = join(cwd, "work", "alpha", "review");
    const second = join(cwd, "work", "beta", "review");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(join(first, "a.md"), "a");
    await writeFile(join(first, "B.MD"), "b");
    await writeFile(join(first, "notes.txt"), "not counted");
    await mkdir(join(first, "nested.md"));
    await writeFile(join(second, "c.md"), "c");
    const phases = [{ id: "review", outputs: ["work/<slug>/review/<name>.md"] }];
    validateBadges(fileBadges, phases);
    assert.throws(() => validateBadges({ ...fileBadges, rules: [{
        ...fileRule, inputs: [{ id: "artifact", type: "phase", scope: "directory" }],
    }] }, phases), /Invalid generated badge rule/);
    const evaluate = (workflows) => evaluateBadges(fileBadges, { cwd, workflows, phases,
        outputPath: async (_, workflow, { directory }) => {
            assert.equal(directory, true);
            return `${workflow}/review`;
        }, runFor: () => null });
    assert.deepEqual((await evaluate([])).summary, [{ id: "files", color: "blue",
        count: 0, text: "Markdown files (0)" }]);
    const result = await evaluate(["work/alpha", "work/beta", "work/gamma"]);
    assert.deepEqual(result.summary, [{ id: "files", color: "blue",
        count: 2, text: "Markdown files (2)" }]);
    assert.equal(result.items["work/alpha"][0].text, "Files (2)");
    assert.equal(result.items["work/beta"][0].text, "Files (1)");
    assert.deepEqual(result.items["work/gamma"], []);
    const scoped = { ...fileBadges, instances: [{ ...fileInstance,
        text: "{count} checklists", phaseText: "Phase: {count} checklists",
        summaryText: "Workflows with checklists ({workflows})",
        targets: [{ phase: "review", output: null }] }] };
    validateBadges(scoped, phases);
    const scopedResult = await evaluateBadges(scoped, { cwd,
        workflows: ["work/alpha", "work/beta", "work/gamma"], phases,
        outputPath: async (_, workflow) => `${workflow}/review`,
        runFor: () => null });
    assert.deepEqual(scopedResult.summary, [{ id: "files", color: "blue",
        count: 2, text: "Workflows with checklists (2)" }]);
    assert.equal(scopedResult.items["work/alpha"][0].text, "2 checklists");
    assert.equal(scopedResult.items["work/alpha"][0].phaseText, "Phase: 2 checklists");
    assert.equal(scopedResult.items["work/beta"][0].phaseText, "Phase: 1 checklists");
    assert.deepEqual(scopedResult.items["work/gamma"], []);
    try {
        await symlink(join(second, "c.md"), join(first, "linked.md"), "file");
    } catch (error) {
        if (error.code !== "EPERM") throw error;
    }
    assert.equal((await evaluate(["work/alpha"])).summary[0].count, 1);
});

test("directory badge reads a template output folder before any named file exists", async (t) => {
    const cwd = await mkdtemp(join(process.cwd(), ".generated-badge-template-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, "work", "alpha", "review"), { recursive: true });
    const config = { canvas: { id: "directory-badge" }, phases: ["review"],
        phaseOutputs: { review: { expectsArtifact: true,
            outputPath: "work/<slug>/review/<name>.md" } },
        userProvidesSlug: false, badges: fileBadges };
    const runtime = await createRuntime({ config, cwd, workspace: cwd,
        session: { sessionId: "directory-badge", log: async () => {} } });
    try {
        const snapshot = await runtime.snapshot();
        assert.deepEqual(snapshot.badges.summary, [{ id: "files", color: "blue",
            count: 0, text: "Markdown files (0)" }]);
        assert.deepEqual(snapshot.badges.items["work/alpha"], []);
        assert.deepEqual(snapshot.badges.diagnostics, []);
        await writeFile(join(cwd, "work", "alpha", "review", "first.md"), "first");
        const updated = await runtime.snapshot();
        assert.equal(updated.badges.items["work/alpha"][0].text, "Files (1)");
        assert.equal(updated.badges.summary[0].count, 1);
    } finally { runtime.close(); }
});

test("directory count errors surface diagnostics rather than claiming zero", async (t) => {
    const cwd = await mkdtemp(join(process.cwd(), ".generated-badge-directory-errors-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, "work", "alpha"), { recursive: true });
    await writeFile(join(cwd, "work", "alpha", "review"), "not a directory");
    const result = await evaluateBadges(fileBadges, { cwd, workflows: ["work/alpha"],
        phases: [{ id: "review", outputs: ["work/<slug>/review/<name>.md"] }],
        outputPath: async () => "work/alpha/review", runFor: () => null });
    assert.deepEqual(result.items["work/alpha"], []);
    assert.match(result.diagnostics.join(" "), /could not be counted safely/);
});

test("Markdown directory count refuses unbounded enumeration", async (t) => {
    const cwd = await mkdtemp(join(process.cwd(), ".generated-badge-directory-limit-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, "any-folder"));
    await Promise.all(Array.from({ length: 1001 }, (_, index) =>
        writeFile(join(cwd, "any-folder", `file-${index}.md`), "")));
    await assert.rejects(countMarkdownDirectory(cwd, "any-folder"), /1000-entry badge limit/);
});

test("generated badge runtime preserves distinct phase/output targets", async (t) => {
    const cwd = await mkdtemp(join(process.cwd(), ".generated-badge-targets-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, "specs", "alpha"), { recursive: true });
    await writeFile(join(cwd, "specs", "alpha", "tasks.md"), "- [x] done\n");
    const targeted = { ...instance, showIn: [], phase: null,
        targets: [{ phase: "specify", output: "specs/<slug>/spec.md" },
            { phase: "plan", output: "specs/<slug>/plan.md" },
            { phase: "plan", output: null }] };
    const phases = [{ id: "tasks", outputs: ["specs/<slug>/tasks.md"] },
        { id: "specify", outputs: ["specs/<slug>/spec.md"] },
        { id: "plan", outputs: ["specs/<slug>/plan.md"] }];
    validateBadges({ ...badges, instances: [targeted] }, phases);
    assert.throws(() => validateBadges({ ...badges, instances: [{
        ...targeted, targets: [{ phase: "plan", output: "specs/<slug>/spec.md" }],
    }] }, phases), /Invalid generated badge instance/);
    const result = await evaluateBadges({ ...badges, instances: [targeted] }, {
        cwd, workflows: ["specs/alpha"], phases,
        outputPath: async (_, workflow) => `${workflow}/tasks.md`, runFor: () => null });
    assert.deepEqual(result.items["specs/alpha"][0].targets, targeted.targets);
});

test("generated runtime snapshots include badges for each workflow and the selected one", async (t) => {
    const cwd = await mkdtemp(join(process.cwd(), ".generated-badge-snapshot-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, "specs", "alpha"), { recursive: true });
    await mkdir(join(cwd, "specs", "beta"), { recursive: true });
    await writeFile(join(cwd, "specs", "alpha", "tasks.md"), "- [x] done\n");
    const config = { canvas: { id: "badge-snapshot" }, phases: ["tasks"],
        phaseOutputs: { tasks: { expectsArtifact: true, outputPath: "specs/<slug>/tasks.md" } },
        userProvidesSlug: false, badges };
    const runtime = await createRuntime({ config, cwd, workspace: cwd,
        session: { sessionId: "badge-snapshot", log: async () => {} } });
    try {
        let snapshot = await runtime.snapshot();
        assert.equal(snapshot.badges.items["specs/alpha"][0].text, "1/1 complete");
        assert.deepEqual(snapshot.badges.items["specs/beta"], []);
        assert.deepEqual(snapshot.badges.selected, []);
        await runtime.save({ revision: snapshot.revision, selected: "specs/alpha" });
        snapshot = await runtime.snapshot();
        assert.deepEqual(snapshot.badges.selected, snapshot.badges.items["specs/alpha"]);
    } finally { runtime.close(); }
});

test("artifact staleness uses metadata and does not require rule-specific host logic", async (t) => {
    const cwd = await mkdtemp(join(process.cwd(), ".generated-badge-stale-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, "specs", "alpha"), { recursive: true });
    await writeFile(join(cwd, "specs", "alpha", "tasks.md"), "Work");
    const module = "badge-rule-artifact-state-adapter";
    const hash = createHash("sha256").update(await readFile(new URL(
        "../extension-canvas-design/generated-host/badges/adapters/artifact-state.mjs",
        import.meta.url))).digest("hex");
    const config = { instances: [{ ...instance, id: "stale", type: "stale",
        text: "Stale", color: "amber" }],
    types: [{ ...type, id: "stale", rule: "artifact-stale" }],
    rules: [{ ...rule, id: "artifact-stale", module, hash, textPlaceholders: [] }] };
    await verifyBadgeModules(config);
    const phases = [{ id: "tasks", outputs: ["specs/<slug>/tasks.md"] }];
    const evaluate = (completedAt) => evaluateBadges(config, { cwd, workflows: ["specs/alpha"],
        phases, outputPath: async () => "specs/alpha/tasks.md",
        runFor: () => ({ status: "Completed", completedAt }) });
    assert.equal((await evaluate(new Date(Date.now() + 30_000).toISOString()))
        .items["specs/alpha"][0].text, "Stale");
    assert.deepEqual((await evaluate(new Date(0).toISOString())).items["specs/alpha"], []);
    const currentRun = await evaluateBadges(config, { cwd, workflows: ["specs/alpha"],
        phases, outputPath: async () => "specs/alpha/tasks.md",
        runFor: () => ({ status: "Completed",
            startedAt: new Date(0).toISOString(),
            completedAt: new Date(Date.now() + 30_000).toISOString() }) });
    assert.deepEqual(currentRun.items["specs/alpha"], []);
});

test("badge config rejects undeclared outputs and normalizes completed run statuses", async (t) => {
    const cwd = await mkdtemp(join(process.cwd(), ".generated-badge-run-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const module = "badge-rule-run-adapter";
    const hash = createHash("sha256").update(await readFile(new URL(
        "../extension-canvas-design/generated-host/badges/adapters/run.mjs",
        import.meta.url))).digest("hex");
    const config = { instances: [{ id: "done", type: "done", inputs: { phase: "tasks" },
        text: "Done", color: "green", showIn: ["workflow-summary", "phase-card"], phase: "tasks" }],
    types: [{ ...type, id: "done", rule: "phase-run-complete" }],
    rules: [{ ...rule, id: "phase-run-complete", inputs: [{ id: "phase", type: "phase" }],
        textPlaceholders: [], module, hash }] };
    const phases = [{ id: "tasks", outputs: ["specs/<slug>/tasks.md"] }];
    validateBadges(config, phases);
    assert.throws(() => validateBadges(badges, [{ id: "tasks", outputs: [] }]),
        /Invalid generated badge input/);
    await verifyBadgeModules(config);
    for (const status of ["Completed", "complete", "success"]) {
        const result = await evaluateBadges(config, { cwd, workflows: ["specs/alpha"], phases,
            outputPath: async () => null, runFor: () => ({ status }) });
        assert.equal(result.items["specs/alpha"][0].text, "Done", status);
        assert.deepEqual(result.summary, [{ id: "done", color: "green", count: 1,
            text: "Progress (1)" }]);
    }
    const missing = await evaluateBadges(config, { cwd, workflows: ["specs/alpha"], phases,
        outputPath: async () => null, runFor: () => null });
    assert.deepEqual(missing.items["specs/alpha"], []);
    assert.equal(missing.summary[0].count, 0);
});

test("Value match searches a single declared output and counts one match per workflow", async (t) => {
    const cwd = await mkdtemp(join(process.cwd(), ".generated-badge-shared-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, "specs", "alpha"), { recursive: true });
    await writeFile(join(cwd, "specs", "alpha", "spec.md"), "Verdict: needs-clarification");
    const output = "specs/<slug>/spec.md";
    const config = { instances: [{ id: "verdict", type: "value-match",
        inputs: { artifact: { phase: "specify", output },
            value: "VERDICT: NEEDS-CLARIFICATION" }, text: "Review needed",
        color: "amber", showIn: ["workflow-list", "workflow-summary"], phase: null }],
    types: [{ ...type, id: "value-match", rule: "value-match" }],
    rules: [{ ...rule, id: "value-match",
        inputs: [{ id: "artifact", type: "artifact" },
            { id: "value", type: "text" }], textPlaceholders: [] }] };
    const phases = [{ id: "specify", outputs: [output] }];
    validateBadges(config, phases);
    assert.throws(() => validateBadges({ ...config, instances: [{
        ...config.instances[0], inputs: { ...config.instances[0].inputs, value: " " },
    }] }, phases), /Invalid generated badge input/);
    assert.throws(() => validateBadges({ ...config, instances: [{
        ...config.instances[0], inputs: { ...config.instances[0].inputs, value: "x".repeat(257) },
    }] }, phases), /Invalid generated badge input/);
    const result = await evaluateBadges(config, { cwd, phases, workflows: ["specs/alpha"],
        outputPath: async () => "specs/alpha/spec.md", runFor: () => null });
    assert.equal(result.items["specs/alpha"][0].text, "Review needed");
    assert.equal(result.summary[0].count, 1);
});

test("missing artifacts do not match; oversized reads emit unknown diagnostics", async (t) => {
    const cwd = await mkdtemp(join(process.cwd(), ".generated-badge-errors-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, "specs", "alpha"), { recursive: true });
    const diagnostics = [];
    const evaluate = () => evaluateBadges(badges, { cwd, workflows: ["specs/alpha"],
        phases: [{ id: "tasks", outputs: ["specs/<slug>/tasks.md"] }],
        outputPath: async () => "specs/alpha/tasks.md", runFor: () => null,
        log: (message) => diagnostics.push(message) });
    assert.deepEqual((await evaluate()).items["specs/alpha"], []);
    assert.deepEqual(diagnostics, []);
    await writeFile(join(cwd, "specs", "alpha", "tasks.md"), "- [x] ".repeat(30_000));
    assert.deepEqual((await evaluate()).items["specs/alpha"], []);
    assert.ok(diagnostics.some((message) => message.includes("could not be read")));
    assert.ok(diagnostics.some((message) => message.includes("could not be read safely")));
});

test("workflow artifact evidence is read once across badge instances", async (t) => {
    const cwd = await mkdtemp(join(process.cwd(), ".generated-badge-cache-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, "specs", "alpha"), { recursive: true });
    await writeFile(join(cwd, "specs", "alpha", "tasks.md"), "- [x] done");
    let resolved = 0;
    const config = { ...badges, instances: [instance, { ...instance, id: "other" }] };
    const result = await evaluateBadges(config, { cwd, workflows: ["specs/alpha"],
        phases: [{ id: "tasks", outputs: ["specs/<slug>/tasks.md"] }],
        outputPath: async () => { resolved++; return "specs/alpha/tasks.md"; },
        runFor: () => null });
    assert.equal(resolved, 1);
    assert.deepEqual(result.items["specs/alpha"].map(({ id }) => id), ["work", "other"]);
});

test("exhausted badge evaluation budget is reported instead of silently skipping", async () => {
    const diagnostics = [];
    const result = await evaluateBadges(badges, { cwd: process.cwd(),
        workflows: ["specs/alpha", "specs/beta"],
        phases: [{ id: "tasks", outputs: ["specs/<slug>/tasks.md"] }],
        outputPath: async () => { throw new Error("Must not read after deadline"); },
        runFor: () => null, budgetMs: 0, log: (message) => diagnostics.push(message) });
    assert.deepEqual(result.items, { "specs/alpha": [], "specs/beta": [] });
    assert.match(result.diagnostics[0], /some badges were not evaluated/);
    assert.deepEqual(diagnostics, result.diagnostics);
});

test("badge validator permits 100 unique types and rules", () => {
    const config = { instances: [], types: [], rules: [] };
    for (let index = 0; index < 100; index++) {
        const id = `rule-${index}`;
        config.rules.push({ ...rule, id });
        config.types.push({ ...type, id: `type-${index}`, rule: id });
    }
    assert.doesNotThrow(() => validateBadges(config, ["tasks"]));
    assert.throws(() => validateBadges({ ...config, types: [...config.types, type] },
        ["tasks"]), /Invalid generated badge configuration/);
});
