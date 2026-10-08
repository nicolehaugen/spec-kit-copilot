import assert from "node:assert/strict";
import { test } from "node:test";
import {
    createChild, inspectChild, sendChild, validateCreatedChild, validateInspectedChild, validateSentChild,
} from "../extension-canvas-design/generated-scaffold/contracts/child-session.mjs";

const id = "4c7bd764-95e9-4d72-8288-af783e74507b";
const alias = "a102138a-6487-4e6a-a984-e405431b9f82";
const projectId = "project-1";
const parentPath = "C:\\worktrees\\parent";
const childPath = "C:\\worktrees\\child";
const posixParent = "/worktrees/parent";
const posixChild = "/worktrees/child";
const success = (textResultForLlm) => ({ resultType: "success", textResultForLlm });
const created = success(`Created session 'Workflow child' (id: ${id}) in project 'spec-kit-copilot'`);
const inspected = (overrides = {}) => success(JSON.stringify({
    id: alias, project_id: projectId, session_type: "worktree",
    path: childPath, branch: "child-branch", ...overrides,
}));
const options = { id, projectId, parentPath };

function fakeSession(results) {
    const calls = [];
    return {
        calls,
        session: { rpc: { tools: { execute: async (request) => {
            calls.push(request);
            const result = results.shift();
            if (result instanceof Error) throw result;
            return result;
        } } } },
    };
}

test("creates an isolated app worktree, accepts its distinct session alias and routes immediately", async () => {
    const { session, calls } = fakeSession([created, inspected(), success("Message sent")]);
    const child = await createChild({ session, name: "Workflow child", projectId, parentPath,
        kickoffPrompt: "Run the complete workflow", baseBranch: "feature-base" });
    assert.deepEqual(child, { id, projectSessionId: alias, projectId,
        path: childPath, branch: "child-branch" });
    await sendChild({ session, id: child.id, message: "Continue workflow", mode: "autopilot" });
    assert.deepEqual(calls, [
        { name: "create_session", arguments: { name: "Workflow child", project_id: projectId,
            workspace_type: "worktree", coordinate_with_creator: false,
            kickoff: { prompt: "Run the complete workflow", mode: "autopilot" },
            base_branch: "feature-base" } },
        { name: "get_session", arguments: { project_session_id: id } },
        { name: "send_session_message", arguments: { session_id: id,
            message: "Continue workflow", delivery_mode: "immediate", mode: "autopilot" } },
    ]);
});

test("creation without kickoff does not start a child turn", async () => {
    const { session, calls } = fakeSession([created, inspected()]);
    await createChild({ session, name: "Workflow child", projectId, parentPath });
    assert.equal(Object.hasOwn(calls[0].arguments, "kickoff"), false);
});

test("creates and inspects a POSIX child worktree with the creation ID as routing handle", async () => {
    const { session, calls } = fakeSession([created, inspected({ path: posixChild, name: "Workflow child" })]);
    const child = await createChild({ session, name: "Workflow child", projectId,
        parentPath: posixParent });
    assert.equal(child.id, id);
    assert.equal(child.projectSessionId, alias);
    assert.equal(child.path, posixChild);
    assert.deepEqual(calls.map((call) => call.name), ["create_session", "get_session"]);
    assert.equal(validateInspectedChild(inspected({ path: "/Worktrees/parent" }),
        { ...options, parentPath: posixParent }).path, "/Worktrees/parent");
});

test("create result must bind the requested name to a single valid UUID", () => {
    for (const result of [
        success("Created session 'Other child' (id: " + id + ") in project 'spec-kit-copilot'"),
        success("Created session 'Workflow child' (id: not-a-uuid) in project 'spec-kit-copilot'"),
        success(`Created session 'Workflow child' (id: ${id})`),
        success(`Created session 'Workflow child' (id: ${id}) in project 'spec-kit-copilot'\nIgnored`),
        success(JSON.stringify({ id })),
        success(""), { resultType: "error", textResultForLlm: "denied" },
    ]) {
        assert.throws(() => validateCreatedChild(result, "Workflow child"), /Incompatible create_session result/);
    }
});

test("inspection rejects incompatible, spoofed or missing identity and paths", () => {
    for (const result of [
        success("not JSON"), success("null"), success("[]"),
        inspected({ id: undefined }), inspected({ id: "not-a-uuid" }),
        inspected({ active_session_id: "spoofed" }),
        inspected({ project_id: undefined }), inspected({ project_id: "other-project" }),
        inspected({ session_type: "branch" }), inspected({ session_type: undefined }),
        inspected({ path: undefined }), inspected({ path: "relative\\child" }),
        inspected({ path: parentPath.toUpperCase() + "\\" }),
        inspected({ path: parentPath + "\\nested" }),
        inspected({ path: "C:\\worktrees" }),
        inspected({ path: posixChild }),
        inspected({ path: "\\worktrees\\child" }),
        inspected({ name: "Another child" }),
        { resultType: "error", textResultForLlm: "not found" },
    ]) {
        assert.throws(() => validateInspectedChild(result, { ...options, name: "Workflow child" }),
            /Incompatible get_session result/);
    }
});

test("POSIX inspection rejects equal, descendant and ancestor paths and a different convention", () => {
    const optionsPosix = { ...options, parentPath: posixParent };
    for (const path of [posixParent + "/", posixParent + "/nested", "/worktrees",
        childPath, "relative/child"]) {
        assert.throws(() => validateInspectedChild(inspected({ path }), optionsPosix),
            /Incompatible get_session result/);
    }
    assert.equal(validateInspectedChild(inspected({ path: "/worktrees/parental" }),
        optionsPosix).path, "/worktrees/parental");
});

test("does not route after failed inspection, and propagates app tool failures", async () => {
    const { session, calls } = fakeSession([created, inspected({ project_id: "wrong" })]);
    await assert.rejects(createChild({ session, name: "Workflow child", projectId, parentPath }),
        /Incompatible get_session result/);
    assert.deepEqual(calls.map((call) => call.name), ["create_session", "get_session"]);
    const rejected = fakeSession([new Error("App tool unavailable")]);
    await assert.rejects(inspectChild({ session: rejected.session, ...options }), /App tool unavailable/);
    const failed = fakeSession([{ resultType: "error", textResultForLlm: "message rejected" }]);
    await assert.rejects(sendChild({ session: failed.session, id, message: "Continue" }),
        /Incompatible send_session_message result/);
});

test("routes with optional interactive mode or without a mode", async () => {
    const { session, calls } = fakeSession([success("Message sent"), success("Message sent")]);
    await sendChild({ session, id, message: "Run phase", mode: "interactive" });
    await sendChild({ session, id, message: "Continue" });
    assert.equal(calls[0].arguments.mode, "interactive");
    assert.equal(Object.hasOwn(calls[1].arguments, "mode"), false);
    assert.equal(validateSentChild(success("Message sent")), true);
    assert.throws(() => validateSentChild(success("")), /Incompatible send_session_message result/);
});

test("invalid arguments and missing tool executor fail before dispatch", async () => {
    const { session, calls } = fakeSession([]);
    await assert.rejects(createChild({ session, name: "Workflow child", projectId,
        parentPath: "relative\\parent" }), /absolute parent path/);
    await assert.rejects(createChild({ session, name: "Workflow child", projectId,
        parentPath: "relative/parent" }), /absolute parent path/);
    await assert.rejects(createChild({ session, name: "Child' spoofed", projectId,
        parentPath }), /Child creation requires/);
    await assert.rejects(sendChild({ session, id: "fake", message: "Continue" }), /UUID/);
    await assert.rejects(sendChild({ session, id, message: " " }), /nonempty message/);
    await assert.rejects(sendChild({ session, id, message: "Continue", mode: "plan" }), /supported mode/);
    await assert.rejects(inspectChild({ session: {}, ...options }), /session.rpc.tools.execute/);
    assert.equal(calls.length, 0);
});

test("creation rejects inspected metadata with a different child name before returning a handle", async () => {
    const { session } = fakeSession([created, inspected({ name: "Different child" })]);
    await assert.rejects(createChild({ session, name: "Workflow child", projectId, parentPath }),
        /Incompatible get_session result/);
});
