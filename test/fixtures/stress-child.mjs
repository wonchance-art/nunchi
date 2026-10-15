// One process of the M6 concurrency stress tests (test/multi-agent-stress.test.mjs): two of these run at once, each an
// agent in a worktree of its own, and print what they saw as JSON on stdout. Started with a time to wait for, so both
// begin together. Modes:
// - folds <ledger> <generation> <runsDir> <who> <n> <at>: n hunts, each a sweep run written into this worktree's runs
//   folder and folded through the ledger's catch-up (syncLedger: its rule fold, then its AI fold from a loader), one
//   commit each, as `hunt --record` folds; per fold, the ledger's rev just before, the rev it committed and its tries.
// - claim-group | claim-file | claim-expired <stateDir> <who> <rounds> <at>: per round, acquire the round's claim from a
//   folder of its own (the other process does the same at once).
// - renew <stateDir> <rounds> <at>: per round, renew the holder's (expired) claim; take-over <stateDir> <rounds> <at>:
//   per round, take that claim over.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as L from '../../src/ledger.mjs';
import * as C from '../../src/fix/claims.mjs';
import { agentFolds, AGENTS } from './agent-folds.mjs';

const [mode, ...args] = process.argv.slice(2);
const wait = at => { while (Date.now() < Number(at)) { /* both begin together */ } };
const group = (kind, i) => `${kind}${String(i).padStart(11, '0')}`.slice(0, 12);
const out = [];

if (mode === 'folds') {
  const [ledger, generation, runsDir, who, n, at] = args;
  const folds = agentFolds(who, Number(n));
  // the hunt's input as the loader gives it (ai-fold.mjs aiLoader takes it from the run's files; here from one file)
  // each call of `input` for a run is one try of its fold (the store reads, folds and commits, and tries again when the
  // other agent committed in between: at most 4 tries, then once under the lock)
  const tries = new Map();
  const loader = { key: dir => { try { return JSON.parse(readFileSync(join(dir, 'fold.json'), 'utf8')).key; } catch { return null; } },
    input: dir => { tries.set(dir, (tries.get(dir) || 0) + 1); return JSON.parse(readFileSync(join(dir, 'fold.json'), 'utf8')); } };
  const revOf = () => { try { return JSON.parse(readFileSync(ledger, 'utf8')).rev ?? 0; } catch { return 0; } };
  wait(at);
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
    out.push({ run: f.run, before, rev: s.rev, tries: tries.get(dir) || 0 });
  }
} else if (mode.startsWith('claim-')) {
  const [stateDir, who, rounds, at] = args;
  wait(at);
  for (let i = 0; i < Number(rounds); i++) {
    // a folder, an address and a file of this process's own per round: only the conflict under test can refuse
    const port = { 'claim-group': 4000, 'claim-file': 4200, 'claim-expired': 4400 }[mode] + i * 2 + (who === 'a' ? 0 : 1);
    const mine = { worktree: `/w/${mode}/${who}-${i}`, branch: `nunchi/fix-${who}-${i}`, url: `http://127.0.0.1:${port}`, agent: AGENTS[who].agent, vendor: AGENTS[who].vendor };
    const own = `app/${mode}/${who}-${i}.tsx`;
    const r = mode === 'claim-group' ? C.acquireClaim(stateDir, { ...mine, group: group('a', i), files: [own] })
      : mode === 'claim-file' ? C.acquireClaim(stateDir, { ...mine, group: group(who === 'a' ? 'b' : 'c', i), files: [own, `app/${mode}/shared-${i}.tsx`] })
      : C.acquireClaim(stateDir, { ...mine, group: group('d', i), files: [own] });
    out.push({ round: i, ok: r.ok, why: r.why ?? null, token: r.token ?? null });
  }
} else if (mode === 'renew' || mode === 'take-over') {
  const [stateDir, rounds, at] = args;
  const holder = JSON.parse(readFileSync(join(stateDir, 'holder.json'), 'utf8'));
  wait(at);
  for (let i = 0; i < Number(rounds); i++) {
    const g = group('e', i);
    if (mode === 'renew') out.push({ round: i, renewed: C.renewClaim(stateDir, g, holder[i], Date.now()) });
    else { const r = C.acquireClaim(stateDir, { group: g, worktree: `/w/t-${i}`, branch: `nunchi/fix-t-${i}`, url: `http://127.0.0.1:${5000 + i}`, files: [`app/t-${i}.tsx`], agent: 'Codex', now: Date.now() }); out.push({ round: i, ok: r.ok, why: r.why ?? null, token: r.token ?? null }); }
  }
}
process.stdout.write(JSON.stringify(out));
