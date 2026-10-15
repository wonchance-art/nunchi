// Shared by the fix loop's test files (they are split so each stays well inside the per-file test timeout on
// Windows): the context with a fake capture, the record and row readers, one attempt start → edit → checks → commit
// → verify, an AI finding decided Fix, and a project whose app nunchi starts itself (--serve start).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as F from '../../src/fix/loop.mjs';
import * as R from '../../src/fix/records.mjs';
import * as P from '../../src/project.mjs';
import * as L from '../../src/ledger.mjs';
import { readKey } from '../../src/state.mjs';
import { fixProject, edit, commitWith } from './fix-project.mjs';

export const proveOk = async () => ({ ok: true, how: 'test' });
export const ctxOf = (p, extra = {}) => F.openFix({ cwd: p.root, root: p.root, deps: { capture: p.cap.capture, prove: proveOk, ...extra } });
export const stateDir = p => P.stateOf(p.nunchi).root.dir;
export const latest = p => R.latestRecord(stateDir(p), p.group);
export const rowOf = p => { const led = P.loadLedger(p.nunchi, { root: p.root }); return P.ledgerView(led).rows.find(r => r.fp === p.fp); };
export const trailers = r => r.json.trailers;
export const TITLE = 'Tap target smaller than 24px';

// start → edit → checks → commit → verify
export async function attempt(p, { change = ['TINY', 'ROOMY'], verify = true, deps = {}, file = 'app/settings/page.jsx', extraEdit = null } = {}) {
  const s = await F.startFix(ctxOf(p, deps), p.group);
  assert.equal(s.code, 0, s.lines.join('\n'));
  if (change) edit(p.root, file, ...change);
  if (extraEdit) extraEdit(p.root);
  const c = await F.checkFix(ctxOf(p, deps), p.group);
  assert.equal(c.code, 0, c.lines.join('\n'));
  commitWith(p.root, trailers(c));
  if (!verify) return { s, c };
  const v = await F.verifyFix(ctxOf(p, deps), p.group);
  return { s, c, v };
}

// An AI finding (L6, the panel heading on /settings, grounded in components/panel.jsx) double-checked in the sweep,
// in the ledger as verify --record leaves it, and decided Fix.
export async function aiProject(over = {}) {
  const p = await fixProject({ decide: null, ...over });
  const manifest = JSON.parse(readFileSync(join(p.nunchi, 'runs', '0001', 'manifest.json'), 'utf8'));
  const findings = ['m', 'd'].map(vp => {
    const sc = manifest.scenes.find(s => s.id === `settings.guest.normal.${vp}`);
    const f = { source: 'ai', lens: 'L6', rule: 'L6.vague-error', route: '/settings', scene: sc.id, selector: 'main > section > h2', severity: 'medium',
      evidence: { claim: 'The panel heading says nothing about what it holds.', file: 'components/panel.jsx', line: 1 }, identity: { element: 'main > section > h2', file: 'components/panel.jsx', anchor: null, name: null, component: { file: 'components/panel.jsx', name: null } } };
    const { fp, group, inputs } = L.fingerprintOf(f);
    return { fp, group, inputs, lens: f.lens, rule: f.rule, route: f.route, scene: f.scene, cell: `guest.normal.${vp}`, selector: f.selector, box: [40, 100, 300, 30], evidence: f.evidence, identity: f.identity,
      status: 'confirmed', claimedSeverity: 'medium', verdictSeverity: 'medium', by: 'same-model check', vendor: null, suspect: false, sceneHash: { top: sc.top, full: sc.full, textHash: sc.textHash, src: null } };
  });
  L.commitFix(join(stateDir(p), 'ledger.json'), s => L.foldAi(s, { run: '0001', stream: 'main', key: 'test-ai', findings, seen: [], now: Date.now() - 60e3 }));
  const led = P.loadLedger(p.nunchi, { root: p.root });
  const row = P.ledgerView(led).rows.find(r => r.source === 'ai');
  P.recordDecisions(led, { targets: [{ group: row.group }], decision: 'fix', by: 'Tester', channel: 'board' });
  return { ...p, group: row.group, fp: row.fp };
}
export const verdictsFor = (p1Dir, { item = 'gone', control = 'still-there' } = {}) => Object.entries(readKey(p1Dir, 'recheck-key.json').packets).map(([packet, ref]) => ({ packet, verdict: ref.kind === 'control' ? control : item, reason: 'compared the two screens' }));

export async function servedProject() {
  const p = await fixProject({ files: { 'package.json': JSON.stringify({ name: 'x', private: true, scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '0.0.0-test' } }) } });
  const { checkProfile, approveProfile, scriptsApprovedPath } = await import('../../src/checks.mjs');
  approveProfile(scriptsApprovedPath(stateDir(p)), p.root, { seen: checkProfile(p.root).hash, channel: 'cli-tty', by: 'Tester' });
  const runChecks = async () => ({ pm: { name: 'npm' }, results: { build: { status: 'pass', exit: 0, count: null, output: '' } } });   // a build: --serve start's proof
  const events = [];
  let up = false;
  const serve = async () => { up = true; events.push('serve'); return { ok: true, url: 'http://127.0.0.1:4999', stop: () => { up = false; events.push('stop'); } }; };
  const capture = async a => { events.push(`capture:${up ? 'up' : 'down'}`); if (!up) return { manifest: { scenes: a.scenes.map(s => ({ id: `${s.route.slice(1) || '~'}.${s.person}.normal.${a.viewports[0]}`, route: s.route, person: s.person, status: 'capture-failed', reason: 'app-unreachable' })), health: { problems: [] } }, findings: [] }; return p.cap.capture(a); };
  return { p, events, deps: { serve, capture, runChecks } };
}
