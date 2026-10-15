// Board activity (design 0.1-c §7 "Board activity", §3.4 "Now", M6): AI hunts in progress, per worktree, run and
// declared agent, with their progress ("Codex · AI review L6 · 12/40 units · 3 min"); a hunt that goes quiet drops out
// by the reader's clock; a second plan never leaves another agent's running hunt answering an old one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as Act from '../src/activity.mjs';
import * as P from '../src/project.mjs';
import { startBoard } from '../src/board/server.mjs';
import { smallProject } from './fixtures/board-project.mjs';
import { huntProject, answerAll, answerSome, tmp } from './fixtures/hunt-run.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
process.env.XDG_STATE_HOME = tmp('nunchi-activity-xdg-');
const T = Date.parse('2026-10-15T01:00:00Z');
const hunt = (over = {}) => ({ agent: 'Codex', vendor: 'OpenAI', stream: 'main', run: '0007', plan: 'p1', lenses: ['L6'], units: 40, answered: 12, complete: 12, now: T, ...over });

test('activity: a hunt in progress, its words, and its end: every planned unit answered, or 30 minutes without a word (the reader\'s clock)', () => {
  const sd = tmp('nunchi-activity-');
  Act.noteHunt(sd, hunt({ answered: 0, complete: 0, now: T - 3 * 60e3 }));
  const h = Act.noteHunt(sd, hunt());
  assert.equal(Act.huntLine(h, T), 'Codex · AI review L6 · 12/40 units · 3 min', 'the design\'s words; minutes since it started');
  assert.equal(Act.huntLine({ ...h, declaredAgent: null, startedAt: h.lastActivity, lenses: ['L1', 'L2', 'L6', 'L9', 'L10'] }, T + 20e3), 'Your AI · AI review L1, L2, L6 +2 · 12/40 units · just started');
  assert.deepEqual(Act.listHunts(sd, T).map(x => [x.hunt.declaredAgent, x.running]), [['Codex', true]]);
  assert.equal(Act.listHunts(sd, T + 31 * 60e3)[0].running, false, 'quiet for 31 minutes: no longer shown, with no write');
  // a second agent on the same run and plan: each its own record; how many units any agent answered is shared
  Act.noteHunt(sd, hunt({ agent: 'Claude Code', vendor: 'Anthropic', lenses: ['L1', 'L9'], answered: 28, complete: 40, now: T + 60e3 }));
  assert.deepEqual(Act.listHunts(sd, T + 60e3).map(x => [x.hunt.declaredAgent, x.hunt.answered, x.hunt.complete, x.running]).sort(), [['Claude Code', 28, 40, false], ['Codex', 12, 40, false]], 'every planned unit answered: done for both');
  // a record past 30 minutes is removed by the next write
  Act.noteHunt(sd, hunt({ run: '0009', now: T + 40 * 60e3 }));
  assert.deepEqual(Act.listHunts(sd, T + 40 * 60e3).map(x => x.hunt.run), ['0009']);
});

test('activity: progress from the run\'s records: planned units only, this agent\'s part and everyone\'s', () => {
  const plan = { units: [{ id: 'u1', lens: 'L6', status: 'planned' }, { id: 'u2', lens: 'L9', status: 'planned' }, { id: 'u3', lens: 'L1', status: 'planned' }, { id: 'u4', lens: 'L1', status: 'not-seen' }] };
  const rec = (agent, units) => ({ agent, cells: units.map(unit => ({ unit, status: 'seen' })) });
  const records = [rec('Codex', ['u1', 'u4']), rec('Claude Code', ['u2'])];
  assert.deepEqual(Act.huntProgress(plan, records, 'codex'), { lenses: ['L6'], units: 3, answered: 1, complete: 2 });
  assert.deepEqual(Act.huntProgress(plan, records, 'Gemini'), { lenses: ['L1', 'L6', 'L9'], units: 3, answered: 0, complete: 2 }, 'no part yet: the plan\'s lenses');
});

test('cli: hunt --plan starts the hunt under the declared agent, each hunt --record moves it on, and the last answer ends it', () => {
  const p = huntProject();
  const run = (...a) => execFileSync('node', [CLI, 'hunt', ...a], { cwd: p.cwd, encoding: 'utf8' });
  const plan = JSON.parse(run('--plan', '--lens', 'L9', '--agent', 'Codex', '--vendor', 'OpenAI', '--json'));
  const sd = P.stateOf(join(p.cwd, '.nunchi')).root.dir;
  const now = () => Act.listHunts(sd).filter(x => x.running).map(x => Act.huntLine(x.hunt));
  const planned = plan.units.filter(u => u.status === 'planned');
  assert.deepEqual(now(), [`Codex · AI review L9 · 0/${planned.length} units · just started`]);
  writeFileSync(join(p.cwd, 'a.json'), JSON.stringify({ plan: plan.id, agent: 'Codex', vendor: 'OpenAI', units: [answerAll(planned[0], 'none'), ...planned.slice(1).map(u => answerSome(u, 'none'))] }));
  run('--record', 'a.json');
  assert.deepEqual(now(), planned.length > 1 ? [`Codex · AI review L9 · 1/${planned.length} units · just started`] : []);
  writeFileSync(join(p.cwd, 'a.json'), JSON.stringify({ plan: plan.id, agent: 'Codex', vendor: 'OpenAI', units: planned.map(u => answerAll(u, 'none')) }));
  run('--record', 'a.json');
  assert.deepEqual(now(), [], 'every planned unit answered: no longer in progress');
  assert.equal(JSON.parse(readFileSync(join(sd, 'hunts', `${Act.huntId({ stream: 'main', run: '0001', agent: 'Codex' })}.json`), 'utf8')).declaredVendor, 'OpenAI');
  // a name that is not one is refused before anything is written
  const bad = spawnSync('node', [CLI, 'hunt', '--plan', '--agent', 'x'.repeat(41)], { cwd: p.cwd, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--agent must be at most 40 characters/);
});

test('cli: a second plan is refused while another agent hunts this run with the plan on disk (one plan per run); the same plan, or the same agent, goes on', () => {
  const p = huntProject();
  const plan = (...a) => spawnSync('node', [CLI, 'hunt', '--plan', '--json', ...a], { cwd: p.cwd, encoding: 'utf8' });
  const first = plan('--lens', 'L9', '--agent', 'Codex');
  assert.equal(first.status, 0, first.stderr);
  const id = JSON.parse(first.stdout).id;
  const other = plan('--lens', 'L6', '--agent', 'Claude Code');
  assert.equal(other.status, 1);
  assert.match(other.stderr, new RegExp(`^nunchi hunt: Codex is hunting this run right now \\(AI review L9 · 0/\\d+ units · just started\\) with the plan in hunt-plan\\.json \\(plan ${id}\\)\\. Answer that plan's units`));
  assert.equal(JSON.parse(readFileSync(join(p.runDir, 'hunt-plan.json'), 'utf8')).id, id, 'the plan on disk is Codex\'s still');
  assert.equal(plan('--lens', 'L6', '--agent', 'codex').status, 0, 'Codex itself may plan again (case aside)');
  assert.equal(plan('--lens', 'L6', '--agent', 'Claude Code').status, 0, 'the same plan: Claude Code joins it');
  const again = plan('--lens', 'L9', '--agent', 'Codex');
  assert.equal(again.status, 1, 'now Claude Code hunts that plan: Codex is refused in turn');
  assert.match(again.stderr, /^nunchi hunt: Claude Code is hunting this run right now/);
});

test('board: "Now" lists the running hunts with their progress after captures and claims; a hunt that goes quiet leaves it, and the version, by the reader\'s clock', async () => {
  const p = smallProject();
  let t = T;
  const b = await startBoard({ projectDir: p.root, now: () => t });
  const origin = b.origin;
  const s = await (await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code: b.newLink().split('#t=')[1] }) })).json();
  const get = async path => (await fetch(origin + path, { headers: { 'x-nunchi-token': s.token } })).json();
  try {
    const v0 = (await get('/api/generation')).version;
    Act.noteHunt(b.stateDir, hunt({ now: t - 3 * 60e3, answered: 0, complete: 0 }));
    Act.noteHunt(b.stateDir, hunt({ now: t }));
    Act.noteHunt(b.stateDir, hunt({ now: t, agent: 'Codex\u0007 <b>x</b>', run: '0008' }));
    const v1 = (await get('/api/generation')).version;
    assert.notEqual(v1, v0);
    const lines = (await get('/api/summary')).now;
    assert.equal(lines[0], 'Codex · AI review L6 · 12/40 units · 3 min');
    assert.equal(lines.length, 2);
    assert.equal(lines[1], 'Your AI · AI review L6 · 12/40 units · just started', 'a declared name that is no name (a control character) is not shown');
    t += 31 * 60e3;
    const v2 = (await get('/api/generation')).version;
    assert.notEqual(v2, v1, 'gone quiet: the version changes without a write');
    assert.deepEqual((await get('/api/summary')).now, []);
  } finally { await b.close(); }
});
