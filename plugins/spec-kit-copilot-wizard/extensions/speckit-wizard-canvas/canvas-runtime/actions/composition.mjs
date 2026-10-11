// Composition-view canvas action handler: showInferredPipeline.
//
// Renamed from `showComposition` because the composition slice
// (`{ presets, extensions, artifacts }`) is written by the deterministic
// fast assembler in `canvas-runtime/composition-apply.mjs::runFastComposition`
// directly from Node (no agent involvement). The one remaining
// LLM-driven writer is the `composition.inferPipeline` prompt in
// `prompts/composition.mjs`, and it pushes `{ runId, inferredPipeline }`.
// The action also requires the originating refresh runId before handing
// the inferred pipeline to `applyComposition`, which partial-
// merges it into the cached composition (preserving the assembler-owned
// slice untouched).

import { withInstance } from "../instances.mjs";
import { applyComposition } from "../composition-apply.mjs";
import { finishRefreshPart } from "../refresh-status.mjs";
import { inferredPipelineInputSchema } from "../../contracts/agent-pipeline.mjs";
import { assertReplyRunId, ReplyRunError } from "../../contracts/agent-replies.mjs";

export const compositionActions = [
    {
        name: "showInferredPipeline",
        description:
            "Push the LLM's inferred pipeline ordering with the unchanged originating runId from the refresh prompt. Missing, stale, or completed run IDs are rejected before applying. Partial-merge preserves the assembler-owned composition slice (`{ presets, extensions, artifacts }`). Every id in `pipeline` / `unplaced` must be an artifact id with `kind: \"command\"` in the current cached composition.",
        inputSchema: inferredPipelineInputSchema,
        handler: (ctx) =>
            withInstance(ctx, async (inst) => {
                const refresh = inst.refreshStatus;
                try {
                    assertReplyRunId(ctx.input?.runId,
                        refresh?.status === "refreshing" && refresh.pipelinePending ? refresh.id : null);
                } catch (error) {
                    if (!(error instanceof ReplyRunError)) throw error;
                    return { ok: false, inferredPipelineStatus: { accepted: false,
                        provided: ctx.input?.inferredPipeline !== undefined, reason: error.message } };
                }
                const result = await applyComposition(inst, { inferredPipeline: ctx.input.inferredPipeline });
                if (result.inferredPipelineStatus?.accepted) finishRefreshPart(inst, "pipeline", refresh);
                // Surface inferredPipeline acceptance so the LLM sees the
                // drop in-turn (silent-drop was the previous failure mode).
                return { ok: true, inferredPipelineStatus: result.inferredPipelineStatus };
            }),
    },
];
