// `nunchi open` (design 0.1-c §3.1): starts the board as a detached process and returns at once, so an agent's command
// never blocks; a second `nunchi open` finds the running board through `state/boards/<pid>.json` (its port and
// control socket, never its token) and asks it, over that socket, to open the browser with a fresh one-time link.
// `--stop` stops this project's boards. The link is printed only when stdin and stdout are the person's own terminal
// and no browser is opened (`--no-browser`); the board hands it over a pipe of its own (fd 3), never its stdout.
// Otherwise the board opens the browser itself and nothing secret is printed.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { readdirSync, readFileSync, unlinkSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardsDir } from './server.mjs';
import { withLockAsync, privateDir } from '../stable.mjs';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));

// The detached server's environment, allow-listed: what git (PATH, the user's config), the answer keys
// (XDG_STATE_HOME, LOCALAPPDATA) and the browser opener need. Never NODE_* (NODE_OPTIONS can load code into it),
// LD_* / DYLD_*, BROWSER, GIT_* or anything else of the caller's.
const SERVER_ENV = /^(PATH|HOME|USER|LOGNAME|USERNAME|LANG|LANGUAGE|LC_[A-Z]+|TZ|TMPDIR|TEMP|TMP|XDG_STATE_HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR|XDG_CURRENT_DESKTOP|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|PATHEXT)$/i;
export function serverEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (SERVER_ENV.test(k) && typeof v === 'string') out[k] = v;
  return out;
}
// The real path as the file system has it: `.native` gives macOS's own case and Windows' long names, so one project
// typed two ways is one project (the JS realpath keeps the case it was given).
export const real = p => { try { return realpathSync.native(p); } catch { return resolve(p); } };

// One request over the control socket: → the parsed reply, or null (no answer within `ms`).
export function ask(socket, cmd, ms = 1500) {
  return new Promise(res => {
    let done = false, buf = '';
    const finish = v => { if (!done) { done = true; try { s.destroy(); } catch {} res(v); } };
    const s = connect(socket);
    s.setEncoding('utf8');
    s.setTimeout(ms, () => finish(null));
    s.on('error', () => finish(null));
    s.on('connect', () => s.write(JSON.stringify({ cmd }) + '\n'));
    s.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { finish(JSON.parse(buf.slice(0, i))); } catch { finish(null); } } });
    s.on('end', () => finish(null));
  });
}

// This project's board records; a record whose board does not answer is removed (a board that crashed).
export async function boardsOf(stateDir, projectDir) {
  const dir = boardsDir(stateDir), project = real(projectDir);
  let names = [];
  try { names = readdirSync(dir).filter(n => /^\d+\.json$/.test(n)).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const file = join(dir, n);
    let rec = null;
    try { if (lstatSync(file).isFile()) rec = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    if (!rec || typeof rec.socket !== 'string' || !Number.isInteger(rec.port)) continue;
    if (real(rec.project) !== project) continue;
    const pong = await ask(rec.socket, 'ping');
    if (pong?.ok && pong.port === rec.port && real(pong.project) === project) out.push({ ...rec, file });
    else { try { unlinkSync(file); } catch {} if (process.platform !== 'win32') { try { if (lstatSync(rec.socket).isSocket()) unlinkSync(rec.socket); } catch {} } }
  }
  return out;
}

const firstLine = (stream, ms) => new Promise((res, rej) => {
  let buf = '';
  const t = setTimeout(() => rej(new Error('the board did not start within 20 s')), ms);
  stream.setEncoding('utf8');
  stream.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(t); res(buf.slice(0, i)); } });
  stream.on('end', () => { clearTimeout(t); rej(new Error('the board stopped while starting')); });
});
const parse = s => { try { return JSON.parse(s); } catch { throw new Error('the board answered something else'); } };

// The detached server's working folder: the OS temp folder (this user's on Windows), outside any project.
export const serverCwd = () => tmpdir();

// → { port, reused, link?, portIgnored? }. Under a lock (`boards/launch.lock.d`): two `nunchi open` at once start one
// board, and the second reuses it. A running board keeps its port: a `port` asked for that differs is ignored, and
// said (`portIgnored`).
export async function openBoard(opts) {
  privateDir(boardsDir(opts.stateDir));                      // the board's socket folder: this user's only (0700)
  return withLockAsync(join(boardsDir(opts.stateDir), 'launch'), () => openUnlocked(opts), { timeoutMs: 30000 });
}
async function openUnlocked({ projectDir, stateDir, mode = 'board', labeller = null, browser = true, linkToTerminal = false, port = 0, idleMs = null }) {
  const live = (await boardsOf(stateDir, projectDir)).filter(b => b.mode === mode && (mode !== 'label' || b.labeller === labeller));
  if (live.length) {
    const b = live[0];
    const opened = browser ? !!(await ask(b.socket, 'open'))?.ok : null;
    return { port: b.port, reused: true, ...(browser ? { opened } : {}), ...(port && port !== b.port ? { portIgnored: port } : {}) };
  }
  const wantLink = !browser && linkToTerminal;
  const args = [SERVER, '--project', resolve(projectDir), '--mode', mode, ...(port ? ['--port', String(port)] : []), ...(browser ? ['--open'] : []),
    ...(wantLink ? ['--link-to-parent'] : []), ...(labeller ? ['--labeller', labeller] : []), ...(idleMs ? ['--idle-ms', String(idleMs)] : [])];
  // stdout carries the port only; the link, when this terminal is to print it, comes over a pipe of its own (fd 3)
  // its working folder is the temp folder (serverCwd), never the project or its state (which may be in the project's
  // .git or .nunchi): on Windows a process inside a folder keeps it from being removed or renamed (a worktree, a checkout)
  const child = spawn(process.execPath, args, { cwd: serverCwd(), detached: true, stdio: ['ignore', 'pipe', 'ignore', ...(wantLink ? ['pipe'] : [])], windowsHide: true, env: serverEnv() });
  let line, link = null;
  try {
    line = parse(await firstLine(child.stdout, 20000));
    if (wantLink && !line.error) link = await firstLine(child.stdio[3], 5000).catch(() => null);
  } finally { for (const s of child.stdio) s?.destroy(); child.unref(); }
  if (line.error) throw Object.assign(new Error(line.error), { code: 'BOARD_FAILED' });
  return { port: line.port, reused: false, ...(browser ? { opened: line.opened !== false } : {}), ...(link && /^http:\/\/127\.0\.0\.1:\d{1,5}\/#t=[0-9a-f]{64}$/.test(link) ? { link } : {}) };
}

// What `nunchi open` says after the board answered (`r` from openBoard): the next step that works from here. A running
// board never hands out a link (only one it starts does, to the person's own terminal), and no browser opener on this
// machine (`opened: false`: none of the fixed list, or it failed to start) leaves a person a link to open by hand only
// through a board started from their terminal.
export function openWords(r, { noBrowser = false, tty = false } = {}) {
  if (r.link) return `open this link in your browser; it works once, for 2 minutes:\n  ${r.link}`;
  const handLink = 'nunchi open --stop, then nunchi open --no-browser in your own terminal prints a link to open by hand';
  if (noBrowser) return r.reused && tty ? `no browser was opened, and a running board hands out no link: ${handLink}` : 'no browser was opened; to open it, run nunchi open in your own terminal';
  if (r.opened === false) return `no browser could be opened on this machine (no opener found): ${handLink}`;
  return r.reused ? 'a fresh one-time link was opened in the browser' : 'the browser shows it; it stops after 2 hours idle (nunchi open --stop stops it now)';
}

export async function stopBoards(stateDir, projectDir) {
  const live = await boardsOf(stateDir, projectDir);
  for (const b of live) await ask(b.socket, 'stop');
  // wait for each to go (its record is removed on exit)
  for (let i = 0; i < 40 && live.length; i++) {
    if ((await boardsOf(stateDir, projectDir)).length === 0) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return live.length;
}
