export function mountPageAssets(content, slots, assets, token) {
    const rendered = new Set();
    for (const target of content.querySelectorAll("[data-asset-slot]")) {
        const slotId = target.dataset.assetSlot;
        if (!slots.some((slot) => slot.id === slotId && slot.accepts.includes("asset"))
            || rendered.has(slotId)) {
            throw new Error(`Unknown or duplicate generated asset slot: ${slotId}`);
        }
        rendered.add(slotId);
        const asset = assets.find((item) => item.slot === slotId);
        if (!asset) continue;
        const image = document.createElement("img");
        image.className = "generated-image";
        image.alt = asset.label;
        image.src = `/assets/${encodeURIComponent(asset.file)}?token=${encodeURIComponent(token)}`;
        target.replaceChildren(image);
    }
    for (const asset of assets) {
        if (!rendered.has(asset.slot)) {
            throw new Error(`Generated page did not render asset slot ${asset.slot}`);
        }
    }
}
