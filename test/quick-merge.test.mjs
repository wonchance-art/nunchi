// Record with merge (design 0.1-c §6, M5) in a real browser: a recording made by a first look of a few screens, then a
// capture of more. Replaying it (what auto did before M5) misses every new screen's data and makes the run
// `recording-stale`; merging records them and replays the rest, and the next replay sees exactly what the merge saw.
// Needs Chromium (skipped otherwise).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { capture, launch } from '../src/capture.mjs';
import { quickServer } from './fixtures/quick-app.mjs';
import { tmp } from './fixtures/board-project.mjs';

let srv, browserOk = true;
before(async () => {
  srv = await quickServer();
  // CI sets NUNCHI_REQUIRE_BROWSER so a missing browser fails the run instead of skipping the capture tests
  try { const b = await launch(); await b.close(); } catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(() => srv && srv.close());

const files = dir => readdirSync(dir, { recursive: true }).filter(f => statSync(join(dir, f)).isFile()).sort();
const scenesOf = routes => routes.map(r => ({ route: r, path: r }));
const hits = () => Object.fromEntries([...srv.hits].sort());

test('no recording-stale after a quick run: screens the recording lacks are recorded with merge, the rest replay strictly', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const har = tmp('nunchi-merge-har-');
  const opts = { baseUrl: srv.base, viewports: ['m'], recordingDir: har };
  // the first look: two screens, recorded
  const first = await capture({ ...opts, scenes: scenesOf(['/', '/pricing']), out: tmp('nunchi-merge-q-'), network: 'auto' });
  assert.deepEqual([first.run.network.guest, first.manifest.health.status], ['record', 'ok']);
  assert.deepEqual(JSON.parse(readFileSync(join(har, 'guest.json'), 'utf8')).routes, { '/': ['m'], '/pricing': ['m'] });
  const more = scenesOf(['/', '/about', '/help', '/pricing']);

  // what auto did before (and --network replay still does): the new screens miss their data → recording-stale
  const stale = await capture({ ...opts, scenes: more, out: tmp('nunchi-merge-r-'), network: 'replay' });
  assert.equal(stale.manifest.health.status, 'recording-stale');
  assert.deepEqual(stale.manifest.scenes.filter(s => s.replayMisses).map(s => s.route).sort(), ['/about', '/help']);

  // merge: the recording lacks /about and /help; they are recorded, / and /pricing replay and ask the server nothing
  const before = hits();
  const a = tmp('nunchi-merge-a-');
  const merged = await capture({ ...opts, scenes: more, out: a, network: 'auto', states: ['normal', 'empty'] });
  assert.deepEqual([merged.run.network.guest, merged.manifest.health.status, merged.manifest.health.problems], ['merge', 'ok', []]);
  assert.equal(merged.manifest.scenes.reduce((n, s) => n + s.replayMisses, 0), 0, 'no replay misses');
  const after1 = hits();
  assert.deepEqual([after1['/api/data/home'], after1['/api/data/pricing']], [before['/api/data/home'], before['/api/data/pricing']], 'screens already recorded never go live');
  assert.deepEqual([after1['/api/data/about'], after1['/api/data/help']], [1, 1], 'a screen the recording lacks is asked once (its empty state replays it)');
  const rec = readFileSync(join(har, 'guest.json'), 'utf8');
  assert.deepEqual(JSON.parse(rec).routes, { '/': ['m'], '/about': ['m'], '/help': ['m'], '/pricing': ['m'] });
  assert.ok(!rec.includes('tok-quick-must-not-be-recorded'), 'tokens are scrubbed from what the merge added');

  // the next run replays everything, asks nothing, and sees exactly what the merge saw
  const b = tmp('nunchi-merge-b-');
  const replayed = await capture({ ...opts, scenes: more, out: b, network: 'auto', states: ['normal', 'empty'] });
  assert.deepEqual([replayed.run.network.guest, replayed.manifest.health.status], ['replay', 'ok']);
  assert.deepEqual(hits(), after1, 'nothing asked live');
  const stable = f => f !== 'timing.json' && f !== 'run.json' && !f.endsWith('volatile.json');
  assert.deepEqual(files(a).filter(stable), files(b).filter(stable));
  assert.deepEqual(files(a).filter(stable).filter(f => !readFileSync(join(a, f)).equals(readFileSync(join(b, f)))), [], 'byte-identical evidence');
  assert.equal(readFileSync(join(har, 'guest.json'), 'utf8'), rec, 'a replay leaves the recording as it was');
});
