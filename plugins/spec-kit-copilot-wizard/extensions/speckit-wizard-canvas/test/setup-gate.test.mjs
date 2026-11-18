import assert from "node:assert/strict";
import test from "node:test";
import { isSetupComplete } from "../ui/setup.js";
import { state } from "../ui/state.js";

function prepareSetup(t) {
    const previousSnapshot = state.snapshot;
    const previousRunning = state.setupRowRunning;
    t.after(() => {
        state.snapshot = previousSnapshot;
        state.setupRowRunning = previousRunning;
    });
    state.setupRowRunning = null;
    state.snapshot = {
        environment: { pluginInstalled: true, cliInstalled: true },
        projectInitialized: true,
        setup: { skillsReloaded: false },
    };
}

test("successful live reload unlocks setup with a false saved flag", t => {
    prepareSetup(t);
    state.snapshot.skillsReload = { ok: true };
    assert.equal(isSetupComplete(), true);
    assert.equal(state.snapshot.setup.skillsReloaded, false);
});

test("failed, absent, or non-boolean live reload stays locked without saved completion", t => {
    prepareSetup(t);
    for (const result of [undefined, { ok: false }, {}, { ok: "true" }]) {
        state.snapshot.skillsReload = result;
        assert.equal(isSetupComplete(), false, JSON.stringify(result));
    }
});

test("saved completion unlocks setup without a live reload result", t => {
    prepareSetup(t);
    state.snapshot.setup.skillsReloaded = true;
    assert.equal(isSetupComplete(), true);
});

test("reload completion does not bypass prerequisites or a running setup step", t => {
    prepareSetup(t);
    for (const savedCompletion of [false, true]) {
        state.snapshot.setup.skillsReloaded = savedCompletion;
        state.snapshot.skillsReload = savedCompletion ? undefined : { ok: true };
        for (const prerequisite of ["pluginInstalled", "cliInstalled", "projectInitialized"]) {
            const target = prerequisite === "projectInitialized"
                ? state.snapshot : state.snapshot.environment;
            target[prerequisite] = false;
            assert.equal(isSetupComplete(), false, `missing ${prerequisite}`);
            target[prerequisite] = true;
        }
        for (const step of ["init", "reload", "installDefaults"]) {
            state.setupRowRunning = step;
            assert.equal(isSetupComplete(), false, `running ${step}`);
        }
        state.setupRowRunning = null;
        assert.equal(isSetupComplete(), true);
    }
});
