// `nunchi open` (design 0.1-c §3.1): starts the board as a detached process and returns at once, so an agent's command
// never blocks; a second `nunchi open` finds the running board through `state/boards/<pid>.json` (its port and
// control socket, never its token) and asks it, over that socket, to open the browser with a fresh one-time link.
// `--stop` stops this project's boards. The link is printed only when stdin and stdout are the person's own terminal
// and no browser is opened (`--no-browser`); otherwise the board opens the browser itself and nothing secret is printed.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { readdirSync, readFileSync, unlinkSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardsDir } from './server.mjs';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };

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
  stream.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(t); try { res(JSON.parse(buf.slice(0, i))); } catch { rej(new Error('the board answered something else')); } } });
  stream.on('end', () => { clearTimeout(t); rej(new Error('the board stopped while starting')); });
});

// → { port, reused, link? }
export async function openBoard({ projectDir, stateDir, mode = 'board', labeller = null, browser = true, linkToTerminal = false, port = 0, idleMs = null }) {
  const live = (await boardsOf(stateDir, projectDir)).filter(b => b.mode === mode && (mode !== 'label' || b.labeller === labeller));
  if (live.length) {
    const b = live[0];
    if (browser) await ask(b.socket, 'open');
    return { port: b.port, reused: true };
  }
  const args = [SERVER, '--project', resolve(projectDir), '--mode', mode, ...(port ? ['--port', String(port)] : []), ...(browser ? ['--open'] : []),
    ...(!browser && linkToTerminal ? ['--link-to-parent'] : []), ...(labeller ? ['--labeller', labeller] : []), ...(idleMs ? ['--idle-ms', String(idleMs)] : [])];
  const child = spawn(process.execPath, args, { cwd: resolve(projectDir), detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let line;
  try { line = await firstLine(child.stdout, 20000); }
  finally { child.stdout.destroy(); child.unref(); }
  if (line.error) throw Object.assign(new Error(line.error), { code: 'BOARD_FAILED' });
  return { port: line.port, reused: false, ...(line.link ? { link: line.link } : {}) };
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
