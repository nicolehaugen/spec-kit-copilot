import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyChanges, fingerprint, parseArgs, patchJson, preview, readOptional } from './configuration-files.mjs';

export const providerIds = Object.freeze([
  'plugin:spec-kit-copilot-wizard:speckit-wizard-canvas',
  'plugin:spec-kit-copilot-wizard:speckit-canvas-designer',
]);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function disabledEntries(text) {
  const settings = JSON.parse(text);
  if (!object(settings)) throw new Error('Copilot settings must be an object.');
  if (!Object.hasOwn(settings, 'extensions')) return [];
  if (!object(settings.extensions)) throw new Error('extensions must be an object.');
  if (!Object.hasOwn(settings.extensions, 'disabledExtensions')) return [];
  const entries = settings.extensions.disabledExtensions;
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string')) {
    throw new Error('extensions.disabledExtensions must be an array of strings.');
  }
  return entries;
}

export async function clearProviderDisables(options = {}, { home = homedir() } = {}) {
  if (options.expect && !options.apply) throw new Error('--expect requires --apply.');
  const path = resolve(options.file ?? resolve(home, '.copilot', 'settings.json'));
  const before = await readOptional(path);
  const entries = before === null ? [] : disabledEntries(before);
  const removedIds = providerIds.filter(id => entries.includes(id));
  const retainedEntries = entries.filter(id => !providerIds.includes(id));
  const after = before === null ? null : patchJson(before, removedIds.length
    ? [[['extensions', 'disabledExtensions'], retainedEntries]]
    : []);
  const changes = [{ path, before, after }];
  const result = {
    path, providerIds, removedIds,
    preview: before === after ? `Unchanged: ${path}` : preview([{
      path: `${path} (extensions.disabledExtensions)`,
      before: JSON.stringify(entries, null, 2), after: JSON.stringify(retainedEntries, null, 2),
    }]),
    expect: fingerprint(changes),
    changed: before !== after, applied: Boolean(options.apply),
  };
  if (options.apply) {
    result.backups = await applyChanges(changes, options.expect);
    const actual = await readOptional(path);
    if (actual !== after) {
      throw new Error(`Provider settings verification failed at ${path}; cleanup incomplete. Backups: ${result.backups.join(', ')}`);
    }
  }
  result.notice = options.apply
    ? 'Persisted disable entries checked; providers have NOT reloaded or been verified running. Reload and inspect both providers separately.'
    : 'Preview only; no settings or providers changed. Confirm this exact diff before --apply --expect.';
  result.notice += ' Avoid concurrent settings writes during apply: checks do not lock the final check-to-replacement window; an intervening save can be overwritten and backups predate it.';
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), ['file', 'expect']);
  if (options.help) {
    console.log('node dev-tools\\clear-provider-disables.mjs [--file PATH] [--apply --expect DIGEST]\nPreview is the default. Removes only the exact installed Wizard/Designer disable IDs. Backups are retained beside settings; absent files remain absent. Does not enable the plugin, reload providers, or open a canvas.');
    return;
  }
  console.log(JSON.stringify(await clearProviderDisables(options), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
