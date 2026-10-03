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
    input.required = constraints.required === true || (constraints.minLength ?? 0) > 0;
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
    if (constraints.required) {
        const error = document.createElement("p");
        error.id = `${inputId}-error`;
        error.className = "settings-field-error";
        error.setAttribute("role", "alert");
        error.textContent = `Enter a nonblank ${field.label}.`;
        error.hidden = true;
        const describedBy = input.getAttribute("aria-describedby");
        input.setAttribute("aria-describedby", [describedBy, error.id].filter(Boolean).join(" "));
        root.append(error);
        let touched = context.showValidationError === true;
        const validate = () => {
            const invalid = !input.value.trim();
            error.hidden = !touched || !invalid;
            if (error.hidden) input.removeAttribute("aria-invalid");
            else input.setAttribute("aria-invalid", "true");
        };
        input.addEventListener("blur", () => { touched = true; validate(); });
        input.addEventListener("input", validate);
        validate();
    }
    input.addEventListener("input", () => onChange(input.value));
}
