// Shared safe Markdown rendering and visible clarification-marker presentation.
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
})[character]);

// Matches the Wizard's parseClarifications: markers are found in the raw text before
// Markdown rendering, so markers that wrap across lines or list items still get a control.
const clarificationMarker = /\[NEEDS CLARIFICATION:\s*([\s\S]*?)\]/gi;

export function renderMarkdown(source, { clarifications } = {}) {
    let text = String(source ?? "").replace(/\r\n?/g, "\n");
    let placeholderPrefix = "\uE000";
    while (text.includes(placeholderPrefix)) placeholderPrefix += "\uE000";
    const placeholder = new RegExp(`${placeholderPrefix}(\\d+)\uE001`, "g");
    const controls = [];
    if (clarifications) {
        text = text.replace(clarificationMarker, (match, question, startIdx) => {
            const index = clarifications.push({ question: question.trim(), marker: match, startIdx,
                endIdx: startIdx + match.length }) - 1;
            controls.push(`<button type="button" class="clarify-pill" data-clarify-idx="${index}" aria-label="Clarify: ${esc(question.trim())}">Clarify</button>`);
            return `${placeholderPrefix}${controls.length - 1}\uE001`;
        });
    }
    const lines = text.split("\n");
    const fenceStart = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
    const closingFor = (fence) => new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}\\s*$`);
    let commentOpen = false, fenceEnd = null;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        if (fenceEnd) {
            if (fenceEnd.test(line)) fenceEnd = null;
            continue;
        }
        const opening = !commentOpen && fenceStart.exec(line);
        if (opening) {
            fenceEnd = closingFor(opening[1]);
            continue;
        }
        let visible = "", cursor = 0;
        while (cursor < line.length) {
            const marker = line.indexOf(commentOpen ? "-->" : "<!--", cursor);
            if (marker < 0) {
                visible += commentOpen ? " " : line.slice(cursor);
                break;
            }
            visible += commentOpen ? " " : `${line.slice(cursor, marker)} `;
            cursor = marker + (commentOpen ? 3 : 4);
            commentOpen = !commentOpen;
        }
        lines[lineIndex] = visible;
        const uncovered = !commentOpen && fenceStart.exec(visible);
        if (uncovered) fenceEnd = closingFor(uncovered[1]);
    }
    const html = [];
    let index = 0;

    const emphasis = (text) => {
        let rendered = esc(text);
        rendered = rendered.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
        rendered = rendered.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
        rendered = rendered.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
        rendered = rendered.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
        return rendered;
    };
    const inline = (text) => {
        let result = "", cursor = 0;
        const tokens = /(`+)([\s\S]*?)\1|\[((?:[^\[\]\n]|\[[^\]\n]*\])+)\]\(([^)\s]+)\)/g;
        for (const token of text.matchAll(tokens)) {
            result += emphasis(text.slice(cursor, token.index));
            if (token[1]) result += `<code>${esc(token[2])}</code>`;
            else {
                const href = /^(https?:|mailto:|#)/i.test(token[4]) ? esc(token[4]) : "#";
                result += `<a href="${href}" target="_blank" rel="noopener noreferrer">${emphasis(token[3])}</a>`;
            }
            cursor = token.index + token[0].length;
        }
        return result + emphasis(text.slice(cursor));
    };

    const renderList = (tag, items) => {
        html.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`);
    };

    while (index < lines.length) {
        const line = lines[index];
        const fence = fenceStart.exec(line);
        if (fence) {
            const language = fence[2].trim();
            const closing = closingFor(fence[1]);
            const body = [];
            index += 1;
            while (index < lines.length && !closing.test(lines[index])) body.push(lines[index++]);
            if (index < lines.length) index += 1;
            const className = language ? ` class="language-${esc(language)}"` : "";
            html.push(`<pre><code${className}>${esc(body.join("\n"))}</code></pre>`);
            continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            const level = heading[1].length;
            html.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
            index += 1;
            continue;
        }
        if (/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
            html.push("<hr />");
            index += 1;
            continue;
        }
        if (/^>\s?/.test(line)) {
            const quote = [];
            while (index < lines.length && /^>\s?/.test(lines[index])) {
                quote.push(lines[index++].replace(/^>\s?/, ""));
            }
            html.push(`<blockquote>${inline(quote.join("\n"))}</blockquote>`);
            continue;
        }
        if (/^\s*[-*+]\s+/.test(line)) {
            const items = [];
            while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
                items.push(lines[index++].replace(/^\s*[-*+]\s+/, ""));
            }
            renderList("ul", items);
            continue;
        }
        if (/^\s*\d+\.\s+/.test(line)) {
            const items = [];
            while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
                items.push(lines[index++].replace(/^\s*\d+\.\s+/, ""));
            }
            renderList("ol", items);
            continue;
        }
        if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-+:?(\s*\|\s*:?-+:?)+\|?\s*$/.test(lines[index + 1] ?? "")) {
            const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
            const headers = cells(line);
            const rows = [];
            index += 2;
            while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) rows.push(cells(lines[index++]));
            html.push(`<table><thead><tr>${headers.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
            continue;
        }
        if (/^\s*$/.test(line)) {
            index += 1;
            continue;
        }
        const paragraph = [];
        while (
            index < lines.length
            && !/^\s*$/.test(lines[index])
            && !/^(#{1,6})\s+/.test(lines[index])
            && !/^\s{0,3}(?:`{3,}|~{3,})/.test(lines[index])
            && !/^\s*[-*+]\s+/.test(lines[index])
            && !/^\s*\d+\.\s+/.test(lines[index])
            && !/^>\s?/.test(lines[index])
            && !/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/.test(lines[index])
        ) {
            paragraph.push(lines[index++]);
        }
        html.push(`<p>${inline(paragraph.join("\n"))}</p>`);
    }
    return html.join("\n").replace(placeholder, (_, index) => controls[Number(index)] ?? "");
}
