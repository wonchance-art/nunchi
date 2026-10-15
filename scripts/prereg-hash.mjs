#!/usr/bin/env node
// What a gate is pre-registered against (design 0.1-c §9: "the engine, scorer and answer-key hashes"), the doc's own
// rules, and the seeds. Written into docs/prereg-<gate>.md by this script, never typed by hand, and checked before and
// after the measurement.
//
// A pre-registration names its sets in a fenced block whose info string is `prereg-sets`, one line each:
//
//   gate    heldout
//   engine  src lenses hooks skills/nunchi/SKILL.md .claude-plugin package.json package-lock.json
//   scorer  bench/score.mjs bench/ai-gate.mjs scripts/prereg-stats.mjs scripts/prereg-hash.mjs
//   keys    @key-2 @key-3
//   seeds   salt-1 salt-2 salt-3 bootstrap
//   beacon  drand <chain hash> <round>
//
// - A repository path (a file, or a folder: every file git tracks under it) is read as git stores it at HEAD, and only
//   while the working tree holds exactly that: nothing modified, staged, untracked or ignored under it (ignored files
//   would run but not be hashed), except dependency and build folders (node_modules, .next, dist, out) that an app's
//   hashed lockfile rebuilds. Line endings and a checkout's filters cannot change a hash.
// - `@name` is kept outside the repository until the measurement ends (an answer key the hunting session must not
//   read, or a held-out app no other session may open), given on the command line as `--key name=<path>`: a file is
//   hashed as its bytes; a folder must be the top of its own git repository and is hashed like a repository set
//   (every tracked file at its HEAD, clean tree), its paths listed as `@name/<path>`.
// - A set's hash is the sha256 of its sha256sum-style listing, `<sha256 of the file>  <path or @name>\n` per file,
//   sorted by path bytes. For repository paths on a checkout with LF line endings, `git ls-files -z -- <paths> | xargs
//   -0 sha256sum -b | sed 's/ \*/  /' | sha256sum` prints the same hash (macOS: `shasum -a 256 -b` for `sha256sum -b`,
//   `shasum -a 256` for the last one): `-b` makes every platform print the binary marker `*` (Git Bash on Windows
//   prints it by default), and `sed` turns it back into the usual two spaces.
// - The `doc` row is the sha256 of the doc itself, its line endings made LF, without the hash block and without a
//   final `## Amendments` section: the registered rules, so changing one after registration fails `--check`. A new
//   registration (`--fill --again --reason <why>`) appends a row to `## Amendments`, dated in KST.
// - Seeds are derived only after the registration is pushed, from the registered hashes and a public randomness
//   beacon: drand round <round> of the named chain, a round published after the push, so nobody can know or grind
//   the seeds while choosing what to register. A seed is the first 8 hex digits of
//   sha256("nunchi-prereg:<gate>:<seed>:<every row's name=hash>:<beacon randomness>"), read as a whole number.
// - A doc may have LF or CRLF line endings (a Windows checkout); it is read either way and written back with its own.
//
//   node scripts/prereg-hash.mjs <doc> [--key name=path …]                 print the block
//   node scripts/prereg-hash.mjs --fill <doc> [--key …] [--again --reason <why>]   register: write the block
//   node scripts/prereg-hash.mjs --seeds <doc> --beacon <randomness> [--key …]     once pushed and the round is out
//   node scripts/prereg-hash.mjs --check <doc> [--key …]                   exit 0 when everything registered holds,
//                                                                           1 when something differs, 2 when the doc
//                                                                           is not registered (or cannot be read)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BEGIN = '<!-- prereg-hash:begin -->';
export const END = '<!-- prereg-hash:end -->';
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const RESERVED = new Set(['gate', 'seeds', 'beacon', 'doc']);
// ignored folders an app set may hold: its dependencies and build output, rebuilt from its hashed lockfile
const REBUILT = new Set(['node_modules', '.next', 'dist', 'out']);
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const byBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const fail = (msg, code = 2) => Object.assign(new Error(msg), { exit: code });

// --- the doc ---

// A doc is parsed with LF line endings and written back with the ones it had (CRLF in a Windows checkout).
export const toLf = text => text.replace(/\r\n/g, '\n');
export const eolOf = text => (text.includes('\r\n') ? '\r\n' : '\n');
const AMENDMENTS = /^## Amendments[ \t]*$/m;

export function parseSets(doc) {
  const text = toLf(doc);
  const m = /^```prereg-sets[ \t]*\n([\s\S]*?)^```[ \t]*$/m.exec(text);
  if (!m) throw fail('the doc has no ```prereg-sets block');
  let gate = null, seeds = null, beacon = null;
  const sets = [];
  for (const raw of m[1].split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [name, ...entries] = line.split(/\s+/);
    if (name === 'gate') {
      if (gate !== null) throw fail('the block names the gate twice');
      if (entries.length !== 1 || !NAME.test(entries[0])) throw fail('gate: one name of lower-case letters, digits and -');
      gate = entries[0]; continue;
    }
    if (name === 'seeds') {
      if (seeds !== null) throw fail('the block has two seeds lines');
      for (const s of entries) if (!NAME.test(s)) throw fail(`seed name "${s}": lower-case letters, digits and -`);
      if (new Set(entries).size !== entries.length) throw fail('a seed is named twice');
      seeds = entries; continue;
    }
    if (name === 'beacon') {
      if (beacon !== null) throw fail('the block has two beacon lines');
      if (entries.length !== 3 || entries[0] !== 'drand' || !/^[0-9a-f]{64}$/.test(entries[1]) || !/^([1-9][0-9]{0,12}|ROUND)$/.test(entries[2])) throw fail('beacon: drand <64-hex chain hash> <round number, or ROUND until it is set>');
      beacon = { chain: entries[1], round: entries[2] === 'ROUND' ? null : Number(entries[2]) }; continue;
    }
    if (!NAME.test(name)) throw fail(`set name "${name}": lower-case letters, digits and -`);
    if (RESERVED.has(name)) throw fail(`"${name}" is not a set name (gate, seeds, beacon and doc are taken)`);
    if (sets.some(s => s.name === name)) throw fail(`set "${name}" is named twice`);
    if (!entries.length) throw fail(`set "${name}" names no file`);
    for (const e of entries) {
      if (e.startsWith('@')) { if (!NAME.test(e.slice(1))) throw fail(`key "${e}": @ and lower-case letters, digits and -`); continue; }
      // a plain path from the repository's root: no leading / or -, no empty, . or .. part, no trailing /, no \
      if (e.startsWith('-') || e.includes('\\') || e.split('/').some(p => p === '' || p === '.' || p === '..')) throw fail(`"${e}" is not a plain repository path`);
    }
    sets.push({ name, entries });
  }
  if (!gate) throw fail('the prereg-sets block names no gate');
  if (!sets.length) throw fail('the prereg-sets block names no set');
  if (seeds?.length && !beacon) throw fail('named seeds need a beacon line (beacon drand <chain hash> <round>)');
  return { gate, sets, seeds: seeds || [], beacon };
}

const blockAt = text => {
  const a = text.indexOf(BEGIN), b = text.indexOf(END);
  if (a < 0 || b < a || text.indexOf(BEGIN, a + 1) >= 0 || text.indexOf(END, b + 1) >= 0) throw fail(`the doc needs exactly one ${BEGIN} … ${END} pair`);
  return { a, b, body: text.slice(a + BEGIN.length, b) };
};

// The doc's registered rules: LF, the hash block emptied, and a final `## Amendments` section cut off.
export function docBody(doc) {
  const text = toLf(doc);
  const { a, b } = blockAt(text);
  const ruled = `${text.slice(0, a)}${BEGIN}\n${text.slice(b)}`;
  const m = AMENDMENTS.exec(ruled);
  const end = s => `${s.replace(/\s+$/, '')}\n`;      // blank lines at the end are no rule
  if (!m) return end(ruled);
  if (/^## /m.test(ruled.slice(m.index + m[0].length))) throw fail('## Amendments must be the doc\'s last section');
  if (ruled.indexOf(BEGIN) > m.index) throw fail('the hash block must come before ## Amendments');
  return end(ruled.slice(0, m.index));
}
export const docHash = doc => sha256(docBody(doc));

// The rows of `## Amendments` that record something: `| <YYYY-MM-DD …> | … |`.
export function amendments(doc) {
  const text = toLf(doc);
  const m = AMENDMENTS.exec(text);
  if (!m) return [];
  return text.slice(m.index).split('\n').filter(l => /^\| \d{4}-\d{2}-\d{2}\b/.test(l));
}
const kstNow = (d = new Date()) => `${new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')} KST`;
export function appendAmendment(doc, row) {
  const eol = eolOf(doc);
  let text = toLf(doc);
  if (!AMENDMENTS.test(text)) text = `${text.replace(/\n*$/, '\n')}\n## Amendments\n\n| When (KST) | What | Why |\n|---|---|---|\n`;
  text = `${text.replace(/\n*$/, '\n')}${row}\n`;
  return eol === '\n' ? text : text.replace(/\n/g, '\r\n');
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
  const status = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=traditional', ...spec]).toString('utf8').split('\0').filter(Boolean);
  const rebuilt = l => l.startsWith('!! ') && l.slice(3).split('/').some(p => REBUILT.has(p));
  const dirty = status.filter(l => !rebuilt(l));
  if (dirty.length) throw fail(`the working tree of ${repo} differs from HEAD under the hashed paths (commit or remove first; "!!" is ignored): ${dirty.slice(0, 5).map(d => d.replace(/^(..) /, '$1 ')).join(', ')}${dirty.length > 5 ? ` and ${dirty.length - 5} more` : ''}`);
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

// Whether a folder is the top of a git work tree, by git's own answer (an empty prefix), never by comparing two
// spellings of a path: Windows gives one folder several (a short 8.3 name such as RUNNER~1, another drive-letter
// case, / or \), and a link or junction is another spelling anywhere.
export function isRepoTop(dir) {
  let out;
  try { out = git(dir, ['rev-parse', '--is-inside-work-tree', '--show-prefix']).toString('utf8').split('\n'); } catch { return false; }
  return out[0].trim() === 'true' && out[1] !== undefined && out[1].trim() === '';
}

export function headCommit(repo) { return git(repo, ['rev-parse', 'HEAD']).toString('utf8').trim(); }
// HEAD is on a remote-tracking branch: the registration was pushed, so its time is public.
export function isPushed(repo) {
  try { return git(repo, ['branch', '-r', '--contains', 'HEAD']).toString('utf8').trim() !== ''; } catch { return false; }
}

// --- hashing ---

export const listing = files => [...files].sort((a, b) => byBytes(a.path, b.path)).map(f => `${f.sha}  ${f.path}\n`).join('');

// → {gate, rows: [{set, files, hash}] (the doc first when given), keys: [{name, files, hash}], commit}
export function computeHashes({ repo, spec, keys = {}, doc = null }) {
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
      if (!isRepoTop(keys[name])) throw fail(`key @${name}: ${keys[name]} is a folder but not the top of a git repository`);
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
  if (doc !== null) rows.unshift({ set: 'doc', files: 1, hash: docHash(doc) });
  return { gate: spec.gate, rows, keys: keyRows, commit: headCommit(repo) };
}

// Seeds from the registered rows and the beacon's randomness (hex, as drand publishes it).
export function deriveSeeds(gate, rows, names, randomness) {
  if (!/^[0-9a-f]{32,}$/.test(String(randomness))) throw fail('--beacon takes the round\'s randomness as hex, as drand publishes it');
  const basis = rows.map(r => `${r.set}=${r.hash}`).join(',');
  return names.map(name => ({ name, value: parseInt(sha256(`nunchi-prereg:${gate}:${name}:${basis}:${randomness}`).slice(0, 8), 16) }));
}

// --- the block in the doc ---

const BEACON_LINE = /^Beacon: drand chain `([0-9a-f]{64})` round (\d+), randomness `([0-9a-f]+)`\.$/;
export function renderBlock(r, { docPath = 'docs/prereg-<gate>.md', spec = null, seeds = null, randomness = null } = {}) {
  const keyArgs = r.keys.map(k => ` --key ${k.name}=<file>`).join('');
  const names = spec?.seeds || [];
  const seedPart = !names.length ? [] : seeds ? [
    '| Seed | Value |', '|---|---:|', ...seeds.map(s => `| ${s.name} | ${s.value} |`), '',
    `Beacon: drand chain \`${spec.beacon.chain}\` round ${spec.beacon.round}, randomness \`${randomness}\`.`, '',
  ] : [
    `Seeds (${names.join(', ')}): **pending**. They are derived from these hashes and drand round ${spec.beacon.round} of chain`,
    `\`${spec.beacon.chain}\`, published after this registration is pushed: \`node scripts/prereg-hash.mjs --seeds`,
    `${docPath} --beacon <that round's randomness>${keyArgs}\`.`, '',
  ];
  return [
    '| Set | Files | sha256 |',
    '|---|---:|---|',
    ...r.rows.map(x => `| ${x.set} | ${x.files} | \`${x.hash}\` |`),
    ...r.keys.map(k => `| key @${k.name} | ${k.files} | \`${k.hash}\` |`),
    '',
    ...seedPart,
    `Hashed from commit \`${r.commit}\` with Node ${process.version}: tracked files as git stores them, keys as`,
    `their bytes, and \`doc\` is this file without this block and without \`## Amendments\`. Check before and after the`,
    `measurement: \`node scripts/prereg-hash.mjs --check ${docPath}${keyArgs}\`.`,
  ].join('\n');
}

// What a filled block registered: set rows, key rows, seeds and beacon; null when nothing is registered yet.
export function readRegistered(doc) {
  const { body } = blockAt(toLf(doc));
  const rows = [], keys = [], seeds = [];
  let beacon = null;
  for (const line of body.split('\n')) {
    let m = /^\| key @([a-z][a-z0-9-]*) \| (\d+) \| `([0-9a-f]{64})` \|$/.exec(line);
    if (m) { keys.push({ name: m[1], files: Number(m[2]), hash: m[3] }); continue; }
    m = /^\| ([a-z][a-z0-9-]*) \| (\d+) \| `([0-9a-f]{64})` \|$/.exec(line);
    if (m) { rows.push({ set: m[1], files: Number(m[2]), hash: m[3] }); continue; }
    m = /^\| ([a-z][a-z0-9-]*) \| (\d+) \|$/.exec(line);
    if (m) { seeds.push({ name: m[1], value: Number(m[2]) }); continue; }
    m = BEACON_LINE.exec(line);
    if (m) beacon = { chain: m[1], round: Number(m[2]), randomness: m[3] };
  }
  return rows.length ? { rows, keys, seeds, beacon } : null;
}

export function compare(registered, now) {
  const diffs = [];
  const by = (list, k) => new Map(list.map(x => [x[k], x]));
  const pairs = [['set', registered.rows, now.rows, 'set', 'hash'], ['key', registered.keys, now.keys, 'name', 'hash']];
  if (now.seeds) pairs.push(['seed', registered.seeds, now.seeds, 'name', 'value']);
  for (const [what, a, b, k, v] of pairs) {
    const ma = by(a, k), mb = by(b, k);
    for (const name of [...new Set([...ma.keys(), ...mb.keys()])].sort(byBytes)) {
      if (!ma.has(name)) diffs.push(`${what} ${name}: not registered`);
      else if (!mb.has(name)) diffs.push(`${what} ${name}: registered, no longer named by the doc`);
      else if (ma.get(name)[v] !== mb.get(name)[v]) diffs.push(`${what} ${name}: registered ${ma.get(name)[v]}, now ${mb.get(name)[v]}${name === 'doc' ? ' (the doc changed outside ## Amendments)' : ''}`);
    }
  }
  return diffs;
}

export function fillDoc(doc, block) {
  const text = toLf(doc);
  const { a, b } = blockAt(text);
  const out = `${text.slice(0, a)}${BEGIN}\n${toLf(block)}\n${text.slice(b)}`;
  return eolOf(doc) === '\r\n' ? out.replace(/\n/g, '\r\n') : out;
}

// --- command line ---

export function main(argv, { repo = fileURLToPath(new URL('..', import.meta.url)), log = console.log, now = new Date() } = {}) {
  const keys = {};
  let mode = 'print', doc = null, again = false, reason = null, beaconValue = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fill' || a === '--check' || a === '--seeds') mode = a.slice(2);
    else if (a === '--again') again = true;
    else if (a === '--reason') reason = String(argv[++i] ?? '').trim();
    else if (a === '--beacon') beaconValue = String(argv[++i] ?? '').trim().toLowerCase();
    else if (a === '--repo') repo = resolve(argv[++i] ?? '');
    else if (a === '--key') {
      const v = argv[++i] ?? ''; const eq = v.indexOf('=');
      if (eq < 1 || !NAME.test(v.slice(0, eq))) throw fail('--key takes name=<path>');
      if (v.slice(0, eq) in keys) throw fail(`--key ${v.slice(0, eq)} given twice`);
      keys[v.slice(0, eq)] = resolve(v.slice(eq + 1));
    } else if (!a.startsWith('--') && !doc) doc = a;
    else throw fail(`unknown argument ${a}`);
  }
  if (!doc) throw fail('usage: prereg-hash.mjs [--fill [--again --reason <why>] | --seeds --beacon <randomness> | --check] <docs/prereg-<gate>.md> [--key name=<path> …]');
  const path = resolve(doc);
  const text = readFileSync(path, 'utf8');
  const shownDoc = doc.replace(/\\/g, '/');
  const spec = parseSets(text);
  const registered = readRegistered(text);
  if ((mode === 'check' || mode === 'seeds') && !registered) throw fail(`${doc} is not registered yet (node scripts/prereg-hash.mjs --fill ${shownDoc})`, 2);
  const current = computeHashes({ repo, spec, keys, doc: text });
  const amended = amendments(text).length;
  if (mode === 'print') return log(renderBlock(current, { docPath: shownDoc, spec }));

  if (mode === 'check') {
    const recorded = registered.seeds.length ? deriveSeeds(spec.gate, current.rows, spec.seeds, registered.beacon?.randomness ?? '') : null;
    const diffs = compare(registered, { ...current, seeds: recorded });
    if (registered.seeds.length && registered.beacon && spec.beacon && registered.beacon.round !== spec.beacon.round) diffs.push(`beacon: seeds came from round ${registered.beacon.round}, the doc names round ${spec.beacon.round}`);
    if (diffs.length) throw fail(`${doc}: the registration no longer holds:\n  ${diffs.join('\n  ')}`, 1);
    const seedsSaid = !spec.seeds.length ? 'no seeds' : registered.seeds.length ? `${registered.seeds.length} seeds` : `seeds pending (drand round ${spec.beacon.round})`;
    return log(`${doc}: every registered hash holds (${current.rows.length} rows, ${current.keys.length} keys, ${seedsSaid}); ${amended} amendment${amended === 1 ? '' : 's'}`);
  }

  if (mode === 'seeds') {
    const diffs = compare(registered, current);
    if (diffs.length) throw fail(`${doc}: the registration no longer holds, so no seeds:\n  ${diffs.join('\n  ')}`, 1);
    if (!spec.seeds.length) throw fail(`${doc} names no seeds`);
    if (registered.seeds.length) throw fail(`${doc} has its seeds already (a new beacon round needs a new registration: --fill --again --reason)`, 1);
    if (!beaconValue) throw fail(`give drand round ${spec.beacon.round}'s randomness: --beacon <hex>`);
    const status = git(repo, ['status', '--porcelain=v1', '--', path]).toString('utf8').trim();
    if (status || !isPushed(repo)) throw fail(`commit and push the registration first: seeds come only after the registration is public (${status ? 'the doc has uncommitted changes' : 'HEAD is on no remote branch'})`);
    const seeds = deriveSeeds(spec.gate, current.rows, spec.seeds, beaconValue);
    writeFileSync(path, fillDoc(text, renderBlock(current, { docPath: shownDoc, spec, seeds, randomness: beaconValue })));
    return log(`${doc}: ${seeds.length} seeds from drand round ${spec.beacon.round}`);
  }

  // --fill
  if (spec.seeds.length && spec.beacon.round === null) throw fail('set the beacon round first: a drand round that will be published after you push this registration (the line says ROUND)');
  let out = text;
  if (registered) {
    const diffs = compare(registered, current);
    if (!diffs.length) return log(`${doc}: already registered with these hashes; nothing written`);
    if (!again || !reason) throw fail(`${doc} is registered with other hashes:\n  ${diffs.join('\n  ')}\nA new registration is an amendment: give --again and --reason "<why>"; it is logged under ## Amendments.`, 1);
    if (registered.beacon && spec.beacon && spec.beacon.round <= registered.beacon.round) throw fail(`the seeds came from drand round ${registered.beacon.round}; a new registration needs a later round (edit the beacon line)`, 1);
    out = appendAmendment(out, `| ${kstNow(now)} | re-registered at commit ${current.commit.slice(0, 12)} | ${reason.replace(/\|/g, '/').replace(/\s+/g, ' ')} |`);
  }
  writeFileSync(path, fillDoc(out, renderBlock(current, { docPath: shownDoc, spec })));
  log(`${doc}: registered ${current.rows.length} rows and ${current.keys.length} keys at ${current.commit.slice(0, 12)}${spec.seeds.length ? `; seeds after drand round ${spec.beacon.round}` : ''}`);
}

// Run as a command only when this file is the program, however it was reached: through a link, a junction, or a
// short or differently cased Windows path, so a check never exits 0 without running.
const realOrSelf = p => { try { return realpathSync.native(p); } catch { return p; } };
if (process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(e.exit ?? 2); }
}
