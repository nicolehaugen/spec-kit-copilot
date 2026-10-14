import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedSessionFile } from "./generate.mjs";
import { generationTargets, RECEIPT_NAME, REQUEST_LIMIT,
    validateGenerationRequestIntegrity } from "./contracts/generation-request.mjs";
import { readGeneratedFile, readReceipt, RECEIPT_LIMIT, renameDirectoryWithoutReplacement,
    safeDirectory, snapshotGeneratedTree, treeDigest, unchangedDirectory, validateReceipt } from "./generated-files.mjs";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export async function loadGeneratedRequest(project, workspace, handoffId, requestId, optional = false) {
    if (!isAbsolute(project) || !isAbsolute(workspace)
        || !idPattern.test(handoffId) || !idPattern.test(requestId)) {
        throw new Error("Invalid generation checkout, workspace or identifiers");
    }
    const checkout = await realpath(project);
    await safeDirectory(checkout);
    let folder = resolve(workspace);
    for (const part of ["speckit-canvas-designer", "handoffs", handoffId, "generations", requestId]) {
        if (!await safeDirectory(folder, optional)) return null;
        folder = join(folder, part);
    }
    if (!await safeDirectory(folder, optional)) return null;
    let bytes;
    try { bytes = await readBoundedSessionFile(folder, "request.json", REQUEST_LIMIT, "Generation request"); }
    catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
    const request = JSON.parse(bytes);
    validateGenerationRequestIntegrity(request, handoffId, requestId);
    if (request.project !== checkout) throw new Error("Generation request is bound to another checkout");
    return { request, folder, checkout };
}

async function authoritativeReceipt(generation) {
    return validateReceipt(JSON.parse(await readBoundedSessionFile(generation.folder,
        RECEIPT_NAME, RECEIPT_LIMIT, "Generation receipt")), generation.request);
}

async function verifiedTree(root, generation) {
    const receipt = await readReceipt(root, generation.request);
    if (JSON.stringify(receipt) !== JSON.stringify(await authoritativeReceipt(generation))) {
        throw new Error("Generation receipt differs from the session receipt");
    }
    return receipt;
}

async function publicationParent(project, create = false) {
    let parent = project;
    for (const part of [".github", "extensions"]) {
        parent = join(parent, part);
        if (create) await mkdir(parent, { recursive: true });
        if (!await safeDirectory(parent, !create)) return null;
    }
    return parent;
}

export async function publicationStatus(project, workspace, handoffId, canvasId) {
    const paths = generationTargets(canvasId);
    const parent = await publicationParent(project);
    if (!parent) return { status: "absent" };
    const target = join(project, paths.publicationTarget);
    if (!await safeDirectory(target, true)) return { status: "absent" };
    const receipt = await readReceipt(target, null, false);
    if (receipt.project !== project || receipt.canvasId !== canvasId || receipt.handoffId !== handoffId) {
        throw new Error("Published canvas belongs to another checkout or handoff");
    }
    const previous = await loadGeneratedRequest(project, workspace, handoffId, receipt.requestId, true);
    if (previous && JSON.stringify(receipt) !== JSON.stringify(await authoritativeReceipt(previous))) {
        throw new Error("Published receipt differs from the session receipt");
    }
    const files = await snapshotGeneratedTree(target);
    return { status: treeDigest(files) === treeDigest(receipt.files) ? "ready" : "modified",
        requestId: receipt.requestId, digest: treeDigest(await snapshotGeneratedTree(target, true)) };
}

export async function generatedOutputStatus(project, workspace, handoffId, canvasId) {
    const paths = generationTargets(canvasId);
    const checkout = await realpath(project);
    let publication;
    try { publication = await publicationStatus(checkout, workspace, handoffId, canvasId); }
    catch (error) { publication = { status: "blocked", error: error.message }; }
    const base = { ...paths, publication };
    const parent = join(checkout, "generated-canvases");
    try {
        if (!await safeDirectory(parent, true)
            || !await safeDirectory(join(parent, canvasId), true)) return { ...base, status: "absent" };
        const source = join(parent, canvasId);
        const receipt = await readReceipt(source, null, false);
        const generation = await loadGeneratedRequest(checkout, workspace, handoffId, receipt.requestId);
        if (receipt.canvasId !== canvasId || receipt.handoffId !== handoffId
            || JSON.stringify(receipt) !== JSON.stringify(await authoritativeReceipt(generation))) {
            throw new Error("Generated receipt does not match the intended canvas and handoff");
        }
        const files = await snapshotGeneratedTree(source);
        if (!receipt.files.every((file) => files.some((entry) => entry.path === file.path))) {
            return { ...base, status: "incomplete", error: "Generated output is missing files" };
        }
        return { ...base, status: treeDigest(files) === treeDigest(receipt.files) ? "ready" : "modified",
            requestId: receipt.requestId };
    } catch (error) {
        return { ...base, status: "foreign", error: error.message };
    }
}

export async function resolvePublication(project, workspace, handoffId, requestId) {
    const generation = await loadGeneratedRequest(project, workspace, handoffId, requestId, true);
    if (generation) {
        const { request, checkout } = generation;
        const source = join(checkout, request.target);
        const sourceParent = join(checkout, "generated-canvases");
        if (await safeDirectory(sourceParent, true) && await safeDirectory(source, true)) {
            await verifiedTree(source, generation);
        } else {
            const parent = await publicationParent(checkout);
            if (!parent) throw new Error("Generated source is missing");
            await verifiedTree(join(checkout, request.publicationTarget), generation);
        }
        return { canvasId: request.values["canvas.id"], requestId, target: request.target,
            publicationTarget: request.publicationTarget };
    }
    const checkout = await realpath(project);
    const parent = await publicationParent(checkout);
    if (!parent) throw new Error("No published generated canvas matches the request");
    const parentStat = await safeDirectory(parent);
    const matches = [];
    for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        let paths;
        try { paths = generationTargets(entry.name); } catch { continue; }
        const target = join(parent, entry.name);
        let metadata;
        try { metadata = JSON.parse(await readGeneratedFile(target, RECEIPT_NAME, RECEIPT_LIMIT)); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        const receipt = validateReceipt(metadata);
        if (receipt.handoffId !== handoffId || receipt.requestId !== requestId) continue;
        await readReceipt(target);
        if (receipt.project !== checkout || receipt.canvasId !== entry.name) {
            throw new Error("Published receipt belongs to another checkout");
        }
        matches.push({ canvasId: entry.name, requestId, ...paths });
    }
    await unchangedDirectory(parent, parentStat);
    if (matches.length !== 1) throw new Error(`Expected one published generated canvas, found ${matches.length}`);
    return matches[0];
}

export async function publishGenerated(project, workspace, handoffId, requestId,
    replaceExisting = false, expectedDigest = null,
    { write = writeFile, install = renameDirectoryWithoutReplacement } = {}) {
    const resolved = await resolvePublication(project, workspace, handoffId, requestId);
    const generation = await loadGeneratedRequest(project, workspace, handoffId, requestId, true);
    const checkout = await realpath(project);
    const target = join(checkout, resolved.publicationTarget);
    const priorRequestId = typeof replaceExisting === "string"
        ? /^--replace-existing=([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(replaceExisting)?.[1] : null;
    const digest = typeof expectedDigest === "string"
        ? /^--expected-target-digest=([a-f0-9]{64})$/.exec(expectedDigest)?.[1] : null;
    if (replaceExisting !== false && (!priorRequestId || !digest)
        || replaceExisting === false && expectedDigest !== null) {
        throw new Error("Invalid publication replacement authorization");
    }
    const state = await publicationStatus(checkout, workspace, handoffId, resolved.canvasId);
    if (state.status === "ready" && state.requestId === requestId) {
        if (generation) await verifiedTree(target, generation);
        return { ...resolved, status: "published", reused: true, warnings: [] };
    }
    if (!generation) throw new Error("First-time publication requires the frozen request and receipt");
    if (state.status === "absent" ? !!priorRequestId
        : state.requestId !== priorRequestId || state.digest !== digest) {
        throw new Error("Publication conflict: confirm replacement of the current runtime during Open");
    }
    const source = join(checkout, resolved.target);
    const receipt = await verifiedTree(source, generation);
    const sourceStat = await safeDirectory(source);
    const parent = await publicationParent(checkout, true);
    const parentStat = await safeDirectory(parent);
    const stagingParent = join(checkout, "generated-canvases");
    const stagingParentStat = await safeDirectory(stagingParent);
    if (stagingParentStat.dev !== parentStat.dev) throw new Error("Publication must stay on the same filesystem");
    const stage = await mkdtemp(join(stagingParent, `.${resolved.canvasId}-publish-`));
    const stageStat = await safeDirectory(stage);
    let backupDir;
    let backupStat;
    let moved = false;
    let published = false;
    let failure;
    const warnings = [];
    try {
        for (const file of [...receipt.files, { path: RECEIPT_NAME }]) {
            const from = join(source, file.path), to = join(stage, file.path);
            await mkdir(dirname(to), { recursive: true });
            const bytes = await readGeneratedFile(dirname(from), from.slice(dirname(from).length + 1));
            await write(to, bytes, { flag: "wx" });
        }
        await verifiedTree(stage, generation);
        await unchangedDirectory(source, sourceStat);
        await verifiedTree(source, generation);
        await unchangedDirectory(parent, parentStat);
        await unchangedDirectory(stagingParent, stagingParentStat);
        const latest = await publicationStatus(checkout, workspace, handoffId, resolved.canvasId);
        if (JSON.stringify(latest) !== JSON.stringify(state)) throw new Error("Published canvas changed during Open");
        if (state.status !== "absent") {
            const original = await safeDirectory(target);
            backupDir = await mkdtemp(join(stagingParent, `.${resolved.canvasId}-runtime-backup-`));
            backupStat = await safeDirectory(backupDir);
            await renameDirectoryWithoutReplacement(target, join(backupDir, "previous"));
            moved = true;
            await unchangedDirectory(join(backupDir, "previous"), original);
            if (treeDigest(await snapshotGeneratedTree(join(backupDir, "previous"), true)) !== digest) {
                throw new Error("Published canvas changed during replacement");
            }
        }
        await install(stage, target);
        published = true;
    } catch (error) {
        failure = error;
        if (moved && !published) {
            try { await renameDirectoryWithoutReplacement(join(backupDir, "previous"), target); }
            catch (rollback) {
                failure = new AggregateError([error, rollback],
                    `Publication failed (${error.message}); rollback failed (${rollback.message}); prior runtime remains at ${join(backupDir, "previous")}`);
            }
        }
    }
    try {
        if (await safeDirectory(stage, true)) {
            await unchangedDirectory(stage, stageStat);
            await rm(stage, { recursive: true });
        }
    } catch (error) {
        if (failure) failure = new AggregateError([failure, error],
            `${failure.message}; staging cleanup failed at ${stage}: ${error.message}`);
        else warnings.push(`Published, but staging cleanup failed at ${stage}: ${error.message}`);
    }
    try {
        if (backupDir && (published || !await safeDirectory(join(backupDir, "previous"), true))) {
            await unchangedDirectory(backupDir, backupStat);
            await rm(backupDir, { recursive: true });
        }
    } catch (error) {
        if (failure) failure = new AggregateError([failure, error],
            `${failure.message}; backup cleanup failed at ${backupDir}: ${error.message}`);
        else warnings.push(`Published, but backup cleanup failed at ${backupDir}: ${error.message}`);
    }
    if (failure) throw failure;
    return { ...resolved, status: "published", reused: false, warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { process.stdout.write(`${JSON.stringify(await publishGenerated(...process.argv.slice(2)))}\n`); }
    catch (error) { process.stderr.write(`Canvas publication: ${error.message}\n`); process.exitCode = 1; }
}
