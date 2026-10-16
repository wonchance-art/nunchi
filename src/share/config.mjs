// `nunchi share` (spec §7.6): what the person chose and what nunchi sent, kept in the state folder (state.mjs: the
// repository's shared `<git-common-dir>/nunchi/<app>/state/`, or `.nunchi/state`), where the deny hook keeps every tool
// of the agent away from it, reads included. Never in `.nunchi/config.json`: that file is committed, and a Drive path
// (which names the account) or a private repository's name would land in the app's repository.
//
// - `share.json`: the person's choice — on or off, the destination, what goes (signed-in screens, page text), when
//   (after every full check, or only on `nunchi share`), the doorbell. Turning sharing on, and every setting of it, is
//   the person's: a code typed back in their own terminal (`cli-tty`), or the board's Turn on (only once a destination
//   was set up in the terminal). Turning it off is anyone's, the agent's included.
// - `share-log.json`: what nunchi did — the sends (for "Last sent" and `share --status`), the files nunchi's own list
//   says it wrote at each destination (retention removes only those), the one sealed artifact pack waiting to be
//   published (the deny hook checks an Artifact call against it), and the artifact's pinned link and audience (written
//   by the PostToolUse hook from the publish result).
// Both are written through the state's documents (`updateDoc`: a revision, a lock, an atomic write, the generation
// bumped, so an open board redraws).
import { join, isAbsolute, basename } from 'node:path';
import { readDoc, updateDoc } from '../state.mjs';

export const SHARE_KINDS = ['artifact', 'drive', 'git'];
export const RETAIN = 5;                    // runs kept at (A) and (C); (B) keeps git history
const LOG_SENDS = 50;
export const shareFiles = stateDir => ({ config: join(stateDir, 'share.json'), log: join(stateDir, 'share-log.json'), dir: join(stateDir, 'share'), clone: join(stateDir, 'share', 'git') });

const str = (v, max = 4096) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const obj = v => !!v && typeof v === 'object' && !Array.isArray(v);
export const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]{6,128}$/;
export const SESSION_ID = /^(?:session|cse)_[A-Za-z0-9]{8,128}$/;
// a folder inside My Drive: plain names, `/` between them, no `..`, no leading or trailing slash
export const DRIVE_FOLDER = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[^/\\\u0000-\u001f\u007f:*?"<>|]{1,255}(?:\/[^/\\\u0000-\u001f\u007f:*?"<>|]{1,255}){0,15}$/;

function destOk(d) {
  if (!obj(d) || !SHARE_KINDS.includes(d.kind)) return false;
  if (d.kind === 'artifact') return d.url === null || (typeof d.url === 'string' && ARTIFACT_URL.test(d.url));
  if (d.kind === 'drive') return str(d.root) && isAbsolute(d.root) && basename(d.root) === 'My Drive' && str(d.folder, 1024) && DRIVE_FOLDER.test(d.folder);
  if (d.kind === 'git') return str(d.remote, 1024) && str(d.web, 512) && str(d.branch, 200) && /^nunchi\/[a-z0-9][a-z0-9._-]{0,80}$/.test(d.branch);
  return false;
}
export function isShareConfig(c) {
  return obj(c) && c.schema === 1 && typeof c.on === 'boolean' && destOk(c.dest) && obj(c.include) && typeof c.include.signedIn === 'boolean' && typeof c.include.pageText === 'boolean'
    && (c.when === 'after' || c.when === 'manual') && str(c.app, 200)
    && (c.doorbell === null || (obj(c.doorbell) && SESSION_ID.test(String(c.doorbell.session)) && str(c.doorbell.claude) && isAbsolute(c.doorbell.claude)))
    && obj(c.set) && (c.set.channel === 'cli-tty')
    && (c.stopped === null || c.stopped === undefined || (obj(c.stopped) && typeof c.stopped.why === 'string'));
}
const isLog = l => obj(l) && l.schema === 1 && Array.isArray(l.sends) && obj(l.written) && (l.sealed === null || l.sealed === undefined || obj(l.sealed)) && (l.artifact === null || l.artifact === undefined || obj(l.artifact));
const CONFIG_FIX = 'run nunchi share --setup in your own terminal to set it up again';
const LOG_FIX = 'delete it (nunchi forgets what it sent, nothing else)';

// → the person's choice, or null when sharing was never set up
export const readShare = stateDir => readDoc(shareFiles(stateDir).config, { validate: isShareConfig, fix: CONFIG_FIX, max: 64 * 1024, why: 'is not a sharing setup nunchi wrote' }).doc;
export const emptyLog = () => ({ schema: 1, sends: [], written: {}, sealed: null, artifact: null });
export const readShareLog = stateDir => readDoc(shareFiles(stateDir).log, { validate: isLog, fix: LOG_FIX, max: 8 * 1024 * 1024, missing: emptyLog, why: 'is not a send log nunchi wrote' }).doc;

// The person's setup (from their terminal: `share --setup`), replacing any earlier one.
export function writeSetup(stateDir, cfg, { generation = null } = {}) {
  if (!isShareConfig(cfg)) throw Object.assign(new Error('not a sharing setup'), { code: 'BAD_ARGS' });
  return updateDoc(shareFiles(stateDir).config, () => ({ ...cfg }), { read: { validate: () => true, fix: CONFIG_FIX }, prev: false, generation });
}
// On or off. `on: true` only for a destination set up in the terminal and not stopped (the board's Turn on, the
// terminal's `share --on`); off is anyone's. → the setup as written, or null when there is none.
export function setOn(stateDir, on, { channel, at, generation = null } = {}) {
  let refused = null;
  const doc = updateDoc(shareFiles(stateDir).config, cur => {
    if (!cur) { refused = 'not-set-up'; return cur; }
    if (on && cur.stopped) { refused = cur.stopped.why; return cur; }
    if (cur.on === on) return cur;
    return { ...cur, on, turned: { on, channel, at } };
  }, { read: { validate: isShareConfig, fix: CONFIG_FIX, max: 64 * 1024 }, prev: false, generation });
  return { doc, refused };
}
// The artifact is no longer private (its publish result said so): sharing stops until the person sets it up again.
export function stopShare(stateDir, why, { url = null, at, generation = null } = {}) {
  return updateDoc(shareFiles(stateDir).config, cur => (!cur || (cur.stopped?.why === why && !cur.on) ? cur : { ...cur, on: false, stopped: { why, ...(url ? { url } : {}), at } }),
    { read: { validate: isShareConfig, fix: CONFIG_FIX, max: 64 * 1024 }, prev: false, generation });
}
export function updateLog(stateDir, fn, { generation = null } = {}) {
  return updateDoc(shareFiles(stateDir).log, cur => fn(cur || emptyLog()) ?? cur, { read: { validate: isLog, fix: LOG_FIX, missing: emptyLog, max: 8 * 1024 * 1024 }, prev: false, generation });
}
// A send noted in the log (the newest LOG_SENDS kept).
export const withSend = (log, send) => ({ ...log, sends: [...log.sends, send].slice(-LOG_SENDS) });
// The latest send that reached its destination (an artifact's once its publish went through).
export const lastSent = log => [...(log?.sends || [])].reverse().find(s => s.state === 'sent' || s.state === 'published') || null;
// The artifact the next publish goes to: the person's link from setup, else the one the first publish made (pinned).
export const artifactUrl = (cfg, log) => cfg?.dest?.kind !== 'artifact' ? null : cfg.dest.url || (log?.artifact?.url && ARTIFACT_URL.test(log.artifact.url) ? log.artifact.url : null);

// "github.com/mina/nunchi-results", "https://github.com/mina/nunchi-results(.git)", "git@github.com:mina/r.git",
// "ssh://git@github.com/mina/r" → { remote (as the person's git pushes to it), web: "github.com/mina/nunchi-results",
// anon: the https URL asked anonymously }, or null
export function parseRepo(input) {
  const s = String(input ?? '').trim();
  const NAME = '[A-Za-z0-9_.-]{1,100}';
  const HOST = '[A-Za-z0-9.-]{1,200}\\.[A-Za-z]{2,}';
  let m;
  const out = (host, owner, repo, remote) => {
    repo = repo.replace(/\.git$/, '');
    if (!repo || repo === '.' || repo === '..' || owner === '.' || owner === '..') return null;
    const web = `${host.toLowerCase()}/${owner}/${repo}`;
    return { remote: remote ?? `https://${web}.git`, web, anon: `https://${web}.git` };
  };
  if ((m = new RegExp(`^(?:https://)?(${HOST})/(${NAME})/(${NAME})/?$`).exec(s))) return out(m[1], m[2], m[3]);
  if ((m = new RegExp(`^git@(${HOST}):(${NAME})/(${NAME})$`).exec(s))) return out(m[1], m[2], m[3], s);
  if ((m = new RegExp(`^ssh://git@(${HOST})/(${NAME})/(${NAME})/?$`).exec(s))) return out(m[1], m[2], m[3], s);
  return null;
}

// KST, as every time nunchi writes for people
export const kst = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().replace('Z', '+09:00');
// The app's name in the lines and the branch: the project folder's name, as data (control characters out, clipped).
export const appName = project => basename(project).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim().slice(0, 60) || 'app';
export const appSlug = name => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 60) || 'app';
