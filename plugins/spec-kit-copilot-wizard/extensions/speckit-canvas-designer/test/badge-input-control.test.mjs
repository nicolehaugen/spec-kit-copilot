import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBadgeInputControls, validateBadgeInputBinding,
    validateBadgeInputControl } from "../contracts/badge-input-control.mjs";

const entry = (kind, name, document) => ({ kind, name, sourceId: "fixture", document });
const rule = entry("generated.badge-rule-definition", "fixture-rule", {
    id: "fixture", inputs: [{ id: "phase", type: "phase" }],
});
const type = entry("designer.badges-settings-definition", "fixture-settings", {
    id: "fixture", rule: "fixture",
});
const control = entry("designer.badge-input-control", "fixture-control", {
    schemaVersion: 1, id: "fixture.input", adapter: "fixture-adapter", inputTypes: ["phase"],
});
const binding = entry("designer.badge-input-binding", "fixture-binding", {
    schemaVersion: 1, id: "fixture", rule: "fixture", control: "fixture.input",
});
const adapter = entry("designer.badge-input-adapter", "fixture-adapter");

test("Designer control registry binds a rule to its declared input types", () => {
    validateBadgeInputControl(control.document, control.name);
    validateBadgeInputBinding(binding.document, binding.name);
    assert.deepEqual(resolveBadgeInputControls([control, binding, adapter], [type], [rule]), [{
        rule: "fixture", control: "fixture.input", adapter: "fixture-adapter",
        binding: "fixture-binding", definition: "fixture-control", sourceId: "fixture",
    }]);
});

test("Designer badge controls fail explicitly on missing, duplicate, and incompatible links", () => {
    assert.throws(() => resolveBadgeInputControls([binding, adapter], [type], [rule]),
        /missing Designer badge input control fixture.input/);
    assert.throws(() => resolveBadgeInputControls([control, binding], [type], [rule]),
        /missing Designer badge input adapter fixture-adapter/);
    assert.throws(() => resolveBadgeInputControls([control, adapter], [type], [rule]),
        /missing Designer badge input binding for fixture/);
    assert.throws(() => resolveBadgeInputControls([control, binding, adapter,
        { ...binding, name: "duplicate-binding" }], [type], [rule]),
    /duplicate badge rule\/control binding fixture/);
    assert.throws(() => resolveBadgeInputControls([{ ...control,
        document: { ...control.document, inputTypes: ["artifact"] } }, binding, adapter],
    [type], [rule]), /does not support fixture.phase/);
    assert.throws(() => validateBadgeInputBinding({ ...binding.document, id: "other" },
        "fixture-binding"), /invalid Designer badge rule\/control binding/);
});
