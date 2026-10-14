// A synthetic app in a git repository for the fix loop's tests (M3): three Next.js-style routes, a sweep already
// captured, and a stand-in for capture() that writes probe runs in capture's own format from what the working tree
// holds (markers in the source decide what the "screens" show). Invented content only; no browser.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { annotate } from '../../src/ledger.mjs';
import { stableJson, sha } from '../../src/stable.mjs';
import * as P from '../../src/project.mjs';

export const tmp = prefix => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const write = (p, v) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, typeof v === 'string' || Buffer.isBuffer(v) ? v : stableJson(v)); };
// git for the test itself (the engine uses its own hardened runner); signing off, an identity of its own
export const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ---- a PNG writer (RGBA, filter 0): enough for the drift check's decoder ----------------------------------------------
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
// w×h of `bg`, with `rects` [{ x, y, w, h, color: [r,g,b] }] painted on
export function png(w, h, { bg = [255, 255, 255], rects = [] } = {}) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const r = rects.find(q => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h);
      const c = r ? r.color : bg, o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const jpeg = (w, h, salt = 0) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, salt & 255, 0xff, 0xd9]);

// ---- the app ----------------------------------------------------------------------------------------------------------
export const FILES = {
  'package.json': JSON.stringify({ name: 'shelf-fixture', private: true, dependencies: { next: '0.0.0-test', react: '0.0.0-test' } }, null, 2) + '\n',
  'app/layout.jsx': 'export default function Layout({ children }) { return <body>{children}</body>; }\n',
  'app/page.jsx': 'export default function Home() { return <main><h1>Plant shelf</h1></main>; }\n',
  'app/settings/page.jsx': "import Panel from '../../components/panel.jsx';\nexport default function Settings() {\n  return <main><Panel /><button className=\"save\">Save</button>{/* TINY */}</main>;\n}\n",
  'app/help/page.jsx': "import Panel from '../../components/panel.jsx';\nexport default function Help() { return <main><Panel /></main>; }\n",
  'components/panel.jsx': 'export default function Panel() { return <section>Shelf panel</section>; }\n',
  'public/robots.txt': 'User-agent: *\n',
  '.gitignore': 'node_modules/\n',
  '.nunchi/.gitignore': 'auth.json\nevidence/\nhar/\nruns/\nstate/\n',
};
const VPS = { m: [390, 844], d: [1280, 800] };
export const ROUTES = ['/', '/help', '/settings'];
const slug = r => (r === '/' ? '~' : r.slice(1).replace(/\//g, '~'));
const has = (root, file, marker) => { try { return readFileSync(join(root, file), 'utf8').includes(marker); } catch { return false; } };

// What a screen shows, from markers in the working tree:
// - TINY in app/settings/page.jsx: "Save" is a 20 px tap target on /settings (the group to fix, target-size-min);
//   WRAP: the same button, wrapped in a div (another selector, the same element);
// - BROKEN in app/page.jsx: a broken image on / (another defect: a regression when a fix adds it);
// - SHIFT in app/settings/page.jsx: the first view's pixels change outside the button (visual drift);
//   MOVE: the panel's heading control moves;
// - HELPDEFECT in components/panel.jsx: /help shows a clipped text no run has seen (a route only P1 captures);
// - CLIP in app/settings/page.jsx: the panel heading is cut off on /settings (a new defect in the fix's own screen);
// - world.flakyOnce: a page error on /settings that many times (a flaky rule: gone when captured again);
// - world.hostile: the Save button's name, as an app could make it (prompt-injection-like text);
// - world.fail: route → the scene fails; world.misses: replay misses.
export function screen(root, route, vp, state, world = {}) {
  const [w, h] = VPS[vp];
  const id = `${slug(route)}.guest.${state}.${vp}`;
  const wrap = has(root, 'app/settings/page.jsx', 'WRAP');
  const saveSel = wrap ? 'main > div > button.save' : 'main > button.save';
  const controls = route === '/settings' ? [{ selector: saveSel, tag: 'button', name: 'Save', box: [40, 300, has(root, 'app/settings/page.jsx', 'TINY') || wrap ? 20 : 120, has(root, 'app/settings/page.jsx', 'TINY') || wrap ? 20 : 44] },
    { selector: 'main > section > h2', tag: 'h2', name: 'Shelf panel', box: [40, has(root, 'app/settings/page.jsx', 'MOVE') ? 160 : 100, 300, 30] }]
    : route === '/help' ? [{ selector: 'main > section > h2', tag: 'h2', name: 'Shelf panel', box: [40, 100, 300, 30] }]
    : [{ selector: 'main > h1', tag: 'h1', name: 'Plant shelf', box: [40, 40, 300, 40] }];
  const findings = [];
  const f = (rule, lens, severity, selector, evidence, box = null) => findings.push({ lens, rule, severity, scene: id, route, viewport: vp, selector, box, evidence });
  if (route === '/settings' && (has(root, 'app/settings/page.jsx', 'TINY') || wrap)) f('target-size-min', 'L8', 'medium', saveSel, { width: 20, height: 20, minimum: 24, name: 'Save' }, [40, 300, 20, 20]);
  if (route === '/' && has(root, 'app/page.jsx', 'BROKEN')) f('broken-image', 'L1', 'high', 'main > img.hero', { src: '/hero-missing.png' }, [40, 120, 300, 200]);
  if (route === '/help' && has(root, 'components/panel.jsx', 'HELPDEFECT')) f('clipped-text', 'L1', 'medium', 'main > section > h2', { text: 'Shelf panel' }, [40, 100, 300, 30]);
  if (route === '/settings' && has(root, 'app/settings/page.jsx', 'CLIP')) f('clipped-text', 'L1', 'medium', 'main > section > h2', { text: 'Shelf panel' }, [40, 100, 300, 30]);
  if (route === '/settings' && world.flakyOnce > 0) { world.flakyOnce--; f('page-error', 'L1', 'high', null, { message: 'x is not defined' }); }
  if (route === '/settings' && world.hostile) findings.forEach(x => { if (x.rule === 'target-size-min') x.evidence = { ...x.evidence, name: world.hostile }; });
  const rects = [{ x: 40, y: 300, w: controls[0].box[2], h: controls[0].box[3], color: [30, 90, 200] }];
  if (route === '/settings' && has(root, 'app/settings/page.jsx', 'SHIFT')) rects.push({ x: 0, y: 500, w: Math.round(w * 0.6), h: 200, color: [200, 30, 30] });
  // PLANTS in components/panel.jsx: the panel's heading on /settings reads differently (where the AI finding is)
  if (route === '/settings' && has(root, 'components/panel.jsx', 'PLANTS')) rects.push({ x: 40, y: 100, w: 300, h: 30, color: [0, 140, 0] });
  const failed = (world.fail || []).includes(route);
  return { id, route, vp, state, w, h, controls, findings: failed ? [] : findings, png: png(w, h, { rects }), failed };
}

// capture()'s stand-in: same arguments, same files (manifest, findings with fingerprints, run.json, per-scene evidence
// with top.png), same return. `world` changes what it sees; `calls` records each call's scope.
export function fakeCapture(root, world = {}) {
  const calls = [];
  const capture = async ({ baseUrl, scenes, out, viewports = ['m', 'd'], states = ['normal'], runMeta = {}, png: withPng = false, canaries = 0, canaryRoutes = null }) => {
    calls.push({ routes: [...new Set(scenes.map(s => s.route))].sort(), viewports, states, kind: runMeta.kind, png: withPng, canaries, baseUrl });
    if (world.throw) throw Object.assign(new Error(world.throw), { code: 'NO_BROWSER' });
    const entries = [], findings = [];
    for (const s of scenes) for (const vp of viewports) for (const state of states.filter(x => x === 'normal')) {
      const sc = screen(root, s.route, vp, state, world);
      const dir = join(out, sc.id);
      write(join(dir, 'controls.json'), sc.controls);
      write(join(dir, 'top.jpg'), jpeg(sc.w, sc.h, 1));
      write(join(dir, 'full.jpg'), jpeg(sc.w, sc.h + 100, 2));
      if (withPng) write(join(dir, 'top.png'), sc.png);
      write(join(dir, 'text.txt'), `${s.route}\n`);
      write(join(dir, 'aria.yml'), '- main\n');
      write(join(dir, 'measure.json'), { h1: null });
      entries.push({ id: sc.id, route: s.route, path: s.path, person: s.person || 'guest', state, viewport: vp, status: sc.failed ? 'capture-failed' : 'captured', reason: sc.failed ? 'no-dom' : null,
        finalPath: s.path, redirected: false, httpStatus: 200, top: sha(sc.png), full: sha(sc.png), textHash: sha(s.route), findings: sc.findings.length, dataRequests: 1, replayMisses: (world.misses || {})[s.route] || 0 });
      findings.push(...sc.findings);
    }
    // canaries (the re-check's controls): copies of the eligible screens with a planted defect, cycling over them
    const planted = [];
    const eligible = entries.filter(e => e.status === 'captured' && (!canaryRoutes || canaryRoutes.includes(e.route)));
    const KINDS = [['vague-error', 'L6', 'L6.vague-error'], ['template-copy', 'L7', 'L7.template-copy'], ['verb-swap', 'L5', 'L5.same-action-different-verb']];
    for (let k = 1; k <= (world.canaries ?? canaries) && eligible.length; k++) {
      const base = eligible[(k - 1) % eligible.length], [kind, lens, checklist] = KINDS[(k - 1) % KINDS.length];
      const id = `${base.id}.canary-${k}`;
      for (const n of ['controls.json', 'top.jpg', 'full.jpg', 'text.txt', 'aria.yml', 'measure.json']) write(join(out, id, n), readFileSync(join(out, base.id, n)));
      entries.push({ ...base, id, canary: k, of: base.id, findings: 0, top: sha(`${base.top}:${kind}`), full: sha(`${base.full}:${kind}`) });
      planted.push({ scene: id, of: base.id, route: base.route, person: base.person, state: base.state, viewport: base.viewport, kind, lens, checklist, what: kind, selector: 'main', box: [0, 0, 10, 10], before: 'a', after: 'b' });
    }
    if (planted.length) write(join(out, 'canaries.json'), { schema: 1, note: 'answer key', seed: 'test', requested: canaries, planted });
    const manifest = { schema: 1, health: { status: 'ok', problems: world.problems || [] }, baseUrl, viewports: viewports.map(v => ({ id: v, width: VPS[v][0], height: VPS[v][1] })), states, scenes: entries };
    const annotated = annotate(findings);
    write(join(out, 'manifest.json'), manifest);
    write(join(out, 'findings.json'), { schema: 1, findings: annotated });
    write(join(out, 'run.json'), { ...runMeta, network: { guest: 'replay' }, health: manifest.health });
    return { manifest, findings: annotated, run: runMeta };
  };
  return { capture, calls };
}

// The project: the app committed on main, a recording, and a complete sweep (run 0001) in the ledger with the "Save"
// tap target to fix. → { root, nunchi, group, fp, world, cap }
export async function fixProject({ prefix = 'nunchi-fix-', files = {}, decide = 'fix', channel = 'cli-agent', world = {} } = {}) {
  const root = tmp(prefix);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'user.name', 'Tester');
  git(root, 'config', 'user.email', 'tester@example.invalid');
  for (const [k, v] of Object.entries({ ...FILES, ...files })) if (v !== null) write(join(root, k), v);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'the app');
  write(join(root, '.nunchi', 'har', 'guest.json'), { schema: 1, entries: [] });
  const cap = fakeCapture(root, world);
  const run = join(root, '.nunchi', 'runs', '0001');
  await cap.capture({ baseUrl: 'http://127.0.0.1:3000', scenes: ROUTES.map(r => ({ route: r, path: r, person: 'guest' })), out: run, viewports: ['m', 'd'], states: ['normal'],
    runMeta: { schema: 1, id: '0001', kind: 'sweep', worktree: 'main', wholeApp: true, scope: { routes: ROUTES, persons: ['guest'], viewports: ['d', 'm'], states: ['normal'], changedSince: null } } });
  write(join(root, '.nunchi', 'runs', 'latest'), '0001\n');
  cap.calls.length = 0;
  const led = P.loadLedger(join(root, '.nunchi'), { root });
  const { rows, groups } = P.ledgerView(led);
  const row = rows.find(r => r.rule === 'target-size-min');
  if (decide) P.recordDecisions(led, { targets: [{ group: row.group }], decision: decide, by: 'Tester', channel });
  return { root, nunchi: join(root, '.nunchi'), group: row.group, fp: row.fp, world, cap, rows, groups };
}

// An edit of the working tree, committed with the trailers the engine asked for.
export function edit(root, file, from, to) {
  const p = join(root, file);
  writeFileSync(p, readFileSync(p, 'utf8').replace(from, to));
}
export const commitWith = (root, trailers, subject = 'Fix the Save tap target') => git(root, 'commit', '-q', '-a', '-m', subject, '-m', trailers.join('\n'));
export const exists = p => existsSync(p);
