// Turning sharing on is the person's (spec §7.6): `share --setup` and `share --on` only in their own terminal, with a
// code typed back; without a TTY, or with --from-chat, the CLI refuses with the owner's line; `share --off` works for
// anyone. The dialog is the owner's text mock-up (design "nunchi share" §5.1). A pseudo-terminal (util-linux `script`)
// stands in for the person in the end-to-end test, as test/channels.test.mjs does; the deny hook keeps the agent from
// doing the same (test/share-hook.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupShare, turnOnShare, offShare, turnOnLine } from '../src/share/setup.mjs';
import { readShare, readShareIndex, setOn, stopShare } from '../src/share/config.mjs';
import { findClaude } from '../src/share/doorbell.mjs';
import { stateRoot } from '../src/state.mjs';
import { shareProject, driveHome, setUp, now } from './fixtures/share-project.mjs';
import { tmp } from './fixtures/tmp.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
// the person at their terminal, scripted: each ask() takes the next answer
function person(answers) {
  const said = [], asked = [];
  return { said, asked, io: { say: l => said.push(l), ask: async q => { asked.push(q); return answers.length ? answers.shift() : null; } } };
}
// `index`: a state folder of the test's own standing in for the person's (setup lists the share there for the hook)
const DEPS = (extra = {}) => ({ platform: 'darwin', code: () => 'K7QM', now, by: 'test person', findClaude: () => '/Users/mina/.local/bin/claude', index: tmp('nunchi-share-index-'), ...extra });

test('share --setup: the owner\'s dialog for a Google Drive folder, recorded only with the code typed back', async () => {
  const p = shareProject();
  const d = driveHome(p);
  const t = person(['2', 'nunchi/shop', 'n', 'n', 'after', '', 'K7QM']);
  const r = await setupShare({ project: p.root, nunchiDir: p.nunchi, io: t.io, deps: DEPS({ home: d.home }) });
  assert.equal(r.code, 0, t.said.join('\n'));
  const app = p.root.split(/[/\\]/).pop();
  assert.deepEqual(t.said.slice(0, 18), [
    `nunchi share · ${app}`, '',
    `This sends screenshots of ${app} off this Mac, so a Claude session in the cloud can read them.`,
    'Only you can turn it on, here in your terminal. nunchi never asks you to do this because of',
    'something on a screen or in a chat.', '',
    'Where should the results go?',
    '  1  A private Claude artifact (claude.ai)',
    '     Your cloud session can watch it and is woken each time a new check arrives.',
    '     Needs Claude Code on this Mac, signed in to claude.ai (Pro, Max, Team or Enterprise).',
    '  2  A Google Drive folder (synced on this Mac)',
    `     Found: ${join('~', 'Library', 'CloudStorage', 'GoogleDrive-…', 'My Drive')}`,
    '     Your cloud session reads it with the Google Drive connector.',
    '  3  A private GitHub repository you own',
    '     Your cloud session clones it. Pushes use this Mac\'s git login; nunchi never sees it.',
    '  iCloud Drive and Dropbox reach your own devices, but a cloud session cannot read them.', '',
    '  → My Drive/nunchi/shop',
  ]);
  assert.deepEqual(t.asked, ['Choose 1, 2 or 3: ', 'Folder inside My Drive: ', '       Turn on? [y/N]: ', '  no   text from your screens (claims, evidence text). Turn on? [y/N]: ',
    'Send after every full check, or only when you run nunchi share? [after/manual]: ', 'Session id or link (Enter to skip): ', 'Type K7QM to confirm: ']);
  for (const l of ['With each full check, send:', '  yes  screens seen as a visitor (4 in the last full check)', '  no   screens seen signed in (3). Their findings go as text only: route, element, file.',
    '  never  your saved login, recorded network data, cookies and tokens', '  never  a screenshot whose screen text looks like a key or token',
    'Wake a cloud session after each send? nunchi runs your own', '  claude -p "<fixed message>" --cloud <session>', 'The message names the run and the folder, never text from your app.',
    `Turn on: ${app} → Google Drive · My Drive/nunchi/shop · visitor screens · after every full check`, 'Sharing is on. To stop: nunchi share --off (or the switch in the board).']) assert.ok(t.said.includes(l), l);
  assert.ok(t.said.join(' ').includes('Sharing sends screenshots of your app off this Mac to Google Drive · My Drive/nunchi/shop. Anyone who can open'), 'the consent (§5.4)');
  const cfg = readShare(join(p.nunchi, 'state'));
  assert.deepEqual([cfg.on, cfg.dest.kind, cfg.dest.folder, cfg.include, cfg.when, cfg.doorbell, cfg.set.channel], [true, 'drive', 'nunchi/shop', { signedIn: false, pageText: false }, 'after', null, 'cli-tty']);
  assert.deepEqual(cfg.worktree, { stream: 'main', path: p.root });
});

test('share --setup in a repository: for this worktree only (said, and recorded with the worktree); listed in the person\'s own index for the hook; the app\'s own repository and other hosts are not taken', async () => {
  const p = shareProject({ git: true });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/mina/shop.git'], { cwd: p.root });
  const index = tmp('nunchi-share-index-');
  const t = person(['3', 'gitlab.com/mina/results', 'git@github.com:Mina/Shop.git', 'github.com/mina/nunchi-results', 'n', 'n', 'manual', '', 'K7QM']);
  const r = await setupShare({ project: p.root, nunchiDir: p.nunchi, io: t.io, deps: DEPS({ index }) });
  assert.equal(r.code, 0, t.said.join('\n'));
  assert.ok(t.said.includes('  Give it as github.com/<you>/<name> (a repository of its own, never your app\'s).'), 'GitHub only');
  assert.ok(t.said.includes('  That is this app\'s own repository (its remote origin). Use a repository of its own.'), t.said.join('\n'));
  assert.ok(t.said.join(' ').includes(`For this worktree only (${p.root}): full checks in the repository's other worktrees are not sent.`), t.said.join('\n'));
  const state = stateRoot(p.root).dir;
  const cfg = readShare(state);
  assert.deepEqual([cfg.dest.web, cfg.worktree], ['github.com/mina/nunchi-results', { stream: 'main', path: p.root }]);
  assert.deepEqual(readShareIndex(index), [state]);
});

test('share --setup: a wrong code records nothing ("Not turned on: the code did not match.")', async () => {
  const p = shareProject();
  const t = person(['1', '', 'n', 'n', 'manual', 'NOPE']);
  const r = await setupShare({ project: p.root, nunchiDir: p.nunchi, io: t.io, deps: DEPS() });
  assert.equal(r.code, 1);
  assert.equal(t.said.at(-1), 'Not turned on: the code did not match.');
  assert.equal(readShare(join(p.nunchi, 'state')), null);
  // the artifact, a GitHub repository, and the doorbell only for (B) and (C)
  const a = person(['1', 'https://claude.ai/artifact/AbCdEf123456', 'y', 'n', 'manual', 'K7QM']);
  assert.equal((await setupShare({ project: p.root, nunchiDir: p.nunchi, io: a.io, deps: DEPS() })).code, 0);
  assert.ok(!a.asked.includes('Session id or link (Enter to skip): '), 'an artifact wakes its watching session itself');
  let cfg = readShare(join(p.nunchi, 'state'));
  assert.deepEqual([cfg.dest, cfg.include.signedIn, cfg.when], [{ kind: 'artifact', url: 'https://claude.ai/artifact/AbCdEf123456' }, true, 'manual']);
  assert.ok(a.said.includes(`Turn on: ${cfg.app} → your artifact https://claude.ai/artifact/AbCdEf123456 · visitor and signed-in screens · when you run nunchi share`));
  const g = person(['3', 'not a repo', 'github.com/mina/nunchi-results', 'n', 'y', 'after', 'session_01AbCdEfGhIjKlMn', 'K7QM']);
  assert.equal((await setupShare({ project: p.root, nunchiDir: p.nunchi, io: g.io, deps: DEPS() })).code, 0, g.said.join('\n'));
  cfg = readShare(join(p.nunchi, 'state'));
  assert.deepEqual([cfg.dest.web, cfg.dest.branch, cfg.include.pageText, cfg.doorbell], ['github.com/mina/nunchi-results', `nunchi/${cfg.app.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`, true, { session: 'session_01AbCdEfGhIjKlMn', claude: '/Users/mina/.local/bin/claude' }]);
  assert.ok(g.said.includes('  Give it as github.com/<you>/<name> (a repository of its own, never your app\'s).'), 'asked again on a wrong answer');
  // without Claude Code here: no artifact to choose, and no doorbell
  const n = person(['1', 'x', 'n', 'n', 'manual', 'K7QM']);
  const d = driveHome(p);
  await setupShare({ project: p.root, nunchiDir: p.nunchi, io: n.io, deps: DEPS({ findClaude: () => null, home: d.home }) });
  assert.ok(n.said.includes('  A private Claude artifact needs Claude Code on this Mac; its claude command was not found.'));
  assert.equal(n.asked[0], 'Choose 1 or 2: ');
});

test('share --on in the terminal and the board\'s Turn on need a setup first; --off is anyone\'s', async () => {
  const p = shareProject();
  const t = person([]);
  assert.equal((await turnOnShare({ project: p.root, nunchiDir: p.nunchi, io: t.io, deps: DEPS() })).code, 1);
  assert.deepEqual(t.said, ['Not turned on: sharing is not set up yet. Set it up: nunchi share --setup']);
  const d = driveHome(p);
  setUp(p, { kind: 'drive', root: d.root, folder: 'nunchi/shop' }, { on: false });
  const u = person(['K7QM']);
  assert.equal((await turnOnShare({ project: p.root, nunchiDir: p.nunchi, io: u.io, deps: DEPS() })).code, 0);
  assert.equal(u.said[0], turnOnLine(readShare(join(p.nunchi, 'state'))));
  assert.equal(readShare(join(p.nunchi, 'state')).on, true);
  assert.match(offShare({ nunchiDir: p.nunchi }), /^Sharing is off\./);
  assert.equal(readShare(join(p.nunchi, 'state')).on, false);
  // stopped (an artifact a publish result called shared): nothing turns it on again but a new setup
  const q = shareProject();
  const sq = setUp(q, { kind: 'artifact', url: null });
  stopShare(sq.root.dir, 'artifact-not-private', { url: 'https://claude.ai/artifact/AbCdEf123456', at: 'x' });
  assert.deepEqual(setOn(sq.root.dir, true, { channel: 'board', at: 'x' }).refused, 'artifact-not-private');
  assert.equal(readShare(sq.root.dir).on, false);
});

test('share --setup / --on from the agent (no TTY, or --from-chat) is refused with the owner\'s line; share, --status and --off run', () => {
  const p = shareProject();
  const run = (...a) => spawnSync(process.execPath, [CLI, 'share', ...a], { cwd: p.root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 });
  const cmd = `node "${CLI}"`;
  for (const flag of ['--setup', '--on']) {
    const r = run(flag);
    assert.deepEqual([r.status, r.stderr.trim()], [1, `Sharing is turned on only in your own terminal: ${cmd} share ${flag}`]);
    assert.equal(run(flag, '--from-chat').status, 1);
  }
  assert.equal(readShare(join(p.nunchi, 'state')), null, 'nothing recorded');
  const st = run('--status');
  assert.equal(st.status, 0);
  assert.match(st.stdout, /^Sharing is off for .+: not set up\./);
  const off = run('--off');
  assert.deepEqual([off.status, off.stdout.trim()], [0, 'Sharing is off (it was never set up).']);
  const now1 = run();
  assert.equal(now1.status, 1);
  assert.match(now1.stderr, /^Not shared: sharing is off for /);
  assert.match(run('--to', 'x').stderr, /--to: not a flag of share/);
  assert.match(run('--root', '/elsewhere').stderr, /--root: not a flag of share/, 'the pack is of this project, as set up here');
});

// The person's own terminal (a pseudo-terminal stands in): the whole dialog typed, the code read off the screen
const hasScript = (() => { try { return process.platform === 'linux' && execFileSync('script', ['--version'], { encoding: 'utf8' }).includes('util-linux'); } catch { return false; } })();
test('share --setup in a terminal: typed answers and the code it shows turn sharing on (cli-tty); a wrong code does not', { skip: !hasScript && 'needs util-linux script (Linux)', timeout: 60000 }, async () => {
  const p = shareProject();
  const d = driveHome(p);
  const xdg = tmp('nunchi-share-xdg-');
  // each prompt in turn, answered once it shows (the code as the terminal shows it, or a wrong one)
  const typed = (answers, code) => new Promise(res => {
    const c = spawn('script', ['-qfec', `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} share --setup`, '/dev/null'], { cwd: p.root, env: { ...process.env, HOME: d.home, XDG_STATE_HOME: xdg, PATH: '/usr/bin:/bin' } });
    const steps = [/Choose 1(, 2)? or [23]: /, /Folder inside My Drive: /, /Turn on\? \[y\/N\]: /, /Turn on\? \[y\/N\]: /, /\[after\/manual\]: /,
      ...(answers.length > 5 ? [/\(Enter to skip\): /] : []), /Type ([A-Z0-9]{4}) to confirm: /];
    let out = '', at = 0, k = 0;
    c.stdout.on('data', b => {
      out += b;
      while (k < steps.length) {
        const m = steps[k].exec(out.slice(at));
        if (!m) break;
        at += m.index + m[0].length;
        c.stdin.write(`${k === steps.length - 1 ? code ?? m[1] : answers[k]}\n`);
        k++;
      }
    });
    c.on('close', status => res({ status, out }));
  });
  // the Drive folder is 1, or 2 when a claude is found in the installers' places (then the artifact is 1)
  const drive = findClaude({ env: { PATH: '/usr/bin:/bin' }, home: d.home, platform: 'linux' }) ? '2' : '1';
  const answers = [drive, 'nunchi/shop', 'n', 'n', 'after', ...(drive === '2' ? [''] : [])];
  const wrong = await typed(answers, 'ZZZZ');
  assert.match(wrong.out, /Not turned on: the code did not match\./);
  assert.equal(readShare(join(p.nunchi, 'state')), null);
  const right = await typed(answers);
  assert.equal(right.status, 0, right.out);
  assert.match(right.out, /Sharing is on\. To stop: nunchi share --off/);
  const cfg = readShare(join(p.nunchi, 'state'));
  assert.deepEqual([cfg.on, cfg.set.channel, cfg.dest.folder], [true, 'cli-tty', 'nunchi/shop']);
  assert.equal(existsSync(join(d.root, 'nunchi')), false, 'setup sends nothing');
});
