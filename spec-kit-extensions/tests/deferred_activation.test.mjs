import assert from "node:assert/strict";
import { appendFile, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { publicationFixture, installPublicationScripts } from "./publication_fixture.mjs";
import { publishGenerated, publicationStatus, resolvePublication,
    generatedOutputStatus } from "../extension-canvas-design/scripts/publish-generated.mjs";
import { FILE_LIMIT, RECEIPT_LIMIT, TREE_LIMIT, readGeneratedFile, readReceipt,
    renameDirectoryWithoutReplacement, snapshotGeneratedTree, treeDigest, validateReceipt } from "../extension-canvas-design/scripts/generated-files.mjs";
import { checkGenerationProtocol, generatedOutput } from
    "../../plugins/spec-kit-copilot-wizard/extensions/speckit-canvas-designer/contracts/generated-output.mjs";

const publish = (f, request = f.first, ...flags) =>
    publishGenerated(f.project, f.workspace, f.handoff.handoffId, request.requestId, ...flags);

test("Generate leaves discovery absent; Open copies exact bytes and repeated Open never rewrites", async (t) => {
    const f = await publicationFixture(t);
    await installPublicationScripts(f.project);
    await checkGenerationProtocol(f.project);
    await f.generate();
    await assert.rejects(lstat(join(f.project, ".github", "extensions")), { code: "ENOENT" });
    const status = await generatedOutput(f.project, f.values["canvas.id"], f.handoff.handoffId, f.workspace);
    assert.equal(status.status, "ready");
    assert.equal(status.publication.status, "absent");
    const result = await publish(f);
    assert.equal(result.status, "published");
    assert.equal(result.reused, false);
    assert.equal(treeDigest(await snapshotGeneratedTree(f.source, true)),
        treeDigest(await snapshotGeneratedTree(f.runtime, true)));
    const before = await lstat(join(f.runtime, "extension.mjs"));
    assert.equal((await publish(f)).reused, true);
    const after = await lstat(join(f.runtime, "extension.mjs"));
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal((await readReceipt(f.source)).requestId, f.first.requestId);
});

test("source regeneration cannot publish or authorize runtime replacement", async (t) => {
    const f = await publicationFixture(t);
    await f.generate();
    await publish(f);
    const before = treeDigest(await snapshotGeneratedTree(f.runtime, true));
    const next = await f.freeze("Second", true);
    await f.generate(next, `--replace-existing=${f.first.requestId}`);
    assert.equal(treeDigest(await snapshotGeneratedTree(f.runtime, true)), before);
    await assert.rejects(publish(f, next), /Publication conflict/);
    assert.equal(treeDigest(await snapshotGeneratedTree(f.runtime, true)), before);
    const state = await publicationStatus(f.project, f.workspace, f.handoff.handoffId, f.values["canvas.id"]);
    await publish(f, next, `--replace-existing=${state.requestId}`, `--expected-target-digest=${state.digest}`);
    assert.equal(JSON.parse(await readFile(join(f.runtime, "canvas-config.json"))).canvas.displayName, "Second");
    assert.equal((await readdir(join(f.project, ".github", "extensions"))).length, 1);
});

test("publication refuses a changed runtime even when its prior request identity is unchanged", async (t) => {
    const f = await publicationFixture(t);
    await f.generate();
    await publish(f);
    const next = await f.freeze("Second", true);
    await f.generate(next, `--replace-existing=${f.first.requestId}`);
    const state = await publicationStatus(f.project, f.workspace, f.handoff.handoffId, f.values["canvas.id"]);
    await appendFile(join(f.runtime, "extension.mjs"), "\n// manual edit\n");
    await assert.rejects(publish(f, next, `--replace-existing=${state.requestId}`,
        `--expected-target-digest=${state.digest}`), /Publication conflict/);
    const changed = await publicationStatus(f.project, f.workspace, f.handoff.handoffId, f.values["canvas.id"]);
    assert.equal(changed.status, "modified");
    await publish(f, next, `--replace-existing=${changed.requestId}`, `--expected-target-digest=${changed.digest}`);
    assert.equal((await readReceipt(f.runtime)).requestId, next.requestId);
});

test("tampered files, extra files and changed receipts fail before discovery is created", async (t) => {
    for (const corrupt of [
        (f) => appendFile(join(f.source, "extension.mjs"), "\n// tampered\n"),
        (f) => writeFile(join(f.source, "extra.txt"), "unexpected"),
        async (f) => {
            const receipt = JSON.parse(await readFile(join(f.source, "generation-receipt.json")));
            receipt.files[0].hash = "0".repeat(64);
            await writeFile(join(f.source, "generation-receipt.json"), JSON.stringify(receipt));
        },
        (f) => rm(join(f.requestFolder(f.first.requestId), "generation-receipt.json")),
        (f) => writeFile(join(f.source, "generation-receipt.json"), Buffer.alloc(RECEIPT_LIMIT + 1)),
        (f) => rm(join(f.source, "extension.mjs")),
    ]) {
        const f = await publicationFixture(t);
        await f.generate();
        await corrupt(f);
        await assert.rejects(publish(f));
        await assert.rejects(lstat(join(f.project, ".github", "extensions")), { code: "ENOENT" });
    }
});

test("receipt inventories enforce exact path, count and byte limits", () => {
    const hash = "0".repeat(64);
    const file = (path, size = 0) => ({ path, size, hash });
    const receipt = { schemaVersion: 2, project: process.cwd(), canvasId: "bounded-receipt",
        handoffId: "handoff-1", requestId: "request-1", requestIntegrity: hash, sourceFingerprint: hash,
        target: "generated-canvases/bounded-receipt/", publicationTarget: ".github/extensions/bounded-receipt/",
        files: ["extension.mjs", "canvas-config.json", "canvas-setup.json", "settings-provenance.json"].map((path) => file(path)) };
    assert.equal(validateReceipt(receipt), receipt);
    const atByteLimit = { ...receipt, files: receipt.files.map(({ path }) => file(path, FILE_LIMIT)) };
    assert.equal(atByteLimit.files.reduce((total, entry) => total + entry.size, 0), TREE_LIMIT);
    assert.equal(validateReceipt(atByteLimit), atByteLimit);
    assert.throws(() => validateReceipt({ ...atByteLimit, files: [...atByteLimit.files, file("extra", 1)] }),
        /oversized generation receipt/);
    for (const size of [-1, 0.5, FILE_LIMIT + 1]) {
        assert.throws(() => validateReceipt({ ...receipt, files: [...receipt.files, file("extra", size)] }),
            /Invalid receipt file inventory/);
    }
    const atCountLimit = { ...receipt, files: [...receipt.files,
        ...Array.from({ length: 4092 }, (_, index) => file(`file-${index}`))] };
    assert.equal(validateReceipt(atCountLimit), atCountLimit);
    assert.throws(() => validateReceipt({ ...atCountLimit, files: [...atCountLimit.files, file("extra")] }),
        /Invalid generation receipt/);
    assert.equal(validateReceipt({ ...receipt, files: [...receipt.files, file(`${"a/".repeat(7)}file`)] }).files.length, 5);
    for (const path of ["../outside", "/outside", "a\\outside", "CON.txt", "a/NUL", "COM1.html",
        "LPT9.txt", `${"a/".repeat(8)}file`, "EXTENSION.MJS", "generation-receipt.json"]) {
        assert.throws(() => validateReceipt({ ...receipt, files: [...receipt.files, file(path)] }),
            /Invalid receipt file inventory/);
    }
    assert.throws(() => validateReceipt({ ...receipt, files: receipt.files.slice(1) }),
        /Incomplete or oversized generation receipt/);
});

test("generated reads and snapshots enforce exact emitted-byte limits", async (t) => {
    const f = await publicationFixture(t);
    const root = join(f.project, "bounded-output");
    await mkdir(root);
    const bytes = Buffer.alloc(FILE_LIMIT);
    await writeFile(join(root, "file-0"), bytes);
    assert.equal((await readGeneratedFile(root, "file-0")).length, FILE_LIMIT);
    await appendFile(join(root, "file-0"), "x");
    await assert.rejects(readGeneratedFile(root, "file-0"), /bounded regular file/);
    await writeFile(join(root, "file-0"), bytes);
    for (let index = 1; index < 4; index++) await writeFile(join(root, `file-${index}`), bytes);
    assert.equal((await snapshotGeneratedTree(root)).reduce((total, entry) => total + entry.size, 0), TREE_LIMIT);
    await writeFile(join(root, "extra"), "x");
    await assert.rejects(snapshotGeneratedTree(root), /exceeds 32 MiB/);
});

test("unsupported immutable requests cannot generate or publish and are never migrated", async (t) => {
    const f = await publicationFixture(t);
    const path = join(f.requestFolder(f.first.requestId), "request.json");
    const request = await f.readRequest();
    const bytes = JSON.stringify({ ...request, schemaVersion: 1 });
    await writeFile(path, bytes);
    await assert.rejects(f.generate(), /Unsupported generation request/);
    await assert.rejects(publish(f), /Unsupported generation request/);
    assert.equal(await readFile(path, "utf8"), bytes);
    await assert.rejects(lstat(f.source), { code: "ENOENT" });
});

test("reset recovery reopens only a unique already-published new-format app", async (t) => {
    const f = await publicationFixture(t);
    await f.generate();
    await publish(f);
    await rm(join(f.requestFolder(f.first.requestId), "request.json"));
    await assert.rejects(f.generate(), { code: "ENOENT" });
    assert.equal((await publish(f)).reused, true);
    assert.equal((await resolvePublication(f.project, f.workspace, f.handoff.handoffId,
        f.first.requestId)).canvasId, f.values["canvas.id"]);
    await rename(f.runtime, join(f.runtime, "..", "unrelated-name"));
    await assert.rejects(publish(f), /another checkout/);
});

test("an unrelated occupied runtime is never replaced", async (t) => {
    const f = await publicationFixture(t);
    await f.generate();
    await mkdir(f.runtime, { recursive: true });
    await writeFile(join(f.runtime, "extension.mjs"), "unrelated");
    await assert.rejects(publish(f));
    assert.equal(await readFile(join(f.runtime, "extension.mjs"), "utf8"), "unrelated");
    const status = await generatedOutputStatus(f.project, f.workspace, f.handoff.handoffId, f.values["canvas.id"]);
    assert.equal(status.status, "ready");
    assert.equal(status.publication.status, "blocked");
});

test("copy and install failures preserve the runtime, remove owned staging, and allow retry", async (t) => {
    const f = await publicationFixture(t);
    await f.generate();
    await publish(f);
    const before = treeDigest(await snapshotGeneratedTree(f.runtime, true));
    const next = await f.freeze("Second", true);
    await f.generate(next, `--replace-existing=${f.first.requestId}`);
    const state = await publicationStatus(f.project, f.workspace, f.handoff.handoffId, f.values["canvas.id"]);
    for (const operations of [
        { write: async () => { throw new Error("Copy failed"); } },
        { install: async () => { throw new Error("Install failed"); } },
    ]) {
        await assert.rejects(publish(f, next, `--replace-existing=${state.requestId}`,
            `--expected-target-digest=${state.digest}`, operations), /(?:Copy|Install) failed/);
        assert.equal(treeDigest(await snapshotGeneratedTree(f.runtime, true)), before);
        assert.deepEqual(await readdir(join(f.project, "generated-canvases")), [f.values["canvas.id"]]);
    }
    await publish(f, next, `--replace-existing=${state.requestId}`, `--expected-target-digest=${state.digest}`);
    assert.equal((await readReceipt(f.runtime)).requestId, next.requestId);
});

test("a concurrent first publication is never overwritten", async (t) => {
    const f = await publicationFixture(t);
    await f.generate();
    await assert.rejects(publish(f, f.first, false, null, {
        install: async (stage, target) => {
            await mkdir(target);
            await writeFile(join(target, "extension.mjs"), "other publisher");
            await renameDirectoryWithoutReplacement(stage, target);
        },
    }));
    assert.equal(await readFile(join(f.runtime, "extension.mjs"), "utf8"), "other publisher");
    assert.deepEqual(await readdir(join(f.project, "generated-canvases")), [f.values["canvas.id"]]);
});

test("a source change during copy fails instead of publishing stale validated bytes", async (t) => {
    const f = await publicationFixture(t);
    await f.generate();
    let changed = false;
    await assert.rejects(publish(f, f.first, false, null, {
        write: async (...args) => {
            await writeFile(...args);
            if (!changed) {
                changed = true;
                await appendFile(join(f.source, "extension.mjs"), "\n// concurrent edit\n");
            }
        },
    }), /differ from their receipt/);
    await assert.rejects(lstat(f.runtime), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(f.project, "generated-canvases")), [f.values["canvas.id"]]);
});

test("unsafe source parents fail before creating discovery", async (t) => {
    const f = await publicationFixture(t);
    await f.generate();
    const parent = join(f.project, "generated-canvases");
    const original = join(f.project, "source-original");
    await rename(parent, original);
    await symlink(original, parent, process.platform === "win32" ? "junction" : "dir");
    t.after(() => rm(parent, { force: true }));
    await assert.rejects(publish(f), /Unsafe generated directory/);
    await assert.rejects(lstat(join(f.project, ".github", "extensions")), { code: "ENOENT" });
});

test("failed rollback retains the prior runtime and reports its exact recovery path", async (t) => {
    const f = await publicationFixture(t);
    await f.generate();
    await publish(f);
    const priorBytes = treeDigest(await snapshotGeneratedTree(f.runtime, true));
    const next = await f.freeze("Second", true);
    await f.generate(next, `--replace-existing=${f.first.requestId}`);
    const state = await publicationStatus(f.project, f.workspace, f.handoff.handoffId, f.values["canvas.id"]);
    let failure;
    try {
        await publish(f, next, `--replace-existing=${state.requestId}`, `--expected-target-digest=${state.digest}`, {
            install: async (_stage, target) => {
                await mkdir(target);
                await writeFile(join(target, "extension.mjs"), "concurrent publisher");
                throw new Error("Install failed");
            },
        });
        assert.fail("Replacement must fail");
    } catch (error) { failure = error; }
    assert.ok(failure instanceof AggregateError);
    assert.match(failure.message, /Install failed.*rollback failed.*prior runtime remains at/);
    const recovery = failure.message.split("prior runtime remains at ")[1];
    assert.equal(treeDigest(await snapshotGeneratedTree(recovery, true)), priorBytes);
    assert.equal(await readFile(join(f.runtime, "extension.mjs"), "utf8"), "concurrent publisher");
    const folders = await readdir(join(f.project, "generated-canvases"));
    assert.equal(folders.filter((name) => name.includes("-publish-")).length, 0);
    assert.equal(folders.filter((name) => name.includes("-runtime-backup-")).length, 1);
});
