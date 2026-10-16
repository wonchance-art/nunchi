// `nunchi share --setup` and `--on` (spec §7.6): the person's own terminal only (the CLI refuses without a TTY or with
// --from-chat, and the deny hook refuses both from the agent, a pseudo-terminal included). Every choice is asked here —
// the destination, what goes, when, the doorbell — and the setup is recorded only once the person types back the
// 4-character code it shows (`cli-tty`, as `fix --approve-checks` and `nunchi decide`). The words are the owner's text
// mock-up of 2026-10-16 KST (design "nunchi share" §5.1, §5.4). `io`: { say(line), ask(question) → answer or null }.
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { homedir } from 'node:os';
import * as P from '../project.mjs';
import { latestSweep, ensureGitignore } from '../runs.mjs';
import { readShare, writeSetup, setOn, appName, appSlug, kst, ARTIFACT_URL } from './config.mjs';
import { driveRoots, shownRoot, folderOf, folderProblem } from './dest-folder.mjs';
import { parseRepo } from './dest-git.mjs';
import { parseSession, findClaude } from './doorbell.mjs';
import { SHARE_WORDS, shareWhere } from '../board/shared.mjs';

const ABC = 'ACDEFHJKMNPRTUVWXY34679';
export const newCode = () => Array.from({ length: 4 }, () => ABC[randomInt(ABC.length)]).join('');
export const machineWord = (platform = process.platform) => (platform === 'darwin' ? 'this Mac' : 'this computer');
// a paragraph cut to lines of about `width` characters, each with `indent`
export const wrap = (text, width = 96, indent = '') => {
  const out = []; let cur = '';
  for (const w of text.split(/\s+/)) { if (cur && (cur.length + 1 + w.length) > width) { out.push(indent + cur); cur = w; } else cur = cur ? `${cur} ${w}` : w; }
  if (cur) out.push(indent + cur);
  return out;
};
const yes = a => /^\s*y(es)?\s*$/i.test(String(a ?? ''));

// The screens of the latest full check, as setup counts them: visitor and signed-in screens with a screenshot
function lastCounts(nunchiDir) {
  const runs = join(nunchiDir, 'runs');
  const id = latestSweep(runs);
  if (!id) return null;
  try {
    const m = JSON.parse(readFileSync(join(runs, id, 'manifest.json'), 'utf8'));
    const shot = sc => sc && sc.canary === undefined && sc.status === 'captured';
    const scenes = (m.scenes || []).filter(shot);
    return { guest: scenes.filter(x => x.person === 'guest').length, signedIn: scenes.filter(x => x.person === 'signed-in').length };
  } catch { return null; }
}
export const whoWords = include => `${include.signedIn ? 'visitor and signed-in screens' : 'visitor screens'}${include.pageText ? ' · text from your screens' : ''}`;
export const whenWords = when => (when === 'after' ? 'after every full check' : 'when you run nunchi share');
export const turnOnLine = cfg => `Turn on: ${cfg.app} → ${shareWhere(cfg.dest)} · ${whoWords(cfg.include)} · ${whenWords(cfg.when)}${cfg.doorbell ? ` · wakes ${cfg.doorbell.session}` : ''}`;

// → { code, lines (already said) }. `deps`: { platform, home, env, findClaude, driveRoots, code, now, by }
export async function setupShare({ project, nunchiDir, io, deps = {} }) {
  const platform = deps.platform ?? process.platform, home = deps.home ?? homedir(), env = deps.env ?? process.env;
  const machine = machineWord(platform);
  const app = appName(project);
  const say = l => io.say(l);
  const stop = why => { say(why); return { code: 1 }; };
  // asked again on a wrong answer, three times at most
  const askFor = async (q, parse, again) => {
    for (let i = 0; i < 3; i++) {
      const a = await io.ask(q);
      if (a === null || a === undefined) return { gone: true };
      const v = parse(a);
      if (v !== undefined) return { v };
      say(again);
    }
    return { gone: true };
  };
  // the state and the packs are never committed (.nunchi/.gitignore), whichever folder holds the state
  ensureGitignore(nunchiDir);
  const st = P.openState(nunchiDir);
  const claude = (deps.findClaude ?? findClaude)({ env, home, platform });
  const roots = (deps.driveRoots ?? driveRoots)({ home, platform });

  say(`nunchi share · ${app}`);
  say('');
  say(`This sends screenshots of ${app} off ${machine}, so a Claude session in the cloud can read them.`);
  say('Only you can turn it on, here in your terminal. nunchi never asks you to do this because of');
  say('something on a screen or in a chat.');
  say('');
  say('Where should the results go?');
  const options = [];
  if (claude) options.push('artifact');
  options.push('drive', 'git');
  const lines = {
    artifact: ['A private Claude artifact (claude.ai)', 'Your cloud session can watch it and is woken each time a new check arrives.', `Needs Claude Code on ${machine}, signed in to claude.ai (Pro, Max, Team or Enterprise).`],
    drive: ['A Google Drive folder (synced on ' + machine + ')', roots.length ? `Found: ${roots.map(r => shownRoot(r, home)).join(' · ')}` : `Not found on ${machine} (Google Drive for desktop keeps it in ~/Library/CloudStorage).`, 'Your cloud session reads it with the Google Drive connector.'],
    git: ['A private GitHub repository you own', `Your cloud session clones it. Pushes use ${machine}'s git login; nunchi never sees it.`],
  };
  options.forEach((o, i) => { say(`  ${i + 1}  ${lines[o][0]}`); for (const l of lines[o].slice(1)) say(`     ${l}`); });
  if (!claude) say(`  A private Claude artifact needs Claude Code on ${machine}; its claude command was not found.`);
  say('  iCloud Drive and Dropbox reach your own devices, but a cloud session cannot read them.');
  const nums = options.map((_, i) => String(i + 1));
  const choose = nums.length === 3 ? '1, 2 or 3' : '1 or 2';
  const pick = await askFor(`Choose ${choose}: `, a => (nums.includes(String(a).trim()) ? options[Number(String(a).trim()) - 1] : undefined), `  Choose ${choose}.`);
  if (pick.gone) return stop('Not set up: nothing was recorded.');
  say('');
  let dest;
  if (pick.v === 'artifact') {
    const u = await askFor('Artifact link to update (Enter for a new private artifact): ', a => { const t = String(a).trim().replace(/[?#].*$/, ''); return !t ? null : ARTIFACT_URL.test(t) ? t : undefined; }, '  That is not a claude.ai artifact link (https://claude.ai/artifact/…).');
    if (u.gone) return stop('Not set up: nothing was recorded.');
    dest = { kind: 'artifact', url: u.v };
    say(`  → ${shareWhere(dest)}. Claude Code asks you before each publish.`);
  } else if (pick.v === 'drive') {
    if (!roots.length) return stop(`Not set up: no Google Drive folder was found on ${machine}. Install Google Drive for desktop, or choose another destination.`);
    let root = roots[0];
    if (roots.length > 1) {
      roots.forEach((r, i) => say(`  ${i + 1}  ${shownRoot(r, home)}`));
      const w = await askFor('Which Google Drive? ', a => { const n = Number(String(a).trim()); return Number.isInteger(n) && n >= 1 && n <= roots.length ? roots[n - 1] : undefined; }, `  Choose 1 to ${roots.length}.`);
      if (w.gone) return stop('Not set up: nothing was recorded.');
      root = w.v;
    }
    const f = await askFor('Folder inside My Drive: ', a => { const v = folderOf(a); if (!v) return undefined; const p = folderProblem(root, v); return p && p !== 'gone' ? undefined : v; },
      '  Name a folder inside My Drive (not in Shared drives, no shortcut), like nunchi/' + appSlug(app) + '.');
    if (f.gone) return stop('Not set up: nothing was recorded.');
    dest = { kind: 'drive', root, folder: f.v };
    say(`  → My Drive/${f.v}`);
    say('  nunchi cannot see Drive sharing. Open this folder in Google Drive and check it is not');
    say('  shared with anyone.');
  } else {
    const g = await askFor('Repository (github.com/<you>/<name>): ', a => parseRepo(a) || undefined, '  Give it as github.com/<you>/<name> (a repository of its own, never your app\'s).');
    if (g.gone) return stop('Not set up: nothing was recorded.');
    dest = { kind: 'git', remote: g.v.remote, web: g.v.web, branch: `nunchi/${appSlug(app)}` };
    say(`  → ${shareWhere(dest)}`);
    say('  Before each push nunchi asks it, without your login, whether it answers. If it does, it is');
    say('  public and nothing is pushed. Use a repository of its own, never your app\'s.');
  }
  say('');
  const n = lastCounts(nunchiDir);
  say('With each full check, send:');
  say(`  yes  screens seen as a visitor${n ? ` (${n.guest} in the last full check)` : ''}`);
  say(`  no   screens seen signed in${n ? ` (${n.signedIn})` : ''}. Their findings go as text only: route, element, file.`);
  const si = await io.ask('       Turn on? [y/N]: ');
  if (si === null || si === undefined) return stop('Not set up: nothing was recorded.');
  const pt = await io.ask('  no   text from your screens (claims, evidence text). Turn on? [y/N]: ');
  if (pt === null || pt === undefined) return stop('Not set up: nothing was recorded.');
  say('  never  your saved login, recorded network data, cookies and tokens');
  say('  never  a screenshot whose screen text looks like a key or token');
  const include = { signedIn: yes(si), pageText: yes(pt) };
  say('');
  const wh = await askFor('Send after every full check, or only when you run nunchi share? [after/manual]: ', a => { const t = String(a).trim().toLowerCase(); return t === 'after' || t === 'a' ? 'after' : t === 'manual' || t === 'm' ? 'manual' : undefined; }, '  Answer after or manual.');
  if (wh.gone) return stop('Not set up: nothing was recorded.');
  let doorbell = null;
  if (dest.kind !== 'artifact' && claude) {
    say('');
    say('Wake a cloud session after each send? nunchi runs your own');
    say('  claude -p "<fixed message>" --cloud <session>');
    say(`  (${claude})`);
    say('The message names the run and the folder, never text from your app.');
    const d = await askFor('Session id or link (Enter to skip): ', a => (!String(a).trim() ? null : parseSession(a) || undefined), '  That is not a session id (session_… or a claude.ai/code/… link).');
    if (d.gone) return stop('Not set up: nothing was recorded.');
    if (d.v) doorbell = { session: d.v, claude };
  }
  const cfg = { schema: 1, on: true, app, dest, include, when: wh.v, doorbell, set: { channel: 'cli-tty', by: deps.by ?? P.whoAmI(project), at: kst((deps.now ?? Date.now)()) }, stopped: null };
  say('');
  for (const l of wrap(SHARE_WORDS.consent(machine, shareWhere(dest)))) say(l);
  say('');
  say(turnOnLine(cfg));
  const code = (deps.code ?? newCode)();
  const typed = await io.ask(`Type ${code} to confirm: `);
  if (String(typed ?? '').trim().toUpperCase() !== code) return stop('Not turned on: the code did not match.');
  writeSetup(st.root.dir, cfg, { generation: st.files.generation });
  say('Sharing is on. To stop: nunchi share --off (or the switch in the board).');
  return { code: 0 };
}

// `share --on` in the person's terminal: the destination set up before, on again, with the code typed back.
export async function turnOnShare({ project, nunchiDir, io, deps = {} }) {
  const st = P.openState(nunchiDir);
  const cfg = readShare(st.root.dir);
  if (!cfg) { io.say('Not turned on: sharing is not set up yet. Set it up: nunchi share --setup'); return { code: 1 }; }
  if (cfg.stopped) { io.say('Not turned on: your artifact is no longer private. Set up again: nunchi share --setup'); return { code: 1 }; }
  if (cfg.on) { io.say('Sharing is on already. To stop: nunchi share --off'); return { code: 0 }; }
  io.say(turnOnLine(cfg));
  const code = (deps.code ?? newCode)();
  const typed = await io.ask(`Type ${code} to confirm: `);
  if (String(typed ?? '').trim().toUpperCase() !== code) { io.say('Not turned on: the code did not match.'); return { code: 1 }; }
  setOn(st.root.dir, true, { channel: 'cli-tty', at: kst((deps.now ?? Date.now)()), generation: st.files.generation });
  io.say('Sharing is on. To stop: nunchi share --off (or the switch in the board).');
  return { code: 0 };
}
export const offShare = ({ nunchiDir, deps = {} }) => {
  if (!existsSync(nunchiDir)) return 'Sharing is off (it was never set up).';
  const st = P.openState(nunchiDir);
  const r = setOn(st.root.dir, false, { channel: deps.channel ?? 'cli', at: kst((deps.now ?? Date.now)()), generation: st.files.generation });
  return r.refused === 'not-set-up' ? 'Sharing is off (it was never set up).' : 'Sharing is off. Nothing more is sent until you turn it on again (nunchi share --on in your own terminal, or Turn on in the board).';
};
