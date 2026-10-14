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
// Honest limits (design §8.3): this matches paths and words in the tool call. A command that builds a path at run
// time (variables, base64, a script file) is not seen. Neither this hook nor the board's channels are a security
// boundary against code that runs as the same user: such code can read the same files and start the same processes
// as the person. What they give is an attestation that holds against honest mistakes and naive prompt injection (a
// dismissal recorded by the agent does not count until the person confirms it in the board). For a repository you do
// not trust, run the agent in a container or as another user. Codex CLI has no such hook.
import { readFileSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
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
export function protectedOf(cwd, { env = process.env, common = undefined } = {}) {
  const gc = common === undefined ? gitCommonDir(cwd) : common;
  const stateDirs = stateDirsOf(cwd, gc);
  return { cwd, common: gc, keys: keyBases(env), boards: boards(stateDirs) };
}

// A path (absolute, or relative to the cwd): which protection it falls under, or null. `write`: the call writes.
const READ_DENY = [
  [/(^|\/)\.git\/nunchi(\/|$)/, 'nunchi\'s shared state (the ledger, approvals and board records) is the engine\'s: use nunchi findings / nunchi decide'],
  [/(^|\/)\.nunchi\/state(\/|$)/, 'nunchi\'s state is the engine\'s: use nunchi findings / nunchi decide'],
  [/(^|\/)\.nunchi\/auth\.json$/, 'the saved login holds session cookies; only the engine reads it'],
  [/(^|\/)\.nunchi\/runs\/[^/]+\/(canaries\.json|hunt-key\.json|verify-key\.json|recheck-key\.json)$/, 'the canaries and answer keys must stay unseen by the hunter, verifier and re-checker'],
  [/^\/proc\/(\d+|self)\/(cmdline|environ|mem|maps|fd)(\/|$)/, 'process memory and command lines can hold the board\'s one-time link or key'],
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
const READ_ONLY = new Set(['cat', 'ls', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'rg', 'stat', 'file', 'diff', 'tree', 'jq', 'du']);
const GIT_READ = new Set(['diff', 'log', 'show', 'status', 'add', 'commit', 'blame', 'ls-files', 'grep']);
// The words of one shell segment, roughly (quotes dropped).
const words = seg => (seg.match(/"[^"]*"|'[^']*'|[^\s"']+/g) || []).map(w => w.replace(/^["']|["']$/g, ''));
// Path-like words of a command (after `=`, too: `--out=.nunchi/state`).
const pathsIn = cmd => words(cmd.replace(/[;&|()<>`]/g, ' ')).flatMap(w => [w, ...(w.includes('=') ? [w.slice(w.indexOf('=') + 1)] : [])]).filter(w => /[/\\.~$%]/.test(w));
// The board is started by `nunchi open` only: run directly, or asked for its link, it could hand a session to the agent.
const BOARD_SCRIPT = /(^|[\s;&|(`'"/=])board\/(server|launch)\.mjs\b/;
const RUNS_CODE = /(^|\/)(node|nodejs|bun|deno|tsx|ts-node|npx|pnpx|bunx)(\.exe)?$/i;
export function bashRule(command, prot) {
  const cmd = String(command || '');
  const flat = cmd.replace(/\\/g, '/');
  if (/--link-to-parent\b|\blinkToTerminal\b/.test(flat)) return 'the board\'s link goes to the person\'s own terminal only (they run nunchi open --no-browser there)';
  for (const seg of flat.split(/;|&&|\|\||\||\n/)) {
    if (BOARD_SCRIPT.test(seg) && (words(seg).some(w => RUNS_CODE.test(w)) || /\b(import|require)\s*\(|--(import|require)\b/.test(seg))) return 'the board is started by nunchi open, never by running its script';
  }
  if (NUNCHI.test(flat)) {
    if (/\b(approve)\b/.test(flat) && /(nunchi|cli\.mjs)\b[^;&|\n]*\sapprove\b/.test(flat)) return 'approving decisions is the person\'s (the board, or nunchi approve in their own terminal)';
    if (/(nunchi|cli\.mjs)\b[^;&|\n]*\s(label\b|--label\b)/.test(flat)) return 'labelling is done by a person in the board (they run nunchi open --label themselves)';
    if (/--approve-checks\b/.test(flat)) return 'check scripts are approved by the person in the board';
    if (PTY.test(flat)) return 'running nunchi under a pseudo-terminal would pass for the person\'s own terminal';
  }
  if (/\/proc\/(\d+|self)\/(cmdline|environ|mem|maps|fd)\b/.test(flat)) return READ_DENY[4][1];
  // words that name protected paths: anything protected for reading; protected for writing unless the segment only reads
  const home = homedir().replace(/\\/g, '/');
  for (const seg of flat.split(/;|&&|\|\||\||\n/)) {
    const w = words(seg);
    const first = w.find(x => !/^\w+=/.test(x)) || '';
    const readsOnly = !/>/.test(seg) && (READ_ONLY.has(first) || (first === 'git' && GIT_READ.has(w[w.indexOf('git') + 1])) || (first === 'find' && !/\s-(delete|exec|execdir|ok|fprint)/.test(seg)));
    for (const raw of pathsIn(seg)) {
      const p = raw.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
      if (/\$\{?(XDG_STATE_HOME|LOCALAPPDATA)\}?|%LOCALAPPDATA%/i.test(p) && /nunchi/.test(seg)) return 'the answer keys are kept out of reach of the AI';
      const why = pathRule(p, prot, { write: !readsOnly });
      if (why) return why;
    }
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

// The hook: the tool call on stdin; exit 0 allows it, exit 2 with a reason on stderr denies it (Claude Code shows the
// reason to the agent). Input that cannot be read is let through: the hook guards nunchi's files, not every call.
async function main() {
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 4 * 1024 * 1024) break; }
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const why = judge(input);
  if (!why) process.exit(0);
  process.stderr.write(`nunchi: denied — ${why}.\n`);
  process.exit(2);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
