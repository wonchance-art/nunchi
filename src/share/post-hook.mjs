#!/usr/bin/env node
// The plugin's PostToolUse hook on Artifact (spec §7.6): after a publish of the pack `nunchi share` sealed, the link the
// first publish made is pinned, what was published is recorded, and an artifact the result no longer calls private
// stops sharing (share/hook.mjs postArtifact). It writes nunchi's own state only, never the network. A call that is not
// a sealed pack's publish changes nothing. It never blocks: the publish has happened.
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { protectedOf, stateDirsOf } from '../deny-hook.mjs';
import { postArtifact } from './hook.mjs';

export const MAX_INPUT = 4 * 1024 * 1024;
export function answerPost(raw, { env = process.env } = {}) {
  let input;
  try { if (typeof raw !== 'string' || raw.length > MAX_INPUT) return { status: 0, stdout: '' }; input = JSON.parse(raw); } catch { return { status: 0, stdout: '' }; }
  if (String(input?.tool_name || '') !== 'Artifact') return { status: 0, stdout: '' };
  try {
    const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : process.cwd();
    const prot = protectedOf(cwd, { env });
    const r = postArtifact(input, { stateDirs: stateDirsOf(cwd, prot.common) });
    return { status: 0, stdout: r ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: r.context } }) : '' };
  } catch (e) {
    return { status: 0, stdout: '', stderr: `nunchi: the publish was not recorded (${String(e?.message || e).split('\n')[0].slice(0, 200)}); run nunchi share --status\n` };
  }
}
async function main() {
  let raw = '';
  try { for await (const chunk of process.stdin) { raw += chunk; if (raw.length > MAX_INPUT) break; } } catch { raw = null; }
  const r = answerPost(raw);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
