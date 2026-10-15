// One process of the M6 concurrency stress tests (test/multi-agent-stress.test.mjs): two of these run at once, each an
// agent in a worktree of its own, and print what they saw as JSON on stdout. They meet at a barrier on files (never at
// a time on the clock): each says it is there, then waits until the other is too, so both start together however
// slow either was to load, and the claim modes meet again before every round, so each round is a race. Modes:
// - folds <ledger> <generation> <runsDir> <who> <n> <barrier>: n hunts, each a sweep run written into this worktree's
//   runs folder and folded through the ledger's catch-up (syncLedger: its rule fold, then its AI fold from a loader),
//   one commit each, as `hunt --record` folds; per fold, the ledger's rev just before, the rev it committed, its tries,
//   and the rev read under the lock (a fold that got there).
// - claim-group | claim-file | claim-expired <stateDir> <who> <rounds> <barrier>: per round, acquire the round's claim
//   from a folder of its own (the other process does the same at once).
// - renew <stateDir> <rounds> <barrier>: per round, renew the holder's (expired) claim; take-over <stateDir> <rounds>
//   <barrier>: per round, take that claim over.
// An expired claim expires at its round: `expiry.json` in the state folder ({ base, step }) says the round's claim was
// last renewed at base + i·step, and the round reads the clock at half a step past its expiry. A take-over removes
// every expired claim, so with one time for all a round's take-over would remove the later rounds' claims before
// their race.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as L from '../../src/ledger.mjs';
import * as C from '../../src/fix/claims.mjs';
import { agentFolds, AGENTS } from './agent-folds.mjs';

const [mode, ...args] = process.argv.slice(2);
const OTHER = { a: 'b', b: 'a', renew: 'take-over', 'take-over': 'renew' };
const group = (kind, i) => `${kind}${String(i).padStart(11, '0')}`.slice(0, 12);
const MAX_TRIES = 5;                                   // state.mjs updateDoc: 4 optimistic tries, then once under the lock
const out = [];
let barrier = null, me = null;

// Wait here until the other process is here too (`name`: the meeting, e.g. the start or a round). A process that
// failed says so at the barrier, and the other stops waiting instead of spinning until it is killed. The one that came
// last sees the other at once, so it would always go first: `spread` then waits a seeded 0–2 ms (the same every run),
// so either may go first and some rounds start within microseconds of each other.
let seed = null;
function meet(name, { spread = false } = {}) {
  writeFileSync(join(barrier, `${name}.${me}`), '');
  const there = join(barrier, `${name}.${OTHER[me]}`), failed = join(barrier, 'failed');
  for (;;) {
    if (existsSync(there)) break;
    if (existsSync(failed)) throw new Error('the other process failed');
  }
  if (!spread) return;
  if (seed === null) seed = [...me].reduce((x, c) => (x * 31 + c.charCodeAt(0)) % 2147483648, 7);   // one per process
  seed = (seed * 1103515245 + 12345) % 2147483648;
  const until = performance.now() + (seed % 2000) / 1000;
  while (performance.now() < until) { /* spread the starts */ }
}
// when, on a clock both processes share (ms since the epoch, fractional), to say which rounds overlapped
const at = () => performance.timeOrigin + performance.now();
// the clock a round with an expired claim reads: half a step after that round's claim expired (expiry.json, above)
const expiryOf = (stateDir, i) => { const e = JSON.parse(readFileSync(join(stateDir, 'expiry.json'), 'utf8')); return e.base + i * e.step + C.CLAIM_TTL_MS + e.step / 2; };

function run() {
  if (mode === 'folds') {
    const [ledger, generation, runsDir, who, n] = args;
    [me, barrier] = [who, args[5]];
    const folds = agentFolds(who, Number(n));
    const revOf = () => { try { return JSON.parse(readFileSync(ledger, 'utf8')).rev ?? 0; } catch { return 0; } };
    // the hunt's input as the loader gives it (ai-fold.mjs aiLoader takes it from the run's files; here from one file).
    // Each call of `input` for a run is one try of its fold (the store reads, folds and commits, and tries again when
    // the other agent committed in between: at most 4 tries, then once under the lock, where the rev on disk is the one
    // read, since no one else can write)
    const tries = new Map(), locked = new Map();
    const loader = { key: dir => { try { return JSON.parse(readFileSync(join(dir, 'fold.json'), 'utf8')).key; } catch { return null; } },
      input: dir => { const k = (tries.get(dir) || 0) + 1; tries.set(dir, k); if (k === MAX_TRIES) locked.set(dir, revOf()); return JSON.parse(readFileSync(join(dir, 'fold.json'), 'utf8')); } };
    meet('start');
    for (const f of folds) {
      const dir = join(runsDir, f.run);
      mkdirSync(dir, { recursive: true });
      const scene = { id: `shared~0.guest.normal.m`, route: '/shared/0', person: 'guest', state: 'normal', viewport: 'm', status: 'captured', reason: null, httpStatus: 200 };
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, health: { status: 'ok', problems: [] }, scenes: [scene] }));
      writeFileSync(join(dir, 'findings.json'), JSON.stringify({ schema: 1, findings: [] }));
      writeFileSync(join(dir, 'fold.json'), JSON.stringify({ key: f.key, findings: f.findings, seen: f.seen }));
      writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 1, id: f.run, kind: 'sweep', worktree: AGENTS[who].stream, scope: { routes: ['/shared/0'] }, wholeApp: false }));
      const before = revOf();
      const s = L.syncLedger(ledger, runsDir, { stream: AGENTS[who].stream, generation, now: f.now, timeoutMs: 120000, loaders: { ai: loader } });
      out.push({ run: f.run, before, rev: s.rev, tries: tries.get(dir) || 0, ...(locked.has(dir) ? { locked: locked.get(dir) } : {}) });
    }
  } else if (typeof mode === 'string' && mode.startsWith('claim-')) {
    const [stateDir, who, rounds] = args;
    [me, barrier] = [who, args[3]];
    for (let i = 0; i < Number(rounds); i++) {
      // a folder, an address and a file of this process's own per round: only the conflict under test can refuse
      const port = { 'claim-group': 4000, 'claim-file': 4200, 'claim-expired': 4400 }[mode] + i * 2 + (who === 'a' ? 0 : 1);
      const mine = { worktree: `/w/${mode}/${who}-${i}`, branch: `nunchi/fix-${who}-${i}`, url: `http://127.0.0.1:${port}`, agent: AGENTS[who].agent, vendor: AGENTS[who].vendor };
      const own = `app/${mode}/${who}-${i}.tsx`;
      meet(`${mode}-${i}`, { spread: true });
      const r = mode === 'claim-group' ? C.acquireClaim(stateDir, { ...mine, group: group('a', i), files: [own] })
        : mode === 'claim-file' ? C.acquireClaim(stateDir, { ...mine, group: group(who === 'a' ? 'b' : 'c', i), files: [own, `app/${mode}/shared-${i}.tsx`] })
        : C.acquireClaim(stateDir, { ...mine, group: group('d', i), files: [own], now: expiryOf(stateDir, i) });
      out.push({ round: i, ok: r.ok, why: r.why ?? null, token: r.token ?? null });
    }
  } else if (mode === 'renew' || mode === 'take-over') {
    const [stateDir, rounds] = args;
    [me, barrier] = [mode, args[2]];
    const holder = JSON.parse(readFileSync(join(stateDir, 'holder.json'), 'utf8'));
    for (let i = 0; i < Number(rounds); i++) {
      const g = group('e', i);
      const now = expiryOf(stateDir, i);
      meet(`round-${i}`, { spread: true });
      const from = at();
      if (mode === 'renew') out.push({ round: i, renewed: C.renewClaim(stateDir, g, holder[i], now), from, to: at() });
      else { const r = C.acquireClaim(stateDir, { group: g, worktree: `/w/t-${i}`, branch: `nunchi/fix-t-${i}`, url: `http://127.0.0.1:${5000 + i}`, files: [`app/t-${i}.tsx`], agent: 'Codex', now }); out.push({ round: i, ok: r.ok, why: r.why ?? null, token: r.token ?? null, from, to: at() }); }
    }
  }
}

if (typeof mode === 'string') {                        // nothing when the test runner loads this file as a test
  try { run(); } catch (e) { if (barrier) try { writeFileSync(join(barrier, 'failed'), String(e?.message || e)); } catch {} throw e; }
  process.stdout.write(JSON.stringify(out));
}
