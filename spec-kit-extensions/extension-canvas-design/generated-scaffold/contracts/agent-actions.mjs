export const RESPONSE_LIMIT = 64 * 1024;

export const agentActionSchemas = Object.freeze({
    run_phase: { type: "object", additionalProperties: false, required: ["phase", "args"],
        properties: { phase: { type: "string" }, itemId: { type: "string" },
            args: { type: "string", maxLength: 32000 },
            slug: { type: "string", maxLength: 100 },
            name: { type: "string", maxLength: 120 } } },
    report_workflow_slug: { type: "object", additionalProperties: false, required: ["phaseRunId", "slug"],
        properties: { phaseRunId: { type: "string" },
            slug: { type: "string", minLength: 1, maxLength: 100 } } },
    report_phase_artifact: { type: "object", additionalProperties: false, required: ["phaseRunId", "path"],
        properties: { phaseRunId: { type: "string" }, path: { type: "string" } } },
    report_autopilot_step: { type: "object", additionalProperties: false,
        required: ["autopilotId", "phase", "action"],
        properties: { autopilotId: { type: "string" }, phase: { type: "string" },
            action: { type: "string", enum: ["start", "complete"] } } },
});

export function phaseResponse(events, messageId) {
    let interaction = null;
    let active = null;
    let turn = null;
    let text = "";
    let hasTools = false;
    let endedInteraction = null;
    let latest = null;
    const complete = (response) => Buffer.byteLength(response, "utf8") > RESPONSE_LIMIT
        ? { response: null, error: "The phase response exceeds the 64 KiB capture limit.", success: true }
        : { response, error: null, success: true };

    for (const event of events) {
        const data = event.data ?? {};
        if (event.agentId || data.parentToolCallId) continue;
        if (event.type === "user.message" && data.messageId === messageId) {
            if (!data.interactionId) return { response: null,
                error: "The phase response could not be associated with its dispatched message.", success: false };
            interaction = data.interactionId;
        }
        if (event.type === "assistant.turn_start") {
            active = data.interactionId;
            endedInteraction = null;
            turn = data.turnId;
            text = "";
            hasTools = false;
        }
        if (!interaction || (active !== interaction
            && !(event.type === "session.task_complete" && endedInteraction === interaction))) continue;
        if (event.type === "assistant.message" && data.interactionId === interaction && data.turnId === turn) {
            if (data.toolRequests?.length) hasTools = true;
            if (!data.toolRequests?.length && !["analysis", "commentary", "thinking"].includes(data.phase)
                && typeof data.content === "string" && data.content.trim()) text = data.content;
        }
        if (event.type === "tool.execution_start" && data.turnId === turn) hasTools = true;
        // Copilot App presents task_complete's summary as the agent's final reply.
        if (event.type === "session.task_complete" && data.success === true) latest = complete(data.summary ?? "");
        if (event.type === "session.task_complete" && data.success === false) {
            latest = { response: null, error: "The phase did not complete successfully.", success: false };
        }
        if (event.type === "assistant.turn_end" && data.turnId === turn) {
            if (text && !hasTools) latest = complete(text);
            endedInteraction = active;
            active = null;
        }
    }
    return latest;
}
