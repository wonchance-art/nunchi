// One send (spec §7.6): `nunchi share` on demand, and after every full check when the person chose "after" (capture
// calls it once the run is folded; never after a first look or a fix probe). The words are the owner's text mock-ups of
// 2026-10-16 KST (design "nunchi share" §5.2): the engine prints them, the skill relays them as printed.
import { join } from 'node:path';
import { existsSync, readdirSync, rmSync, lstatSync, readFileSync } from 'node:fs';
import * as P from '../project.mjs';
import { stateRoot } from '../state.mjs';
import { latestRun, runKind, gitRunner, ensureGitignore } from '../runs.mjs';
import { writeStable, refuseLink } from '../stable.mjs';
import { byRun } from '../ledger.mjs';
import { readShare, readShareLog, updateLog, withSend, artifactUrl, shareFiles, kst, appName } from './config.mjs';
import { buildPack, scanPack, writePackDir } from './pack.mjs';
import { folderProblem, sendToFolder } from './dest-folder.mjs';
import { sendToGit } from './dest-git.mjs';
import { publishPlan, sealOf, limitLine, MB } from './dest-artifact.mjs';
import { ring } from './doorbell.mjs';
import { shareWhere } from '../board/shared.mjs';

const RUN_ID = /^\d{4,}$/;
const s = n => (n === 1 ? '' : 's');
export const OUTBOX = ['share', 'outbox'];
export const outboxDir = nunchiDir => join(nunchiDir, ...OUTBOX);

// The share lines' middle (§5.2): what went, what stayed
export function countLines(c, include, { inline = false } = {}) {
  const who = c.visitorOnly ? 'visitor' : 'visitor and signed in';
  const text = c.textOnly && c.visitorOnly ? `, ${c.textOnly} of them as text only (seen signed in)` : '';
  const left = [c.signedInScreens && c.visitorOnly ? `${c.signedInScreens} signed-in screenshot${s(c.signedInScreens)}` : null,
    c.secretShapedScreens ? `${c.secretShapedScreens} screenshot${s(c.secretShapedScreens)} whose screen text looks like a key or token` : null,
    !include.pageText ? 'text from your screens' : null, 'your login', 'network recordings'].filter(Boolean).join(', ');
  const counts = `${c.screens} screen${s(c.screens)} (${who}) · ${c.groups} finding${s(c.groups)}${inline ? '' : text} · ${MB(c.bytes)} · ${c.files} files`;
  return inline ? [`  ${counts}. Left out: ${left}.`] : [`  ${counts}`, `  Left out: ${left}.`];
}
export const offLine = app => `Not shared: sharing is off for ${app}. Only you can turn it on: nunchi share --setup in your own terminal.`;
const NOT_PRIVATE = url => `Not shared: your artifact${url ? ` ${url}` : ''} is no longer private (its last publish said so), so sharing stopped. Make it private again from its Share menu, then turn sharing on again: nunchi share --setup in your own terminal.`;
const FOLDER_WORDS = {
  gone: () => 'Not shared: the folder no longer exists (Google Drive signed out?). Nothing was sent.',
  'shared-drive': f => `Not shared: My Drive/${f} is inside Shared drives. Pick a folder in My Drive.`,
  outside: f => `Not shared: My Drive/${f} leads out of My Drive (a shortcut or a link). Pick a folder in My Drive.`,
  'not-folder': f => `Not shared: My Drive/${f} is not a folder. Pick a folder in My Drive.`,
};

// The branch the run's commit is on now (the branch's tip is that commit), or null
function branchOf(root, commit) {
  if (!commit) return null;
  try {
    const git = gitRunner(root, { timeout: 15_000 });
    const head = git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    return head === commit ? git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' }).trim() || null : null;
  } catch { return null; }
}

// → { code, lines, json }. `auto`: after a capture (silent unless set up to send after every full check). `deps`:
// `check` (the anonymous check of (B)), `spawn` (the doorbell's), `now`.
export function share({ project, nunchiDir, root = project, run = null, auto = false, version, deps = {} }) {
  const now = deps.now ?? Date.now;
  const done = (code, lines, json = {}) => ({ code, lines, json: { code, lines, ...json } });
  // read first, without making anything: a project never set up to share stays as it was
  const cfg = existsSync(nunchiDir) ? readShare(stateRoot(project).dir) : null;
  const app = cfg?.app ?? appName(project);
  if (!cfg || !cfg.on) {
    if (auto) return done(0, []);
    if (cfg?.stopped?.why === 'artifact-not-private') return done(1, [NOT_PRIVATE(cfg.stopped.url)]);
    return done(1, [offLine(app)]);
  }
  if (auto && cfg.when !== 'after') return done(0, []);
  // the packs nunchi writes into .nunchi/share are never committed (an older .gitignore gains the line)
  ensureGitignore(nunchiDir);
  const st = P.openState(nunchiDir, { warn: deps.warn });
  const stateDir = st.root.dir;
  const runsDir = join(nunchiDir, 'runs');
  const id = run ?? latestRun(runsDir);
  if (!id) return done(1, ['Not shared: nothing captured yet. Results are shared after a full check.']);
  if (!RUN_ID.test(id) || !existsSync(join(runsDir, id, 'manifest.json'))) return done(1, [`Not shared: there is no complete run ${id} in this project's .nunchi/runs.`]);
  const kind = runKind(runsDir, id);
  if (kind === 'quick') return done(1, [`Not shared: run ${id} is a first look. Results are shared after a full check.`]);
  if (kind !== 'sweep') return done(1, [`Not shared: run ${id} is a fix probe, not a full check. Results are shared after a full check.`]);
  const dest = cfg.dest;
  if (dest.kind === 'drive') { const p = folderProblem(dest.root, dest.folder); if (p) return done(1, [FOLDER_WORDS[p](dest.folder)]); }

  // the pack, then the scan of every text file of it, whole, just before it goes
  const led = P.loadLedger(nunchiDir, { root, warn: deps.warn });
  const view = P.ledgerView(led);
  const runDir = join(runsDir, id);
  let commit = null;
  try { commit = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).commit ?? null; } catch {}
  const pack = buildPack({ runDir, nunchiDir, led, view, root, project, include: cfg.include, form: dest.kind === 'artifact' ? 'fragment' : 'page', version, app, branch: branchOf(root, commit) });
  const hit = scanPack(pack.files);
  if (hit) return done(1, [`Not shared: ${hit.path} still holds a secret-shaped string (${hit.kind}, ${hit.path}:${hit.line}). Nothing was sent.`], { run: id });
  const c = pack.counts;
  const at = kst(now());
  const sendOf = (state, where, extra = {}) => ({ run: id, at, kind: dest.kind, where, screens: c.screens, visitorOnly: c.visitorOnly, files: c.files, bytes: c.bytes, state, ...extra });
  const bell = where => (cfg.doorbell ? [ring({ claude: cfg.doorbell.claude, session: cfg.doorbell.session, run: id, app, where, spawn: deps.spawn }).line] : []);
  const stop = '  Stop sharing: nunchi share --off';

  if (dest.kind === 'drive') {
    const where = `My Drive/${dest.folder}/${id}`;
    const key = `drive|${dest.root}|${dest.folder}`;
    const log = readShareLog(stateDir);
    let r;
    try { r = sendToFolder({ root: dest.root, folder: dest.folder, run: id, files: pack.files, written: log.written[key] || [] }); }
    catch (e) {
      if (e.code === 'FOLDER_NOT_OURS') return done(1, [`Not shared: My Drive/${dest.folder}/${id} holds files nunchi did not write. Move them, then run nunchi share. Nothing was sent.`]);
      if (['ENOENT', 'EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'UNSAFE_PATH'].includes(e.code)) return done(1, [`Not shared: My Drive/${dest.folder} could not be written (${e.code}). Nothing more was sent.`]);
      throw e;
    }
    updateLog(stateDir, l => withSend({ ...l, written: { ...l.written, [key]: r.written } }, sendOf('sent', where)), { generation: st.files.generation });
    return done(0, [`Shared run ${id} (full check) → Google Drive · ${where}`, ...countLines(c, cfg.include), `  In your cloud session, say: “read the nunchi results in ${where}”.`, stop, ...bell(`Google Drive · ${where}`)],
      { run: id, dest: 'drive', where, screens: c.screens, files: c.files, bytes: c.bytes });
  }
  if (dest.kind === 'git') {
    let r;
    try { r = sendToGit({ clone: shareFiles(stateDir).clone, remote: dest.remote, branch: dest.branch, run: id, app, files: pack.files, ...(deps.check ? { check: deps.check } : {}) }); }
    catch (e) {
      if (e.code === 'PUBLIC') return done(1, [`Not shared: ${dest.web} answers without a login, so it is public. Make it private on GitHub, then run nunchi share.`]);
      if (e.code === 'GIT_FAILED' || e.code === 'GIT_UNSAFE' || e.code === 'UNSAFE_PATH') return done(1, [`Not shared: ${dest.web}: ${e.message}. Nothing was sent.`]);
      throw e;
    }
    const where = `${dest.web} · branch ${dest.branch} · runs/${id}`;
    updateLog(stateDir, l => withSend(l, sendOf('sent', where, { commit: r.commit })), { generation: st.files.generation });
    return done(0, [`Shared run ${id} → ${dest.web} · branch ${dest.branch} · commit ${r.commit}`, '  Checked just now: the repository does not answer without your login.', ...countLines(c, cfg.include),
      `  In your cloud session, say: “read the nunchi results in ${dest.web}, branch ${dest.branch}, runs/${id}”.`, stop, ...bell(where)],
    { run: id, dest: 'git', where, commit: r.commit, screens: c.screens, files: c.files, bytes: c.bytes });
  }
  // (A): sealed and waiting for the skill's publish; the deny hook asks the person
  const log = readShareLog(stateDir);
  const url = artifactUrl(cfg, log);
  const outbox = outboxDir(nunchiDir);
  const packDir = join(outbox, id, 'pack');
  const plan = publishPlan({ pack, run: id, app, packDir, url, at: url ? log.written[`artifact|${url}`] : null });
  if (plan.problem) return done(1, [limitLine(id, plan.problem)], { run: id });
  // nunchi's own folders, never through a link (openState refused one at .nunchi/share already)
  for (const d of [outbox, join(outbox, id)]) refuseLink(d);
  writePackDir(packDir, pack.files);
  writeStable(join(outbox, id, 'publish.json'), plan.call);
  // only the newest pack waits: older ones nunchi wrote are removed
  try { for (const n of readdirSync(outbox)) if (RUN_ID.test(n) && n !== id && byRun(n, id) !== 0 && lstatSync(join(outbox, n)).isDirectory()) rmSync(join(outbox, n), { recursive: true, force: true }); } catch {}
  const seal = sealOf({ plan, pack, packDir, run: id, app, include: cfg.include, counts: c, url });
  updateLog(stateDir, l => withSend({ ...l, sealed: seal }, sendOf('prepared', url || 'a new private artifact')), { generation: st.files.generation });
  const priv = url && log.artifact?.url === url && log.artifact?.audience === 'private' ? ' (private)' : '';
  return done(0, [`Run ${id} is ready to share → ${url ? `your artifact ${url}${priv}` : 'a new private artifact'}`, ...countLines(c, cfg.include, { inline: true }), '  Claude Code will ask you to allow the publish.'],
    { run: id, dest: 'artifact', where: url || null, publish: join(outbox, id, 'publish.json'), screens: c.screens, files: c.files, bytes: c.bytes });
}
// `share --status`: on or off, where, what goes, when, and every place it sent to (the send log)
export function shareStatus({ nunchiDir, project }) {
  const dir = stateRoot(project).dir;
  const cfg = existsSync(nunchiDir) ? readShare(dir) : null;
  const log = existsSync(nunchiDir) ? readShareLog(dir) : null;
  const app = cfg?.app ?? appName(project);
  if (!cfg) return { code: 0, lines: [`Sharing is off for ${app}: not set up. Only you can turn it on: nunchi share --setup in your own terminal.`] };
  const who = cfg.include.signedIn ? 'visitor and signed-in screens' : 'visitor screens';
  const lines = [`Sharing ${cfg.on ? 'on' : 'off'} · ${app} → ${shareWhere({ ...cfg.dest, url: artifactUrl(cfg, log) })} · ${who}${cfg.include.pageText ? ' · text from your screens' : ''} · ${cfg.when === 'after' ? 'after every full check' : 'when you run nunchi share'}${cfg.doorbell ? ` · wakes ${cfg.doorbell.session}` : ''}`];
  if (cfg.stopped?.why === 'artifact-not-private') lines.push('  Stopped: your artifact is no longer private. Set up again in your terminal: nunchi share --setup');
  const sends = (log?.sends || []).filter(x => x.state !== 'prepared' || x === log.sends.at(-1));
  if (!sends.length) lines.push('  Nothing sent yet.');
  for (const x of sends) lines.push(`  ${x.state === 'prepared' ? 'Prepared' : 'Sent'} run ${x.run} · ${x.at} → ${x.where} (${x.screens} screen${s(x.screens)}, ${x.files} files${x.commit ? `, commit ${x.commit}` : ''})`);
  lines.push(cfg.on ? '  To stop: nunchi share --off' : '  To turn it on again: nunchi share --on in your own terminal, or Turn on in the board');
  return { code: 0, lines };
}
