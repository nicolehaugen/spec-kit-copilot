export const controlId = "stock.image";
export const valueContract = {
    type: "image",
    maxBytes: 32768,
    mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
};

export function mount({ root, field, value, context, onChange }) {
    const { constraints, inputId, validateImage, setBusy } = context ?? {};
    if (!root || typeof root.replaceChildren !== "function"
        || !field || typeof field.label !== "string"
        || typeof value !== "string" || typeof inputId !== "string" || !inputId
        || constraints?.maxBytes !== valueContract.maxBytes
        || JSON.stringify(constraints.mimeTypes) !== JSON.stringify(valueContract.mimeTypes)
        || typeof onChange !== "function" || typeof validateImage !== "function"
        || typeof setBusy !== "function") {
        throw new Error("Invalid Designer image control or value");
    }
    const element = (tag, text, className) => {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    };
    const label = element("label", field.label);
    const input = element("input");
    input.type = "file";
    input.accept = valueContract.mimeTypes.join(",");
    input.id = inputId;
    label.htmlFor = input.id;
    const uploadError = element("p", undefined, "settings-image-error");
    uploadError.id = `${input.id}-error`;
    uploadError.setAttribute("role", "alert");
    uploadError.hidden = true;
    input.setAttribute("aria-describedby", uploadError.id);
    const setUploadError = (message) => {
        uploadError.textContent = message;
        uploadError.hidden = !message;
        if (message) input.setAttribute("aria-invalid", "true");
        else input.removeAttribute("aria-invalid");
    };
    const preview = element("img");
    preview.alt = `${field.label} preview`;
    const controls = element("div", undefined, "image-controls");
    const remove = element("button", "Remove", "image-remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${field.label} image`);
    let request = 0;
    const refresh = () => {
        const selected = !!value;
        preview.hidden = !selected;
        if (selected) preview.src = value;
        else preview.removeAttribute("src");
        remove.hidden = !selected;
    };
    input.addEventListener("change", async () => {
        if (input.disabled) return;
        const file = input.files?.[0];
        if (!file) return;
        if (!valueContract.mimeTypes.includes(file.type)
            || !file.size || file.size > constraints.maxBytes) {
            input.value = "";
            setUploadError(file.size > constraints.maxBytes
                ? `${field.label} is too large (${file.size.toLocaleString()} bytes). Maximum: ${constraints.maxBytes.toLocaleString()} bytes (32 KiB).`
                : `${field.label} must be a nonempty PNG, JPEG, GIF, or WebP image.`);
            return;
        }
        const current = ++request;
        input.disabled = true;
        remove.disabled = true;
        setBusy(true);
        setUploadError("");
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const content = `data:${file.type};base64,${btoa(
                Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))}`;
            if (!validateImage(content)) throw new Error("Image bytes do not match the selected format.");
            await new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = resolve;
                image.onerror = () => reject(new Error("Image cannot be displayed."));
                image.src = content;
            });
            if (current !== request || !root.isConnected) return;
            onChange(content);
            value = content;
            refresh();
        } catch (error) {
            if (current === request && root.isConnected) {
                setUploadError(`Could not load ${field.label}: ${error.message}`);
            }
        } finally {
            if (current === request) {
                input.value = "";
                input.disabled = false;
                remove.disabled = false;
                setBusy(false);
            }
        }
    });
    remove.addEventListener("click", () => {
        onChange("");
        value = "";
        refresh();
        setUploadError("");
    });
    controls.append(input, remove);
    root.classList.add("settings-image-content");
    root.replaceChildren(label, preview, controls, uploadError);
    if (field.description) root.append(element("p", field.description, "settings-hint"));
    refresh();
}
