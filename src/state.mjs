// State store (design 0.1-c §8.1): where nunchi keeps what it computes (the ledger, approvals) and how it writes it.
//
// - Root. In a git repository the state lives under the repository's common git folder,
//   `$(git rev-parse --git-common-dir)/nunchi/<app>/state`, so every worktree of the repository sees one ledger and
//   one set of approvals (design §7). `<app>` is `root` for an app at the top of the repository and `app-<hash of
//   its path in the repository>` for one in a subfolder, so two apps of a monorepo never share a ledger. Without
//   git (or with a git nunchi cannot run safely, runs.mjs gitRunner) the state stays in `.nunchi/state`, per folder,
//   and so it does when the shared folder cannot be written (resolveStateRoot, recorded in `.nunchi/state/fallback.json`).
//   A `.nunchi/state` written before the shared root existed is moved there once (adoptLegacy); files of it that are
//   committed to git never are.
// - Writes. A document is read with its `rev`, changed, and committed under the file's lock only if its `rev` is
//   still the one read; otherwise the writer reads again and retries (no lost updates, also when a lock was taken
//   over from a holder judged stale). The file it replaces is kept as `<file>.prev`, the write is atomic and synced
//   (stable.mjs writeAtomic), and the state's `generation` file is bumped so readers (the board) see a change. The
//   bump comes after the document's write: a reader that sees a new generation finds the new document, but one that
//   read the document between the two sees the old generation with the new document. A reader caches by the
//   documents' `rev`, never by the generation alone (the generation says only "look again").
// - Reads. A file that cannot be read or parsed is read once more (a Windows reader can meet a rename), then it is an
//   error, never "empty".
// - Answer keys (hunt, verify, re-check) live outside the project, under the user's state folder, so an agent
//   working in the project does not read them by accident (design §2.2).
import { readFileSync, lstatSync, openSync, fstatSync, closeSync, realpathSync, renameSync, rmSync, existsSync, readdirSync, accessSync, constants } from 'node:fs';
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
// The record that this worktree keeps its state in `.nunchi/state` because the repository's shared folder could not
// be written (resolveStateRoot): later commands read it and pick the same root.
export const FALLBACK = 'fallback.json';
// → { dir, shared, stream, legacy, gitCommonDir, prefix } (and `fallback: true` when a fallback was recorded)
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
      if (present(join(legacy, FALLBACK))) return { dir: legacy, shared: false, stream: 'main', legacy: null, gitCommonDir: common, prefix, fallback: true };
      const app = prefix ? `app-${sha(prefix, 12)}` : 'root';
      const same = common === gitDir;
      const stream = same ? 'main' : `wt:${basename(gitDir)}`;
      return { dir: join(common, 'nunchi', app, 'state'), shared: true, stream, legacy, gitCommonDir: common, prefix };
    }
  }
  return { dir: legacy, shared: false, stream: 'main', legacy: null, gitCommonDir: null, prefix: null };
}

// The files under `.nunchi/state` that are committed to git (`git ls-files`, through gitRunner like every git call
// of the engine). State that came through git is never read: anyone with push access could have written it.
export function trackedState(projectDir) {
  try {
    const run = gitRunner(resolve(projectDir), { timeout: 15_000 });
    return run(['ls-files', '-z', '--', '.nunchi/state'], { encoding: 'utf8' }).split('\0').filter(Boolean).map(p => basename(p)).sort();
  } catch { return []; }
}

// The probe of a state folder nunchi is about to write: created owner-only, then checked writable. Through here so a
// test can make it fail as a read-only or foreign-owned git folder does (tests may run as root, where modes do not).
export const stateIo = { probe: root => { ensureStateDir(root); accessSync(root.dir, constants.W_OK); } };
const UNWRITABLE = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'EEXIST']);
// stateRoot, for a command that writes: when the repository's shared folder cannot be written (a read-only or
// foreign-owned `.git`, or `nunchi` there being a file), this worktree keeps its state in `.nunchi/state` instead,
// says so in one line (`warning`), and records the choice (`.nunchi/state/fallback.json`) so later commands pick the
// same root. Deleting that file tries the shared folder again. → stateRoot's result, plus `warning` when it fell back.
export function resolveStateRoot(projectDir) {
  const root = stateRoot(projectDir);
  if (!root.shared) return root;
  try { stateIo.probe(root); return root; }
  catch (e) {
    if (!UNWRITABLE.has(e.code)) throw e;
    const legacy = root.legacy, marker = join(legacy, FALLBACK);
    privateDir(legacy);
    refuseLink(legacy);
    writeStable(marker, { schema: 1, note: 'this worktree keeps its nunchi state here: the repository\'s shared state folder could not be written; delete this file to try it again', shared: root.dir, code: e.code });
    const fallback = { dir: legacy, shared: false, stream: 'main', legacy: null, gitCommonDir: root.gitCommonDir, prefix: root.prefix, fallback: true };
    return { ...fallback, warning: `the repository's shared state folder ${root.dir} cannot be written (${e.code}); this worktree keeps its state in .nunchi/state instead (recorded in .nunchi/state/${FALLBACK}; delete it to try the shared folder again)` };
  }
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
// - the ledger, when the shared folder has none yet: it becomes the shared ledger (`migrateLedger`: its folds and
//   items tagged with this worktree's stream). When the shared folder already has a ledger (another worktree's), the
//   open items it does not have are carried over, tagged with this worktree's stream (`carryLedger`), and what was
//   not carried is said; this worktree's runs are folded again by the next ledger command.
// - approvals: added to the shared list (both are approvals made on this machine).
// - Never taken: when this machine first saw each decision (`decisionsSeen`). A file can claim any time, and an early
//   one would let a decision outrank later ones; the decisions are noted again, from now.
// - A file committed to git (`tracked`, from trackedState) is never adopted: it stays where it is, and is said.
// The moved files are left beside, renamed `<name>.moved`, never deleted.
// → { moved, tracked, carried, notCarried }: file names, and what carryLedger reported.
export function adoptLegacy(root, { tracked = [], migrateLedger = d => d, carryLedger = cur => ({ doc: cur, carried: 0, notCarried: [] }), validateLedger = () => true, validateApproved = () => true, mergeApproved = (a, b) => b } = {}) {
  const out = { moved: [], tracked: [], carried: 0, notCarried: [] };
  if (!root.shared || !root.legacy || !present(root.legacy)) return out;
  const files = stateFiles(root.dir), old = stateFiles(root.legacy);
  const skip = new Set(tracked);
  // another nunchi process may be moving the same file right now: one that is gone was moved, not lost
  const read = (file, opts) => { try { return readDoc(file, opts).doc; } catch (e) { if (!present(file)) return null; throw e; } };
  const putAside = file => { try { retryBusy(() => renameSync(file, `${file}.moved`)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
  const committed = file => { if (!present(file) || !skip.has(basename(file))) return false; out.tracked.push(basename(file)); return true; };
  const legacyLedger = present(old.ledger) && !committed(old.ledger) ? read(old.ledger, { fix: 'it is the ledger an older nunchi wrote; delete it and the runs on disk rebuild it', validate: validateLedger, why: 'is not a nunchi ledger' }) : null;
  if (legacyLedger) {
    ensureStateDir(root);
    const { decisionsSeen: _ignored, ...rest } = legacyLedger;
    let carried = 0, notCarried = [];
    updateDoc(files.ledger, cur => {
      if (cur === null) { carried = 0; notCarried = []; return { ...migrateLedger(rest, root.stream), rev: undefined }; }
      const r = carryLedger(cur, rest, root.stream);
      carried = r.carried; notCarried = r.notCarried;
      return r.doc;
    }, { read: { validate: validateLedger, why: 'is not a nunchi ledger' }, generation: files.generation });
    out.carried = carried; out.notCarried = notCarried;
    if (putAside(old.ledger)) out.moved.push('ledger.json');
  }
  const legacyApproved = present(old.approved) && !committed(old.approved) ? read(old.approved, { fix: 'nothing was written; fix it by hand or delete it', validate: validateApproved, why: 'has no "approved" list' }) : null;
  if (legacyApproved) {
    ensureStateDir(root);
    updateDoc(files.approved, cur => mergeApproved(cur, legacyApproved), { read: { validate: validateApproved, why: 'has no "approved" list' }, prev: false, generation: files.generation });
    if (putAside(old.approved)) out.moved.push('approved.json');
  }
  out.tracked.sort();
  return out;
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
  // every folder from the user's state base down is nunchi's own: a link among them is refused, never followed
  // (the folders above the base are the user's)
  const base = userStateBase(env);
  for (let d = dirname(p); ; d = dirname(d)) { refuseLink(d); if (d === base || dirname(d) === d) break; }
  privateDir(dirname(p));
  for (let d = dirname(p); ; d = dirname(d)) { refuseLink(d); if (d === base || dirname(d) === d) break; }
  writeStable(p, value);                                     // 0600, atomic, never through a link
  const old = join(runDir, name);
  if (present(old)) rmSync(old, { force: true });            // an older nunchi's copy inside the project goes
  return p;
}
const KEY_FIX = 'it is an answer key nunchi wrote; plan again to make a new one';
const KEY_MAX = 64 * 1024 * 1024;
// The key as it is, from outside the project, or null: a pure read (the ledger's fold reads keys this way).
export function peekKey(runDir, name, env) {
  checkName(name);
  const p = keyPath(runDir, name, env);
  return present(p) ? readJsonFile(p, KEY_FIX, { max: KEY_MAX, retry: true }) : null;
}
// What a key an older nunchi left inside the project may carry: its plan, never recorded verdicts (a file in the
// project can say anything, design §2.2). Re-check keys came after keys moved out: none is read from the project.
const LEGACY_KEYS = new Set(['hunt-key.json', 'verify-key.json']);
// The key, from outside the project; a hunt or verify key an older nunchi left inside the run is read once and moved
// out, without any verdicts it holds.
export function readKey(runDir, name, env) {
  const value = peekKey(runDir, name, env);
  if (value !== null) return value;
  const old = join(runDir, name);
  if (!LEGACY_KEYS.has(name) || !present(old)) return null;
  const doc = readJsonFile(old, KEY_FIX, { max: KEY_MAX });
  const { recorded: _r, earlier: _e, ...plan } = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  writeKey(runDir, name, plan, env);
  return plan;
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
