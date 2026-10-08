// Composition-view canvas action handler: showInferredPipeline.
//
// Renamed from `showComposition` because the composition slice
// (`{ presets, extensions, artifacts }`) is written by the deterministic
// fast assembler in `canvas-runtime/composition-apply.mjs::runFastComposition`
// directly from Node (no agent involvement). The one remaining
// LLM-driven writer is the `composition.inferPipeline` prompt in
// `prompts/composition.mjs`, and it only ever pushes `{ inferredPipeline }`.
// So this action's real contract is: receive one payload — the LLM's
// inferred pipeline — and hand it to `applyComposition`, which partial-
// merges it into the cached composition (preserving the assembler-owned
// slice untouched).

import { withInstance } from "../instances.mjs";
import { applyComposition } from "../composition-apply.mjs";
import { finishRefreshPart } from "../refresh-status.mjs";
import { inferredPipelineInputSchema } from "../../contracts/agent-pipeline.mjs";

export const compositionActions = [
    {
        name: "showInferredPipeline",
        description:
            "Push the LLM's inferred pipeline ordering (`{ shape, pipeline, unplaced, rationale }`) to the wizard. Emitted by the `composition.inferPipeline` prompt after reading `state.composition.artifacts` + fetched READMEs. Partial-merge in the handler preserves the assembler-owned composition slice (`{ presets, extensions, artifacts }`) untouched. Every id in `pipeline` / `unplaced` must be an artifact id with `kind: \"command\"` in the current cached composition — closed vocabulary.",
        inputSchema: inferredPipelineInputSchema,
        handler: (ctx) =>
            withInstance(ctx, async (inst) => {
                const result = await applyComposition(inst, ctx.input ?? {});
                if (result.inferredPipelineStatus?.accepted) finishRefreshPart(inst, "pipeline");
                // Surface inferredPipeline acceptance so the LLM sees the
                // drop in-turn (silent-drop was the previous failure mode).
                return { ok: true, inferredPipelineStatus: result.inferredPipelineStatus };
            }),
    },
];
