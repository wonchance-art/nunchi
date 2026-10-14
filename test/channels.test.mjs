// Channels (design 0.1-c §1): every decision and approval records how it was made, and only a person's (the board,
// or `nunchi decide` in their own terminal) clears a dismissal from "Ready to ship". Synthetic projects only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from '../src/ledger.mjs';
import * as P from '../src/project.mjs';
import { summary, standingOf } from '../src/summary.mjs';
import { smallProject, writeRun, scene } from './fixtures/board-project.mjs';
import { stableJson } from '../src/stable.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const cli = (cwd, ...a) => new Promise(res => execFile('node', [CLI, ...a], { cwd, encoding: 'utf8' }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
const decisionFiles = nunchi => { try { return readdirSync(join(nunchi, 'decisions'), { recursive: true }).map(String).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(nunchi, 'decisions', f), 'utf8'))); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
const groupOf = (led, rule) => P.ledgerView(led).groups.find(g => g.rule === rule);
const sum = led => { const { rows, groups } = P.ledgerView(led); return summary({ state: led.state, rows, groups, stream: led.st.root.stream, runsDir: led.st.runsDir }); };

test('channels: a decision names its channel and batch; an unknown channel or a bad batch id is refused', () => {
  const d = L.buildDecision({ target: { group: 'a'.repeat(12) }, decision: 'keep', reason: 'intended', by: 'me', channel: 'board', batch: 'b-1' });
  assert.equal(d.channel, 'board');
  assert.equal(d.batch, 'b-1');
  assert.ok(!('channel' in L.buildDecision({ target: { group: 'a'.repeat(12) }, decision: 'fix', by: 'me' })), 'no channel given: none written (older callers)');
  assert.throws(() => L.buildDecision({ target: { group: 'a'.repeat(12) }, decision: 'fix', by: 'me', channel: 'git' }), { code: 'BAD_ARGS' });
  assert.throws(() => L.buildDecision({ target: { group: 'a'.repeat(12) }, decision: 'fix', by: 'me', batch: '../x' }), { code: 'BAD_ARGS' });
});

test('channels: approvals keep the channel they were made with; a confirmation is recorded apart; a bad channels map is not an approval list', () => {
  const p = smallProject();
  const file = join(p.nunchi, 'state', 'approved.json');
  mkdirSync(join(p.nunchi, 'state'), { recursive: true });
  L.addApproved(file, ['a-1:' + '0'.repeat(64)], { channel: 'cli-agent' });
  L.addApproved(file, ['a-1:' + '0'.repeat(64), 'b-2:' + '1'.repeat(64)], { channel: 'board' });
  let r = L.readApprovals(file);
  assert.equal(r.channels.get('a-1:' + '0'.repeat(64)), 'cli-agent', 'approving again does not change how it was made');
  assert.equal(r.channels.get('b-2:' + '1'.repeat(64)), 'board');
  L.addApproved(file, [], { confirm: ['a-1:' + '0'.repeat(64), 'c-3:' + '2'.repeat(64)] });
  r = L.readApprovals(file);
  assert.ok(r.confirmed.has('a-1:' + '0'.repeat(64)));
  assert.ok(r.approved.has('c-3:' + '2'.repeat(64)), 'a decision from git confirmed in the board is approved here too');
  assert.equal(L.isApprovedDoc({ approved: [], channels: { x: 1 } }), false);
  assert.equal(L.isApprovedDoc({ approved: [], channels: { x: 'board' }, confirmed: ['x'] }), true);
  const merged = L.mergeApprovedDocs({ approved: ['x'], channels: { x: 'cli-tty' } }, { approved: ['y'], channels: { y: 'board', x: 'cli-agent' } });
  assert.deepEqual(merged.channels, { x: 'cli-tty', y: 'board' });
});

test('channels: the view says how each decision was made — board and terminal are a person, the agent and git are not, until confirmed', () => {
  const p = smallProject();
  const led = P.loadLedger(p.nunchi, { root: p.root });
  const high = groupOf(led, 'raw-error-text'), medium = groupOf(led, 'dead-href'), low = groupOf(led, 'target-size-min');
  P.recordDecisions(led, { targets: [{ group: high.group }], decision: 'keep', reason: 'intended', by: 'me', channel: 'cli-agent' });
  P.recordDecisions(led, { targets: [{ group: medium.group }], decision: 'false-positive', reason: 'not-a-problem', by: 'me', channel: 'board' });
  // one from git: a file nobody approved here
  const forged = L.buildDecision({ target: { group: low.group }, decision: 'keep', reason: 'intended', by: 'someone else', channel: 'board' });
  L.saveDecision(join(p.nunchi, 'decisions'), forged);
  let again = P.loadLedger(p.nunchi, { root: p.root });
  let rows = P.ledgerView(again).rows;
  const dec = g => rows.find(r => r.group === g.group).decision;
  assert.deepEqual([dec(high).channel, dec(high).human], ['cli-agent', false]);
  assert.deepEqual([dec(medium).channel, dec(medium).human], ['board', true]);
  assert.deepEqual([dec(low).channel, dec(low).human], ['git', false], 'a file from git that claims "board" is not a board decision');
  const s = sum(again);
  assert.deepEqual(s.confirm.map(c => c.group).sort(), [high.group, low.group].sort());
  assert.match(s.verdict.text, /^Not yet · 1 blocker, 1 high: .*1 to confirm/);
  // confirmed in the board: a person's now
  P.confirmDecisions(again, s.confirm.map(c => c.key));
  again = P.loadLedger(p.nunchi, { root: p.root });
  rows = P.ledgerView(again).rows;
  assert.deepEqual([dec(high).human, dec(low).human, dec(low).verified], [true, true, true]);
  assert.equal(sum(again).confirm.length, 0);
});

test('channels: an approval from before channels existed is "unknown" and waits for a confirmation', () => {
  const p = smallProject();
  const led = P.loadLedger(p.nunchi, { root: p.root });
  const high = groupOf(led, 'raw-error-text');
  const d = L.saveDecision(join(p.nunchi, 'decisions'), L.buildDecision({ target: { group: high.group }, decision: 'keep', reason: 'intended', by: 'me' }));
  writeFileSync(join(p.nunchi, 'state', 'approved.json'), stableJson({ schema: 2, approved: [L.approvalKey(d)] }));
  const again = P.loadLedger(p.nunchi, { root: p.root });
  const row = P.ledgerView(again).rows.find(r => r.group === high.group);
  assert.deepEqual([row.status, row.decision.channel, row.decision.human], ['kept', 'unknown', false], 'still shown as kept (recorded and shown, design §1)');
  assert.equal(standingOf(P.ledgerView(again).groups.find(g => g.group === high.group), P.ledgerView(again).rows), 'confirm');
});

test('channels: `nunchi decide` run by the agent (no terminal) is cli-agent, says the dismissal waits for the board, and accepts the board\'s words', async () => {
  const p = smallProject();
  const led = P.loadLedger(p.nunchi, { root: p.root });
  const high = groupOf(led, 'raw-error-text'), low = groupOf(led, 'target-size-min'), med = groupOf(led, 'dead-href');
  const r = await cli(p.root, 'decide', high.group, 'not-a-problem');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /recorded by your AI: it counts for "ready to ship" once you confirm it in the board/);
  const later = await cli(p.root, 'decide', low.group, 'later', '--from-chat', '--json');
  assert.equal(later.code, 0, later.stderr);
  assert.equal(JSON.parse(later.stdout)[0].decision, 'hold');
  const files = decisionFiles(p.nunchi);
  const fp = files.find(d => d.target.group === high.group);
  assert.deepEqual([fp.decision, fp.reason, fp.channel], ['false-positive', 'not-a-problem', 'cli-agent']);
  const approvals = JSON.parse(readFileSync(join(p.nunchi, 'state', 'approved.json'), 'utf8'));
  assert.equal(approvals.channels[L.approvalKey(fp)], 'cli-agent');
  const f = await cli(p.root, 'findings', '--json');
  const s = JSON.parse(f.stdout).summary;
  assert.equal(s.confirm.length, 1);
  assert.match(s.verdict.text, /1 to confirm/);
  const text = await cli(p.root, 'findings');
  assert.match(text.stdout, /ready to ship\? Not yet · 1 blocker, 1 high: 1 to decide, 1 to confirm/);
  assert.match(text.stdout, /1 decision\(s\) recorded by the AI or from git wait for you to confirm them in the board/);
  // a reason the decision does not take is refused before anything is written
  const bad = await cli(p.root, 'decide', med.group, 'keep');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /needs --reason intended \| out-of-scope/);
  // and a reason the decision does not take, as the board refuses it (one check, in buildDecision)
  const before = readdirSync(join(p.nunchi, 'decisions'), { recursive: true }).length;
  for (const words of [['fix', '--reason', 'intended'], ['later', '--reason', 'intended'], ['reopen', '--reason', 'not-a-problem']]) {
    const r = await cli(p.root, 'decide', med.group, ...words);
    assert.equal(r.code, 1, words.join(' '));
    assert.match(r.stderr, /takes no reason/, words.join(' '));
  }
  assert.equal(readdirSync(join(p.nunchi, 'decisions'), { recursive: true }).length, before, 'nothing written');
  assert.throws(() => L.buildDecision({ target: { group: med.group }, decision: 'fix', reason: 'intended', by: 'x' }), /"fix" takes no reason/);
  assert.equal(L.reasonProblem('keep', 'intended'), null);
});

test('summary: a redirected screen is not checked, for the verdict and the counts alike (checked + not seen = all)', () => {
  const p = smallProject();
  const mf = join(p.nunchi, 'runs', '0001', 'manifest.json');
  const m = JSON.parse(readFileSync(mf, 'utf8'));
  const captured = m.scenes.filter(s => s.status === 'captured');
  captured[0].reason = 'redirected to /login';
  writeFileSync(mf, JSON.stringify(m));
  let led = P.loadLedger(p.nunchi, { root: p.root });
  const { groups } = P.ledgerView(led);
  const board = (g, decision, reason = null) => P.recordDecisions(P.loadLedger(p.nunchi, { root: p.root }), { targets: [{ group: g.group }], decision, reason, by: 'me', channel: 'board' });
  board(groups.find(g => g.rule === 'secret-in-client-bundle'), 'false-positive', 'not-a-problem');
  board(groups.find(g => g.rule === 'raw-error-text'), 'keep', 'intended');
  led = P.loadLedger(p.nunchi, { root: p.root });
  led.state.folds.push({ run: '0001', source: 'ai', key: 'k', stream: 'main' });
  const { rows, groups: gs } = P.ledgerView(led);
  const s = summary({ state: led.state, rows, groups: gs, runsDir: led.st.runsDir });
  const sc = s.health.scenes;
  assert.equal(sc.checked + sc.notSeen, sc.total, 'every screen is either checked or not seen');
  assert.equal(s.verdict.text, `Yes, for what was checked · ${sc.notSeen} screens not checked`);
  assert.ok(sc.reasons.includes('redirected to /login'));
});

test('summary: the verdict names what stands in the way, then the AI review, then screens not checked; a running capture is too early', () => {
  const p = smallProject();
  let led = P.loadLedger(p.nunchi, { root: p.root });
  assert.equal(sum(led).verdict.text, 'Not yet · 1 blocker, 1 high: 2 to decide');
  const { groups } = P.ledgerView(led);
  const board = (g, decision, reason = null) => P.recordDecisions(P.loadLedger(p.nunchi, { root: p.root }), { targets: [{ group: g.group }], decision, reason, by: 'me', channel: 'board' });
  board(groups.find(g => g.rule === 'secret-in-client-bundle'), 'fix');
  board(groups.find(g => g.rule === 'raw-error-text'), 'hold');
  led = P.loadLedger(p.nunchi, { root: p.root });
  assert.equal(sum(led).verdict.text, 'Not yet · 1 blocker, 1 high: 1 waiting for the AI, 1 later');
  board(groups.find(g => g.rule === 'secret-in-client-bundle'), 'false-positive', 'not-a-problem');
  board(groups.find(g => g.rule === 'raw-error-text'), 'keep', 'intended');
  led = P.loadLedger(p.nunchi, { root: p.root });
  const s = sum(led);
  assert.equal(s.verdict.text, 'Probably · rules only — the AI review hasn’t run');
  assert.equal(s.since.label, 'First full check (run 0001)');
  assert.equal(s.toDecide, 2, 'the two medium and low groups are still open');
  // the AI review ran (an ai fold of the run): screens not checked are named
  led.state.folds.push({ run: '0001', source: 'ai', key: 'k', stream: 'main' });
  const { rows, groups: gs } = P.ledgerView(led);
  assert.equal(summary({ state: led.state, rows, groups: gs, runsDir: led.st.runsDir }).verdict.text, 'Yes, for what was checked · 1 screen not checked');
  mkdirSync(join(p.nunchi, 'runs', '0002.partial'));
  assert.equal(summary({ state: led.state, rows, groups: gs, runsDir: led.st.runsDir }).verdict.text, 'Too early to say · a capture is running');
});

test('summary: since the last full check counts what the runs after the previous full check found; the handoff appears once all is decided', () => {
  const p = smallProject();
  let led = P.loadLedger(p.nunchi, { root: p.root });
  // run 0002: the raw error is gone, a new one appears; every screen captured
  const scenes = p.scenes.filter(s => s.status === 'captured');
  writeRun(p.root, '0002', { scenes, parent: '0001', findings: [
    ...p.findings.filter(f => f.rule !== 'raw-error-text').map(({ fp, group, ...f }) => f),
    { lens: 'L1', rule: 'clipped-text', severity: 'medium', scene: scenes[2].id, route: '/garden', viewport: 'd', selector: 'h2', box: null, evidence: { text: 'Garden beds' } },
  ] });
  led = P.loadLedger(p.nunchi, { root: p.root });
  let s = sum(led);
  assert.equal(s.since.label, 'Since last full check (run 0001)');
  assert.deepEqual([s.since.new, s.since.fixed, s.since.back], [1, 1, 0]);
  const { groups } = P.ledgerView(led);
  const open = groups.filter(g => g.status === 'open');
  P.recordDecisions(led, { targets: open.map(g => ({ group: g.group })), decision: 'fix', by: 'me', channel: 'board', batch: 'b1' });
  s = sum(P.loadLedger(p.nunchi, { root: p.root }));
  assert.equal(s.toDecide, 0);
  assert.equal(s.handoff.text, `All decided. ${open.length} to fix. Go back to your AI chat and say “fix them”.`);
  // one decision file per group, sharing the batch id
  const files = decisionFiles(p.nunchi);
  assert.equal(files.filter(d => d.batch === 'b1').length, open.length);
});

test('summary: findings --json and the summary agree, deterministically (the same summary twice)', async () => {
  const p = smallProject();
  const one = JSON.parse((await cli(p.root, 'findings', '--json')).stdout).summary;
  const two = JSON.parse((await cli(p.root, 'findings', '--json')).stdout).summary;
  assert.deepEqual(one, two);
  assert.deepEqual(one, sum(P.loadLedger(p.nunchi, { root: p.root })));
  assert.equal(one.bySeverity.blocker, 1);
  assert.equal(one.health.scenes.notSeen, 1);
  assert.deepEqual(scene('/', 'guest', 'normal', 'd').id, '~.guest.normal.d');
});

// The person's own terminal (design §1 cli-tty): stdin and stdout TTYs plus the typed code. A pseudo-terminal stands in
// for the person here (util-linux `script`); the deny hook keeps the agent from doing the same (test/deny-hook.test.mjs).
const hasScript = (() => { try { return process.platform === 'linux' && execFileSync('script', ['--version'], { encoding: 'utf8' }).includes('util-linux'); } catch { return false; } })();
test('channels: nunchi decide in a terminal shows a 4-character code; typed back it records cli-tty (a person), anything else records nothing', { skip: !hasScript && 'needs util-linux script (Linux)', timeout: 30000 }, async () => {
  const p = smallProject();
  const g = groupOf(P.loadLedger(p.nunchi, { root: p.root }), 'raw-error-text').group;
  const typed = answer => new Promise(res => {
    const c = spawn('script', ['-qfec', `node ${JSON.stringify(CLI)} decide ${g} keep --reason intended`, '/dev/null'], { cwd: p.root });
    let out = '', sent = false;
    c.stdout.on('data', d => { out += d; const m = /Type ([A-Z0-9]{4}) to confirm/.exec(out); if (m && !sent) { sent = true; c.stdin.write(`${answer ?? m[1]}\n`); } });
    c.on('close', code => res({ code, out, code4: /Type ([A-Z0-9]{4})/.exec(out)?.[1] }));
  });
  const wrong = await typed('NOPE');
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.code4, /^[ACDEFHJKMNPRTUVWXY34679]{4}$/);
  assert.match(wrong.out, /not recorded/);
  assert.equal(decisionFiles(p.nunchi).length, 0);
  const right = await typed(null);
  assert.equal(right.code, 0, right.out);
  const [d] = decisionFiles(p.nunchi);
  assert.equal(d.channel, 'cli-tty');
  const row = P.ledgerView(P.loadLedger(p.nunchi, { root: p.root })).rows.find(r => r.group === g);
  assert.deepEqual([row.decision.channel, row.decision.human], ['cli-tty', true]);
});
