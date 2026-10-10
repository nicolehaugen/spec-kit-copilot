import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { clearProviderDisables, providerIds } from '../../dev-tools/clear-provider-disables.mjs';
import { readJson, repositoryRoot, workspace, write } from './fixture-files.mjs';

test('preview/apply removes only exact provider IDs, backs up bytes, and preserves unrelated content', async t => {
  const home = await workspace(t);
  const file = resolve(home, '.copilot', 'settings.json');
  const entries = ['personal:keep', providerIds[0], `${providerIds[0]}-other`,
    providerIds[1], providerIds[0], 'plugin:other:speckit-canvas-designer'];
  const before = `{\r\n  "unrelated": { "value" : 1 },\r\n  "extensions": {\r\n    "keep": true,\r\n    "disabledExtensions": ${JSON.stringify(entries)}\r\n  }\r\n}\r\n`;
  await write(file, before);
  const preview = await clearProviderDisables({}, { home });
  assert.equal(preview.path, file);
  assert.equal(preview.changed, true);
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.removedIds, providerIds);
  assert.match(preview.preview, /extensions\.disabledExtensions/);
  assert.doesNotMatch(preview.preview, /unrelated|"value"|"keep"/);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.deepEqual(await readdir(resolve(home, '.copilot')), ['settings.json']);
  const after = before.replace(JSON.stringify(entries), JSON.stringify([
    'personal:keep', `${providerIds[0]}-other`, 'plugin:other:speckit-canvas-designer',
  ]));
  const applied = await clearProviderDisables({ apply: true, expect: preview.expect }, { home });
  assert.equal(applied.backups.length, 1);
  assert.equal(await readFile(applied.backups[0], 'utf8'), before);
  assert.equal(await readFile(file, 'utf8'), after);
  assert.match(applied.notice, /NOT reloaded/);
  const repeat = await clearProviderDisables({}, { home });
  assert.equal(repeat.changed, false);
  const repeated = await clearProviderDisables({ apply: true, expect: repeat.expect }, { home });
  assert.deepEqual(repeated.backups, []);
  assert.equal(await readFile(file, 'utf8'), after);
});

test('missing files and disable properties remain absent without backups', async t => {
  const home = await workspace(t);
  const file = resolve(home, 'settings.json');
  for (const value of [null, {}, { extensions: {} }, { extensions: { disabledExtensions: [] } }]) {
    if (value !== null) await write(file, value);
    const before = value === null ? null : await readFile(file, 'utf8');
    const preview = await clearProviderDisables({ file });
    assert.equal(preview.changed, false);
    const applied = await clearProviderDisables({ file, apply: true, expect: preview.expect });
    assert.deepEqual(applied.backups, []);
    if (value === null) assert.deepEqual(await readdir(home), []);
    else assert.equal(await readFile(file, 'utf8'), before);
  }
});

test('missing digest and concurrent settings changes are rejected without overwrites or backups', async t => {
  const home = await workspace(t);
  const file = resolve(home, 'settings.json');
  await write(file, { extensions: { disabledExtensions: providerIds } });
  const preview = await clearProviderDisables({ file });
  await assert.rejects(clearProviderDisables({ file, apply: true }), /Conflict/);
  const changed = { extensions: { disabledExtensions: [...providerIds, 'personal:new'] } };
  await write(file, changed);
  await assert.rejects(clearProviderDisables({ file, apply: true, expect: preview.expect }), /Conflict/);
  assert.deepEqual(await readJson(file), changed);
  assert.deepEqual(await readdir(home), ['settings.json']);
});

test('malformed JSON, incompatible shapes and duplicate fields fail before mutation', async t => {
  const home = await workspace(t);
  const file = resolve(home, 'settings.json');
  for (const before of [
    '{', 'null', '[]', '{"extensions":null}', '{"extensions":[]}',
    '{"extensions":{"disabledExtensions":null}}',
    '{"extensions":{"disabledExtensions":[1]}}',
    '{"extensions":{"disabledExtensions":"all"}}',
    '{"extensions":{},"extensions":{}}',
    '{"extensions":{"disabledExtensions":[],"disabledExtensions":[]}}',
  ]) {
    await write(file, before);
    await assert.rejects(clearProviderDisables({ file }));
    assert.equal(await readFile(file, 'utf8'), before);
    assert.deepEqual(await readdir(home), ['settings.json']);
  }
});

test('directory targets and linked ancestors fail without modifying the linked settings', async t => {
  const home = await workspace(t);
  await assert.rejects(clearProviderDisables({ file: home }), /Expected a regular file/);
  const target = resolve(home, 'target');
  const file = resolve(target, 'settings.json');
  await write(file, { extensions: { disabledExtensions: providerIds } });
  const link = resolve(home, 'linked');
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(clearProviderDisables({ file: resolve(link, 'settings.json') }), /symlink or junction/);
  assert.deepEqual((await readJson(file)).extensions.disabledExtensions, providerIds);
  assert.deepEqual(await readdir(target), ['settings.json']);
});

test('CLI help is read-only and unknown options and unconfirmed apply fail', async t => {
  const home = await workspace(t);
  const script = resolve(repositoryRoot, 'dev-tools', 'clear-provider-disables.mjs');
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const file = resolve(home, 'settings.json');
  await write(file, { extensions: { disabledExtensions: providerIds } });
  const before = await readFile(file, 'utf8');
  assert.equal(run(['--help']).status, 0);
  assert.equal(run(['--file', file]).status, 0);
  for (const args of [
    ['--file', file, '--apply'], ['--ids', 'all'], ['--expect', 'digest'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.notEqual(result.stderr.trim(), '');
  }
  assert.equal(await readFile(file, 'utf8'), before);
  assert.deepEqual(await readdir(home), ['settings.json']);
});
