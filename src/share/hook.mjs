// The hooks' side of sharing (spec §7.6; design "nunchi share" §6). Read by the deny hook (PreToolUse, a pure data
// hook: it reads, never writes) and by the PostToolUse hook on Artifact, which records what a publish result says.
//
// PreToolUse on Artifact: a publish whose page or files lie in `.nunchi/` (or in the Drive folder sharing writes) is
// allowed only when it is exactly the pack `nunchi share` sealed — the call it wrote (`.nunchi/share/outbox/<run>/
// publish.json`), every file's sha256 as sealed, to the pinned link — while sharing is on for an artifact; then the
// person is asked, every time, with nunchi's sentence (`ask`, which auto mode cannot approve silently). Anything else
// from `.nunchi/` is denied. A publish of the agent's own page elsewhere is not nunchi's to judge.
// PostToolUse on Artifact: the link the first publish made is pinned; what nunchi published there is recorded (for
// retention); the audience the result states is kept, and an artifact that is no longer private stops sharing.
//
// What this is not: a boundary against the agent's own tools. An agent can copy a file elsewhere first and publish
// that; the hook sees only the paths in the call. It holds against honest mistakes and naive injection, as the rest of
// the hook does.
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { readShare, readShareLog, updateLog, stopShare, artifactUrl, shareFiles, kst, parseRepo, ARTIFACT_URL } from './config.mjs';

const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const norm = p => { const s = String(p).replace(/\\/g, '/').replace(/\/+$/, ''); return FOLD ? s.toLowerCase() : s; };
const within = (p, dir) => { const a = norm(p), b = norm(dir); return !!b && (a === b || a.startsWith(b + '/')); };
const realish = p => {
  let cur = resolve(p); const rest = [];
  for (let i = 0; i < 64; i++) { try { lstatSync(cur); break; } catch { const up = dirname(cur); if (up === cur) break; rest.unshift(basename(cur)); cur = up; } }
  try { return join(realpathSync.native(cur), ...rest); } catch { return resolve(p); }
};
const str = v => typeof v === 'string' && v.length > 0;
const MB = n => (n < 1e5 ? `${Math.max(1, Math.round(n / 1e3))} KB` : `${Math.round(n / 1e5) / 10} MB`);

// Every state folder's sharing (setup and log), read once per call. A file that cannot be read counts as nothing set
// up there (the hook then denies what would need it).
export function sharesOf(stateDirs) {
  const out = [];
  for (const dir of stateDirs) {
    let cfg = null, log = null;
    try { cfg = readShare(dir); } catch {}
    try { log = readShareLog(dir); } catch {}
    if (cfg || log?.sealed) out.push({ stateDir: dir, cfg, log });
  }
  return out;
}
// The Drive folders sharing writes (for the deny hook's write rule) and the remotes it pushes to
export const shareFolders = shares => shares.filter(x => x.cfg?.dest?.kind === 'drive').map(x => join(x.cfg.dest.root, ...x.cfg.dest.folder.split('/')));
export const shareRemotes = shares => shares.filter(x => x.cfg?.dest?.kind === 'git').map(x => x.cfg.dest.web.toLowerCase());
// a word that names one of those remotes, in any of its forms
export const namesRemote = (word, remotes) => { const p = parseRepo(word); return !!p && remotes.includes(p.web.toLowerCase()); };

const NUNCHI_PART = /(^|\/)\.nunchi(\/|$)/i;
const sourcesOf = files => {
  if (Array.isArray(files)) return files.map(f => (f && typeof f === 'object' ? f.path : f)).filter(str);
  if (!files || typeof files !== 'object') return [];
  return Object.values(files).map(v => (typeof v === 'string' ? v : v && typeof v === 'object' ? v.from : null)).filter(str);
};
const sha256 = data => createHash('sha256').update(data).digest('hex');
function fileSha(p) {
  try { const st = lstatSync(p); if (!st.isFile()) return null; return sha256(readFileSync(p)); } catch { return null; }
}
const DENY_OTHER = 'only the pack nunchi share sealed is published from .nunchi/, exactly as its publish.json says (run nunchi share; it prints the line and prepares the pack)';
const ALLOWED_KEYS = new Set(['action', 'file_path', 'files', 'url', 'title', 'icon']);

// The PreToolUse answer for an Artifact call: null (not nunchi's), a reason to deny, or { ask } with the sentence.
// `pathRule(p, opts)`: the deny hook's own rule for a path. `cwd`: the call's.
export function artifactRule(ti, { cwd, shares, pathRule }) {
  const action = ti.action ?? 'publish';
  const abs = p => resolve(cwd, String(p));
  if (action === 'read') return str(ti.out_dir) ? pathRule(ti.out_dir, { write: true }) : null;
  if (action !== 'publish') return null;
  const named = [ti.file_path, ...(Array.isArray(ti.file_paths) ? ti.file_paths : []), ...sourcesOf(ti.files), ti.root].filter(str);
  for (const p of named) { const why = pathRule(p, {}); if (why) return why; }
  const folders = shareFolders(shares);
  const touches = named.some(p => NUNCHI_PART.test(norm(abs(p))) || NUNCHI_PART.test(norm(realish(abs(p)))) || folders.some(f => within(abs(p), f) || within(realish(abs(p)), realish(f))));
  if (!touches) return null;
  // which seal names this page
  const page = str(ti.file_path) ? realish(abs(ti.file_path)) : null;
  const match = page && shares.find(x => x.log?.sealed && norm(realish(x.log.sealed.call.file_path)) === norm(page));
  if (!match) return DENY_OTHER;
  const { cfg, log } = match;
  const seal = log.sealed;
  if (!cfg || !cfg.on || cfg.dest.kind !== 'artifact') return `sharing is off${cfg?.stopped ? ' (the artifact is no longer private)' : ''}: only the person turns it on, in their own terminal (nunchi share --setup) or the board`;
  for (const k of Object.keys(ti)) if (!ALLOWED_KEYS.has(k)) return `${DENY_OTHER}: ${k} is not part of it`;
  if (seal.published) return 'that pack was published already: run nunchi share for the next one';
  const pinned = artifactUrl(cfg, log);
  if ((seal.url || null) !== (pinned || null)) return 'that pack was prepared for another artifact: run nunchi share again';
  if ((ti.url || null) !== (seal.call.url || null)) return `that pack goes to ${seal.call.url ? `your artifact ${seal.call.url}` : 'a new private artifact'}, not ${ti.url ? ti.url : 'a new one'}`;
  for (const k of ['title', 'icon']) if (ti[k] !== undefined && ti[k] !== seal.call[k]) return `${DENY_OTHER}: its ${k} is not the sealed one`;
  if (!ti.files || typeof ti.files !== 'object' || Array.isArray(ti.files)) return `${DENY_OTHER}: its files are a map of published paths`;
  const want = seal.call.files, got = ti.files;
  const keys = [...new Set([...Object.keys(want), ...Object.keys(got)])];
  for (const k of keys) {
    const w = want[k], g0 = got[k];
    const g = g0 && typeof g0 === 'object' ? g0.from : g0;
    if (w === null || w === undefined) { if (g !== null || !(k in want)) return `${DENY_OTHER}: ${k} is not in it`; continue; }
    if (!str(g) || norm(realish(abs(g))) !== norm(realish(w))) return `${DENY_OTHER}: ${k} is not the sealed file`;
  }
  // the files as sealed, byte for byte (a pack changed after sealing is refused)
  for (const p of [seal.call.file_path, ...Object.values(want).filter(str)]) {
    const want256 = seal.hashes?.[resolve(p)];
    if (!want256 || fileSha(p) !== want256) return `${basename(p)} of run ${seal.run}'s pack changed after nunchi sealed it: run nunchi share again`;
  }
  const c = seal.counts || {};
  const left = c.visitorOnly && !seal.include?.pageText ? 'Signed-in screens and page text are left out.' : c.visitorOnly ? 'Signed-in screens are left out.' : !seal.include?.pageText ? 'Page text is left out.' : 'Signed-in screens and page text go too.';
  return { ask: `nunchi: publish run ${seal.run} of ${seal.app} to ${seal.call.url ? `your artifact ${seal.call.url}` : 'a new private artifact'}?\n${c.screens ?? 0} ${c.visitorOnly ? 'visitor ' : ''}screens, ${MB(c.bytes ?? 0)}. ${left}` };
}

// What a publish result says about its audience. → 'private' | 'shared' | 'unknown'
export function audienceOf(text) {
  const t = String(text || '');
  if (/\b(shared with (your |the )?(organi[sz]ation|org|team|people|anyone)|public (link|artifact)|anyone with the link|is public|published (to a )?public)\b/i.test(t)) return 'shared';
  if (/\b(is|stays|remains) private\b|\bprivate (to|by default)\b|\bvisible only to you\b/i.test(t)) return 'private';
  return 'unknown';
}
const URL_IN = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]{6,128}/;

// The PostToolUse side: → { context } (a line for Claude) or null. Writes the log (and stops sharing) when the call was
// a sealed pack's publish and its result names the artifact.
export function postArtifact(input, { stateDirs, now = Date.now, generation = dir => join(dir, 'generation') } = {}) {
  if (String(input?.tool_name || '') !== 'Artifact') return null;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if ((ti.action ?? 'publish') !== 'publish' || !str(ti.file_path)) return null;
  const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : process.cwd();
  const page = norm(realish(resolve(cwd, ti.file_path)));
  const match = sharesOf(stateDirs).find(x => x.log?.sealed && norm(realish(x.log.sealed.call.file_path)) === page);
  if (!match) return null;
  const text = typeof input.tool_response === 'string' ? input.tool_response : JSON.stringify(input.tool_response ?? '');
  // PostToolUse runs only after a call that succeeded: a result that names no link went to the call's own
  const url = URL_IN.exec(text)?.[0] || (str(ti.url) ? ti.url : null);
  if (!url || !ARTIFACT_URL.test(url)) return null;
  const seal = match.log.sealed;
  const at = kst(now());
  const audience = audienceOf(text);
  updateLog(match.stateDir, l => {
    if (!l.sealed || l.sealed.run !== seal.run) return l;
    const sends = [...l.sends];
    for (let i = sends.length - 1; i >= 0; i--) if (sends[i].run === seal.run && sends[i].state === 'prepared') { sends[i] = { ...sends[i], state: 'published', where: url, at }; break; }
    return { ...l, sends, sealed: { ...l.sealed, published: at }, written: { ...l.written, [`artifact|${url}`]: seal.after }, artifact: { url: seal.url || url, audience, at } };
  }, { generation: generation(match.stateDir) });
  if (audience === 'shared') {
    stopShare(match.stateDir, 'artifact-not-private', { url, at, generation: generation(match.stateDir) });
    return { context: `nunchi: the publish result says your artifact ${url} is no longer private, so sharing stopped. Tell the person: make it private again from its Share menu, then set sharing up again in their own terminal (nunchi share --setup).` };
  }
  return { context: `nunchi: run ${seal.run} was published to ${url}${audience === 'private' ? ' (private)' : ''}. Tell the person the share line, nothing more.` };
}
export { shareFiles };
