#!/usr/bin/env node
// A fake GitHub for `nunchi share` (B) tests, reached the way the person's git reaches GitHub over ssh: their git
// config's `core.sshCommand` runs this script (with `ssh.variant = simple`, git passes the host and the command:
// `git@github.com "git-receive-pack 'mina/results.git'"`). It serves the bare repositories under its first argument,
// and only for the host github.com, so a remote that git rewrote anywhere else is never answered. Nothing here touches
// the network. Synthetic repositories only.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, appendFileSync } from 'node:fs';

const [root, ...rest] = process.argv.slice(2);
// `node --test` runs every module under test/: without git's arguments there is nothing to serve
if (!root) process.exit(0);
const host = rest.at(-2), command = rest.at(-1);
const m = /^(git-upload-pack|git-receive-pack) '([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)'$/.exec(command || '');
const repo = m ? join(root, ...m[2].split('/')) : null;
try { appendFileSync(join(root, 'calls.log'), `${JSON.stringify(rest)}\n`); } catch {}
if (host !== 'git@github.com' || !repo || !existsSync(repo)) {
  process.stderr.write(`ERROR: Repository not found (fake GitHub: ${JSON.stringify(rest)}).\n`);
  process.exit(128);
}
const r = spawnSync('git', [m[1].slice(4), repo], { stdio: 'inherit' });
process.exit(r.status ?? 1);
