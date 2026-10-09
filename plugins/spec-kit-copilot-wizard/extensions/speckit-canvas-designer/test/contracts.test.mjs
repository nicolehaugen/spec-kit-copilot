import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeGenerationRequest, validateGenerateSubmission } from "../contracts/generation-request.mjs";
import { validateGenerationRequestIntegrity } from "../../../../../spec-kit-extensions/extension-canvas-design/scripts/contracts/generation-request.mjs";
import { normalizeObservedVersions } from "../contracts/specify-inventory.mjs";
import { validateSaveRequest, validateSavedSettings } from "../contracts/designer-settings.mjs";
import { designerOpenInputSchema, validateDesignerOpenInput } from "../contracts/host-open.mjs";
import { checkSchema } from "../contracts/design-contributions.mjs";
import { validateDesignerAdapterExports } from "../contracts/control-adapter.mjs";

test("independently packaged generator accepts the exact Designer request and rejects tampering", () => {
    const request = { schemaVersion: 1, handoffId: "handoff-1", requestId: "request-1",
        values: { "canvas.id": "sample" }, badges: [{ id: "ready" }] };
    const serialized = serializeGenerationRequest(request);
    assert.equal(serialized, JSON.stringify(request));
    assert.doesNotThrow(() => validateGenerationRequestIntegrity(JSON.parse(serialized),
        "handoff-1", "request-1"));
    assert.throws(() => validateGenerationRequestIntegrity({ ...request,
        badges: [{ id: "other" }] }, "handoff-1", "request-1"), /integrity mismatch/);
    assert.throws(() => validateGenerationRequestIntegrity(request,
        "other-handoff", "request-1"), /integrity mismatch/);
});

test("Designer settings preserve the saved revision and exact-key contract", () => {
    const model = { revision: "pages-1", constraints: { "canvas.id": { type: "string" } } };
    const record = { schemaVersion: 1, handoffId: "handoff-1", modelRevision: "pages-1",
        revision: 1, values: { "canvas.id": "sample" } };
    assert.doesNotThrow(() => validateSavedSettings(record, { handoffId: "handoff-1" }, model));
    assert.doesNotThrow(() => validateSaveRequest({ revision: 1, modelRevision: "pages-1",
        values: record.values, badges: [] }, model));
    assert.doesNotThrow(() => validateSavedSettings({ ...record, badges: [] },
        { handoffId: "handoff-1" }, model));
    assert.throws(() => validateSavedSettings({ ...record, badges: [], extra: true },
        { handoffId: "handoff-1" }, model), /do not match/);
    assert.throws(() => validateSavedSettings({ ...record, revision: 0 },
        { handoffId: "handoff-1" }, model), /do not match/);
    assert.throws(() => validateSaveRequest({ revision: 1, modelRevision: "pages-1",
        values: record.values, extra: true }, model), /Invalid Designer save request/);
});

test("changed preset composition identifies affected badge dependencies without rewriting settings", () => {
    const badge = { id: "saved-one", type: "custom", inputs: { phase: "plan" } };
    const compatible = { id: "unaffected", type: "stable", inputs: { phase: "plan" } };
    const record = { schemaVersion: 1, handoffId: "handoff-1", modelRevision: "old",
        revision: 1, values: {}, badges: [badge, compatible] };
    const handoff = { handoffId: "handoff-1" };
    const model = { revision: "new", badgeTypes: [
        { id: "custom", rule: "custom", enabled: false },
        { id: "stable", rule: "stable", enabled: true },
    ], badgeRules: [{ id: "stable", inputs: [{ id: "phase" }], adapter: "stable-evaluator" }],
    badgeInputControls: [{ rule: "stable", control: "stable-control" }],
    templates: [{ kind: "generated.badge-rule-adapter", name: "stable-evaluator" }] };
    assert.throws(() => validateSavedSettings(record, handoff, model),
        (error) => /saved-one \(disabled type custom\)/.test(error.message)
            && !error.message.includes("unaffected"));
    model.badgeTypes[0].enabled = true;
    assert.throws(() => validateSavedSettings(record, handoff, model),
        /saved-one \(missing rule custom\)/);
    model.badgeRules.push({ id: "custom", inputs: [{ id: "artifact" }], adapter: "custom-evaluator" });
    model.badgeInputControls.push({ rule: "custom", control: "custom-control" });
    model.templates.push({ kind: "generated.badge-rule-adapter", name: "custom-evaluator" });
    assert.throws(() => validateSavedSettings(record, handoff, model),
        /saved-one \(changed inputs for rule custom\)/);
    model.badgeRules[1].inputs = [{ id: "phase" }];
    assert.throws(() => validateSavedSettings(record, handoff, model),
        (error) => /Saved Designer settings do not match/.test(error.message)
            && !error.message.includes("saved badges:"));
});

test("Designer handoff and generation contracts include badges without accepting unrelated fields", () => {
    assert.equal(designerOpenInputSchema.properties.preview.type, "boolean");
    for (const kind of ["designer.badges-settings-definition",
        "generated.badge-rule-definition", "generated.badge-rule-adapter"]) {
        assert.ok(designerOpenInputSchema.properties.templates.items.properties.kind.enum.includes(kind));
    }
    assert.deepEqual(validateDesignerOpenInput({ preview: true }),
        { preview: true, handoffId: undefined, pages: undefined, templates: undefined });
    assert.throws(() => validateDesignerOpenInput({ preview: true, handoffId: "handoff-1" }),
        /cannot include a Wizard handoff/);
    const model = { revision: "pages-1", templates: [] };
    const request = { modelRevision: model.revision, settingsRevision: 0,
        values: { "canvas.id": "sample" }, badges: [] };
    assert.equal(validateGenerateSubmission(request, model), request);
    assert.throws(() => validateGenerateSubmission({ ...request, extra: true }, model),
        /Invalid Designer generation request/);
    assert.throws(() => validateGenerateSubmission({ ...request, settingsRevision: -1 }, model),
        /Invalid Designer generation request/);
});

test("observed Specify versions reject duplicate relevant IDs and retain priority", () => {
    const item = { id: "runtime-ext", version: "1.2.3", priority: 30 };
    assert.deepEqual(normalizeObservedVersions(JSON.stringify([item]), "extensions",
        new Set(["runtime-ext"])), [item]);
    assert.throws(() => normalizeObservedVersions(JSON.stringify([item, item]),
        "extensions", new Set(["runtime-ext"])), /Invalid extensions package identity/);
});

test("contribution schema and Designer adapter reject invalid slots and mismatched values", () => {
    const slot = { type: "string", enum: ["essentials.options"] };
    assert.doesNotThrow(() => checkSchema("essentials.options", slot, "contribution.slot"));
    assert.throws(() => checkSchema("workflow.unknown", slot, "contribution.slot"),
        /unsupported value/);
    const control = { id: "risk-matrix", value: { type: "object", properties: {
        impact: ["low", "high"],
    } } };
    assert.doesNotThrow(() => validateDesignerAdapterExports({
        controlId: control.id, valueContract: control.value, validate: () => true,
    }, control));
    assert.throws(() => validateDesignerAdapterExports({
        controlId: control.id, valueContract: { type: "string" }, validate: () => true,
    }, control), /incompatible Designer adapter/);
});
