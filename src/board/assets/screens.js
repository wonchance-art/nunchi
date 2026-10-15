// Screens of the board: the wall and one screen at a time (M7; the mock-up the owner approved on 2026-10-15 KST, §4).
// A module of the page's script: board.js hands it the page's helpers (init). Screens is a viewer (decision D4): no
// decision key works here; Enter opens a finding, which is decided in Finding detail. What the server sends is data
// and reaches the page through textContent only.
import * as W from './shared.mjs';

const T = W.SCREENS;
let X = null;
export function init(ctx) { X = ctx; }

// ---- the wall -----------------------------------------------------------------------------------------------------

// Thumbnails are fetched when they come near the screen (a wall can have hundreds).
let thumbs = null;
function lazy(el, url) {
  if (!('IntersectionObserver' in window)) return X.bg(el, url);
  thumbs ||= new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { thumbs.unobserve(e.target); X.bg(e.target, e.target.getAttribute('data-src')); } }, { rootMargin: '600px' });
  el.setAttribute('data-src', url);
  thumbs.observe(el);
}
const showOk = (s, v) => v === 'all' || (v === 'open' && s.open > 0) || (v === 'not' && !s.checked) || (v === 'changed' && s.changed === true);
const qOk = (s, q) => { const n = String(q || '').trim().toLowerCase(); return !n || [s.route, s.h1 || ''].some(x => String(x).toLowerCase().includes(n)); };
const matches = (s, F) => (F.vp === 'all' || s.viewport === F.vp) && (F.who === 'all' || s.person === F.who) && (F.state === 'all' || s.state === F.state) && showOk(s, F.show) && qOk(s, F.q);
// The wall's screens under its filters, in the order it shows them (page groups, each in the wall's order): what J/K
// walk on the wall and in Screen detail.
export const shownScenes = () => {
  const groups = (X.S.screens?.groups || []).map(g => g.id);
  const rank = s => { const i = groups.indexOf(s.group); return i < 0 ? groups.length : i; };
  return (X.S.screens?.scenes || []).map((s, i) => ({ s, i })).filter(x => matches(x.s, X.S.screenFilter)).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(x => x.s);
};
const aiLine = s => (!s.checked ? null : !s.ai || !s.ai.of ? T.rulesOnly : s.ai.budget ? T.aiBudget : T.ai(s.ai.seen, s.ai.of));
const cardId = key => `card-${String(key).replace(/\s/g, '_')}`;
// "First look" or "Not checked yet" (M5b): text in the board's chip style, never colour alone
const lookChip = s => X.h('span', { class: `tag tag-look tag-${s.look === 'not-yet' ? 'notyet' : 'first'}` }, s.look === 'not-yet' ? T.notYet : T.firstLook);
const BADGES = ['blocker', 'high', 'medium', 'low', 'clean', 'dark'];

export function renderWall(focus = false) {
  const S = X.S, h = X.h;
  if (S.route.view !== 'screens' || !S.screens) return;
  thumbs?.disconnect(); thumbs = null;
  const all = S.screens.scenes;
  const F = S.screenFilter;
  const base = S.screens.baseline;
  const vps = W.VPS.filter(v => all.some(s => s.viewport === v)), whos = W.PERSONS.filter(p => all.some(s => s.person === p)), states = W.STATES.filter(x => all.some(s => s.state === x));
  if (!F.vp) F.vp = vps.includes('d') ? 'd' : vps[0] || 'all';
  if (F.state !== 'all' && !states.includes(F.state)) F.state = 'all';
  if (F.show === 'changed' && !base) F.show = 'all';
  const narrow = X.narrow();
  const count = (key, v) => all.filter(s => matches(s, { ...F, [key]: v })).length;
  const set = (key, v) => { F[key] = v; renderWall(); };
  // a filter: buttons with counts (the screens that value would show under the other filters); selects on a phone
  const filter = (name, list, words, key) => {
    if (list.length < 2) return null;
    const vals = [...list, 'all'];
    const word = v => (v === 'all' ? T.all : words[v] || v);
    if (narrow) {
      const id = `wall-${key}`;
      const sel = h('select', { id }, vals.map(v => h('option', { value: v, selected: F[key] === v }, v === 'all' ? word(v) : `${word(v)} (${count(key, v)})`)));
      sel.addEventListener('change', () => set(key, sel.value));
      return h('label', { class: 'field', for: id }, name, sel);
    }
    return h('span', { class: 'cv-fl' }, h('span', { class: 'muted small', id: `wall-l-${key}` }, name), h('div', { class: 'seg-b', role: 'group', 'aria-labelledby': `wall-l-${key}` }, vals.map(v => {
      const b = h('button', { type: 'button', id: `wall-${key}-${v}`, 'aria-pressed': F[key] === v ? 'true' : 'false' }, word(v), v === 'all' ? null : h('span', { class: 'cnt' }, ` ${count(key, v)}`));
      b.addEventListener('click', () => set(key, v));
      return b;
    })));
  };
  const showList = ['open', 'not', ...(base ? ['changed'] : [])];
  const search = h('input', { id: 'screen-search', type: 'search', value: F.q || '', placeholder: T.searchHint, autocomplete: 'off', spellcheck: 'false' });
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const typing = X.d.activeElement === X.$('screen-search');
      F.q = X.$('screen-search')?.value || '';
      renderWall();
      if (typing) { const s = X.$('screen-search'); s?.focus(); s?.setSelectionRange(s.value.length, s.value.length); }
    }, 250);
  });
  const shown = shownScenes();
  const sel = S.screenSel ? all.find(s => s.key === S.screenSel) : null;
  if (!S.wallFocus || !shown.some(s => s.key === S.wallFocus)) S.wallFocus = shown[0]?.key || null;
  const card = s => {
    const th = h('span', { class: `thumb thumb-${s.viewport === 'm' ? 'm' : 'd'}`, 'aria-hidden': 'true' });
    if (s.img) lazy(th, s.img.thumb); else { th.classList.add('thumb-none'); th.textContent = 'No screenshot'; }
    const ai = aiLine(s);
    const extra = [ai, s.changed === true ? T.changedWord : null].filter(Boolean).join(' · ');
    // during a first look (M5b): a text chip, "First look" on its key screens, "Not checked yet" on the pages it did not
    // open (no screenshot, no finding: the chip is its badge); said in the card's name too
    const notYet = s.look === 'not-yet', look = notYet ? T.notYet : s.look === 'first' ? T.firstLook : null;
    const b = h('button', { type: 'button', id: cardId(s.key), 'data-key': s.key, tabindex: s.key === S.wallFocus ? '0' : '-1', 'aria-pressed': sel?.key === s.key ? 'true' : 'false',
      'aria-label': notYet ? `${s.route}, ${s.label}: ${T.notYet}` : `${s.h1 || s.route}, ${s.label}: ${s.badge}${look ? `. ${look}` : ''}${extra ? `. ${extra}` : ''}` },
    h('span', { class: 'thumb-wrap' }, th, notYet ? null : h('span', { class: `badge badge-${BADGES.includes(s.kind) ? s.kind : 'low'}` }, s.badge)),
    h('span', { class: 'card-body' }, h('span', { class: 'card-name' }, s.h1 || s.route), h('span', { class: 'mono muted small' }, s.route), h('span', { class: 'small muted' }, s.label),
      look ? lookChip(s) : null, s.note ? h('span', { class: `small ${s.kind === 'dark' ? 'warn' : 'muted'}` }, s.note) : null, extra ? h('span', { class: 'small muted' }, extra) : null));
    // a click looks at it in the side panel; the keyboard's Space does the same, Enter opens the screen (wallKey)
    b.addEventListener('click', e => { quickLook(s.key); if (e.detail > 0) X.$('panel-h')?.focus(); });
    b.addEventListener('focus', () => { S.wallFocus = s.key; for (const c of X.main().querySelectorAll('.card button')) c.setAttribute('tabindex', c === b ? '0' : '-1'); });
    return h('li', { class: 'card' }, b);
  };
  let panel = h('p', { class: 'panels-empty muted' }, 'Select a screen to see it large, with its findings outlined and numbered.');
  if (sel) {
    const boxes = sel.findings.filter(f => f.n && !f.why).map(f => ({ box: f.box, n: f.n }));
    const close = h('button', { type: 'button', class: 'b b-quiet', id: 'sp-close' }, 'Close');
    close.addEventListener('click', () => { S.screenSel = null; history.replaceState(null, '', '/#/screens'); renderWall(); X.$(cardId(sel.key))?.focus(); });
    const open = h('button', { type: 'button', class: 'b', id: 'sp-open', 'aria-keyshortcuts': 'Enter' }, W.COVERAGE.openScreen, ' ', h('span', { class: 'kbd', 'aria-hidden': 'true' }, '↵'));
    open.addEventListener('click', () => openScreen(sel));
    panel = h('section', { class: 'screen-panel', 'aria-labelledby': 'panel-h' },
      h('div', { class: 'sp-head' }, h('div', null, h('h2', { id: 'panel-h', tabindex: '-1' }, sel.h1 || sel.route), h('p', { class: 'muted small' }, h('span', { class: 'mono' }, sel.route), ` · ${sel.label}`)), close),
      sel.img ? X.shot(sel, boxes, { label: `Screenshot of ${sel.route}, ${sel.label}${boxes.length ? `, ${W.plural(boxes.length, 'finding')} outlined and numbered` : ''}`, cls: sel.viewport === 'm' ? 'shot-m' : '' })
        // a page the first look did not open (M5b): what it is, and the first look's line (what comes next)
        : sel.look === 'not-yet' ? h('p', { class: 'pad sp-notyet' }, lookChip(sel), S.screens.quick?.text ? h('span', { class: 'small muted' }, S.screens.quick.text) : null)
          : h('p', { class: 'pad muted' }, `Not seen: ${sel.reason || sel.status}.`),
      sel.findings.length ? h('ol', { class: 'sp-list' }, sel.findings.map(f => h('li', null, h('a', { href: `#/finding/${f.group}` },
        h('span', { class: `numb${f.n ? '' : ' numb-none'}` }, f.n ? String(f.n) : '–'),
        h('span', { class: 'sp-text' }, h('span', { class: 'sp-what' }, f.headline), h('span', { class: 'small' }, `${W.SEV_LABEL[X.sevOf(f.severity)]} · ${f.source === 'ai' ? 'AI' : 'Rule'} · ${f.statusText}${f.why ? ` · not outlined: ${f.why}` : ''}`)))))) : sel.img ? h('p', { class: 'pad muted' }, T.nothing) : null,
      sel.look === 'not-yet' ? null : h('p', { class: 'pad sp-open' }, open));
  }
  const withOpen = all.filter(s => s.open > 0).length, clean = all.filter(s => s.badge === 'Clean').length, notChecked = all.filter(s => !s.checked).length;
  const captured = all.filter(s => s.look !== 'not-yet');
  const groups = S.screens.groups.map(g => ({ g, list: shown.filter(s => s.group === g.id) })).filter(x => x.list.length);
  const clear = h('button', { type: 'button', class: 'b', id: 'wall-clear' }, W.COVERAGE.clear);
  clear.addEventListener('click', () => { Object.assign(F, { vp: 'all', who: 'all', state: 'all', show: 'all', q: '' }); renderWall(); X.focusHeading(); });
  X.show(h('section', { id: 'screens', class: 'view', 'aria-labelledby': 'h-screens' }, h('div', { class: 'stack' },
    h('div', { class: 'head-row' }, h('div', null, h('h1', { id: 'h-screens' }, 'Screens'), h('p', { class: 'muted' }, `${W.plural(new Set(captured.map(s => s.route)).size, 'page')}, ${W.plural(captured.length, 'screen')} · every one nunchi captured in run ${S.screens.run || '—'}, as it saw it`))),
    // a quick first look (M5) says so, as Coverage does
    S.screens.quick ? h('p', { class: 'banner', role: 'note', id: 'wall-first-look' }, S.screens.quick.text || W.COVERAGE.quick(S.screens.quick.screens)) : null,
    h('div', { class: 'filters wall-filters' }, filter('Width', vps, W.WIDTH, 'vp'), filter('Who', whos, W.WHO, 'who'), filter('State', states, W.STATE_LABEL, 'state'),
      narrow ? (() => { const sel2 = h('select', { id: 'wall-show' }, ['all', ...showList].map(v => h('option', { value: v, selected: F.show === v }, v === 'all' ? T.all : `${{ open: T.open, not: T.not, changed: T.changed(base) }[v]} (${count('show', v)})`))); sel2.addEventListener('change', () => set('show', sel2.value)); return h('label', { class: 'field', for: 'wall-show' }, T.show, sel2); })()
        : h('span', { class: 'cv-fl' }, h('span', { class: 'muted small', id: 'wall-l-show' }, T.show), h('div', { class: 'seg-b', role: 'group', 'aria-labelledby': 'wall-l-show' }, ['all', ...showList].map(v => {
          const b = h('button', { type: 'button', id: `wall-show-${v}`, 'aria-pressed': F.show === v ? 'true' : 'false' }, v === 'all' ? T.all : { open: T.open, not: T.not, changed: T.changed(base) }[v], v === 'all' ? null : h('span', { class: 'cnt' }, ` ${count('show', v)}`));
          b.addEventListener('click', () => set('show', v));
          return b;
        }))),
      h('label', { class: 'field', for: 'screen-search' }, T.search, h('span', { class: 'kbd', 'aria-hidden': 'true' }, '/'), search)),
    h('p', { class: 'facts-inline' }, h('span', null, h('b', null, String(withOpen)), ' with open findings'), h('span', null, h('b', null, String(clean)), ' clean'),
      h('span', null, h('b', null, String(notChecked)), ' not checked'), h('span', { id: 'wall-shown' }, T.shown(shown.length, all.length))),
    h('div', { class: 'wall-wrap' }, h('div', { class: 'wall-groups' }, groups.length ? groups.map(({ g, list }, i) => h('section', { class: 'wall-group', 'aria-labelledby': `wall-g-${i}` }, h('h2', { id: `wall-g-${i}`, class: 'wall-g-h' }, g.title), h('ul', { class: 'wall' }, list.map(card))))
      : h('div', { class: 'empty-note' }, h('p', null, T.noMatch), h('p', null, clear))), h('aside', { class: 'panels', 'aria-label': 'Selected screen' }, panel)))));
  if (focus) {
    const back = S.wallReturn && X.$(cardId(S.wallReturn));
    S.wallReturn = null;
    if (back) back.focus(); else X.focusHeading();
  }
}

function quickLook(key) {
  const S = X.S;
  S.screenSel = key;
  S.wallFocus = key;
  history.replaceState(null, '', `/#/screen/${encodeURIComponent(key)}`);
  renderWall();
  X.$(cardId(key))?.setAttribute('tabindex', '0');
}
function openScreen(s) { X.go(`#/screens/${s.run}/${encodeURIComponent(s.id)}`); }

// Keys on the wall (§4.5): one tab stop (roving focus on the cards), arrows by position, Home/End, J/K, Space for the
// quick look, Enter to open the screen, / to search. → true when the key was the wall's.
export function wallKey(e, k) {
  const S = X.S;
  const t = e.target;
  const onCard = t instanceof Element && !!t.closest('.card button');
  const cards = [...X.main().querySelectorAll('.card button')];
  const cur = onCard ? t.closest('.card button') : cards.find(c => c.getAttribute('data-key') === S.wallFocus);
  const i = cards.indexOf(cur);
  const to = el => { if (!el) return; el.focus(); el.scrollIntoView?.({ block: 'nearest' }); };
  if (k === '/') { X.$('screen-search')?.focus(); return true; }
  if (k === 'j' || k === 'k') { to(cards[i < 0 ? 0 : i + (k === 'j' ? 1 : -1)]); return true; }
  if (!onCard) return false;
  if (k === 'ArrowRight' || k === 'ArrowLeft') { to(cards[i + (k === 'ArrowRight' ? 1 : -1)]); return true; }
  if (k === 'Home' || k === 'End') { to(k === 'Home' ? cards[0] : cards[cards.length - 1]); return true; }
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    // the card below (above): the nearest one whose top is past this card's edge, closest in its column
    const r = cur.getBoundingClientRect(), mid = r.left + r.width / 2;
    const cand = cards.filter(c => { const b = c.getBoundingClientRect(); return k === 'ArrowDown' ? b.top >= r.bottom - 1 : b.bottom <= r.top + 1; })
      .map(c => { const b = c.getBoundingClientRect(); return { c, dy: Math.abs(b.top - r.top), dx: Math.abs(b.left + b.width / 2 - mid) }; })
      .sort((a, b) => a.dy - b.dy || a.dx - b.dx);
    const row = cand.length ? cand.filter(x => x.dy === cand[0].dy).sort((a, b) => a.dx - b.dx) : [];
    to(row[0]?.c);
    return true;
  }
  const s = S.screens.scenes.find(x => x.key === cur.getAttribute('data-key'));
  // (a page the first look did not open has no screen to open: Enter shows what it is, as Space does)
  if (k === ' ' || (k === 'Enter' && s?.look === 'not-yet')) { quickLook(cur.getAttribute('data-key')); X.announce(`${cur.getAttribute('aria-label')}`); return true; }
  if (k === 'Enter') { if (s) openScreen(s); return true; }
  return false;
}

// ---- one screen (Screen detail, §4.2) -------------------------------------------------------------------------------

export async function loadDetail(r, { from = null } = {}) {
  const S = X.S;
  if (!S.screens || (from !== 'screen' && from !== 'screens')) S.screens = await X.api('/api/screens');
  let data = null;
  try { data = await X.api(`/api/screens/${r.run}/${encodeURIComponent(r.scene)}`); } catch (e) { if (e.status !== 404) throw e; }
  S.sd.data = data;
  renderDetail(from !== 'screen' || !data);
}
// A live update: the same screen in the newest run (the view follows the generation), or the word that it is gone.
export async function refreshDetail() {
  const S = X.S;
  S.screens = await X.api('/api/screens');
  const r = S.route;
  if (S.screens.run && S.screens.run !== r.run && S.screens.scenes.some(s => s.id === r.scene)) {
    S.route = { ...r, run: S.screens.run };
    history.replaceState(null, '', `/#/screens/${S.screens.run}/${encodeURIComponent(r.scene)}`);
  }
  const had = !!S.sd.data;
  let data = null;
  try { data = await X.api(`/api/screens/${S.route.run}/${encodeURIComponent(S.route.scene)}`); } catch (e) { if (e.status !== 404) throw e; }
  S.sd.data = data;
  renderDetail(had && !data);
}

// (the pages a first look did not open are on the wall only: Screen detail walks the screens it has)
const order = () => {
  const S = X.S;
  const list = shownScenes().filter(s => s.look !== 'not-yet');
  const key = S.sd.data?.key;
  if (list.some(s => s.key === key)) return { list, filtered: true };
  // a screen the filters hide (opened from Coverage or a finding): the whole wall, in the order it shows it
  const F = S.screenFilter, was = { ...F };
  Object.assign(F, { vp: 'all', who: 'all', state: 'all', show: 'all', q: '' });
  const all = shownScenes().filter(s => s.look !== 'not-yet');
  Object.assign(F, was);
  return { list: all, filtered: false };
};
const filterWords = () => {
  const F = X.S.screenFilter;
  return [F.vp !== 'all' ? `Width: ${W.WIDTH[F.vp] || F.vp}` : null, F.who !== 'all' ? `Who: ${W.WHO[F.who] || F.who}` : null, F.state !== 'all' ? `State: ${W.STATE_LABEL[F.state] || F.state}` : null,
    F.show !== 'all' ? `${T.show}: ${{ open: T.open, not: T.not, changed: T.changed(X.S.screens?.baseline) }[F.show]}` : null, F.q ? `${T.search}: ${F.q}` : null].filter(Boolean).join(' · ');
};
const goScene = (run, id) => X.go(`#/screens/${run}/${encodeURIComponent(id)}`);

export function renderDetail(focus = false) {
  const S = X.S, h = X.h;
  if (S.route.view !== 'screen') return;
  const D = S.sd.data;
  if (!D) {
    const back = h('a', { class: 'b', id: 'sd-back', href: '#/screens' }, T.back);
    X.show(h('article', { class: 'view sd', 'aria-labelledby': 'h-screen' }, h('div', { class: 'panel-box detail-box' }, h('h1', { id: 'h-screen' }, T.gone(S.screens?.run || '—')), h('p', null, back))));
    X.focusHeading();
    return;
  }
  const narrow = X.narrow();
  const sd = S.sd;
  const vp = D.scene.viewport;
  const both = sd.both && D.widths.d && D.widths.m;
  const shownVps = both ? W.VPS.filter(v => D.widths[v]) : [vp];
  const all = [{ id: D.id, person: D.page.person, viewport: vp, state: D.page.state }, ...D.siblings];
  const has = (p, v, st) => all.find(x => x.person === p && x.viewport === v && x.state === st);
  // the order J/K walk: the wall's filtered order
  const { list, filtered } = order();
  const i = list.findIndex(s => s.key === D.key);
  const prev = i > 0 ? list[i - 1] : null, next = i >= 0 && i < list.length - 1 ? list[i + 1] : null;
  const fw = filtered ? filterWords() : '';
  // the coverage line (rule checks, AI, changed) so "clean" is never read as "fully looked at"
  const cov = D.coverage[vp];
  const covLine = cov && cov.checked ? [T.ruleChecks(true), cov.ai ? T.aiLenses(cov.ai.seen, cov.ai.of, cov.ai.lenses.filter(l => l.status !== 'seen').map(l => (l.reason === 'canary-missed' ? T.doesntCount(l.lens) : T.notChecked(l.lens))).join(', ')) : T.rulesOnlyAi,
    D.scene.changed === true ? T.changedSince(D.baseline) : null].filter(Boolean).join(' · ') : null;

  // the toolbar: width, state, who, whole screen, compare (one toolbar, arrows move in it)
  const tb = [];
  const btn = (id, text, pressed, fn, extra = {}) => { const b = h('button', { type: 'button', id, 'aria-pressed': pressed ? 'true' : 'false', ...extra }, text); b.addEventListener('click', fn); return b; };
  const group = (name, kids) => (kids.filter(Boolean).length ? h('div', { class: 'seg-b', role: 'group', 'aria-label': name }, kids) : null);
  const widths = W.VPS.filter(v => D.widths[v]);
  tb.push(h('span', { class: 'sd-tl muted small' }, 'Width'), group('Width', [...widths.map(v => btn(`sd-w-${v}`, W.WIDTH[v], !both && v === vp, () => { sd.both = false; if (v !== vp) goScene(D.run, D.widths[v].id); else renderDetail(); })),
    widths.length > 1 ? btn('sd-w-both', [T.both, ' ', h('span', { class: 'kbd', 'aria-hidden': 'true' }, 'B')], !!both, () => { sd.both = !both; renderDetail(); }, { 'aria-keyshortcuts': 'B' }) : null]));
  const stateList = W.STATES.filter(st => has(D.page.person, vp, st));
  const whoList = W.PERSONS.filter(p => has(p, vp, D.page.state));
  const pick = (name, id, list, cur, words, toScene) => {
    if (list.length < 2) return null;
    if (narrow) {
      const s = h('select', { id }, list.map(v => h('option', { value: v, selected: v === cur }, words[v] || v)));
      s.addEventListener('change', () => { const x = toScene(s.value); if (x) goScene(D.run, x.id); });
      return h('label', { class: 'field', for: id }, name, s);
    }
    return [h('span', { class: 'sd-tl muted small' }, name), group(name, list.map(v => btn(`${id}-${v}`, words[v] || v, v === cur, () => { const x = toScene(v); if (x) goScene(D.run, x.id); })))];
  };
  tb.push(pick('State', 'sd-st', stateList, D.page.state, W.STATE_LABEL, st => has(D.page.person, vp, st)), stateList.length > 1 && !narrow ? h('span', { class: 'kbd sd-hint', 'aria-hidden': 'true' }, '[ / ]') : null);
  tb.push(pick('Who', 'sd-who', whoList, D.page.person, W.WHO, p => has(p, vp, D.page.state)));
  const anyImg = shownVps.some(v => D.widths[v]?.img && D.coverage[v]?.checked !== false);
  if (anyImg) tb.push(btn('sd-whole', [sd.whole ? T.firstView : T.whole, ' ', h('span', { class: 'kbd', 'aria-hidden': 'true' }, '0')], !!sd.whole, () => { sd.whole = !sd.whole; renderDetail(); }, { 'aria-keyshortcuts': '0', class: 'b' }));
  const sources = D.compare;
  const cur = sources.find(c => c.id === sd.cmp) || null;
  if (sources.length) {
    if (narrow) {
      const s = h('select', { id: 'sd-cmp' }, [h('option', { value: 'off', selected: !cur }, T.off), ...sources.map(c => h('option', { value: c.id, selected: cur?.id === c.id }, c.label))]);
      s.addEventListener('change', () => { sd.cmp = s.value; renderDetail(); });
      tb.push(h('label', { class: 'field', for: 'sd-cmp' }, T.compare, s));
    } else {
      tb.push(h('span', { class: 'sd-tl muted small' }, T.compare), group(T.compare, [btn('sd-cmp-off', T.off, !cur, () => { sd.cmp = 'off'; renderDetail(); }), ...sources.map(c => btn(`sd-cmp-${c.id}`, c.label, cur?.id === c.id, () => { sd.cmp = c.id; renderDetail(); }))]),
        h('span', { class: 'kbd sd-hint', 'aria-hidden': 'true' }, 'C'));
    }
    if (cur) tb.push(h('span', { class: 'sd-tl muted small' }, T.view), group(T.view, [btn('sd-view-slider', T.slider, sd.view !== 'side', () => { sd.view = 'slider'; renderDetail(); }), btn('sd-view-side', T.sideBySide, sd.view === 'side', () => { sd.view = 'side'; renderDetail(); })]));
  }
  const toolbar = h('div', { class: 'sd-tools', role: 'toolbar', 'aria-label': 'Screen', 'aria-orientation': 'horizontal' }, tb.flat().filter(Boolean));
  roving(toolbar);

  // the screenshots, numbered by group (the same defect has the same number on both widths)
  const figure = (v, withCap = true) => {
    const sc = D.widths[v];
    if (!sc) return null;
    const c = D.coverage[v];
    const cap = both && withCap ? h('p', { class: 'sd-cap small' }, W.WIDTH[v]) : null;
    // a screen that was not checked shows no image (a redirect's is another page's): why, and where it is judged
    if (!sc.img || c?.checked === false) {
      const j = D.judged;
      const text = j && v === vp ? T.judged(c?.why || 'Not checked', j.path) : `${c?.why || 'Not checked'}.`;
      return h('figure', { class: 'sd-fig' }, cap, h('p', { class: 'warn' }, text), j && j.key && v === vp ? h('p', null, h('a', { class: 'b', id: 'sd-judged', href: `#/screens/${D.run}/${encodeURIComponent(j.id)}` }, T.openRoute(j.path))) : null);
    }
    const boxes = D.findings.filter(f => f.at[v]?.ok).map(f => ({ box: f.at[v].box, n: f.n }));
    return h('figure', { class: 'sd-fig' }, cap, X.shot(sc, boxes, { first: !sd.whole, on: sd.on, cls: v === 'm' ? 'shot-m' : '',
      label: `Screenshot of ${D.page.route}, ${sc.label}${boxes.length ? `, ${W.plural(boxes.length, 'finding')} outlined and numbered` : ''}` }));
  };
  const compareOf = v => {
    const sc = D.widths[v];
    if (!sc) return null;
    if (D.coverage[v]?.checked === false) return figure(v);
    const cap = both ? h('p', { class: 'sd-cap small' }, W.WIDTH[v]) : null;
    if (cur.gone) return h('div', { class: 'sd-fig' }, cap, h('p', { class: 'muted' }, T.gcd));
    const e = cur.per?.[v];
    if (!e) return figure(v);
    if (e.missing) return h('div', { class: 'sd-fig' }, cap, h('p', { class: 'muted' }, T.notIn(cur.run)), figure(v, false));
    if (e.same) return h('div', { class: 'sd-fig' }, cap, h('p', { class: 'muted' }, T.unchanged(cur.run)), figure(v, false));
    const firstView = x => ({ ...x, img: { ...x.img, url: x.img.thumb, h: x.img.vh } });
    const before = cur.kind === 'run' ? T.before(cur.run) : W.FIX_WORDS.before;
    const after = cur.kind === 'run' ? T.after(D.run) : cur.undone ? T.afterUndone(cur.attempt) : W.FIX_WORDS.after;
    const cls = v === 'm' ? 'shot-m' : '';
    const note = cur.kind === 'run' ? h('p', { class: 'small' }, T.changedPx(cur.run)) : null;
    if (sd.view === 'side') {
      return h('div', { class: 'sd-fig' }, cap, h('div', { class: 'sd-sbs' },
        h('figure', null, h('p', { class: 'small' }, before), X.shot(firstView(e.before), [], { label: `${before}: ${D.page.route}, ${e.before.label}`, cls })),
        h('figure', null, h('p', { class: 'small' }, after), X.shot(firstView(e.after), [], { label: `${after}: ${D.page.route}, ${e.after.label}`, cls }))), note);
    }
    const b = X.shot(firstView(e.before), [], { label: `${before}: ${D.page.route}, ${e.before.label}`, cls });
    const a = X.shot(firstView(e.after), [], { label: `${after}: ${D.page.route}, ${e.after.label}`, cls: `${cls} cmp-after`.trim() });
    const at = Number.isFinite(sd.at) ? sd.at : 50;
    const slider = h('input', { type: 'range', id: `sd-slider-${v}`, class: 'cmp-slider', min: '0', max: '100', step: '5', value: String(at), 'aria-label': W.FIX_WORDS.slider });
    const put = n => { a.style.clipPath = `inset(0 0 0 ${n}%)`; sd.at = n; slider.setAttribute('aria-valuetext', `${W.FIX_WORDS.before} ${n}%, ${W.FIX_WORDS.after} ${100 - n}%`); };
    slider.addEventListener('input', () => put(Number(slider.value)));
    put(at);
    return h('div', { class: 'sd-fig fix-compare', role: 'group', 'aria-label': `${W.FIX_WORDS.slider}, ${D.page.route}, ${W.WIDTH[v]}` }, cap,
      h('div', { class: 'cmp-labels', 'aria-hidden': 'true' }, h('span', null, before), h('span', null, after)), h('div', { class: 'cmp' }, b, a), slider, note);
  };
  // under the figures, as the mock-up has it: both widths number a defect the same
  const figures = h('div', { class: 'sd-main' }, h('div', { class: `sd-figs${both ? ' sd-both' : ''}` }, shownVps.map(v => (cur ? compareOf(v) : figure(v)))),
    both ? h('p', { class: 'small muted sd-same' }, T.sameNumber) : null);

  // the findings on this screen, numbered as the boxes; Enter opens one (decided in Finding detail, D4)
  const widthsText = f => (f.viewports.length === W.VPS.filter(v => D.widths[v]).length && f.viewports.length > 1 ? f.viewports.map(v => W.WIDTH[v]).join(', ') : f.viewports.length === 1 ? T.onlyOn(f.viewports[0]) : '');
  const items = D.findings.map(f => {
    const shownAt = shownVps.map(v => f.at[v]).filter(Boolean);
    const notOutlined = shownAt.length && !shownAt.some(x => x.ok) ? shownAt[0].why : null;
    const meta = [f.source === 'ai' ? `${f.lens} · ${f.checked ? 'double-checked' : 'not double-checked'}` : 'Rule', f.statusText, widthsText(f), f.others ? T.alsoOn(f.others) : null].filter(Boolean).join(' · ');
    const a = h('a', { class: 'sd-f', id: `sd-f-${f.n}`, href: `#/finding/${f.group}` },
      h('span', { class: 'numb', 'aria-hidden': 'true' }, String(f.n)),
      h('span', { class: 'sp-text' }, h('span', { class: 'sp-what' }, h('span', { class: 'sr' }, `${f.n}. `), `${W.SEV_LABEL[X.sevOf(f.severity)]} · ${f.source === 'ai' ? 'AI · ' : ''}${f.headline}`),
        h('span', { class: 'small' }, meta), notOutlined ? h('span', { class: 'small' }, T.notOutlined(notOutlined)) : null));
    a.addEventListener('click', () => { S.returnTo = `#/screens/${D.run}/${encodeURIComponent(D.id)}`; S.sd.back = a.id; });
    a.addEventListener('focus', () => mark(f.n));
    a.addEventListener('blur', () => mark(null));
    return h('li', null, a);
  });
  const side = h('section', { class: 'sd-side', 'aria-labelledby': 'sd-f-h' },
    h('h2', { id: 'sd-f-h' }, T.findingsH(D.findings.length)),
    D.findings.length ? h('ol', { class: 'sp-list sd-list' }, items) : h('p', { class: 'muted' }, T.nothing, covLine ? ` ${covLine}` : ''),
    D.fixedHere.length && D.baseline ? [h('h3', { class: 'sd-h3' }, T.fixedHere(D.baseline, D.fixedHere.length)), h('ul', { class: 'sd-fixed' }, D.fixedHere.map(x => h('li', null, h('span', { class: 'good', 'aria-hidden': 'true' }, '✓ '), T.fixedIn(x.title, x.run))))] : null,
    D.siblings.length ? h('details', { class: 'sp-sibs', id: 'sd-sibs', open: sd.sibsOpen }, h('summary', null, `${T.samePage(D.siblings.length)} ▸`),
      h('ul', { class: 'sd-sibs-list' }, D.siblings.map(x => h('li', null, h('a', { href: `#/screens/${D.run}/${encodeURIComponent(x.id)}` }, W.sceneLabelText(x)))))) : null);
  side.querySelector('#sd-sibs')?.addEventListener('toggle', e => { sd.sibsOpen = e.target.open; });

  const pos = i >= 0 ? T.position(i + 1, list.length, fw) : '';
  X.show(h('article', { class: 'view sd', 'aria-labelledby': 'h-screen' },
    h('nav', { class: 'detail-nav sd-nav', 'aria-label': 'Screen navigation' }, h('a', { href: '#/screens', id: 'sd-all' }, `← ${T.allScreens}`),
      h('span', { class: 'pn' }, prev ? h('a', { href: `#/screens/${prev.run}/${encodeURIComponent(prev.id)}`, rel: 'prev', id: 'sd-prev' }, T.prev) : null,
        next ? h('a', { href: `#/screens/${next.run}/${encodeURIComponent(next.id)}`, rel: 'next', id: 'sd-next' }, T.next) : null, pos ? h('span', { class: 'muted small sd-pos' }, pos) : null)),
    h('div', { class: 'panel-box sd-box' },
      h('header', { class: 'sd-head' },
        h('p', { class: 'chips' }, h('span', { class: `badge-inline badge-${BADGES.includes(D.scene.kind) ? D.scene.kind : 'low'}` }, D.scene.badge), covLine ? h('span', { class: 'muted' }, covLine) : null,
          cov ? h('a', { class: 'b b-quiet', id: 'sd-cov', href: cov.link }, T.coverageLink) : null),
        h('h1', { id: 'h-screen' }, D.page.name || D.page.route),
        h('p', { class: 'muted' }, h('span', { class: 'mono' }, D.page.route), ` · ${W.WHO[D.page.person] || D.page.person}${narrow || !both ? ` · ${W.WIDTH[vp]}` : ''} · ${W.STATE_LABEL[D.page.state] || D.page.state}`)),
      toolbar,
      h('div', { class: 'sd-body' }, figures, side))));
  if (focus) {
    // back from a finding opened here: on its link again, else the screen's heading
    const back = sd.back && X.$(sd.back);
    sd.back = null;
    if (back) back.focus(); else X.focusHeading();
  }
}

// One toolbar, one tab stop: arrows move between its buttons (selects keep their own arrows).
function roving(bar) {
  const btns = () => [...bar.querySelectorAll('button')];
  const was = X.S.sd.tb;
  const list = btns();
  const start = list.find(b => b.id === was) || list.find(b => b.getAttribute('aria-pressed') === 'true') || list[0];
  for (const b of list) b.setAttribute('tabindex', b === start ? '0' : '-1');
  bar.addEventListener('focusin', e => { if (e.target instanceof HTMLButtonElement) { X.S.sd.tb = e.target.id; for (const b of btns()) b.setAttribute('tabindex', b === e.target ? '0' : '-1'); } });
  bar.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    if (!(e.target instanceof HTMLButtonElement)) return;
    const all = btns(), i = all.indexOf(e.target);
    if (i < 0) return;
    e.preventDefault(); e.stopPropagation();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length;
    all[j].focus();
  });
}

// Finding n marked on the screenshots: its box thicker, its number inverted (shape, not colour).
function mark(n) {
  X.S.sd.on = n;
  for (const s of X.main().querySelectorAll('.sd-fig .shot')) s.dataset.on = n === null ? '' : String(n);
  for (const b of X.main().querySelectorAll('.sd-fig .box')) {
    const ns = String(b.getAttribute('data-ns') || '').split(' ').filter(Boolean).map(Number);
    b.classList.toggle('box-on', n !== null && ns.includes(n));
  }
}

// Keys in Screen detail (§4.5). No decision key: F, W, X, S (and Z) do nothing here (D4). → true when handled.
export function detailKey(e, k) {
  const S = X.S, sd = S.sd, D = sd.data;
  if (!D) return false;
  const vp = D.scene.viewport;
  const all = [{ id: D.id, person: D.page.person, viewport: vp, state: D.page.state }, ...D.siblings];
  if (k === 'j' || k === 'k') {
    const { list } = order();
    const i = list.findIndex(s => s.key === D.key);
    const n = list[i + (k === 'j' ? 1 : -1)];
    if (!n) { X.announce(k === 'j' ? T.last : T.first); return true; }
    X.announce(T.said(n.h1 || n.route, n.label, n.badge, list.indexOf(n) + 1, list.length));
    goScene(n.run, n.id);
    return true;
  }
  if (k === 'v') {
    const other = vp === 'd' ? 'm' : 'd';
    if (sd.both) { sd.both = false; renderDetail(); return true; }
    if (D.widths[other]) goScene(D.run, D.widths[other].id);
    return true;
  }
  if (k === 'b') { if (D.widths.d && D.widths.m) { sd.both = !sd.both; renderDetail(); } return true; }
  if (k === '[' || k === ']') {
    const list = W.STATES.filter(st => all.some(x => x.person === D.page.person && x.viewport === vp && x.state === st));
    const i = list.indexOf(D.page.state);
    const st = list[(i + (k === ']' ? 1 : -1) + list.length) % list.length];
    const x = all.find(y => y.person === D.page.person && y.viewport === vp && y.state === st);
    if (x && st !== D.page.state) { X.announce(W.STATE_LABEL[st] || st); goScene(D.run, x.id); }
    return true;
  }
  if (k === '0') { sd.whole = !sd.whole; renderDetail(); return true; }
  if (k === 'c') {
    const ids = ['off', ...D.compare.map(c => c.id)];
    if (ids.length < 2) return true;
    const cur = D.compare.find(c => c.id === sd.cmp)?.id || 'off';
    sd.cmp = ids[(ids.indexOf(cur) + 1) % ids.length];
    renderDetail();
    X.announce(sd.cmp === 'off' ? `${T.compare}: ${T.off}` : `${T.compare}: ${D.compare.find(c => c.id === sd.cmp).label}`);
    return true;
  }
  if (/^[1-9]$/.test(k)) { const a = X.$(`sd-f-${k}`); if (a) a.focus(); return true; }
  return false;
}
// Esc in Screen detail: back to the wall, the focus on this screen's card.
export function escape() {
  const S = X.S;
  if (S.sd.data) { S.wallReturn = S.sd.data.key; S.wallFocus = S.sd.data.key; }
  X.go('#/screens');
  return true;
}
