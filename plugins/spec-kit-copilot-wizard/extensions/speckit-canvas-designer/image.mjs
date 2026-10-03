export const IMAGE_TYPES = {
    "image/png": { extension: "png", signature: [137, 80, 78, 71, 13, 10, 26, 10] },
    "image/jpeg": { extension: "jpg", signature: [255, 216, 255] },
    "image/gif": { extension: "gif", signature: [71, 73, 70, 56] },
    "image/webp": { extension: "webp", signature: [82, 73, 70, 70] },
};

export function decodeImage(value, maxBytes = 32 * 1024) {
    if (value === "") return null;
    const match = typeof value === "string"
        && /^data:(image\/(?:png|jpeg|gif|webp));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(value);
    if (!match || match[2].length > Math.ceil(maxBytes / 3) * 4) {
        throw new Error("Invalid Designer image: expected a PNG, JPEG, GIF, or WebP under 32 KiB");
    }
    const bytes = Buffer.from(match[2], "base64");
    const type = IMAGE_TYPES[match[1]];
    if (!bytes.length || bytes.length > maxBytes || bytes.toString("base64") !== match[2]
        || !type.signature.every((part, index) => bytes[index] === part)
        || (match[1] === "image/png" && (bytes.length < 24
            || bytes.toString("ascii", 12, 16) !== "IHDR"))
        || (match[1] === "image/jpeg" && (bytes.length < 5
            || bytes.at(-2) !== 255 || bytes.at(-1) !== 217))
        || (match[1] === "image/gif" && (bytes.length < 14
            || !["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))))
        || (match[1] === "image/webp" && (bytes.length < 16
            || bytes.toString("ascii", 8, 12) !== "WEBP"
            || bytes.readUInt32LE(4) + 8 !== bytes.length))) {
        throw new Error("Invalid Designer image: image bytes do not match their declared format");
    }
    return { mime: match[1], extension: type.extension, bytes };
}
