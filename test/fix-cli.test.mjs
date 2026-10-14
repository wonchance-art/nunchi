// The fix loop through the CLI (M3): `nunchi fix` subcommands, probe runs hidden from `runs` and removed first by
// `gc` (kept while their attempt is open), and the human-only approval of the check scripts. Synthetic git
// repositories; no browser (the attempts are made through the library with capture's stand-in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from '../src/fix/loop.mjs';
import * as P from '../src/project.mjs';
import { fixProject, edit, commitWith, tmp } from './fixtures/fix-project.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
process.env.XDG_STATE_HOME = tmp('nunchi-fixcli-xdg-');
const cli = (cwd, ...a) => new Promise(res => execFile('node', [CLI, ...a], { cwd, encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
const ctxOf = p => F.openFix({ cwd: p.root, root: p.root, deps: { capture: p.cap.capture, prove: async () => ({ ok: true }) } });

test('fix --plan prints the one plan the skill shows (branch, findings, checks, the URL) and writes fix-plan.json; --status and --summary', async () => {
  const p = await fixProject();
  const r = await cli(p.root, 'fix', '--plan');
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^Fix plan: 1 finding to fix\. Fixes go on branch nunchi\/fixes-\d{4}; merge it when you're happy\.$/);
  assert.match(lines[1], new RegExp(`^  1\\. medium  Tap target smaller than 24px — /settings · fix in app/settings/page\\.jsx  \\(group ${p.group}\\)$`));
  assert.equal(lines[2], 'No build, typecheck, lint or test script: nunchi relies on re-capture.');
  assert.equal(lines[3], 'The app must answer at http://127.0.0.1:3000 (or start it with --serve dev|start), with the data the last capture recorded.');
  assert.ok(existsSync(join(P.stateOf(p.nunchi).root.dir, 'fix-plan.json')));
  const j = JSON.parse((await cli(p.root, 'fix', '--plan', '--json')).stdout);
  assert.deepEqual([j.plan.length, j.plan[0].group, j.dirty, j.url], [1, p.group, 0, 'http://127.0.0.1:3000']);
  // a dirty tree: the plan offers the one choice, --start refuses
  writeFileSync(join(p.root, 'wip.txt'), 'x');
  assert.match((await cli(p.root, 'fix', '--plan')).stdout, /Your working tree has 1 uncommitted change\. Choose once: 1\. commit them as "WIP before nunchi fixes" \(recommended\), 2\. stash them, or 3\. stop\./);
  const s = await cli(p.root, 'fix', '--start', p.group);
  assert.equal(s.code, 1);
  assert.match(s.stderr, /^Your working tree has uncommitted changes \(wip\.txt\)/);
  assert.equal((await cli(p.root, 'fix', '--status')).stdout.trim(), 'No fix attempts yet.');
  assert.match((await cli(p.root, 'fix', '--summary')).stdout, /^Fixed 0 of 1\. 1 not finished yet\./);
  const u = await cli(p.root, 'fix');
  assert.equal(u.code, 1);
  assert.match(u.stderr, /^nunchi fix: use --plan, --start <group>/);
});

test('fix --approve-checks is a person\'s: refused unless stdin and stdout are a terminal (the agent cannot approve its own scripts)', async () => {
  const p = await fixProject({ files: { 'package.json': JSON.stringify({ name: 'x', private: true, dependencies: { next: '0' }, scripts: { test: 'node t.js' } }) + '\n' } });
  const r = await cli(p.root, 'fix', '--approve-checks');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /check scripts are approved by a person: in the board \(nunchi open shows a card\), or by running nunchi fix --approve-checks in your own terminal\. Your AI cannot approve them\./);
  assert.ok(!existsSync(join(P.stateOf(p.nunchi).root.dir, 'scripts-approved.json')));
});

test('probe runs: hidden from `nunchi runs` (--all lists them), never `latest`; gc removes them first, but keeps an open attempt\'s', async () => {
  const p = await fixProject();
  // one finished attempt (P0, P1), then an open one (its P0)
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  edit(p.root, 'app/settings/page.jsx', 'TINY', 'WRAP');
  const c = await F.checkFix(ctxOf(p), p.group);
  commitWith(p.root, c.json.trailers);
  await F.verifyFix(ctxOf(p), p.group);
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  const runs = await cli(p.root, 'runs');
  assert.match(runs.stdout, /^\(3 fix probe runs hidden: nunchi runs --all lists them\)\n0001 \(latest\)/);
  assert.equal(runs.stdout.trim().split('\n').length, 2);
  const all = await cli(p.root, 'runs', '--all');
  assert.match(all.stdout, /0002 .*fix probe P0 of group/);
  assert.match(all.stdout, /0004 .*fix probe P0 of group/);
  const gc = await cli(p.root, 'gc', '--keep', '1');
  assert.equal(gc.code, 0, gc.stderr);
  assert.deepEqual(readdirSync(join(p.nunchi, 'runs')).filter(n => /^\d{4}$/.test(n)).sort(), ['0001', '0004'], 'the closed attempt\'s probes went first; the open one\'s P0 stays');
});
