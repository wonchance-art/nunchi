// Runs (design 0.1-c §7, M6): only runs on the tracked branch fold as sweeps; a capture on a nunchi fix branch is a fix
// probe (M3), and a hunt of it is recorded in its run, never folded into the ledger as a sweep's, and said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as P from '../src/project.mjs';
import { huntProject, answerAll, tmp } from './fixtures/hunt-run.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
process.env.XDG_STATE_HOME = tmp('nunchi-runs-probes-xdg-');

test('a hunt of a fix probe (a capture on a fix branch) is recorded in its run and never folded as a sweep\'s, and said', () => {
  const p = huntProject();
  const meta = JSON.parse(readFileSync(join(p.runDir, 'run.json'), 'utf8'));
  writeFileSync(join(p.runDir, 'run.json'), JSON.stringify({ ...meta, kind: 'fix-probe', fixBranch: 'nunchi/fixes-1015' }));
  const run = (...a) => spawnSync('node', [CLI, 'hunt', ...a], { cwd: p.cwd, encoding: 'utf8' });
  const plan = JSON.parse(run('--plan', '--run', '0001', '--lens', 'L9', '--json').stdout);
  writeFileSync(join(p.cwd, 'a.json'), JSON.stringify({ plan: plan.id, agent: 'Codex', units: [answerAll(plan.units[0], 'none')] }));
  const r = run('--record', 'a.json', '--run', '0001');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /nunchi: the AI hunt not folded into the ledger: it is a fix-probe run: only a sweep folds its AI findings/);
  assert.ok(JSON.parse(readFileSync(join(p.runDir, 'ai-findings.json'), 'utf8')), 'recorded in the run');
  const led = P.loadLedger(join(p.cwd, '.nunchi'), { root: p.cwd });
  assert.equal(led.state.folds.some(f => f.source === 'ai'), false, 'never folded');
});
