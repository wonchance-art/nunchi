// The plugin's PreToolUse deny hook (design 0.1-c §1, spec §5.1 M2 notes): denied and allowed tool calls, on a
// synthetic git repository with a nunchi state, answer keys and a running board record. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judge, keyBases, protectedOf } from '../src/deny-hook.mjs';
import { tmp } from './fixtures/board-project.mjs';

const HOOK = fileURLToPath(new URL('../src/deny-hook.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const POSIX = process.platform !== 'win32';

// a repository with nunchi's shared state, a fallback state, a board record and answer keys under XDG_STATE_HOME
function repo() {
  const root = tmp('nunchi-hook-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const common = realpathSync(join(root, '.git'));
  const state = join(common, 'nunchi', 'root', 'state');
  mkdirSync(join(state, 'boards'), { recursive: true });
  writeFileSync(join(state, 'ledger.json'), '{}');
  writeFileSync(join(state, 'approved.json'), '{"approved":[]}');
  writeFileSync(join(state, 'boards', '4242.json'), JSON.stringify({ pid: 4242, port: 47123, socket: join(state, 'boards', '4242.sock'), mode: 'board', project: root }));
  mkdirSync(join(root, '.nunchi', 'runs', '0001', 'home.guest.normal.d'), { recursive: true });
  mkdirSync(join(root, '.nunchi', 'decisions', 'group-aaaaaaaaaaaa'), { recursive: true });
  const xdg = join(root, 'xdg');
  mkdirSync(join(xdg, 'nunchi', 'abc', 'keys', '0001'), { recursive: true });
  writeFileSync(join(xdg, 'nunchi', 'abc', 'keys', '0001', 'verify-key.json'), '{}');
  return { root, common, state, env: { ...process.env, XDG_STATE_HOME: xdg }, xdg };
}
const call = (r, tool, input) => judge({ tool_name: tool, tool_input: input, cwd: r.root }, { env: r.env });

test('deny hook: the shared state, .nunchi/state, the answer keys, the saved login and the canaries are out of reach of every tool', () => {
  const r = repo();
  const denied = [
    ['Read', { file_path: join(r.state, 'ledger.json') }],
    ['Read', { file_path: join(r.root, '.git', 'nunchi', 'root', 'state', 'approved.json') }],
    ['Read', { file_path: join(r.root, '.nunchi', 'state', 'ledger.json') }],
    ['Read', { file_path: '.nunchi/state/approved.json' }],
    ['Write', { file_path: join(r.state, 'approved.json'), content: '{}' }],
    ['Edit', { file_path: join(r.state, 'generation'), old_string: '1', new_string: '2' }],
    ['Read', { file_path: join(r.xdg, 'nunchi', 'abc', 'keys', '0001', 'verify-key.json') }],
    ['Read', { file_path: join(homedir(), '.local', 'state', 'nunchi', 'x', 'keys', '0001', 'hunt-key.json') }],
    ['Read', { file_path: join(r.root, '.nunchi', 'auth.json') }],
    ['Read', { file_path: join(r.root, '.nunchi', 'runs', '0001', 'canaries.json') }],
    ['Read', { file_path: join(r.root, '.nunchi', 'runs', '0001', 'verify-key.json') }],
    ['Grep', { pattern: 'approved', path: r.state }],
    ['Grep', { pattern: 'x', path: r.root, glob: '.nunchi/state/**' }],
    ['Glob', { pattern: '**/*-key.json', path: r.xdg }],
    ['Glob', { pattern: '.git/nunchi/**' }],
    ['Bash', { command: `cat ${join(r.state, 'ledger.json')}` }],
    ['Bash', { command: 'cat .git/nunchi/root/state/approved.json' }],
    ['Bash', { command: 'ls -la .nunchi/state/' }],
    ['Bash', { command: 'cat ~/.local/state/nunchi/abc/keys/0001/recheck-key.json' }],
    ['Bash', { command: 'find "$XDG_STATE_HOME/nunchi" -name "*.json"' }],
    ['Bash', { command: 'type %LOCALAPPDATA%\\nunchi\\abc\\keys\\0001\\verify-key.json' }],
    ['Bash', { command: 'jq . .nunchi/runs/0001/canaries.json' }],
    ['Bash', { command: 'cat .nunchi/auth.json | base64' }],
    ['Bash', { command: `node -e "require('fs').readFileSync('${r.root}/.nunchi/state/ledger.json')"` }],
  ];
  for (const [tool, input] of denied) assert.ok(call(r, tool, input), `${tool} ${JSON.stringify(input)} is denied`);
});

test('deny hook: decisions, labels, lens packs and .nunchi/config.json can be read but not written by the AI\'s tools', () => {
  const r = repo();
  const d = join(r.root, '.nunchi', 'decisions', 'group-aaaaaaaaaaaa', 'x-1.json');
  for (const [tool, input] of [
    ['Write', { file_path: d, content: '{}' }], ['Edit', { file_path: d, old_string: 'a', new_string: 'b' }], ['MultiEdit', { file_path: d, edits: [] }],
    ['Write', { file_path: join(r.root, '.nunchi', 'labels', 'me', 'aaaaaaaaaaaa.json'), content: '{}' }],
    ['Write', { file_path: join(r.root, '.nunchi', 'lenses', 'mine.json'), content: '{}' }],
    ['Edit', { file_path: join(r.root, '.nunchi', 'lenses.lock.json'), old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: join(r.root, '.nunchi', 'config.json'), content: '{"allowHosts":["prod.example.com"]}' }],
    ['Bash', { command: `echo '{}' > ${d}` }],
    ['Bash', { command: 'cp /tmp/x.json .nunchi/decisions/group-aaaaaaaaaaaa/' }],
    ['Bash', { command: 'rm -rf .nunchi/decisions' }],
    ['Bash', { command: "sed -i 's/fix/keep/' .nunchi/decisions/group-aaaaaaaaaaaa/x-1.json" }],
    ['Bash', { command: 'printf \'{"allowHosts":["x"]}\' | tee .nunchi/config.json' }],
    ['Bash', { command: 'git checkout -- .nunchi/decisions' }],
  ]) assert.ok(call(r, tool, input), `${tool} ${JSON.stringify(input)} is denied`);
  for (const [tool, input] of [
    ['Read', { file_path: d }], ['Read', { file_path: join(r.root, '.nunchi', 'config.json') }],
    ['Bash', { command: `cat ${d}` }], ['Bash', { command: 'ls .nunchi/decisions' }], ['Bash', { command: 'git add .nunchi/decisions && git commit -m "decisions"' }],
    ['Bash', { command: 'git diff -- .nunchi/decisions' }], ['Grep', { pattern: 'keep', path: join(r.root, '.nunchi', 'decisions') }],
  ]) assert.equal(call(r, tool, input), null, `${tool} ${JSON.stringify(input)} is allowed`);
});

test('deny hook: the human-only commands, and nunchi under a pseudo-terminal, are denied; the agent\'s own commands are not', () => {
  const r = repo();
  for (const command of [
    'node "${CLAUDE_SKILL_DIR}/../../src/cli.mjs" approve --all', 'nunchi approve mv1-abc', 'npx nunchi approve --all',
    'node src/cli.mjs open --label', 'nunchi label', 'nunchi fix --start --approve-checks',
    'script -q /dev/null node src/cli.mjs decide abc keep --reason intended', 'unbuffer nunchi decide abc keep --reason intended',
    'python3 -c "import pty; pty.spawn([\'nunchi\', \'decide\', \'abc\', \'fix\'])"', 'expect -c "spawn nunchi open --no-browser"',
  ]) assert.ok(call(r, 'Bash', { command }), command);
  for (const command of [
    'node "${CLAUDE_SKILL_DIR}/../../src/cli.mjs" findings --json', 'node src/cli.mjs decide abc fix', 'node src/cli.mjs decide abc not-a-problem --from-chat',
    'node src/cli.mjs open', 'nunchi open --no-browser', 'nunchi open --stop', 'node src/cli.mjs hunt --plan', 'node src/cli.mjs capture --url http://127.0.0.1:3000',
    'npm run build && npm test', 'cat .nunchi/runs/0001/hunt-plan.json', 'ls .nunchi/runs/0001/home.guest.normal.d', 'git log --oneline',
    'curl -s http://127.0.0.1:3000/api/health', 'echo "a script to approve"',
  ]) assert.equal(call(r, 'Bash', { command }), null, command);
});

test('deny hook: the board\'s script is never run directly and its link handover is never asked for; reading its source is fine', () => {
  const r = repo();
  for (const command of [
    'node src/board/server.mjs --project . --mode board', 'node ./node_modules/nunchi/src/board/server.mjs --project .', 'nohup node "src/board/server.mjs" &',
    'env FOO=1 node src/board/server.mjs', 'node src/cli.mjs open --link-to-parent', 'node src/board/server.mjs --link-to-parent 3>&1',
    'node -e "import(\'./src/board/launch.mjs\').then(m => m.openBoard({ projectDir: \'.\', browser: false }))"',
    'node --input-type=module -e "const { openBoard } = await import(\'/abs/nunchi/src/board/launch.mjs\')"', 'bun src/board/server.mjs',
    'node -e "x({ linkToTerminal: true })"',
  ]) assert.ok(call(r, 'Bash', { command }), command);
  for (const command of ['cat src/board/server.mjs', 'git diff -- src/board/server.mjs', 'grep -n openBoard src/board/launch.mjs', 'node --test test/board-security.test.mjs', 'nunchi open --no-browser']) {
    assert.equal(call(r, 'Bash', { command }), null, command);
  }
});

test('deny hook: requests to a running board, its socket and its process are denied, by any loopback name; the app\'s own port is not', () => {
  const r = repo();
  const p = protectedOf(r.root, { env: r.env });
  assert.deepEqual(p.boards.map(b => b.port), [47123], 'the board record is found in the shared state');
  for (const command of ['curl http://127.0.0.1:47123/api/summary', 'curl -s localhost:47123', 'wget -qO- "http://[::1]:47123/"', 'nc 127.0.0.1 47123',
    'exec 3<>/dev/tcp/127.0.0.1/47123', `nc -U ${join(r.state, 'boards', '4242.sock')}`, 'cat /proc/4242/environ', 'cat /proc/self/environ', 'tr "\\0" " " < /proc/999/cmdline']) {
    assert.ok(call(r, 'Bash', { command }), command);
  }
  assert.ok(call(r, 'WebFetch', { url: 'http://127.0.0.1:47123/api/summary', prompt: 'x' }));
  assert.ok(call(r, 'WebFetch', { url: 'http://localhost:47123/', prompt: 'x' }));
  if (POSIX) assert.ok(call(r, 'Read', { file_path: '/proc/4242/cmdline' }), 'the board\'s process (no /proc on Windows)');
  assert.equal(call(r, 'WebFetch', { url: 'http://127.0.0.1:3000/', prompt: 'x' }), null, 'the app under test');
  assert.equal(call(r, 'WebFetch', { url: 'https://example.com/docs', prompt: 'x' }), null);
  assert.equal(call(r, 'Bash', { command: 'curl -s http://localhost:3000/' }), null);
});

test('deny hook: a link inside the project that points into the state is followed before deciding', { skip: !POSIX && 'symlinks need privileges on Windows' }, () => {
  const r = repo();
  symlinkSync(r.state, join(r.root, 'innocent'));
  assert.ok(call(r, 'Read', { file_path: join(r.root, 'innocent', 'ledger.json') }));
  assert.ok(call(r, 'Write', { file_path: join(r.root, 'innocent', 'new.json'), content: '{}' }), 'a file that does not exist yet, under a linked folder');
  assert.equal(call(r, 'Read', { file_path: join(r.root, 'src', 'app.tsx') }), null);
});

test('deny hook: the app\'s code, the run evidence and nunchi\'s outputs stay open to the AI', () => {
  const r = repo();
  for (const [tool, input] of [
    ['Read', { file_path: join(r.root, 'src', 'page.tsx') }], ['Write', { file_path: join(r.root, 'src', 'page.tsx'), content: 'x' }],
    ['Edit', { file_path: join(r.root, 'app', 'layout.tsx'), old_string: 'a', new_string: 'b' }],
    ['Read', { file_path: join(r.root, '.nunchi', 'runs', '0001', 'home.guest.normal.d', 'controls.json') }],
    ['Read', { file_path: join(r.root, '.nunchi', 'runs', '0001', 'verify-packets.json') }],
    ['Read', { file_path: join(r.root, '.nunchi', 'runs', '0001', 'canary-score.json') }],
    ['Read', { file_path: join(r.root, '.nunchi', 'samples.json') }], ['Write', { file_path: join(r.root, '.nunchi', 'samples.json'), content: '{}' }],
    ['Glob', { pattern: 'src/**/*.tsx', path: r.root }], ['Grep', { pattern: 'Delete', path: join(r.root, 'src') }],
    ['Read', { file_path: join(r.root, '.gitignore') }], ['Read', { file_path: join(r.root, '.git', 'config') }],
  ]) assert.equal(call(r, tool, input), null, `${tool} ${JSON.stringify(input)}`);
  assert.ok(keyBases({ XDG_STATE_HOME: '/x/state' }).includes(join('/x/state', 'nunchi')));
});

test('deny hook: the script answers exit 2 with the reason on stderr to deny, exit 0 to allow, and lets unreadable input through', () => {
  const r = repo();
  const run = input => spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: r.env, cwd: r.root, timeout: 20000 });
  const deny = run({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(r.state, 'ledger.json') }, cwd: r.root });
  assert.equal(deny.status, 2);
  assert.match(deny.stderr, /^nunchi: denied — nunchi's shared state/);
  const allow = run({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(r.root, 'README.md') }, cwd: r.root });
  assert.deepEqual([allow.status, allow.stdout, allow.stderr], [0, '', '']);
  assert.equal(run('not json').status, 0);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'nunchi approve --all' }, cwd: r.root }).status, 2);
});

test('deny hook: hooks/hooks.json runs the script on every tool that reads, writes, runs or fetches', () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const entry = hooks.hooks.PreToolUse[0];
  for (const tool of ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Grep', 'Glob', 'WebFetch']) assert.ok(new RegExp(`^(${entry.matcher})$`).test(tool), tool);
  assert.equal(entry.hooks[0].type, 'command');
  assert.match(entry.hooks[0].command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/src\/deny-hook\.mjs"$/);
  assert.ok(existsSync(join(ROOT, 'src', 'deny-hook.mjs')));
  // a pure data hook: nothing in it opens a socket or fetches
  const src = readFileSync(HOOK, 'utf8');
  for (const bad of ['node:http', 'node:https', 'node:net', 'fetch(', 'node:dgram', 'writeFile']) assert.ok(!src.includes(bad), bad);
});
