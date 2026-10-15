// The fix loop end to end, through the CLI, with a real browser (design 0.1-c §4): a tiny invented app served from its
// own folder (it renders what its source files say and serves public/ as they are on disk), a real capture, a Fix
// decision recorded from chat, then fix --start (P0, the probe-file proof), an edit, fix --checks, the commit with the
// trailers, fix --verify (P1) → fixed, folded for the group only. Needs Chromium (NUNCHI_BROWSER or `nunchi setup`):
// skipped without one unless NUNCHI_REQUIRE_BROWSER is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { git, edit } from './fixtures/fix-project.mjs';
import { tmp } from './fixtures/tmp.mjs';
import { freePort } from '../src/fix/probe.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const cli = (cwd, ...a) => new Promise(res => execFile('node', [CLI, ...a], { cwd, encoding: 'utf8', timeout: 240000, env: { ...process.env, XDG_STATE_HOME: join(cwd, '..', 'xdg') } }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
async function browserOk() {
  try { const b = await chromium.launch({ executablePath: process.env.NUNCHI_BROWSER || undefined }); await b.close(); return true; }
  catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; return false; }
}

// The app's server: it lives outside the repository (it is the test's), reads the app's source on every request.
const SERVER = `import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2], port = Number(process.argv[3]);
const page = (title, body) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + title + '</title></head><body><main><h1>' + title + '</h1>' + body + '</main></body></html>';
createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const file = join(root, 'public', path.slice(1));
  if (path !== '/' && /^\\/[\\w.-]+$/.test(path) && existsSync(file)) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(readFileSync(file)); }
  const src = f => readFileSync(join(root, 'app', f), 'utf8');
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page('Plant shelf', '<p>Your plants, sorted by thirst.</p><a href="/settings">Settings</a>')); }
  if (path === '/settings') {
    const href = /href="#"/.test(src('settings/page.jsx')) ? '#' : '/';
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('Settings', '<p>Watering reminders.</p><a href="' + href + '">More about reminders</a> <a href="/">Home</a>'));
  }
  res.writeHead(404, { 'content-type': 'text/html' }); res.end(page('Not found', '<a href="/">Home</a>'));
}).listen(port, '127.0.0.1');
`;

test('fix e2e: capture, decide, fix --start, edit, fix --checks, commit, fix --verify → fixed (real browser, real git)', { timeout: 300000 }, async t => {
  if (!(await browserOk())) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const base = tmp('nunchi-fix-e2e-');
  const root = join(base, 'shelf');
  mkdirSync(join(root, 'app', 'settings'), { recursive: true });
  mkdirSync(join(root, 'public'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'shelf-e2e', private: true, dependencies: { next: '0.0.0-test' } }, null, 2) + '\n');
  writeFileSync(join(root, 'app', 'page.jsx'), 'export default function Home() { return <main><h1>Plant shelf</h1><a href="/settings">Settings</a></main>; }\n');
  writeFileSync(join(root, 'app', 'settings', 'page.jsx'), 'export default function Settings() {\n  return <main><h1>Settings</h1><a href="#">More about reminders</a> <a href="/">Home</a></main>;\n}\n');
  writeFileSync(join(root, 'public', 'robots.txt'), 'User-agent: *\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'user.name', 'Tester');
  git(root, 'config', 'user.email', 'tester@example.invalid');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'the app');
  writeFileSync(join(base, 'server.mjs'), SERVER);
  const port = await freePort();
  const server = spawn(process.execPath, [join(base, 'server.mjs'), root, String(port)], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    const url = `http://127.0.0.1:${port}`;
    const cap = await cli(root, 'capture', '--url', url, '--network', 'record', '--json');
    assert.equal(cap.code, 0, cap.stderr);
    const groups = JSON.parse((await cli(root, 'findings', '--all', '--json')).stdout).groups;
    const dead = groups.find(g => g.rule === 'dead-href');
    assert.ok(dead, groups.map(g => g.rule).join(', '));
    assert.equal((await cli(root, 'decide', dead.group, 'fix', '--from-chat')).code, 0);
    const plan = await cli(root, 'fix', '--plan');
    assert.match(plan.stdout, /^Fix plan: 1 finding to fix\./);
    const start = await cli(root, 'fix', '--start', dead.group, '--agent', 'Claude Code', '--json');
    assert.equal(start.code, 0, start.stderr + start.stdout);
    const s = JSON.parse(start.stdout);
    assert.match(s.lines.join('\n'), /^Fix brief · group [0-9a-f]{12} · attempt 1 of 2 · branch nunchi\/fixes-\d{4}/);
    assert.equal(readFileSync(join(root, '.nunchi', 'runs', 'latest'), 'utf8').trim(), '0001', 'a probe is never latest');
    edit(root, 'app/settings/page.jsx', 'href="#"', 'href="/settings/reminders"');
    const checks = JSON.parse((await cli(root, 'fix', '--checks', dead.group, '--json')).stdout);
    assert.equal(checks.code, 0, checks.lines.join('\n'));
    assert.match(checks.lines.join('\n'), /no test script — nunchi relies on re-capture\./);
    git(root, 'commit', '-q', '-a', '-m', 'Make "More about reminders" go somewhere', '-m', checks.trailers.join('\n'));
    // a capture on the fix branch (design §7) is a fix probe: kept apart, never latest, the finding still to fix
    const onBranch = await cli(root, 'capture', '--url', url, '--json');
    assert.equal(onBranch.code, 0, onBranch.stderr);
    const probeRun = JSON.parse(onBranch.stdout).run;
    assert.equal(JSON.parse(readFileSync(join(root, '.nunchi', 'runs', probeRun, 'run.json'), 'utf8')).kind, 'fix-probe');
    assert.equal(readFileSync(join(root, '.nunchi', 'runs', 'latest'), 'utf8').trim(), '0001');
    assert.equal(JSON.parse((await cli(root, 'findings', '--all', '--json')).stdout).groups.find(g => g.group === dead.group).status, 'to-fix');
    const v = await cli(root, 'fix', '--verify', dead.group);
    assert.equal(v.code, 0, v.stderr);
    assert.equal(v.stdout.trim(), "Fixed 'Link that goes nowhere (#)' (re-checked 2 screens, nothing else broke).");
    const after = JSON.parse((await cli(root, 'findings', '--all', '--json')).stdout).groups.find(g => g.group === dead.group);
    assert.equal(after.status, 'fixed');
    assert.match((await cli(root, 'runs')).stdout, /^\(3 fix probe runs hidden: nunchi runs --all lists them\)/);
    assert.match((await cli(root, 'fix', '--summary')).stdout, /^Fixed 1 of 1 \(re-checked 2 screens, nothing else broke\)\./);
    assert.equal(git(root, 'status', '--porcelain', '--', '.', ':!.nunchi'), '', 'the probe file is gone, nothing left behind');
  } finally { server.kill(); }
});
