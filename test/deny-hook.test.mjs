// The plugin's PreToolUse deny hook (design 0.1-c §1, spec §5.1 M2 notes): denied and allowed tool calls, on a
// synthetic git repository with a nunchi state, answer keys and a running board record. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judge, keyBases, protectedOf, answer, plausibleGit, MAX_INPUT, isProc } from '../src/deny-hook.mjs';
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
  const xdg = tmp('nunchi-hook-xdg-');                // outside the repository, as a real state folder is
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
    // review B6: multiplexers and detachers, pty modules in other spellings, nunchi by package version
    'tmux new-session -d "nunchi decide abc keep --reason intended"', 'tmux send-keys -t s "nunchi decide abc keep --reason intended" Enter',
    'screen -dm nunchi decide abc keep --reason intended', 'dtach -n /tmp/s nunchi decide abc keep --reason intended', 'abduco -c s nunchi open --no-browser',
    'zellij run -- nunchi decide abc keep --reason intended', 'python3 -c "import os, pty; os.execvp(\'nunchi\', [\'nunchi\', \'decide\', \'abc\', \'keep\'])"',
    'python -c "from pty import spawn; spawn([\'node\', \'src/cli.mjs\', \'decide\', \'abc\', \'keep\'])"', 'python3 -c "import pexpect; pexpect.spawn(\'nunchi decide abc keep\')"',
    'node -e "require(\'node-pty\').spawn(\'nunchi\', [\'decide\', \'abc\', \'keep\'])"', 'npx nunchi@latest approve --all', 'npx -y nunchi@0.1.0 approve --all',
    'npx -y nunchi@0.1.0 open --label', 'tmux new -d npx nunchi@latest decide abc keep',
    // review B7: the key folder moved for one command (the keys would land where the hook does not look)
    'XDG_STATE_HOME=/tmp/k nunchi hunt --plan', 'HOME=/tmp/h node src/cli.mjs verify --plan', 'env LOCALAPPDATA=C:\\tmp nunchi hunt --plan',
    'export XDG_STATE_HOME=/tmp/k && nunchi hunt --plan', 'export XDG_STATE_HOME=/tmp/k', 'USERPROFILE=/tmp/u npx nunchi@latest hunt --plan', '$env:LOCALAPPDATA = "C:\\tmp"',
  ]) assert.ok(call(r, 'Bash', { command }), command);
  for (const command of [
    'node "${CLAUDE_SKILL_DIR}/../../src/cli.mjs" findings --json', 'node src/cli.mjs decide abc fix', 'node src/cli.mjs decide abc not-a-problem --from-chat',
    'node src/cli.mjs open', 'nunchi open --no-browser', 'nunchi open --stop', 'node src/cli.mjs hunt --plan', 'node src/cli.mjs capture --url http://127.0.0.1:3000',
    'npm run build && npm test', 'cat .nunchi/runs/0001/hunt-plan.json', 'ls .nunchi/runs/0001/home.guest.normal.d', 'git log --oneline',
    'curl -s http://127.0.0.1:3000/api/health', 'echo "a script to approve"',
    'npx nunchi@latest findings --json', 'npx -y nunchi@0.1.0 capture --url http://127.0.0.1:3000', 'tmux ls', 'nunchi capture --url http://127.0.0.1:3000 --screens home',
    'HOME=/tmp/h npm test', 'NUNCHI_BROWSER=/opt/chrome nunchi capture --url http://127.0.0.1:3000',
  ]) assert.equal(call(r, 'Bash', { command }), null, command);
});

test('deny hook: the bypasses of review B4 — recursive searches, globs, cd, quotes, find -exec, xargs, inline code, Grep/Glob bases, process lists', () => {
  const r = repo();
  writeFileSync(join(r.root, '.nunchi', 'runs', '0001', 'canaries.json'), '{}');
  writeFileSync(join(r.root, '.nunchi', 'runs', '0001', 'hunt-plan.json'), '{}');
  mkdirSync(join(r.root, 'src'), { recursive: true });
  for (const command of [
    // recursive searches over the project root that do not leave out .git and .nunchi
    'grep -rn approved .', 'grep -R "fix" ', 'grep -rl keep', 'grep --recursive -n x .', 'egrep -r x .', 'grep -rn x . --exclude-dir=.nunchi', 'grep -rn x .nunchi/runs',
    'rg --hidden approved', 'rg -uu approved .', 'rg -. x', 'rg x .git', 'rg x .nunchi', 'rg --hidden x -g "!.git"', 'rg --hidden -l x | xargs cat',
    // canaries.json through globs, *.json, braces
    'cat .nunchi/runs/0001/*.json', 'cat .nunchi/runs/*/canar*', 'jq . .nunchi/runs/0001/{hunt-plan,canaries}.json', 'head .nunchi/runs/000?/c*',
    'cat .git/nunch?/root/state/ledger.json', 'cat .git/*/root/state/approved.json', 'ls .git/nunchi*',
    // cd, quote concatenation, escapes, subshells
    'cd .git && cat nunchi/root/state/ledger.json', '(cd .nunchi && cat state/approved.json)', 'cd .nunchi/runs/0001; jq . canaries.json',
    'cat .nu"nchi"/state/ledger.json', "cat '.git'/'nunchi'/root/state/ledger.json", 'cat .nunchi/st\\ate/ledger.json', 'cat $(echo .nunchi/runs/0001/canaries.json)',
    // find -exec, find | xargs
    'find . -name "*.json" -exec cat {} +', 'find . -type f -exec grep -l keep {} \\;', 'find .git -exec cat {} \\;', 'find . -name "*.json" | xargs cat', 'find . -not -path ./.git -name "*.json" -exec cat {} +',
    // inline code
    'node -e "require(\'fs\').readFileSync(\'.git/nunchi/root/state/ledger.json\', \'utf8\')"', 'node -e "fs.readdirSync(path.join(\'.git\', \'nunchi\'))"',
    'python3 -c "print(open(\'.nunchi/runs/0001/\' + \'canaries.json\').read())"', 'bash -c "cat .nunchi/state/ledger.json"', 'sh -c \'cd .git && cat nunchi/root/state/approved.json\'',
    // other processes' command lines
    'ps aux', 'ps -ef', 'ps ax', 'ps -eo pid,args', 'ps -o command -p 1', 'pgrep -a chrome', 'pgrep -fl chrome', 'cat /proc/*/cmdline', 'for f in /proc/[0-9]*/cmdline; do cat $f; done', 'cd /proc && cat */cmdline',
  ]) assert.ok(call(r, 'Bash', { command }), command);
  for (const command of [
    'grep -rn useState src', 'grep -rn x . --exclude-dir=.git --exclude-dir=.nunchi', 'grep -rn x . --exclude-dir={.git,.nunchi}', 'grep -rn x . --include="*.tsx"', 'grep -n x README.md',
    'rg useState', 'rg -n "TODO" src', 'rg --hidden x -g "!.git" -g "!.nunchi"', 'rg -t ts x', 'rg --files', 'rg --hidden --files',
    'cat .nunchi/runs/0001/hunt-plan.json', 'ls .nunchi/runs/0001/', 'cat src/*.tsx', 'ls -la src/', 'cd src && ls',
    'find . -name "*.tsx" -exec grep -l useState {} +', 'find src -type f -exec cat {} +', 'find . -name "*.json"', 'find . -path ./.git -prune -o -path ./.nunchi -prune -o -name "*.json" -exec cat {} +',
    'node -e "console.log(1 + 1)"', 'python3 -c "print(2)"', 'bash -c "npm test"', 'ps', 'ps -e', 'ps -p 123 -o pid,comm', 'pgrep node', 'cat README.md 2>&1', 'npm test 2>/dev/null',
  ]) assert.equal(call(r, 'Bash', { command }), null, command);
  for (const [tool, input] of [['Grep', { pattern: 'x', path: join(r.root, '.git') }], ['Grep', { pattern: 'x', path: '.nunchi/runs' }], ['Grep', { pattern: 'x', path: join(r.root, '.nunchi') }],
    ['Glob', { pattern: '.git/**/*.json' }], ['Glob', { pattern: '**/*', path: join(r.root, '.nunchi', 'runs', '0001') }], ['Grep', { pattern: 'x', path: '/proc' }]]) assert.ok(call(r, tool, input), `${tool} ${JSON.stringify(input)}`);
  for (const [tool, input] of [['Grep', { pattern: 'x', path: join(r.root, 'src') }], ['Grep', { pattern: 'keep', path: join(r.root, '.nunchi', 'decisions') }], ['Glob', { pattern: 'src/**/*.tsx' }]]) assert.equal(call(r, tool, input), null, `${tool} ${JSON.stringify(input)}`);
});

test('deny hook: /proc as Windows resolves it (onto the current drive) is still /proc, where Git Bash has command lines', () => {
  for (const p of ['/proc', '/proc/123/cmdline', 'D:\\proc\\123\\cmdline', 'd:/proc/self/environ', 'C:\\proc']) assert.ok(isProc(p), p);
  assert.ok(isProc('D:\\proc\\4242\\fd\\3', '4242'), 'the board\'s own process, by pid');
  for (const p of ['/procfs/x', 'D:\\projects\\app', '/home/me/proc/1/cmdline', 'D:\\a\\proc']) assert.equal(isProc(p), false, p);
});

test('deny hook: the board\'s script is never run directly and its link handover is never asked for; reading its source is fine', () => {
  const r = repo();
  for (const command of [
    'node src/board/server.mjs --project . --mode board', 'node ./node_modules/nunchi/src/board/server.mjs --project .', 'nohup node "src/board/server.mjs" &',
    'env FOO=1 node src/board/server.mjs', 'node src/cli.mjs open --link-to-parent', 'node src/board/server.mjs --link-to-parent 3>&1',
    'node -e "import(\'./src/board/launch.mjs\').then(m => m.openBoard({ projectDir: \'.\', browser: false }))"',
    'node --input-type=module -e "const { openBoard } = await import(\'/abs/nunchi/src/board/launch.mjs\')"', 'bun src/board/server.mjs',
    'node -e "x({ linkToTerminal: true })"',
    // round 2: a renamed copy, the flag split by quotes; the script's name split by quotes
    'cp -r src /tmp/copy && mv /tmp/copy/board/server.mjs /tmp/copy/board/s.mjs && node /tmp/copy/board/s.mjs --project . --link-to-p""arent 3>&1',
    "node /tmp/copy/board/s.mjs --link-to-'parent'", 'node src/board/serv""er.mjs --project .', "node src/board/'launch.mjs'",
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

test('deny hook: the script answers exit 2 with the reason on stderr to deny, exit 0 to allow, and fails closed: input it cannot read and an error while judging deny', () => {
  const r = repo();
  const run = input => spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: r.env, cwd: r.root, timeout: 20000 });
  const deny = run({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(r.state, 'ledger.json') }, cwd: r.root });
  assert.equal(deny.status, 2);
  assert.match(deny.stderr, /^nunchi: denied — nunchi's shared state/);
  const allow = run({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(r.root, 'README.md') }, cwd: r.root });
  assert.deepEqual([allow.status, allow.stdout, allow.stderr], [0, '', '']);
  assert.equal(run('not json').status, 2, 'not JSON: denied');
  const big = run(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'x'.repeat(MAX_INPUT + 10) } }));
  assert.equal(big.status, 2, 'over 4 MB: denied');
  assert.match(big.stderr, /over 4 MB/);
  const broken = answer(JSON.stringify({ tool_name: 'Read' }), { judgeFn: () => { throw new Error('boom'); } });
  assert.deepEqual([broken.status, /could not judge this call \(boom\)/.test(broken.stderr)], [2, true], 'an error while judging: denied');
  // git is asked only where a .git can be: none here, a folder, a worktree's file, a folder below one
  const plain = tmp('nunchi-hook-plain-');
  assert.equal(plausibleGit(plain), false);
  assert.equal(protectedOf(plain, { env: r.env }).common, null);
  assert.equal(plausibleGit(r.root), true);
  assert.equal(plausibleGit(join(r.root, '.nunchi', 'runs')), true);
  writeFileSync(join(plain, '.git'), 'gitdir: /elsewhere\n');
  assert.equal(plausibleGit(plain), true, 'a worktree');
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'nunchi approve --all' }, cwd: r.root }).status, 2);
});

test('CI validates the plugin manifests (claude plugin validate --strict, the CLI pinned)', () => {
  // line ends as git checks the file out (CRLF on Windows)
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['validate:plugin'], 'claude plugin validate --strict .');
  assert.match(ci, /\n {6}- run: npm run validate:plugin\n/, 'a step runs it');
  assert.match(ci, /npm install --global @anthropic-ai\/claude-code@\d+\.\d+\.\d+\n/, 'with an exact version of the CLI');
});

test('deny hook: hooks/hooks.json runs the script on every tool that reads, writes, runs or fetches', () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const entry = hooks.hooks.PreToolUse[0];
  for (const tool of ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Grep', 'Glob', 'WebFetch']) assert.ok(new RegExp(`^(${entry.matcher})$`).test(tool), tool);
  assert.equal(entry.hooks[0].type, 'command');
  assert.equal(entry.hooks[0].command, 'command -v node >/dev/null 2>&1 || exit 0; node "${CLAUDE_PLUGIN_ROOT}/src/deny-hook.mjs"');
  if (POSIX) {
    // run as Claude Code runs it (a POSIX shell; Git Bash on Windows): with node it judges, without node it allows (the
    // documented limit: no node, no hook)
    const r = repo();
    const sh = (PATH, input) => spawnSync('/bin/sh', ['-c', entry.hooks[0].command], { input: JSON.stringify(input), encoding: 'utf8', env: { PATH, CLAUDE_PLUGIN_ROOT: ROOT, HOME: r.env.HOME || '/' }, cwd: r.root, timeout: 20000 });
    const nodeDir = dirname(process.execPath);
    assert.equal(sh(`${nodeDir}:/usr/bin:/bin`, { tool_name: 'Read', tool_input: { file_path: join(r.state, 'ledger.json') }, cwd: r.root }).status, 2);
    assert.equal(sh(`${nodeDir}:/usr/bin:/bin`, { tool_name: 'Read', tool_input: { file_path: join(r.root, 'README.md') }, cwd: r.root }).status, 0);
    assert.equal(sh('/nonexistent', { tool_name: 'Read', tool_input: { file_path: join(r.state, 'ledger.json') }, cwd: r.root }).status, 0, 'no node: the hook cannot run, and says nothing');
  }
  assert.ok(existsSync(join(ROOT, 'src', 'deny-hook.mjs')));
  // a pure data hook: nothing in it opens a socket or fetches
  const src = readFileSync(HOOK, 'utf8');
  for (const bad of ['node:http', 'node:https', 'node:net', 'fetch(', 'node:dgram', 'writeFile']) assert.ok(!src.includes(bad), bad);
});
