// Probes, not runs (design 0.1-c §4.4). P0 is captured at `fix --start`, P1 at `fix --verify` with identical options:
// all persons, both viewports, the baseline's states, strict replay from the attempt's HAR snapshot (its sha in the
// record), PNG first views, whole-app detectors off, `run.json` kind `fix-probe`. P1's scope is P0's plus the routes
// the diff reaches (`affectedRoutes`); those have no baseline.
//
// Proof that the served code is the commit: either the engine starts the app itself from this folder with an approved
// start script (`--serve dev|start`, on a port nobody listened on), or it writes a probe file into the app's static
// folder (public/ or static/) and fetches it back from --url. Without either, the outcome is *needs you*.
import { writeFileSync, rmSync, readFileSync, existsSync, statSync, mkdtempSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { startRun, finishRun, workTree } from '../runs.mjs';
import { discover } from '../discover.mjs';
import { buildSourceMap, sourceHashes } from '../sourcemap.mjs';
import { writeStable, privateDir, refuseLink } from '../stable.mjs';
import { readJsonFile } from '../state.mjs';
import { decodePng, pixelDiff } from './png.mjs';
import { screenDrift } from './judge.mjs';
import { packageManagerOf, findBinary, commandFor, childEnv, killTree, cleanOutput } from './run.mjs';

const sha = buf => createHash('sha256').update(buf).digest('hex');
const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
const read = (p, fallback = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- the recording snapshot ------------------------------------------------------------------------------------------

// Copies each person's recording into the attempt's own folder (state/fixes/<group>/<n>-har/), so P0 and P1 replay the
// very same data whatever happens to .nunchi/har in between. → { person: sha256 } or { missing: [person] }.
export function snapshotRecordings(harDir, into, persons) {
  const missing = persons.filter(p => !existsSync(join(harDir, `${p}.json`)));
  if (missing.length) return { missing };
  privateDir(into);
  const out = {};
  for (const p of persons) {
    const to = join(into, `${p}.json`);
    refuseLink(to);
    copyFileSync(join(harDir, `${p}.json`), to);
    out[p] = sha(readFileSync(to));
  }
  return { shas: out };
}
export function snapshotIntact(into, shas) {
  return Object.entries(shas || {}).every(([p, h]) => { try { return sha(readFileSync(join(into, `${p}.json`))) === h; } catch { return false; } });
}

// ---- proof of the served code ----------------------------------------------------------------------------------------

export const STATIC_DIRS = ['public', 'static'];
// The probe file: written into the app's static folder, fetched back from the base URL, removed. → { ok, how, … }.
export async function proveByFile({ root, url, timeoutMs = 15000, fetchImpl = fetch }) {
  const dir = STATIC_DIRS.map(d => join(root, d)).find(isDir);
  if (!dir) return { ok: false, why: 'the app has no public/ or static/ folder to place a probe file in (use --serve dev or --serve start)' };
  const name = `nunchi-probe-${randomBytes(8).toString('hex')}.txt`, body = randomBytes(16).toString('hex');
  const file = join(dir, name);
  writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
  try {
    const base = new URL(url);
    const tries = [...new Set([new URL(`/${name}`, base.origin).href, new URL(name, base.href.endsWith('/') ? base.href : `${base.href}/`).href])];
    for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(300)) {
      for (const u of tries) {
        try {
          const r = await fetchImpl(u, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
          if (r.ok && (await r.text()).trim() === body) return { ok: true, how: 'probe-file' };
        } catch {}
      }
    }
    return { ok: false, why: `the app at ${base.origin} did not serve a file written into ${STATIC_DIRS.find(d => isDir(join(root, d)))}/ of this folder: it is not running from here, or it serves a build made before (start it from this folder, or use --serve)` };
  } finally { rmSync(file, { force: true }); }
}

export function freePort() {
  return new Promise((res, rej) => { const s = createServer(); s.once('error', rej); s.listen({ port: 0, host: '127.0.0.1' }, () => { const p = s.address().port; s.close(() => res(p)); }); });
}
// Which arguments tell a dev server its port (and to listen on 127.0.0.1 only): PORT is set for everyone.
const PORT_ARGS = [
  [/^\s*next\b/, p => ['--port', String(p), '--hostname', '127.0.0.1']],
  [/^\s*vite\b/, p => ['--port', String(p), '--strictPort', '--host', '127.0.0.1']],
  [/^\s*(astro|nuxt|nuxi|remix|react-router)\b/, p => ['--port', String(p)]],
];
// Starts the app from this folder with an approved start script (`dev` or `start` of the check profile's `serve`).
// → { ok: true, url, stop } | { ok: false, why }.
export async function serveApp({ root, profile, script, url, env = process.env, platform = process.platform, timeoutMs = 120000 }) {
  if (!profile?.serve || typeof profile.serve[script] !== 'string') return { ok: false, why: `--serve ${script}: package.json has no "${script}" script (nunchi starts the app only with dev or start)` };
  const port = await freePort();
  const pm = packageManagerOf(root, profile);
  const line = profile.serve[script];
  const extraArgs = (PORT_ARGS.find(([re]) => re.test(line))?.[1] || (() => []))(port);
  const c = commandFor({ pm, script, bin: findBinary(pm.name, { env, platform }), platform, profile, extraArgs });
  if (c.refused) return { ok: false, why: c.refused };
  let out = '';
  const child = spawn(c.cmd, c.args, { cwd: root, env: childEnv(env, platform, { serve: true, extra: { PORT: String(port) } }), shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], ...(c.opts || {}) });
  child.stdout.on('data', d => { out = (out + d).slice(-8000); }); child.stderr.on('data', d => { out = (out + d).slice(-8000); });
  let exited = null;
  child.on('exit', code => { exited = code ?? 'signal'; });
  child.on('error', e => { exited = e.message; });
  const path = (() => { try { return new URL(url || 'http://127.0.0.1/').pathname; } catch { return '/'; } })();
  const served = `http://127.0.0.1:${port}${path}`;
  const stop = () => { if (exited === null) killTree(child, platform); };
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(400)) {
    if (exited !== null) return { ok: false, why: `${pm.name} run ${script} stopped (${exited}) before the app answered: ${cleanOutput(out).trim().split('\n').slice(-3).join(' / ').slice(0, 400)}` };
    try { const r = await fetch(served, { redirect: 'manual', signal: AbortSignal.timeout(3000) }); await r.arrayBuffer(); return { ok: true, url: served, stop, how: 'serve' }; } catch {}
  }
  stop();
  return { ok: false, why: `${pm.name} run ${script} did not answer on port ${port} within ${Math.round(timeoutMs / 1000)} s` };
}

// ---- a probe capture -------------------------------------------------------------------------------------------------

// The scenes of a probe: each route of the scope with the path the last sweep used for it (its sample), per person.
export function probeScenes(scope, samplePaths = {}) {
  return scope.routes.flatMap(route => scope.persons.map(person => ({ route, path: samplePaths[route] || route, person })));
}
// One probe run (P0 or P1): a run folder of .nunchi/runs (ids shared with the other worktrees), never `latest`.
// `capture`: capture.mjs's capture (passed in so the engine's packages load only when a probe runs).
// → { runId, runDir, manifest, findings }.
export async function captureProbe({ capture, root, nunchiDir, runsDir, idsFile = null, stream, url, scope, samplePaths, harDir, storageState = null, allowHosts = [], allowBaseHosts = [],
  browserPath, fix, canaries = 3, canarySeed, canaryRoutes, onStart = () => {} }) {
  const run = startRun(runsDir, { ids: idsFile });
  onStart(run.id);
  const runMeta = { schema: 1, id: run.id, parent: null, kind: 'fix-probe', worktree: stream, ...workTree(root),
    scope: { routes: [...scope.routes].sort(), persons: [...scope.persons].sort(), viewports: [...scope.viewports].sort(), states: [...scope.states], changedSince: null },
    wholeApp: false, unresolved: [], fix };
  try {
    const r = await capture({ baseUrl: url, scenes: probeScenes(scope, samplePaths), out: run.path, viewports: scope.viewports, states: scope.states, network: 'replay', recordingDir: harDir,
      storageState: scope.persons.includes('signed-in') ? storageState : null, allowHosts, allowBaseHosts, browserPath, runMeta, flow: {}, canaries, canarySeed, canaryRoutes,
      wholeAppDetectors: false, png: true });
    // what each route's code was at this capture: the re-check tells an unchanged route by it (§2.4)
    try { const map = buildSourceMap(root, discover(root).routes); writeStable(join(run.path, 'source-map.json'), map); writeStable(join(run.path, 'source-hashes.json'), sourceHashes(root, map)); } catch {}
    finishRun(runsDir, run.id, { latest: false });
    return { runId: run.id, runDir: join(runsDir, run.id), manifest: r.manifest, findings: r.findings };
  } catch (e) {
    rmSync(run.path, { recursive: true, force: true });
    throw e;
  }
}

// A flaky rule's finding is re-captured once on its scene (design §4.5) before it counts: those scenes alone, into a
// private temporary folder (no run). → (finding) => whether the same rule fired on that scene again.
export async function recaptureFlaky({ capture, findings, url, scope, samplePaths, harDir, storageState, allowHosts = [], allowBaseHosts = [], browserPath, scenesById }) {
  if (!findings.length) return () => true;
  const again = new Map();
  const out = mkdtempSync(join(tmpdir(), 'nunchi-flaky-'));
  try {
    for (const f of findings) {
      const s = scenesById.get(f.scene);
      if (!s || again.has(f.scene)) continue;
      const states = s.state === 'normal' ? ['normal'] : ['normal', s.state];
      const r = await capture({ baseUrl: url, scenes: [{ route: s.route, path: samplePaths[s.route] || s.route, person: s.person }], out: join(out, String(again.size)), viewports: [s.viewport], states, network: 'replay',
        recordingDir: harDir, storageState: s.person === 'signed-in' ? storageState : null, allowHosts, allowBaseHosts, browserPath, runMeta: { kind: 'fix-probe' }, flow: {}, canaries: 0, wholeAppDetectors: false });
      again.set(f.scene, r.findings.filter(x => x.scene === f.scene));
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
  return f => (again.get(f.scene) || []).some(x => x.rule === f.rule && (x.fp === f.fp || x.selector === f.selector));
}

// Visual drift between P0 and P1 on the screens both captured (design §4.5 row 4), the group's boxes left out.
// `boxesOf(sceneId)`: the group's boxes on that screen, before and after. → { share, moved, scenes: [{ scene, share, moved }] }
export function measureDrift({ p0Dir, p1Dir, p0Scenes, p1Scenes, boxesOf = () => [] }) {
  const after = new Map(p1Scenes.filter(s => s.status === 'captured' && s.canary === undefined).map(s => [s.id, s]));
  const scenes = [];
  for (const s of p0Scenes) {
    if (s.status !== 'captured' || s.canary !== undefined || !after.has(s.id)) continue;
    const boxes = boxesOf(s.id);
    let pixels = null;
    try {
      const a = decodePng(readFileSync(join(p0Dir, s.id, 'top.png'))), b = decodePng(readFileSync(join(p1Dir, s.id, 'top.png')));
      pixels = pixelDiff(a, b, { masks: boxes.filter(Array.isArray).map(([x, y, w, h]) => [x - 8, y - 8, w + 16, h + 16]) });
    } catch { pixels = null; }
    const d = screenDrift({ before: read(join(p0Dir, s.id, 'controls.json'), []), after: read(join(p1Dir, s.id, 'controls.json'), []), boxes, pixels });
    scenes.push({ scene: s.id, route: s.route, viewport: s.viewport, ...d, png: !!pixels });
  }
  return { share: Math.max(0, ...scenes.map(s => s.share)), moved: scenes.reduce((n, s) => n + s.moved, 0), scenes: scenes.filter(s => s.share > 0 || s.moved > 0) };
}

// The run as the judge reads it (probeView's inputs).
export function readProbe(runDir) {
  const fix = `fix or remove the probe run ${runDir}`;
  return { manifest: readJsonFile(join(runDir, 'manifest.json'), fix), findings: readJsonFile(join(runDir, 'findings.json'), fix)?.findings || [] };
}
export const controlsReader = runDir => scene => read(join(runDir, scene, 'controls.json'), []);

// A probe file a command that died left behind (it is removed right after its fetch otherwise).
export function sweepProbeFiles(root) {
  for (const d of STATIC_DIRS) {
    let names = [];
    try { names = readdirSync(join(root, d)); } catch { continue; }
    for (const n of names) if (/^nunchi-probe-[0-9a-f]{16}\.txt$/.test(n)) rmSync(join(root, d, n), { force: true });
  }
}
