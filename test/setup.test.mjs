// A plugin installed from git has no node_modules: the engine must say how to set itself up, and the
// commands that need no browser keep working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dependencyState } from '../src/setup.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('fresh install without node_modules: setup --check says what is missing, capture points at setup', () => {
  const copy = mkdtempSync(join(tmpdir(), 'nunchi-fresh-'));
  for (const f of ['src', 'package.json', 'package-lock.json']) cpSync(join(ROOT, f), join(copy, f), { recursive: true });
  const cli = (...a) => spawnSync(process.execPath, [join(copy, 'src', 'cli.mjs'), ...a], { cwd: copy, encoding: 'utf8', env: { ...process.env, NUNCHI_BROWSER: '' } });
  const check = cli('setup', '--check', '--json');
  assert.equal(check.status, 1);
  const r = JSON.parse(check.stdout);
  assert.equal(r.ready, false);
  assert.deepEqual(r.dependencies.packages, { '@babel/parser': { want: '7.29.9', have: null }, 'axe-core': { want: '4.13.0', have: null }, 'playwright-core': { want: '1.63.0', have: null } });
  const cap = cli('capture', '--url', 'http://127.0.0.1:9', '--routes', '/');
  assert.equal(cap.status, 2);
  assert.match(cap.stderr, /Run `nunchi setup` once/);
  assert.doesNotMatch(cap.stderr, /at .*\.mjs/, 'no stack trace');
  assert.equal(cli('discover', '--root', copy).status, 0, 'discover needs no packages');
  const inv = cli('inventory', '--root', copy);
  assert.equal(inv.status, 2, 'inventory needs the pinned parser');
  assert.match(inv.stderr, /Run `nunchi setup` once/);
});

test('the development checkout has the pinned versions', () => {
  assert.equal(dependencyState(ROOT).ok, true, JSON.stringify(dependencyState(ROOT)));
});
