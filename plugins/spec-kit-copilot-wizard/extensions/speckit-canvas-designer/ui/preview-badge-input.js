export const controlId = "preview.badge-inputs";
export const contractVersion = 1;

export function mount({ root, rule, inputs, phases, outputs, onChange }) {
    const value = { ...inputs };
    let ready = true;
    for (const input of rule.inputs) {
        const label = document.createElement("label");
        label.textContent = input.label ?? input.id;
        const field = document.createElement(input.type === "text" ? "input" : "select");
        if (input.type === "text") {
            field.value = value[input.id] ?? "";
            field.addEventListener("input", () => {
                value[input.id] = field.value;
                onChange({ ...value });
            });
        } else {
            const choices = input.type === "phase"
                ? phases.map((phase) => ({ label: phase, value: phase }))
                : phases.flatMap((phase) => (outputs[phase]?.outputs ?? []).map((output) =>
                    ({ label: `${phase}: ${output}`, value: JSON.stringify({ phase, output }) })));
            for (const choice of choices) {
                const option = document.createElement("option");
                option.value = choice.value;
                option.textContent = choice.label;
                field.append(option);
            }
            if (input.type === "phase") field.value = value[input.id] ?? choices[0]?.value;
            else if (input.type === "artifact") {
                field.value = JSON.stringify(value[input.id] ?? {});
            } else {
                ready = false;
                const hint = document.createElement("span");
                hint.textContent = "Open the installed Designer to edit this input.";
                label.append(hint);
                field.disabled = true;
            }
            field.addEventListener("change", () => {
                value[input.id] = input.type === "phase" ? field.value : JSON.parse(field.value);
                onChange({ ...value });
            });
        }
        label.append(field);
        root.append(label);
    }
    return { isReady: () => ready };
}
