import assert from "node:assert/strict";
import { test } from "node:test";
import { phaseResponse, phaseTurnState } from "../extension-canvas-design/generated-scaffold/phase-response.mjs";
import { freshState, validateWorkflowState, validatePendingRemoval } from
    "../extension-canvas-design/generated-scaffold/contracts/workflow-state.mjs";

test("saved recovery status accepts existing state and rejects incompatible values", () => {
    const phases = [{ id: "specify" }];
    const state = freshState();
    state.runs.push({ runId: "run", phase: "specify", item: "__new__:1", sessionId: "session",
        instanceId: "canvas", args: "", before: [], status: "Completed", artifact: null, messageId: "msg" });
    assert.equal(validateWorkflowState(state, phases, []), state);
    state.runs[0].status = "Needs review";
    assert.equal(validateWorkflowState(state, phases, []), state);
    state.runs[0].status = "Needs deletion";
    assert.throws(() => validateWorkflowState(state, phases, []), /Saved canvas state is invalid/);
});

test("pending removal contract permits explicit discard but rejects incompatible confirmations", () => {
    assert.deepEqual(validatePendingRemoval({ itemId: "__new__:1", revision: 3 }),
        { itemId: "__new__:1", revision: 3 });
    assert.deepEqual(validatePendingRemoval({ itemId: "__new__:1", revision: 3, confirmation: "discard" }),
        { itemId: "__new__:1", revision: 3, confirmation: "discard" });
    for (const input of [{ itemId: "__new__:1", revision: 3, confirmation: true },
        { itemId: "__new__:1", revision: 3, confirmation: "delete" },
        { itemId: "__new__:1", revision: 3, extra: true }]) {
        assert.throws(() => validatePendingRemoval(input), /Invalid unstarted workflow removal/);
    }
});

test("a live turn is distinguished from a completed or missing turn", () => {
    const events = [
        { type: "user.message", data: { messageId: "sent", interactionId: "run" } },
        { type: "assistant.turn_start", data: { interactionId: "run", turnId: "turn" } },
    ];
    assert.deepEqual(phaseTurnState(events, "sent"), { active: true, ended: false });
    assert.deepEqual(phaseTurnState(events, "other"), { active: false, ended: false });
    events.push({ type: "assistant.turn_end", data: { turnId: "turn" } });
    assert.deepEqual(phaseTurnState(events, "sent"), { active: false, ended: true });
});

test("task completion after a tool-using turn records success", () => {
    const events = [
        { type: "user.message", data: { messageId: "sent", interactionId: "run" } },
        { type: "assistant.turn_start", data: { interactionId: "run", turnId: "turn" } },
        { type: "tool.execution_start", data: { turnId: "turn" } },
        { type: "assistant.turn_end", data: { turnId: "turn" } },
        { type: "session.task_complete", data: { success: true, summary: "Finished" } },
    ];
    assert.deepEqual(phaseResponse(events, "sent"), {
        response: "Finished", error: null, success: true,
    });
});

test("task failure after a tool-using turn records failure", () => {
    const events = [
        { type: "user.message", data: { messageId: "sent", interactionId: "run" } },
        { type: "assistant.turn_start", data: { interactionId: "run", turnId: "turn" } },
        { type: "assistant.message", data: { interactionId: "run", turnId: "turn",
            toolRequests: [{ name: "example" }] } },
        { type: "assistant.turn_end", data: { turnId: "turn" } },
        { type: "session.task_complete", data: { success: false } },
    ];
    assert.deepEqual(phaseResponse(events, "sent"), {
        response: null, error: "The phase did not complete successfully.", success: false,
    });

    test("matching message without an interaction ID is a terminal association failure", () => {
        assert.deepEqual(phaseResponse([
            { type: "user.message", data: { messageId: "other" } },
            { type: "user.message", data: { messageId: "sent" } },
        ], "sent"), {
            response: null, error: "The phase response could not be associated with its dispatched message.",
            success: false,
        });
    });
    assert.equal(phaseResponse(events, "another"), null);
});
