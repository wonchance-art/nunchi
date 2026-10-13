// Pegroom demo server: serves the built SPA from dist/ and a small JSON API backed by in-memory,
// invented data. No dependencies, no network beyond the port it listens on.
//   node server.mjs --port 3427
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(HERE, 'dist');
const portAt = process.argv.indexOf('--port');
const PORT = Number(portAt > 0 ? process.argv[portAt + 1] : process.env.PORT || 3427);
const HOST = '127.0.0.1';

const SESSION_COOKIE = 'pegroom_sid';
const MEMBERS = { 'member-ines': { id: 'm-118', firstName: 'Ines', lastName: 'Okafor-Lind', email: 'ines@okafor-lind.name' } };

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

// Pages the SPA answers for. Anything else gets the app shell with a 404 status so the client can show
// its own "not found" page.
const SPA_ROUTES = [
  /^\/$/, /^\/about$/, /^\/help$/, /^\/plans$/, /^\/tools$/, /^\/sign-in$/,
  /^\/dashboard$/, /^\/bookings$/, /^\/bookings\/[^/]+$/, /^\/book$/, /^\/loans$/, /^\/history$/, /^\/settings$/,
  /^\/account\/billing$/,
];
const PRIVATE = /^\/(dashboard|bookings|book|loans|history|settings|account)(\/|$)/;

// ---------------------------------------------------------------- invented data

const announcements = [
  {
    id: 'n-31', title: 'Workshop closed 20–24 January',
    body: 'The main hall is closed while the floor is resurfaced. Pick-ups and returns move to the side entrance on Mill Lane.',
    link: '/help',
  },
];

const plans = [
  { id: 'borrower', name: 'Borrower', price: 6, popular: false, features: ['Borrow up to 3 tools at a time', '7-day loans, renew twice', 'Free induction for power tools'] },
  { id: 'workshop', name: 'Workshop', price: 14, popular: true, features: ['Everything in Borrower', '6 hours of bench time a month', 'Use of the dust extractor and bandsaw'] },
  { id: 'household', name: 'Household', price: 22, popular: false, features: ['Up to 4 people on one membership', '12 hours of bench time a month', 'Priority booking for evening slots'] },
  { id: 'plan-4', name: 'Plan name', price: 0, popular: false, features: ['Feature 1', 'Feature 2', 'Feature 3'] },
];

const tools = [
  { id: 't-01', name: 'Cordless drill driver', category: 'Woodwork', location: 'Shelf A2', deposit: false, image: '/img/tools/drill.svg' },
  { id: 't-02', name: 'Orbital sander', category: 'Woodwork', location: 'Shelf A4', deposit: false, image: '/img/tools/sander.svg' },
  { id: 't-03', name: 'Biscuit joiner', category: 'Woodwork', location: 'Shelf B1', deposit: true, image: '/img/tools/biscuit-joiner.svg' },
  { id: 't-04', name: 'Tile cutter', category: 'Metalwork', location: { shelf: 'D', bay: 2 }, deposit: true, image: '/img/tools/tile-cutter.svg' },
  { id: 't-05', name: 'Bench vice, 100 mm', category: 'Metalwork', location: 'Shelf C3', deposit: false, image: '/img/tools/vice.svg' },
  { id: 't-06', name: 'Hedge trimmer', category: 'Garden', location: 'Shed 1', deposit: true, image: '/img/tools/trimmer.svg' },
];

const bookings = [
  { id: 'bk-2081', bench: 'Bench A · woodwork', date: '2026-01-17', start: '14:00', end: '16:00', duration: 120, status: 'confirmed', steward: 'Tomasz Brannagh', bring: ['Safety glasses', 'Your own timber', 'Dust mask'], notes: 'Cutting dovetails for a spice rack.' },
  { id: 'bk-2084', bench: 'Bench C · metalwork', date: '2026-01-21', start: '18:00', end: '20:00', duration: 120, status: 'confirmed', steward: 'Rhiannon Achebe', bring: ['Safety glasses', 'Gloves'], notes: 'Drilling brackets.' },
  { id: 'bk-2090', bench: 'Sewing table', date: '2026-01-28', start: '10:00', end: '12:00', duration: 120, status: 'pending', steward: 'Ama Lindqvist', bring: ['Fabric and thread'], notes: 'Hemming curtains.' },
];

const benches = [
  { id: 'bench-a', name: 'Bench A · woodwork' },
  { id: 'bench-b', name: 'Bench B · woodwork' },
  { id: 'bench-c', name: 'Bench C · metalwork' },
  { id: 'sewing', name: 'Sewing table' },
];
const DAYS = ['Mon 19', 'Tue 20', 'Wed 21', 'Thu 22', 'Fri 23', 'Sat 24', 'Sun 25'];
const TIMES = ['10:00', '14:00', '18:00', '20:00'];
const slots = DAYS.flatMap((day, d) => TIMES.map((time, t) => ({ day, time, free: (d * 3 + t) % 4 !== 0 })));

const loans = [
  { id: 'ln-501', tool: 'Orbital sander, 125 mm, with dust bag and spare sheets', due: '2026-01-19', renewals: 1 },
  { id: 'ln-502', tool: 'Tile cutter', due: '2026-01-12', renewals: 2 },
  { id: 'ln-503', tool: 'Cordless drill driver with two batteries', due: '2026-01-22', renewals: 0 },
];

const history = [
  { id: 'ln-470', tool: 'Wallpaper steamer', borrowed: '2025-11-02', returned: '2025-11-08' },
  { id: 'ln-455', tool: 'Hedge trimmer', borrowed: '2025-09-14', returned: '2025-09-20' },
  { id: 'ln-431', tool: 'Bench vice, 100 mm', borrowed: '2025-07-01', returned: '2025-07-05' },
];

const profile = {
  displayName: 'Ines Okafor-Lind', email: 'ines@okafor-lind.name', phone: '07700 900418',
  memberSince: '15/03/2024', newsletter: true, plan: 'Workshop',
  household: [{ name: 'Kofi Okafor-Lind', role: 'Partner' }],
};

// ---------------------------------------------------------------- helpers

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const memberOf = req => MEMBERS[cookies(req)[SESSION_COOKIE]] || null;

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', ...headers });
  res.end(buf);
}
const json = (res, status, body, headers) => send(res, status, body, 'application/json; charset=utf-8', headers);

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

// ---------------------------------------------------------------- API

async function api(req, res, path) {
  const member = memberOf(req);
  const needMember = () => { if (!member) { json(res, 401, { message: 'Sign in to continue.' }); return false; } return true; };

  if (path === '/api/sign-in' && req.method === 'POST') {
    const { email, password } = await readBody(req);
    if (!email || !password) return json(res, 400, { message: 'Enter your email and password.' });
    return json(res, 200, { ok: true }, { 'set-cookie': `${SESSION_COOKIE}=member-ines; Path=/; SameSite=Lax` });
  }
  if (path === '/api/sign-out' && req.method === 'POST') {
    return json(res, 200, { ok: true }, { 'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax` });
  }
  if (path === '/api/announcements') return json(res, 200, { announcements });
  if (path === '/api/plans') return json(res, 200, { plans });
  if (path === '/api/tools') return json(res, 200, { tools, total: tools.length });

  if (path === '/api/dashboard') {
    if (!needMember()) return;
    return json(res, 200, {
      member: { firstName: member.firstName, plan: 'Workshop' },
      welcome: 'Welcome back, {{first_name}}! Here is your week at Pegroom.',
      status: 'MBR_ACTIVE_PAID',
      upcoming: bookings.slice(0, 2).map(b => ({ id: b.id, bench: b.bench, date: b.date, start: b.start })),
      loans: loans.map(l => ({ id: l.id, tool: l.tool, due: l.due })),
    });
  }
  if (path === '/api/streak') {
    if (!needMember()) return;
    return json(res, 200, { weeks: 6 });
  }
  if (path === '/api/bookings' && req.method === 'POST') {
    if (!needMember()) return;
    return json(res, 200, { ok: true, id: 'bk-2101' });
  }
  if (path === '/api/bookings' && req.method === 'GET') {
    if (!needMember()) return;
    return json(res, 200, { bookings: bookings.map(({ bring, notes, ...b }) => b) });
  }
  let m;
  if ((m = path.match(/^\/api\/bookings\/([^/]+)$/))) {
    if (!needMember()) return;
    const i = bookings.findIndex(b => b.id === m[1]);
    if (i < 0) return json(res, 404, { message: 'No such booking.' });
    if (req.method === 'DELETE') { bookings.splice(i, 1); return json(res, 200, { ok: true }); }
    return json(res, 200, { booking: bookings[i] });
  }
  if (path === '/api/reservations' && req.method === 'POST') {
    if (!needMember()) return;
    return json(res, 200, { ok: true });
  }
  if (path === '/api/benches') {
    if (!needMember()) return;
    return json(res, 200, { benches, slots });
  }
  if (path === '/api/loans') {
    if (!needMember()) return;
    return json(res, 200, { loans });
  }
  if ((m = path.match(/^\/api\/loans\/([^/]+)\/renew$/)) && req.method === 'POST') {
    if (!needMember()) return;
    const loan = loans.find(l => l.id === m[1]);
    if (!loan) return json(res, 404, { message: 'No such loan.' });
    return json(res, 200, { ok: true, renewals: loan.renewals + 1 });
  }
  if (path === '/api/history') {
    if (!needMember()) return;
    return json(res, 200, { loans: history });
  }
  if (path === '/api/profile') {
    if (!needMember()) return;
    if (req.method === 'DELETE') return json(res, 200, { ok: true }, { 'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax` });
    return json(res, 200, { profile });
  }
  if (path === '/api/billing') {
    // still reads the session cookie name from before the rename
    if (!cookies(req).pegroom_session) return json(res, 401, { message: 'Sign in to continue.' });
    return json(res, 200, { billing: { plan: 'Workshop', card: 'card ending 4242', next: '2026-02-01' } });
  }
  return json(res, 404, { message: 'Not found.' });
}

// ---------------------------------------------------------------- static files and the SPA shell

async function fileAt(path) {
  const p = normalize(join(DIST, path));
  if (!p.startsWith(DIST)) return null;
  try { const s = await stat(p); return s.isFile() ? p : null; } catch { return null; }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}`);
    const path = decodeURIComponent(url.pathname);
    if (path.startsWith('/api/')) return await api(req, res, path);

    if (path !== '/') {
      const file = await fileAt(path);
      if (file) return send(res, 200, await readFile(file), TYPES[extname(file)] || 'application/octet-stream', { 'cache-control': 'public, max-age=60' });
      if (extname(path)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }

    const member = memberOf(req);
    if (PRIVATE.test(path) && !member) return send(res, 302, '', 'text/plain', { location: `/sign-in?next=${encodeURIComponent(path)}` });
    if (path === '/sign-in' && member) return send(res, 302, '', 'text/plain', { location: '/dashboard' });

    const shell = await readFile(join(DIST, 'index.html'));
    const known = SPA_ROUTES.some(re => re.test(path));
    return send(res, known ? 200 : 404, shell, TYPES['.html']);
  } catch (e) {
    send(res, 500, 'Server error', 'text/plain; charset=utf-8');
  }
});

server.listen(PORT, HOST, () => process.stdout.write(`pegroom on http://${HOST}:${PORT}\n`));
