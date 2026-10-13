import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { discover } from '../src/discover.mjs';
import { buildSourceMap, affectedRoutes, importsOf } from '../src/sourcemap.mjs';

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'nunchi-map-'));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

test('importsOf: static, multi-line, re-export, dynamic, require, css @import', () => {
  const src = `import a from './a';\nimport {\n  b,\n  c,\n} from "@/lib/b";\nimport './side.css';\nexport * from './re';\nexport { x } from './x';\nconst L = dynamic(() => import('./lazy'));\nconst r = require('../r');\nimport type { T } from './types';`;
  assert.deepEqual(importsOf(src), ['../r', './a', './lazy', './re', './side.css', './types', './x', '@/lib/b']);
  assert.deepEqual(importsOf(`@import url("./base.css");`), ['./base.css']);
});

const nextApp = () => tree({
  'package.json': { dependencies: { next: '15.0.0' } },
  'tsconfig.json': `{
    // comments and trailing commas are allowed here
    "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"], "~ui/*": ["./src/components/ui/*"], }, },
  }`,
  'src/app/layout.tsx': `import './globals.css';\nimport { Nav } from '@/components/Nav';`,
  'src/app/globals.css': `body { margin: 0 }`,
  'src/app/page.tsx': `import { Hero } from '@/components/Hero';`,
  'src/app/(app)/layout.tsx': `import { Sidebar } from '@/components/Sidebar';`,
  'src/app/(app)/tasks/page.tsx': `import { TaskList } from '@/components/TaskList';\nimport { Button } from '~ui/button';`,
  'src/app/(app)/tasks/loading.tsx': `export default () => null;`,
  'src/app/(app)/settings/page.tsx': `import { Button } from '~ui/button';\nimport { format } from 'date-fns';`,
  'src/components/Nav.tsx': `import Link from 'next/link';`,
  'src/components/Hero.tsx': `import { Button } from './ui/button';`,
  'src/components/Sidebar.tsx': ``,
  'src/components/TaskList.tsx': `import { notify } from '@/lib/notify';`,
  'src/components/ui/button.tsx': ``,
  'src/lib/notify.ts': ``,
  'src/middleware.ts': ``,
});

test('next app router: layouts, loading, middleware, aliases and transitive imports; packages ignored', () => {
  const root = nextApp();
  const map = buildSourceMap(root, discover(root).routes);
  assert.deepEqual(map.routes['/tasks'], [
    'src/app/(app)/layout.tsx', 'src/app/(app)/tasks/loading.tsx', 'src/app/(app)/tasks/page.tsx',
    'src/app/globals.css', 'src/app/layout.tsx',
    'src/components/Nav.tsx', 'src/components/Sidebar.tsx', 'src/components/TaskList.tsx', 'src/components/ui/button.tsx',
    'src/lib/notify.ts', 'src/middleware.ts',
  ]);
  assert.ok(!map.routes['/'].includes('src/components/Sidebar.tsx'), 'the (app) layout does not wrap the root page');
  assert.deepEqual(map.files['src/components/ui/button.tsx'], ['/', '/settings', '/tasks']);
  assert.deepEqual(map.files['src/lib/notify.ts'], ['/tasks']);
});

test('affectedRoutes: by file, and config changes affect everything', () => {
  const root = nextApp();
  const map = buildSourceMap(root, discover(root).routes);
  assert.deepEqual(affectedRoutes(map, ['src/lib/notify.ts']).routes, ['/tasks']);
  assert.deepEqual(affectedRoutes(map, ['src/app/globals.css']).routes, ['/', '/settings', '/tasks']);
  assert.deepEqual(affectedRoutes(map, ['README.md']).routes, []);
  const cfg = affectedRoutes(map, ['next.config.mjs']);
  assert.deepEqual(cfg.routes, ['/', '/settings', '/tasks']);
  assert.match(cfg.reason, /config changed/);
});

test('tanstack: root and parent routes frame a child route', () => {
  const root = tree({
    'package.json': { dependencies: { '@tanstack/react-start': '1.0.0' } },
    'src/routes/__root.tsx': `import '../styles.css';`,
    'src/styles.css': ``,
    'src/routes/index.tsx': ``,
    'src/routes/posts.tsx': `import { PostsShell } from '../components/PostsShell';`,
    'src/routes/posts.$postId.tsx': `import { Post } from '../components/Post';`,
    'src/components/PostsShell.tsx': ``,
    'src/components/Post.tsx': ``,
  });
  const map = buildSourceMap(root, discover(root).routes);
  assert.deepEqual(map.routes['/posts/$postId'], ['src/components/Post.tsx', 'src/components/PostsShell.tsx', 'src/routes/__root.tsx', 'src/routes/posts.$postId.tsx', 'src/routes/posts.tsx', 'src/styles.css']);
  assert.deepEqual(map.routes['/'], ['src/routes/__root.tsx', 'src/routes/index.tsx', 'src/styles.css']);
});

test('deterministic and cycle-safe', () => {
  const root = tree({
    'package.json': { dependencies: { next: '15.0.0' } },
    'app/page.tsx': `import './a';`, 'app/a.ts': `import './b';`, 'app/b.ts': `import './a';`,
  });
  const a = JSON.stringify(buildSourceMap(root, discover(root).routes));
  assert.equal(a, JSON.stringify(buildSourceMap(root, discover(root).routes)));
  assert.deepEqual(JSON.parse(a).routes['/'], ['app/a.ts', 'app/b.ts', 'app/page.tsx']);
});

test('cli capture --changed-since --plan: only routes whose files changed, uncommitted and untracked included', () => {
  const root = nextApp();
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  writeFileSync(join(root, 'src/lib/notify.ts'), 'export const notify = () => {};');
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const plan = JSON.parse(execFileSync('node', [cli, 'capture', '--root', root, '--changed-since', 'HEAD', '--plan'], { cwd: root, encoding: 'utf8' }).split('\n').slice(1).join('\n'));
  assert.deepEqual(plan.scenes.map(s => s.route), ['/tasks']);
  assert.deepEqual(plan.skipped.map(s => [s.route, s.reason]), [['/', 'unchanged'], ['/settings', 'unchanged']]);
  writeFileSync(join(root, 'src/components/ui/button.tsx'), 'export const Button = 1;');
  writeFileSync(join(root, 'src/components/New.tsx'), '');
  const plan2 = JSON.parse(execFileSync('node', [cli, 'capture', '--root', root, '--changed-since', 'HEAD', '--plan'], { cwd: root, encoding: 'utf8' }).split('\n').slice(1).join('\n'));
  assert.deepEqual(plan2.scenes.map(s => s.route), ['/', '/settings', '/tasks']);
});
