// scripts/tcp-peak.mjs: this machine's TCP sockets as the board e2e helper reports them when a wait fails, and the
// sampler CI runs the suite through (a Windows runner refused Chromium a connection with WSAENOBUFS, PR #36). The
// readers of each platform's table, from text as each platform prints it; the sampler passes the command's exit code
// and says the most there were at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseProc, parseNetstat, parseNetshRange, parseNetshExcluded, tally, tcpLine } from '../scripts/tcp-peak.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/tcp-peak.mjs', import.meta.url));
const CI = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));

test('the TCP table of each platform: Linux /proc, Windows and macOS netstat; states by one name, local ports', () => {
  const proc = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:C350 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5133387 1 0 100 0 0 10 0',
    '   1: 0100007F:C351 0100007F:C350 06 00000000:00000000 03:00000ab1 00000000     0        0 0 3 0',
    '   2: 0100007F:C350 0100007F:C352 01 00000000:00000000 00:00000000 00000000     0        0 5133388 1 0 20 4 30 10 -1',
  ].join('\n');
  assert.deepEqual(parseProc(proc), [{ state: 'LISTEN', port: 50000 }, { state: 'TIME_WAIT', port: 50001 }, { state: 'ESTABLISHED', port: 50000 }]);
  const win = [
    '', 'Active Connections', '', '  Proto  Local Address          Foreign Address        State',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING',
    '  TCP    127.0.0.1:49673        127.0.0.1:49674        ESTABLISHED',
    '  TCP    127.0.0.1:49674        127.0.0.1:49673        TIME_WAIT',
    '  TCP    [::1]:50100            [::1]:50101            FIN_WAIT_2',
    '  UDP    0.0.0.0:123            *:*                    ',
  ].join('\r\n');
  assert.deepEqual(parseNetstat(win), [{ state: 'LISTEN', port: 135 }, { state: 'ESTABLISHED', port: 49673 }, { state: 'TIME_WAIT', port: 49674 }, { state: 'FIN_WAIT2', port: 50100 }]);
  const mac = [
    'Active Internet connections (including servers)',
    'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)',
    'tcp4       0      0  127.0.0.1.50123        127.0.0.1.8080         TIME_WAIT',
    'tcp6       0      0  ::1.8080               ::1.50124              CLOSE_WAIT',
    'tcp46      0      0  *.5000                 *.*                    LISTEN',
  ].join('\n');
  assert.deepEqual(parseNetstat(mac), [{ state: 'TIME_WAIT', port: 50123 }, { state: 'CLOSE_WAIT', port: 8080 }, { state: 'LISTEN', port: 5000 }]);
});

test('the dynamic range and the ports of it in use: netsh\'s range and exclusions; a port counted once', () => {
  assert.deepEqual(parseNetshRange('\r\nProtocol tcp Dynamic Port Range\r\n---------------------------------\r\nStart Port      : 49152\r\nNumber of Ports : 16384\r\n'), { first: 49152, last: 65535 });
  assert.equal(parseNetshRange('nothing here'), null);
  assert.deepEqual(parseNetshExcluded('\r\nProtocol tcp Port Exclusion Ranges\r\n\r\nStart Port    End Port\r\n----------    --------\r\n      5357        5357\r\n     50000       50059     *\r\n\r\n* - Administered port exclusions.\r\n'), [[5357, 5357], [50000, 50059]]);
  const t = tally([{ state: 'TIME_WAIT', port: 50001 }, { state: 'ESTABLISHED', port: 50000 }, { state: 'LISTEN', port: 50000 }, { state: 'TIME_WAIT', port: 50002 }, { state: 'LISTEN', port: 135 }], { first: 49152, last: 65535 });
  assert.deepEqual(t, { total: 5, states: { LISTEN: 2, TIME_WAIT: 2, ESTABLISHED: 1 }, inRange: 3 });
  assert.equal(tally([], null).inRange, null);
});

test('this machine\'s line: sockets, states, the range and memory, never a throw', async () => {
  const line = await tcpLine();
  assert.match(line, /^the machine's TCP sockets(: \d+ \(.+\); local ports of the dynamic range in use: (\d+|\?) of .+| could not be read \(.+\)); free memory [\d.]+ of [\d.]+ GB$/, line);
  // read on each platform CI runs on (/proc; netstat and netsh on Windows; netstat and sysctl on macOS)
  if (['linux', 'win32', 'darwin'].includes(process.platform)) assert.match(line, /^the machine's TCP sockets: \d+ \(.+\); local ports of the dynamic range in use: \d+ of \d+–\d+ \(\d+ ports/, line);
  assert.match(await tcpLine('plan9'), /^the machine's TCP sockets could not be read \(no reader of the TCP table on plan9\)/, 'an unknown platform says so');
});

test('the sampler runs the command, passes its exit code and says the most sockets at once', () => {
  const r = spawnSync(process.execPath, [SCRIPT, process.execPath, '-e', 'setTimeout(() => process.exit(3), 600)'], { encoding: 'utf8', env: { ...process.env, NUNCHI_TCP_SAMPLE_MS: '200' } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /^tcp-peak: the most at once: .+ at \+\d+ s \(\d+ sockets: .+\); the most in TIME_WAIT: \d+; \d+ samples every 0\.2 s; free memory now [\d.]+ of [\d.]+ GB\n$/, r.stdout);
  const none = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /^usage:/);
});

test('CI runs the suite through the sampler, around the temporary-folder check', () => {
  // line ends as git checks the file out (CRLF on Windows)
  const ci = readFileSync(CI, 'utf8').replace(/\r\n/g, '\n');
  assert.match(ci, /\n {6}- run: node scripts\/tcp-peak\.mjs node scripts\/tmp-leftovers\.mjs npm test\n/);
});
