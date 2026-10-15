// Source inventory (spec §2.4): strings, UI states and destructive actions with file:line, and the
// no-AI classification pass whose candidates feed L2/L5/L6/L7/L9. Fixture apps are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { discover } from '../src/discover.mjs';
import { buildInventory } from '../src/inventory.mjs';
import { stableJson } from '../src/stable.mjs';
import { tmp } from './fixtures/tmp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function tree(files) {
  const root = tmp('nunchi-inv-');
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}
const inventory = root => buildInventory(root, discover(root).routes);
const fileOf = (inv, f) => inv.files.find(x => x.file === f);
const str = (inv, f, text) => fileOf(inv, f)?.strings.find(s => s.text === text);
const cands = (inv, kind) => inv.candidates.filter(c => c.kind === kind);

const nextApp = (extra = {}) => tree({
  'package.json': { dependencies: { next: '15.0.0', react: '19.0.0' } },
  'app/layout.tsx': `import Link from 'next/link';
export const metadata = { title: 'Fernway — plan small trips' };
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/">Fernway</Link>
          <Link href="/trips">Trips</Link>
          <Link href="/settings">Settings</Link>
          <Link href="/login">Sign In</Link>
        </header>
        {children}
      </body>
    </html>
  );
}
`,
  'app/page.tsx': `import Link from 'next/link';
import { Suspense } from 'react';
import { Feed, Spinner } from '@/components/Feed';
export default function Home({ user }: { user: { name: string } }) {
  return (
    <main>
      <h1>Welcome back, {user.name}</h1>
      <p>
        Read the <Link href="/help">guide</Link> before
        you start.
      </p>
      <input placeholder="Search trips" aria-label="Search" className="input big" style={{ color: 'red' }} />
      <img alt={user ? 'Your avatar' : \`Avatar of \${user.name}\`} src="/a.png" />
      <Suspense fallback={<Spinner />}><Feed /></Suspense>
    </main>
  );
}
`,
  'components/Feed.tsx': `export const Spinner = () => <span aria-label="Loading feed" />;
export function Feed() { return <p>{'Nothing new'}</p>; }
`,
  'app/trips/page.tsx': `'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { deleteAll } from '@/lib/api';

export default function Trips() {
  const { data, isLoading, error } = useQuery({ queryKey: ['trips'], queryFn: load });
  const [formError, setFormError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  async function load() {
    const r = await fetch('/api/trips');
    if (!r.ok) throw new Error(\`Could not load trips (\${r.status})\`);
    return r.json();
  }
  const handleDelete = (id: string) => {
    if (!window.confirm('Delete this trip? This cannot be undone.')) return;
    toast.success('Trip deleted');
  };
  const removeDone = () => { toast('Removed past trips', { action: { label: 'Undo', onClick: () => {} } }); };
  const clearList = () => { setFormError('List cleared'); };
  if (isLoading) return <p>Loading trips…</p>;
  if (error) return <p className="err">{error.message}</p>;
  return (
    <section>
      {data.items.length === 0 ? <p>No trips yet</p> : null}
      <button onClick={() => handleDelete('1')}>Delete</button>
      <button onClick={removeDone}>Remove past</button>
      <button onClick={clearList}>Trash list</button>
      <button onClick={() => setConfirmOpen(true)}>Delete all</button>
      <button onClick={() => deleteAll()}>Erase everything</button>
      {formError && <span role="alert">{formError}</span>}
      <button onClick={() => toast.error(\`Failed to save \${data.name}\`)}>Save</button>
    </section>
  );
}
`,
  'app/trips/loading.tsx': `export default function Loading() { return <div>Loading your trips…</div>; }\n`,
  'app/trips/error.tsx': `'use client';
export default function TripsError({ reset }: { reset: () => void }) {
  return <div><p>Something went wrong</p><button onClick={() => reset()}>Try again</button><button onClick={reset}>Retry</button></div>;
}
`,
  'app/settings/page.tsx': `'use client';
import { useState } from 'react';
export default function Settings() {
  const [error, setError] = useState<string | null>(null);
  const save = () => { setError('Could not save your preferences. Check your connection and try again.'); };
  return (
    <>
      <h1>Preferences</h1>
      <label>Display name</label>
      <button type="submit" onClick={save}>Submit</button>
      {error ? <p role="alert">{error}</p> : <p>All changes saved</p>}
      <a href="/login">Sign in</a>
    </>
  );
}
`,
  ...extra,
});

test('strings: JSX text with file:line, sentences across inline links, props, template literals, metadata', () => {
  const inv = inventory(nextApp());
  assert.equal(inv.scope, 'routes');
  const welcome = str(inv, 'app/page.tsx', 'Welcome back, {…}');
  assert.deepEqual([welcome.line, welcome.column, welcome.kind, welcome.role, welcome.element], [7, 11, 'text', 'heading', 'h1']);
  const sentence = str(inv, 'app/page.tsx', 'Read the guide before you start.');
  assert.ok(sentence, 'a sentence reads through an inline link and joins its lines');
  assert.equal(sentence.line, 9);
  assert.equal(str(inv, 'app/page.tsx', 'guide').role, 'link', 'the link keeps its own label too');
  assert.equal(str(inv, 'app/page.tsx', 'Search trips').prop, 'placeholder');
  assert.equal(str(inv, 'app/page.tsx', 'Search').prop, 'aria-label');
  assert.ok(str(inv, 'app/page.tsx', 'Your avatar'), 'both sides of a conditional prop');
  assert.ok(str(inv, 'app/page.tsx', 'Avatar of ${…}'), 'template literals keep static parts');
  assert.equal(str(inv, 'app/layout.tsx', 'Fernway — plan small trips').kind, 'metadata');
  assert.equal(str(inv, 'components/Feed.tsx', 'Nothing new').kind, 'text', 'a string literal child is text');
  const all = inv.files.flatMap(f => f.strings.map(s => s.text));
  for (const bad of ['input big', 'red', '/a.png', 'next/link', 'sonner', '/api/trips', 'en', 'trips']) assert.ok(!all.includes(bad), `not user-facing: ${bad}`);
  assert.deepEqual(fileOf(inv, 'app/layout.tsx').routes, ['/', '/settings', '/trips']);
});

test('strings: toasts, dialogs, error setters, thrown messages kept apart', () => {
  const inv = inventory(nextApp());
  const f = 'app/trips/page.tsx';
  assert.deepEqual([str(inv, f, 'Trip deleted').kind, str(inv, f, 'Trip deleted').call], ['toast', 'toast.success']);
  assert.equal(str(inv, f, 'Removed past trips').kind, 'toast');
  assert.equal(str(inv, f, 'Undo').kind, 'toast', 'toast action label');
  assert.equal(str(inv, f, 'Failed to save ${…}').call, 'toast.error');
  assert.deepEqual([str(inv, f, 'Delete this trip? This cannot be undone.').kind, str(inv, f, 'Delete this trip? This cannot be undone.').call], ['dialog', 'confirm']);
  assert.equal(str(inv, f, 'List cleared').kind, 'state-message');
  const thrown = str(inv, f, 'Could not load trips (${…})');
  assert.deepEqual([thrown.kind, thrown.line], ['thrown', 13]);
  assert.deepEqual(fileOf(inv, f).dialogs, [{ call: 'confirm', line: 17, text: 'Delete this trip? This cannot be undone.' }]);
});

test('states: if-return loading/error, ternary empty, && error, Suspense fallback, Next.js loading/error files', () => {
  const inv = inventory(nextApp());
  const st = f => fileOf(inv, f).states.map(s => `${s.line} ${s.state} ${s.how} ${s.by} ${JSON.stringify(s.strings)}${s.elements.length ? ' ' + s.elements.join(',') : ''}${s.rawValues ? ' raw:' + s.rawValues.join(',') : ''}`);
  assert.deepEqual(st('app/trips/page.tsx'), [
    '22 loading if-return condition ["Loading trips…"]',
    '23 error if-return condition [] raw:error.message',
    '26 empty ternary condition ["No trips yet"]',
    '32 error and condition []',
  ]);
  // {error} set only from written messages is copy, not a raw value
  assert.deepEqual(st('app/settings/page.tsx'), ['11 error ternary condition []']);
  assert.deepEqual(st('app/page.tsx'), ['14 loading suspense element [] Spinner']);
  assert.deepEqual(st('app/trips/loading.tsx'), ['1 loading file file ["Loading your trips…"]']);
  assert.deepEqual(st('app/trips/error.tsx'), ['1 error file file ["Something went wrong","Try again","Retry"]']);
});

test('actions: destructive with and without confirm, undo, custom dialog, unknown across files; window.confirm listed', () => {
  const inv = inventory(nextApp());
  const acts = fileOf(inv, 'app/trips/page.tsx').actions.map(a => `${a.line} ${a.label} ${a.handler} ${a.confirm ? a.confirm.kind : 'none'}${a.undo ? ' undo' : ''}`);
  assert.deepEqual(acts, [
    '27 Delete inline native',
    '28 Remove past removeDone none undo',
    '29 Trash list clearList none',
    '30 Delete all inline dialog',
    '31 Erase everything inline unknown',
  ]);
  const native = fileOf(inv, 'app/trips/page.tsx').actions[0].confirm;
  assert.deepEqual(native, { kind: 'native', line: 17, text: 'Delete this trip? This cannot be undone.' });
  assert.match(fileOf(inv, 'app/trips/page.tsx').actions[4].confirm.reason, /deleteAll, defined in another file/);
  assert.deepEqual(fileOf(inv, 'app/trips/error.tsx').actions, [], 'Next.js reset() is a retry, not a destructive action');
  assert.deepEqual(fileOf(inv, 'app/settings/page.tsx').actions, []);
  const unguarded = cands(inv, 'unguarded-destructive');
  assert.deepEqual(unguarded.map(c => `${c.file}:${c.line} ${c.label}`), ['app/trips/page.tsx:29 Trash list']);
});

test('candidates: different verbs, casing and names for the same thing (triggering)', () => {
  const inv = inventory(nextApp());
  assert.ok(inv.candidates.every(c => c.candidate === true && !('severity' in c)), 'candidates are marked and carry no severity');
  const del = cands(inv, 'verb-variants').find(c => c.concept === 'delete');
  assert.deepEqual(del.variants.map(v => v.forms.join('/')), ['Delete', 'Erase', 'Remove', 'Trash']);
  assert.equal(del.variants[0].count, 2);
  assert.deepEqual(del.variants[0].occurrences[0], { file: 'app/trips/page.tsx', line: 27, text: 'Delete', role: 'button' });
  const save = cands(inv, 'verb-variants').find(c => c.concept === 'save');
  assert.deepEqual(save.variants.map(v => v.forms.join('/')), ['Save', 'Submit']);
  const casing = cands(inv, 'casing-variants').find(c => c.concept === 'signin');
  assert.deepEqual(casing.variants.map(v => `${v.forms[0]} ${v.occurrences[0].file}:${v.occurrences[0].line}`), ['Sign In app/layout.tsx:11', 'Sign in app/settings/page.tsx:12']);
  const term = cands(inv, 'term-variants').find(c => c.concept === 'settings');
  assert.deepEqual(term.variants.map(v => v.forms[0]), ['preferences', 'settings']);
  assert.deepEqual(cands(inv, 'vague-error').map(c => `${c.file}:${c.line} ${c.text}`), ['app/trips/error.tsx:1 Something went wrong']);
  assert.deepEqual(cands(inv, 'raw-message').map(c => `${c.file}:${c.line} ${c.via} ${c.expression}`), ['app/trips/page.tsx:23 jsx error.message']);
});

const consistentApp = () => tree({
  'package.json': { dependencies: { next: '15.0.0' } },
  'app/layout.jsx': `export default function Root({ children }) { return <html><body><nav><a href="/">Home</a><a href="/notes">Notes</a></nav>{children}</body></html>; }\n`,
  'app/page.jsx': `export default function Home() { return <><h1>Notes</h1><a href="/login">Sign in</a><button type="button">Save</button></>; }\n`,
  'app/notes/page.jsx': `'use client';
import { useEffect, useState } from 'react';
export default function Notes() {
  const [notes, setNotes] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { fetch('/api/notes').then(r => r.json()).then(setNotes).catch(() => setFailed(true)); }, []);
  const onDelete = async (id) => { if (await confirmDelete(id)) setNotes(notes.filter(n => n.id !== id)); };
  const clearFilters = () => setNotes(notes);
  function confirmDelete(id) { return new Promise(r => r(window.confirm(\`Delete the note "\${id}"? You can't undo this.\`))); }
  if (failed) return <p>We couldn't load your notes. Check your connection and reload.</p>;
  if (!notes) return <p>Loading notes…</p>;
  if (notes.length === 0) return <p>No notes yet. Write your first one.</p>;
  return (
    <ul>
      {notes.map(n => <li key={n.id}>{n.text}<button onClick={() => onDelete(n.id)}>Delete</button></li>)}
      <li><button onClick={() => onDelete('all')}>Delete all notes</button></li>
      <li><a href="/login">Sign in</a></li>
      <li><button onClick={clearFilters}>Clear filters</button></li>
    </ul>
  );
}
`,
  'app/about/page.jsx': `export default function About() { return <><nav><a href="/">Home</a><a href="/notes">Notes</a></nav><p>Made by a small team.</p></>; }\n`,
});

test('candidates: a consistent app raises none (non-triggering)', () => {
  const inv = inventory(consistentApp());
  assert.deepEqual(inv.candidates, [], JSON.stringify(inv.candidates, null, 2));
  const notes = fileOf(inv, 'app/notes/page.jsx');
  assert.deepEqual(notes.states.map(s => `${s.line} ${s.state} ${s.by}`), ['10 error condition', '11 loading content', '12 empty condition']);
  assert.deepEqual(notes.actions.map(a => `${a.label} ${a.confirm.kind} ${a.confirm.line}`), ['Delete native 9', 'Delete all notes native 9']);
});

test('i18n calls whose key is the source text are copy; dotted keys are not', () => {
  const inv = inventory(nextApp({
    'app/i18n/page.tsx': `import { useTranslation } from 'react-i18next';
export default function P() {
  const { t } = useTranslation();
  return <><button type="button">{t('Archive trip')}</button><p>{t('trips.empty_state')}</p><input placeholder={t('Where to?')} /></>;
}
`,
  }));
  const f = fileOf(inv, 'app/i18n/page.tsx');
  assert.deepEqual(f.strings.map(s => `${s.line} ${s.kind} ${s.role} ${s.text}`), ['4 text button Archive trip', '4 prop text Where to?']);
});

test('drifted copy of a header: same links, one missing and one worded differently (L7)', () => {
  const inv = inventory(nextApp({
    'app/trips/[id]/page.tsx': `export default function Trip() {
  return (<><header><a href="/">Fernway</a><a href="/trips">Trips</a><a href="/login">Log in</a></header><p>One trip.</p></>);
}
`,
  }));
  const drift = cands(inv, 'drifted-copy');
  assert.equal(drift.length, 1);
  assert.deepEqual(drift[0].copies.map(c => `${c.file}:${c.line} only=${c.only.join(',')}`), ['app/layout.tsx:7 only=Settings', 'app/trips/[id]/page.tsx:2 only=']);
  assert.deepEqual(drift[0].worded, [{ here: 'Sign In', there: 'Log in' }]);
  assert.equal(inventory(consistentApp()).candidates.filter(c => c.kind === 'drifted-copy').length, 0, 'identical copies are not drift');
});

test('React Router app: routes from the router file, strings and states through its imports', () => {
  const root = tree({
    'package.json': { dependencies: { 'react-router-dom': '7.0.0' } },
    'src/main.jsx': `import { createBrowserRouter } from 'react-router-dom';
import Inbox from './pages/Inbox';
export const router = createBrowserRouter([{ path: '/', element: <Inbox /> }]);
`,
    'src/pages/Inbox.jsx': `import { useEffect, useState } from 'react';
export default function Inbox() {
  const [items, setItems] = useState([]);
  const [isLoading, setLoading] = useState(true);
  useEffect(() => { fetch('/api/inbox').then(r => r.json()).then(setItems).finally(() => setLoading(false)); }, []);
  const clearInbox = () => setItems([]);
  return (
    <div>
      {isLoading && <span>Fetching messages</span>}
      {!isLoading && !items.length && <p>Inbox zero!</p>}
      <button onClick={clearInbox}>Clear inbox</button>
      <button onClick={() => alert('Archived')}>Archive</button>
    </div>
  );
}
`,
    'src/pages/Inbox.test.jsx': `test('x', () => { render(<button>Remove</button>); });\n`,
  });
  const inv = inventory(root);
  assert.equal(inv.scope, 'routes');
  const inbox = fileOf(inv, 'src/pages/Inbox.jsx');
  assert.deepEqual(inbox.routes, ['/']);
  assert.deepEqual(inbox.states.map(s => `${s.line} ${s.state}`), ['9 loading', '10 empty']);
  assert.deepEqual(inbox.dialogs, [{ call: 'alert', line: 12, text: 'Archived' }]);
  assert.deepEqual(inbox.actions.map(a => `${a.line} ${a.label} ${a.confirm ? a.confirm.kind : 'none'}`), ['11 Clear inbox none']);
  assert.ok(cands(inv, 'no-error-state').some(c => c.file === 'src/pages/Inbox.jsx' && c.line === 5));
  assert.ok(!inv.files.some(f => /test/.test(f.file)), 'test files are not inventoried');
  // Without routes (tree mode) test files are still excluded.
  const tree_ = buildInventory(root, []);
  assert.equal(tree_.scope, 'tree');
  assert.deepEqual(tree_.files.map(f => f.file), ['src/pages/Inbox.jsx'], 'files with nothing user-facing are left out');
  assert.deepEqual(tree_.files[0].routes, []);
});

test('a file that does not parse is skipped with the reason; the rest is inventoried', () => {
  const inv = inventory(nextApp({
    'app/broken/page.tsx': `import { Bad } from './Bad';\nexport default function P() { return <Bad />; }\n`,
    'app/broken/Bad.tsx': `export function Bad() { return <div>Unclosed <span>tag</div>; }\n`,
    'app/notes/page.mdx': `# Notes\n`,
  }));
  const bad = inv.skipped.find(s => s.file === 'app/broken/Bad.tsx');
  assert.equal(bad.reason, 'parse-error');
  assert.equal(bad.line, 1);
  assert.match(bad.message, /Unterminated JSX/);
  assert.deepEqual(inv.skipped.find(s => s.file === 'app/notes/page.mdx'), { file: 'app/notes/page.mdx', reason: 'unsupported-type' });
  assert.ok(str(inv, 'app/trips/page.tsx', 'Trip deleted'), 'other files still inventoried');
});

test('secret-shaped strings are reported by kind only', () => {
  const fake = 'sk_live_' + 'Q'.repeat(24);
  const inv = inventory(nextApp({ 'app/keys/page.tsx': `export default function K() { return <p title="${fake}">Key: ${fake}</p>; }\n` }));
  const texts = fileOf(inv, 'app/keys/page.tsx').strings;
  assert.ok(texts.length >= 2);
  assert.ok(texts.every(s => !s.text.includes(fake) && s.secret === 'stripe-live-secret-key'), JSON.stringify(texts));
  assert.ok(!stableJson(inv).includes(fake));
});

test('deterministic: two builds are byte-identical, paths are posix and relative', () => {
  const root = nextApp();
  const a = stableJson(inventory(root));
  const b = stableJson(inventory(root));
  assert.equal(a, b);
  assert.ok(!a.includes(root), 'no absolute paths');
  assert.ok(!a.includes('\\\\'), 'posix paths');
});

test('CLI: nunchi inventory --json is the stable JSON; the text view lists candidates', () => {
  const root = nextApp();
  const run = (...a) => spawnSync(process.execPath, [join(ROOT, 'src', 'cli.mjs'), 'inventory', '--root', root, ...a], { encoding: 'utf8' });
  const j = run('--json');
  assert.equal(j.status, 0, j.stderr);
  assert.equal(j.stdout, stableJson(inventory(root)));
  const t = run();
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /candidates for the AI lenses \(not findings\)/);
  assert.match(t.stdout, /L5 verb-variants delete: "Delete" ×2 \(app\/trips\/page\.tsx:27\)/);
});

// Pebble's copy defects that no rule scores (answer key `rule: null`) should be visible in its inventory.
test('Pebble: seeded copy defects show up as inventory entries or candidates', () => {
  const inv = inventory(join(ROOT, 'bench', 'pebble'));
  const has = (kind, pred) => cands(inv, kind).some(pred);
  // P33 'Log in' / 'Login' / 'Sign in'
  assert.ok(has('verb-variants', c => c.concept === 'sign-in' && c.variants.length === 2));
  assert.ok(has('spelling-variants', c => c.concept === 'login'));
  // P34 'Save' and 'Submit' on one page
  assert.ok(has('verb-variants', c => c.concept === 'save' && c.variants.every(v => v.occurrences[0].file === 'app/app/settings/page.jsx')));
  // P35 'Something went wrong.'
  assert.ok(has('vague-error', c => c.file === 'app/app/page.jsx' && c.line === 15));
  // P36 'Are you sure?'
  assert.ok(has('vague-confirm', c => c.file === 'app/app/settings/page.jsx' && c.text === 'Are you sure?'));
  // P37 drifted header on /pricing
  assert.ok(has('drifted-copy', c => c.copies.some(x => x.file === 'app/pricing/page.jsx') && c.copies.some(x => x.file === 'components/SiteHeader.jsx')));
  // P38 'Clear all tasks' with no confirm and no undo
  assert.ok(has('unguarded-destructive', c => c.file === 'app/app/tasks/page.jsx' && c.label === 'Clear all tasks'));
  // P40 notes load with nothing shown meanwhile
  assert.ok(has('no-loading-state', c => c.file === 'app/app/notes/page.jsx'));
  // and P11/P26 from the source side
  assert.ok(has('raw-message', c => c.file === 'app/app/tasks/page.jsx'));
  assert.deepEqual(fileOf(inv, 'app/app/tasks/[id]/page.jsx').dialogs, [{ call: 'alert', line: 11, text: 'debug: task loaded' }]);
});
