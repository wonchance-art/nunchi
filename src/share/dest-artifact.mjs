// (A) a private Claude artifact (spec §7.6). nunchi cannot publish by itself: no public API exists without keys, and
// Claude Code's Artifact tool is off under `-p` and in the SDK. So the engine prepares the pack, seals it (the call and
// the sha256 of every file, in the state) and prints the share line; the skill makes exactly that Artifact call; the
// deny hook checks it against the seal (only that pack, to the pinned link) and asks the person every time; the
// PostToolUse hook records what the result says (the link the first publish made, whether the artifact is private).
//
// Layout at the artifact: the latest run at the top (the page is its index.html, in the fragment form, beside its
// share.json and findings.json), the screenshots in img/ (named by their bytes, so runs share them), and the share.json
// and findings.json of each of the last RETAIN runs under runs/<run>/. Retention removes only what nunchi's own list
// (the state's) says it published there, by `null` in the call.
import { resolve } from 'node:path';
import { byRun } from '../ledger.mjs';
import { RETAIN } from './config.mjs';
import { sha256 } from './pack.mjs';

// The Artifact tool's limits (its description, 2026-10-16 KST), in bytes as 10^6: the smaller reading of "MB".
export const ARTIFACT_LIMITS = { page: 16e6, file: 15e6, publishFiles: 255, publishBytes: 64e6, versionFiles: 511, versionBytes: 256e6 };
const ROOT_DATA = ['share.json', 'findings.json'];

// `pack`: buildPack's; `packDir`: where it was written; `at`: what nunchi published at this artifact so far
// ({ files: { path: { sha256, bytes } }, runs: [{ run, files }] }), or null. → { call, after, problem }
export function publishPlan({ pack, run, app, packDir, url = null, at = null, retain = RETAIN }) {
  const prev = { files: at?.files || {}, runs: at?.runs || [] };
  const page = pack.files.find(f => f.path === 'index.html');
  const mine = new Map();
  for (const f of pack.files) {
    if (f.path === 'index.html') continue;
    mine.set(f.path, f);
    if (ROOT_DATA.includes(f.path)) mine.set(`runs/${run}/${f.path}`, f);
  }
  const shaOf = f => (f.sha ??= sha256(f.data));
  const runFiles = ['index.html', ...mine.keys()].sort();
  const runs = [...prev.runs.filter(r => r.run !== run), { run, files: runFiles }].sort((a, b) => byRun(a.run, b.run)).slice(-retain);
  const keep = new Set(runs.flatMap(r => r.files));
  const files = {};
  const after = {};
  for (const [p, f] of mine) {
    after[p] = { sha256: shaOf(f), bytes: f.data.length };
    if (prev.files[p]?.sha256 !== shaOf(f)) files[p] = resolve(packDir, ...f.path.split('/'));
  }
  after['index.html'] = { sha256: shaOf(page), bytes: page.data.length };
  for (const p of Object.keys(prev.files).sort()) {
    if (keep.has(p) || p === 'index.html') { if (!after[p]) after[p] = prev.files[p]; continue; }
    files[p] = null;
  }
  const sorted = Object.fromEntries(Object.keys(files).sort().map(k => [k, files[k]]));
  const call = { action: 'publish', file_path: resolve(packDir, 'index.html'), ...(url ? { url } : { icon: 'checklist' }), files: sorted, title: `nunchi · ${app}` };
  // the limits, before anything is sent
  const sentFiles = [page, ...[...mine].filter(([p]) => sorted[p]).map(([, f]) => f)];
  const sentBytes = sentFiles.reduce((n, f) => n + f.data.length, 0);
  const total = Object.values(after).reduce((n, f) => n + f.bytes, 0);
  const big = sentFiles.find(f => f !== page && f.data.length > ARTIFACT_LIMITS.file);
  const problem = page.data.length > ARTIFACT_LIMITS.page ? { what: 'page', have: page.data.length, limit: ARTIFACT_LIMITS.page }
    : big ? { what: 'file', path: big.path, have: big.data.length, limit: ARTIFACT_LIMITS.file }
    : sentFiles.length > ARTIFACT_LIMITS.publishFiles ? { what: 'publish-files', have: sentFiles.length, limit: ARTIFACT_LIMITS.publishFiles }
    : sentBytes > ARTIFACT_LIMITS.publishBytes ? { what: 'publish-bytes', have: sentBytes, limit: ARTIFACT_LIMITS.publishBytes }
    : Object.keys(after).length > ARTIFACT_LIMITS.versionFiles ? { what: 'version-files', have: Object.keys(after).length, limit: ARTIFACT_LIMITS.versionFiles }
    : total > ARTIFACT_LIMITS.versionBytes ? { what: 'version-bytes', have: total, limit: ARTIFACT_LIMITS.versionBytes } : null;
  return { call, after: { files: Object.fromEntries(Object.keys(after).sort().map(k => [k, after[k]])), runs }, sent: { files: sentFiles.length, bytes: sentBytes }, problem };
}

// The seal the deny hook checks an Artifact call against: the call, and the sha256 of every file it sends (the page's
// too), by the real path the call names.
export function sealOf({ plan, pack, packDir, run, app, include, counts, url }) {
  const hashes = {};
  for (const f of pack.files) hashes[resolve(packDir, ...f.path.split('/'))] = f.sha ?? sha256(f.data);
  return { run, app, packDir: resolve(packDir), call: plan.call, hashes, after: plan.after, url, include, counts: { screens: counts.screens, bytes: counts.bytes, files: counts.files, visitorOnly: counts.visitorOnly } };
}
// "1.3 MB" (the owner's mock-up); a pack under 0.1 MB in KB, so it never reads "0 MB"
export const MB = n => (n < 1e5 ? `${Math.max(1, Math.round(n / 1e3))} KB` : `${Math.round(n / 1e5) / 10} MB`);
export function limitLine(run, p) {
  const n = x => (p.what.endsWith('files') ? String(x) : MB(x));
  const what = { page: `its page is ${MB(p.have)}; an artifact page takes at most ${MB(p.limit)}`, file: `${p.path} is ${MB(p.have)}; an artifact file takes at most ${MB(p.limit)}`,
    'publish-files': `it has ${n(p.have)} files; one artifact publish takes at most ${n(p.limit)}`, 'publish-bytes': `it is ${n(p.have)}; one artifact publish takes at most ${n(p.limit)}`,
    'version-files': `the artifact would hold ${n(p.have)} files; it holds at most ${n(p.limit)}`, 'version-bytes': `the artifact would hold ${n(p.have)}; it holds at most ${n(p.limit)}` }[p.what];
  return `Not shared: run ${run} is too big for your artifact (${what}). Nothing was sent. A Google Drive folder takes any size: nunchi share --setup in your own terminal.`;
}
