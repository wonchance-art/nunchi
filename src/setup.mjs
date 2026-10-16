// One-time setup of the bundled engine (spec §10, H15): a plugin install from git has no node_modules.
// The pinned packages come from package-lock.json with `npm ci --ignore-scripts` (integrity-checked,
// no install scripts), and Chromium from the pinned playwright-core's own installer. Nothing is fetched
// from the npm registry by name at run time, and nothing runs at import.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Pinned dependencies present at the versions package.json asks for?
export function dependencyState(root = ENGINE_ROOT) {
  const want = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies || {};
  const out = {};
  for (const [name, version] of Object.entries(want).sort()) {
    const f = join(root, 'node_modules', name, 'package.json');
    if (!existsSync(f)) { out[name] = { want: version, have: null }; continue; }
    out[name] = { want: version, have: JSON.parse(readFileSync(f, 'utf8')).version };
  }
  return { ok: Object.values(out).every(d => d.have === d.want), packages: out };
}

// Where Chromium is (NUNCHI_BROWSER, or the browser playwright-core installed), or null.
export async function browserState(root = ENGINE_ROOT) {
  if (process.env.NUNCHI_BROWSER) return { ok: existsSync(process.env.NUNCHI_BROWSER), path: process.env.NUNCHI_BROWSER, from: 'NUNCHI_BROWSER' };
  const entry = join(root, 'node_modules', 'playwright-core', 'index.mjs');
  if (!existsSync(entry)) return { ok: false, path: null, from: null };
  const { chromium } = await import(pathToFileURL(entry).href);
  let path = null;
  try { path = chromium.executablePath(); } catch {}
  return { ok: !!path && existsSync(path), path, from: 'playwright-core' };
}

// How a person runs this engine in their own terminal: a plugin install puts no `nunchi` command on their PATH, so the
// skill and `setup` give the whole command (the commands only a person may run — login, approvals, guards — go there).
export const terminalCommand = (root = ENGINE_ROOT) => `node "${join(root, 'src', 'cli.mjs')}"`;

// What `setup` says when the Chromium download fails. The download is what failed (a network, a proxy, the disk):
// system libraries are another matter, and only Linux's (Chromium starts without them nowhere else).
export function downloadFailedWords(platform = process.platform, root = ENGINE_ROOT) {
  return 'nunchi setup: the Chromium download failed (see above: no network, a proxy that blocks it, or a full disk). ' +
    'Run `nunchi setup` again once that is fixed, or point NUNCHI_BROWSER at an installed Chrome or Chromium.' +
    (platform === 'linux' ? ` On Linux, if Chromium then cannot start for missing system libraries: node "${join(root, 'node_modules', 'playwright-core', 'cli.js')}" install --with-deps chromium (needs sudo).` : '');
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }).status;

export async function setup({ root = ENGINE_ROOT, check = false, browser = true, log = m => console.error(m) } = {}) {
  let deps = dependencyState(root);
  if (!deps.ok && !check) {
    log('nunchi setup: installing the pinned engine packages from package-lock.json (npm ci --ignore-scripts, no install scripts run)…');
    if (run(npm, ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], root) !== 0) log('nunchi setup: npm ci failed (see above).');
    deps = dependencyState(root);
  }
  let chrome = await browserState(root);
  if (deps.ok && !chrome.ok && browser && !check) {
    log('nunchi setup: downloading Chromium with the pinned playwright-core (about 170 MB, once)…');
    if (run(process.execPath, [join(root, 'node_modules', 'playwright-core', 'cli.js'), 'install', 'chromium'], root) !== 0) log(downloadFailedWords(process.platform, root));
    chrome = await browserState(root);
  }
  return { ready: deps.ok && (chrome.ok || !browser), dependencies: deps, browser: chrome, command: terminalCommand(root) };
}
