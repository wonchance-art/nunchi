import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { routeMatcher, codeNavigations, buildFlow, isRedirected } from '../src/flow.mjs';
import { tmp } from './fixtures/tmp.mjs';

test('routeMatcher: literal routes win over dynamic ones, every router syntax', () => {
  const m = routeMatcher(['/', '/posts/[id]', '/posts/new', '/docs/[...slug]', '/shop/[[...rest]]', '/u/$userId', '/files/$', '/team/:id', '/opt/:id?']);
  assert.equal(m('/'), '/');
  assert.equal(m('/posts/new'), '/posts/new');
  assert.equal(m('/posts/42'), '/posts/[id]');
  assert.equal(m('/posts/42/'), '/posts/[id]');
  assert.equal(m('/posts/42?tab=1#c'), '/posts/[id]');
  assert.equal(m('/docs/a/b/c'), '/docs/[...slug]');
  assert.equal(m('/docs'), null, 'catch-all needs at least one segment');
  assert.equal(m('/shop'), '/shop/[[...rest]]');
  assert.equal(m('/shop/x/y'), '/shop/[[...rest]]');
  assert.equal(m('/u/7'), '/u/$userId');
  assert.equal(m('/files/a/b'), '/files/$');
  assert.equal(m('/team/3'), '/team/:id');
  assert.equal(m('/opt'), '/opt/:id?');
  assert.equal(m('/nowhere'), null);
});

test('codeNavigations: literal navigations in the files each route renders, with file:line', () => {
  const root = tmp('nunchi-nav-');
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'page.jsx'), [
    "import Link from 'next/link';",
    "export default function P({ id }) {",
    "  const go = () => router.push('/app/tasks');",
    "  if (!id) redirect(`/app/tasks/${id}`);",
    "  return <Link href=\"/pricing\">Pricing</Link>;",
    "}",
    "const ext = <a href=\"//cdn.example.invalid/x\">x</a>;",
  ].join('\n'));
  const nav = codeNavigations(root, { files: { 'app/page.jsx': ['/'] }, routes: { '/': ['app/page.jsx'] } });
  assert.deepEqual(nav, [
    { from: '/', to: '/app/tasks', file: 'app/page.jsx', line: 3 },
    { from: '/', to: '/app/tasks/x', file: 'app/page.jsx', line: 4 },
    { from: '/', to: '/pricing', file: 'app/page.jsx', line: 5 },
  ]);
});

const scene = (route, person = 'guest', viewport = 'm', extra = {}) => ({ id: `${route}.${person}.normal.${viewport}`, route, person, viewport, state: 'normal', status: 'captured', redirected: false, finalPath: route, httpStatus: 200, ...extra });
const link = (path, extra = {}) => ({ path, selector: `a[href="${path}"]`, visible: true, landmark: null, ...extra });

test('flow: dead links, unreachable routes and dead ends are found; their clean counterparts are not', () => {
  const routes = ['/', '/about', '/pricing', '/orphan', '/end', '/broken', '/posts/[id]', '/via-code', '/login'];
  const entries = [scene('/'), scene('/about'), scene('/pricing'), scene('/orphan'), scene('/end'), scene('/broken', 'guest', 'm', { httpStatus: 500 }), scene('/posts/[id]'),
    scene('/via-code'), scene('/private', 'guest', 'm', { redirected: true, finalPath: '/login' })];
  const sceneLinks = new Map([
    ['/.guest.normal.m', [link('/about'), link('/pricing'), link('/posts/7'), link('/gone'), link('/logo.svg'), link('/api/export'), link('/end'), link('/broken')]],
    ['/about.guest.normal.m', [link('/')]],
    ['/pricing.guest.normal.m', [link('/'), link('/hidden', { visible: false })]],
    ['/orphan.guest.normal.m', [link('/')]],
    ['/end.guest.normal.m', [link('/', { visible: false })]],
    ['/broken.guest.normal.m', []],
    ['/posts/[id].guest.normal.m', [link('/')]],
    ['/via-code.guest.normal.m', []],
  ]);
  const { flow, findings } = buildFlow({ entries, sceneLinks, routes, complete: true, code: [{ from: '/about', to: '/via-code', file: 'app/about/page.jsx', line: 4 }, { from: '/via-code', to: '/', file: 'app/via-code/page.jsx', line: 2 }] });
  const by = rule => findings.filter(f => f.rule === rule).map(f => f.route + (f.evidence.href ? ' ' + f.evidence.href : '')).sort();
  assert.deepEqual(by('link-to-missing-route'), ['/ /gone', '/pricing /hidden'], 'assets and /api links are not judged; hidden links still lead somewhere');
  assert.deepEqual(by('unreachable-route'), ['/orphan'], 'linked, code-navigated, redirected-to and entry routes are reachable');
  assert.deepEqual(by('dead-end'), ['/end'], 'an error page and a screen whose source navigates are not dead ends');
  assert.equal(flow.nodes.find(n => n.route === '/via-code').reachedBy, 'code');
  assert.equal(flow.nodes.find(n => n.route === '/login').reachedBy, 'redirect');
  assert.deepEqual(flow.order.slice(0, 6), ['/', '/about', '/pricing', '/posts/[id]', '/end', '/broken']);
});

test('isRedirected: the flag when the entry has it, else derived from path and finalPath (manifests written before the flag)', () => {
  assert.equal(isRedirected({ redirected: true, path: '/a', finalPath: '/a' }), true, 'the flag wins');
  assert.equal(isRedirected({ redirected: false, path: '/a', finalPath: '/login' }), false, 'the flag wins');
  assert.equal(isRedirected({ path: '/private', finalPath: '/login', reason: 'redirected to /login' }), true);
  assert.equal(isRedirected({ path: '/a?x=1', finalPath: '/a?tab=2#top', reason: null }), false, 'only the path part counts, as capture decides it');
  assert.equal(isRedirected({ path: '/a', finalPath: null, reason: 'no-dom' }), false, 'no page, no redirect');
  assert.equal(isRedirected({ reason: 'redirected to /login' }), true, 'no paths: the reason says so');
  assert.equal(isRedirected({ reason: 'login-expired' }), false);
});

test('flow: a manifest written before entries carried `redirected`: redirected scenes still lead to their targets and add no links', () => {
  // entries exactly as such a manifest has them: path, finalPath and reason, no `redirected` field
  const old = (route, finalPath, extra = {}) => {
    const { redirected, ...e } = scene(route, 'guest', 'm', { path: route, finalPath, reason: finalPath.split('?')[0] === route ? null : `redirected to ${finalPath}`, ...extra });
    return e;
  };
  const routes = ['/', '/a', '/private', '/billing', '/login', '/signup'];
  const entries = [old('/', '/'), old('/a', '/a?tab=1'), old('/private', '/login'), old('/billing', '/signup', { status: 'capture-failed' })];
  const sceneLinks = new Map([
    ['/.guest.normal.m', [link('/a')]],
    ['/a.guest.normal.m', [link('/')]],
    ['/private.guest.normal.m', [link('/'), link('/gone')]],   // the sign-in page's links, not /private's
  ]);
  const { flow, findings } = buildFlow({ entries, sceneLinks, routes, complete: true });
  assert.deepEqual(flow.edges.map(e => `${e.from} ${e.to}`), ['/ /a', '/a /'], 'no links are read from a redirected scene');
  assert.equal(flow.nodes.find(n => n.route === '/login').reachedBy, 'redirect');
  assert.equal(flow.nodes.find(n => n.route === '/signup').reachedBy, 'redirect', 'a strict-path redirect still leads to its target');
  assert.equal(flow.nodes.find(n => n.route === '/private').captured, false);
  assert.deepEqual(findings.map(f => `${f.rule} ${f.route}`).sort(), ['unreachable-route /billing', 'unreachable-route /private']);
});

test('flow: without the app\'s route list, or for a partial capture, nothing is called missing or unreachable', () => {
  const entries = [scene('/'), scene('/a')];
  const sceneLinks = new Map([['/.guest.normal.m', [link('/elsewhere')]], ['/a.guest.normal.m', [link('/')]]]);
  const partial = buildFlow({ entries, sceneLinks, routes: ['/', '/a'], complete: false });
  assert.deepEqual(partial.findings.filter(f => f.rule !== 'dead-end'), []);
  const changed = buildFlow({ entries, sceneLinks, routes: ['/', '/a', '/b'], complete: true, wholeApp: false });
  assert.deepEqual(changed.findings.map(f => f.rule), ['link-to-missing-route'], 'dead links are still judged, unreachable is not');
});

test('flow: shared navigation is marked per section, order and groups do not depend on input order', () => {
  const app = ['/app', '/app/a', '/app/b'];
  const routes = ['/', '/about', ...app];
  const entries = [scene('/'), scene('/about'), ...app.map(r => scene(r, 'signed-in'))];
  const nav = app.map(r => link(r, { landmark: 'nav' }));
  const sceneLinks = new Map([['/.guest.normal.m', [link('/about', { landmark: 'header' }), link('/app')]], ['/about.guest.normal.m', [link('/', { landmark: 'header' })]],
    ...app.map(r => [`${r}.signed-in.normal.m`, nav])]);
  const a = buildFlow({ entries, sceneLinks, routes, complete: true });
  const b = buildFlow({ entries: [...entries].reverse(), sceneLinks, routes: [...routes].reverse(), complete: true });
  assert.deepEqual(a.flow, b.flow);
  assert.ok(a.flow.edges.filter(e => e.from.startsWith('/app')).every(e => e.global), 'the app menu is shared navigation');
  assert.ok(!a.flow.edges.find(e => e.from === '/' && e.to === '/app').global, 'a content link is not');
  assert.deepEqual(a.flow.groups, [{ id: '/', routes: ['/', '/about'] }, { id: '/app', routes: ['/app', '/app/a', '/app/b'] }]);
});
