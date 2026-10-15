// `nunchi capture --quick`, then the full check, through the CLI against an invented app (design 0.1-c §6, M5): the key
// screens it picks, what a quick run writes and folds, which run the AI commands build on, and the full check after it
// recording with merge (no recording-stale). Needs Chromium (skipped otherwise).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch } from '../src/capture.mjs';
import { quickApp, quickServer, SAMPLES } from './fixtures/quick-app.mjs';
import { tmp } from './fixtures/board-project.mjs';

process.env.XDG_STATE_HOME = tmp('nunchi-quick-cli-xdg-');
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
// async: a synchronous child would block this process, and with it the test server the capture is reading
const cli = (cwd, ...a) => new Promise(res => execFile('node', [CLI, ...a], { cwd, encoding: 'utf8' }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
const json = r => { assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout); };
const read = p => JSON.parse(readFileSync(p, 'utf8'));

let srv, browserOk = true;
before(async () => {
  srv = await quickServer();
  try { const b = await launch(); await b.close(); } catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(() => srv && srv.close());

test('a capture that fails, or is stopped, takes its unfinished run folder with it: nothing is left to say it runs (review of PR #33)', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const app = quickApp();
  mkdirSync(join(app, '.nunchi'), { recursive: true });
  writeFileSync(join(app, '.nunchi', 'samples.json'), JSON.stringify(SAMPLES));
  const runs = join(app, '.nunchi', 'runs');
  const partial = () => readdirSync(runs).filter(n => n.endsWith('.partial'));
  const failed = await cli(app, 'capture', '--url', srv.base, '--samples', '.nunchi/samples.json', '--auth', 'no-such-login.json');
  assert.equal(failed.code, 2, failed.stderr);
  assert.match(failed.stderr, /signed-in scenes need a saved login state/);
  assert.deepEqual(partial(), []);
  if (process.platform === 'win32') return;                                   // a signal there ends the process at once
  const child = spawn(process.execPath, [CLI, 'capture', '--url', srv.base, '--samples', '.nunchi/samples.json', '--viewports', 'm'], { cwd: app, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const exited = new Promise(res => child.on('exit', (code, signal) => res(code ?? signal)));
  for (let i = 0; i < 400 && !partial().some(p => existsSync(join(runs, p, 'progress.json'))); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(partial().length, 1, 'it is running');
  child.kill('SIGINT');
  assert.equal(await exited, 130, stderr);
  assert.match(stderr, /stopped \(SIGINT\); run 0001 was not completed and is removed/);
  assert.deepEqual(partial(), []);
});

test('capture --quick: the key screens, presence-only, rule lenses only; the full check after it merges the recording', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const app = quickApp();
  mkdirSync(join(app, '.nunchi'), { recursive: true });
  writeFileSync(join(app, '.nunchi', 'samples.json'), JSON.stringify(SAMPLES));
  const runs = join(app, '.nunchi', 'runs');
  const base = ['--url', srv.base, '--samples', '.nunchi/samples.json', '--viewports', 'm'];
  srv.set({ lowContrast: true });

  // flags a quick run decides for itself are refused before anything is made
  const clash = await cli(app, 'capture', '--quick', ...base, '--states', 'normal,error');
  assert.equal(clash.code, 1);
  assert.match(clash.stderr, /--quick chooses the key screens itself.*leave out --states/);
  assert.ok(!existsSync(runs), 'no run folder');

  const q = json(await cli(app, 'capture', '--quick', ...base, '--json'));
  assert.deepEqual([q.run, q.kind, q.health.status, q.network], ['0001', 'quick', 'ok', { guest: 'record' }]);
  assert.deepEqual(q.quick.routes, ['/', '/pricing', '/about', '/app', '/blog', '/careers', '/contact', '/help']);
  const meta = read(join(runs, '0001', 'run.json'));
  assert.deepEqual([meta.kind, meta.wholeApp, meta.scope.routes, meta.scope.states], ['quick', false, [...q.quick.routes].sort(), ['normal']]);
  assert.equal(meta.quick.why['/pricing'], 'navigation');
  // rule lenses only: no whole-app detector (every page links to /zebra/nowhere, a missing route), no AI inputs, no progress
  const rules = new Set(read(join(runs, '0001', 'findings.json')).findings.map(f => f.rule));
  assert.ok(rules.has('axe-color-contrast'), [...rules].join(', '));
  for (const r of ['link-to-missing-route', 'unreachable-route', 'secret-in-client-bundle']) assert.ok(!rules.has(r), r);
  for (const f of ['source-map.json', 'source-hashes.json', 'inventory.json', 'canaries.json', 'progress.json']) assert.ok(!existsSync(join(runs, '0001', f)), f);
  assert.deepEqual(read(join(app, '.nunchi', 'har', 'guest.json')).routes, Object.fromEntries([...q.quick.routes].sort().map(r => [r, ['m']])));

  // the AI side builds on a full check only
  const hunt = await cli(app, 'hunt', '--plan');
  assert.equal(hunt.code, 1);
  assert.match(hunt.stderr, /no full check yet: run 0001 is a quick first look/);
  assert.match((await cli(app, 'hunt', '--plan', '--run', '0001')).stderr, /run 0001 is a quick first look \(rule lenses only\)/);
  const f1 = json(await cli(app, 'findings', '--json'));
  assert.equal(f1.summary.verdict.text, 'Too early to say');
  assert.ok(f1.groups.some(g => g.rule === 'axe-color-contrast' && g.status === 'open'), 'what the first look found is open');

  // the full check: the screens the first look recorded replay, the rest are recorded and merged in; no recording-stale
  srv.set({ lowContrast: false });
  const asked = srv.hits.get('/api/data/pricing'), zebra = srv.hits.get('/api/data/zebra') || 0;
  const full = json(await cli(app, 'capture', ...base, '--states', 'normal', '--json'));
  assert.deepEqual([full.run, full.kind, full.network, full.health.status, full.replayMisses], ['0002', 'sweep', { guest: 'merge' }, 'ok', 0]);
  assert.equal(srv.hits.get('/api/data/pricing'), asked, 'a screen the first look recorded is not asked again');
  assert.equal(srv.hits.get('/api/data/zebra'), zebra + 1, 'one it did not is recorded');
  assert.equal(Object.keys(read(join(app, '.nunchi', 'har', 'guest.json')).routes).length, 14);
  assert.ok(!existsSync(join(runs, '0002', 'progress.json')), 'the progress file goes before the run is complete');
  const f2 = json(await cli(app, 'findings', '--all', '--json'));
  assert.ok(f2.groups.filter(g => g.rule === 'axe-color-contrast').every(g => g.status === 'fixed'), 'the full check fixes, like for like');
  assert.ok(f2.summary.fullCheckDone, JSON.stringify(f2.summary.fullCheckDone));
  assert.equal(f2.summary.fullCheckDone.text, `Full check done: ${f2.summary.fullCheckDone.newGroups} new group${f2.summary.fullCheckDone.newGroups === 1 ? '' : 's'}`);
  assert.ok(f2.summary.fullCheckDone.newGroups >= 2, 'the link to a missing route and the unreachable page are new');

  // a first look after it: the hunt and the verifier still build on the full check
  json(await cli(app, 'capture', '--quick', ...base, '--json'));
  assert.equal(json(await cli(app, 'hunt', '--plan', '--json')).run, '0002');
  assert.match((await cli(app, 'verify', '--plan')).stderr, new RegExp(`${join('runs', '0002', 'ai-findings.json').replace(/\\/g, '\\\\')} does not exist yet`));
  assert.match((await cli(app, 'recheck', '--plan')).stdout, /no open AI findings to re-check against run 0002/);
  assert.match((await cli(app, 'recheck', '--plan', '--run', '0003')).stderr, /cannot be re-checked: it is a quick run: only a sweep folds its AI findings/);
  const listed = await cli(app, 'runs');
  assert.match(listed.stdout, /0001 {2}no git {2}health ok {2}8 routes {2}quick \(a first look\)/);
  assert.match(listed.stdout, /0003 \(latest\).*quick \(a first look\)/);
  assert.deepEqual(readdirSync(runs).sort(), ['0001', '0002', '0003', 'latest']);
});
