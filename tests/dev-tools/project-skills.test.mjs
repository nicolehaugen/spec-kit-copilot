import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { repositoryRoot } from './fixture-files.mjs';

test('project development skill frontmatter matches its directory', async () => {
  const names = [
    'dev-tools-speckit-wizard-installed-refresh',
    'dev-tools-speckit-wizard-installed-open',
    'dev-tools-speckit-wizard-local-generate-launch',
    'dev-tools-speckit-distribution',
  ];
  for (const name of names) {
    const text = await readFile(resolve(repositoryRoot, '.github', 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`));
    assert.match(text, /description:.*USE FOR:.*DO NOT USE FOR:/);
    assert.match(text, /argument-hint:/);
  }
});
