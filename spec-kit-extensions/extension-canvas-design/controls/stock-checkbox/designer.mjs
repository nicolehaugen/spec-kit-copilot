export const controlId = "stock.checkbox";
export const valueContract = { type: "boolean" };

export function mount({ root, field, value, context, onChange }) {
    const { constraints, inputId } = context ?? {};
    if (!root || typeof root.replaceChildren !== "function"
        || !field?.id || typeof field.label !== "string"
        || typeof value !== "boolean" || typeof onChange !== "function"
        || typeof inputId !== "string" || !inputId || constraints?.type !== "boolean") {
        throw new Error("Invalid Designer checkbox control or value");
    }
    const label = document.createElement("label");
    label.textContent = field.label;
    label.htmlFor = inputId;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = inputId;
    input.name = field.id;
    input.checked = value;
    if (field.description) {
        label.title = field.description;
        input.setAttribute("aria-description", field.description);
    }
    input.addEventListener("input", () => onChange(input.checked));
    root.replaceChildren(input, label);
}
