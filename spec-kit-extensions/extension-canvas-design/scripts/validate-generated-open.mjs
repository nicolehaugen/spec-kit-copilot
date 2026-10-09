import { isAbsolute, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
    throw new Error(`Generated canvas registration: ${message}`);
}

function field(text, label) {
    return text.match(new RegExp(`^\\s*${label}:\\s*(.*?)\\s*$`, "mi"))?.[1];
}

function expected(checkout, canvasId, requestId) {
    if (typeof checkout !== "string" || !isAbsolute(checkout)
        || !/^[a-z0-9][a-z0-9-]*$/.test(canvasId)
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(requestId)) {
        fail("invalid checkout, canvas ID or request ID.");
    }
    return { extensionId: `project:${canvasId}`, canvasId,
        instanceId: `generated-${requestId}`,
        entry: resolve(checkout, ".github", "extensions", canvasId, "extension.mjs") };
}

function samePath(actual, target) {
    if (typeof actual !== "string" || !isAbsolute(actual)) return false;
    const left = normalize(actual);
    const right = normalize(target);
    return process.platform === "win32"
        ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function validateGeneratedProvider(list, inspect, checkout, canvasId, requestId) {
    const wanted = expected(checkout, canvasId, requestId);
    if (typeof list !== "string" || typeof inspect !== "string") {
        fail("list and inspect must contain the unmodified extension-management results.");
    }
    const entries = list.split(/^•\s*/m).slice(1);
    const registered = entries.filter((entry) => field(entry, "ID") === wanted.extensionId);
    if (registered.length !== 1 || field(registered[0], "Source") !== "project"
        || !samePath(field(registered[0], "Path"), wanted.entry)) {
        fail("the project provider is missing, ambiguous, or not from the generated entry point.");
    }
    if (field(inspect, "ID") !== wanted.extensionId
        || field(inspect, "Source") !== "project"
        || !samePath(field(inspect, "Path"), wanted.entry)
        || !["running", "ready"].includes(field(inspect, "Status"))) {
        fail("inspection does not show the running generated project provider.");
    }
    return wanted;
}

function identity(result, kind) {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
        fail(`${kind} must supply the tool's explicit canvas and extension IDs.`);
    }
    return result;
}

export function validateGeneratedCanvas(result, checkout, canvasId, requestId) {
    const wanted = expected(checkout, canvasId, requestId);
    const found = identity(result, "canvas capabilities");
    if (found.canvasId !== wanted.canvasId || found.extensionId !== wanted.extensionId) {
        fail("canvas capabilities belong to a different canvas or provider.");
    }
    return wanted;
}

export function validateGeneratedOpen(result, checkout, canvasId, requestId) {
    const wanted = validateGeneratedCanvas(result, checkout, canvasId, requestId);
    if (result.instanceId !== wanted.instanceId) {
        fail("opened instance does not match the generation request.");
    }
    return wanted;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const [stage, checkout, canvasId, requestId] = process.argv.slice(2);
        if (!["provider", "canvas", "open"].includes(stage)) {
            fail("usage: validate-generated-open.mjs <provider|canvas|open> <checkout> <canvas-id> <request-id> (JSON on stdin).");
        }
        let json = "";
        for await (const chunk of process.stdin) json += chunk;
        const input = JSON.parse(json);
        const wanted = stage === "provider"
            ? validateGeneratedProvider(input.list, input.inspect, checkout, canvasId, requestId)
            : stage === "canvas"
                ? validateGeneratedCanvas(input.capabilities, checkout, canvasId, requestId)
                : validateGeneratedOpen(input.opened, checkout, canvasId, requestId);
        console.log(JSON.stringify(wanted));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
