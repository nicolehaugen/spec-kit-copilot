export const controlId = "stock.image";
export const valueContract = { type: "image", maxBytes: 32768,
    mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] };

export function mount({ root, field, value }) {
    if (!root || !field?.id || typeof value?.src !== "string"
        || typeof value.alt !== "string" || typeof value.className !== "string") {
        throw new Error("Invalid packaged image presentation");
    }
    const image = document.createElement("img");
    image.src = value.src;
    image.alt = value.alt;
    image.className = value.className;
    root.replaceChildren(image);
}
