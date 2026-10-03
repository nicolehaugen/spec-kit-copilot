export const controlId = "stock.text";
export const valueContract = { type: "string" };

export function mount({ root, field, value, context, onChange }) {
    const { constraints, inputId } = context ?? {};
    if (!root || typeof root.replaceChildren !== "function"
        || !field?.id || typeof field.label !== "string"
        || typeof value !== "string" || typeof onChange !== "function"
        || typeof inputId !== "string" || !inputId
        || constraints?.type !== "string" || !Number.isInteger(constraints.maxLength)) {
        throw new Error("Invalid Designer text control or value");
    }
    const label = document.createElement("label");
    label.textContent = field.label;
    label.htmlFor = inputId;
    const input = document.createElement("input");
    input.type = "text";
    input.id = inputId;
    input.name = field.id;
    input.value = value;
    input.required = (constraints.minLength ?? 0) > 0;
    input.maxLength = constraints.maxLength;
    if (constraints.pattern) input.pattern = constraints.pattern;
    if (input.required) {
        const required = document.createElement("span");
        required.className = "muted";
        required.textContent = " (required)";
        label.append(required);
    }
    root.replaceChildren(label, input);
    if (field.description) {
        label.title = field.description;
        const hint = document.createElement("p");
        hint.className = "settings-hint";
        hint.id = `${inputId}-hint`;
        hint.textContent = field.description;
        input.setAttribute("aria-describedby", hint.id);
        root.append(hint);
    }
    input.addEventListener("input", () => onChange(input.value));
}
