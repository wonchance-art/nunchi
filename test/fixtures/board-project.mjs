// A synthetic project for the board's tests (M2): .nunchi/runs/<id> folders as `capture` writes them (manifest,
// run.json, findings.json, screenshots), invented content only. Not a git repository unless `git: true`, so the state
// stays in .nunchi/state.
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { annotate, foldRun, foldAi, runForFold, emptyState, fingerprintOf } from '../../src/ledger.mjs';
import { stableJson } from '../../src/stable.mjs';

// A JPEG header with a SOF0 segment is all the engine reads of a screenshot (jpegSize); a browser shows it as broken,
// which the tests do not need to see. `realJpeg` is a decodable 8×8 grey image for the browser tests.
export function jpeg(w, h, salt = 0) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, salt & 255, 0xff, 0xd9]);
}
const write = (p, v) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, typeof v === 'string' || Buffer.isBuffer(v) ? v : stableJson(v)); };
export const tmp = prefix => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
export const slug = route => (route === '/' ? '~' : route.slice(1).replace(/\//g, '~'));
export const scene = (route, person, state, viewport, extra = {}) => ({
  id: `${slug(route)}.${person}.${state}.${viewport}`, route, path: route, person, state, viewport,
  status: 'captured', reason: null, finalPath: route, httpStatus: 200, findings: 0, dataRequests: 1, replayMisses: 0, ...extra,
});
export const VPS = [{ id: 'm', width: 390, height: 844 }, { id: 'd', width: 1280, height: 800 }];

// One complete run folder. `scenes`: manifest entries (scene()); `findings`: rule findings (annotated here).
export function writeRun(root, id, { scenes, findings = [], parent = null, wholeApp = true, problems = [], ai = null, extraScene = null } = {}) {
  const run = join(root, '.nunchi', 'runs', id);
  scenes.forEach((s, i) => {
    const vp = VPS.find(v => v.id === s.viewport) || VPS[1];
    if (s.status === 'captured') {
      write(join(run, s.id, 'top.jpg'), jpeg(vp.width, vp.height, i));
      write(join(run, s.id, 'full.jpg'), jpeg(vp.width, s.fullHeight || 2000, i + 100));
    }
    write(join(run, s.id, 'measure.json'), { h1: s.h1 ?? null });
    write(join(run, s.id, 'controls.json'), s.controls || []);
    // files the board never serves: network evidence with a cookie and a token
    write(join(run, s.id, 'network.json'), { requests: [{ path: '/api/me?token=NETWORK-TOKEN-1', headers: { cookie: 'sid=COOKIE-VALUE-1' } }] });
    write(join(run, s.id, 'text.txt'), 'PAGE-TEXT-ONLY-IN-TEXT-TXT\n');
    if (extraScene) extraScene(join(run, s.id), s);
  });
  const health = { status: problems.length ? 'problems' : 'ok', problems };
  const manifest = { schema: 1, baseUrl: 'http://127.0.0.1:3000', viewports: VPS, health, states: [...new Set(scenes.map(s => s.state))], scenes: scenes.map(({ h1, controls, fullHeight, ...s }) => s) };
  const routes = [...new Set(scenes.map(s => s.route))].sort();
  write(join(run, 'manifest.json'), manifest);
  write(join(run, 'run.json'), { schema: 1, id, parent, kind: 'sweep', commit: null, dirty: null, wholeApp, health,
    scope: { routes, persons: [...new Set(scenes.map(s => s.person))].sort(), viewports: [...new Set(scenes.map(s => s.viewport))].sort(), states: [...new Set(scenes.map(s => s.state))].sort(), changedSince: null } });
  const annotated = annotate(findings);
  write(join(run, 'findings.json'), { schema: 1, findings: annotated });
  write(join(run, 'flow.json'), { schema: 1, order: routes });
  if (ai) write(join(run, 'ai-findings.json'), { schema: 1, findings: ai });
  write(join(root, '.nunchi', 'runs', 'latest'), id + '\n');
  return { run, findings: annotated };
}

export const HOSTILE = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';

// AI findings folded into the project's ledger (.nunchi/state/ledger.json) as `hunt --record` / `verify --record`
// would leave them: `list` of { lens, rule, scene (a scene()), selector, box, claim, file, line, status, severity }.
export function withAi(p, list, { run = '0001' } = {}) {
  const st0 = foldRun(emptyState(), { ...runForFold(join(p.nunchi, 'runs', run)), stream: 'main' });
  const findings = list.map(x => {
    const f = { source: 'ai', lens: x.lens, rule: x.rule, route: x.scene.route, scene: x.scene.id, selector: x.selector ?? null, severity: x.severity || 'high',
      evidence: { claim: x.claim, ...(x.file ? { file: x.file, line: x.line ?? 1 } : {}) } };
    const { fp, group, inputs } = fingerprintOf(f);
    return { fp, group, inputs, lens: f.lens, rule: f.rule, route: f.route, scene: f.scene, cell: `${x.scene.person}.${x.scene.state}.${x.scene.viewport}`, selector: f.selector,
      box: x.box ?? null, evidence: f.evidence, identity: null, status: x.status || 'claimed', claimedSeverity: f.severity, verdictSeverity: x.status === 'confirmed' ? f.severity : null,
      by: x.status && x.status !== 'claimed' ? 'same-model check' : null, vendor: null, suspect: !!x.suspect, sceneHash: { top: 't', full: 'f', textHash: 'x' } };
  });
  const st = foldAi(st0, { run, stream: 'main', key: `fixture:${run}`, findings, seen: [], now: 1_700_000_000_000 });
  mkdirSync(join(p.nunchi, 'state'), { recursive: true });
  writeFileSync(join(p.nunchi, 'state', 'ledger.json'), stableJson(st));
  return Object.values(st.items).filter(i => i.source === 'ai');
}

// A small project: two pages, phone and desktop, a blocker secret, a high raw error (with hostile text), two medium
// dead links on one component, a low tap target. → { root, nunchi, run, findings, scenes }
export function smallProject({ git = false, prefix = 'nunchi-board-' } = {}) {
  const root = tmp(prefix);
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
  }
  const scenes = [
    scene('/', 'guest', 'normal', 'd', { h1: 'Plant shelf', controls: [{ selector: 'main > a.more', box: [40, 900, 120, 32] }, { selector: 'nav a', box: [10, 10, 12, 12] }] }),
    scene('/', 'guest', 'normal', 'm', { controls: [{ selector: 'main > a.more', box: [16, 700, 100, 32] }] }),
    scene('/garden', 'guest', 'normal', 'd', { h1: 'Garden', controls: [{ selector: 'main > a.more', box: [40, 400, 120, 32] }] }),
    scene('/garden', 'guest', 'error', 'd', { controls: [{ selector: 'main p.err', box: [40, 300, 400, 24] }] }),
    scene('/lost', 'guest', 'normal', 'd', { status: 'failed', reason: 'timeout' }),
  ];
  const f = (rule, severity, sc, selector, evidence, lens = 'L1') => ({ lens, rule, severity, scene: sc.id, route: sc.route, viewport: sc.viewport, selector, box: null, evidence });
  const findings = [
    { lens: 'L9', rule: 'secret-in-client-bundle', severity: 'blocker', scene: null, route: null, viewport: null, selector: null, box: null, evidence: { url: '/assets/app-4f1c2a9b.js', kind: 'stripe-live-secret-key' } },
    f('raw-error-text', 'high', scenes[3], 'main p.err', { text: `TypeError: ${HOSTILE}` }, 'L6'),
    f('dead-href', 'medium', scenes[0], 'main > a.more', { href: '#' }, 'L3'),
    f('dead-href', 'medium', scenes[1], 'main > a.more', { href: '#' }, 'L3'),
    f('dead-href', 'medium', scenes[2], 'main > a.more', { href: '#' }, 'L3'),
    f('target-size-min', 'low', scenes[0], 'nav a', { width: 12 }, 'L8'),
  ];
  const { run, findings: annotated } = writeRun(root, '0001', { scenes, findings });
  return { root, nunchi: join(root, '.nunchi'), run, findings: annotated, scenes };
}
