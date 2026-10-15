// Offering guards (design 0.1-c §5, spec §7.3): only after a verified fix of a kind with a built-in guard, as one card
// at the end of a fix batch, in the design's words; an Add toggle per row that only a person (the board's key) uses;
// "≥ 5 open instances" as a passive chip; `nunchi guard --add` refused off a terminal; the deny hook keeps the agent off
// guards.json. Synthetic projects (test/fixtures/board-project.mjs), fix records written as the fix loop writes them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { writeRun, scene, tmp } from './fixtures/board-project.mjs';
import { boardRequest } from './fixtures/board-call.mjs';
import * as P from '../src/project.mjs';
import * as R from '../src/fix/records.mjs';
import * as F from '../src/fix/loop.mjs';
import * as O from '../src/guard-offer.mjs';
import * as G from '../src/guards.mjs';
import { startBoard } from '../src/board/server.mjs';
import { judge } from '../src/deny-hook.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
process.env.XDG_STATE_HOME = tmp('nunchi-offer-xdg-');
const T0 = Date.parse('2026-10-15T01:00:00Z');

// two window.confirm groups, one href="#" group, one clipped-text group (no guard), and n more dead links
function project({ moreDeadLinks = 0 } = {}) {
  const root = tmp('nunchi-offer-');
  writeFileSync(join(root, 'package.json'), '{"name":"fern-shelf","private":true}\n');
  const scenes = ['/', '/garden', '/shop', '/help', '/cart', '/about', '/blog'].map(r => scene(r, 'guest', 'normal', 'd'));
  const f = (lens, rule, severity, sc, selector, evidence) => ({ lens, rule, severity, scene: sc.id, route: sc.route, viewport: sc.viewport, selector, box: null, evidence });
  const findings = [
    f('L9', 'native-dialog', 'medium', scenes[0], null, { type: 'confirm', message: 'Remove?' }),
    f('L9', 'native-dialog', 'medium', scenes[1], null, { type: 'confirm', message: 'Water now?' }),
    f('L7', 'dead-href', 'low', scenes[2], 'main a.more', { href: '#', name: 'More' }),
    f('L1', 'clipped-text', 'medium', scenes[3], 'h2.title', { text: 'Ferns of the…' }),
    ...Array.from({ length: moreDeadLinks }, (_, i) => f('L7', 'dead-href', 'low', scenes[3 + (i % 4)], `aside a.x${i}`, { href: '#', name: `X${i}` })),
  ];
  writeRun(root, '0001', { scenes, findings });
  const nunchi = join(root, '.nunchi');
  const led = P.loadLedger(nunchi, { root });
  const { rows, groups } = P.ledgerView(led);
  const by = rule => groups.filter(g => g.rule === rule).map(g => g.group).sort();
  return { root, nunchi, stateDir: led.st.root.dir, rows, groups, by };
}
// the fix loop's records: an attempt that ended `phase` (fixed = verified by the engine's probes)
function attempt(p, group, phase, at = T0 + 60e3) {
  let rec = R.allocate(p.stateDir, group, { title: group }, { now: at });
  rec = R.setPhase(p.stateDir, rec, phase === 'fixed' ? 'folding' : 'verifying', {}, { now: at + 1000 });
  return R.setPhase(p.stateDir, rec, phase, {}, { now: at + 2000 });
}
const plan = (p, groups, at = T0) => R.writePlan(p.stateDir, { groups }, { now: at });
const rowsNow = p => P.ledgerView(P.loadLedger(p.nunchi, { root: p.root })).rows;

test('after verified fixes of guarded kinds: one offer, in the design\'s words', () => {
  const p = project();
  const [c1, c2] = p.by('native-dialog'), [d1] = p.by('dead-href'), [t1] = p.by('clipped-text');
  plan(p, [c1, c2, d1, t1]);
  for (const g of [c1, c2, d1, t1]) attempt(p, g, 'fixed');
  const offer = O.guardOffer({ stateDir: p.stateDir, rows: p.rows, doc: null });
  assert.deepEqual(offer.rows.map(r => [r.kind, r.label, r.fixed, r.added]), [['native-dialog', '`window.confirm`', 2, false], ['dead-href', '`href="#"`', 1, false]]);
  assert.equal(O.offerLine(offer.rows), 'Stop these coming back? `window.confirm` (fixed twice) · `href="#"`');
  assert.deepEqual(offer.rows[0].params, { calls: ['confirm'] });
  assert.equal(O.fixedWords(3), ' (fixed 3 times)');
  // the batch summary carries it, pointing at the board (the person adds, never the agent)
  const sum = F.summaryFix(F.openFix({ cwd: p.root }));
  assert.equal(sum.lines[1], 'Stop these coming back? `window.confirm` (fixed twice) · `href="#"` → the board (nunchi open).');
  assert.deepEqual(sum.json.guards.map(g => g.kind), ['native-dialog', 'dead-href']);
});

test('no offer without a verified fix in this batch, or when a guard covers the kind already', () => {
  const p = project();
  const [c1, c2] = p.by('native-dialog'), [d1] = p.by('dead-href');
  plan(p, [c1, d1]);
  attempt(p, c1, 'reverted');
  attempt(p, d1, 'needs-you');
  assert.deepEqual(O.guardOffer({ stateDir: p.stateDir, rows: p.rows, doc: null }).rows, []);
  // fixed before this plan: counted in "fixed n", not offered by itself
  attempt(p, c2, 'fixed', T0 - 3600e3);
  assert.deepEqual(O.guardOffer({ stateDir: p.stateDir, rows: p.rows, doc: null }).rows, []);
  attempt(p, c1, 'fixed');
  assert.deepEqual(O.guardOffer({ stateDir: p.stateDir, rows: p.rows, doc: null }).rows.map(r => [r.kind, r.fixed]), [['native-dialog', 2]]);
  const guarded = G.validateGuards({ schema: 1, guards: [{ kind: 'native-dialog', params: { calls: ['alert', 'confirm'] } }], baseline: [] });
  assert.deepEqual(O.guardOffer({ stateDir: p.stateDir, rows: p.rows, doc: guarded }).rows, []);
  const narrower = G.validateGuards({ schema: 1, guards: [{ kind: 'native-dialog', params: { calls: ['alert'] } }], baseline: [] });
  assert.equal(O.guardOffer({ stateDir: p.stateDir, rows: p.rows, doc: narrower }).rows.length, 1, 'a guard that does not cover confirm yet');
  G.writeGuards(join(p.nunchi, 'guards.json'), guarded);
  assert.equal(F.summaryFix(F.openFix({ cwd: p.root })).lines.length, 1, 'only the batch line when nothing is offered');
});

test('a verified fix that took baselined hits away: the summary proposes tightening the baseline', () => {
  const p = project();
  const [c1, c2] = p.by('native-dialog');
  writeFileSync(join(p.root, 'remove.jsx'), "export const R = () => <button onClick={() => confirm('Remove?')}>x</button>;\nexport const W = () => <button onClick={() => confirm('Water now?')}>y</button>;\n");
  G.writeGuards(join(p.nunchi, 'guards.json'), G.addGuard(G.emptyGuards(), { project: p.root, kind: 'native-dialog', params: { calls: ['confirm'] } }).doc);
  plan(p, [c1, c2]);
  attempt(p, c1, 'fixed');
  attempt(p, c2, 'fixed');
  writeFileSync(join(p.root, 'remove.jsx'), 'export const R = () => <button>x</button>;\n');
  const kindsAsked = [];
  const tighten = kinds => { kindsAsked.push(...kinds); const doc = G.readGuards(join(p.nunchi, 'guards.json')); return G.compareBaseline(G.scanGuards({ project: p.root, guards: doc.guards }).hits, doc.baseline).gone.reduce((n, e) => n + e.count - e.now, 0); };
  const sum = F.summaryFix(F.openFix({ cwd: p.root }), { tighten });
  assert.deepEqual(kindsAsked, ['native-dialog'], 'only the kinds this batch fixed');
  assert.equal(sum.lines.at(-1), '2 baselined guard hits are gone with these fixes: tighten the baseline so they cannot come back unseen (nunchi guard --baseline, in your own terminal; commit .nunchi/guards.json).');
  assert.equal(sum.json.tighten, 2);
  // through the CLI, which scans with the parser
  const cli = spawnSync(process.execPath, [CLI, 'fix', '--summary'], { cwd: p.root, encoding: 'utf8' });
  assert.match(cli.stdout, /2 baselined guard hits are gone with these fixes/);
  // nothing gone, or no guard of the fixed kinds: no proposal
  assert.ok(!F.summaryFix(F.openFix({ cwd: p.root }), { tighten: () => 0 }).lines.some(l => /tighten/.test(l)));
});

test('the Add toggle adds the guard with today\'s hits as its baseline, and takes back only what it added', async () => {
  const p = project();
  const [c1] = p.by('native-dialog');
  plan(p, [c1]);
  attempt(p, c1, 'fixed');
  writeFileSync(join(p.root, 'remove.jsx'), "export const R = () => <button onClick={() => confirm('Remove?')}>x</button>;\n");
  const on = await O.toggleOffer({ nunchiDir: p.nunchi, stateDir: p.stateDir, project: p.root, rows: p.rows, kind: 'native-dialog', add: true, by: 'Ana' });
  assert.deepEqual(on, { ok: true, baselined: 1 });
  const doc = G.readGuards(join(p.nunchi, 'guards.json'));
  assert.deepEqual(doc.guards, [{ kind: 'native-dialog', params: { calls: ['confirm'] } }]);
  assert.equal(doc.baseline.length, 1);
  assert.deepEqual(O.guardOffer({ stateDir: p.stateDir, rows: p.rows, doc }).rows.map(r => r.added), [true], 'the row stays, pressed');
  assert.equal(F.summaryFix(F.openFix({ cwd: p.root })).lines.length, 1, 'added: no longer offered in chat');
  const off = await O.toggleOffer({ nunchiDir: p.nunchi, stateDir: p.stateDir, project: p.root, rows: p.rows, kind: 'native-dialog', add: false });
  assert.deepEqual(off, { ok: true });
  assert.deepEqual(G.readGuards(join(p.nunchi, 'guards.json')), G.emptyGuards());
  // a guard the person had before the card: the card never removes it
  G.writeGuards(join(p.nunchi, 'guards.json'), { schema: 1, guards: [{ kind: 'native-dialog', params: { calls: ['alert'] } }], baseline: [] });
  assert.equal((await O.toggleOffer({ nunchiDir: p.nunchi, stateDir: p.stateDir, project: p.root, rows: p.rows, kind: 'native-dialog', add: true })).ok, true);
  assert.deepEqual(G.readGuards(join(p.nunchi, 'guards.json')).guards, [{ kind: 'native-dialog', params: { calls: ['alert', 'confirm'] } }]);
  await O.toggleOffer({ nunchiDir: p.nunchi, stateDir: p.stateDir, project: p.root, rows: p.rows, kind: 'native-dialog', add: false });
  assert.deepEqual(G.readGuards(join(p.nunchi, 'guards.json')).guards, [{ kind: 'native-dialog', params: { calls: ['alert'] } }]);
  assert.equal((await O.toggleOffer({ nunchiDir: p.nunchi, stateDir: p.stateDir, project: p.root, rows: p.rows, kind: 'dead-href', add: true })).status, 409, 'not offered');
});

test('"guard available": a passive chip at five open places a guard would cover', () => {
  assert.deepEqual([...O.guardAvailable(project({ moreDeadLinks: 3 }).rows, null)], []);
  const p = project({ moreDeadLinks: 4 });
  assert.deepEqual([...O.guardAvailable(p.rows, null)], ['dead-href']);
  assert.deepEqual([...O.guardAvailable(p.rows, G.validateGuards({ schema: 1, guards: [{ kind: 'dead-href', params: { values: ['#'] } }], baseline: [] }))], []);
  const f = spawnSync(process.execPath, [CLI, 'findings', '--json'], { cwd: p.root, encoding: 'utf8' });
  assert.equal(JSON.parse(f.stdout).kinds.find(k => k.rule === 'dead-href').guard, 'guard available');
});

test('the board: the card in the summary, the toggle through the key only, the chip on the kind\'s section', async () => {
  const p = project({ moreDeadLinks: 4 });
  const [c1] = p.by('native-dialog');
  plan(p, [c1]);
  attempt(p, c1, 'fixed');
  const b = await startBoard({ projectDir: p.root });
  try {
    const origin = b.origin;
    const s = await (await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code: b.newLink().split('#t=')[1] }) })).json();
    const call = (path, body, token = s.token) => boardRequest(origin, path, { token, body });
    let sum = (await call('/api/summary')).json;
    assert.deepEqual(sum.guards, { title: 'Stop these coming back?', unreadable: false, rows: [{ kind: 'native-dialog', text: '`window.confirm`', added: false }] });
    const list = (await call('/api/groups?status=open&group=kind')).json;
    assert.equal(list.sections.find(x => x.key === 'dead-href').guard, 'available');
    assert.equal(list.sections.find(x => x.key === 'native-dialog')?.guard, undefined);
    assert.equal((await call('/api/guard', { kind: 'native-dialog', add: true }, 'f'.repeat(64))).status, 401, 'no key, no guard');
    assert.equal((await call('/api/guard', { kind: 'no-eval', add: true })).status, 400);
    assert.equal((await call('/api/guard', { kind: 'native-dialog', add: 'yes' })).status, 400);
    const r = await call('/api/guard', { kind: 'native-dialog', add: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, { ok: true, added: true, baselined: 0 }, 'how many hits there now became its baseline');
    assert.ok(existsSync(join(p.nunchi, 'guards.json')));
    sum = (await call('/api/summary')).json;
    assert.equal(sum.guards.rows[0].added, true);
    assert.equal((await call('/api/guard', { kind: 'dead-href', add: true })).status, 409, 'only what the card offers');
    assert.equal((await call('/api/guard', { kind: 'native-dialog', add: false })).status, 200);
    assert.deepEqual(G.readGuards(join(p.nunchi, 'guards.json')).guards, []);
  } finally { await b.close(); }
});

test('nunchi guard: listing and --lint for anyone; --add, --remove and --baseline refused off a terminal', () => {
  const p = project();
  writeFileSync(join(p.root, 'remove.jsx'), "export const R = () => <a href=\"#\" onClick={() => confirm('Remove?')}>x</a>;\n");
  const run = (...a) => spawnSync(process.execPath, [CLI, 'guard', ...a], { cwd: p.root, encoding: 'utf8' });
  const list = run();
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^off  native-dialog   `alert` \/ `window\.confirm` \/ `window\.prompt` — 1 hit\(s\) now$/m);
  assert.match(list.stdout, /^off  colour-literal  colour literals outside the measured tokens — unavailable: no tokens\.json in the latest run/m);
  assert.equal(JSON.parse(run('--json').stdout).guards.find(g => g.kind === 'dead-href').hits, 1);
  assert.match(run('--lint').stdout, /'no-alert': 'error'/);
  for (const a of [['--add', 'native-dialog'], ['--remove', 'native-dialog'], ['--baseline']]) {
    const r = run(...a);
    assert.equal(r.status, 1, a.join(' '));
    assert.match(r.stderr, /Your AI cannot/);
  }
  assert.ok(!existsSync(join(p.nunchi, 'guards.json')));
  assert.equal(run('--add').status, 2);
  assert.equal(run('--lnt').status, 2, 'a typo is refused, not ignored');
  assert.equal(run('--strict').status, 2, 'another command\'s flag is refused');
});

test('deny hook: the agent cannot write guards.json or add, remove or re-baseline a guard; it may read and propose', () => {
  const root = tmp('nunchi-offer-hook-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const call = (tool, input) => judge({ tool_name: tool, tool_input: input, cwd: root }, { env: process.env });
  for (const [tool, input] of [
    ['Write', { file_path: join(root, '.nunchi', 'guards.json'), content: '{}' }],
    ['Edit', { file_path: '.nunchi/guards.json', old_string: '1', new_string: '2' }],
    ['Bash', { command: 'echo {} > .nunchi/guards.json' }],
    ['Bash', { command: 'git checkout HEAD~3 -- .nunchi/guards.json' }],
    ['Bash', { command: 'nunchi guard --add native-dialog' }],
    ['Bash', { command: 'node "${CLAUDE_SKILL_DIR}/../../src/cli.mjs" guard --baseline' }],
    ['Bash', { command: 'npx nunchi@latest guard --remove dead-href' }],
    ['Bash', { command: 'script -q /dev/null nunchi guard --add raw-message' }],
    // the folder that holds it: removed, copied into, checked out or restored from another commit
    ['Bash', { command: 'rm -rf .nunchi' }],
    ['Bash', { command: 'cp /tmp/weaker.json .nunchi/' }],
    ['Bash', { command: 'git checkout origin/main -- .nunchi' }],
    ['Bash', { command: 'git restore --source=HEAD~1 .nunchi/' }],
    ['Bash', { command: `cp /tmp/weaker.json ${join(root, '.nunchi')}` }],
    // in any letter case (a case-insensitive disk opens the same file)
    ['Write', { file_path: join(root, '.nunchi', 'Guards.json'), content: '{}' }],
    ['Bash', { command: 'echo {} > .NUNCHI/GUARDS.JSON' }],
    // the guard command in the words as the shell joins them
    ['Bash', { command: 'nunchi guard --ad""d native-dialog' }],
    ['Bash', { command: 'nunchi "guard" "--add" raw-message' }],
    ['Bash', { command: "nun''chi guard --base'line'" }],
  ]) assert.ok(call(tool, input), `${tool} ${JSON.stringify(input)} is denied`);
  for (const [tool, input] of [
    ['Read', { file_path: join(root, '.nunchi', 'guards.json') }], ['Bash', { command: 'cat .nunchi/guards.json' }],
    ['Bash', { command: 'nunchi guard' }], ['Bash', { command: 'nunchi guard --lint' }], ['Bash', { command: 'nunchi check --base origin/main --sarif out.sarif' }],
    ['Bash', { command: 'git add .nunchi/guards.json && git commit -m guards' }],
    ['Bash', { command: 'ls .nunchi' }], ['Bash', { command: 'cd .nunchi && ls' }], ['Bash', { command: 'git add .nunchi && git diff --cached -- .nunchi' }],
    ['Bash', { command: 'npx eslint . --ignore-pattern .nunchi' }], ['Bash', { command: 'cp .nunchi/../package.json /tmp/pkg.json' }],
    ['Write', { file_path: join(root, '.nunchi', 'notes.md'), content: 'x' }],
  ]) assert.equal(call(tool, input), null, `${tool} ${JSON.stringify(input)} is allowed`);
});

// ---- in a real browser (skipped without Chromium unless NUNCHI_REQUIRE_BROWSER is set) ----------------------------------

let browser = null, browserOk = true;
before(async () => {
  try { browser = await chromium.launch({ executablePath: process.env.NUNCHI_BROWSER || undefined }); }
  catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(async () => { await browser?.close(); });
// the card, measured in one evaluation (live redraws detach handles)
const CARD = () => {
  const c = document.getElementById('h-guards')?.closest('section');
  if (!c) return null;
  return {
    head: document.getElementById('h-guards').textContent, labelled: c.getAttribute('aria-labelledby'),
    rows: [...c.querySelectorAll('li')].map(li => {
      const b = li.querySelector('button'), r = b?.getBoundingClientRect();
      return { text: li.querySelector('.what').textContent, code: [...li.querySelectorAll('code')].map(x => x.textContent),
        button: b ? { text: b.innerText, pressed: b.getAttribute('aria-pressed'), labelledby: b.getAttribute('aria-labelledby'), h: Math.round(r.height), w: Math.round(r.width) } : null };
    }),
    focus: document.activeElement?.id || null, wide: document.documentElement.scrollWidth <= innerWidth,
  };
};
const axeRun = async pg => { await pg.evaluate(AXE); return pg.evaluate(async () => (await globalThis.axe.run(document, { resultTypes: ['violations'] })).violations.map(x => x.id)); };
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

test('board e2e: the card on Progress in the design\'s words, the Add toggle pressed, the chip on Findings; axe light 1280 and dark 390', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = project({ moreDeadLinks: 4 });
  const [c1, c2] = p.by('native-dialog');
  plan(p, [c1, c2]);
  attempt(p, c1, 'fixed');
  attempt(p, c2, 'fixed');
  const b = await startBoard({ projectDir: p.root });
  try {
    for (const [viewport, scheme] of [[{ width: 1280, height: 900 }, 'light'], [{ width: 390, height: 844 }, 'dark']]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      const pg = await context.newPage();
      const errors = [];
      pg.on('pageerror', e => errors.push(String(e)));
      await pg.goto(b.newLink());
      await pg.waitForSelector('#h-guards');
      const m = await pg.evaluate(CARD);
      assert.equal(m.head, 'Stop these coming back?');
      assert.equal(m.labelled, 'h-guards');
      assert.deepEqual(m.rows.map(r => [r.text, r.code, r.button.text, r.button.pressed]), [['window.confirm (fixed twice)', ['window.confirm'], scheme === 'light' ? 'Add' : '✓ Added', scheme === 'light' ? 'false' : 'true']]);
      assert.ok(m.rows.every(r => r.button.h >= 44 && r.button.w >= 44 && r.button.labelledby === 'guard-a-native-dialog guard-l-native-dialog'), JSON.stringify(m.rows));
      // its name is "Add" and its row, pressed or not
      assert.equal(await pg.getByRole('button', { name: 'Add window.confirm (fixed twice)', exact: true, pressed: scheme !== 'light' }).count(), 1);
      assert.ok(m.wide, 'no sideways scroll');
      assert.deepEqual(await axeRun(pg), []);
      if (scheme === 'light') {
        await pg.click('#guard-b-native-dialog');
        await pg.waitForFunction(() => document.getElementById('guard-b-native-dialog')?.getAttribute('aria-pressed') === 'true');
        assert.equal((await pg.evaluate(CARD)).focus, 'guard-b-native-dialog', 'the focus stays on the toggle');
        assert.equal((await pg.evaluate(CARD)).rows[0].button.text, '✓ Added');
        await pg.waitForFunction(() => document.getElementById('announce')?.textContent === 'Added');
        assert.deepEqual(G.readGuards(join(p.nunchi, 'guards.json')).guards, [{ kind: 'native-dialog', params: { calls: ['confirm'] } }]);
        assert.deepEqual(await axeRun(pg), [], 'pressed');
        // the passive chip on the kind's section
        await pg.evaluate(() => { location.hash = '#/findings'; });
        await pg.waitForSelector('.sect-head');
        const chips = await pg.evaluate(() => [...document.querySelectorAll('.sect-head')].map(s => s.querySelector('.tag')?.textContent ?? null));
        assert.deepEqual(chips.filter(Boolean), ['guard available']);
        assert.deepEqual(await axeRun(pg), [], 'findings with the chip');
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await b.close(); }
});

test('the offer waits for the end of the batch, on the board and in fix --summary', () => {
  const p = project();
  const [c1, c2] = p.by('native-dialog'), [d1] = p.by('dead-href');
  plan(p, [c1, c2, d1]);
  attempt(p, c1, 'fixed');
  assert.equal(O.guardOffer({ stateDir: p.stateDir, rows: p.rows, doc: null }), null, 'two groups not started yet');
  const running = R.allocate(p.stateDir, c2, { title: c2 }, { now: T0 + 70e3 });
  assert.equal(O.guardOffer({ stateDir: p.stateDir, rows: p.rows, doc: null }), null, 'one being fixed');
  assert.equal(F.summaryFix(F.openFix({ cwd: p.root })).lines.length, 1, 'no offer in the chat mid-batch');
  R.setPhase(p.stateDir, R.setPhase(p.stateDir, running, 'folding', {}, { now: T0 + 80e3 }), 'fixed', {}, { now: T0 + 81e3 });
  attempt(p, d1, 'reverted', T0 + 90e3);
  assert.deepEqual(O.guardOffer({ stateDir: p.stateDir, rows: p.rows, doc: null }).rows.map(r => r.kind), ['native-dialog']);
  assert.match(F.summaryFix(F.openFix({ cwd: p.root })).lines[1], /^Stop these coming back\? `window.confirm` \(fixed twice\)/);
});

test('the board: a guards.json that cannot be read keeps the rows without toggles and hides the chip; a terminal add is seen live', async () => {
  const p = project({ moreDeadLinks: 4 });
  const [c1] = p.by('native-dialog');
  plan(p, [c1]);
  attempt(p, c1, 'fixed');
  const b = await startBoard({ projectDir: p.root });
  try {
    const s = await (await fetch(`${b.origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: b.origin }, body: JSON.stringify({ code: b.newLink().split('#t=')[1] }) })).json();
    const call = (path, body) => boardRequest(b.origin, path, { token: s.token, body });
    // the person adds the guard in their own terminal: the generation does not move, the board sees it anyway
    const v0 = (await call('/api/generation')).json.version;
    O.changeGuards({ nunchiDir: p.nunchi, stateDir: p.stateDir, change: d => G.addGuard(d, { project: p.root, kind: 'native-dialog', params: { calls: ['confirm'] } }) });
    assert.notEqual((await call('/api/generation')).json.version, v0);
    assert.equal((await call('/api/summary')).json.guards, null, 'guarded now: nothing to offer');
    // a file that cannot be read (a merge conflict, a hand edit)
    writeFileSync(join(p.nunchi, 'guards.json'), '<<<<<<< ours\n{}\n');
    const sum = (await call('/api/summary')).json;
    assert.deepEqual(sum.guards, { title: 'Stop these coming back?', unreadable: true, rows: [{ kind: 'native-dialog', text: '`window.confirm`', added: false }] });
    assert.equal(sum.warnings.filter(w => w.includes('guards.json')).length, 1);
    assert.match(sum.warnings.find(w => w.includes('guards.json')), /^\.nunchi\/guards\.json is not valid JSON/, 'its path once, as the repository names it');
    const list = (await call('/api/groups?status=open&group=kind')).json;
    assert.ok(list.sections.every(x => x.guard === undefined), 'no chip: what the file covers is not known');
    assert.equal((await call('/api/guard', { kind: 'native-dialog', add: true })).status, 409);
    const f = spawnSync(process.execPath, [CLI, 'findings', '--json'], { cwd: p.root, encoding: 'utf8' });
    assert.equal(JSON.parse(f.stdout).kinds.find(k => k.rule === 'dead-href').guard, undefined);
    assert.equal(f.stderr.split('\n').filter(l => l.includes('guards.json')).length, 1);
    assert.match(f.stderr, /nunchi: \.nunchi\/guards\.json is not valid JSON/);
  } finally { await b.close(); }
});

test('board e2e: a toggle in focus whose file turns unreadable leaves the focus on the card; the pressed state shows in forced colours', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = project();
  const [c1, c2] = p.by('native-dialog'), [d1] = p.by('dead-href');
  plan(p, [c1, c2, d1]);
  for (const g of [c1, c2, d1]) attempt(p, g, 'fixed');
  const b = await startBoard({ projectDir: p.root });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, forcedColors: 'active' });
    const pg = await context.newPage();
    await pg.goto(b.newLink());
    await pg.waitForSelector('#guard-b-native-dialog');
    await pg.click('#guard-b-native-dialog');
    await pg.waitForFunction(() => document.getElementById('guard-b-native-dialog')?.getAttribute('aria-pressed') === 'true');
    const look = await pg.evaluate(() => ['native-dialog', 'dead-href'].map(k => { const b = document.getElementById(`guard-b-${k}`), c = getComputedStyle(b); return { text: b.innerText, bg: c.backgroundColor, color: c.color }; }));
    assert.equal(look[0].text, '✓ Added');
    assert.equal(look[1].text, 'Add');
    assert.notEqual(look[0].bg, look[1].bg, 'pressed and not pressed look different in forced colours');
    await pg.focus('#guard-b-dead-href');
    writeFileSync(join(p.nunchi, 'guards.json'), '{"schema":1,"guards":[],"baseline":[],"regex":".*"}\n');
    await pg.waitForFunction(() => !document.getElementById('guard-b-dead-href'), null, { timeout: 15000 });
    assert.equal(await pg.evaluate(() => document.activeElement?.id), 'h-guards', 'the focus stays on the card');
    assert.deepEqual(await pg.evaluate(() => [...document.querySelectorAll('.guard-list li')].map(li => [li.textContent, !!li.querySelector('button')])), [['window.confirm (fixed twice)', false], ['href="#"', false]]);
    assert.deepEqual(await axeRun(pg), []);
    await context.close();
  } finally { await b.close(); }
});
