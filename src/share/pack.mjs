// The pack `nunchi share` sends (spec §7.6): one run and the ledger as a folder a cloud Claude session can read.
//
//   share.json     what the pack is and holds: the run, what was included and left out, the groups a person decided Fix,
//                  and every other file with its bytes and sha256 (a partial sync shows; a forgery that rewrites
//                  share.json too does not: there is no key to sign with)
//   findings.json  `export --format json` (page text off unless the person turned it on)
//   index.html     `export --html` with page text off, only the screenshots that go (the fragment form for an artifact)
//   img/<hash>.jpg the screenshots of the screens that go: visitor screens by default
//
// Deterministic: no clock, every list sorted, the same run, ledger, decisions and choice give the same bytes. Never in
// a pack: the saved login, recordings (`har/`), `network.json`, `console.json`, `text.txt`, `aria.yml`, cookies, tokens,
// canaries and answer keys, the ledger's state — the pack is built from the exports, which never read them. A screen
// whose captured text holds a secret-shaped string (`text.txt` and `aria.yml` are read here only to decide, never
// copied) loses its screenshot. Just before a send every text file of the pack is scanned once more, whole; one hit
// stops the send, said by location and kind only.
import { readFileSync, lstatSync, existsSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { buildModel, renderHtml } from '../export-html.mjs';
import { findingsModel, exportJson, DEFAULT_STATUSES } from '../export-findings.mjs';
import { scrubSecrets } from '../rules.mjs';
import { readManifest, sceneDir } from '../hunt.mjs';
import { stableJson, privateDir, refuseLink, setMode } from '../stable.mjs';
import { HUMAN_CHANNELS } from '../ledger.mjs';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
const TEXT_MAX = 4 * 1024 * 1024;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A screen's captured text as capture wrote it: capture writes `[secret-shaped: <kind>]` where it scrubbed something,
// and the scrubber may still find a shape an older nunchi let through. Read only to decide, never copied.
export const secretShaped = text => typeof text === 'string' && (text.includes('[secret-shaped:') || scrubSecrets(text) !== text);
function readSmall(file) {
  try { const st = lstatSync(file); if (!st.isFile() || st.size > TEXT_MAX) return st.isFile() ? '[secret-shaped: too-large-to-check]' : ''; return readFileSync(file, 'utf8'); } catch { return ''; }
}
// The screens (of `scenes`) whose `text.txt` or `aria.yml` holds a secret-shaped string → a Set of scene ids
export function withheldScenes(runDir, scenes) {
  const out = new Set();
  for (const s of scenes) {
    const dir = sceneDir(runDir, s.id);
    if (!dir) continue;
    if (['text.txt', 'aria.yml'].some(f => secretShaped(readSmall(join(dir, f))))) out.add(s.id);
  }
  return out;
}

// The first secret-shaped string in a text: { kind, line } or null. The whole text is scrubbed (a token split across
// lines included); where the scrubbed text first differs is where it is.
export function findSecret(text) {
  const out = scrubSecrets(text);
  if (out === text) return null;
  let i = 0;
  while (i < text.length && text[i] === out[i]) i++;
  const kind = /^\[secret-shaped: ([a-z0-9-]+)\]/.exec(out.slice(i))?.[1] || 'secret';
  return { kind, line: text.slice(0, i).split('\n').length };
}
const TEXT_FILE = /\.(html|json)$/;
// → { path, kind, line } of the first hit in the pack's text files, or null
export function scanPack(files) {
  for (const f of [...files].sort((a, b) => cmp(a.path, b.path))) {
    if (!TEXT_FILE.test(f.path)) continue;
    const hit = findSecret(f.data.toString('utf8'));
    if (hit) return { path: f.path, ...hit };
  }
  return null;
}

// The pack of one run. `led`/`view`: the ledger (project.mjs loadLedger, ledgerView); `include`: { signedIn, pageText };
// `form`: 'page' or 'fragment' (an artifact); `branch`: the branch the run's commit is on, when known; `partial`: why the
// run is not a full check (send.mjs partialWhy), or null. → { files: [{ path, data }], share, counts }
export function buildPack({ runDir, nunchiDir, led, view, root, project, include, form = 'page', version, app, branch = null, partial = null }) {
  const meta = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  const manifest = readManifest(runDir);
  const persons = include.signedIn ? ['guest', 'signed-in'] : ['guest'];
  const candidates = (Array.isArray(manifest.scenes) ? manifest.scenes : []).filter(s => s && s.canary === undefined && s.status === 'captured' && persons.includes(s.person) && sceneDir(runDir, s.id));
  const withheld = withheldScenes(runDir, candidates);
  const m = buildModel({ runDir, nunchiDir, ledger: led, shots: { persons, withheld } });
  const html = renderHtml(m, { imageUrl: k => `"img/${k}.jpg"`, form, pageText: include.pageText });
  const fm = findingsModel({ led, view, root, project, statuses: DEFAULT_STATUSES, pageText: include.pageText });
  const files = [{ path: 'index.html', data: Buffer.from(html) }, { path: 'findings.json', data: Buffer.from(exportJson(fm)) }];
  for (const key of [...m.images.keys()].sort()) files.push({ path: `img/${key}.jpg`, data: readFileSync(m.images.get(key).file) });
  // the groups a person decided Fix (board or their terminal): the cloud side fixes only these; the agent's apart
  const human = new Set(), agent = new Set();
  for (const r of view.rows) if (r.status === 'to-fix') (HUMAN_CHANNELS.has(r.decision?.channel) ? human : agent).add(String(r.group));
  const shown = m.scenes.filter(s => s.img);
  // findings whose every place was seen by someone whose screenshots stay home: text only
  const textOnly = fm.groups.filter(g => g.items.some(it => it.route !== null) && g.items.every(it => !it.persons.some(p => persons.includes(p)))).length;
  const listed = files.map(f => ({ path: f.path, bytes: f.data.length, sha256: sha256(f.data) })).sort((a, b) => cmp(a.path, b.path));
  const share = {
    schema: 1, tool: 'nunchi', version, app, run: meta.id ?? null, kind: partial ? 'partial' : 'full', ...(partial ? { partialWhy: partial } : {}), wholeApp: meta.wholeApp === true,
    commit: typeof meta.commit === 'string' ? meta.commit : null, branch, treeMatches: meta.dirty === false,
    included: { screens: shown.length, persons, pageText: include.pageText },
    leftOut: { signedInScreens: m.scenes.filter(s => s.notShared === 'signed-in').length, secretShapedScreens: m.scenes.filter(s => s.notShared === 'secret-shaped').length, pageTextFields: fm.counts.pageTextLeftOut },
    findings: { groups: fm.counts.groups, places: fm.counts.items, textOnly },
    groups: { toFix: [...human].sort(), decidedByAgent: [...agent].filter(g => !human.has(g)).sort() },
    form, files: listed,
  };
  files.push({ path: 'share.json', data: Buffer.from(stableJson(share)) });
  files.sort((a, b) => cmp(a.path, b.path));
  const bytes = files.reduce((n, f) => n + f.data.length, 0);
  return { files, share, counts: { screens: shown.length, files: files.length, bytes, images: m.images.size, ...share.leftOut, groups: fm.counts.groups, textOnly, visitorOnly: !include.signedIn } };
}

// Writes the pack into `dir` (made fresh: a folder of nunchi's own, `.partial` first and renamed when complete). Files
// 0600, folders 0700; never through a link.
export function writePackDir(dir, files) {
  const part = `${dir}.partial`;
  for (const p of [dir, part]) { refuseLink(p); rmSync(p, { recursive: true, force: true }); }
  privateDir(part);
  for (const f of files) {
    const to = join(part, ...f.path.split('/'));
    privateDir(dirname(to));
    writeFileSync(to, f.data, { flag: 'wx', mode: 0o600 });
    setMode(to, 0o600);
  }
  renameSync(part, dir);
  return dir;
}
// The files of a pack folder as written (path, bytes, sha256), or null when one cannot be read: for the hook's check.
export function listPackDir(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), p);
      else if (e.isFile()) { const data = readFileSync(join(d, e.name)); out.push({ path: p, bytes: data.length, sha256: sha256(data) }); }
      else throw new Error(`${p} is not a plain file`);
    }
  };
  try { if (!existsSync(dir)) return null; walk(dir, ''); } catch { return null; }
  return out.sort((a, b) => cmp(a.path, b.path));
}
