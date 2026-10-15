#!/usr/bin/env node
// The hashes a gate is pre-registered against (design 0.1-c §9: "the engine, scorer and answer-key hashes") and the
// seeds derived from them. Written into docs/prereg-<gate>.md at registration time, never typed by hand, and checked
// before and after the measurement.
//
// A pre-registration names its sets in a fenced block whose info string is `prereg-sets`, one set per line:
//
//   gate    heldout
//   engine  src lenses hooks skills/nunchi/SKILL.md .claude-plugin package.json package-lock.json
//   scorer  bench/score.mjs bench/ai-gate.mjs scripts/prereg-stats.mjs scripts/prereg-hash.mjs
//   key     @heldout-2 @heldout-3
//   seeds   salt-1 salt-2 salt-3 bootstrap
//
// - A repository path (a file, or a folder: every file git tracks under it) is read as git stores it at HEAD, and only
//   while the working tree holds exactly that (nothing modified, staged or untracked under it). Line endings and a
//   checkout's filters cannot change a hash.
// - `@name` is kept outside the repository until the measurement ends (an answer key the hunting session must not
//   read, or a held-out app no other session may open), given on the command line as `--key name=<path>`: a file is
//   hashed as its bytes; a folder must be the top of its own git repository and is hashed like a repository set
//   (every tracked file at its HEAD, clean tree), its paths listed as `@name/<path>`.
// - A set's hash is the sha256 of its sha256sum-style listing, `<sha256 of the file>  <path or @name>\n` per file,
//   sorted by path bytes. For repository paths on a clean checkout, `git ls-files -z -- <paths> | xargs -0 sha256sum |
//   sha256sum` prints the same hash.
// - A seed is the first 8 hex digits of sha256("nunchi-prereg:<gate>:<seed>:" + every set's name=hash), read as a
//   whole number. Nobody picks it; it is fixed the moment the sets are.
//
//   node scripts/prereg-hash.mjs <doc> [--key name=path …]            print the block
//   node scripts/prereg-hash.mjs --fill <doc> [--key name=path …]     write it between the doc's prereg-hash markers
//                                                                      (a different registration is replaced only with --again)
//   node scripts/prereg-hash.mjs --check <doc> [--key name=path …]    exit 0 when every hash and seed still holds,
//                                                                      1 when one differs, 2 when the doc is not registered
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BEGIN = '<!-- prereg-hash:begin -->';
export const END = '<!-- prereg-hash:end -->';
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const byBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const fail = (msg, code = 2) => Object.assign(new Error(msg), { exit: code });

// --- the doc's set block ---

export function parseSets(text) {
  const m = /^```prereg-sets[ \t]*\n([\s\S]*?)^```[ \t]*$/m.exec(text);
  if (!m) throw fail('the doc has no ```prereg-sets block');
  let gate = null; let seeds = []; const sets = [];
  for (const raw of m[1].split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [name, ...entries] = line.split(/\s+/);
    if (name === 'gate') { if (entries.length !== 1 || !NAME.test(entries[0])) throw fail('gate: one name of lower-case letters, digits and -'); gate = entries[0]; continue; }
    if (name === 'seeds') { for (const s of entries) if (!NAME.test(s)) throw fail(`seed name "${s}": lower-case letters, digits and -`); seeds = entries; continue; }
    if (!NAME.test(name)) throw fail(`set name "${name}": lower-case letters, digits and -`);
    if (sets.some(s => s.name === name)) throw fail(`set "${name}" is named twice`);
    if (!entries.length) throw fail(`set "${name}" names no file`);
    for (const e of entries) {
      if (e.startsWith('@')) { if (!NAME.test(e.slice(1))) throw fail(`key "${e}": @ and lower-case letters, digits and -`); continue; }
      // a plain path from the repository's root: no leading / or -, no empty, . or .. part, no trailing /
      if (e.startsWith('-') || e.includes('\\') || e.split('/').some(p => p === '' || p === '.' || p === '..')) throw fail(`"${e}" is not a plain repository path`);
    }
    sets.push({ name, entries });
  }
  if (!gate) throw fail('the prereg-sets block names no gate');
  if (!sets.length) throw fail('the prereg-sets block names no set');
  if (new Set(seeds).size !== seeds.length) throw fail('a seed is named twice');
  return { gate, sets, seeds };
}

// --- reading the repository as git stores it ---

function git(repo, args, input) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  env.GIT_TERMINAL_PROMPT = '0';
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', '--no-optional-locks', ...args],
    { cwd: repo, env, input, maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

// entries: repository paths, or null for every tracked file
function repoFiles(repo, entries) {
  if (entries && !entries.length) return [];
  const spec = entries ? ['--', ...entries] : [];
  const dirty = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...spec]).toString('utf8').split('\0').filter(Boolean);
  if (dirty.length) throw fail(`the working tree of ${repo} differs from HEAD under the hashed paths (commit or remove first): ${dirty.slice(0, 5).map(d => d.slice(3)).join(', ')}${dirty.length > 5 ? ` and ${dirty.length - 5} more` : ''}`);
  const rows = git(repo, ['ls-tree', '-r', '-z', 'HEAD', ...spec]).toString('utf8').split('\0').filter(Boolean).map(r => {
    const tab = r.indexOf('\t');
    const [mode, type, oid] = r.slice(0, tab).split(' ');
    return { mode, type, oid, path: r.slice(tab + 1) };
  });
  for (const r of rows) if (r.type !== 'blob') throw fail(`${r.path} is a ${r.type} (a submodule?), not a file`);
  for (const e of entries || []) if (!rows.some(r => r.path === e || r.path.startsWith(`${e}/`))) throw fail(`${e} is not in the repository at HEAD`);
  if (!rows.length) throw fail(`${repo} has no tracked file at HEAD`);
  // one `cat-file --batch` for every blob: "<oid> blob <size>\n<bytes>\n" each
  const out = git(repo, ['cat-file', '--batch'], rows.map(r => r.oid).join('\n') + '\n');
  let at = 0;
  for (const r of rows) {
    const nl = out.indexOf(0x0a, at);
    const [oid, type, size] = out.subarray(at, nl).toString('utf8').split(' ');
    if (oid !== r.oid || type !== 'blob') throw fail(`git could not read ${r.path}`);
    const len = Number(size);
    r.sha = sha256(out.subarray(nl + 1, nl + 1 + len));
    at = nl + 1 + len + 1;
  }
  return rows.map(r => ({ path: r.path, sha: r.sha }));
}

export function headCommit(repo) { return git(repo, ['rev-parse', 'HEAD']).toString('utf8').trim(); }

// --- hashing ---

export const listing = files => [...files].sort((a, b) => byBytes(a.path, b.path)).map(f => `${f.sha}  ${f.path}\n`).join('');

// → {gate, rows: [{set, files, hash}], keys: [{name, files, hash}], seeds: [{name, value}], commit}
export function computeHashes({ repo, spec, keys = {} }) {
  const named = new Set(spec.sets.flatMap(s => s.entries.filter(e => e.startsWith('@')).map(e => e.slice(1))));
  const missing = [...named].filter(n => !(n in keys)).sort(byBytes);
  if (missing.length) throw fail(`give the file of each key: ${missing.map(n => `--key ${n}=<path>`).join(' ')}`);
  const extra = Object.keys(keys).filter(n => !named.has(n)).sort(byBytes);
  if (extra.length) throw fail(`the doc names no key ${extra.map(n => `@${n}`).join(', ')}`);
  const keyFiles = {};
  const keyRows = [...named].sort(byBytes).map(name => {
    let st;
    try { st = statSync(keys[name]); } catch { throw fail(`key @${name}: cannot read ${keys[name]}`); }
    if (st.isFile()) keyFiles[name] = [{ path: `@${name}`, sha: sha256(readFileSync(keys[name])) }];
    else if (st.isDirectory()) {
      let top = null;
      try { top = realpathSync(git(keys[name], ['rev-parse', '--show-toplevel']).toString('utf8').trim()); } catch {}
      if (top !== realpathSync(keys[name])) throw fail(`key @${name}: ${keys[name]} is a folder but not the top of a git repository`);
      keyFiles[name] = repoFiles(keys[name], null).map(f => ({ path: `@${name}/${f.path}`, sha: f.sha }));
    } else throw fail(`key @${name}: ${keys[name]} is not a file or a folder`);
    const list = keyFiles[name];
    return { name, files: list.length, hash: list.length === 1 && list[0].path === `@${name}` ? list[0].sha : sha256(listing(list)) };
  });
  const rows = spec.sets.map(s => {
    const files = repoFiles(repo, s.entries.filter(e => !e.startsWith('@')));
    for (const e of s.entries.filter(x => x.startsWith('@'))) files.push(...keyFiles[e.slice(1)]);
    const paths = new Set();
    for (const f of files) { if (paths.has(f.path)) throw fail(`set "${s.name}" names ${f.path} twice`); paths.add(f.path); }
    return { set: s.name, files: files.length, hash: sha256(listing(files)) };
  });
  const basis = rows.map(r => `${r.set}=${r.hash}`).join(',');
  const seeds = spec.seeds.map(name => ({ name, value: parseInt(sha256(`nunchi-prereg:${spec.gate}:${name}:${basis}`).slice(0, 8), 16) }));
  return { gate: spec.gate, rows, keys: keyRows, seeds, commit: headCommit(repo) };
}

// --- the block in the doc ---

export function renderBlock(r, docPath = 'docs/prereg-<gate>.md') {
  const keyArgs = r.keys.map(k => ` --key ${k.name}=<file>`).join('');
  return [
    '| Set | Files | sha256 |',
    '|---|---:|---|',
    ...r.rows.map(x => `| ${x.set} | ${x.files} | \`${x.hash}\` |`),
    ...r.keys.map(k => `| key @${k.name} | ${k.files} | \`${k.hash}\` |`),
    '',
    ...(r.seeds.length ? ['| Seed | Value |', '|---|---:|', ...r.seeds.map(s => `| ${s.name} | ${s.value} |`), ''] : []),
    `Hashed from commit \`${r.commit}\` (tracked files as git stores them; keys as their bytes). Seeds are derived from the`,
    `hashes, never chosen. Check before and after the measurement: \`node scripts/prereg-hash.mjs --check ${docPath}${keyArgs}\`.`,
  ].join('\n');
}

const blockAt = text => {
  const a = text.indexOf(BEGIN), b = text.indexOf(END);
  if (a < 0 || b < a || text.indexOf(BEGIN, a + 1) >= 0) throw fail(`the doc needs exactly one ${BEGIN} … ${END} pair`);
  return { a, b, body: text.slice(a + BEGIN.length, b) };
};
// What a filled block registered: set rows, key rows, seeds; null when nothing is registered yet.
export function readRegistered(text) {
  const { body } = blockAt(text);
  const rows = [], keys = [], seeds = [];
  for (const line of body.split('\n')) {
    let m = /^\| key @([a-z][a-z0-9-]*) \| (\d+) \| `([0-9a-f]{64})` \|$/.exec(line);
    if (m) { keys.push({ name: m[1], files: Number(m[2]), hash: m[3] }); continue; }
    m = /^\| ([a-z][a-z0-9-]*) \| (\d+) \| `([0-9a-f]{64})` \|$/.exec(line);
    if (m) { rows.push({ set: m[1], files: Number(m[2]), hash: m[3] }); continue; }
    m = /^\| ([a-z][a-z0-9-]*) \| (\d+) \|$/.exec(line);
    if (m) seeds.push({ name: m[1], value: Number(m[2]) });
  }
  return rows.length ? { rows, keys, seeds } : null;
}

export function compare(registered, now) {
  const diffs = [];
  const by = (list, k) => new Map(list.map(x => [x[k], x]));
  for (const [what, a, b, k, v] of [['set', registered.rows, now.rows, 'set', 'hash'], ['key', registered.keys, now.keys, 'name', 'hash'], ['seed', registered.seeds, now.seeds, 'name', 'value']]) {
    const ma = by(a, k), mb = by(b, k);
    for (const name of [...new Set([...ma.keys(), ...mb.keys()])].sort(byBytes)) {
      if (!ma.has(name)) diffs.push(`${what} ${name}: not registered`);
      else if (!mb.has(name)) diffs.push(`${what} ${name}: registered, no longer named by the doc`);
      else if (ma.get(name)[v] !== mb.get(name)[v]) diffs.push(`${what} ${name}: registered ${ma.get(name)[v]}, now ${mb.get(name)[v]}`);
    }
  }
  return diffs;
}

export function fillDoc(text, block) {
  const { a, b } = blockAt(text);
  return `${text.slice(0, a)}${BEGIN}\n${block}\n${text.slice(b)}`;
}

// --- command line ---

function main(argv) {
  const keys = {};
  let mode = 'print', doc = null, repo = fileURLToPath(new URL('..', import.meta.url)), again = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fill' || a === '--check') mode = a.slice(2);
    else if (a === '--again') again = true;
    else if (a === '--repo') repo = resolve(argv[++i] ?? '');
    else if (a === '--key') {
      const v = argv[++i] ?? ''; const eq = v.indexOf('=');
      if (eq < 1 || !NAME.test(v.slice(0, eq))) throw fail('--key takes name=<path>');
      if (v.slice(0, eq) in keys) throw fail(`--key ${v.slice(0, eq)} given twice`);
      keys[v.slice(0, eq)] = resolve(v.slice(eq + 1));
    } else if (!a.startsWith('--') && !doc) doc = a;
    else throw fail(`unknown argument ${a}`);
  }
  if (!doc) throw fail('usage: prereg-hash.mjs [--fill | --check] <docs/prereg-<gate>.md> [--key name=<path> …] [--again]');
  const text = readFileSync(resolve(doc), 'utf8');
  const now = computeHashes({ repo, spec: parseSets(text), keys });
  const shownDoc = doc.replace(/\\/g, '/');
  if (mode === 'print') return console.log(renderBlock(now, shownDoc));
  const registered = readRegistered(text);
  if (mode === 'check') {
    if (!registered) throw fail(`${doc} is not registered yet (node scripts/prereg-hash.mjs --fill ${shownDoc})`, 2);
    const diffs = compare(registered, now);
    if (diffs.length) throw fail(`${doc}: the registration no longer holds:\n  ${diffs.join('\n  ')}`, 1);
    return console.log(`${doc}: every registered hash and seed holds (${now.rows.length} sets, ${now.keys.length} keys, ${now.seeds.length} seeds)`);
  }
  if (registered && compare(registered, now).length && !again) {
    throw fail(`${doc} is registered with other hashes:\n  ${compare(registered, now).join('\n  ')}\nA new registration before any data is an amendment of the registration: give --again and say why in the doc.`, 1);
  }
  writeFileSync(resolve(doc), fillDoc(text, renderBlock(now, shownDoc)));
  console.log(`${doc}: registered ${now.rows.length} sets, ${now.keys.length} keys, ${now.seeds.length} seeds at ${now.commit.slice(0, 12)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(e.exit ?? 2); }
}
