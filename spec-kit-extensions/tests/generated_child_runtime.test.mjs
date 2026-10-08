import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

async function fixture(t, withBadges = false) {
    const root = resolve(`spec-kit-extensions/tests/.generated-child-${randomUUID()}`);
    t.after(() => rm(root, { recursive: true, force: true }));
    const parent = join(root, "parent");
    const scaffold = join(root, "scaffold");
    await mkdir(parent, { recursive: true });
    await mkdir(join(parent, ".specify"), { recursive: true });
    await cp(new URL("../extension-canvas-design/generated-scaffold/", import.meta.url),
        scaffold, { recursive: true });
    const adapter = Buffer.from("export default {};");
    await mkdir(join(scaffold, "pages"), { recursive: true });
    await writeFile(join(scaffold, "pages", "phase-adapter.mjs"), adapter);
    for (const skill of ["constitution", "specify", "plan"]) {
        const folder = join(parent, ".github", "skills", `speckit-${skill}`);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "SKILL.md"), `---\nname: speckit-${skill}\n---\n`);
    }
    const children = new Map(), messages = [], projectId = "project-1";
    const parentId = randomUUID();
    const session = { sessionId: parentId, log: async () => {},
        rpc: { skills: { reload: async () => ({ errors: [] }) },
            tools: { execute: async ({ name, arguments: args }) => {
                if (name === "get_session") {
                    const child = children.get(args.project_session_id);
                    return { resultType: "success", textResultForLlm: JSON.stringify(child
                        ? { id: args.project_session_id, project_id: projectId,
                            session_type: "worktree", path: child.path, name: child.name,
                            ...(child.omitStatus ? {} : { activity_status: child.busy ? "busy" : "idle" }) }
                        : { id: parentId, project_id: projectId, path: parent, branch: "main" }) };
                }
                if (name === "get_sessions_status") {
                    return { resultType: "success", textResultForLlm: JSON.stringify({
                        sessions: [...children].map(([id, child]) => ({
                            id, activity_status: child.busy ? "busy" : "idle",
                        })),
                    }) };
                }
                if (name === "create_session") {
                    const id = randomUUID();
                    const path = join(root, `child-${children.size + 1}`);
                    await mkdir(path, { recursive: true });
                    children.set(id, { path, name: args.name });
                    return { resultType: "success",
                        textResultForLlm: `Created session '${args.name}' (id: ${id}) in project 'Test'` };
                }
                if (name === "send_session_message") {
                    messages.push(args);
                    return { resultType: "success", textResultForLlm: "Message sent" };
                }
                throw new Error(`Unexpected tool ${name}`);
            } } } };
    const config = { canvas: { id: "test-child" }, phases: ["constitution", "specify", "plan"],
        phaseOutputs: { constitution: { expectsArtifact: true },
            specify: { expectsArtifact: true, outputPath: "specs/<slug>/spec.md" },
            plan: { expectsArtifact: true, outputPath: "specs/<slug>/plan.md" } },
        workflowPage: { adapter: "phase-adapter", managedRun: true,
            hash: createHash("sha256").update(adapter).digest("hex") } };
    if (withBadges) {
        const source = new URL("../extension-canvas-design/generated-host/badges/adapters/content.mjs",
            import.meta.url);
        const bytes = await readFile(source);
        await mkdir(join(scaffold, "badges"), { recursive: true });
        await writeFile(join(scaffold, "badges", "badge-rule-content-adapter.mjs"), bytes);
        config.badges = {
            rules: [{ id: "checklist-progress", module: "badge-rule-content-adapter",
                hash: createHash("sha256").update(bytes).digest("hex"),
                label: "Progress", description: "Progress",
                inputs: [{ id: "artifact", type: "artifact" }],
                textPlaceholders: ["completed", "total"] }],
            types: [{ id: "progress", title: "Progress", description: "Progress",
                rule: "checklist-progress", defaultText: "{completed}/{total}",
                defaultColor: "blue", enabled: true }],
            instances: [{ id: "progress", type: "progress",
                inputs: { artifact: { phase: "specify", output: "specs/<slug>/spec.md" } },
                text: "{completed}/{total}", showIn: ["workflow-list", "workflow-summary"] }],
        };
    }
    const { createRuntime } = await import(pathToFileURL(join(scaffold, "runtime.mjs")).href);
    let runtime = await createRuntime({ config, cwd: parent, workspace: root, session });
    t.after(() => runtime.close());
    const statePath = join(root, "generated-canvases",
        createHash("sha256").update(JSON.stringify([parent, config.canvas.id])).digest("hex"), "state.json");
    const saved = async () => JSON.parse(await readFile(statePath, "utf8"));
    const report = async (run, status, extra = {}) =>
        runtime.reportChild({ runId: run.runId, token: run.token, status, ...extra });
    return { root, parent, children, messages, saved, report, session, statePath,
        get runtime() { return runtime; },
        restart: async () => {
            runtime.close();
            runtime = await createRuntime({ config, cwd: parent, workspace: root, session });
        } };
}

test("manual child retains checkout across phases; reads its artifact without merging", async (t) => {
    const f = await fixture(t);
    const constitution = await f.runtime.run({ phase: "constitution", args: "Principles" }, "panel");
    const projectRun = (await f.saved()).runs.find((run) => run.runId === constitution.runId);
    await mkdir(join(projectRun.childPath, ".specify", "memory"), { recursive: true });
    await writeFile(join(projectRun.childPath, ".specify", "memory", "constitution.md"), "Principles");
    await f.report(projectRun, "start");
    await f.report(projectRun, "complete", { artifacts: [".specify/memory/constitution.md"] });
    assert.equal(await readFile(join(f.parent, ".specify", "memory", "constitution.md"), "utf8"), "Principles");
    assert.deepEqual(await readdir(join(f.parent, ".specify", "memory")), ["constitution.md"]);
    const { id } = await f.runtime.createPending({ revision: (await f.runtime.snapshot()).revision });
    const specify = await f.runtime.run({ phase: "specify", itemId: id, args: "Feature", slug: "demo" }, "panel");
    const specRun = (await f.saved()).runs.find((run) => run.runId === specify.runId);
    await mkdir(join(specRun.childPath, "specs", "demo"), { recursive: true });
    await writeFile(join(specRun.childPath, "specs", "demo", "spec.md"), "Feature specification");
    await f.report(specRun, "start");
    await f.restart();
    await f.report(specRun, "complete", { slug: "demo", artifacts: ["specs/demo/spec.md"] });
    assert.equal((await f.runtime.artifact({ phase: "specify", itemId: "specs/demo" })).content,
        "Feature specification");
    await assert.rejects(readFile(join(f.parent, "specs", "demo", "spec.md")), { code: "ENOENT" });
    const plan = await f.runtime.run({ phase: "plan", itemId: "specs/demo", args: "Plan it" }, "panel");
    const planRun = (await f.saved()).runs.find((run) => run.runId === plan.runId);
    assert.equal(planRun.childId, specRun.childId);
    assert.equal(planRun.childPath, specRun.childPath);
    assert.equal(f.messages.filter((message) => message.message.includes("Run this Canvas Design workflow")).length, 3);
    await writeFile(join(planRun.childPath, "specs", "demo", "plan.md"), "Plan");
    await f.report(planRun, "start");
    await f.report(planRun, "complete", { artifacts: ["specs/demo/plan.md"] });
    const updated = await f.runtime.run({ phase: "constitution", args: "New principles" }, "panel");
    assert.notEqual((await f.saved()).runs.find((run) => run.runId === updated.runId).childId,
        projectRun.childId);
});

test("Autopilot preallocates ordered child reports and keeps concurrent workflows isolated", async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.parent, ".specify", "memory"), { recursive: true });
    await writeFile(join(f.parent, ".specify", "memory", "constitution.md"), "Canonical");
    const first = await f.runtime.createPending({ revision: (await f.runtime.snapshot()).revision });
    const a = await f.runtime.startAutopilot({ itemId: first.id }, "panel");
    const second = await f.runtime.createPending({ revision: (await f.runtime.snapshot()).revision });
    const b = await f.runtime.startAutopilot({ itemId: second.id }, "panel");
    const runs = (await f.saved()).runs;
    const firstRuns = runs.filter((run) => run.autopilotId === a.autopilotId);
    const secondRuns = runs.filter((run) => run.autopilotId === b.autopilotId);
    assert.equal(firstRuns.length, 2);
    assert.equal(secondRuns.length, 2);
    assert.notEqual(firstRuns[0].childId, secondRuns[0].childId);
    await f.runtime.save({ revision: (await f.runtime.snapshot()).revision, selected: "__new__" });
    assert.equal((await f.runtime.snapshot()).autopilot, null);
    await f.runtime.save({ revision: (await f.runtime.snapshot()).revision, selected: second.id });
    assert.equal(await readFile(join(firstRuns[0].childPath,
        ".specify", "memory", "constitution.md"), "utf8"), "Canonical");
    await assert.rejects(f.runtime.reportChild({ runId: firstRuns[0].runId,
        token: secondRuns[0].token, status: "start" }), /Unknown child run report/);
    await assert.rejects(f.runtime.run({ phase: "constitution", args: "Changed" }, "panel"),
        /Wait for active workflows/);
    await assert.rejects(f.report(firstRuns[1], "start"), /configured order/);
    await f.report(firstRuns[0], "start");
    await mkdir(join(firstRuns[0].childPath, "specs", "workflow-1"), { recursive: true });
    await writeFile(join(firstRuns[0].childPath, "specs", "workflow-1", "spec.md"), "Spec");
    await assert.rejects(f.report(firstRuns[0], "complete",
        { slug: "workflow-1", artifacts: ["specs/workflow-1/plan.md"] }), /ENOENT|Required|artifact/i);
    await f.report(firstRuns[0], "complete",
        { slug: "workflow-1", artifacts: ["specs/workflow-1/spec.md"] });
    await f.report(firstRuns[1], "start");
    assert.equal((await f.saved()).autopilots.find((entry) => entry.id === a.autopilotId).item,
        "specs/workflow-1");
    await writeFile(join(firstRuns[1].childPath, "specs", "workflow-1", "plan.md"), "Plan");
    await f.restart();
    await f.report(firstRuns[1], "complete", { artifacts: ["specs/workflow-1/plan.md"] });
    assert.equal((await f.saved()).autopilots.find((entry) => entry.id === a.autopilotId).status,
        "Completed");
    assert.equal((await f.saved()).autopilots.find((entry) => entry.id === b.autopilotId).status,
        "Request sent");
    await assert.rejects(readFile(join(f.parent, "specs", "workflow-1", "plan.md")),
        { code: "ENOENT" });
    await assert.rejects(f.runtime.stopAutopilot({}), /child session Copilot chat/);
});

test("legacy parent-session saved runs and artifacts remain readable", async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.parent, "specs", "legacy"), { recursive: true });
    await writeFile(join(f.parent, "specs", "legacy", "spec.md"), "Saved parent artifact");
    await f.runtime.createPending({ revision: (await f.runtime.snapshot()).revision });
    const previous = await f.saved();
    previous.runs.push({ runId: randomUUID(), item: "specs/legacy", phase: "specify",
        instanceId: "panel", sessionId: f.session.sessionId, args: "Prior request",
        before: [], messageId: "old-message", status: "Completed",
        artifact: "specs/legacy/spec.md", artifacts: ["specs/legacy/spec.md"] });
    const file = join(f.root, "generated-canvases",
        createHash("sha256").update(JSON.stringify([f.parent, "test-child"])).digest("hex"), "state.json");
    await writeFile(file, JSON.stringify(previous));
    await f.restart();
    assert.equal((await f.runtime.snapshot()).statuses.specify.status, "Not run");
    assert.equal((await f.runtime.artifact({ phase: "specify", itemId: "specs/legacy" })).content,
        "Saved parent artifact");
});

test("incompatible child identity or artifact reports never complete a run", async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.parent, ".specify", "memory"), { recursive: true });
    await writeFile(join(f.parent, ".specify", "memory", "constitution.md"), "Canonical");
    const { id } = await f.runtime.createPending({ revision: (await f.runtime.snapshot()).revision });
    const { runId } = await f.runtime.run({ phase: "specify", itemId: id,
        slug: "safe", args: "Feature" }, "panel");
    const run = (await f.saved()).runs.find((entry) => entry.runId === runId);
    await assert.rejects(f.runtime.reportChild({ runId, token: run.token,
        status: "start" }, "wrong-panel"), /Unknown child run report/);
    const owned = f.children.get(run.childId);
    owned.path = f.parent;
    await assert.rejects(f.report(run, "start"), /overlaps parent worktree/);
    assert.equal((await f.saved()).runs.find((entry) => entry.runId === runId).status, "Request sent");
    owned.path = run.childPath;
    await f.report(run, "start");
    await mkdir(join(run.childPath, "specs", "safe"), { recursive: true });
    await writeFile(join(run.childPath, "specs", "safe", "spec.md"), "Specification");
    await assert.rejects(f.report(run, "complete",
        { slug: "safe", artifacts: ["specs/safe/../safe/spec.md"] }), /supported artifact locations/);
    assert.equal((await f.saved()).runs.find((entry) => entry.runId === runId).status, "Running");
});

test("constitution publication refuses a changed parent and leaves no partial publication", async (t) => {
    const f = await fixture(t);
    const memory = join(f.parent, ".specify", "memory");
    await mkdir(memory, { recursive: true });
    const canonical = join(memory, "constitution.md");
    await writeFile(canonical, "Original");
    const { runId } = await f.runtime.run({ phase: "constitution", args: "Updated" }, "panel");
    const run = (await f.saved()).runs.find((entry) => entry.runId === runId);
    await writeFile(join(run.childPath, ".specify", "memory", "constitution.md"), "Child update");
    await f.report(run, "start");
    await writeFile(canonical, "External parent update");
    await assert.rejects(f.report(run, "complete",
        { artifacts: [".specify/memory/constitution.md"] }),
    (error) => error.status === 409 && /changed since this run began/.test(error.message));
    assert.equal(await readFile(canonical, "utf8"), "External parent update");
    assert.deepEqual((await readdir(memory)).sort(), ["constitution.md"]);
    assert.equal((await f.saved()).runs.find((entry) => entry.runId === runId).status, "Running");
});

test("constitution created externally after an absent launch baseline is not overwritten", async (t) => {
    const f = await fixture(t);
    const { runId } = await f.runtime.run({ phase: "constitution", args: "New" }, "panel");
    const run = (await f.saved()).runs.find((entry) => entry.runId === runId);
    assert.equal(run.constitutionBaseline, null);
    const memory = join(run.childPath, ".specify", "memory");
    await mkdir(memory, { recursive: true });
    await writeFile(join(memory, "constitution.md"), "Child draft");
    await f.report(run, "start");
    await mkdir(join(f.parent, ".specify", "memory"), { recursive: true });
    const target = join(f.parent, ".specify", "memory", "constitution.md");
    await writeFile(target, "External draft");
    await assert.rejects(f.report(run, "complete",
        { artifacts: [".specify/memory/constitution.md"] }),
    (error) => error.status === 409 && /changed since this run began/.test(error.message));
    assert.equal(await readFile(target, "utf8"), "External draft");
});

test("pinned setup rejects drift; unchanged child constitution syncs only between runs", async (t) => {
    const f = await fixture(t);
    const memory = join(f.parent, ".specify", "memory");
    await mkdir(memory, { recursive: true });
    const canonical = join(memory, "constitution.md");
    await writeFile(canonical, "Original");
    const { id } = await f.runtime.createPending({ revision: (await f.runtime.snapshot()).revision });
    const { runId } = await f.runtime.run({ phase: "specify", itemId: id,
        args: "Feature", slug: "demo" }, "panel");
    const first = (await f.saved()).runs.find((entry) => entry.runId === runId);
    await mkdir(join(first.childPath, "specs", "demo"), { recursive: true });
    await writeFile(join(first.childPath, "specs", "demo", "spec.md"), "Feature");
    await f.report(first, "start");
    await f.report(first, "complete", { slug: "demo", artifacts: ["specs/demo/spec.md"] });
    await writeFile(canonical, "Updated canonical");
    const next = await f.runtime.run({ phase: "plan", itemId: "specs/demo",
        args: "Plan" }, "panel");
    assert.equal(await readFile(join(first.childPath, ".specify", "memory", "constitution.md"),
        "utf8"), "Updated canonical");
    const plan = (await f.saved()).runs.find((entry) => entry.runId === next.runId);
    await f.report(plan, "fail", { error: "Stopped in child chat" });
    const skill = join(first.childPath, ".github", "skills", "speckit-plan", "SKILL.md");
    await writeFile(skill, "Different child skill");
    await assert.rejects(f.runtime.run({ phase: "plan", itemId: "specs/demo", args: "Retry" }, "panel"),
        (error) => error.status === 409 && /pinned setup/.test(error.message));
    assert.equal(await readFile(skill, "utf8"), "Different child skill");
    await writeFile(skill, "---\nname: speckit-plan\n---\n");
    const parentSkill = join(f.parent, ".github", "skills", "speckit-plan", "SKILL.md");
    await writeFile(parentSkill, "---\nname: speckit-plan\n---\nNew guidance");
    await assert.rejects(f.runtime.run({ phase: "plan", itemId: "specs/demo", args: "Retry" }, "panel"),
        (error) => error.status === 409 && /Parent setup changed/.test(error.message));
    await writeFile(parentSkill, "---\nname: speckit-plan\n---\n");
    await writeFile(join(first.childPath, ".specify", "memory", "constitution.md"), "Child edit");
    await assert.rejects(f.runtime.run({ phase: "plan", itemId: "specs/demo", args: "Retry" }, "panel"),
        (error) => error.status === 409 && /Child constitution was changed/.test(error.message));
    assert.equal(await readFile(canonical, "utf8"), "Updated canonical");
});

test("active workflow conflicts fail closed; aged idle child permits explicit retry", async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.parent, ".specify", "memory"), { recursive: true });
    await writeFile(join(f.parent, ".specify", "memory", "constitution.md"), "Canonical");
    const { id } = await f.runtime.createPending({ revision: (await f.runtime.snapshot()).revision });
    const { runId } = await f.runtime.run({ phase: "specify", itemId: id,
        slug: "demo", args: "Feature" }, "panel");
    const first = (await f.saved()).runs.find((entry) => entry.runId === runId);
    assert.equal(f.messages[0].mode, "interactive");
    await assert.rejects(f.runtime.run({ phase: "specify", itemId: id,
        slug: "demo", args: "Retry" }, "panel"), (error) => error.status === 409 && /active run/.test(error.message));
    const state = await f.saved();
    state.runs.find((entry) => entry.runId === runId).startedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await writeFile(f.statePath, JSON.stringify(state));
    await f.restart();
    f.children.get(first.childId).busy = true;
    await assert.rejects(f.runtime.run({ phase: "specify", itemId: id,
        slug: "demo", args: "Retry" }, "panel"), /active run/);
    f.children.get(first.childId).busy = false;
    f.children.get(first.childId).omitStatus = true;
    const retry = await f.runtime.run({ phase: "specify", itemId: id,
        slug: "demo", args: "Retry" }, "panel");
    assert.notEqual(retry.runId, runId);
    assert.equal((await f.saved()).runs.find((entry) => entry.runId === runId).status, "Failed");
    assert.equal((await f.saved()).runs.find((entry) => entry.runId === retry.runId).childId,
        first.childId);
});

test("unchanged or linked output cannot be reported as new phase work", async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.parent, ".specify", "memory"), { recursive: true });
    await writeFile(join(f.parent, ".specify", "memory", "constitution.md"), "Canonical");
    await mkdir(join(f.parent, "specs", "existing"), { recursive: true });
    await writeFile(join(f.parent, "specs", "existing", "spec.md"), "Old spec");
    const { runId } = await f.runtime.run({ phase: "specify", itemId: "specs/existing",
        args: "Revise" }, "panel");
    const run = (await f.saved()).runs.find((entry) => entry.runId === runId);
    await f.report(run, "start");
    await assert.rejects(f.report(run, "complete", { artifacts: ["specs/existing/spec.md"] }),
        (error) => error.status === 409 && /unchanged/.test(error.message));
    const artifact = join(run.childPath, "specs", "existing", "spec.md");
    await rm(artifact);
    try { await symlink(join(run.childPath, ".specify", "memory", "constitution.md"), artifact); }
    catch (error) { if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error; return; }
    await assert.rejects(f.report(run, "complete", { artifacts: ["specs/existing/spec.md"] }),
        /link|checkout/);
});

test("badges read child artifact evidence and never parent checkout for managed workflows", async (t) => {
    const f = await fixture(t, true);
    await mkdir(join(f.parent, ".specify", "memory"), { recursive: true });
    await writeFile(join(f.parent, ".specify", "memory", "constitution.md"), "Canonical");
    const { id } = await f.runtime.createPending({ revision: (await f.runtime.snapshot()).revision });
    const { runId } = await f.runtime.run({ phase: "specify", itemId: id,
        args: "Checklist", slug: "badge" }, "panel");
    const run = (await f.saved()).runs.find((entry) => entry.runId === runId);
    await mkdir(join(run.childPath, "specs", "badge"), { recursive: true });
    await writeFile(join(run.childPath, "specs", "badge", "spec.md"), "- [x] Done\n- [ ] Remaining");
    await f.report(run, "start");
    await f.report(run, "complete", { slug: "badge", artifacts: ["specs/badge/spec.md"] });
    const snapshot = await f.runtime.snapshot();
    assert.equal(snapshot.badges.selected[0].text, "1/2");
    assert.equal(snapshot.badges.summary[0].count, 1);
    await assert.rejects(readFile(join(f.parent, "specs", "badge", "spec.md")), { code: "ENOENT" });
});
