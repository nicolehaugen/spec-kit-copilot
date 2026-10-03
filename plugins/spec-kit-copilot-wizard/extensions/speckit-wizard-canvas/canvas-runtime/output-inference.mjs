import { commandId } from "../artifact-evidence.mjs";
import { failRefresh } from "./refresh-status.mjs";

export function beginOutputInference(inst, requests) {
    if (inst.outputInference?.timer) clearTimeout(inst.outputInference.timer);
    inst.outputInference = null;
    if (!requests.length) return null;
    if (!inst.url || !inst.token) throw new Error("Artifact inference endpoint unavailable");
    const inference = { status: "updating", total: requests.length,
        pending: new Map(requests.map(({ commandId: id, fingerprint }) => [commandId(id), fingerprint])) };
    inference.timer = setTimeout(() => {
        if (inst.outputInference !== inference) return;
        inference.status = "incomplete";
        failRefresh(inst);
        inst.broadcast({ type: "invalidate", reason: "output inference timed out" });
    }, 10 * 60 * 1000);
    inference.timer.unref?.();
    inst.outputInference = inference;
    inst.broadcast({ type: "invalidate", reason: "output inference started" });
    const endpoint = new URL("/api/artifact-targets", inst.url);
    endpoint.searchParams.set("token", inst.token);
    return endpoint;
}

export function failOutputInference(inst) {
    if (!inst.outputInference) return;
    if (inst.outputInference.timer) clearTimeout(inst.outputInference.timer);
    inst.outputInference.status = "incomplete";
    failRefresh(inst);
    inst.broadcast({ type: "invalidate", reason: "output inference failed" });
}
