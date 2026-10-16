#!/usr/bin/env node
// `claude plugin validate --strict`, less the one warning nunchi means to have: no `version` in plugin.json or its
// marketplace entry. Without one, Claude Code takes the commit as the plugin's version, so each commit on main reaches
// `claude plugin update` (a pinned version is cached and never updated until bumped: test/plugin-manifest.test.mjs).
// Every other warning and every error still fails, as --strict would.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NO_VERSION = /^No version specified\b/;
const isNoVersion = w => /(^|→ )version$/.test(String(w?.path ?? '')) && NO_VERSION.test(String(w?.message ?? ''));

// → the problems that fail the check: [{ file, kind: 'error' | 'warning', path, message }]
export function blocking(report) {
  const out = [];
  for (const part of [report?.manifest, ...(report?.contents ?? [])].filter(Boolean)) {
    for (const e of part.errors ?? []) out.push({ file: part.file, kind: 'error', path: e.path, message: e.message });
    for (const w of part.warnings ?? []) if (!isNoVersion(w)) out.push({ file: part.file, kind: 'warning', path: w.path, message: w.message });
  }
  if (report?.success !== true && !out.length) out.push({ file: report?.target, kind: 'error', path: '', message: 'validation did not succeed' });
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] || '.';
  const r = spawnSync('claude', ['plugin', 'validate', '--json', dir], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.error) { console.error(`validate-plugin: could not run claude (${r.error.message})`); process.exit(2); }
  let report;
  try { report = JSON.parse(r.stdout); } catch { console.error(`validate-plugin: claude printed no report\n${r.stdout}${r.stderr}`); process.exit(2); }
  const bad = blocking(report);
  for (const b of bad) console.error(`✗ ${b.kind}: ${b.file} ${b.path ? `(${b.path}) ` : ''}${b.message}`);
  if (bad.length) process.exit(1);
  console.log('validate-plugin: passed (strict; the commit is the plugin\'s version, so "No version specified" is expected)');
}
