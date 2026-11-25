import assert from "node:assert/strict";
import { test } from "node:test";
import { specKitSkillReloadErrors } from "../contracts/skill-reload.mjs";
import { runSkillsReload } from "../server/handlers-ops.mjs";

const speckit = "Failed to load skill 'C:\\repo\\.github\\skills\\speckit-plan\\SKILL.md': bad YAML";
const unrelated = "Failed to load skill 'C:\\speckit-work\\repo\\.claude\\skills\\playtest-jobs\\SKILL.md': bad YAML";

test("only reload errors naming a Spec Kit skill are blocking", () => {
    assert.deepEqual(specKitSkillReloadErrors([speckit, unrelated, "Failed to load skills", 7]), [speckit]);
    assert.deepEqual(specKitSkillReloadErrors(["Skill speckit-bug-report: invalid frontmatter"]),
        ["Skill speckit-bug-report: invalid frontmatter"]);
    assert.deepEqual(specKitSkillReloadErrors([
        "Failed to load skill '.claude/skills/custom/SKILL.md': references speckit-plan",
    ]), []);
    assert.deepEqual(specKitSkillReloadErrors(undefined), []);
});

test("Wizard setup reload succeeds despite errors in unrelated skills", async () => {
    const reload = async (errors) => {
        const inst = { state: {} };
        const result = await runSkillsReload({ getInstance: () => inst,
            session: { rpc: { skills: { reload: async () => ({ errors, warnings: [] }) } } } });
        return { result, inst };
    };
    const passed = await reload([unrelated]);
    assert.equal(passed.result.ok, true);
    assert.equal(passed.result.errors, 1);
    assert.equal(passed.inst.skillsReload.ok, true);
    const failed = await reload([unrelated, speckit]);
    assert.equal(failed.result.ok, false);
    assert.equal(failed.result.errors, 2);
});
