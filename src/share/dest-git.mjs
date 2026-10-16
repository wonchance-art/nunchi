// (B) a private GitHub repository the person owns (spec §7.6). nunchi keeps its own clone in the state folder (the deny
// hook keeps the agent out of it), commits the pack under runs/<run>/ on the branch `nunchi/<app>` and pushes with the
// person's own git login (their credential helper or ssh agent): nunchi never reads a token. Never a force, a reset of
// anything but its own clone, or a push to the app's own repository (which may be public; an orphan branch there is
// fetched by every clone).
//
// Before every push nunchi asks the repository, anonymously, whether it answers: `git ls-remote` with no config of the
// person's (no credential helper, no `insteadOf` that would turn it into an ssh URL with their key), no prompt. If it
// answers without a login, it is public, and nothing is pushed. A repository that does not answer is private or missing
// (or the network is down); the push then tells which. It is one HTTPS request, at a send the person turned on.
//
// The check and the push name one repository: the person's git config may rewrite a URL (`url.<x>.insteadOf`,
// `pushInsteadOf`, a `pushurl`), and the push keeps their config. So once the remote is added, git is asked where its
// fetches and pushes really go (`git remote get-url [--push] --all`, with their config); every one must be the same
// GitHub repository the person set up (its https or ssh form), or nothing is fetched or pushed. The anonymous check
// asks that push URL's repository.
import { existsSync, writeFileSync, mkdirSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { gitRunner } from '../runs.mjs';
import { privateDir, refuseLink, setMode } from '../stable.mjs';
import { parseRepo, sameRepo } from './config.mjs';

export { parseRepo };
// The URL the anonymous check asks: the https form of the remote; a local or file remote as it is (a local path answers
// anyone on this machine: it is not private).
export function anonUrl(remote) {
  const p = parseRepo(remote);
  if (p) return p.anon;
  return remote;
}

// The person's config left out entirely, so nothing of theirs answers for them: no credential helper, no `insteadOf`,
// no askpass, no terminal prompt, no ssh agent.
export function anonEnv(env = process.env, emptyConfig) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^(GIT_|SSH_AUTH_SOCK$|SSH_ASKPASS$)/i.test(k)) out[k] = v;
  return { ...out, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never' };
}
// → true when the repository answers without a login (public)
export function answersAnonymously(remote, { dir, timeout = 20_000, run = execFileSync } = {}) {
  privateDir(dir);
  const empty = join(dir, 'no-config');
  if (!existsSync(empty)) { writeFileSync(empty, '', { mode: 0o600 }); setMode(empty, 0o600); }
  try {
    run('git', ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'protocol.ext.allow=never', 'ls-remote', '--heads', '--end-of-options', anonUrl(remote)],
      { cwd: tmpdir(), env: anonEnv(process.env, empty), timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
}

// The app's own GitHub repositories (every remote of the project's repository, as configured and as git rewrites it):
// sharing never pushes there (it may be public, and an orphan branch there reaches every clone).
// → Map(web in lower case → remote name)
export function appRepos(root) {
  const out = new Map();
  let git;
  try { git = gitRunner(root, { timeout: 15_000 }); git(['rev-parse', '--git-dir']); } catch { return out; }
  const add = (url, name) => { const p = parseRepo(url); if (p && !out.has(p.web.toLowerCase())) out.set(p.web.toLowerCase(), name); };
  let configured = [];
  try { configured = git(['config', '-z', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], { encoding: 'utf8' }).split('\0').filter(Boolean); } catch {}
  const names = new Set();
  for (const e of configured) {
    const i = e.indexOf('\n');
    const key = i < 0 ? e : e.slice(0, i), url = i < 0 ? '' : e.slice(i + 1);
    const name = /^remote\.(.+)\.(?:url|pushurl)$/s.exec(key)?.[1];
    if (name === undefined) continue;
    names.add(name);
    add(url, name);
  }
  for (const name of [...names].sort()) {
    for (const how of [['--all'], ['--push', '--all']]) {
      try { for (const u of git(['remote', 'get-url', ...how, name], { encoding: 'utf8' }).split('\n')) if (u.trim()) add(u.trim(), name); } catch {}
    }
  }
  return out;
}
// Where the clone's `origin` really fetches from and pushes to, with the person's config → { fetch: [urls], push: [urls] }
function realUrls(git) {
  const list = how => git(['remote', 'get-url', ...how, 'origin'], { encoding: 'utf8' }).split('\n').map(u => u.trim()).filter(Boolean);
  return { fetch: list(['--all']), push: list(['--push', '--all']) };
}

const firstLine = e => String(e?.stderr || e?.message || e).split('\n').map(l => l.trim()).filter(l => l && !/^hint:/.test(l))[0]?.slice(0, 200) || 'git failed';
// Commits the pack into nunchi's clone and pushes it. `check`: the anonymous check (answersAnonymously, or a test's),
// given the URL the push goes to. → { commit, pushed: true } or throws { code: 'PUBLIC' | 'REDIRECTED' (with `to`: the
// repositories it would reach instead, or null for an address that is not one) | 'GIT_FAILED', message }
export function sendToGit({ clone, remote, branch, run, app, files, check = r => answersAnonymously(r, { dir: dirname(clone) }) }) {
  privateDir(clone);
  refuseLink(clone);
  const git = gitRunner(clone, { timeout: 120_000 });
  if (!existsSync(join(clone, '.git'))) git(['init', '-q']);
  const fail = (e, what) => { throw Object.assign(new Error(`${what}: ${firstLine(e)}`), { code: 'GIT_FAILED' }); };
  try { git(['remote', 'remove', 'origin']); } catch {}
  git(['remote', 'add', 'origin', '--', remote]);
  // where git really fetches and pushes, the person's rewrites applied: the repository set up, or nothing goes
  const want = parseRepo(remote)?.web;
  let real;
  try { real = realUrls(git); } catch (e) { fail(e, 'could not read the remote'); }
  const elsewhere = [...real.fetch, ...real.push].filter(u => !sameRepo(parseRepo(u)?.web, want));
  if (!want || !real.push.length || elsewhere.length) {
    throw Object.assign(new Error('redirected'), { code: 'REDIRECTED', to: [...new Set(elsewhere.map(u => parseRepo(u)?.web ?? null))] });
  }
  // the branch as GitHub has it (the person's login), or none yet
  let heads;
  try { heads = git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { encoding: 'utf8' }).trim(); } catch (e) { fail(e, 'could not reach the repository'); }
  if (heads) {
    try { git(['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]); } catch (e) { fail(e, 'could not fetch the branch'); }
    git(['checkout', '-q', '-f', '-B', 'nunchi-share', `refs/remotes/origin/${branch}`]);
  } else {
    // a new branch: an empty tree of nunchi's own
    try { git(['checkout', '-q', '-f', '--orphan', 'nunchi-share-new']); } catch {}
    try { git(['rm', '-rq', '--cached', '--ignore-unmatch', '.']); } catch {}
    for (const n of readdirSync(clone)) if (n !== '.git') rmSync(join(clone, n), { recursive: true, force: true });
    try { git(['branch', '-D', 'nunchi-share']); } catch {}
    git(['checkout', '-q', '--orphan', 'nunchi-share']);
  }
  const base = join(clone, 'runs', run);
  rmSync(base, { recursive: true, force: true });
  for (const f of files) {
    const to = join(base, ...f.path.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    if (lstatSync(dirname(to)).isSymbolicLink()) throw Object.assign(new Error(`${dirname(to)} is a link`), { code: 'UNSAFE_PATH' });
    writeFileSync(to, f.data, { mode: 0o600 });
  }
  git(['add', '-A', '--', `runs/${run}`]);
  const changed = git(['status', '--porcelain', '--', `runs/${run}`], { encoding: 'utf8' }).trim();
  if (changed) git(['-c', 'user.name=nunchi share', '-c', 'user.email=share@nunchi.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', `nunchi share: run ${run} of ${app}`]);
  let commit;
  try { commit = git(['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim(); } catch (e) { fail(e, 'nothing to push'); }
  // right before the push: does the repository the push goes to answer without a login?
  for (const u of [...new Set(real.push)]) if (check(u)) throw Object.assign(new Error('public'), { code: 'PUBLIC' });
  try { git(['push', '-q', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`]); } catch (e) { fail(e, 'the push failed'); }
  return { commit, pushed: true, unchanged: !changed };
}
