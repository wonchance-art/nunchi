#!/usr/bin/env node
// The plugin's PreToolUse hook (design 0.1-c §1, spec §5.1 "M2 deny hook"): keeps Claude Code's tools away from what
// only the person (the board, their own terminal) or the engine may touch. A pure data hook: it reads the tool call on
// stdin, looks at the paths and words in it, and answers; no network, no state written.
//
// Denied, to every tool (Read, Grep, Glob, Write, Edit, MultiEdit, NotebookEdit, Bash, WebFetch):
// - the shared state: `<git-common-dir>/nunchi/**` (ledger, approvals with their channels, the run-id counter, the
//   generation, metrics, board records) and `.nunchi/state/**` (the per-folder fallback);
// - the answer keys outside the project (`$XDG_STATE_HOME/nunchi/**`, `%LOCALAPPDATA%\nunchi\**`,
//   `~/.local/state/nunchi/**`), whose path the CLI prints; and inside a run, `canaries.json` and older keys;
// - the saved login (`.nunchi/auth.json`: session cookies);
// - the board: requests to a running board's port, its control socket, and `/proc/<pid>` of its process (the token
//   lives in its memory only), and any `/proc/<n>/cmdline|environ|mem` (a browser's command line holds the one-time
//   link for a moment).
// Denied as writes (reading them is fine: they are committed files): `.nunchi/decisions/**`, `.nunchi/labels/**`,
// `.nunchi/lenses/**`, `.nunchi/lenses.lock.json`, `.nunchi/config.json` (allowHosts is the user's to write, D10).
// Denied commands: `nunchi … approve`, `nunchi … label` / `--label`, `nunchi fix --approve-checks` (human channels
// only), nunchi run under a pseudo-terminal wrapper (`script`, `unbuffer`, `expect`, a Python pty): that would pass
// for the person's own terminal (the `cli-tty` channel); and the board's script run directly, or asked for its link
// (`--link-to-parent`).
//
// How a Bash command is read: split into segments (also at `$(`, backticks and parentheses), words joined as a shell
// joins them (`.nu"nchi"`), `cd` followed, globs and braces expanded against the file system, pieces of words checked
// as paths (inline code), `sh -c` judged as a command. Recursive reads (grep -r, rg, find -exec / -delete, find or
// rg --files into xargs) are denied when they reach the state, keys, auth or a run's canaries unless their filters
// (--include / --exclude-dir, -g, -name, -path -prune) leave those out; rg's own skipping of dot folders counts.
// Process lists with command lines (ps aux / -ef / -o args, pgrep -a, top -c, /proc/*/cmdline) are denied. Grep and
// Glob are denied with a base in .git, .nunchi itself, .nunchi/runs or /proc.
//
// Honest limits (design §8.3): this matches paths and words in the tool call. A command that builds a path at run
// time (variables, base64, a script file) is not seen. Neither this hook nor the board's channels are a security
// boundary against code that runs as the same user: such code can read the same files and start the same processes
// as the person. What they give is an attestation that holds against honest mistakes and naive prompt injection (a
// dismissal recorded by the agent does not count until the person confirms it in the board). For a repository you do
// not trust, run the agent in a container or as another user. Codex CLI has no such hook.
import { readFileSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve, dirname, basename, isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import { gitRunner } from './runs.mjs';
import { pathToFileURL } from 'node:url';

const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const norm = p => { const s = String(p).replace(/\\/g, '/').replace(/\/+$/, ''); return FOLD ? s.toLowerCase() : s; };
const within = (p, dir) => { const a = norm(p), b = norm(dir); return !!b && (a === b || a.startsWith(b + '/')); };
const realish = p => {
  let cur = resolve(p); const rest = [];
  for (let i = 0; i < 64; i++) { try { lstatSync(cur); break; } catch { const up = dirname(cur); if (up === cur) break; rest.unshift(basename(cur)); cur = up; } }
  try { return join(realpathSync(cur), ...rest); } catch { return resolve(p); }
};

// Where the answer keys may be: every candidate, whichever one this machine uses.
export function keyBases(env = process.env) {
  const out = [join(homedir(), '.local', 'state', 'nunchi')];
  if (env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)) out.push(join(env.XDG_STATE_HOME, 'nunchi'));
  if (env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA)) out.push(join(env.LOCALAPPDATA, 'nunchi'));
  return out;
}
// The repository's common git folder, through git with its own programs off (as the engine runs it), or null.
function gitCommonDir(cwd) {
  try {
    const out = gitRunner(cwd, { timeout: 3000 })(['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    return out && isAbsolute(out) ? resolve(out) : null;
  } catch { return null; }
}
// Running boards: their port, pid and socket, from the board records nunchi keeps in the state.
function boards(stateDirs) {
  const out = [];
  for (const dir of stateDirs) {
    let names = [];
    try { names = readdirSync(join(dir, 'boards')).filter(n => /^\d+\.json$/.test(n)); } catch { continue; }
    for (const n of names) {
      try { const r = JSON.parse(readFileSync(join(dir, 'boards', n), 'utf8')); if (Number.isInteger(r.port)) out.push({ port: r.port, pid: Number(r.pid) || null, socket: typeof r.socket === 'string' ? r.socket : null }); } catch {}
    }
  }
  return out;
}
// Every state folder of this repository: `<common>/nunchi/<app>/state` for each app, and `.nunchi/state` of the cwd.
function stateDirsOf(cwd, common) {
  const out = [join(cwd, '.nunchi', 'state')];
  if (common) { try { for (const app of readdirSync(join(common, 'nunchi'))) out.push(join(common, 'nunchi', app, 'state')); } catch {} }
  return out;
}

// What a project protects, computed once per call. `env` and `cwd` come from the hook's input.
// Is there a `.git` (a folder, or a worktree's file) here or in a folder above? Git is asked only then, so a call in
// a folder that is no repository spawns nothing.
export function plausibleGit(cwd) {
  let cur = resolve(cwd);
  for (let i = 0; i < 128; i++) {
    try { lstatSync(join(cur, '.git')); return true; } catch {}
    const up = dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
  return false;
}
export function protectedOf(cwd, { env = process.env, common = undefined } = {}) {
  const gc = common === undefined ? (plausibleGit(cwd) ? gitCommonDir(cwd) : null) : common;
  const stateDirs = stateDirsOf(cwd, gc);
  return { cwd, common: gc, keys: keyBases(env), boards: boards(stateDirs) };
}

// A path (absolute, or relative to the cwd): which protection it falls under, or null. `write`: the call writes.
const READ_DENY = [
  [/(^|\/)\.git\/nunchi(\/|$)/, 'nunchi\'s shared state (the ledger, approvals and board records) is the engine\'s: use nunchi findings / nunchi decide'],
  [/(^|\/)\.nunchi\/state(\/|$)/, 'nunchi\'s state is the engine\'s: use nunchi findings / nunchi decide'],
  [/(^|\/)\.nunchi\/auth\.json$/, 'the saved login holds session cookies; only the engine reads it'],
  [/(^|\/)\.nunchi\/runs\/[^/]+\/(canaries\.json|hunt-key\.json|verify-key\.json|recheck-key\.json)$/, 'the canaries and answer keys must stay unseen by the hunter, verifier and re-checker'],
  [/^\/proc\/[^/]+\/(cmdline|environ|mem|maps|fd)(\/|$)/, 'process memory and command lines can hold the board\'s one-time link or key'],
];
const WRITE_DENY = [
  [/(^|\/)\.nunchi\/decisions(\/|$)/, 'decisions are recorded with nunchi decide (or in the board), never written by hand'],
  [/(^|\/)\.nunchi\/labels(\/|$)/, 'labels are made by a person in the board (nunchi open --label)'],
  [/(^|\/)\.nunchi\/lenses(\/|$)|(^|\/)\.nunchi\/lenses\.lock\.json$/, 'lens packs are approved by the person; edit them only when they ask, in their own editor'],
  [/(^|\/)\.nunchi\/config\.json$/, '.nunchi/config.json (allowHosts) is written by the user, never by the AI'],
];
export function pathRule(p, prot, { write = false } = {}) {
  const abs = isAbsolute(p) ? resolve(p) : resolve(prot.cwd, p);
  for (const cand of [abs, realish(abs)]) {
    const n = norm(cand);
    if (prot.common && within(cand, join(prot.common, 'nunchi'))) return READ_DENY[0][1];
    for (const k of prot.keys) if (within(cand, k)) return 'the answer keys are kept out of reach of the AI (they say which findings are planted or decoys)';
    for (const b of prot.boards) {
      if (b.socket && within(cand, b.socket)) return 'the board\'s control socket is for nunchi open only';
      if (b.pid && within(cand, `/proc/${b.pid}`)) return 'the board\'s process holds its key';
    }
    for (const [re, why] of READ_DENY) if (re.test(n)) return why;
    if (write) for (const [re, why] of WRITE_DENY) if (re.test(n)) return why;
  }
  return null;
}

// ---- Bash ------------------------------------------------------------------------------------------------------------

const NUNCHI = /(^|[\s;&|(`'"/])(nunchi|cli\.mjs)(?=[\s;&|)`'"]|$)/;
const PTY = /(^|[\s;&|(`])(script|unbuffer|expect|ptyexec|socat)\s|\bpty\.spawn\b|\bimport\s+pty\b|\bopenpty\b/;
const READ_ONLY = new Set(['cat', 'ls', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'stat', 'file', 'diff', 'tree', 'jq', 'du']);
const GIT_READ = new Set(['diff', 'log', 'show', 'status', 'add', 'commit', 'blame', 'ls-files', 'grep']);
// The board is started by `nunchi open` only: run directly, or asked for its link, it could hand a session to the agent.
const BOARD_SCRIPT = /(^|[\s;&|(`'"/=])board\/(server|launch)\.mjs\b/;
const RUNS_CODE = /(^|\/)(node|nodejs|bun|deno|tsx|ts-node|npx|pnpx|bunx)(\.exe)?$/i;
// words before the command itself: they run what follows them
const WRAPPERS = new Set(['env', 'nohup', 'setsid', 'nice', 'ionice', 'time', 'exec', 'command', 'builtin', 'sudo', 'doas', 'stdbuf', 'chronic', 'caffeinate']);

// The words of one shell segment as a shell joins them: quoted and bare parts next to each other are one word
// (`.nu"nchi"` is `.nunchi`); a backslash outside single quotes escapes the next character; quotes are dropped.
export function shellWords(seg) {
  const out = [];
  let cur = null, q = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') { if (c === '"') q = null; else if (c === '\\' && /["\\$`]/.test(seg[i + 1] || '')) cur += seg[++i]; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; if (cur === null) cur = ''; continue; }
    if (c === '\\' && i + 1 < seg.length) { cur = (cur ?? '') + seg[++i]; continue; }
    if (/\s/.test(c)) { if (cur !== null) out.push(cur); cur = null; continue; }
    cur = (cur ?? '') + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}
const words = shellWords;
// A command's segments, split at ; && || | & newlines, $( ` ( and ) (inside quotes too: stricter, never looser), each
// with whether a pipe feeds it.
function segments(cmd) {
  const parts = String(cmd).split(/(\|\||&&|;|\||(?<![>&])&(?![>&])|\n|\$\(|`|\(|\))/);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) if (parts[i].trim()) out.push({ text: parts[i], pipe: i > 0 && parts[i - 1] === '|' });
  return out;
}
// The same, split only outside quotes (for inline code, kept whole).
function quotedSegments(cmd) {
  const out = [];
  let cur = '', q = null;
  const s = String(cmd);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"') { cur += c + (s[i + 1] ?? ''); i++; continue; } cur += c; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '\\') { cur += c + (s[i + 1] ?? ''); i++; continue; }
    if (c === ';' || c === '\n' || ((c === '&' || c === '|') && s[i + 1] === c) || c === '|') { out.push(cur); cur = ''; if (s[i + 1] === c && c !== ';' && c !== '\n') i++; continue; }
    cur += c;
  }
  out.push(cur);
  return out.filter(x => x.trim());
}
const baseName = w =>String(w || '').replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
// Where the command word is: after VAR=value words and wrappers (with a wrapper's own options).
function commandAt(w) {
  let i = 0;
  while (i < w.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) { i++; continue; }
    const b = baseName(w[i]);
    if (WRAPPERS.has(b)) { i++; while (i < w.length && /^-/.test(w[i])) i++; continue; }
    if (b === 'timeout') { i++; while (i < w.length && /^(-|\d)/.test(w[i])) i++; continue; }
    break;
  }
  return i;
}

// ---- globs, as the file system answers them --------------------------------------------------------------------------
const GLOB_CHARS = /[*?[]/;
const BRACES = /\{[^{}]*,[^{}]*\}/;
function expandBraces(w, cap = 64) {
  const m = BRACES.exec(w);
  if (!m) return [w];
  const out = [];
  for (const alt of m[0].slice(1, -1).split(',')) for (const x of expandBraces(w.slice(0, m.index) + alt + w.slice(m.index + m[0].length), cap)) { if (out.length >= cap) return out; out.push(x); }
  return out;
}
// A glob → a regex. `slash`: `*` and `?` cross `/` too (find -path); otherwise one name, `**` any depth. Dot files
// match too (stricter than a shell).
const segRe = (g, { slash = false } = {}) => new RegExp('^' + g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, slash ? '.*' : '[^/]*')
  .replace(/\?/g, slash ? '.' : '[^/]').replace(/\[!/g, '[^').replace(/\u0000/g, '.*') + '$', FOLD ? 'i' : '');
// A word with braces or glob characters → the paths it names on this machine (at most `max`), and the word itself.
export function expandGlob(word, cwd, { max = 4000 } = {}) {
  const out = new Set();
  for (const w of expandBraces(word)) {
    out.add(w);
    if (!GLOB_CHARS.test(w)) continue;
    const parts = resolve(cwd, w).replace(/\\/g, '/').split('/');
    const add = (p, n) => (p.endsWith('/') ? p + n : `${p}/${n}`);
    let paths = [parts[0] === '' ? '/' : `${parts[0]}/`];
    for (let i = 1; i < parts.length && paths.length; i++) {
      const seg = parts[i];
      if (!seg) continue;
      const next = [];
      if (seg === '**') {
        const walk = (p, depth) => {
          if (next.length >= max) return;
          next.push(p);
          if (!depth) return;
          let ents = [];
          try { ents = readdirSync(p, { withFileTypes: true }); } catch { return; }
          for (const e of ents) if (e.isDirectory()) walk(add(p, e.name), depth - 1);
        };
        for (const p of paths) walk(p, 8);
      } else if (GLOB_CHARS.test(seg)) {
        const re = segRe(seg);
        for (const p of paths) { let names = []; try { names = readdirSync(p); } catch {} for (const n of names) if (re.test(n) && next.length < max) next.push(add(p, n)); }
      } else for (const p of paths) next.push(add(p, seg));
      paths = next;
    }
    for (const p of paths.slice(0, max)) out.add(p);
  }
  return [...out];
}

// ---- reads that walk folders -------------------------------------------------------------------------------------------
const STATE_FILES = ['ledger.json', 'approved.json', 'generation', 'metrics.json', 'run-id', '4242.json', '4242.sock', 'scripts-approved.json', 'labels-approved.json'];
const KEY_FILES = ['hunt-key.json', 'verify-key.json', 'recheck-key.json'];
const RUN_FILES = ['canaries.json', ...KEY_FILES];
// What the AI must not read, as places (a folder, or a file) with sample names of the files a folder holds.
function locations(prot) {
  if (prot.locs) return prot.locs;
  const out = [];
  if (prot.common) out.push({ path: join(prot.common, 'nunchi'), files: STATE_FILES });
  out.push({ path: join(prot.cwd, '.git', 'nunchi'), files: STATE_FILES }, { path: join(prot.cwd, '.nunchi', 'state'), files: STATE_FILES },
    { path: join(prot.cwd, '.nunchi', 'auth.json'), files: ['auth.json'], file: true });
  const runs = join(prot.cwd, '.nunchi', 'runs');
  let ids = [];
  try { ids = readdirSync(runs).slice(0, 1000); } catch {}
  for (const id of ids) for (const f of RUN_FILES) out.push({ path: join(runs, id, f), files: [f], file: true });
  for (const k of prot.keys) out.push({ path: k, files: KEY_FILES });
  // only what is there (nothing to reach otherwise)
  prot.locs = out.filter(l => { try { lstatSync(l.path); return true; } catch { return false; } });
  for (const l of prot.locs) l.real = realish(l.path);
  return prot.locs;
}
// The protected places a recursive read of `root` reaches, each with its paths below root (the files a filter has to
// rule out). A root inside a place (`inside`) reaches it whatever is excluded.
function reaches(root, cwd, prot) {
  const R = realish(resolve(cwd, root));
  const out = [];
  for (const l of locations(prot)) {
    if (within(R, l.real) || within(R, l.path)) { out.push({ ...l, inside: true, paths: l.files }); continue; }
    const L = within(l.real, R) ? l.real : within(l.path, R) ? l.path : null;
    if (!L) continue;
    const rel = relative(R, L).replace(/\\/g, '/');
    out.push({ ...l, inside: false, paths: l.file ? [rel] : l.files.map(f => `${rel}/${f}`) });
  }
  return out;
}
// Does a filter glob match a path below the root (`a/b/c.json`)? Without a `/` it matches a name at any depth;
// `dirs`: only a folder on the way (an excluded folder is not entered).
function globHits(g, path, { dirs = false } = {}) {
  const names = path.split('/');
  for (const x of expandBraces(String(g).replace(/^\.\//, ''))) {
    const pat = x.replace(/\/\*\*$|\/$/, '');
    if (!pat.includes('/')) {
      const re = segRe(pat);
      if (dirs ? names.slice(0, -1).some(n => re.test(n)) : re.test(names.at(-1))) return true;
    } else {
      const re = segRe(pat.replace(/^\*\*\//, ''), { slash: true });
      const cands = dirs ? names.slice(0, -1).map((_, i) => names.slice(0, i + 1).join('/')) : [path];
      if (cands.some(c => re.test(c))) return true;
    }
  }
  return false;
}
// A place is safe for a filtered recursive read when every path of it is excluded, or includes are given and none of
// its paths matches one.
function filtered(place, { excludeDirs = [], excludeFiles = [], includes = [], excl = [], incl = [] } = {}) {
  const hasIncl = includes.length + incl.length > 0;
  const included = p => includes.some(g => globHits(g, p)) || incl.some(fn => fn(p));
  if (hasIncl && place.paths.every(p => !included(p))) return true;
  if (place.inside) return false;
  return place.paths.every(p => excludeDirs.some(g => globHits(g, p, { dirs: true })) || excludeFiles.some(g => globHits(g, p)) || excl.some(fn => fn(p)));
}
const RECURSIVE_WHY = 'a recursive read here reaches nunchi\'s state, answer keys or a run\'s canaries: search the app\'s own folders, or exclude .git and .nunchi';
const reachesUnfiltered = (roots, cwd, prot, f, skip = () => false) => {
  for (const root of roots.length ? roots : ['.']) for (const r of expandGlob(root, cwd)) for (const place of reaches(r, cwd, prot)) if (!skip(place) && !filtered(place, f)) return RECURSIVE_WHY;
  return null;
};
// Splits `--key=value` / `--key value`.
const longOpt = (args, i) => { const a = args[i]; const k = a.includes('=') ? a.slice(0, a.indexOf('=')) : a; return { k, value: a.includes('=') ? a.slice(a.indexOf('=') + 1) : null }; };

// grep -r: the roots (the operands after the pattern, `.` when none) with --include, --exclude and --exclude-dir.
function grepRule(args, cwd, prot) {
  let recursive = false, pattern = false, end = false;
  const roots = [], f = { excludeDirs: [], excludeFiles: [], includes: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!end && a === '--') { end = true; continue; }
    if (!end && a.startsWith('--')) {
      const { k, value } = longOpt(args, i);
      const val = () => (value !== null ? value : args[++i] ?? '');
      if (k === '--recursive' || k === '--dereference-recursive') recursive = true;
      else if (k === '--include') f.includes.push(val());
      else if (k === '--exclude') f.excludeFiles.push(val());
      else if (k === '--exclude-dir') f.excludeDirs.push(val());
      else if (k === '--regexp' || k === '--file') { val(); pattern = true; }
      else if (['--max-count', '--after-context', '--before-context', '--context', '--directories', '--devices', '--label', '--binary-files', '--exclude-from'].includes(k)) val();
      continue;
    }
    if (!end && /^-[A-Za-z0-9]/.test(a)) {
      const g = a.slice(1);
      const m = /[efmABCdD]/.exec(g);
      if (/[rR]/.test(m ? g.slice(0, m.index) : g)) recursive = true;
      if (m) { if (m[0] === 'e' || m[0] === 'f') pattern = true; if (m.index === g.length - 1) i++; }
      continue;
    }
    if (!pattern) { pattern = true; continue; }
    roots.push(a);
  }
  return recursive ? reachesUnfiltered(roots, cwd, prot, f) : null;
}

// rg: always recursive; folders whose name starts with a dot (.git, .nunchi, .local) are skipped unless --hidden, -.
// or -uu. Filters: -g / --glob (`!` excludes), -t / --type.
function rgRule(args, cwd, prot, { piped = false } = {}) {
  let hidden = false, pattern = false, end = false, files = false, u = 0;
  const roots = [], f = { excludeDirs: [], excludeFiles: [], includes: [] };
  const glob = g => { if (g.startsWith('!')) { f.excludeDirs.push(g.slice(1)); f.excludeFiles.push(g.slice(1)); } else f.includes.push(g); };
  const type = t => f.includes.push(t === 'all' ? '*' : `*.${t}`);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!end && a === '--') { end = true; continue; }
    if (!end && a.startsWith('--')) {
      const { k, value } = longOpt(args, i);
      const val = () => (value !== null ? value : args[++i] ?? '');
      if (k === '--hidden') hidden = true;
      else if (k === '--unrestricted') u++;
      else if (k === '--files') files = true;
      else if (k === '--glob' || k === '--iglob') glob(val());
      else if (k === '--type') type(val());
      else if (k === '--regexp' || k === '--file') { val(); pattern = true; }
      else if (['--type-not', '--max-count', '--after-context', '--before-context', '--context', '--threads', '--max-columns', '--max-depth', '--type-add', '--encoding', '--pre', '--replace', '--sort', '--sortr', '--max-filesize', '--colors', '--path-separator', '--ignore-file'].includes(k) && value === null) i++;
      continue;
    }
    if (!end && /^-[A-Za-z0-9.]/.test(a)) {
      const g = a.slice(1);
      const m = /[efgtTmABCjMdEr]/.exec(g);
      const flags = m ? g.slice(0, m.index) : g;
      if (flags.includes('.')) hidden = true;
      u += (flags.match(/u/g) || []).length;
      if (m) {
        const v = m.index < g.length - 1 ? g.slice(m.index + 1) : args[++i] ?? '';
        if (m[0] === 'e' || m[0] === 'f') pattern = true;
        if (m[0] === 'g') glob(v);
        if (m[0] === 't') type(v);
      }
      continue;
    }
    if (!pattern && !files) { pattern = true; continue; }
    roots.push(a);
  }
  if (files && !piped) return null;                                    // file names only
  if (u >= 2) hidden = true;
  const skipped = place => !hidden && !place.inside && place.paths.every(p => p.split('/').slice(0, -1).some(n => n.startsWith('.')));
  return reachesUnfiltered(roots, cwd, prot, f, skipped);
}

// find with -exec / -execdir / -ok / -okdir / -delete, or piped into xargs: its roots, -name and -path filters and
// exclusions (`! -name`, `-not -path`, `-path … -prune`), each as find matches them (the path as find prints it).
function findRule(args, cwd, prot, { piped = false } = {}) {
  const roots = [];
  let i = 0;
  while (i < args.length && /^-([HLP]|O\d|D)$/.test(args[i])) i += args[i] === '-D' ? 2 : 1;
  for (; i < args.length && !/^[-(!)]/.test(args[i]); i++) roots.push(args[i]);
  const expr = args.slice(i);
  if (!piped && !expr.some(a => /^-(exec|execdir|ok|okdir|delete)$/.test(a))) return null;
  for (const root of roots.length ? roots : ['.']) {
    const full = p => `${root.replace(/\/+$/, '')}/${p}`;
    const f = { includes: [], excludeFiles: [], excl: [], incl: [] };
    for (let j = 0; j < expr.length; j++) {
      const a = expr[j], neg = expr[j - 1] === '!' || expr[j - 1] === '-not';
      if (/^-i?name$/.test(a)) (neg ? f.excludeFiles : f.includes).push(expr[++j] ?? '');
      else if (/^-(i?path|i?wholename)$/.test(a)) {
        const re = segRe(expr[++j] ?? '', { slash: true });
        if (expr[j + 1] === '-prune') f.excl.push(p => p.split('/').some((_, k, n) => re.test(full(n.slice(0, k + 1).join('/')))));
        else if (neg) f.excl.push(p => re.test(full(p)));
        else f.incl.push(p => re.test(full(p)));
      } else if (/^-i?regex$/.test(a)) { j++; if (!neg) f.incl.push(() => true); }
    }
    const why = reachesUnfiltered([root], cwd, prot, f);
    if (why) return why;
  }
  return null;
}

// Command lines of other processes: a browser's holds the board's one-time link for a moment.
const PS_WHY = 'other processes\' command lines can hold the board\'s one-time link';
const CMDLINE = /args|cmd|command/i;
function psRule(name, args) {
  if (name === 'ps') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^(-[A-Za-z]*[oO]|--format|o|O)$/.test(a)) { if (CMDLINE.test(args[++i] || '')) return PS_WHY; continue; }
      if (/^(-[A-Za-z]*[oO].+|--format=.*)$/.test(a)) { if (CMDLINE.test(a)) return PS_WHY; continue; }
      if (/^(-[pPuUgGtCqs]|--(pid|ppid|user|group|tty|sort|cols|columns|rows|lines|width))$/.test(a)) { i++; continue; }
      if (/^-[A-Za-z]*[fFE]/.test(a)) return PS_WHY;                  // -f, -ef, -F; -E (macOS: the environment)
      if (/^[A-Za-z]+$/.test(a)) return PS_WHY;                       // BSD style (aux, ax, e): the command column has the arguments
    }
    return null;
  }
  if (name === 'pgrep' || name === 'pkill') {
    const short = args.filter(a => /^-[A-Za-z]+$/.test(a)).join('');
    return /a/.test(short) || args.includes('--list-full') || (/l/.test(short) && /f/.test(short)) ? PS_WHY : null;
  }
  if (name === 'top' && args.some(a => /^-[A-Za-z]*c/.test(a))) return PS_WHY;
  return null;
}

// Inline code (node -e, python -c, sh -c …): a shell's is judged as a command; any other's by the paths in it, and by
// nunchi's places named in pieces (`join('.git', 'nunchi')`).
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const INLINE = { node: /^(-e|--eval|-p|--print|-pe)$/, nodejs: /^(-e|--eval|-p|--print)$/, bun: /^(-e|--eval|-p|--print)$/, deno: /^eval$/, perl: /^-[a-zA-Z]*[eE]$/, ruby: /^-[a-zA-Z]*e$/, php: /^-r$/, osascript: /^-e$/, pwsh: /^-(c|command)$/i, powershell: /^-(c|command)$/i };
function inlineCode(name, args) {
  if (name === 'eval') return { shell: true, code: args.join(' ') };
  if (SHELLS.has(name)) { const k = args.findIndex(a => /^-[a-zA-Z]*c$/.test(a)); return k >= 0 ? { shell: true, code: args.slice(k + 1).join(' ') } : null; }
  const re = /^python[\d.]*$/.test(name) ? /^-[a-zA-Z]*c$/ : INLINE[name];
  if (!re) return null;
  const k = args.findIndex(a => re.test(a));
  return k >= 0 ? { shell: false, code: args.slice(k + 1).join(' ') } : null;
}
const PIECES_WHY = 'this code names nunchi\'s state, answer keys or canaries: use nunchi findings / nunchi decide';

export function bashRule(command, prot, { depth = 0, cwd: start = prot.cwd } = {}) {
  const cmd = String(command || '');
  const flat = cmd.replace(/\\/g, '/');
  if (/--link-to-parent\b|\blinkToTerminal\b/.test(flat)) return 'the board\'s link goes to the person\'s own terminal only (they run nunchi open --no-browser there)';
  for (const seg of flat.split(/;|&&|\|\||\||\n/)) {
    if (BOARD_SCRIPT.test(seg) && (words(seg).some(w => RUNS_CODE.test(w)) || /\b(import|require)\s*\(|--(import|require)\b/.test(seg))) return 'the board is started by nunchi open, never by running its script';
  }
  // inline code, whole (the finer segments below cut it at its parentheses): a shell's is judged as a command; any
  // other's by nunchi's places named in pieces (`join('.git', 'nunchi')`)
  for (const seg of quotedSegments(cmd)) {
    const w = words(seg), at = commandAt(w);
    const inline = inlineCode(baseName(w[at]), w.slice(at + 1));
    if (inline?.shell && depth < 3) { const inner = bashRule(inline.code, prot, { depth: depth + 1, cwd: start }); if (inner) return inner; }
    if (inline && !inline.shell) {
      const c = inline.code.replace(/\\/g, '/');
      if ((/\.git\b/.test(c) && /nunchi/.test(c)) || (/\.nunchi\b/.test(c) && /\b(state|canaries|auth|key)/.test(c)) || (/\/proc\b/.test(c) && /cmdline|environ/.test(c))) return PIECES_WHY;
    }
  }
  if (NUNCHI.test(flat)) {
    if (/\b(approve)\b/.test(flat) && /(nunchi|cli\.mjs)\b[^;&|\n]*\sapprove\b/.test(flat)) return 'approving decisions is the person\'s (the board, or nunchi approve in their own terminal)';
    if (/(nunchi|cli\.mjs)\b[^;&|\n]*\s(label\b|--label\b)/.test(flat)) return 'labelling is done by a person in the board (they run nunchi open --label themselves)';
    if (/--approve-checks\b/.test(flat)) return 'check scripts are approved by the person in the board';
    if (PTY.test(flat)) return 'running nunchi under a pseudo-terminal would pass for the person\'s own terminal';
  }
  if (/\/proc\/[^\s/'"]+\/(cmdline|environ|mem|maps|fd)\b/.test(flat)) return READ_DENY[4][1];
  const home = homedir().replace(/\\/g, '/');
  const segs = segments(cmd);
  let cwd = start;
  for (let s = 0; s < segs.length; s++) {
    const text = segs[s].text;
    const forms = [...new Set([text, text.replace(/\\/g, '/')])];
    const w = words(forms[0]);
    const at = commandAt(w);
    const name = baseName(w[at]);
    const args = w.slice(at + 1);
    // writes: a redirection into a file (not into /dev/null, not a copy of a descriptor)
    const writes = />/.test(text.replace(/\d*>&\d*-?|&>>?\s*\/dev\/null\b|\d*>>?\s*\/dev\/null\b/g, ''));
    const readsOnly = !writes && (READ_ONLY.has(name) || (name === 'git' && GIT_READ.has(args.find(a => !a.startsWith('-')))) || (name === 'find' && !args.some(a => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a))));
    // path-like words, and pieces of words (`readFileSync('.git/nunchi/…')`); a glob as the files it names
    const cands = new Set();
    for (const f of forms) {
      for (const x of words(f)) { cands.add(x); if (x.includes('=')) cands.add(x.slice(x.indexOf('=') + 1)); }
      for (const m of f.matchAll(/[^\s'"`(),;+<>|&=]+/g)) cands.add(m[0]);
    }
    for (const raw of cands) {
      if (!/[/\\.~$%]/.test(raw)) continue;
      const p = raw.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
      if (/\$\{?(XDG_STATE_HOME|LOCALAPPDATA)\}?|%LOCALAPPDATA%/i.test(p) && /nunchi/.test(text)) return 'the answer keys are kept out of reach of the AI';
      for (const x of GLOB_CHARS.test(p) || BRACES.test(p) ? expandGlob(p, cwd) : [p]) {
        const why = pathRule(resolve(cwd, x), prot, { write: !readsOnly });
        if (why) return why;
      }
    }
    // reads that walk folders, other processes' command lines, inline code
    const next = segs[s + 1]?.pipe ? words(segs[s + 1].text) : null;
    const piped = !!next && baseName(next[commandAt(next)]) === 'xargs';
    const why = ['grep', 'egrep', 'fgrep', 'zgrep'].includes(name) ? grepRule(args, cwd, prot)
      : name === 'rg' ? rgRule(args, cwd, prot, { piped })
      : name === 'find' ? findRule(args, cwd, prot, { piped })
      : psRule(name, args);
    if (why) return why;
    if ((name === 'cd' || name === 'pushd') && args[0] !== '-') cwd = args[0] ? resolve(cwd, args[0].replace(/^~(?=\/|$)/, home)) : homedir();
  }
  // the board's port, by any loopback name
  for (const b of prot.boards) {
    const port = String(b.port);
    if (new RegExp(`(127\\.0\\.0\\.1|localhost|\\[?::1\\]?|0\\.0\\.0\\.0|\\b0)\\s*[:]\\s*${port}\\b`).test(flat) || new RegExp(`\\b(nc|ncat|netcat|telnet|socat)\\b[^;&|\\n]*\\b${port}\\b`).test(flat) || new RegExp(`/dev/tcp/[^/]+/${port}\\b`).test(flat)) return 'the board is the person\'s: it takes requests only from their browser';
  }
  return null;
}

function urlRule(url, prot) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const loop = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host) || /^127\./.test(host);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (loop && prot.boards.some(b => b.port === port)) return 'the board is the person\'s: it takes requests only from their browser';
  return null;
}

function searchBaseRule(base, prot) {
  const why = 'a search there reaches nunchi\'s state, answer keys or a run\'s canaries: read the files you need by name';
  for (const b of [base, realish(base)]) {
    for (const d of [join(prot.cwd, '.git'), prot.common, join(prot.cwd, '.nunchi', 'runs'), '/proc']) if (d && within(b, d)) return why;
    if (norm(b) === norm(join(prot.cwd, '.nunchi'))) return why;
  }
  return null;
}

// The decision for one tool call: → null (allow) or the reason it is denied.
export function judge(input, { env = process.env, common } = {}) {
  const tool = String(input?.tool_name || '');
  const ti = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = typeof input?.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : process.cwd();
  const prot = protectedOf(cwd, { env, common });
  const p = v => (typeof v === 'string' && v ? v : null);
  switch (tool) {
    case 'Read': case 'NotebookRead': return p(ti.file_path || ti.notebook_path) && pathRule(ti.file_path || ti.notebook_path, prot);
    case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return p(ti.file_path || ti.notebook_path) && pathRule(ti.file_path || ti.notebook_path, prot, { write: true });
    case 'Grep': case 'Glob': {
      // the folder searched (with the literal folders a Glob pattern starts with): never .git, .nunchi itself, the runs
      // (each holds its canaries) or /proc
      let base = p(ti.path) ? resolve(cwd, ti.path) : cwd;
      if (tool === 'Glob' && p(ti.pattern)) { for (const s of String(ti.pattern).replace(/\\/g, '/').split('/').slice(0, -1)) { if (GLOB_CHARS.test(s) || BRACES.test(s) || !s) break; base = resolve(base, s); } }
      const why = searchBaseRule(base, prot);
      if (why) return why;
      for (const v of [ti.path, ti.pattern && tool === 'Glob' ? ti.pattern : null, ti.glob]) {
        if (!p(v)) continue;
        const base = String(v).replace(/[*?[{].*$/, '') || '.';
        const why = pathRule(base, prot) || (/(\.git\/nunchi|\.nunchi\/state|\.nunchi\/auth\.json|canaries\.json|-key\.json)/.test(String(v).replace(/\\/g, '/')) ? 'nunchi\'s state, keys and canaries are not for the AI' : null);
        if (why) return why;
      }
      return null;
    }
    case 'Bash': return bashRule(ti.command, prot);
    case 'WebFetch': return urlRule(ti.url, prot);
    default: return null;
  }
}

// The hook's answer to what came on stdin: → { status, stderr }. It fails closed: input it cannot read (not JSON,
// over 4 MB) and an error while judging deny the call, so a call the hook cannot judge never passes by default.
export const MAX_INPUT = 4 * 1024 * 1024;
export function answer(raw, { judgeFn = judge } = {}) {
  const deny = why => ({ status: 2, stderr: `nunchi: denied — ${why}.\n` });
  if (typeof raw !== 'string' || raw.length > MAX_INPUT) return deny('the hook cannot read a tool call over 4 MB');
  let input;
  try { input = JSON.parse(raw); } catch { return deny('the hook could not read this tool call (not JSON)'); }
  let why;
  try { why = judgeFn(input); } catch (e) { return deny(`the hook could not judge this call (${String(e?.message || e).split('\n')[0].slice(0, 200)})`); }
  return why ? deny(why) : { status: 0, stderr: '' };
}
// The hook: the tool call on stdin; exit 0 allows it, exit 2 with a reason on stderr denies it (Claude Code shows the
// reason to the agent).
async function main() {
  let raw = '';
  try { for await (const chunk of process.stdin) { raw += chunk; if (raw.length > MAX_INPUT) break; } } catch { raw = null; }
  const r = answer(raw);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
