import { randomUUID } from "node:crypto";

export function startRefresh(inst) {
    if (inst.refreshStatus?.timer) clearTimeout(inst.refreshStatus.timer);
    const refresh = { id: randomUUID(), status: "refreshing", pipelinePending: true, outputsPending: true };
    refresh.timer = setTimeout(() => {
        if (inst.refreshStatus === refresh) failRefresh(inst);
    }, 10 * 60 * 1000);
    refresh.timer.unref?.();
    inst.refreshStatus = refresh;
    inst.broadcast({ type: "invalidate", reason: "composition refresh started" });
}

export function setRefreshWork(inst, { pipeline, outputs }) {
    if (inst.refreshStatus?.status !== "refreshing") return;
    inst.refreshStatus.pipelinePending = !!pipeline;
    inst.refreshStatus.outputsPending = !!outputs;
    finishRefreshPart(inst);
}

export function finishRefreshPart(inst, part) {
    const refresh = inst.refreshStatus;
    if (!refresh || refresh.status !== "refreshing") return;
    if (part === "pipeline") refresh.pipelinePending = false;
    if (part === "outputs") refresh.outputsPending = false;
    if (!refresh.pipelinePending && !refresh.outputsPending) {
        clearTimeout(refresh.timer);
        refresh.status = "up-to-date";
    }
    inst.broadcast({ type: "invalidate", reason: "composition refresh status changed" });
}

export function failRefresh(inst) {
    const refresh = inst.refreshStatus;
    if (!refresh || refresh.status !== "refreshing") return;
    clearTimeout(refresh.timer);
    refresh.status = "incomplete";
    inst.broadcast({ type: "invalidate", reason: "composition refresh failed" });
}
