import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { repositoryRoot } from './fixture-files.mjs';

const names = ['speckit-wizard-installed-refresh', 'speckit-wizard-installed-open', 'speckit-wizard-local-generate-launch', 'speckit-distribution'];
const readSkill = name => readFile(resolve(repositoryRoot, '.github', 'skills', name, 'SKILL.md'), 'utf8');

test('canonical project skill names/frontmatter are discoverable; no old launcher compatibility duplicate', async () => {
  const ignores = await readFile(resolve(repositoryRoot, '.gitignore'), 'utf8');
  for (const name of names) {
    const text = await readSkill(name);
    assert.match(text, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`));
    assert.match(text, /description:.*USE FOR:.*DO NOT USE FOR:/);
    assert.match(text, /argument-hint:/);
    assert.ok(ignores.includes(`!.github/skills/${name}/`), `Project skill must not be ignored: ${name}`);
  }
  assert.ok(!(await readdir(resolve(repositoryRoot, '.github', 'skills'))).includes('speckit-wizard-local-generate'));
  assert.ok(!(await readdir(resolve(repositoryRoot, 'skills'))).includes('speckit-distribution'));
});

test('refresh retains paired-provider inventory, backup, identity, dependency and configuration checks', async () => {
  const text = await readSkill(names[0]);
  for (const fragment of ['configure-runtime.mjs show', '--apply --expect', 'handlers-designer.mjs',
    'handoff.mjs', 'node_modules', 'robocopy /MIR', 'symlinks', 'Hash-verify', 'extensions_reload',
    'SPECKIT_CONFIG_FILE', 'Only when requested', 'personal skill copies']) assert.ok(text.includes(fragment), fragment);
});

test('installed opening verifies persisted disabled entries and preserves default/focus flags', async () => {
  const text = await readSkill(names[1]);
  for (const fragment of ['extensions.disabledExtensions', 'plugin:spec-kit-copilot-wizard:speckit-wizard-canvas',
    'plugin:spec-kit-copilot-wizard:speckit-canvas-designer', 'JSON-aware edit', 'list_canvas_capabilities',
    'omit `generateCanvas`', '"generateCanvas": true', 'Focus-only reopening', 'Never enable unknown',
    'featureFlags.generateCanvas', '/api/state', 'never print token-bearing URLs']) assert.ok(text.includes(fragment), fragment);
});

test('launcher delegates only refresh/open and includes both packages without unattended generation', async () => {
  const text = await readSkill(names[2]);
  for (const fragment of [names[0], names[1], 'input.generateCanvas: true',
    'spec-kit-extensions\\extension-canvas-design', 'spec-kit-presets\\copilot-vertical-phase-control',
    'Do not invoke phases or submit Generate', 'actual child installation', 'symlinked Specify']) assert.ok(text.includes(fragment), fragment);
});

test('distribution skill separates prepare, release and actual hosted verification with explicit gates', async () => {
  const text = await readSkill(names[3]);
  for (const fragment of ['## Prepare', '## Release', '## Verify-install', 'prepare-distribution.mjs',
    '--apply --expect', 'GITHUB_REPOSITORY', 'Release Extension Trigger', 'Release Preset Trigger',
    'speckit-extension', 'speckit-preset', 'published archives selected by', 'No automatic workflow mutation',
    'does not change runtime settings, commit, push, tag, publish, or bump versions']) assert.ok(text.includes(fragment), fragment);
});

test('preset publisher invokes tested validation before ZIP creation and keeps existing tag guards', async () => {
  const workflow = await readFile(resolve(repositoryRoot, '.github', 'workflows', 'release-preset.yml'), 'utf8');
  assert.ok(workflow.indexOf('node scripts/validate-preset-catalog.mjs') < workflow.indexOf('- name: Create preset zip'));
  assert.match(workflow, /refusing to move it/);
  assert.match(workflow, /--verify-tag/);
});
