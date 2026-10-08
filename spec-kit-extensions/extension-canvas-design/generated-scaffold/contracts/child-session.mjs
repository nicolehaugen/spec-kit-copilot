import { posix, win32 } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonempty(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function toolExecutor(session) {
    const execute = session?.rpc?.tools?.execute;
    if (typeof execute !== "function") throw new Error("Child session requires session.rpc.tools.execute");
    return (name, args) => execute.call(session.rpc.tools, { name, arguments: args });
}

function successfulText(result, tool) {
    if (result?.resultType !== "success" || !nonempty(result.textResultForLlm)) {
        throw new Error(`Incompatible ${tool} result: expected successful nonempty text`);
    }
    return result.textResultForLlm;
}

function pathConvention(path) {
    if (!nonempty(path) || path.includes("\0")) return null;
    if (path.startsWith("/")) return posix.isAbsolute(path) ? posix : null;
    // A rooted path without a drive or UNC share depends on the host's current drive.
    if (/^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(path)) {
        return win32.isAbsolute(path) ? win32 : null;
    }
    return null;
}

function normalizedPath(path, convention) {
    const resolved = convention.resolve(path);
    const root = convention.parse(resolved).root;
    const normalized = resolved === root ? resolved : resolved.replace(/[\\/]+$/, "");
    return convention === win32 ? normalized.toLowerCase() : normalized;
}

function overlaps(left, right, convention) {
    const separator = convention.sep;
    const inside = (ancestor, descendant) => descendant.startsWith(
        ancestor.endsWith(separator) ? ancestor : `${ancestor}${separator}`);
    return left === right || inside(left, right) || inside(right, left);
}

export function validateCreatedChild(result, name) {
    if (!nonempty(name) || /['\r\n]/.test(name)) throw new Error("Child session name must be nonempty display text");
    const text = successfulText(result, "create_session");
    const match = /^Created session '([^'\r\n]+)' \(id: ([0-9a-f-]+)\) in project '[^'\r\n]+'(?:[^\r\n]*)$/i.exec(text);
    if (!match || match[1] !== name || !UUID.test(match[2])) {
        throw new Error("Incompatible create_session result: missing or mismatched child identity");
    }
    return match[2];
}

export function validateInspectedChild(result, { id, projectId, parentPath, name }) {
    const convention = pathConvention(parentPath);
    if (!UUID.test(id ?? "") || !nonempty(projectId) || !convention) {
        throw new Error("Child inspection requires a UUID, project ID and absolute parent path");
    }
    let child;
    try {
        child = JSON.parse(successfulText(result, "get_session"));
    } catch (error) {
        if (error instanceof SyntaxError) throw new Error("Incompatible get_session result: expected JSON", { cause: error });
        throw error;
    }
    // The app can return project-session aliases rather than the creation/routing UUID.
    // A matching name provides an additional check when available; the lookup by
    // creation UUID is the only identity link if names are absent and IDs differ.
    if (!child || Array.isArray(child) || !UUID.test(child.id ?? "")
        || (child.active_session_id != null && !UUID.test(child.active_session_id))
        || child.project_id !== projectId || child.session_type !== "worktree"
        || pathConvention(child.path) !== convention
        || (name !== undefined && child.name !== undefined && child.name !== name)) {
        throw new Error("Incompatible get_session result: invalid child identity, project or worktree");
    }
    const parent = normalizedPath(parentPath, convention);
    const path = normalizedPath(child.path, convention);
    if (overlaps(parent, path, convention)) {
        throw new Error("Incompatible get_session result: child path overlaps parent worktree");
    }
    return { id, projectSessionId: child.id, projectId, path: child.path,
        branch: typeof child.branch === "string" ? child.branch : null };
}

export async function inspectChild({ session, id, projectId, parentPath, name }) {
    const execute = toolExecutor(session);
    if (!UUID.test(id ?? "") || !nonempty(projectId) || !pathConvention(parentPath)) {
        throw new Error("Child inspection requires a UUID, project ID and absolute parent path");
    }
    return validateInspectedChild(await execute("get_session", { project_session_id: id }),
        { id, projectId, parentPath, name });
}

export async function createChild({ session, name, projectId, parentPath, kickoffPrompt, baseBranch }) {
    const execute = toolExecutor(session);
    if (!nonempty(name) || /['\r\n]/.test(name) || !nonempty(projectId) || !pathConvention(parentPath)
        || (kickoffPrompt !== undefined && !nonempty(kickoffPrompt))
        || (baseBranch !== undefined && !nonempty(baseBranch))) {
        throw new Error("Child creation requires a name, project ID and absolute parent path");
    }
    const args = { name, project_id: projectId, workspace_type: "worktree",
        coordinate_with_creator: false };
    if (kickoffPrompt !== undefined) args.kickoff = { prompt: kickoffPrompt, mode: "autopilot" };
    if (baseBranch !== undefined) args.base_branch = baseBranch;
    const id = validateCreatedChild(await execute("create_session", args), name);
    return inspectChild({ session, id, projectId, parentPath, name });
}

export function validateSentChild(result) {
    successfulText(result, "send_session_message");
    return true;
}

export async function sendChild({ session, id, message, mode }) {
    const execute = toolExecutor(session);
    if (!UUID.test(id ?? "") || !nonempty(message)
        || (mode !== undefined && !["interactive", "autopilot"].includes(mode))) {
        throw new Error("Child routing requires a UUID, nonempty message and supported mode");
    }
    const args = { session_id: id, message, delivery_mode: "immediate" };
    if (mode !== undefined) args.mode = mode;
    validateSentChild(await execute("send_session_message", args));
}
