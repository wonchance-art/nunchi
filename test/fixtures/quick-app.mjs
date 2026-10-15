// An invented app for the quick-run tests (M5): a Next.js source tree discover reads, and a server that renders each
// route with a header, a footer and a data request of its own. Every data answer carries a counter that changes on
// each request (only replay makes two captures alike) and a token that must never reach a recording.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './board-project.mjs';

export const ROUTES = ['/', '/about', '/app', '/app/notes', '/app/settings', '/app/tasks', '/blog', '/blog/[slug]', '/careers', '/contact', '/help', '/legal', '/pricing', '/zebra'];
export const SAMPLES = { '/blog/[slug]': '/blog/first-light' };

// The source tree: app/<route>/page.tsx. `extra` adds routes (to change the app between captures).
export function quickApp({ extra = [] } = {}) {
  const root = tmp('nunchi-quick-app-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }));
  for (const r of [...ROUTES, ...extra]) {
    const dir = join(root, 'app', ...r.split('/').filter(Boolean));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'page.tsx'), `export default function Page() {\n  return <main><h1>${r}</h1></main>;\n}\n`);
  }
  return root;
}

const page = (path, { lowContrast = false } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fernleaf ${path}</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1d1f23;background:#fff}main{padding:16px}a{color:#1d4ed8}.faint{color:${lowContrast ? '#d4d4d8' : '#1d1f23'}}</style></head>
<body><header><a href="/">Fernleaf</a> <nav><a href="/pricing">Pricing</a> <a href="/about">About</a> <a href="/zebra/nowhere">Old link</a></nav></header>
<main><h1>Fernleaf ${path}</h1><p class="faint">A calm place for small plans.</p><div id="data">Loading…</div></main>
<footer><a href="/legal">Legal</a> <a href="/help">Help</a></footer>
<script>fetch('/api/data${path === '/' ? '/home' : path}').then(r => r.json()).then(d => { document.getElementById('data').textContent = 'Synced #' + d.sync; }).catch(() => { document.getElementById('data').textContent = 'Offline'; });</script>
</body></html>`;

// → { base, hits: Map(api path → count), close(), set(opts) } — `set({ lowContrast })` changes the pages.
export async function quickServer() {
  const hits = new Map();
  let opts = {};
  let sync = 0;
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path.startsWith('/api/data')) {
      hits.set(path, (hits.get(path) || 0) + 1);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ sync: ++sync, access_token: 'tok-quick-must-not-be-recorded' }));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(path, opts));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close(), set: o => { opts = o; } };
}
