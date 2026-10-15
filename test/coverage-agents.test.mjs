// Coverage (M7) counts the AI cells of a hunt several agents answered (M6) as it counts one agent's: a cell is seen when
// any agent answered its unit completely (hunt-agents.mjs), so two agents that split a plan's units give Coverage and
// Progress the counts one agent answering every unit gives. Invented content (test/fixtures/hunt-run.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBoard } from '../src/board/server.mjs';
import { checkedScene } from '../src/summary.mjs';
import { huntProject, answerAll, deleteAll } from './fixtures/hunt-run.mjs';
import { tmp } from './fixtures/tmp.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
process.env.XDG_STATE_HOME = tmp('nunchi-coverage-agents-xdg-');

async function counts(p) {
  const b = await startBoard({ projectDir: p.cwd });
  const origin = b.origin;
  try {
    const s = await (await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code: b.newLink().split('#t=')[1] }) })).json();
    const call = async path => (await fetch(origin + path, { headers: { 'x-nunchi-token': s.token } })).json();
    const c = await call('/api/coverage'), sum = await call('/api/summary');
    return { coverage: c.totals.ai, progress: sum.ai.coverage };
  } finally { await b.close(); }
}

// One hunt of the run: `parts` is who answers which planned units (an empty header for the undeclared agent).
function hunt(parts) {
  const p = huntProject();
  const run = (...a) => execFileSync('node', [CLI, ...a], { cwd: p.cwd, encoding: 'utf8' });
  const plan = JSON.parse(run('hunt', '--plan', '--json'));
  const units = plan.units.filter(u => u.status === 'planned');
  parts.forEach(({ who, pick }, i) => {
    const mine = units.filter((u, j) => pick(j, units.length));
    writeFileSync(join(p.cwd, `${i}.json`), JSON.stringify({ plan: plan.id, ...who, units: mine.map(u => answerAll(u, 'none', u.lens === 'L9' && u.scenes.some(s => s.scene === 'tasks.guest.normal.m') ? deleteAll() : {})) }));
    run('hunt', '--record', `${i}.json`);
  });
  return { p, units: units.length };
}

test('coverage: two agents that split a plan\'s units count as one agent answering every unit, on Coverage and Progress alike', async () => {
  const half = (j, n) => j < Math.ceil(n / 2);
  const split = hunt([{ who: { agent: 'Claude Code', vendor: 'Anthropic' }, pick: half }, { who: { agent: 'Codex', vendor: 'OpenAI' }, pick: (j, n) => !half(j, n) }]);
  const one = hunt([{ who: {}, pick: () => true }]);
  assert.ok(split.units >= 2, 'a plan of several units, split between the two');
  const [a, b] = [await counts(split.p), await counts(one.p)];
  assert.deepEqual(a, b, 'the same counts');
  // and they are the record's own cells on checked screens: every one seen
  const cov = JSON.parse(readFileSync(join(split.p.runDir, 'coverage.json'), 'utf8'));
  const scenes = new Map(JSON.parse(readFileSync(join(split.p.runDir, 'manifest.json'), 'utf8')).scenes.map(s => [s.id, s]));
  const onChecked = cov.cells.filter(c => scenes.get(c.scene) && checkedScene(scenes.get(c.scene)));
  assert.deepEqual([a.coverage.seen, a.coverage.of], [onChecked.filter(c => c.status === 'seen').length, onChecked.length]);
  // every planned unit answered by one agent or the other: the cells not seen are only the plan's own (none left unanswered)
  const plan = JSON.parse(readFileSync(join(split.p.runDir, 'hunt-plan.json'), 'utf8'));
  assert.deepEqual(onChecked.filter(c => c.status !== 'seen').map(c => `${c.lens}|${c.scene}|${c.reason}`).sort(), plan.notSeen.filter(n => onChecked.some(c => c.lens === n.lens && c.scene === n.scene)).map(n => `${n.lens}|${n.scene}|${n.reason}`).sort());
  assert.deepEqual(cov.agents.map(x => [x.agent, x.units]), [['Claude Code', Math.ceil(split.units / 2)], ['Codex', split.units - Math.ceil(split.units / 2)]]);
});
