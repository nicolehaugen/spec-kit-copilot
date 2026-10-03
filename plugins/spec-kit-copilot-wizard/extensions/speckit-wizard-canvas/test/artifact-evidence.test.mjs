import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFile, link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { artifactPath, collectArtifactEvidence, effectiveSource, readEvidenceCache, writeEvidenceCache, validateCandidates,
    validatePrimaryIndex } from "../artifact-evidence.mjs";
import { handleArtifactTargets } from "../server/handlers-ops.mjs";
import { attachOutputEvidence, outputAvailability } from "../canvas-runtime/output-availability.mjs";

async function fixture(run) {
    const root = join(import.meta.dirname, `.evidence-fixture-${randomUUID()}`);
    const write = async (name, text) => {
        const path = join(root, ...name.split("/"));
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, text);
    };
    try {
        await mkdir(root, { recursive: true });
        await write(".github/skills/speckit-plan/SKILL.md",
            "---\nname: speckit-plan\n---\nWrite FEATURE_DIR/plan.md. See .specify/scripts/powershell/setup-plan.ps1");
        await write(".specify/scripts/powershell/setup-plan.ps1", "FEATURE_DIR is specs/current");
        await run({ root, write });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

function response() {
    return { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
}

test("rejects traversal, symlink-like and invalid primary output evidence", () => {
    for (const path of ["../secret.md", "C:\\secret.md", "/secret.md",
        "specs/<slug>/<slug>/a.md", ".github/skills/a.md", "docs/con.md"]) {
        assert.equal(artifactPath(path), null);
    }
    assert.throws(() => validateCandidates([{ kind: "file", path: "x.md",
        source: "inference", effect: "creates" }], { inference: true }));
    assert.throws(() => validateCandidates([{ kind: "file", path: "x.md",
        root: { name: "FEATURE_DIR", path: "../outside" },
        source: "inference", effect: "creates", evidence: "Writes x.md" }], { inference: true }));
    assert.throws(() => validatePrimaryIndex(0, [{ kind: "folder" }]));
});

test("fingerprints effective skill and script, not composition layers", async () => {
    await fixture(async ({ root, write }) => {
        const first = await effectiveSource(root, "plan");
        const snapshot = { pipeline: [{ id: "plan" }], commands: [],
            composition: { artifacts: [{ id: "commands/speckit.plan", stack: [{ layer: "preset" }] }] } };
        const before = await collectArtifactEvidence(root, snapshot);
        assert.equal(before.requests.find(({ commandId }) => commandId === "speckit.plan").fingerprint, first.fingerprint);
        snapshot.composition.artifacts[0].stack = [{ layer: "extension" }];
        assert.equal((await collectArtifactEvidence(root, snapshot)).requests
            .find(({ commandId }) => commandId === "speckit.plan").fingerprint, first.fingerprint);
        await write(".specify/scripts/powershell/setup-plan.ps1", "FEATURE_DIR is specs/new");
        assert.notEqual((await effectiveSource(root, "plan")).fingerprint, first.fingerprint);
    });
});

test("source reads reject a replaced handle and an oversized file swapped after path checks", async () => {
    await fixture(async ({ root }) => {
        const other = join(root, ".specify", "scripts", "powershell", "setup-plan.ps1");
        await assert.rejects(effectiveSource(root, "plan", (path, flags) =>
            open(path.endsWith("SKILL.md") ? other : path, flags)), /Invalid artifact evidence source/);
        await assert.rejects(effectiveSource(root, "plan", async (path, flags) => {
            if (path.endsWith("SKILL.md")) await writeFile(path, "x".repeat(512 * 1024 + 1));
            return open(path, flags);
        }), /Invalid artifact evidence source/);
    });
});

test("source reads stay bounded when the opened file grows after stat", async () => {
    await fixture(async ({ root }) => {
        await assert.rejects(effectiveSource(root, "plan", async (path, flags) => {
            const file = await open(path, flags);
            let expanded = false;
            return {
                stat: () => file.stat(),
                read: async (...args) => {
                    if (!expanded) {
                        expanded = true;
                        await appendFile(path, "x".repeat(512 * 1024 + 1));
                    }
                    return file.read(...args);
                },
                close: () => file.close(),
            };
        }), /Oversized artifact evidence source/);
    });
});

test("source reads reject a parent replaced by a link after path checks", async () => {
    await fixture(async ({ root }) => {
        const parent = join(root, ".github", "skills", "speckit-plan");
        const backup = `${parent}-original`;
        const outside = await mkdtemp(join(tmpdir(), "evidence-source-"));
        let swapped = false;
        try {
            await writeFile(join(outside, "SKILL.md"), "Unexpected outside content");
            await assert.rejects(effectiveSource(root, "plan", async (path, flags) => {
                if (path.endsWith("SKILL.md")) {
                    await rename(parent, backup);
                    await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
                    swapped = true;
                }
                return open(path, flags);
            }), /Invalid artifact evidence source/);
        } finally {
            if (swapped) await rm(parent);
            if (swapped) await rename(backup, parent);
            await rm(outside, { recursive: true, force: true });
        }
    });
});

test("cache reads reject a replaced handle and remain bounded if the file grows", async () => {
    await fixture(async ({ root, write }) => {
        await write(".speckit-wizard/artifact-targets.json", '{"version":1,"entries":{}}');
        const other = join(root, ".specify", "scripts", "powershell", "setup-plan.ps1");
        await assert.rejects(readEvidenceCache(root, (_path, flags) =>
            open(other, flags)), /Unsafe artifact cache/);
        await assert.rejects(readEvidenceCache(root, async (path, flags) => {
            const file = await open(path, flags);
            let expanded = false;
            return {
                stat: () => file.stat(),
                read: async (...args) => {
                    if (!expanded) {
                        expanded = true;
                        await appendFile(path, "x".repeat(512 * 1024 + 1));
                    }
                    return file.read(...args);
                },
                close: () => file.close(),
            };
        }), /Unsafe artifact cache/);
    });
});

test("cache reads reject a parent replaced by a link after validation", async () => {
    await fixture(async ({ root, write }) => {
        await write(".speckit-wizard/artifact-targets.json", '{"version":1,"entries":{}}');
        const parent = join(root, ".speckit-wizard");
        const backup = `${parent}-original`;
        const outside = await mkdtemp(join(tmpdir(), "evidence-cache-"));
        let swapped = false;
        try {
            await writeFile(join(outside, "artifact-targets.json"), '{"version":1,"entries":{}}');
            await assert.rejects(readEvidenceCache(root, async (path, flags) => {
                await rename(parent, backup);
                await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
                swapped = true;
                return open(path, flags);
            }), /Unsafe artifact cache/);
        } finally {
            if (swapped) await rm(parent);
            if (swapped) await rename(backup, parent);
            await rm(outside, { recursive: true, force: true });
        }
    });
});

test("cache writes replace a swapped destination link without changing its target", async () => {
    await fixture(async ({ root, write }) => {
        await write(".speckit-wizard/artifact-targets.json", '{"version":1,"entries":{}}');
        const outside = await mkdtemp(join(tmpdir(), "evidence-write-"));
        const external = join(outside, "unrelated.json");
        const payload = '{"version":1,"entries":{"commands/speckit.plan":{}}}\n';
        try {
            await writeFile(external, "leave untouched");
            await writeEvidenceCache(root, payload, async (temp, target) => {
                await rm(target);
                if (process.platform === "win32") await link(external, target);
                else await symlink(external, target, "file");
                await rename(temp, target);
            });
            assert.equal(await readFile(external, "utf8"), "leave untouched");
            assert.equal(await readFile(join(root, ".speckit-wizard", "artifact-targets.json"), "utf8"), payload);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });
});

test("cache writes refuse a linked cache directory and clean up failed temp files", async () => {
    await fixture(async ({ root, write }) => {
        await write(".speckit-wizard/artifact-targets.json", '{"version":1,"entries":{}}');
        const directory = join(root, ".speckit-wizard");
        await assert.rejects(writeEvidenceCache(root, "{}", async () => {
            throw new Error("rename failed");
        }), /rename failed/);
        assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);

        const backup = `${directory}-original`;
        const outside = await mkdtemp(join(tmpdir(), "evidence-linked-cache-"));
        let swapped = false;
        try {
            await rename(directory, backup);
            await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
            swapped = true;
            await assert.rejects(writeEvidenceCache(root, "{}"), /Unsafe artifact cache directory/);
            assert.deepEqual(await readdir(outside), []);
        } finally {
            if (swapped) await rm(directory);
            if (swapped) await rename(backup, directory);
            await rm(outside, { recursive: true, force: true });
        }
    });
});

test("endpoint rejects stale evidence and merges current candidates without erasing manual hints", async () => {
    await fixture(async ({ root, write }) => {
        await write(".speckit-wizard/artifact-targets.json", JSON.stringify({
            entries: { "commands/speckit.plan": {
                writesTo: "specs/<slug>/old.md", source: "manual", argsHint: "Keep this hint",
            } },
        }));
        const inst = { workspacePath: root, broadcast() {} };
        const deps = { getInstance: () => inst, broadcast() {} };
        const candidate = { kind: "file", path: "plan.md", relativeTo: "feature",
            source: "inference", effect: "creates", evidence: "The skill writes FEATURE_DIR/plan.md." };
        const entry = { outputEvidence: { fingerprint: "0".repeat(64),
            candidates: [candidate], primaryIndex: 0 } };
        const stale = response();
        await handleArtifactTargets(stale, { entries: { "commands/speckit.plan": entry } }, deps);
        assert.equal(stale.status, 409);
        entry.outputEvidence.fingerprint = (await effectiveSource(root, "plan")).fingerprint;
        const unsafe = response();
        entry.outputEvidence.candidates = [{ ...candidate, path: "../secrets.md" }];
        await handleArtifactTargets(unsafe, { entries: { "commands/speckit.plan": entry } }, deps);
        assert.equal(unsafe.status, 400);
        entry.outputEvidence.candidates = [candidate];
        const valid = response();
        await handleArtifactTargets(valid, { entries: { "commands/speckit.plan": entry } }, deps);
        assert.equal(valid.status, 200);
        const saved = JSON.parse(await readFile(join(root, ".speckit-wizard", "artifact-targets.json"), "utf8"))
            .entries["commands/speckit.plan"];
        assert.equal(saved.source, "manual");
        assert.equal(saved.argsHint, "Keep this hint");
        assert.equal(saved.outputEvidence.candidates[0].path, "plan.md");
        assert.equal(saved.outputEvidence.primaryIndex, 0);
    });
});

test("output availability resolves only existing safe files and folders", async () => {
    await fixture(async ({ root, write }) => {
        await write("specs/current/plan.md", "# plan");
        const candidate = { kind: "file", path: "plan.md", relativeTo: "feature" };
        assert.equal((await outputAvailability(root, candidate, "specs/current")).filePath,
            "specs/current/plan.md");
        assert.equal((await outputAvailability(root, candidate, null)).filePath, undefined);
        assert.deepEqual(await outputAvailability(root, { kind: "file", path: "missing.md" }, null),
            { browsePath: "", resolvedPath: "missing.md" });
        const named = await outputAvailability(root, { kind: "file", path: "next.md",
            root: { name: "FEATURE_DIR", path: "specs/<slug>" } }, null);
        assert.equal(named.resolvedPath, "specs/current/next.md");
        assert.equal(named.folderPath, "specs/current");
        assert.equal(named.filePath, undefined);
    });
});

test("snapshot projects multiple core outputs and installed extension no-file evidence", async () => {
    await fixture(async ({ root, write }) => {
        await write(".github/skills/speckit-assess-intake/SKILL.md",
            "---\nname: speckit-assess-intake\n---\nInspect the idea without writing files.");
        await write(".specify/extensions/assess/commands/speckit.assess.intake.md", "# Intake");
        await write("specs/current/plan.md", "# Plan");
        await write("specs/current/research.md", "# Research");
        const plan = await effectiveSource(root, "plan");
        const extension = await effectiveSource(root, "speckit.assess.intake");
        await write(".speckit-wizard/artifact-targets.json", JSON.stringify({
            entries: {
                "commands/speckit.plan": {
                    outputEvidence: { fingerprint: plan.fingerprint, primaryIndex: 0,
                        candidates: [
                            { kind: "file", path: "plan.md", relativeTo: "feature",
                                source: "inference", effect: "creates", evidence: "Writes FEATURE_DIR/plan.md" },
                            { kind: "file", path: "research.md", relativeTo: "feature",
                                source: "inference", effect: "creates", evidence: "Writes FEATURE_DIR/research.md" },
                        ] },
                },
                "commands/speckit.assess.intake": {
                    outputEvidence: { fingerprint: extension.fingerprint, primaryIndex: null,
                        candidates: [{ kind: "none", source: "inference", effect: "unknown",
                            evidence: "Skill explicitly forbids file writes" }] },
                },
            },
        }));
        const snap = { pipeline: [{ id: "plan" }], commands: [], composition: { artifacts: [] },
            phases: { plan: { status: "empty" },
                "commands/speckit.assess.intake": { status: "empty" } },
            specsDir: "specs/current", warnings: [] };
        const outputs = await collectArtifactEvidence(root, snap);
        assert.deepEqual(outputs.requests.filter(({ commandId }) =>
            ["speckit.plan", "speckit.assess.intake"].includes(commandId)), []);
        const inst = { workspacePath: root };
        await attachOutputEvidence(inst, { reportedPhasePaths: {} }, snap, outputs);
        assert.equal(snap.phases.plan.artifactPath, "specs/current/plan.md");
        assert.equal(snap.outputAvailability.plan.candidates
            .filter(({ filePath }) => filePath).length, 2);
        assert.equal(snap.phases["commands/speckit.assess.intake"].artifactPath, null);
        assert.equal(snap.artifactEvidence["speckit.assess.intake"].primaryIndex, null);
    });
});
