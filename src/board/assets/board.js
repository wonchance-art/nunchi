// nunchi board: the page's script (design 0.1-c §3). Served as /assets/board.js under a CSP with no inline script or
// style. Everything the server sends is data: it reaches the page through textContent only (no markup is ever parsed
// from it), links are internal routes or an editor link the server built, and geometry goes through CSSOM.
import * as W from './shared.mjs';

const d = document;
d.documentElement.classList.add('js');
const $ = id => d.getElementById(id);
const main = () => $('main');
const TOAST = $('toast');
// Every view is drawn through here. The undo toast then sits in the view's dock, right above the decision bar and
// moving with it (never over it, whatever the bar's height), or at the bottom of the window when the view has no bar;
// and the dock's height keeps focus and scrolling clear of it (scroll-padding-bottom, WCAG 2.4.11).
let dockObserver = null;
function show(...nodes) {
  // a redraw (a live update, an undo) never drops the focus to the page: the same control again, or the row, or the
  // view's heading
  const was = d.activeElement, inside = was instanceof Element && was !== main() && main().contains(was);
  main().replaceChildren(...nodes);
  if (inside && !main().contains(d.activeElement)) {
    const again = (was.id && $(was.id)) || (was.classList.contains('row') && S.focus && $(`row-${S.focus}`));
    if (again && /^H[1-6]$/.test(again.tagName)) again.setAttribute('tabindex', '-1');      // a heading the focus was on
    if (again) again.focus({ preventScroll: true }); else focusHeading();
  }
  const dock = main().querySelector('.dock');
  if (dock) dock.prepend(TOAST); else if (TOAST.parentElement !== d.body) d.body.append(TOAST);
  dockObserver?.disconnect();
  fitDock();
  if (dock && 'ResizeObserver' in window) { dockObserver = new ResizeObserver(fitDock); dockObserver.observe(dock); }
}
// The dock's height now (it grows while the toast shows), and the focused row brought out from under it.
function fitDock() {
  const dock = main().querySelector('.dock');
  d.documentElement.style.setProperty('--dock-h', `${dock ? Math.ceil(dock.getBoundingClientRect().height) : 0}px`);
  const f = d.activeElement;
  if (dock && f instanceof Element && f.closest('.row') && f.getBoundingClientRect().bottom > dock.getBoundingClientRect().top) f.scrollIntoView({ block: 'nearest' });
}
const nowMs = () => performance.now();
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

const S = {
  token: null, mode: 'board', labeller: null, version: null, summary: null,
  route: { view: 'progress' },
  params: { status: store.get('nunchi.status') || 'open', group: store.get('nunchi.group') || 'kind', q: '' },
  list: null,            // the frozen list: { sections, unchecked, groups, ids }
  pending: null,         // a newer list, shown on R
  focus: null, selection: new Set(), anchor: null, openUnchecked: false,
  detail: null, details: new Map(),
  screens: null, screenSel: null, screenFilter: { vp: null, who: 'all', state: 'normal' },
  keysOn: store.get('nunchi.keys') !== 'off',
  undo: null, clock: new W.DecisionClock(), images: new Map(), lastNow: 0, stopped: false,
  label: null,
};

// ---- DOM, without parsing markup -----------------------------------------------------------------------------------

function h(tag, props, ...kids) {
  const el = d.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'href') { if (/^#\//.test(v) || /^vscode:\/\/file\//.test(v) || v === '#main') el.setAttribute('href', v); }
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const SEVS = new Set(W.SEVERITIES);
const sevOf = s => (SEVS.has(s) ? s : 'low');
const STATUS_CLASS = new Set(['open', 'regressed', 'to-fix', 'held', 'kept', 'dismissed', 'fixed', 'stale', 'mixed']);
const statusText = s => W.STATUS_LABEL[s] || W.MORE_STATUS[s] || 'Mixed';
const sevChip = s => h('span', { class: `sev sev-${sevOf(s)}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), W.SEV_LABEL[sevOf(s)]);
const statusChip = s => h('span', { class: `st st-${STATUS_CLASS.has(s) ? s : 'mixed'}` }, statusText(s));
const statusChips = g => (g.status === 'mixed' ? Object.keys(g.statuses || {}).sort().map(statusChip) : [statusChip(g.status)]);
const sourceTag = g => (g.source !== 'ai' ? h('span', { class: 'tag' }, 'Rule')
  : g.checked ? h('span', { class: 'tag tag-ai' }, `AI · double-checked${g.suspect ? ' (suspect)' : ''}`) : h('span', { class: 'tag tag-warn' }, `AI · not double-checked${g.tooFewDecoys ? ` (${W.WORDS['too-few-decoys']})` : ''}`));
const decisionTag = g => {
  const dc = g.decision;
  if (!dc || !dc.channel) return null;
  if (dc.channel === 'cli-agent') return h('span', { class: 'tag tag-warn' }, 'Recorded by your AI');
  if (dc.channel === 'git' || dc.channel === 'unknown') return h('span', { class: 'tag tag-warn' }, dc.channel === 'git' ? 'From git' : 'Not confirmed');
  return null;
};
const whereText = g => {
  if (g.where.whole) return g.where.whole;
  return `${g.where.routes.join(', ')}${g.where.more ? ` +${g.where.more} more` : ''}${g.screens ? ` · ${W.plural(g.screens, 'screen')}` : ''}`;
};
// A decision's time as the person reads it: relative when recent, else local (the file keeps KST).
function when(at) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return at || '';
  return W.relativeTime(at, Date.now()) ?? new Date(t).toLocaleString();
}
function announce(text) { const a = $('announce'); a.textContent = ''; setTimeout(() => { a.textContent = text; }, 30); }
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); if (btn) { const was = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = was; }, 1500); } announce('Copied'); }
  catch { announce('Copy failed: select the text and copy it yourself'); }
}
const copyButton = (text, label = 'Copy') => { const b = h('button', { type: 'button', class: 'b' }, label); b.addEventListener('click', () => copy(text, b)); return b; };

// ---- the server ------------------------------------------------------------------------------------------------------

// No answer at all (the board stopped, the network, a laptop waking up) is said in words, never as the browser's
// "Failed to fetch"; status 0.
const NO_ANSWER = 'the board did not answer (is it still running? nunchi open starts it)';
async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, { method, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { 'X-Nunchi-Token': S.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw Object.assign(new Error(NO_ANSWER), { status: 0 }); }
  if (res.status === 401) { lost('expired'); throw Object.assign(new Error('no key'), { status: 401 }); }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data?.error || res.statusText), { status: res.status, data });
  return data;
}
// Screenshots are fetched with the key and shown as blob URLs (an <img> cannot send a header). Kept for reuse, the
// oldest dropped past 240.
function image(url) {
  if (!S.images.has(url)) {
    const p = fetch(url, { headers: { 'X-Nunchi-Token': S.token }, cache: 'no-store', credentials: 'omit' })
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error('no image')))).then(b => URL.createObjectURL(b));
    S.images.set(url, p);
    if (S.images.size > 240) { const [k, old] = S.images.entries().next().value; S.images.delete(k); old.then(u => URL.revokeObjectURL(u), () => {}); }
  }
  return S.images.get(url);
}
const bg = (el, url) => { image(url).then(u => { el.style.backgroundImage = `url("${u}")`; }, () => { el.classList.add('thumb-none'); }); };

// A screenshot region with its boxes (white + dark, dashed: they read on any screenshot and do not rely on colour).
function shot(scene, boxes, { crop = false, label, cls = '' } = {}) {
  const img = scene.img;
  const g = W.shotGeometry(img, boxes, { crop });
  const el = h('div', { class: `shot${cls ? ' ' + cls : ''}`, role: 'img', 'aria-label': label });
  el.style.aspectRatio = `${img.w} / ${g.ch}`;
  el.style.backgroundPosition = `0 ${W.pct(g.posY)}`;
  for (const m of g.marks) {
    const b = h('span', { class: 'box' }, m.n ? h('span', { class: 'num' }, String(m.n)) : null);
    b.style.left = W.pct(m.left); b.style.top = W.pct(m.top); b.style.width = W.pct(m.width); b.style.height = W.pct(m.height);
    el.append(b);
  }
  bg(el, img.url);
  return el;
}

// ---- boot: the one-time link, then the key in memory only ----------------------------------------------------------

function lost(why) {
  if (S.stopped && why !== 'stopped') return;
  S.stopped = true;
  const text = {
    'no-code': 'This tab has no key to the board.',
    used: 'This link was used already, or it expired (a link works once, for 2 minutes).',
    expired: 'This tab lost its key (the board restarted, or the tab was reloaded).',
    stopped: 'The board stopped.',
    offline: 'The board is not running.',
  }[why] || 'This tab has no key to the board.';
  show(h('section', { class: 'lost', 'aria-labelledby': 'lost-h' },
    h('h1', { id: 'lost-h' }, text),
    h('p', null, 'Run this in your terminal for a fresh link (or ask your AI to open the board again):'),
    h('p', { class: 'copyline' }, h('code', null, 'nunchi open'), copyButton('nunchi open')),
    h('p', { class: 'muted small' }, 'The key is never stored on disk or shown to your AI, so a reload needs a fresh link.')));
  $('nav').hidden = true;
  TOAST.hidden = true;
  // said, and the focus on the message (it replaced whatever had the focus)
  focusHeading();
  announce(text);
}

async function boot() {
  const m = /^#t=([0-9a-f]{64})$/.exec(location.hash);
  history.replaceState(null, '', '/');
  if (!m) return lost('no-code');
  let r;
  try { r = await fetch('/api/session', { method: 'POST', cache: 'no-store', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: m[1] }) }); }
  catch { return lost('offline'); }
  if (!r.ok) return lost('used');
  const s = await r.json();
  S.token = s.token; S.mode = s.mode; S.labeller = s.labeller || null;
  wireGlobal();
  try {
    if (S.mode === 'label') { await labelBoot(); return live(); }
    history.replaceState(null, '', '/#/progress');
    addEventListener('hashchange', router);
    await refreshSummary();
    await router();
  } catch (e) {
    // the ledger could not be read (another nunchi holds it, a file is torn): said, with the way out nunchi gives
    if (e.status !== 401) show(h('section', { class: 'lost', 'aria-labelledby': 'err-h' }, h('h1', { id: 'err-h' }, 'The board could not read nunchi’s state'),
      h('p', null, e.message), h('p', { class: 'muted small' }, 'Run nunchi findings in your terminal for the same message; the board updates once it is fixed.')));
  }
  live();
}

// ---- live updates: a fetch stream; when it breaks, polling, and the stream again --------------------------------------
// A request that gets no answer at all (the network, a board restarting, a laptop waking up) is retried with a growing
// wait; only OFFLINE_AFTER of them in a row say the board is not running. An answer of any status (429, 503) means it is.
const OFFLINE_AFTER = 4, POLL_MS = 3000, POLL_MAX_MS = 15000, STREAM_MAX_MS = 60000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// One stream, read to its end. → 'bye' | 'expired' | 'ended' (it ran, then closed) | 'failed' (it could not open)
async function stream() {
  let res;
  try { res = await fetch('/api/live', { headers: { 'X-Nunchi-Token': S.token }, cache: 'no-store', credentials: 'omit' }); } catch { return 'failed'; }
  if (res.status === 401) return 'expired';
  if (!res.ok || !res.body) return 'failed';
  try {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return 'ended';
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (\w+)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev === 'bye') return 'bye';
        if (ev === 'generation' && data) { try { changed(JSON.parse(data).version); } catch {} }
      }
    }
  } catch { return 'ended'; }
}
// Polls the version for at least `ms`, until the board answers. → false when the tab is done (no key, offline).
async function pollFor(ms) {
  const until = Date.now() + ms;
  let misses = 0, wait = POLL_MS;
  for (;;) {
    await sleep(wait);
    if (S.stopped) return false;
    try { const r = await api('/api/generation'); misses = 0; wait = POLL_MS; changed(r.version); if (Date.now() >= until) return true; }
    catch (e) {
      if (e.status === 401) return false;
      if (e.status) { misses = 0; wait = POLL_MS; if (Date.now() >= until) return true; continue; }   // it answered
      if (++misses >= OFFLINE_AFTER) { lost('offline'); return false; }
      wait = Math.min(wait * 2, POLL_MAX_MS);
    }
  }
}
async function live() {
  let wait = POLL_MS;                                    // polling before the stream is tried again; grows while it fails
  while (!S.stopped) {
    const r = await stream();
    if (r === 'bye') return lost('stopped');
    if (r === 'expired') return lost('expired');
    if (r === 'ended') wait = POLL_MS;
    if (!(await pollFor(wait))) return;
    if (r === 'failed') wait = Math.min(wait * 2, STREAM_MAX_MS);
  }
}
let busy = null;
async function changed(version) {
  if (!version || version === S.version) return;
  const first = S.version === null;
  S.version = version;
  if (first) return;
  if (busy) { busy.again = true; return; }
  busy = { again: false };
  try {
    do {
      busy.again = false;
      if (S.mode === 'label') { await labelRefresh(); continue; }
      await refreshSummary();
      if (S.route.view === 'progress') renderProgress();
      if (S.route.view === 'findings' || S.route.view === 'detail') await refreshList();
      if (S.route.view === 'detail' && S.detail) await refreshDetail();
      if (S.route.view === 'screens') { S.screens = await api('/api/screens'); renderScreens(); }
    } while (busy.again);
  } catch {} finally { busy = null; }
}

async function refreshSummary() {
  const s = await api('/api/summary');
  S.summary = s;
  if (S.version === null) S.version = s.version;
  $('runbox').replaceChildren(h('b', null, s.run ? `Run ${s.run}` : 'No run yet'), h('br'), h('span', { class: 'muted' }, s.commit ? `${s.commit}${s.dirty ? ' + edits' : ''}` : s.project));
  const active = Object.values(s.bySeverity).reduce((a, b) => a + b, 0);
  $('nav-findings').textContent = String(active);
  $('nav-screens').textContent = String(s.counts.screens);
  // the Now line, announced at most every 10 s (design §3.4)
  const line = s.now[0] || null;
  if (line && line !== S.nowLine && Date.now() - S.lastNow > 10000) { S.lastNow = Date.now(); announce(line); }
  S.nowLine = line;
}

// ---- routes -------------------------------------------------------------------------------------------------------

function parseRoute() {
  const hsh = location.hash;
  let m;
  if ((m = /^#\/finding\/([0-9a-f]{12})$/.exec(hsh))) return { view: 'detail', id: m[1] };
  if ((m = /^#\/screen\/(.+)$/.exec(hsh))) { try { return { view: 'screens', screen: decodeURIComponent(m[1]) }; } catch { return { view: 'screens' }; } }
  if (hsh === '#/findings') return { view: 'findings' };
  if (hsh === '#/screens') return { view: 'screens' };
  if (hsh === '#/progress' || hsh === '' || hsh === '#' || hsh === '#/') return { view: 'progress' };
  return null;
}
function setNav(view) {
  for (const a of d.querySelectorAll('[data-nav]')) { if (a.getAttribute('data-nav') === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
}
async function router() {
  const r = parseRoute();
  if (!r || S.stopped) return;
  const from = S.route.view;
  S.route = r;
  setNav(r.view === 'detail' ? 'findings' : r.view);
  try {
    if (r.view === 'progress') renderProgress(true);
    else if (r.view === 'findings') { if (!S.list || from === 'progress' || from === 'screens') await loadList(); renderFindings(true); }
    else if (r.view === 'detail') await showDetail(r.id);
    else if (r.view === 'screens') { if (!S.screens || from !== 'screens') S.screens = await api('/api/screens'); S.screenSel = r.screen || S.screenSel; renderScreens(true); }
  } catch (e) { if (e.status !== 401) show(h('p', { class: 'lost' }, `The board could not load this view: ${e.message}`)); }
}
const go = hash => { if (location.hash === hash) router(); else location.hash = hash; };
const focusHeading = () => { const hd = main().querySelector('h1'); if (hd) { hd.setAttribute('tabindex', '-1'); hd.focus({ preventScroll: false }); } };

// ---- Progress -------------------------------------------------------------------------------------------------------

function renderProgress(focus = false) {
  if (S.route.view !== 'progress' || !S.summary) return;
  const s = S.summary;
  const tiles = W.SEVERITIES.map(sev => h('a', { class: `tile${s.bySeverity[sev] && W.SEV[sev] <= W.SEV.high ? ` tile-${sev}` : ''}`, href: '#/findings' },
    h('span', { class: 'tile-k' }, sevChip(sev)), h('span', { class: 'tile-n' }, String(s.bySeverity[sev] || 0))));
  const decideBtn = s.decideNow ? h('a', { class: 'btn btn-primary', href: '#/findings' }, `Decide ${s.decideNow} →`) : h('a', { class: 'btn btn-primary', href: '#/findings' }, 'Review findings');
  const handoff = s.handoff ? h('p', { class: 'handoff' }, s.handoff.text, copyButton(s.handoff.say, 'Copy “fix them”')) : null;
  const hero = h('section', { class: 'panel-box hero', 'aria-labelledby': 'h-progress' },
    h('div', { class: 'hero-top' }, h('div', null, h('p', { class: 'eyebrow' }, 'Ready to ship?'), h('h1', { id: 'h-progress' }, s.verdict.text)), decideBtn),
    handoff, s.treeChanged ? h('p', { class: 'banner banner-warn', role: 'note' }, W.WORDS['tree-differs']) : null, h('div', { class: 'tiles' }, tiles),
    h('p', { class: 'muted small' }, 'Open findings by severity: groups still open, to fix, or held for later. A group is one defect, however many screens show it.'),
    s.now.length ? h('ul', { class: 'now', 'aria-label': 'Now' }, s.now.map(l => h('li', null, l))) : null);
  const confirm = s.confirm.length ? confirmPanel(s.confirm) : null;
  const checks = s.checks && s.checks.requested && !s.checks.approved ? checksPanel(s.checks) : null;
  const since = h('section', { class: 'panel-box', 'aria-labelledby': 'h-since' }, h('h2', { id: 'h-since' }, s.since.label),
    h('ul', { class: 'facts' }, h('li', null, h('b', { class: 'good' }, String(s.since.fixed)), ' fixed'), h('li', null, h('b', null, String(s.since.new)), ' new'),
      s.since.back ? h('li', null, h('b', { class: 'warn' }, String(s.since.back)), ' came back after a fix') : null));
  const sc = s.health.scenes;
  const meter = h('div', { class: 'meter', 'aria-hidden': 'true' }, h('span'));
  meter.firstChild.style.width = `${sc.total ? Math.round((sc.checked / sc.total) * 100) : 0}%`;
  const WHY = { 'login-expired': 'the saved login no longer worked', 'app-unreachable': 'most screens did not load at all', 'recording-stale': 'most screens asked for data the recording does not have' };
  const ai = s.ai.ran ? `${W.plural(s.ai.groups, 'group')}, ${s.ai.doubleChecked} double-checked${s.ai.notDoubleChecked ? `, ${s.ai.notDoubleChecked} not double-checked` : ''}${s.ai.coverage ? ` · ${s.ai.coverage.seen}/${s.ai.coverage.cells} cells seen` : ''}${s.ai.suspect ? ' · verification suspect' : ''}${s.ai.tooFewDecoys ? ` · ${W.WORDS['too-few-decoys']}` : ''}` : 'not run (rules and computed checks only)';
  const health = h('section', { class: 'panel-box', 'aria-labelledby': 'h-health' }, h('h2', { id: 'h-health' }, s.run ? `Run ${s.run}` : 'No run yet'),
    h('div', { class: 'meter-row' }, h('span', null, 'Screens checked'), h('a', { href: '#/screens' }, `${sc.checked} of ${sc.total}`)), meter,
    h('ul', { class: 'facts' }, h('li', null, `AI review: ${ai}`),
      s.health.blind ? h('li', { class: 'warn' }, `This run could not tell what was fixed (${s.health.blind}). Nothing was marked fixed by it.`) : null,
      sc.notSeen ? h('li', null, `${W.plural(sc.notSeen, 'screen')} not seen: ${sc.reasons.join(', ')}`) : null,
      s.ai.coverage?.budget ? h('li', null, `${W.plural(s.ai.coverage.budget, 'cell')} ${W.WORDS['not-seen-budget'].replace(/^Not checked/, 'not checked')}`) : null,
      s.ai.needsYou ? h('li', { class: 'warn' }, `${W.plural(s.ai.needsYou, 'AI finding')} need you: the re-check could not tell whether they are gone`) : null,
      s.health.problems.map(p => h('li', { class: 'warn' }, `Run problem: ${p.status} (${p.scenes}/${p.of} screens) — ${WHY[p.status] || ''}`))));
  const counts = h('section', { class: 'panel-box', 'aria-labelledby': 'h-status' }, h('h2', { id: 'h-status' }, 'Decisions'),
    h('ul', { class: 'statuses' }, W.FILTERS.filter(([k]) => k !== 'all').map(([k, label]) => h('li', null, h('span', { class: `st st-${k}` }, label), ' ', h('b', null, String(s.byStatus[k] || 0))))),
    s.warnings.length ? h('ul', { class: 'facts muted small' }, s.warnings.map(w => h('li', null, w))) : null);
  show(h('div', { id: 'progress', class: 'view' },
    h('div', { class: 'stack' }, hero, confirm, checks, h('div', { class: 'two' }, since, health), counts)));
  if (focus) focusHeading();
}

// design §1: dismissals your AI recorded (or that came through git) count once you confirm them, in one batch
function confirmPanel(list) {
  const words = c => `${W.decidedText(c.decision, c.reason)} · ${c.channel === 'cli-agent' ? 'recorded by your AI' : c.channel === 'git' ? 'came through git' : 'recorded before nunchi knew who decided'}${c.by ? ` (${c.by}` : ''}${c.at ? `${c.by ? ', ' : ' ('}${when(c.at)})` : c.by ? ')' : ''}`;
  const btn = h('button', { type: 'button', class: 'b b-primary' }, `Confirm ${list.length === 1 ? 'it' : `all ${list.length}`}`);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await api('/api/confirm', { method: 'POST', body: { keys: list.map(c => c.key) } }); announce(`${W.plural(list.length, 'decision')} confirmed`); await refreshSummary(); renderProgress(); }
    catch (e) { btn.disabled = false; announce(`Not confirmed: ${e.message}`); }
  });
  return h('section', { class: 'panel-box', 'aria-labelledby': 'h-confirm' },
    h('h2', { id: 'h-confirm' }, `${W.plural(list.length, 'decision')} recorded by your AI — confirm`),
    h('p', { class: 'muted small' }, 'Until you confirm them here, these do not count for “Ready to ship”. Open one to look again first.'),
    h('ul', { class: 'confirm-list' }, list.map(c => h('li', null, sevChip(c.severity),
      h('span', { class: 'what' }, h('span', null, c.title), h('span', { class: 'small muted' }, words(c)), c.note ? h('span', { class: 'small' }, `Note: ${c.note}`) : null),
      h('a', { class: 'b b-quiet', href: `#/finding/${c.group}` }, 'Open')))),
    h('div', null, btn));
}

function checksPanel(c) {
  const btn = h('button', { type: 'button', class: 'b b-primary' }, 'Approve these check scripts');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await api('/api/approve-checks', { method: 'POST', body: { profile: c.profile.hash } }); announce('Check scripts approved'); await refreshSummary(); renderProgress(); }
    catch (e) { btn.disabled = false; announce(`Not approved: ${e.message}`); }
  });
  const scripts = Object.entries(c.profile.scripts);
  return h('section', { class: 'panel-box', 'aria-labelledby': 'h-checks' }, h('h2', { id: 'h-checks' }, 'Your AI asks to run your checks while it fixes'),
    h('p', { class: 'small' }, 'nunchi runs these exact lines of package.json (and nothing else of it) to see that a fix breaks nothing. Approve them once; any change asks again.'),
    scripts.length ? h('dl', { class: 'facts-dl' }, scripts.map(([k, v]) => [h('dt', null, k), h('dd', { class: 'mono' }, v)])) : h('p', { class: 'muted' }, 'No build, typecheck, lint or test script.'),
    c.profile.packageManager ? h('p', { class: 'small muted' }, `Package manager: ${c.profile.packageManager}`) : null, h('div', null, btn));
}

// ---- Findings ---------------------------------------------------------------------------------------------------------

async function loadList() {
  const p = S.params;
  const r = await api(`/api/groups?status=${encodeURIComponent(p.status)}&group=${encodeURIComponent(p.group)}${p.q ? `&q=${encodeURIComponent(p.q)}` : ''}`);
  S.list = freeze(r);
  S.pending = null;
}
const freeze = r => ({ ...r, ids: [...r.sections, ...r.unchecked].flatMap(s => s.ids) });
// The list never moves under the keys (design §3.4): a newer list is kept apart and said in a banner; rows already
// shown take their new status in place.
async function refreshList() {
  const p = S.params;
  const r = await api(`/api/groups?status=${encodeURIComponent(p.status)}&group=${encodeURIComponent(p.group)}${p.q ? `&q=${encodeURIComponent(p.q)}` : ''}`);
  const now = freeze(r);
  const before = new Set(S.list?.ids || []);
  const added = now.ids.filter(id => !before.has(id)).length;
  const fixed = [...before].filter(id => now.groups[id]?.status === 'fixed' && S.list.groups[id]?.status !== 'fixed').length;
  S.list = { ...S.list, groups: now.groups, counts: now.counts };
  S.pending = added || fixed ? { list: now, added, fixed } : null;
  if (S.route.view === 'findings') updateRowsInPlace();
}
function showUpdates() {
  if (!S.pending) return;
  S.list = S.pending.list; S.pending = null;
  renderFindings();
  announce('The list is up to date');
}

function rowEl(g) {
  const sel = S.selection.has(g.id);
  const row = h('li', { class: 'row', role: 'option', id: `row-${g.id}`, 'data-id': g.id, 'aria-selected': sel ? 'true' : 'false', tabindex: S.focus === g.id ? '0' : '-1' });
  fillRow(row, g);
  row.addEventListener('click', e => { if (e.target.closest('button')) return; setFocus(g.id); if (e.shiftKey || e.metaKey || e.ctrlKey) toggleSelect(g.id); else go(`#/finding/${g.id}`); });
  row.addEventListener('focus', () => { if (S.focus !== g.id) setFocus(g.id, { scroll: false }); });
  return row;
}
function fillRow(row, g) {
  const tags = [g.notLookedAt ? h('span', { class: 'tag tag-warn' }, `Not looked at since run ${g.notLookedAt}`) : null,
    g.fixing ? h('span', { class: 'tag tag-ai' }, `${g.fixing.agent} is fixing${g.fixing.minutes !== null ? ` · ${g.fixing.minutes} min` : ''}`) : null,
    g.needsYou ? h('span', { class: 'tag tag-warn' }, 'Needs you') : null, decisionTag(g), sourceTag(g), ...statusChips(g)];
  row.replaceChildren(h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓'),
    h('span', { class: 'row-main' }, h('span', { class: 'row-what' }, g.source === 'ai' ? g.headline : whereText(g)),
      h('span', { class: 'row-where' }, g.source === 'ai' ? whereText(g) : g.gist)),
    // grouped by kind, the section names the severity; grouped otherwise, each row does
    h('span', { class: 'row-tags' }, S.params.group !== 'kind' ? sevChip(g.severity) : null, tags));
  row.setAttribute('aria-label', `${g.source === 'ai' ? g.headline : `${g.kindTitle}: ${whereText(g)}`}, ${W.SEV_LABEL[sevOf(g.severity)]}, ${statusText(g.status)}`);
}
function updateRowsInPlace() {
  for (const row of main().querySelectorAll('.row[data-id]')) { const g = S.list.groups[row.getAttribute('data-id')]; if (g) fillRow(row, g); }
  const b = $('updates');
  if (b) renderBanner(b);
  const tabs = main().querySelectorAll('[role=tab][data-k]');
  for (const t of tabs) { const c = t.querySelector('.cnt'); if (c) c.textContent = String(S.list.counts[t.getAttribute('data-k')] || 0); }
}
function renderBanner(b) {
  if (!S.pending) { b.hidden = true; b.replaceChildren(); return; }
  const parts = [S.pending.added && `${S.pending.added} new`, S.pending.fixed && `${S.pending.fixed} fixed`].filter(Boolean).join(', ');
  const btn = h('button', { type: 'button', class: 'b' }, 'Show ', h('span', { class: 'kbd' }, 'R'));
  btn.addEventListener('click', showUpdates);
  b.replaceChildren(h('span', null, `Updated: ${parts}`), btn);
  b.hidden = false;
}
const visibleIds = () => [...main().querySelectorAll('.row[data-id]')].filter(r => r.offsetParent !== null).map(r => r.getAttribute('data-id'));

function renderFindings(focus = false) {
  if (S.route.view !== 'findings' || !S.list) return;
  const L = S.list, p = S.params;
  // a row that has the focus keeps it across a re-render
  if (d.activeElement?.classList?.contains('row')) focus = true;
  if (!S.focus || !L.ids.includes(S.focus)) S.focus = L.ids[0] || null;
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Status' }, W.FILTERS.map(([k, label]) => {
    const t = h('button', { type: 'button', role: 'tab', 'data-k': k, 'aria-selected': p.status === k ? 'true' : 'false', tabindex: p.status === k ? '0' : '-1' }, label, ' ', h('span', { class: 'cnt' }, String(L.counts[k] || 0)));
    t.addEventListener('click', () => setStatus(k));
    return t;
  }));
  tabs.addEventListener('keydown', e => {
    const list = [...tabs.querySelectorAll('[role=tab]')], i = list.indexOf(d.activeElement);
    if (i < 0) return;
    const j = e.key === 'ArrowRight' ? (i + 1) % list.length : e.key === 'ArrowLeft' ? (i - 1 + list.length) % list.length : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault(); e.stopPropagation();
    setStatus(list[j].getAttribute('data-k'), { focusTab: true });
  });
  const groupSel = h('select', { id: 'group-by' }, [['kind', 'Kind'], ['file', 'Root-cause file'], ['screen', 'Screen'], ['lens', 'Lens']].map(([v, l]) => h('option', { value: v, selected: p.group === v }, l)));
  groupSel.addEventListener('change', async () => { S.params.group = groupSel.value; store.set('nunchi.group', groupSel.value); await loadList(); renderFindings(); d.getElementById('group-by')?.focus(); });
  const search = h('input', { id: 'search', type: 'search', value: p.q, placeholder: 'Plain text', autocomplete: 'off', spellcheck: 'false' });
  let t = null;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const typing = d.activeElement === $('search');
      S.params.q = $('search').value; await loadList(); renderFindings();
      // the search box keeps the focus only if the person is still in it
      if (typing) { const s = $('search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }, 250);
  });
  const banner = h('div', { id: 'updates', class: 'banner', role: 'status', hidden: true });
  renderBanner(banner);
  const section = (s, i, prefix) => {
    const hid = `${prefix}-${i}`;
    const all = h('button', { type: 'button', class: 'b b-quiet' }, `Decide all ${s.ids.length} ▸`);
    all.addEventListener('click', () => { S.selection = new Set(s.ids); S.focus = s.ids[0]; renderFindings(); announce(`${W.plural(s.ids.length, 'group')} selected: press a decision key or use the bar below`); d.getElementById(`row-${s.ids[0]}`)?.focus(); });
    return h('section', { class: 'sect', 'aria-labelledby': hid },
      h('div', { class: 'sect-head' }, h('h2', { id: hid }, sevChip(s.severity), h('span', null, s.title || '—'), h('span', { class: 'muted small' }, W.plural(s.ids.length, 'group'))), all),
      h('ul', { class: 'rows', role: 'listbox', 'aria-labelledby': hid, 'aria-multiselectable': 'true' }, s.ids.map(id => L.groups[id]).filter(Boolean).map(rowEl)));
  };
  const listBox = h('div', { class: 'list-box' }, L.sections.length ? L.sections.map((s, i) => section(s, i, 's')) : h('p', { class: 'empty-note' }, 'Nothing here.'));
  let unchecked = null;
  if (L.unchecked.length) {
    const n = L.unchecked.reduce((a, s) => a + s.ids.length, 0);
    const ask = h('button', { type: 'button', class: 'b' }, 'Ask the AI to double-check');
    ask.addEventListener('click', askDoubleCheck);
    unchecked = h('details', { class: 'list-box unchecked', open: S.openUnchecked },
      h('summary', { class: 'unchecked-sum' }, h('span', null, 'Not double-checked by the AI ', h('span', { class: 'muted' }, `(${n})`))),
      h('div', { class: 'pad' }, h('p', { class: 'muted small' }, 'Claims the AI made that no second reviewer has looked at yet. Decide them if you can see the defect yourself.'), h('p', null, ask)),
      L.unchecked.map((s, i) => section(s, i, 'u')));
    unchecked.addEventListener('toggle', () => { S.openUnchecked = unchecked.open; });
  }
  const selbar = S.selection.size ? h('div', { class: 'banner', role: 'status' }, h('span', null, `${W.plural(S.selection.size, 'group')} selected`), (() => { const c = h('button', { type: 'button', class: 'b' }, 'Clear'); c.addEventListener('click', () => { S.selection.clear(); renderFindings(); }); return c; })()) : null;
  show(h('section', { id: 'findings', class: 'view', 'aria-labelledby': 'h-findings' }, h('div', { class: 'stack' },
    h('div', { class: 'head-row' }, h('div', null, h('h1', { id: 'h-findings' }, 'Findings'), h('p', { class: 'muted' }, `${W.plural(L.total, 'group')} · worst first; the list holds still while you decide`))),
    h('div', { class: 'controls' }, tabs, h('label', { class: 'field', for: 'group-by' }, 'Group by', groupSel), h('label', { class: 'field', for: 'search' }, 'Search', h('span', { class: 'kbd', 'aria-hidden': 'true' }, '/'), search)),
    banner, S.summary?.handoff ? h('p', { class: 'handoff' }, S.summary.handoff.text, copyButton(S.summary.handoff.say, 'Copy “fix them”')) : null, selbar, listBox, unchecked, h('div', { class: 'dock' }, decisionBar(() => targetsNow())))));
  if (focus) { const r = S.focus && $(`row-${S.focus}`); if (r) r.focus(); else focusHeading(); if (S.focus) S.clock.reset(S.focus, nowMs()); }
}
async function setStatus(k, { focusTab = false } = {}) {
  S.params.status = k; store.set('nunchi.status', k);
  await loadList(); renderFindings();
  if (focusTab) main().querySelector(`[role=tab][data-k="${k}"]`)?.focus();
}
function setFocus(id, { scroll = true } = {}) {
  if (!id) return;
  const was = S.focus;
  S.focus = id;
  for (const r of main().querySelectorAll('.row[data-id]')) r.setAttribute('tabindex', r.getAttribute('data-id') === id ? '0' : '-1');
  const el = $(`row-${id}`);
  if (el) { if (d.activeElement !== el) el.focus({ preventScroll: !scroll }); if (scroll) el.scrollIntoView({ block: 'nearest' }); }
  if (was !== id) S.clock.reset(id, nowMs());
}
function moveFocus(step, { extend = false } = {}) {
  const ids = visibleIds();
  if (!ids.length) return;
  const i = Math.max(0, ids.indexOf(S.focus));
  const j = Math.min(ids.length - 1, Math.max(0, i + step));
  if (extend) { S.selection.add(ids[i]); S.selection.add(ids[j]); }
  setFocus(ids[j]);
  if (extend) { for (const r of main().querySelectorAll('.row[data-id]')) r.setAttribute('aria-selected', S.selection.has(r.getAttribute('data-id')) ? 'true' : 'false'); announce(W.plural(S.selection.size, 'group') + ' selected'); }
}
function toggleSelect(id) {
  if (S.selection.has(id)) S.selection.delete(id); else S.selection.add(id);
  const r = $(`row-${id}`); if (r) r.setAttribute('aria-selected', S.selection.has(id) ? 'true' : 'false');
  announce(`${W.plural(S.selection.size, 'group')} selected`);
}
const targetsNow = () => (S.route.view === 'detail' ? (S.detail ? [S.detail.id] : []) : S.selection.size ? [...S.selection] : S.focus ? [S.focus] : []);

// The decision bar (a toolbar): permanent sub-labels, the key on each button (design §3.4).
function decisionBar(targets) {
  const bar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Decide' }, h('span', { class: 'tb-label' }, 'Decide'),
    W.DECISION_BUTTONS.map((b, i) => {
      const el = h('button', { type: 'button', class: `dbtn dbtn-${b.decision}`, tabindex: i === 0 ? '0' : '-1', 'aria-keyshortcuts': b.key },
        h('b', null, b.label, h('span', { class: 'kbd', 'aria-hidden': 'true' }, b.key)), h('small', null, b.sub));
      el.addEventListener('click', () => { const ids = targets(); if (ids.length) decide(ids, b.decision, b.reason); else announce('Pick a finding first'); });
      return el;
    }));
  bar.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const list = [...bar.querySelectorAll('button')], i = list.indexOf(d.activeElement);
    if (i < 0) return;
    e.preventDefault(); e.stopPropagation();
    const j = (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    list.forEach((b, k) => b.setAttribute('tabindex', k === j ? '0' : '-1'));
    list[j].focus();
  });
  return bar;
}

// ---- deciding, undo ---------------------------------------------------------------------------------------------------

// The decision in flight: Z pressed within one round trip of a decision undoes that decision (it waits for it).
let inflight = null;
function decide(...args) {
  const p = decideNow(...args);
  inflight = p;
  p.finally(() => { if (inflight === p) inflight = null; }).catch(() => {});
  return p;
}
async function decideNow(ids, decision, reason, { confirmed = false, ms: given } = {}) {
  const ms = given !== undefined ? given : S.clock.id && ids.includes(S.clock.id) ? S.clock.read(nowMs()) : null;
  let r;
  try { r = await api('/api/decide', { method: 'POST', body: { targets: ids, decision, reason, ms, confirmed } }); }
  catch (e) {
    if (e.status === 409 && e.data?.confirm) { if (await ask(e.data.confirm.text, e.data.confirm.ok)) return decideNow(ids, decision, reason, { confirmed: true, ms }); return; }
    if (e.status === 409 && e.data?.stale) { announce('The list changed: showing it again'); await loadList(); return renderFindings(true); }
    if (e.status !== 401) announce(`Not recorded: ${e.message}`);
    return;
  }
  // what Z undoes: these decisions, by id (the server reopens exactly their targets, if nothing was decided since)
  S.undo = decision === 'reopen' ? null : { ids, decisions: r.made.map(m => m.id), decision, reason, batch: r.batch, decided: r.decided };
  S.selection.clear();
  // the rows take their new status at once; the list keeps its order and members
  const st = { fix: 'to-fix', keep: 'kept', 'false-positive': 'dismissed', hold: 'held', reopen: 'open' }[decision];
  for (const id of ids) { const g = S.list?.groups[id]; if (g) S.list.groups[id] = { ...g, status: st, statuses: { [st]: 1 }, decision: { decision, reason, channel: 'board', human: true } }; }
  const next = nextAfter(ids);
  if (S.route.view === 'detail') { if (next) go(`#/finding/${next}`); else go('#/findings'); }
  else { updateRowsInPlace(); for (const r2 of main().querySelectorAll('.row[aria-selected=true]')) r2.setAttribute('aria-selected', 'false'); if (next) setFocus(next); }
  const ng = next && S.list?.groups[next];
  announce(`${r.decided}${ids.length > 1 ? ` · ${W.plural(ids.length, 'group')}` : ''}.${ng ? ` Next: ${ng.source === 'ai' ? ng.headline : ng.kindTitle}, ${W.SEV_LABEL[sevOf(ng.severity)].toLowerCase()}, ${W.plural(ng.screens || 0, 'screen')}` : ''}`);
  toast(r.decided, decision === 'reopen' ? null : { decision, reason, ids });
}
function nextAfter(ids) {
  const order = S.list?.ids || [];
  const last = Math.max(...ids.map(id => order.indexOf(id)));
  return order.slice(last + 1).find(id => !ids.includes(id)) || order.slice(0, Math.max(0, last)).reverse().find(id => !ids.includes(id)) || null;
}
async function undo() {
  if (inflight) await inflight.catch(() => {});
  const u = S.undo;
  if (!u) return announce('Nothing to undo');
  hideToast();
  try { await api('/api/undo', { method: 'POST', body: { decisions: u.decisions } }); }
  catch (e) {
    if (e.status === 409) { announce('Not undone: it was decided again since'); await loadList(); return renderFindings(true); }
    return announce(`Not undone: ${e.message}`);
  }
  for (const id of u.ids) { const g = S.list?.groups[id]; if (g) S.list.groups[id] = { ...g, status: 'open', statuses: { open: 1 }, decision: null }; }
  if (S.route.view === 'findings') { updateRowsInPlace(); setFocus(u.ids[0]); }
  else if (S.route.view === 'detail') go('#/finding/' + u.ids[0]);       // back to the finding it reopened, its heading focused
  announce(`Undone: ${W.plural(u.ids.length, 'group')} back to open`);
  toast('Undone · back to open', null);
}

// The undo toast (design §3.4): 6 seconds, the other reason, Undo (Z).
let toastTimer = null;
function toast(text, act) {
  const el = TOAST;
  const kids = [h('span', null, text)];
  if (act && W.OTHER_REASON[act.reason]) {
    const other = W.OTHER_REASON[act.reason];
    const b = h('button', { type: 'button', class: 'b' }, `${W.decidedText(act.decision, other)} instead`);
    b.addEventListener('click', () => { hideToast(); decide(act.ids, act.decision, other, { confirmed: true, ms: null }); });
    kids.push(b);
  }
  if (act) { const u = h('button', { type: 'button', class: 'b' }, 'Undo ', h('span', { class: 'kbd' }, 'Z')); u.addEventListener('click', undo); kids.push(u); }
  el.replaceChildren(...kids);
  el.hidden = false;
  fitDock();
  if (!toastHeld.hover && !toastHeld.focus) toastLater(); else clearTimeout(toastTimer);
}
// The toast waits while the pointer is over it or the focus is in it, and gets its 6 seconds again after (WCAG 2.2.1).
const toastHeld = { hover: false, focus: false };
const toastLater = () => { clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, 6000); };
TOAST.addEventListener('pointerenter', () => { toastHeld.hover = true; clearTimeout(toastTimer); });
TOAST.addEventListener('pointerleave', () => { toastHeld.hover = false; if (!toastHeld.focus && !TOAST.hidden) toastLater(); });
TOAST.addEventListener('focusin', () => { toastHeld.focus = true; clearTimeout(toastTimer); });
TOAST.addEventListener('focusout', e => { if (TOAST.contains(e.relatedTarget)) return; toastHeld.focus = false; if (!toastHeld.hover && !TOAST.hidden) toastLater(); });
// Undo lasts as long as its toast: once the toast is gone, Z has nothing to undo. A focus that was in the toast goes
// back to the row (or the view's heading), never to the page itself.
function hideToast() {
  const had = TOAST.contains(d.activeElement);
  TOAST.hidden = true;
  clearTimeout(toastTimer);
  toastHeld.hover = toastHeld.focus = false;
  S.undo = null;
  fitDock();
  if (had) { const row = S.route.view === 'findings' && S.focus ? $(`row-${S.focus}`) : null; if (row) row.focus(); else focusHeading(); }
}

// A question that cannot misfire: the safe choice has the focus.
function ask(text, ok = 'Yes') {
  return new Promise(res => {
    const dlg = $('dialog');
    const no = h('button', { type: 'button', class: 'b' }, 'Cancel'), yes = h('button', { type: 'button', class: 'b b-primary' }, ok);
    dlg.replaceChildren(h('h2', { id: 'dialog-title' }, text), h('div', { class: 'dialog-actions' }, no, yes));
    const done = v => { dlg.close(); res(v); };
    no.addEventListener('click', () => done(false)); yes.addEventListener('click', () => done(true));
    dlg.addEventListener('cancel', () => res(false), { once: true });
    dlg.showModal(); no.focus();
  });
}
function dialog(title, ...body) {
  const dlg = $('dialog');
  const close = h('button', { type: 'button', class: 'b' }, 'Close');
  close.addEventListener('click', () => dlg.close());
  dlg.replaceChildren(h('h2', { id: 'dialog-title' }, title), ...body, h('div', { class: 'dialog-actions' }, close));
  dlg.showModal(); close.focus();
}
function help() {
  const box = h('input', { type: 'checkbox', id: 'keys-on', checked: S.keysOn });
  box.addEventListener('change', () => { S.keysOn = box.checked; store.set('nunchi.keys', box.checked ? 'on' : 'off'); announce(`Single-key shortcuts ${box.checked ? 'on' : 'off'}`); });
  dialog('Keys', h('label', { class: 'check', for: 'keys-on' }, box, 'Single-key shortcuts (letters, / and ?); arrows, Enter, Space and Esc always work'),
    h('table', { class: 'keys' }, h('tbody', null, W.KEY_HELP.map(([k, v]) => h('tr', null, h('td', null, h('span', { class: 'kbd' }, k)), h('td', null, v))))));
}
function moreViews() {
  dialog('More views in 0.2', h('p', { class: 'small' }, 'These views come in 0.2. Until then the same data is one command away in your terminal:'),
    h('table', { class: 'keys' }, h('tbody', null, W.MORE_VIEWS.map(([v, c]) => h('tr', null, h('td', null, v), h('td', null, h('code', null, c), ' ', copyButton(c)))))));
}
function askDoubleCheck() {
  const msg = 'Double-check the AI findings nunchi has not verified yet: run nunchi verify --plan, verify the packets in a fresh context, then nunchi verify --record.';
  dialog('Ask the AI to double-check', h('p', { class: 'small' }, 'Copy this into your AI chat:'), h('p', { class: 'copyline' }, h('code', null, msg)), h('p', null, copyButton(msg)));
}

// ---- Detail -----------------------------------------------------------------------------------------------------------

async function detailData(id) {
  if (!S.details.has(id)) S.details.set(id, api(`/api/groups/${id}`).catch(e => { S.details.delete(id); throw e; }));
  return S.details.get(id);
}
async function showDetail(id) {
  if (!S.list) await loadList();
  const data = await detailData(id);
  const scenes = [...new Set(data.instances.map(f => f.scene).filter(Boolean))];
  const keep = S.detail?.id === id ? S.detail : null;
  S.detail = { id, data, vp: keep?.vp || null, sceneIdx: keep?.sceneIdx || 0, whole: keep?.whole || false, scenes };
  S.focus = id;
  renderDetail(true);
  if (!keep) S.clock.reset(id, nowMs());
  // the next two groups' images, so J lands on a ready screen (design §3.4)
  const order = S.list?.ids || [];
  const i = order.indexOf(id);
  for (const n of order.slice(i + 1, i + 3)) detailData(n).then(dd => { const f = dd.instances.find(x => x.scene && dd.scenes[x.scene]?.img); if (f) image(dd.scenes[f.scene].img.url); }).catch(() => {});
}
async function refreshDetail() {
  S.details.clear();
  try { S.detail.data = await detailData(S.detail.id); } catch { return; }
  renderDetail();
}
function renderDetail(focus = false) {
  if (S.route.view !== 'detail' || !S.detail) return;
  const D = S.detail, g = D.data;
  const order = S.list?.ids || [];
  const i = order.indexOf(g.id);
  const prev = i > 0 ? order[i - 1] : null, next = i >= 0 && i < order.length - 1 ? order[i + 1] : null;
  // which screen: the viewport chosen (or the first with a screenshot), flipping through the screens it was seen on
  const withImg = D.scenes.filter(k => g.scenes[k]?.img);
  const vps = [...new Set(withImg.map(k => g.scenes[k].viewport))].sort((a, b) => W.VPS.indexOf(a) - W.VPS.indexOf(b));
  const vp = D.vp && vps.includes(D.vp) ? D.vp : vps[0] || null;
  const onVp = withImg.filter(k => g.scenes[k].viewport === vp);
  const idx = onVp.length ? ((D.sceneIdx % onVp.length) + onVp.length) % onVp.length : 0;
  const sk = onVp[idx] || null;
  const sc = sk ? g.scenes[sk] : null;
  let figure = null;
  if (sc) {
    const here = g.instances.filter(f => f.scene === sk);
    const boxes = here.filter(f => f.drawable.ok).map(f => ({ box: f.box }));
    const not = here.find(f => !f.drawable.ok);
    const toggle = vps.length > 1 ? h('div', { class: 'seg-b', role: 'group', 'aria-label': 'Width' }, vps.map(v => { const b = h('button', { type: 'button', 'aria-pressed': v === vp ? 'true' : 'false' }, W.WIDTH[v] || v); b.addEventListener('click', () => { D.vp = v; D.sceneIdx = 0; renderDetail(); }); return b; })) : null;
    const whole = h('button', { type: 'button', class: 'b', 'aria-pressed': D.whole ? 'true' : 'false', 'aria-keyshortcuts': '0' }, D.whole ? 'Crop to the finding ' : 'Whole screen ', h('span', { class: 'kbd' }, '0'));
    whole.addEventListener('click', () => { D.whole = !D.whole; renderDetail(); });
    const flip = onVp.length > 1 ? [(() => { const b = h('button', { type: 'button', class: 'b', 'aria-label': 'Previous screen' }, h('span', { class: 'kbd' }, '[')); b.addEventListener('click', () => { D.sceneIdx--; renderDetail(); }); return b; })(),
      (() => { const b = h('button', { type: 'button', class: 'b', 'aria-label': 'Next screen' }, h('span', { class: 'kbd' }, ']')); b.addEventListener('click', () => { D.sceneIdx++; renderDetail(); }); return b; })()] : null;
    figure = h('div', { class: 'fig' },
      h('div', { class: 'fig-tools' }, toggle, whole, flip, h('span', { class: 'small muted' }, `Seen on ${W.plural(D.scenes.length, 'screen')}${onVp.length > 1 ? ` · ${idx + 1} of ${onVp.length} here · [ / ] to flip` : ''}`)),
      h('p', { class: 'muted small' }, `${sc.route} · ${sc.label}`),
      shot(sc, boxes, { crop: !D.whole && boxes.length > 0, label: `Screenshot of ${sc.route}, ${sc.label}${boxes.length ? ', with the element outlined' : ''}`, cls: sc.viewport === 'm' ? 'shot-m' : '' }),
      !boxes.length && not ? h('p', { class: 'muted small' }, `Not outlined: ${not.drawable.why}.`) : null);
  }
  const at = g.code?.line ? `:${g.code.line}` : '';
  const codeLine = g.code ? `${g.code.file}${at}` : null;
  // what Copy path copies: the whole path the server sent for copying (never the clipped one shown); none when the
  // path holds a control character
  const codeCopy = g.code?.copy ? `${g.code.copy}${at}` : null;
  const decision = g.decision;
  const latest = g.history.find(x => x.decision !== 'reopen');
  const reopen = g.status !== 'open' && g.status !== 'regressed' && g.status !== 'fixed' && latest ? (() => { const b = h('button', { type: 'button', class: 'b' }, 'Reopen'); b.addEventListener('click', () => decide([g.id], 'reopen', null, { confirmed: true, ms: null })); return b; })() : null;
  const needs = g.needsYou ? h('div', { class: 'needs', role: 'note' }, h('b', null, 'Needs you'),
    g.needsYou.reason === 'recheck-insufficient' ? h('span', null, 'The re-check could not tell whether this is gone. Look at the screen, then decide; or tell your AI “re-check it”.') : h('span', null, 'nunchi could not finish this one on its own.')) : null;
  const fixing = g.fixing ? h('p', { class: 'banner' }, `${g.fixing.agent} is fixing this${g.fixing.minutes !== null ? ` · ${g.fixing.minutes} min` : ''}`) : null;
  const facts = h('dl', { class: 'facts-dl' },
    codeLine ? [h('dt', null, 'Code'), h('dd', null, h('span', { class: 'mono' }, codeLine), ' ', codeCopy ? copyButton(codeCopy, 'Copy path') : null, ' ', g.code.link ? h('a', { class: 'b b-quiet', href: g.code.link }, 'Open in VS Code') : null)] : null,
    g.secret ? [h('dt', null, 'Where'), h('dd', { class: 'mono' }, g.secret.where), h('dt', null, 'Kind'), h('dd', null, g.secret.kind)] : null,
    D.scenes.length ? [h('dt', null, 'Seen on'), h('dd', null, D.scenes.slice(0, 12).map((k, j) => [j ? h('br') : null, `${g.scenes[k]?.route || ''} · ${g.scenes[k]?.label || ''}`]), D.scenes.length > 12 ? [h('br'), h('span', { class: 'muted' }, `+${D.scenes.length - 12} more`)] : null)] : null,
    decision ? [h('dt', null, 'Decision'), h('dd', null, `${W.decidedText(decision.decision, decision.reason)} · ${decision.by || ''} · ${when(decision.at)}`, decision.channelText ? h('span', { class: decision.human ? 'muted' : 'warn' }, ` · ${decision.channelText}`) : null)] : null,
    g.notes.map(n => [h('dt', null, 'Note'), h('dd', { class: 'warn' }, n)]),
    g.notLookedAt ? [h('dt', null, 'Looked at'), h('dd', { class: 'warn' }, `Not looked at since run ${g.notLookedAt}: no run since has captured every screen it was on, so it cannot be marked fixed.`)] : null,
    g.verification ? [h('dt', null, 'Reviewer'), h('dd', null, `${g.verification.status}${g.verification.by ? ` · ${g.verification.by}` : ''}${g.verification.suspect ? ' · suspect' : ''}${g.verification.tooFewDecoys ? ` · ${W.WORDS['too-few-decoys']}: not a double-check` : ''}`)] : null);
  const evidence = h('details', { class: 'evidence' }, h('summary', null, 'Evidence details'), h('dl', { class: 'facts-dl' },
    h('dt', null, 'Rule'), h('dd', { class: 'mono' }, `${g.lens} · ${g.rule}`), h('dt', null, 'Group'), h('dd', { class: 'mono' }, g.id),
    h('dt', null, 'Fingerprints'), h('dd', { class: 'mono' }, g.fps.join(' ')),
    g.selector ? [h('dt', null, 'Element'), h('dd', { class: 'mono' }, g.selector)] : null,
    g.evidence.map(e => [h('dt', null, e.k), h('dd', { class: e.mono ? 'mono' : '' }, e.v)]),
    h('dt', null, 'History'), h('dd', null, `first seen in run ${g.firstSeen || '—'} · last seen in run ${g.lastSeen || '—'}`)));
  const history = g.history.length ? h('section', { class: 'decide', 'aria-labelledby': 'h-history' }, h('h2', { id: 'h-history' }, 'Decisions'),
    h('ul', { class: 'history' }, g.history.map(x => h('li', null, h('b', null, W.decidedText(x.decision, x.reason)), h('span', { class: 'muted small' }, `${x.by || ''} · ${when(x.at)}${x.channelText ? ` · ${x.channelText}` : ''}`), x.note ? h('span', { class: 'small' }, `“${x.note}”`) : null))),
    reopen ? h('p', null, reopen) : null) : null;
  show(h('article', { class: 'view detail', 'aria-labelledby': 'h-detail' },
    h('nav', { class: 'detail-nav', 'aria-label': 'Finding navigation' }, h('a', { href: '#/findings' }, '← All findings'),
      h('span', { class: 'pn' }, prev ? h('a', { href: `#/finding/${prev}`, rel: 'prev' }, 'Previous (K)') : null, next ? h('a', { href: `#/finding/${next}`, rel: 'next' }, 'Next (J)') : null)),
    h('div', { class: 'panel-box detail-box' },
      h('header', { class: 'detail-head' }, h('p', { class: 'chips' }, sevChip(g.severity), h('span', { class: 'muted' }, g.kindTitle), sourceTag(g), decisionTag(g), ...statusChips(g)),
        h('h1', { id: 'h-detail' }, g.headline)),
      fixing, needs, figure || (g.secret || !g.instances.length ? h('p', { class: 'muted' }, 'No screenshot: this finding belongs to the whole app, not one screen.') : h('p', { class: 'muted' }, 'No screenshot of this finding is left (its run was removed).')),
      facts, evidence),
    history, h('div', { class: 'detail-box dock' }, decisionBar(() => targetsNow()))));
  if (focus) focusHeading();
}

// ---- Screens ----------------------------------------------------------------------------------------------------------

// Thumbnails are fetched when they come near the screen (a wall can have hundreds).
let thumbs = null;
function lazy(el, url) {
  if (!('IntersectionObserver' in window)) return bg(el, url);
  thumbs ||= new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { thumbs.unobserve(e.target); bg(e.target, e.target.getAttribute('data-src')); } }, { rootMargin: '600px' });
  el.setAttribute('data-src', url);
  thumbs.observe(el);
}
function renderScreens(focus = false) {
  if (S.route.view !== 'screens' || !S.screens) return;
  thumbs?.disconnect(); thumbs = null;
  const all = S.screens.scenes;
  const F = S.screenFilter;
  const vps = W.VPS.filter(v => all.some(s => s.viewport === v)), whos = W.PERSONS.filter(p => all.some(s => s.person === p)), states = W.STATES.filter(x => all.some(s => s.state === x));
  if (!F.vp) F.vp = vps.includes('d') ? 'd' : vps[0] || 'all';
  if (F.state !== 'all' && !states.includes(F.state)) F.state = 'all';
  const seg = (label, list, words, key) => list.length > 1 ? h('div', { class: 'seg-b', role: 'group', 'aria-label': label }, [...list, 'all'].map(v => {
    const b = h('button', { type: 'button', 'aria-pressed': F[key] === v ? 'true' : 'false' }, v === 'all' ? 'All' : words[v] || v);
    b.addEventListener('click', () => { F[key] = v; renderScreens(); });
    return b;
  })) : null;
  const shown = all.filter(s => (F.vp === 'all' || s.viewport === F.vp) && (F.who === 'all' || s.person === F.who) && (F.state === 'all' || s.state === F.state));
  const sel = S.screenSel ? all.find(s => s.key === S.screenSel) : null;
  const card = s => {
    const th = h('span', { class: `thumb thumb-${s.viewport === 'm' ? 'm' : 'd'}`, 'aria-hidden': 'true' });
    if (s.img) lazy(th, s.img.thumb); else { th.classList.add('thumb-none'); th.textContent = 'No screenshot'; }
    const b = h('button', { type: 'button', 'aria-pressed': sel?.key === s.key ? 'true' : 'false', 'aria-label': `${s.h1 || s.route}, ${s.label}: ${s.badge}` },
      h('span', { class: 'thumb-wrap' }, th, h('span', { class: `badge badge-${['blocker', 'high', 'medium', 'low', 'clean', 'dark'].includes(s.kind) ? s.kind : 'low'}` }, s.badge)),
      h('span', { class: 'card-body' }, h('span', { class: 'card-name' }, s.h1 || s.route), h('span', { class: 'mono muted small' }, s.route), h('span', { class: 'small muted' }, s.label), h('span', { class: `small ${s.kind === 'dark' ? 'warn' : 'muted'}` }, s.note)));
    b.addEventListener('click', () => { S.screenSel = s.key; history.replaceState(null, '', `/#/screen/${encodeURIComponent(s.key)}`); renderScreens(); $('panel-h')?.focus(); });
    return h('li', { class: 'card' }, b);
  };
  let panel = h('p', { class: 'panels-empty muted' }, 'Select a screen to see it large, with its findings outlined and numbered.');
  if (sel) {
    const boxes = sel.findings.filter(f => f.n).map(f => ({ box: f.box, n: f.n }));
    panel = h('section', { class: 'screen-panel', 'aria-labelledby': 'panel-h' },
      h('div', { class: 'sp-head' }, h('div', null, h('h2', { id: 'panel-h', tabindex: '-1' }, sel.h1 || sel.route), h('p', { class: 'muted small' }, h('span', { class: 'mono' }, sel.route), ` · ${sel.label}`)),
        (() => { const c = h('button', { type: 'button', class: 'b b-quiet' }, 'Close'); c.addEventListener('click', () => { S.screenSel = null; history.replaceState(null, '', '/#/screens'); renderScreens(); }); return c; })()),
      sel.img ? shot(sel, boxes, { label: `Screenshot of ${sel.route}, ${sel.label}${boxes.length ? `, ${W.plural(boxes.length, 'finding')} outlined and numbered` : ''}`, cls: sel.viewport === 'm' ? 'shot-m' : '' }) : h('p', { class: 'pad muted' }, `Not seen: ${sel.reason || sel.status}.`),
      sel.findings.length ? h('ol', { class: 'sp-list' }, sel.findings.map(f => h('li', null, h('a', { href: `#/finding/${f.group}` },
        h('span', { class: `numb${f.n ? '' : ' numb-none'}` }, f.n ? String(f.n) : '–'),
        h('span', { class: 'sp-text' }, h('span', { class: 'sp-what' }, f.headline), h('span', { class: 'small' }, `${W.SEV_LABEL[sevOf(f.severity)]} · ${f.source === 'ai' ? 'AI' : 'Rule'} · ${f.statusText}${f.n ? '' : ` · not outlined: ${f.why}`}`)))))) : sel.img ? h('p', { class: 'pad muted' }, 'Nothing found on this screen.') : null);
  }
  const withOpen = all.filter(s => s.findings.some(f => ['open', 'regressed', 'to-fix', 'held', 'stale', 'mixed'].includes(f.status))).length;
  show(h('section', { id: 'screens', class: 'view', 'aria-labelledby': 'h-screens' }, h('div', { class: 'stack' },
    h('div', { class: 'head-row' }, h('div', null, h('h1', { id: 'h-screens' }, 'Screens'), h('p', { class: 'muted' }, `${W.plural(new Set(all.map(s => s.route)).size, 'page')}, ${W.plural(all.length, 'screen')} · every one nunchi captured in run ${S.screens.run || '—'}, as it saw it`)),
      h('div', { class: 'filters' }, seg('Width', vps, W.WIDTH, 'vp'), seg('Who', whos, W.WHO, 'who'), seg('State', states, W.STATE_LABEL, 'state'))),
    h('p', { class: 'facts-inline' }, h('span', null, h('b', null, String(withOpen)), ' with open findings'), h('span', null, h('b', null, String(all.filter(s => s.badge === 'Clean').length)), ' clean'), h('span', null, h('b', null, String(shown.length)), ' shown')),
    h('div', { class: 'wall-wrap' }, h('ul', { class: 'wall' }, shown.length ? shown.map(card) : h('li', { class: 'empty-note' }, 'No screen matches these filters.')), h('aside', { class: 'panels', 'aria-label': 'Selected screen' }, panel)))));
  if (focus) focusHeading();
}

// ---- keys -----------------------------------------------------------------------------------------------------------

function wireGlobal() {
  $('help-open').addEventListener('click', help);
  $('more-views').addEventListener('click', moreViews);
  const input = () => S.clock.input(nowMs());
  for (const ev of ['keydown', 'pointerdown', 'wheel', 'touchstart']) d.addEventListener(ev, input, { capture: true, passive: true });
  d.addEventListener('visibilitychange', () => (d.hidden ? S.clock.hide(nowMs()) : S.clock.show(nowMs())));
  d.addEventListener('keydown', onKey);
}
function onKey(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || S.stopped) return;
  if ($('dialog').open) return;
  const t = e.target;
  const typing = t instanceof Element && !!t.closest('input, textarea, select, [contenteditable=""], [contenteditable=true]');
  if (e.key === 'Escape') {
    // out of a field: to the row (or the heading), never to the page
    if (typing) { e.preventDefault(); const row = S.route.view === "findings" && S.focus ? $("row-" + S.focus) : null; if (row) row.focus(); else { t.blur(); focusHeading(); } return; }
    if (!TOAST.hidden) return hideToast();
    if (S.selection.size) { S.selection.clear(); return renderFindings(true); }
    if (S.route.view === 'detail') return go('#/findings');
    return;
  }
  if (typing) return;                                     // keys are off in text fields (design §3.4)
  if (S.mode === 'label') return labelKey(e);
  const view = S.route.view;
  const inList = view === 'findings', inDetail = view === 'detail';
  const k = W.keyOf(e);                                  // by its place on the keyboard (any layout, Caps Lock)
  const char = k.length === 1;                            // single-character keys can be turned off (WCAG 2.1.4)
  if (char && !S.keysOn) return;
  const stop = () => { e.preventDefault(); e.stopPropagation(); };
  if (k === '?') { stop(); return help(); }
  if (k === '/' && inList) { stop(); return $('search')?.focus(); }
  if (!inList && !inDetail) return;
  if (t instanceof Element && t.closest('[role=toolbar], [role=tablist]') && (k === 'ArrowLeft' || k === 'ArrowRight')) return;
  if (inList && (k === 'j' || k === 'ArrowDown')) { stop(); return moveFocus(1); }
  if (inList && (k === 'k' || k === 'ArrowUp')) { stop(); return moveFocus(-1); }
  if (inList && (k === 'J' || k === 'K')) { stop(); return moveFocus(k === 'J' ? 1 : -1, { extend: true }); }
  if (inList && k === 'Home') { stop(); return setFocus(visibleIds()[0]); }
  if (inList && k === 'End') { stop(); return setFocus(visibleIds().pop()); }
  if (inList && k === ' ' && S.focus && t instanceof Element && t.closest('.row')) { stop(); return toggleSelect(S.focus); }
  if (inList && k === 'Enter' && S.focus && t instanceof Element && t.closest('.row')) { stop(); return go(`#/finding/${S.focus}`); }
  if (inDetail && (k === 'j' || k === 'k')) {
    stop();
    const order = S.list?.ids || [], i = order.indexOf(S.detail?.id);
    const n = order[i + (k === 'j' ? 1 : -1)];
    return n ? go(`#/finding/${n}`) : announce(k === 'j' ? 'This is the last finding' : 'This is the first finding');
  }
  if (inDetail && k === '0') { stop(); S.detail.whole = !S.detail.whole; return renderDetail(); }
  if (inDetail && (k === '[' || k === ']')) { stop(); S.detail.sceneIdx += k === ']' ? 1 : -1; return renderDetail(); }
  if (k === 'r' || k === 'R') { if (S.pending) { stop(); return showUpdates(); } return; }
  if (k === 'z' || k === 'Z') { stop(); return undo(); }
  const dk = W.DECISION_KEYS[k];
  if (dk) {
    stop();
    const ids = targetsNow();
    if (!ids.length) return announce('Pick a finding first');
    return decide(ids, dk.decision, dk.reason);
  }
}

// ---- label mode (design §9.2): blinded, its own keys, no decision bar ------------------------------------------------

async function labelBoot() {
  $('nav').replaceChildren(h('li', null, h('a', { href: '#/label', 'aria-current': 'page' }, 'Labelling')));
  $('more-views').parentElement.hidden = true;
  $('runbox').replaceChildren(h('b', null, 'Label mode'), h('br'), h('span', { class: 'muted' }, S.labeller || ''));
  history.replaceState(null, '', '/#/label');
  S.label = { pool: await api('/api/label/pool'), at: 0, item: null };
  const first = S.label.pool.items.findIndex(i => !i.label);
  S.label.at = first < 0 ? 0 : first;
  await labelShow(true);
}
async function labelRefresh() { S.label.pool = await api('/api/label/pool'); renderLabel(); }
async function labelShow(focus = false) {
  const it = S.label.pool.items[S.label.at];
  S.label.item = it ? await api(`/api/label/item/${it.id}`) : null;
  renderLabel(focus);
}
function renderLabel(focus = false) {
  const L = S.label, it = L.item, pool = L.pool;
  const banner = h('div', { class: 'label-banner', role: 'status' }, h('span', null, `Labelling for the precision check · ${pool.done}/${pool.total}`), h('span', { class: 'small' }, `Labeller: ${pool.labeller}`));
  if (!it) { show(h('section', { class: 'view', 'aria-labelledby': 'h-label' }, h('div', { class: 'stack' }, banner, h('h1', { id: 'h-label' }, pool.total ? 'All labelled' : 'Nothing to label'), h('p', { class: 'muted' }, pool.total ? 'Every item in the pool has your label. You can close this tab.' : 'The pool is empty: the AI review has not claimed anything yet.')))); return; }
  const sk = it.instances.find(f => f.scene && it.scenes[f.scene]?.img)?.scene;
  const sc = sk ? it.scenes[sk] : null;
  const boxes = sc ? it.instances.filter(f => f.scene === sk && f.drawable.ok).map(f => ({ box: f.box })) : [];
  const keys = h('div', { class: 'label-keys', role: 'group', 'aria-label': 'Label' }, Object.entries(W.LABELS).map(([n, v]) => {
    const b = h('button', { type: 'button', class: `b${it.label === v ? ' b-primary' : ''}`, 'aria-pressed': it.label === v ? 'true' : 'false', 'aria-keyshortcuts': n }, h('span', { class: 'kbd' }, n), W.LABEL_WORDS[v]);
    b.addEventListener('click', () => labelSet(v));
    return b;
  }));
  show(h('section', { class: 'view', 'aria-labelledby': 'h-label' }, h('div', { class: 'stack' }, banner,
    h('div', { class: 'panel-box' },
      h('p', { class: 'eyebrow' }, `${it.lens.id}${it.lens.name ? ` · ${it.lens.name}` : ''} · item ${L.at + 1} of ${pool.total}`),
      h('h1', { id: 'h-label' }, it.claim || '(no claim text)'),
      it.question ? h('p', null, h('b', null, 'Checklist: '), it.question) : null,
      it.lens.definition ? h('details', null, h('summary', null, 'Lens definition'), h('p', { class: 'small' }, it.lens.definition)) : null,
      sc ? shot(sc, boxes, { crop: boxes.length > 0, label: `Screenshot of ${sc.route}${boxes.length ? ', with the element outlined' : ''}`, cls: sc.viewport === 'm' ? 'shot-m' : '' }) : h('p', { class: 'muted' }, 'No screenshot for this claim.'),
      h('dl', { class: 'facts-dl' }, it.code ? [h('dt', null, 'Code'), h('dd', { class: 'mono' }, `${it.code.file}${it.code.line ? `:${it.code.line}` : ''}`)] : null,
        it.instances.find(f => f.selector) ? [h('dt', null, 'Element'), h('dd', { class: 'mono' }, it.instances.find(f => f.selector).selector)] : null),
      h('p', { class: 'small muted' }, 'Correct only if the defect is there in this screen, at this element (or inside or around it), and is a defect under the lens. Unsure counts as wrong.'),
      keys, h('p', { class: 'small muted' }, 'J / K: next / previous item.')))));
  if (focus) focusHeading();
}
async function labelSet(v) {
  const it = S.label.item;
  try { await api('/api/label', { method: 'POST', body: { id: it.id, label: v } }); } catch (e) { return announce(`Not saved: ${e.message}`); }
  announce(`${W.LABEL_WORDS[v]}. Saved.`);
  S.label.pool = await api('/api/label/pool');
  if (S.label.at < S.label.pool.items.length - 1) S.label.at++;
  await labelShow();
  focusHeading();
}
function labelKey(e) {
  const k = W.keyOf(e);                                  // by its place on the keyboard (any layout, Caps Lock)
  if (k.length === 1 && !S.keysOn) return;
  if (W.LABELS[k]) { e.preventDefault(); return labelSet(W.LABELS[k]); }
  if (k === 'j' || k === 'k') { e.preventDefault(); const n = S.label.at + (k === 'j' ? 1 : -1); if (n >= 0 && n < S.label.pool.items.length) { S.label.at = n; labelShow(true); } }
  if (k === '?') { e.preventDefault(); help(); }
}

boot();
