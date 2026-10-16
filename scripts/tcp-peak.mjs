#!/usr/bin/env node
// This machine's TCP sockets: how many, in which states, and how many local ports of its dynamic (ephemeral) range
// are in use. A Windows runner refused Chromium a connection to a board in the suite with net::ERR_NO_BUFFER_SPACE
// (WSAENOBUFS, PR #36, 2026-10-16 KST): Windows had no room for one more socket, which it says when no port of that
// range is free, or no memory for the socket. Measured on Linux (2026-10-16 KST), the whole suite opens 1,069 loopback
// connections, at most 191 at once. The board e2e helper (test/fixtures/board-browser.mjs) says this line when a wait
// fails, and CI runs the suite through this script, which samples the table while it runs:
//   node scripts/tcp-peak.mjs <command> [args…]
// → the command's exit code; at the end one line: the most ports in use at once, when, and the states then.
// Read from /proc on Linux; from netstat (and netsh, sysctl for the range) on Windows and macOS, by absolute path.
import { readFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { freemem, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const STATE = { '01': 'ESTABLISHED', '02': 'SYN_SENT', '03': 'SYN_RECV', '04': 'FIN_WAIT1', '05': 'FIN_WAIT2', '06': 'TIME_WAIT', '07': 'CLOSE', '08': 'CLOSE_WAIT', '09': 'LAST_ACK', '0A': 'LISTEN', '0B': 'CLOSING' };
// Windows' and macOS's names, as Linux's
const NAME = { LISTENING: 'LISTEN', FIN_WAIT_1: 'FIN_WAIT1', FIN_WAIT_2: 'FIN_WAIT2', SYN_RECEIVED: 'SYN_RECV', CLOSED: 'CLOSE' };
const portOf = s => { const m = /[.:](\d+)$/.exec(s); return m ? Number(m[1]) : null; };

// → [{ state, port }] (port: the local one) from /proc/net/tcp or tcp6
export function parseProc(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || !/^[0-9A-F]+:[0-9A-F]{4}$/i.test(f[1])) continue;
    out.push({ state: STATE[f[3].toUpperCase()] || f[3], port: parseInt(f[1].split(':')[1], 16) });
  }
  return out;
}
// from `netstat -an` (Windows: "  TCP    127.0.0.1:49673   127.0.0.1:49674   ESTABLISHED"; macOS:
// "tcp4  0  0  127.0.0.1.50123  127.0.0.1.8080  TIME_WAIT"; UDP and the headers are left out)
export function parseNetstat(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (/^TCP$/i.test(f[0]) && f.length >= 4) out.push({ state: NAME[f[3].toUpperCase()] || f[3].toUpperCase(), port: portOf(f[1]) });
    else if (/^tcp(4|6|46)?$/.test(f[0]) && f.length >= 6) out.push({ state: NAME[f[5].toUpperCase()] || f[5].toUpperCase(), port: portOf(f[3]) });
  }
  return out;
}
// `netsh int ipv4 show dynamicport tcp` → { first, last }
export function parseNetshRange(text) {
  const n = [...String(text).matchAll(/:\s*(\d+)/g)].map(m => Number(m[1]));
  return n.length >= 2 && n[1] > 0 ? { first: n[0], last: n[0] + n[1] - 1 } : null;
}
// `netsh int ipv4 show excludedportrange protocol=tcp` → [[start, end]]
export const parseNetshExcluded = text => [...String(text).matchAll(/^\s*(\d+)\s+(\d+)\b/gm)].map(m => [Number(m[1]), Number(m[2])]);

const run = (file, args) => new Promise(res => {
  execFile(file, args, { timeout: 10e3, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (e, out) => res(e ? { error: e } : { out: String(out) }));
});
const SYSTEM32 = () => `${/^[A-Za-z]:\\[^"%&|<>^\n]*$/.test(process.env.SystemRoot || '') ? process.env.SystemRoot.replace(/\\+$/, '') : 'C:\\Windows'}\\System32`;

// The range, read once (it does not change while a suite runs). → { first, last, excluded } or null
const rangeMemo = new Map();
export async function dynamicRange(platform = process.platform) {
  if (rangeMemo.has(platform)) return rangeMemo.get(platform);
  let r = null;
  if (platform === 'linux') {
    try { const [first, last] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number); if (first && last) r = { first, last, excluded: 0 }; } catch {}
  } else if (platform === 'win32') {
    const [d, x] = await Promise.all([run(`${SYSTEM32()}\\netsh.exe`, ['int', 'ipv4', 'show', 'dynamicport', 'tcp']), run(`${SYSTEM32()}\\netsh.exe`, ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'])]);
    const range = d.out ? parseNetshRange(d.out) : null;
    if (range) {
      let excluded = 0;
      for (const [a, b] of x.out ? parseNetshExcluded(x.out) : []) excluded += Math.max(0, Math.min(b, range.last) - Math.max(a, range.first) + 1);
      r = { ...range, excluded };
    }
  } else if (platform === 'darwin') {
    const s = await run('/usr/sbin/sysctl', ['-n', 'net.inet.ip.portrange.first', 'net.inet.ip.portrange.last']);
    const [first, last] = (s.out || '').trim().split(/\s+/).map(Number);
    if (first && last) r = { first, last, excluded: 0 };
  }
  rangeMemo.set(platform, r);
  return r;
}

// The sockets now. → { sockets: [{ state, port }] } or { error }
export async function tcpNow(platform = process.platform) {
  if (platform === 'linux') {
    let text = '';
    try { text = readFileSync('/proc/net/tcp', 'utf8'); } catch (e) { return { error: e.code || e.message }; }
    try { text += readFileSync('/proc/net/tcp6', 'utf8'); } catch {}
    return { sockets: parseProc(text) };
  }
  if (platform !== 'win32' && platform !== 'darwin') return { error: `no reader of the TCP table on ${platform}` };
  const r = platform === 'win32' ? await run(`${SYSTEM32()}\\NETSTAT.EXE`, ['-an']) : await run('/usr/sbin/netstat', ['-an', '-p', 'tcp']);
  return r.error ? { error: r.error.code || String(r.error.message).split('\n')[0] } : { sockets: parseNetstat(r.out) };
}

// → { total, states: { STATE: n } (most first), inRange: distinct local ports of the range in use }
export function tally(sockets, range) {
  const states = {};
  const ports = new Set();
  for (const s of sockets) {
    states[s.state] = (states[s.state] || 0) + 1;
    if (range && s.port >= range.first && s.port <= range.last) ports.add(s.port);
  }
  const sorted = Object.fromEntries(Object.entries(states).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  return { total: sockets.length, states: sorted, inRange: range ? ports.size : null };
}
const statesWords = states => Object.entries(states).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
export const rangeWords = range => (range ? `${range.first}–${range.last} (${range.last - range.first + 1} ports${range.excluded ? `, ${range.excluded} of them excluded` : ''})` : 'not known');
const gb = n => (n / 1024 ** 3).toFixed(1);

// One line: the machine's TCP sockets now, its dynamic range, and memory (WSAENOBUFS is also said when the system runs
// out of memory for sockets). Never throws.
export async function tcpLine(platform = process.platform) {
  try {
    const [now, range] = await Promise.all([tcpNow(platform), dynamicRange(platform)]);
    const mem = `free memory ${gb(freemem())} of ${gb(totalmem())} GB`;
    if (now.error) return `the machine's TCP sockets could not be read (${now.error}); ${mem}`;
    const t = tally(now.sockets, range);
    return `the machine's TCP sockets: ${t.total} (${statesWords(t.states)}); local ports of the dynamic range in use: ${t.inRange ?? '?'} of ${rangeWords(range)}; ${mem}`;
  } catch (e) { return `the machine's TCP sockets could not be read (${String(e?.message).split('\n')[0]})`; }
}

// `node scripts/tcp-peak.mjs <command…>`: the command, with the table sampled every `NUNCHI_TCP_SAMPLE_MS` (2 s) while
// it runs; one line at the end. The sampling never changes the command's exit code.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) { process.stderr.write('usage: node scripts/tcp-peak.mjs <command> [args…]\n'); process.exit(2); }
  const every = Math.max(200, Number(process.env.NUNCHI_TCP_SAMPLE_MS) || 2000);
  const t0 = Date.now();
  let peak = null, mostTimeWait = 0, samples = 0, failed = null, busy = false;
  const range = await dynamicRange();
  const sample = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = await tcpNow();
      if (now.error) { failed ??= now.error; return; }
      samples++;
      const t = tally(now.sockets, range);
      mostTimeWait = Math.max(mostTimeWait, t.states.TIME_WAIT || 0);
      const key = t.inRange ?? t.total;
      if (!peak || key > (peak.inRange ?? peak.total)) peak = { ...t, at: Math.round((Date.now() - t0) / 1000) };
    } finally { busy = false; }
  };
  await sample();
  const timer = setInterval(sample, every);
  // `node` is this node; Windows: npm is npm.cmd, which only a shell starts (a path is started as it is)
  const file = cmd === 'node' ? process.execPath : cmd;
  const child = spawn(file, args, { stdio: 'inherit', shell: process.platform === 'win32' && !/[\\/]/.test(file) });
  const code = await new Promise(res => { child.once('error', () => res(2)); child.once('exit', (c, sig) => res(c ?? (sig ? 1 : 0))); });
  clearInterval(timer);
  await sample();
  const what = peak ? `the most at once: ${peak.inRange !== null ? `${peak.inRange} local ports of the dynamic range ${rangeWords(range)} in use` : `${peak.total} sockets`} at +${peak.at} s (${peak.total} sockets: ${statesWords(peak.states)}); the most in TIME_WAIT: ${mostTimeWait}`
    : 'no sample';
  process.stdout.write(`tcp-peak: ${what}; ${samples} samples every ${every / 1000} s${failed ? `; a sample failed: ${failed}` : ''}; free memory now ${gb(freemem())} of ${gb(totalmem())} GB\n`);
  process.exitCode = code;
}
