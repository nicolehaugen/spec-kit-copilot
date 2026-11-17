import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../extension-canvas-design/generated-scaffold/ui/markdown.mjs";

test("generated artifact markers collect questions and render safe clarification controls", () => {
    const clarifications = [];
    const html = renderMarkdown("# Questions\n\n[NEEDS CLARIFICATION: Which <scope>?]\n\n"
        + "| Item | Decision |\n| --- | --- |\n| Scope | [**needs clarification**: Which tests?] |",
    { clarifications });
    assert.deepEqual(clarifications.map(({ question }) => question), ["Which <scope>?", "Which tests?"]);
    assert.match(html, /Which &lt;scope&gt;\?/);
    assert.equal((html.match(/class="clarify-pill"/g) ?? []).length, 2);
    assert.match(html, /data-clarify-idx="1"/);
});

test("generated artifact examples and hidden markers never become clarification controls", () => {
    const clarifications = [];
    const html = renderMarkdown("`[NEEDS CLARIFICATION: Inline example]`\n\n"
        + "```\n[NEEDS CLARIFICATION: Fenced example]\n```\n\n"
        + "[[NEEDS CLARIFICATION: Link example]](https://example.com)\n\n"
        + "<!-- [NEEDS CLARIFICATION: Hidden question] -->\n\n"
        + "[NEEDS CLARIFICATION: Visible question]",
    { clarifications });
    assert.deepEqual(clarifications.map(({ question }) => question), ["Visible question"]);
    assert.equal((html.match(/class="clarify-pill"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /Hidden question/);
});
