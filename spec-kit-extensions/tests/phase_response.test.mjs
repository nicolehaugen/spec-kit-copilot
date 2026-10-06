import assert from "node:assert/strict";
import { test } from "node:test";
import { phaseResponse } from "../extension-canvas-design/generated-scaffold/phase-response.mjs";

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
