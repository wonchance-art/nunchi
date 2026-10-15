// Several agents at once, under load (design 0.1-c §12 M6 "done when": concurrency stress tests, 2 × 50 folds, claim
// conflicts). Two processes, each an agent in a worktree of its own (test/fixtures/stress-child.mjs), start together:
// they meet at a barrier on files, never at a time on the clock, and the claim tests meet again before every round, so
// each round is a race. Everything is counted, never timed: a slow machine waits longer, it does not fail.
// - Folds: 50 hunts each, folded through the ledger's catch-up as `hunt --record` folds them. No fold lost, no item
//   twice, and the ledger is the one the same folds give one after the other. Fairness, not speed: every fold done in
//   at most 5 tries, and none overtaken once under the lock; overtakes (the other process's commits between a fold's
//   first read and its own commit) are said, with a bound that only a starved fold would reach.
// - Claims: the same group, the same file, an expired claim, and a renewal racing a take-over: one winner each time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../src/fix/claims.mjs';
import { readGeneration } from '../src/state.mjs';
import { stableJson } from '../src/stable.mjs';
import { AGENTS } from './fixtures/agent-folds.mjs';
import { tmp } from './fixtures/tmp.mjs';

const CHILD = fileURLToPath(new URL('./fixtures/stress-child.mjs', import.meta.url));
const child = args => new Promise(res => execFile(process.execPath, [CHILD, ...args.map(String)], { encoding: 'utf8', timeout: 200000, maxBuffer: 16 * 1024 * 1024 },
  (err, stdout, stderr) => { let out = null; try { out = JSON.parse(stdout); } catch {} res({ code: err ? err.code ?? 1 : 0, stderr, out }); }));
// both at once, each given the same new barrier folder (the last argument)
const both = async (a, b) => { const bar = tmp('nunchi-stress-barrier-'); const r = await Promise.all([child([...a, bar]), child([...b, bar])]); for (const x of r) assert.equal(x.code, 0, x.stderr); return r.map(x => x.out); };
// one alone: the other is "there" already
const alone = async (args, other) => { const bar = tmp('nunchi-stress-alone-'); writeFileSync(join(bar, `start.${other}`), ''); const r = await child([...args, bar]); assert.equal(r.code, 0, r.stderr); return r.out; };
const N = 50;
// A fair store (state.mjs updateDoc): a fold is tried at most 4 times while others commit, then once under the lock,
// whose waiters take turns, and under the lock no one else commits. How many of the other agent's commits fit in its
// tries depends on the machine (a 2-vCPU runner that puts one process aside for a while sees many), so that bound only
// catches a fold starved for most of the other agent's run (measured here: at most 5 to 11).
const MAX_TRIES = 5, MAX_OVERTAKES = 40;

function foldsInto(dir) {
  const state = join(dir, 'state');
  mkdirSync(state, { recursive: true });
  return { ledger: join(state, 'ledger.json'), gen: join(state, 'generation'), runs: who => join(dir, who === 'a' ? 'main' : 'two', '.nunchi', 'runs') };
}

test('2 × 50 folds from two agents in two worktrees at once: no fold lost, no item twice, the ledger the folds give one after the other; overtakes bounded', async t => {
  const at = foldsInto(tmp('nunchi-stress-folds-'));
  const [a, b] = await both(['folds', at.ledger, at.gen, at.runs('a'), 'a', N], ['folds', at.ledger, at.gen, at.runs('b'), 'b', N]);
  const final = JSON.parse(readFileSync(at.ledger, 'utf8'));
  // no fold lost: one commit per hunt, each run's rule and AI fold under its own worktree's stream
  assert.equal(final.rev, 2 * N, 'one commit per fold');
  assert.equal(readGeneration(at.gen), 2 * N);
  for (const who of ['a', 'b']) for (const source of ['rule', 'ai']) assert.equal(final.folds.filter(f => f.source === source && f.stream === AGENTS[who].stream).length, N, `${who} ${source}`);
  assert.equal(new Set([...a, ...b].map(x => x.rev)).size, 2 * N, 'every commit its own rev');
  // they did run at once: each process committed while the other was still folding
  const range = list => [Math.min(...list.map(x => x.rev)), Math.max(...list.map(x => x.rev))];
  const [ra, rb] = [range(a), range(b)];
  assert.ok(ra[0] < rb[1] && rb[0] < ra[1], `the commits interleave (a ${ra}, b ${rb})`);
  // no item twice: each shared defect is one item, claimed by both agents in both worktrees
  const ai = Object.values(final.items).filter(i => i.source === 'ai');
  assert.equal(ai.length, 10 + 2 * N + N / 5, 'ten shared, one of its own per hunt, every fifth hunt a disputed one');
  for (let k = 0; k < 10; k++) {
    const items = ai.filter(i => i.route === `/shared/${k}`);
    assert.equal(items.length, 1, `/shared/${k}`);
    assert.deepEqual(items[0].agents.map(x => x.agent), ['Claude Code', 'Codex']);
    assert.deepEqual([...new Set(items[0].hunts.filter(h => !h.silent).map(h => h.stream))].sort(), ['main', 'wt:two']);
  }
  assert.equal(final.dormant, undefined, 'every rejection found its claim');
  // the ledger the same folds give one after the other (the same child, Claude Code's hunts first, then Codex's)
  const seq = foldsInto(tmp('nunchi-stress-seq-'));
  await alone(['folds', seq.ledger, seq.gen, seq.runs('a'), 'a', N], 'b');
  await alone(['folds', seq.ledger, seq.gen, seq.runs('b'), 'b', N], 'a');
  assert.equal(stableJson(final), readFileSync(seq.ledger, 'utf8'), 'byte for byte');
  // fairness, counted: commits of the other agent between a fold's read and its commit
  const overtakes = [...a, ...b].map(x => x.rev - x.before - 1);
  const worst = Math.max(...overtakes), tries = [...a, ...b].map(x => x.tries);
  t.diagnostic(`overtakes per fold: max ${worst}, mean ${(overtakes.reduce((x, y) => x + y, 0) / overtakes.length).toFixed(2)}, folds overtaken at all ${overtakes.filter(x => x > 0).length} of ${overtakes.length}; tries per fold: max ${Math.max(...tries)}, folds that went under the lock ${tries.filter(x => x === MAX_TRIES).length}`);
  assert.ok(tries.every(x => x >= 1 && x <= MAX_TRIES), `every fold done in at most ${MAX_TRIES} tries (${Math.max(...tries)})`);
  const locked = [...a, ...b].filter(x => x.tries === MAX_TRIES);
  assert.ok(locked.every(x => x.rev === x.locked + 1), 'under the lock, no one else commits: its commit follows the rev it read');
  assert.ok(worst <= MAX_OVERTAKES, `overtaken at most ${worst} times (of ${N} commits by the other agent); bound ${MAX_OVERTAKES}`);
  assert.deepEqual(readdirSync(join(at.ledger, '..')).sort(), ['generation', 'ledger.json', 'ledger.json.prev'], 'no lock, ticket or temp file left');
});

const ROUNDS = 25;
// Expired claims, one per round, each expiring at its round: the round's claim last renewed at base + i·step (31
// minutes ago and on), its round reading the clock half a step after it expired (stress-child.mjs expiryOf), so a
// round's take-over, which removes every expired claim, never removes a later round's before its race.
// `make(i, lastRenewal)` makes round i's claim.
const STEP = 2000;
function expiring(sd, make) {
  const base = Date.now() - 31 * 60e3;
  writeFileSync(join(sd, 'expiry.json'), JSON.stringify({ base, step: STEP }));
  for (let i = 0; i < ROUNDS; i++) assert.ok(make(i, base + i * STEP), `round ${i}'s claim`);
}
const claimsOf = sd => readdirSync(join(sd, 'claims')).filter(n => n.endsWith('.json')).map(n => ({ group: n.slice(0, 12), claim: JSON.parse(readFileSync(join(sd, 'claims', n), 'utf8')) }));
const markersOf = sd => readdirSync(join(sd, 'claims', 'files')).map(n => JSON.parse(readFileSync(join(sd, 'claims', 'files', n), 'utf8')));
const group = (kind, i) => `${kind}${String(i).padStart(11, '0')}`.slice(0, 12);

test('claim conflicts between two agents at once: the same group, the same file, an expired claim: one winner each, the other told why, no marker left behind', async t => {
  const sd = tmp('nunchi-stress-claims-');
  mkdirSync(join(sd, 'claims', 'files'), { recursive: true });
  for (const [mode, loserWhy] of [['claim-group', 'group'], ['claim-file', 'file'], ['claim-expired', 'group']]) {
    // an expired claim per round, made now so the claims before do not remove it, each expiring at its round
    if (mode === 'claim-expired') expiring(sd, (i, now) => C.acquireClaim(sd, { group: group('d', i), worktree: `/w/old-${i}`, branch: 'b', url: `http://127.0.0.1:${6000 + i}`, files: [`app/old-${i}.tsx`], agent: 'Gone', now }).ok);
    const [a, b] = await both([mode, sd, 'a', ROUNDS], [mode, sd, 'b', ROUNDS]);
    t.diagnostic(`${mode}: Claude Code won ${a.filter(x => x.ok).length}, Codex ${b.filter(x => x.ok).length} of ${ROUNDS}`);
    for (let i = 0; i < ROUNDS; i++) {
      const won = [a[i], b[i]].filter(x => x.ok);
      assert.equal(won.length, 1, `${mode} round ${i}: one winner (${JSON.stringify([a[i], b[i]])})`);
      assert.equal([a[i], b[i]].find(x => !x.ok).why, loserWhy, `${mode} round ${i}: the other told why`);
    }
  }
  // every claim on disk is whole and live, one per group; every marker belongs to a live claim's token
  const live = claimsOf(sd);
  assert.ok(live.every(x => C.claimLive(x.claim)), 'the expired ones were taken over');
  assert.equal(live.length, 3 * ROUNDS);
  const tokens = new Map(live.map(x => [x.group, x.claim.token]));
  const markers = markersOf(sd);
  assert.equal(markers.length, ROUNDS + 2 * ROUNDS + ROUNDS, 'one per file claimed, the loser\'s own marker removed, the expired claims\' gone');
  assert.ok(markers.every(m => tokens.get(m.group) === m.token), 'no marker of a loser or of an expired claim');
  assert.ok(!markers.some(m => /^app\/old-/.test(m.file)));
});

test('a renewal racing a take-over at the moment of expiry: exactly one of them wins, never both, never neither', async t => {
  const sd = tmp('nunchi-stress-renew-');
  mkdirSync(join(sd, 'claims', 'files'), { recursive: true });
  const holder = [];
  expiring(sd, (i, now) => (holder[i] = C.acquireClaim(sd, { group: group('e', i), worktree: `/w/h-${i}`, branch: 'b', url: `http://127.0.0.1:${7000 + i}`, files: [`app/h-${i}.tsx`], agent: 'Claude Code', now }).token));
  writeFileSync(join(sd, 'holder.json'), JSON.stringify(holder));
  const [h, tk] = await both(['renew', sd, ROUNDS], ['take-over', sd, ROUNDS]);
  const outcomes = { renewed: 0, taken: 0 };
  for (let i = 0; i < ROUNDS; i++) {
    assert.ok(h[i].renewed !== tk[i].ok, `round ${i}: one of them (${JSON.stringify([h[i], tk[i]])})`);
    if (!tk[i].ok) assert.equal(tk[i].why, 'group');
    const now = C.readClaim(sd, group('e', i));
    assert.equal(now.token, tk[i].ok ? tk[i].token : holder[i], `round ${i}: the claim is the winner's`);
    outcomes[tk[i].ok ? 'taken' : 'renewed']++;
  }
  // after a take-over the old holder's renewal never brings it back
  for (let i = 0; i < ROUNDS; i++) if (tk[i].ok) assert.equal(C.renewClaim(sd, group('e', i), holder[i]), false);
  assert.equal(outcomes.renewed + outcomes.taken, ROUNDS);
  // they raced: both met before every round; rounds whose two attempts overlapped in time are counted (a shared clock)
  const overlapped = h.filter((x, i) => x.from < tk[i].to && tk[i].from < x.to).length;
  t.diagnostic(`renewed first ${outcomes.renewed}, taken over first ${outcomes.taken} of ${ROUNDS}; the two attempts overlapped in ${overlapped} round(s)`);
});
