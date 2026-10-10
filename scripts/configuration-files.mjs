import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export function parseArgs(args, valued, switches = ['apply', 'help']) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || (!valued.includes(name) && !switches.includes(name)) || name in result) {
      throw new Error(`Unknown or repeated argument: ${args[i]}`);
    }
    if (switches.includes(name)) result[name] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for --${name}`);
      result[name] = args[++i];
    }
  }
  return result;
}

export async function assertRegularPath(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symlink or junction: ${current}`);
      if (current === resolve(path) && !stat.isFile()) throw new Error(`Expected a regular file: ${current}`);
      if (current !== resolve(path) && !stat.isDirectory()) throw new Error(`Expected a directory: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (dirname(current) === current) break;
  }
}

export async function readOptional(path) {
  await assertRegularPath(path);
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function jsonText(value, original = '') {
  const indent = original.match(/\n([ \t]+)"/)?.[1] ?? '  ';
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  return `${JSON.stringify(value, null, indent).replaceAll('\n', newline)}${newline}`;
}

// Replace owned JSON values without reformatting unrelated entries or user edits.
export function patchJson(original, updates) {
  JSON.parse(original);
  const spans = new Map();
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(original[cursor] ?? '') && cursor < original.length) cursor++; };
  const string = () => {
    const start = cursor++;
    while (cursor < original.length) {
      if (original[cursor] === '\\') cursor += 2;
      else if (original[cursor++] === '"') return JSON.parse(original.slice(start, cursor));
    }
    throw new Error('Unterminated JSON string.');
  };
  const value = path => {
    whitespace();
    const start = cursor;
    if (original[cursor] === '{') {
      cursor++;
      whitespace();
      while (original[cursor] !== '}') {
        const key = string();
        whitespace();
        cursor++; // JSON.parse has already checked the colon.
        value([...path, key]);
        whitespace();
        if (original[cursor] === ',') { cursor++; whitespace(); }
        else break;
      }
      cursor++;
    } else if (original[cursor] === '[') {
      cursor++;
      whitespace();
      let index = 0;
      while (original[cursor] !== ']') {
        value([...path, index++]);
        whitespace();
        if (original[cursor] === ',') { cursor++; whitespace(); }
        else break;
      }
      cursor++;
    } else if (original[cursor] === '"') string();
    else while (cursor < original.length && !/[\s,}\]]/.test(original[cursor])) cursor++;
    const key = JSON.stringify(path);
    if (spans.has(key)) throw new Error(`Duplicate JSON field: ${path.join('.')}`);
    spans.set(key, { start, end: cursor });
  };
  value([]);
  const edits = updates.map(([path, next]) => {
    const span = spans.get(JSON.stringify(path));
    if (!span) throw new Error(`Required metadata field is missing: ${path.join('.')}`);
    return { ...span, text: JSON.stringify(next) };
  }).sort((a, b) => b.start - a.start);
  for (const { start, end, text } of edits) original = original.slice(0, start) + text + original.slice(end);
  return original;
}

export function fingerprint(changes) {
  return createHash('sha256').update(JSON.stringify(changes.map(({ path, before, after }) => ({ path, before, after })))).digest('hex');
}

export function preview(changes) {
  return changes.map(({ path, before, after }) => {
    if (before === after) return `Unchanged: ${path}`;
    return `--- ${path} (before)\n+++ ${path} (after)\n${(before ?? '').trimEnd().split('\n').map(line => `- ${line}`).join('\n')}\n${after.trimEnd().split('\n').map(line => `+ ${line}`).join('\n')}`;
  }).join('\n');
}

export async function applyChanges(changes, expected) {
  if (expected !== fingerprint(changes)) throw new Error('Conflict: preview has changed or --expect is missing; preview again before applying.');
  for (const change of changes) {
    if (await readOptional(change.path) !== change.before) throw new Error(`Conflict: file changed since preview: ${change.path}`);
  }
  const backups = [];
  for (const { path, before, after } of changes) {
    if (before === after) continue;
    await mkdir(dirname(path), { recursive: true });
    await assertRegularPath(path);
    if (await readOptional(path) !== before) throw new Error(`Conflict: file changed before write: ${path}`);
    if (before !== null) {
      const backup = `${path}.backup-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
      await writeFile(backup, before, { flag: 'wx' });
      backups.push(backup);
    }
    await writeFile(path, after, { flag: before === null ? 'wx' : 'w' });
  }
  return backups;
}
