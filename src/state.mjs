// State store (design 0.1-c §8.1): where nunchi keeps what it computes (the ledger, approvals) and how it writes it.
//
// - Root. In a git repository the state lives under the repository's common git folder,
//   `$(git rev-parse --git-common-dir)/nunchi/<app>/state`, so every worktree of the repository sees one ledger and
//   one set of approvals (design §7). `<app>` is `root` for an app at the top of the repository and `app-<hash of
//   its path in the repository>` for one in a subfolder, so two apps of a monorepo never share a ledger. Without
//   git (or with a git nunchi cannot run safely, runs.mjs gitRunner) the state stays in `.nunchi/state`, per folder.
//   A `.nunchi/state` written before the shared root existed is moved there once (adoptLegacy).
// - Writes. A document is read with its `rev`, changed, and committed under the file's lock only if its `rev` is
//   still the one read; otherwise the writer reads again and retries (no lost updates, also when a lock was taken
//   over from a holder judged stale). The file it replaces is kept as `<file>.prev`, the write is atomic and synced
//   (stable.mjs writeAtomic), and the state's `generation` file is bumped so readers (the board) see a change.
// - Reads. A file that cannot be read or parsed is read once more (a Windows reader can meet a rename), then it is an
//   error, never "empty".
// - Answer keys (hunt, verify, re-check) live outside the project, under the user's state folder, so an agent
//   working in the project does not read them by accident (design §2.2).
import { readFileSync, lstatSync, openSync, fstatSync, closeSync, realpathSync, renameSync, rmSync, existsSync, readdirSync, constants } from 'node:fs';
import { join, dirname, basename, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { sha, stableJson, writeAtomic, writeStable, withLock, privateDir, refuseLink, retryBusy } from './stable.mjs';
import { gitRunner } from './runs.mjs';

// ---- reading nunchi's own files ----------------------------------------------------------------------------

// A file nunchi wrote and can no longer read is an error, never "empty": an empty ledger or approval list written
// back over it would lose what it held. A checkout can put anything at these paths: a link (to a secret, or to a
// device that never ends) is refused, not followed; a size cap is honoured; and a parse error is reported by its
// position only, never with the file's text.
export const corrupt = (file, why) => Object.assign(new Error(`${file} ${why}`), { code: 'CORRUPT', file });
const NOFOLLOW = (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
export const present = p => { try { lstatSync(p); return true; } catch { return false; } };
function readOnce(file, fix, max) {
  let st;
  try { st = lstatSync(file); } catch (e) { throw corrupt(file, `cannot be read (${e.code}): ${fix}`); }
  if (!st.isFile()) throw corrupt(file, `is not a regular file (a link, a folder or a device): ${fix}`);
  let fd, buf;
  try { fd = openSync(file, constants.O_RDONLY | NOFOLLOW); } catch (e) { throw corrupt(file, `cannot be read (${e.code}): ${fix}`); }
  try {
    const s = fstatSync(fd);
    if (!s.isFile()) throw corrupt(file, `is not a regular file (a link, a folder or a device): ${fix}`);
    if (s.size > max) throw corrupt(file, `is larger than ${max} bytes: ${fix}`);
    buf = readFileSync(fd);
  } finally { closeSync(fd); }
  if (buf.length > max) throw corrupt(file, `is larger than ${max} bytes: ${fix}`);
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { const at = /position (\d+)/.exec(String(e.message)); throw corrupt(file, `is not valid JSON${at ? ` (at character ${at[1]})` : ''}: ${fix}`); }
}
// `retry`: read once more after a short wait before calling it corrupt (design §8.1 "retries once"). A link, a
// folder or a file over the cap is not retried: reading again cannot change that.
const STRUCTURAL = /is not a regular file|is larger than/;
// The one read goes through here, so a test can make a read fail once as a Windows reader meeting a rename does.
export const readIo = { readOnce };
export function readJsonFile(file, fix, { max = Infinity, retry = false } = {}) {
  try { return readIo.readOnce(file, fix, max); }
  catch (e) {
    if (!retry || e.code !== 'CORRUPT' || STRUCTURAL.test(e.message) || !present(file)) throw e;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    return readIo.readOnce(file, fix, max);
  }
}

// ---- documents with a revision -------------------------------------------------------------------------------

export const revOf = doc => (doc && Number.isInteger(doc.rev) && doc.rev >= 0 ? doc.rev : 0);
const conflict = file => Object.assign(new Error(`${file} was changed by another nunchi process while this one worked; read again`), { code: 'CONFLICT', file });

// → { doc, rev, present }. A missing file is `missing()` (rev 0); anything else that cannot be read, or that
// `validate` refuses, is an error (CORRUPT).
export function readDoc(file, { fix = 'delete it to start again', validate = () => true, missing = () => null, max = Infinity, why = 'is not the document nunchi expects' } = {}) {
  if (!present(file)) return { doc: missing(), rev: 0, present: false };
  const doc = readJsonFile(file, fix, { max, retry: true });
  if (!validate(doc)) throw corrupt(file, `${why}: ${fix}`);
  return { doc, rev: revOf(doc), present: true };
}

// The generation file: a counter every committed state write increases (design §3.3, §8.1), written atomically
// under its own lock. Taken after the document's lock, never before, so locks are always taken in one order.
export function readGeneration(file) {
  try { const n = Number(String(readFileSync(file, 'utf8')).trim()); return Number.isInteger(n) && n >= 0 ? n : 0; } catch { return 0; }
}
export function bumpGeneration(file) {
  return withLock(file, () => {
    const n = readGeneration(file) + 1;
    refuseLink(file);
    writeAtomic(file, `${n}\n`, { mode: 0o600 });
    return n;
  });
}

// Under the file's lock: the rev on disk must still be `expect` (CONFLICT otherwise). The file it replaces is kept
// as `<file>.prev`; the new one gets rev + 1 and is synced. → the document as written (parsed back, so the caller
// holds exactly what a reader will).
function writeLocked(file, doc, expect, { prev = true, generation = null, fix } = {}) {
  const cur = present(file) ? revOf(readJsonFile(file, fix || 'restore <file>.prev or delete it', { retry: true })) : 0;
  if (expect !== undefined && cur !== expect) throw conflict(file);
  refuseLink(file);
  if (prev && present(file)) {
    refuseLink(`${file}.prev`);
    writeAtomic(`${file}.prev`, readFileSync(file), { durable: true, mode: 0o600 });
  }
  const text = stableJson({ ...doc, rev: cur + 1 });
  writeAtomic(file, text, { durable: true, mode: 0o600 });
  if (generation) bumpGeneration(generation);
  return JSON.parse(text);
}

// Write `doc` if the file is still at `expect` (its rev when read).
export function commitDoc(file, doc, { expect, timeoutMs, ...opts } = {}) {
  privateDir(dirname(file));
  return withLock(file, () => writeLocked(file, doc, expect, opts), { timeoutMs });
}

// Read, change, commit; when another writer committed in between, read again and redo the change (optimistic, so
// the lock is held only for the write). After OPTIMISTIC tries the whole read–change–write runs under the lock, so a
// busy file still makes progress. `fn(doc, { rev, lock })` must be a pure function of the document (it may run more
// than once) and return the same object when there is nothing to write: then nothing is written.
const OPTIMISTIC = 4;
export function updateDoc(file, fn, { read = {}, timeoutMs, prev = true, generation = null } = {}) {
  privateDir(dirname(file));
  const fix = read.fix;
  for (let attempt = 0; ; attempt++) {
    if (attempt >= OPTIMISTIC) {
      return withLock(file, lock => {
        const cur = readDoc(file, read);
        const next = fn(cur.doc, { rev: cur.rev, lock });
        return next === cur.doc ? cur.doc : writeLocked(file, next, cur.rev, { prev, generation, fix });
      }, { timeoutMs });
    }
    const cur = readDoc(file, read);
    const next = fn(cur.doc, { rev: cur.rev, lock: null });
    if (next === cur.doc) return cur.doc;
    try { return withLock(file, () => writeLocked(file, next, cur.rev, { prev, generation, fix }), { timeoutMs }); }
    catch (e) { if (e.code !== 'CONFLICT') throw e; }
  }
}

// ---- the state root ------------------------------------------------------------------------------------------

const LEGACY = (projectDir) => join(projectDir, '.nunchi', 'state');
// → { dir, shared, stream, legacy, gitCommonDir, prefix }
// - dir: the state folder; shared: true when it is the repository's (every worktree's);
// - stream: which worktree's runs fold into it: `main` for the main worktree (and without git), `wt:<name>` for a
//   linked one. Run ids are numbered per worktree, so a fold is keyed by its stream too (ledger.mjs);
// - legacy: the `.nunchi/state` folder of this project, read once and moved when the state is shared.
export function stateRoot(projectDir, { git = true } = {}) {
  const project = resolve(projectDir);
  const legacy = LEGACY(project);
  if (git) {
    let out = null;
    try {
      const run = gitRunner(project, { timeout: 15_000 });
      out = run(['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-prefix'], { encoding: 'utf8' }).split('\n');
    } catch { out = null; }
    if (out && out.length >= 3 && isAbsolute(out[0]) && isAbsolute(out[1])) {
      // resolve(): git writes `C:/…` on Windows; the state folder is named the platform's way
      const common = resolve(out[0].trim()), gitDir = resolve(out[1].trim()), prefix = out[2].replace(/\r$/, '');
      const app = prefix ? `app-${sha(prefix, 12)}` : 'root';
      const same = common === gitDir;
      const stream = same ? 'main' : `wt:${basename(gitDir)}`;
      return { dir: join(common, 'nunchi', app, 'state'), shared: true, stream, legacy, gitCommonDir: common, prefix };
    }
  }
  return { dir: legacy, shared: false, stream: 'main', legacy: null, gitCommonDir: null, prefix: null };
}

export const stateFiles = dir => ({
  dir, ledger: join(dir, 'ledger.json'), approved: join(dir, 'approved.json'), generation: join(dir, 'generation'), runIds: join(dir, 'run-ids.json'),
});

// Creates the state folder owner-only (0700, D12); a symbolic link among nunchi's own folders (`state`, `<app>`,
// `nunchi`) is refused. The repository's own git folder is not nunchi's to judge.
export function ensureStateDir(root) {
  for (let d = root.dir, i = 0; i < (root.shared ? 3 : 1) && d !== dirname(d); d = dirname(d), i++) refuseLink(d);
  privateDir(root.dir);
  return root.dir;
}

// A `.nunchi/state` written before the state was shared is moved into the shared folder once:
// - the ledger, when the shared folder has none yet (it becomes the shared ledger, its folds tagged with this
//   worktree's stream). When the shared folder already has a ledger (another worktree's), only the times this
//   machine first saw each decision are merged (the earliest wins); this worktree's runs are folded again by the
//   next ledger command, presence-only where another worktree's newer runs were folded first.
// - approvals: added to the shared list (both are approvals made on this machine).
// The moved files are left beside, renamed `<name>.moved`, never deleted. → what was moved.
export function adoptLegacy(root, { migrateLedger = d => d, validateLedger = () => true, validateApproved = () => true, mergeApproved = (a, b) => b } = {}) {
  if (!root.shared || !root.legacy || !present(root.legacy)) return [];
  const moved = [];
  const files = stateFiles(root.dir), old = stateFiles(root.legacy);
  // another nunchi process may be moving the same file right now: one that is gone was moved, not lost
  const read = (file, opts) => { try { return readDoc(file, opts).doc; } catch (e) { if (!present(file)) return null; throw e; } };
  const putAside = file => { try { retryBusy(() => renameSync(file, `${file}.moved`)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
  const legacyLedger = present(old.ledger) ? read(old.ledger, { fix: 'it is the ledger an older nunchi wrote; delete it and the runs on disk rebuild it', validate: validateLedger, why: 'is not a nunchi ledger' }) : null;
  if (legacyLedger) {
    ensureStateDir(root);
    updateDoc(files.ledger, cur => {
      if (cur === null) return { ...migrateLedger(legacyLedger, root.stream), rev: undefined };
      const seen = { ...(cur.decisionsSeen || {}) };
      for (const [k, t] of Object.entries(legacyLedger.decisionsSeen || {})) if (!Object.hasOwn(seen, k) || t < seen[k]) seen[k] = t;
      if (stableJson(seen) === stableJson(cur.decisionsSeen || {})) return cur;
      return { ...cur, decisionsSeen: seen };
    }, { read: { validate: validateLedger, why: 'is not a nunchi ledger' }, generation: files.generation });
    if (putAside(old.ledger)) moved.push('ledger.json');
  }
  const legacyApproved = present(old.approved) ? read(old.approved, { fix: 'nothing was written; fix it by hand or delete it', validate: validateApproved, why: 'has no "approved" list' }) : null;
  if (legacyApproved) {
    ensureStateDir(root);
    updateDoc(files.approved, cur => mergeApproved(cur, legacyApproved), { read: { validate: validateApproved, why: 'has no "approved" list' }, prev: false, generation: files.generation });
    if (putAside(old.approved)) moved.push('approved.json');
  }
  return moved;
}

// ---- answer keys outside the project ---------------------------------------------------------------------------

// `$XDG_STATE_HOME/nunchi` (Windows: `%LOCALAPPDATA%\nunchi`), else `~/.local/state/nunchi`.
// An XDG_STATE_HOME the user set wins on every platform (the spec's relative paths are ignored, as XDG says).
export function userStateBase(env = process.env, platform = process.platform) {
  if (env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)) return join(env.XDG_STATE_HOME, 'nunchi');
  if (platform === 'win32' && env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA)) return join(env.LOCALAPPDATA, 'nunchi');
  return join(homedir(), '.local', 'state', 'nunchi');
}
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
// One folder per run: `<base>/<hash of the folder holding the run>/keys/<run folder name>/`. Run ids are numbered per
// worktree, so the hash names the runs folder (one worktree's `.nunchi/runs`, or the parent of an --out folder).
// The folder holding the run is resolved to its real path (the run itself may already be gone: gc removes keys after).
export function keysDir(runDir, env = process.env) {
  const dir = resolve(runDir);
  return join(userStateBase(env), sha(real(dirname(dir)), 16), 'keys', basename(dir));
}
export const keyPath = (runDir, name, env) => join(keysDir(runDir, env), name);
const KEY_NAMES = new Set(['hunt-key.json', 'verify-key.json', 'recheck-key.json']);
const checkName = name => { if (!KEY_NAMES.has(name)) throw new Error(`not an answer key: ${name}`); };

export function writeKey(runDir, name, value, env) {
  checkName(name);
  const p = keyPath(runDir, name, env);
  privateDir(dirname(p));
  writeStable(p, value);                                     // 0600, atomic, never through a link
  const old = join(runDir, name);
  if (present(old)) rmSync(old, { force: true });            // an older nunchi's copy inside the project goes
  return p;
}
// The key, from outside the project; a key an older nunchi left inside the run is read once and moved out.
export function readKey(runDir, name, env) {
  checkName(name);
  const p = keyPath(runDir, name, env);
  const fix = 'it is an answer key nunchi wrote; plan again to make a new one';
  if (present(p)) return readJsonFile(p, fix, { max: 64 * 1024 * 1024, retry: true });
  const old = join(runDir, name);
  if (!present(old)) return null;
  const value = readJsonFile(old, fix, { max: 64 * 1024 * 1024 });
  writeKey(runDir, name, value, env);
  return value;
}
export function removeKey(runDir, name, env) {
  checkName(name);
  rmSync(keyPath(runDir, name, env), { force: true });
  rmSync(join(runDir, name), { force: true });
}
// When a run folder is removed (gc), its keys go too.
export function removeKeys(runDir, env) {
  const d = keysDir(runDir, env);
  if (existsSync(d)) rmSync(d, { recursive: true, force: true });
}
export const keyFilesIn = runDir => { try { return readdirSync(keysDir(runDir)).filter(n => KEY_NAMES.has(n)).sort(); } catch { return []; } };
