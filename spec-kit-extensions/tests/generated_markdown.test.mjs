import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../extension-canvas-design/generated-scaffold/ui/markdown.mjs";

test("generated artifact markers display escaped questions next to clarification controls", () => {
    const clarifications = [];
    const html = renderMarkdown("# Questions\n\n[NEEDS CLARIFICATION: Which <scope> & \"tests\"?]\n\n"
        + "| Item | Decision |\n| --- | --- |\n| Scope | [needs clarification: Which tests?] |",
    { clarifications });
    assert.deepEqual(clarifications.map(({ question }) => question), ["Which <scope> & \"tests\"?", "Which tests?"]);
    assert.doesNotMatch(html, /NEEDS CLARIFICATION/i);
    assert.match(html, /<mark class="clarify-marker">Which &lt;scope&gt; &amp; &quot;tests&quot;\?<\/mark> <button/);
    assert.match(html, /aria-label="Clarify: Which &lt;scope&gt; &amp; &quot;tests&quot;\?"/);
    assert.match(html, /<mark class="clarify-marker">Which tests\?<\/mark> <button/);
    assert.equal((html.match(/class="clarify-pill"/g) ?? []).length, 2);
    assert.match(html, /data-clarify-idx="1"/);
});

test("generated artifact markers wrapped across list lines keep one clarification control", () => {
    const clarifications = [];
    const html = renderMarkdown("## Open Questions\r\n\r\n- [NEEDS CLARIFICATION: Which wording?\r\n"
        + "  It wraps.\r\n  Done.]\r\n- Next item", { clarifications });
    assert.deepEqual(clarifications.map(({ question }) => question), ["Which wording?\n  It wraps.\n  Done."]);
    assert.equal((html.match(/class="clarify-pill"/g) ?? []).length, 1);
    assert.match(html, /<li><mark class="clarify-marker">Which wording\?\n  It wraps\.\n  Done\.<\/mark> <button type="button" class="clarify-pill" data-clarify-idx="0"[^>]*>Clarify<\/button><\/li>/);
    assert.doesNotMatch(html, /NEEDS CLARIFICATION/i);
    assert.match(html, /<li>Next item<\/li>/);
});

test("generated artifact markers are detected like the Wizard, before Markdown rendering", () => {
    const clarifications = [];
    const html = renderMarkdown("`[NEEDS CLARIFICATION: Inline example]`\n\n"
        + "```\n[NEEDS CLARIFICATION: Fenced example]\n```\n\n"
        + "\uE0000\uE001 [NEEDS CLARIFICATION: Visible question]",
    { clarifications });
    assert.deepEqual(clarifications.map(({ question }) => question),
        ["Inline example", "Fenced example", "Visible question"]);
    assert.equal((html.match(/class="clarify-pill"/g) ?? []).length, 3);
    assert.ok(html.includes("\uE0000\uE001"));
});

test("generated artifact rendering without a clarification collector leaves markers as text", () => {
    const html = renderMarkdown("\uE0000\uE001 [NEEDS CLARIFICATION: Which scope?]");
    assert.doesNotMatch(html, /clarify-pill/);
    assert.match(html, /\[NEEDS CLARIFICATION: Which scope\?\]/);
    assert.ok(html.includes("\uE0000\uE001"));
});
