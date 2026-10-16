// One send (spec §7.6): `nunchi share` on demand, and after every full check when the person chose "after" (capture
// calls it once the run is folded; never after a first look or a fix probe, and only a run of the whole app with no run
// problem: a partial run goes only on demand, marked partial). Only the worktree sharing was set up in sends. The words
// are the owner's text mock-ups of 2026-10-16 KST (design "nunchi share" §5.2): the engine prints them, the skill
// relays them as printed.
import { join, resolve } from 'node:path';
import { existsSync, readdirSync, rmSync, lstatSync, readFileSync } from 'node:fs';
import * as P from '../project.mjs';
import { stateRoot } from '../state.mjs';
import { latestRun, runKind, gitRunner, ensureGitignore } from '../runs.mjs';
import { writeStable, refuseLink } from '../stable.mjs';
import { readShare, readShareLog, updateLog, withSend, artifactUrl, shareFiles, kst, appName } from './config.mjs';
import { buildPack, scanPack, writePackDir, listPackDir, sha256 } from './pack.mjs';
import { folderProblem, sendToFolder } from './dest-folder.mjs';
import { sendToGit, appRepos } from './dest-git.mjs';
import { publishPlan, sealOf, limitLine, MB } from './dest-artifact.mjs';
import { ring } from './doorbell.mjs';
import { shareWhere } from '../board/shared.mjs';

const RUN_ID = /^\d{4,}$/;
const s = n => (n === 1 ? '' : 's');
export const OUTBOX = ['share', 'outbox'];
export const outboxDir = nunchiDir => join(nunchiDir, ...OUTBOX);
// (A)'s packs: `<run>-<12 hex of the pack's sha256>`, never rewritten (a call the person was asked about publishes the
// bytes they were asked about); a sealed pack not yet published waits PENDING_MS before another may be sealed
export const PACK_NAME = /^\d{4,}-[0-9a-f]{12}$/;
export const PENDING_MS = 10 * 60e3;
export const packHash = files => sha256(Buffer.from(files.map(f => `${f.path}\n${f.sha ??= sha256(f.data)}`).join('\n'))).slice(0, 12);
const hhmm = ms => kst(ms).slice(11, 16);
// a path of the person's in a line: control characters out
const shown = p => String(p).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, 300);

// Why a full check's run is not of the whole app, or had a run problem (§7.6: such a run is never sent by itself, and is
// marked partial when the person sends it). → a short phrase, or null for a full check
const PROBLEM_WHY = { 'app-unreachable': 'most screens did not load', 'login-expired': 'the saved login no longer worked', 'recording-stale': 'most screens asked for data the recording does not have' };
export function partialWhy(meta, problems = []) {
  const why = (Array.isArray(problems) ? problems : []).map(p => PROBLEM_WHY[p?.status] || 'the run had a problem');
  if (meta?.wholeApp !== true) {
    why.push(meta?.scope?.changedSince ? `only pages changed since ${String(meta.scope.changedSince).replace(/[^\w./@~^:-]/g, '').slice(0, 60)}`
      : meta?.routesGiven ? 'only the pages asked for'
        : (Array.isArray(meta?.skipped) ? meta.skipped : []).some(x => x?.reason === 'needs-sample') ? 'pages that need a sample address were left out' : 'not the whole app');
  }
  return why.length ? [...new Set(why)].join('; ') : null;
}

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
  const here = stateRoot(project);
  const cfg = existsSync(nunchiDir) ? readShare(here.dir) : null;
  const app = cfg?.app ?? appName(project);
  if (!cfg || !cfg.on) {
    if (auto) return done(0, []);
    if (cfg?.stopped?.why === 'artifact-not-private') return done(1, [NOT_PRIVATE(cfg.stopped.url)]);
    return done(1, [offLine(app)]);
  }
  if (auto && cfg.when !== 'after') return done(0, []);
  // the worktree it was set up in, only (another worktree's runs are its own: another branch, maybe another app state)
  if (cfg.worktree.stream !== here.stream) {
    return done(1, [`Not shared: sharing for ${app} was set up in the worktree at ${shown(cfg.worktree.path)}, not in this one. Share from there, or set it up for this worktree in your own terminal: nunchi share --setup`]);
  }
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
  const runDir = join(runsDir, id);
  let meta = {}, problems = [];
  try { meta = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) || {}; } catch {}
  try { problems = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'))?.health?.problems || []; } catch {}
  // a run of part of the app, or with a run problem: never by itself; on demand, marked partial
  const partial = partialWhy(meta, problems);
  if (auto && partial) return done(1, [`Not shared: run ${id} is not a full check (${partial}), so it was not sent by itself. To send it anyway, marked as a partial check: nunchi share`], { run: id });
  const label = partial ? `(partial check: ${partial})` : '(full check)';
  const dest = cfg.dest;
  if (dest.kind === 'drive') { const p = folderProblem(dest.root, dest.folder); if (p) return done(1, [FOLDER_WORDS[p](dest.folder)]); }
  if (dest.kind === 'git') {
    const own = appRepos(root).get(dest.web.toLowerCase());
    if (own !== undefined) return done(1, [`Not shared: ${dest.web} is this app's own repository (its remote ${shown(own).replace(/[^\w.-]/g, '?').slice(0, 60)}). Set up a repository of its own: nunchi share --setup in your own terminal. Nothing was sent.`]);
  }

  // the pack, then the scan of every text file of it, whole, just before it goes
  const led = P.loadLedger(nunchiDir, { root, warn: deps.warn });
  const view = P.ledgerView(led);
  const commit = typeof meta.commit === 'string' ? meta.commit : null;
  const pack = buildPack({ runDir, nunchiDir, led, view, root, project, include: cfg.include, form: dest.kind === 'artifact' ? 'fragment' : 'page', version, app, branch: branchOf(root, commit), partial });
  const hit = scanPack(pack.files);
  if (hit) return done(1, [`Not shared: ${hit.path} still holds a secret-shaped string (${hit.kind}, ${hit.path}:${hit.line}). Nothing was sent.`], { run: id });
  const c = pack.counts;
  const at = kst(now());
  const sendOf = (state, where, extra = {}) => ({ run: id, at, kind: dest.kind, where, screens: c.screens, visitorOnly: c.visitorOnly, files: c.files, bytes: c.bytes, state, ...(partial ? { partial } : {}), ...extra });
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
    return done(0, [`Shared run ${id} ${label} → Google Drive · ${where}`, ...countLines(c, cfg.include), `  In your cloud session, say: “read the nunchi results in ${where}”.`, stop, ...bell(`Google Drive · ${where}`)],
      { run: id, dest: 'drive', where, screens: c.screens, files: c.files, bytes: c.bytes, ...(partial ? { partial } : {}) });
  }
  if (dest.kind === 'git') {
    let r;
    try { r = sendToGit({ clone: shareFiles(stateDir).clone, remote: dest.remote, branch: dest.branch, run: id, app, files: pack.files, ...(deps.check ? { check: deps.check } : {}) }); }
    catch (e) {
      if (e.code === 'PUBLIC') return done(1, [`Not shared: ${dest.web} answers without a login, so it is public. Make it private on GitHub, then run nunchi share.`]);
      if (e.code === 'REDIRECTED') {
        const to = (e.to || []).filter(Boolean);
        return done(1, [`Not shared: your git config sends ${dest.web}'s fetches or pushes somewhere else (${to.length ? to.join(', ') : 'an address that is not a GitHub repository'}). Nothing was sent. Remove the insteadOf, pushInsteadOf or pushurl that rewrites it, or set up the repository it goes to: nunchi share --setup in your own terminal.`]);
      }
      if (e.code === 'GIT_FAILED' || e.code === 'GIT_UNSAFE' || e.code === 'UNSAFE_PATH') return done(1, [`Not shared: ${dest.web}: ${e.message}. Nothing was sent.`]);
      throw e;
    }
    const where = `${dest.web} · branch ${dest.branch} · runs/${id}`;
    updateLog(stateDir, l => withSend(l, sendOf('sent', where, { commit: r.commit })), { generation: st.files.generation });
    return done(0, [`Shared run ${id}${partial ? ` ${label}` : ''} → ${dest.web} · branch ${dest.branch} · commit ${r.commit}`, '  Checked just now: the repository does not answer without your login.', ...countLines(c, cfg.include),
      `  In your cloud session, say: “read the nunchi results in ${dest.web}, branch ${dest.branch}, runs/${id}”.`, stop, ...bell(where)],
    { run: id, dest: 'git', where, commit: r.commit, screens: c.screens, files: c.files, bytes: c.bytes, ...(partial ? { partial } : {}) });
  }
  // (A): sealed and waiting for the skill's publish; the deny hook asks the person
  const log = readShareLog(stateDir);
  const url = artifactUrl(cfg, log);
  const outbox = outboxDir(nunchiDir);
  const name = `${id}-${packHash(pack.files)}`;
  const packDir = join(outbox, name);
  // one sealed pack at a time: another is not sealed while one the person may be answering about waits
  const was = log.sealed;
  if (was && !was.published && resolve(String(was.packDir || '')) !== resolve(packDir) && Number.isFinite(was.prepared) && now() - was.prepared < PENDING_MS && existsSync(String(was.packDir || ''))) {
    return done(1, [`Not shared: run ${was.run}'s pack, prepared at ${hhmm(was.prepared)}, is still waiting for its publish (Claude Code asks you). Answer that first, or run nunchi share again after ${hhmm(was.prepared + PENDING_MS)}. Nothing new was prepared.`], { run: id });
  }
  const plan = publishPlan({ pack, run: id, app, packDir, url, at: url ? log.written[`artifact|${url}`] : null });
  if (plan.problem) return done(1, [limitLine(id, plan.problem)], { run: id });
  try {
    // nunchi's own folders, never through a link (openState refused one at .nunchi/share already)
    for (const d of [outbox, packDir]) refuseLink(d);
    // a pack folder is written once: the same pack again is the folder as written, or refused when it was changed
    if (existsSync(packDir)) {
      const want = pack.files.map(f => ({ path: f.path, bytes: f.data.length, sha256: f.sha ??= sha256(f.data) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      if (JSON.stringify(listPackDir(packDir)) !== JSON.stringify(want)) return done(1, [`Not shared: .nunchi/share/outbox/${name} was changed after nunchi wrote it. Delete that folder, then run nunchi share again. Nothing was prepared.`], { run: id });
    } else writePackDir(packDir, pack.files);
    writeStable(join(outbox, 'publish.json'), plan.call);
  } catch (e) {
    if (e.code === 'UNSAFE_PATH') return done(1, [`Not shared: ${e.message}. Nothing was prepared.`], { run: id });
    throw e;
  }
  // only the newest pack waits: older ones nunchi wrote are removed
  try { for (const n of readdirSync(outbox)) if (n !== name && (PACK_NAME.test(n) || RUN_ID.test(n)) && lstatSync(join(outbox, n)).isDirectory()) rmSync(join(outbox, n), { recursive: true, force: true }); } catch {}
  const seal = sealOf({ plan, pack, packDir, run: id, app, include: cfg.include, counts: c, url, prepared: now(), partial });
  updateLog(stateDir, l => withSend({ ...l, sealed: seal }, sendOf('prepared', url || 'a new private artifact')), { generation: st.files.generation });
  const priv = url && log.artifact?.url === url && log.artifact?.audience === 'private' ? ' (private)' : '';
  return done(0, [`Run ${id}${partial ? ` ${label}` : ''} is ready to share → ${url ? `your artifact ${url}${priv}` : 'a new private artifact'}`, ...countLines(c, cfg.include, { inline: true }), '  Claude Code will ask you to allow the publish.'],
    { run: id, dest: 'artifact', where: url || null, publish: join(outbox, 'publish.json'), screens: c.screens, files: c.files, bytes: c.bytes, ...(partial ? { partial } : {}) });
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
  if (cfg.worktree.stream !== stateRoot(project).stream) lines.push(`  Set up for the worktree at ${shown(cfg.worktree.path)}: only its full checks are sent, not this one's.`);
  const sends = (log?.sends || []).filter(x => x.state !== 'prepared' || x === log.sends.at(-1));
  if (!sends.length) lines.push('  Nothing sent yet.');
  const WORD = { prepared: 'Prepared', unknown: 'Not confirmed' };
  for (const x of sends) lines.push(`  ${WORD[x.state] || 'Sent'} run ${x.run}${x.partial ? ' (partial check)' : ''} · ${x.at} → ${x.where} (${x.screens} screen${s(x.screens)}, ${x.files} files${x.commit ? `, commit ${x.commit}` : ''})`);
  lines.push(cfg.on ? '  To stop: nunchi share --off' : '  To turn it on again: nunchi share --on in your own terminal, or Turn on in the board');
  return { code: 0, lines };
}
