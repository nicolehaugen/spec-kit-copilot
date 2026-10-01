// Workspace resolution helpers shared by the wizard canvas runtime.

import { stat } from "node:fs/promises";
import path from "node:path";

export async function pathExists(path, statFn = stat) {
    try {
        await statFn(path);
        return true;
    } catch {
        return false;
    }
}

// Join `relativePath` onto `base`, preserving the separator style already
// present in `base` so a Windows-style workspace path stays Windows-style
// regardless of the runtime OS (matters for tests and for values persisted
// into state.json). Falls back to the runtime's `path.join` when `base`
// has no separators to sniff.
export function joinIfPossible(base, relativePath) {
    if (!base) return null;
    const looksWindows = /\\/.test(base) || /^[A-Za-z]:/.test(base);
    const join = looksWindows ? path.win32.join : path.posix.join;
    return join(base, relativePath);
}

export function resolveWorkspace(instance, context, sessionRepoPath) {
    const fromInput = context?.input?.cwd;
    if (typeof fromInput === "string" && fromInput.length) return fromInput;
    if (typeof sessionRepoPath === "string" && sessionRepoPath.length) return sessionRepoPath;
    return instance?.workspacePath ?? null;
}

// Resolve the `generateCanvas` feature flag on open/reopen. A reopen/focus
// `open_canvas` call that omits the field (e.g. a focus-only call used just
// to invoke an action) must not silently clear a previously-set flag — only
// an explicit boolean in this call's input should change it, mirroring the
// "rehydrate on reconnect" fallback used by resolveWorkspace above.
export function resolveGenerateCanvas(instance, context) {
    const fromInput = context?.input?.generateCanvas;
    if (fromInput !== undefined) return fromInput === true;
    return instance?.generateCanvas === true;
}

export async function fetchSessionRepoPath(session) {
    try {
        const snapshot = await session?.rpc?.metadata?.snapshot?.();
        if (!snapshot) return null;
        if (typeof snapshot.workingDirectory === "string" && snapshot.workingDirectory.length) {
            return snapshot.workingDirectory;
        }
        const workspace = snapshot.workspace;
        if (workspace) {
            if (typeof workspace.cwd === "string" && workspace.cwd.length) return workspace.cwd;
            if (typeof workspace.git_root === "string" && workspace.git_root.length) return workspace.git_root;
        }
    } catch {
        // The caller exposes an unavailable workspace state when metadata is unavailable.
    }
    return null;
}
