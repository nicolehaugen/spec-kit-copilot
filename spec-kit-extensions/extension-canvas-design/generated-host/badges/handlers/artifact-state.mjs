export const contractVersion = 1;

export async function evaluate({ ruleId, inputs, evidence }) {
    if (ruleId !== "artifact-current" && ruleId !== "artifact-stale") {
        throw new Error(`Unsupported artifact-state badge rule: ${ruleId}`);
    }
    const file = await evidence.readArtifact(inputs.artifact);
    if (file.state === "unknown") {
        return { match: false, diagnostics: [file.diagnostic] };
    }
    if (file.state === "missing") return { match: false };
    const run = await evidence.getRun(inputs.artifact.phase);
    if (!run?.completedAt) return { match: ruleId === "artifact-current" };
    const current = file.mtimeMs >= new Date(run.completedAt).getTime();
    return { match: ruleId === "artifact-current" ? current : !current };
}
