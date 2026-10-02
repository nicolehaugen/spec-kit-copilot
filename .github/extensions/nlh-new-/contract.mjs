import { safePath, UserError } from "./files.mjs";

const outputs = {
    constitution: ".specify/memory/constitution.md",
    specify: "specs/<slug>/spec.md", clarify: "specs/<slug>/spec.md",
    plan: "specs/<slug>/plan.md", tasks: "specs/<slug>/tasks.md",
    implement: "specs/<slug>/tasks.md", checklist: "specs/<slug>/checklists/<name>.md",
};
export function phaseContract(config) {
    const ids = new Set();
    const artifacts = config.phaseArtifacts === undefined ? {} : config.phaseArtifacts;
    if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)
        || Object.keys(artifacts).some((id) => !config.phases.includes(id))) throw new UserError("Invalid phase artifact configuration.");
    return config.phases.map((id) => {
        if (typeof id !== "string" || !/^(?:speckit\.)?[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id) || ids.has(id)) {
            throw new UserError("Invalid or duplicate generated phase.");
        }
        ids.add(id);
        const short = id.replace(/^speckit\./, "");
        const command = `speckit.${short}`;
        const declared = config.phaseOutputs[id]?.outputPath;
        const mapping = artifacts[id];
        if (mapping && (typeof mapping !== "object" || Object.keys(mapping).some((key) => !["outputs", "view"].includes(key))
            || !Array.isArray(mapping.outputs) || !mapping.outputs.length || !mapping.outputs.includes(mapping.view))) {
            throw new UserError("Invalid phase artifact outputs or viewer target.");
        }
        if (Object.hasOwn(artifacts, id) && !mapping) throw new UserError("Invalid phase artifact configuration.");
        const output = mapping?.view ?? (config.phaseOutputs[id]?.expectsArtifact === false ? null : declared || outputs[short] || null);
        const paths = mapping?.outputs ?? (output ? [output] : []);
        const normalized = paths.map((path) => safePath(path, true));
        if (new Set(normalized.map((path) => path.toLowerCase())).size !== normalized.length) throw new UserError("Duplicate phase output path.");
        for (const path of normalized) {
            if (!path.endsWith(".md") || /^(?:\.git|\.github|node_modules|\.speckit-canvas)\//i.test(path)
                || /^\.specify\/(?:extensions|presets|templates)\//i.test(path)
                || (mapping && ([...path].length > 1000 || /\x7f/.test(path)))
                || (mapping && (path.includes("<name>") || path.startsWith("<slug>/")
                    || path.split("/").filter((part) => part === "<slug>").length > 1
                    || (short === "constitution" && path.includes("<slug>"))))) {
                throw new UserError("Phase outputs must be workflow Markdown artifacts.");
            }
        }
        return { id, command, skill: command.replaceAll(".", "-"), output: output ? safePath(output, true) : null,
            outputs: normalized, configuredArtifacts: !!mapping,
            expectsArtifact: mapping ? true : config.phaseOutputs[id]?.expectsArtifact,
            project: short === "constitution", first: short === "specify" };
    });
}
