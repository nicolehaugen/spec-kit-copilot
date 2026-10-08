export const contractVersion = 1;

function outsideFences(text) {
    const lines = [];
    let fence = null;
    for (const line of text.split(/\r?\n/)) {
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (marker) {
            const current = marker[1];
            if (!fence) {
                fence = current;
                continue;
            }
            if (current[0] === fence[0] && current.length >= fence.length
                && line.slice(marker[0].length).trim() === "") {
                fence = null;
                continue;
            }
        }
        if (!fence) lines.push(line);
    }
    return lines;
}

function checklist(text) {
    let completed = 0;
    let total = 0;
    for (const line of outsideFences(text)) {
        const item = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\](?:\s|$)/.exec(line);
        if (!item) continue;
        total++;
        if (item[1] !== " ") completed++;
    }
    return { completed, total, percent: total ? Math.round(completed * 100 / total) : 0 };
}

export async function evaluate({ ruleId, inputs, evidence }) {
    if (ruleId === "value-match") {
        const file = await evidence.readArtifact(inputs.artifact);
        if (file.state === "unknown") {
            return { match: false, diagnostics: [file.diagnostic] };
        }
        if (file.state === "missing") return { match: false };
        return { match: file.text.toLowerCase().includes(inputs.value.toLowerCase()) };
    }
    if (ruleId === "markdown-file-count") {
        const directory = await evidence.countMarkdownFiles(inputs.artifact);
        if (directory.state === "unknown") {
            return { match: false, diagnostics: [directory.diagnostic] };
        }
        const count = directory.count;
        return { match: count > 0, values: { count } };
    }
    if (!["checklist-progress", "checklist-complete", "work-complete"].includes(ruleId)) {
        throw new Error(`Unsupported content badge rule: ${ruleId}`);
    }
    const file = await evidence.readArtifact(inputs.artifact);
    if (file.state === "unknown") {
        return { match: false, diagnostics: [file.diagnostic] };
    }
    if (file.state === "missing") return { match: false };
    const values = checklist(file.text);
    if (ruleId === "checklist-progress") return { match: values.total > 0, values };
    if (!values.total || values.completed !== values.total) return { match: false };
    if (ruleId === "checklist-complete") {
        const prerequisite = await evidence.readArtifact(inputs.prerequisite);
        if (prerequisite.state === "unknown") {
            return { match: false, diagnostics: [prerequisite.diagnostic] };
        }
        if (prerequisite.state === "missing") return { match: false };
        if (!Number.isFinite(file.mtimeMs) || !Number.isFinite(prerequisite.mtimeMs)) {
            return { match: false, diagnostics: ["Checklist or earlier output timestamp is unavailable."] };
        }
        return { match: file.mtimeMs >= prerequisite.mtimeMs };
    }
    return { match: (await evidence.getRun(inputs.phase))?.status === "completed" };
}
