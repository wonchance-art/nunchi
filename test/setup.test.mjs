// A plugin installed from git has no node_modules: the engine must say how to set itself up, and the
// commands that need no browser keep working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dependencyState, downloadFailedWords, terminalCommand } from '../src/setup.mjs';
import { tmp } from './fixtures/tmp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('fresh install without node_modules: setup --check says what is missing, capture points at setup', () => {
  const copy = tmp('nunchi-fresh-');
  for (const f of ['src', 'package.json', 'package-lock.json']) cpSync(join(ROOT, f), join(copy, f), { recursive: true });
  const cli = (...a) => spawnSync(process.execPath, [join(copy, 'src', 'cli.mjs'), ...a], { cwd: copy, encoding: 'utf8', env: { ...process.env, NUNCHI_BROWSER: '' } });
  const check = cli('setup', '--check', '--json');
  assert.equal(check.status, 1);
  const r = JSON.parse(check.stdout);
  assert.equal(r.ready, false);
  assert.deepEqual(r.dependencies.packages, { '@babel/parser': { want: '7.29.9', have: null }, 'axe-core': { want: '4.13.0', have: null }, 'playwright-core': { want: '1.63.0', have: null } });
  // the plugin adds no `nunchi` to the person's PATH: setup says the whole command for their own terminal
  assert.equal(r.command, `node "${join(copy, 'src', 'cli.mjs')}"`);
  const words = cli('setup', '--check');
  assert.ok(words.stdout.split('\n').includes(`in your own terminal, nunchi is: node "${join(copy, 'src', 'cli.mjs')}" <command>  (the plugin adds no nunchi command to your PATH)`), words.stdout);
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

test('the Chromium download failing is said as a download failure; the Linux system-library command only on Linux', () => {
  const root = join('/opt', 'engine');
  for (const platform of ['darwin', 'win32', 'linux']) {
    const w = downloadFailedWords(platform, root);
    assert.match(w, /the Chromium download failed \(see above: no network, a proxy that blocks it, or a full disk\)\. Run `nunchi setup` again once that is fixed, or point NUNCHI_BROWSER at an installed Chrome or Chromium\./);
    if (platform === 'linux') assert.ok(w.includes(`node "${join(root, 'node_modules', 'playwright-core', 'cli.js')}" install --with-deps chromium (needs sudo)`), w);
    else assert.doesNotMatch(w, /Linux|sudo|with-deps/, `${platform}: nothing about Linux`);
  }
  assert.equal(terminalCommand(root), `node "${join(root, 'src', 'cli.mjs')}"`);
});
