import { commandId } from "../artifact-evidence.mjs";
import { failRefresh, finishRefreshPart, isCurrentRefresh } from "./refresh-status.mjs";

function isCurrentInference(inst, inference) {
    return !!inference && inst.outputInference === inference && isCurrentRefresh(inst, inference.refresh);
}

export function beginOutputInference(inst, requests, refresh) {
    if (!isCurrentRefresh(inst, refresh)) throw new Error("Output inference superseded by a newer refresh");
    if (inst.outputInference?.timer) clearTimeout(inst.outputInference.timer);
    inst.outputInference = null;
    if (refresh) refresh.inference = null;
    if (!requests.length) return null;
    if (!inst.url || !inst.token) throw new Error("Artifact inference endpoint unavailable");
    const inference = { refresh, status: "updating", total: requests.length,
        pending: new Map(requests.map(({ commandId: id, fingerprint }) => [commandId(id), fingerprint])) };
    inference.timer = setTimeout(() => {
        failOutputInference(inst, inference, "output inference timed out");
    }, 10 * 60 * 1000);
    inference.timer.unref?.();
    inst.outputInference = inference;
    if (refresh) refresh.inference = inference;
    inst.broadcast({ type: "invalidate", reason: "output inference started" });
    const endpoint = new URL("/api/artifact-targets", inst.url);
    endpoint.searchParams.set("token", inst.token);
    return endpoint;
}

export function finishOutputInference(inst, inference, commands) {
    if (!isCurrentInference(inst, inference)) return;
    for (const id of commands) inference.pending.delete(commandId(id));
    if (!inference.pending.size) {
        clearTimeout(inference.timer);
        inst.outputInference = null;
        // Keep the owner's reference so a later send error still belongs to this
        // work after successful output completion, but not after replacement.
        finishRefreshPart(inst, "outputs", inference.refresh);
    }
}

export function failOutputInference(inst, inference, reason = "output inference failed") {
    if (!isCurrentInference(inst, inference)) return;
    clearTimeout(inference.timer);
    inference.status = "incomplete";
    failRefresh(inst, inference.refresh);
    inst.broadcast({ type: "invalidate", reason });
}
