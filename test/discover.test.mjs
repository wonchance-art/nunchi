import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { discover, detectFramework } from '../src/discover.mjs';

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'nunchi-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}
const paths = r => r.routes.map(x => x.path);
const reasons = r => Object.fromEntries(r.excluded.map(x => [x.file, x.reason]));

test('next app router: groups, dynamic segments, private/parallel/intercepting, api handlers', () => {
  const root = tree({
    'package.json': { dependencies: { next: '15.0.0' } },
    'src/app/page.tsx': '',
    'src/app/(marketing)/pricing/page.tsx': '',
    'src/app/posts/[id]/page.tsx': '',
    'src/app/docs/[...slug]/page.mdx': '',
    'src/app/shop/[[...filters]]/page.jsx': '',
    'src/app/_components/page.tsx': '',
    'src/app/dashboard/@modal/page.tsx': '',
    'src/app/feed/(..)photo/[id]/page.tsx': '',
    'src/app/api/hello/route.ts': '',
    'src/app/posts/[id]/page.test.tsx': '',
    'src/app/layout.tsx': '',
  });
  const r = discover(root);
  assert.equal(r.framework, 'next');
  assert.deepEqual(paths(r), ['/', '/docs/[...slug]', '/posts/[id]', '/pricing', '/shop/[[...filters]]']);
  assert.deepEqual(r.routes.find(x => x.path === '/posts/[id]').params, [{ name: 'id', kind: 'single' }]);
  assert.deepEqual(r.routes.find(x => x.path === '/docs/[...slug]').params, [{ name: 'slug', kind: 'catch-all' }]);
  assert.deepEqual(reasons(r), {
    'src/app/_components/page.tsx': 'private-folder',
    'src/app/api/hello/route.ts': 'api-route-handler',
    'src/app/dashboard/@modal/page.tsx': 'parallel-route-slot',
    'src/app/feed/(..)photo/[id]/page.tsx': 'intercepting-route',
  });
  assert.equal(r.fallback, null);
});

test('next pages router: index, dynamic, api and framework files', () => {
  const root = tree({
    'package.json': { dependencies: { next: '14.2.0' } },
    'pages/index.tsx': '',
    'pages/about.tsx': '',
    'pages/blog/index.tsx': '',
    'pages/blog/[slug].tsx': '',
    'pages/_app.tsx': '',
    'pages/404.tsx': '',
    'pages/api/users.ts': '',
  });
  const r = discover(root);
  assert.deepEqual(paths(r), ['/', '/about', '/blog', '/blog/[slug]']);
  assert.deepEqual(reasons(r), { 'pages/404.tsx': 'error-page', 'pages/_app.tsx': 'framework-file', 'pages/api/users.ts': 'api-route' });
});

test('tanstack start: dots, params, splat, pathless layouts, groups, ignored files', () => {
  const root = tree({
    'package.json': { dependencies: { '@tanstack/react-start': '1.0.0' } },
    'src/routes/__root.tsx': '',
    'src/routes/index.tsx': '',
    'src/routes/about.tsx': '',
    'src/routes/posts.$postId.tsx': '',
    'src/routes/posts/index.tsx': '',
    'src/routes/_auth.tsx': '',
    'src/routes/_auth.settings.tsx': '',
    'src/routes/files/$.tsx': '',
    'src/routes/(app)/inbox.tsx': '',
    'src/routes/-components/Button.tsx': '',
    'src/routes/editor.lazy.tsx': '',
  });
  const r = discover(root);
  assert.equal(r.framework, 'tanstack-start');
  assert.deepEqual(paths(r), ['/', '/about', '/editor', '/files/$', '/inbox', '/posts', '/posts/$postId', '/settings']);
  assert.deepEqual(r.routes.find(x => x.path === '/posts/$postId').params, [{ name: 'postId', kind: 'single' }]);
  assert.deepEqual(reasons(r), { 'src/routes/__root.tsx': 'root-layout', 'src/routes/_auth.tsx': 'pathless-layout' });
});

test('react router: absolute and relative paths, params, catch-all 404', () => {
  const root = tree({
    'package.json': { dependencies: { 'react-router-dom': '6.26.0', vite: '5.0.0' } },
    'src/main.tsx': `import { createBrowserRouter } from 'react-router-dom';
      const router = createBrowserRouter([
        { path: '/', element: <Home /> },
        { path: '/projects/:projectId', element: <Project />, children: [ { path: 'settings', element: <S /> } ] },
        { path: '*', element: <NotFound /> },
      ]);`,
    'src/Other.tsx': `<Routes><Route path="/team/:id?" element={<Team />} /></Routes> // react-router`,
    'src/unrelated.ts': `const shape = { path: '/not-a-route' };`,
  });
  const r = discover(root);
  assert.equal(r.framework, 'react-router');
  assert.deepEqual(paths(r), ['/', '/projects/:projectId', '/team/:id?', 'settings']);
  assert.equal(r.routes.find(x => x.path === 'settings').needsResolution, 'relative-path');
  assert.deepEqual(r.routes.find(x => x.path === '/team/:id?').params, [{ name: 'id', kind: 'optional' }]);
  assert.deepEqual(r.excluded.map(x => x.reason), ['not-found-catch-all']);
});

test('unknown framework falls back to crawl', () => {
  const root = tree({ 'package.json': { dependencies: { express: '4.0.0' } }, 'index.html': '<a href="/x">x</a>' });
  const r = discover(root);
  assert.equal(detectFramework(root), 'unknown');
  assert.deepEqual(r.routes, []);
  assert.equal(r.fallback, 'crawl');
});

test('deterministic: same tree gives byte-identical output', () => {
  const root = tree({
    'package.json': { dependencies: { next: '15.0.0' } },
    'app/b/page.tsx': '', 'app/a/page.tsx': '', 'app/c/[x]/page.tsx': '',
  });
  assert.equal(JSON.stringify(discover(root)), JSON.stringify(discover(root)));
  assert.deepEqual(paths(discover(root)), ['/a', '/b', '/c/[x]']);
});
