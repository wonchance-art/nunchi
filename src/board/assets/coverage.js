// The Coverage view of the board (M7; the mock-up the owner approved on 2026-10-15 KST, §3): what nunchi looked at in
// the latest run, and what it didn't. A module of the page's script: board.js hands it the page's helpers (init). As
// everywhere on the board, what the server sends is data and reaches the page through textContent only.
//
// The map is a grid with one tab stop (roving focus): arrows, Home/End, Ctrl+Home/End, J/K to the next or previous
// cell with a gap, Enter or Space for what was looked at there (the panel), Esc back to the cell. Below 760 px (a
// phone, or 200% zoom) it is a list of pages, native disclosures, so nothing scrolls sideways.
import * as W from './shared.mjs';

const C = W.COVERAGE;
let X = null;
// Below this width of the view (not the window: the sidebar takes its part) the map is a list of pages.
const LIST_BELOW = 760;
export function init(ctx) {
  X = ctx;
  const main = X.main();
  if (main && typeof ResizeObserver === 'function') new ResizeObserver(() => { if (X.S.route.view === 'coverage' && V().data?.run && narrowNow() !== V().narrow) render(); }).observe(main);
}
const V = () => X.S.cov;
const narrowNow = () => { const m = X.main(); const w = m ? m.clientWidth : 0; return w ? w < LIST_BELOW : X.narrow(); };

const where = (p, v, st) => `${W.WHO[p] || p}, ${W.WIDTH[v] || v}${st ? `, ${W.STATE_LABEL[st] || st}` : ''}`;
const byState = (a, b) => W.STATES.indexOf(a.state) - W.STATES.indexOf(b.state);

export async function load(route, { reload = true } = {}) {
  if (reload || !V().data) { try { V().data = await X.api('/api/coverage'); } finally { V().updating = false; } }
  const D = V().data;
  if (!route.scene) V().sel = null;
  V().missing = null;
  if (route.scene && D.run) {
    // a link to one screen's coverage (Progress, Finding detail, Screen detail): its page, its column, its state
    const at = locate(D, `${route.run}/${route.scene}`);
    if (at) {
      if (V().f.state !== 'all') V().f.state = at.cell.state;
      V().sel = { ri: at.ri, ci: at.ci };
      V().focus = `cv-${at.ri}-${at.ci}`;
      V().open.add(at.ri);
    } else {
      // a screen of another run (a first look, a partial run, an older run): not in the run shown, said in words
      V().sel = null;
      V().missing = route.run;
    }
  }
  render(true);
  if (route.scene && V().sel) X.$('cv-panel-h')?.focus();
}

// The row and column of a screen.
function locate(D, key) {
  const cols = columns(D);
  for (const [ri, r] of D.routes.entries()) {
    const cell = r.cells.find(c => c.key === key);
    if (cell) return { ri, ci: cols.findIndex(c => c.person === cell.person && c.vp === cell.viewport), cell };
  }
  return null;
}
const columns = D => D.scope.persons.flatMap(p => D.scope.viewports.map(v => ({ key: `${p}-${v}`, person: p, vp: v })));

// One cell of the map under the filters: { text, gap, name, scenes }.
function view(D, r, col, f) {
  if (col.other) {
    const others = r.cells.filter(c => c.state !== f.state);
    const marks = others.map(c => W.coverageMark(c, f.checks));
    return { text: W.markCounts(marks), parts: W.markParts(marks), gap: marks.some(m => m.gap), name: `${r.route}, ${C.otherStates.toLowerCase()}: ${countWords(marks)}.`, scenes: others, other: true, kinds: marks };
  }
  if (f.state === 'all') {
    const scenes = r.cells.filter(c => c.person === col.person && c.viewport === col.vp).sort(byState);
    const marks = scenes.map(c => W.coverageMark(c, f.checks));
    return { text: W.markCounts(marks), parts: W.markParts(marks), gap: marks.some(m => m.gap), name: `${r.route}, ${where(col.person, col.vp)}, all states: ${countWords(marks)}.`, scenes };
  }
  const c = r.cells.find(x => x.person === col.person && x.viewport === col.vp && x.state === f.state) || null;
  const m = W.coverageMark(c, f.checks);
  return { text: `${W.MARKS[m.kind].sym} ${m.text}`, parts: [{ kind: m.kind, sym: W.MARKS[m.kind].sym, word: m.text }], gap: m.gap, name: W.cellName(r.route, where(col.person, col.vp, f.state), c, f.checks), scenes: c ? [c] : [], empty: !c };
}
// A cell's marks as shown: each shape in a span of its own (a symbol font, its colour), the words beside it; "· none"
// when there is nothing. The cell's accessible name says the same in words.
function marksEl(v) {
  const h = X.h;
  if (!v.parts.length) return [h('span', { class: 'cv-mk cv-mk-none', 'aria-hidden': 'true' }, W.MARKS.none.sym), ` ${C.none}`];
  return v.parts.map((p, i) => [i ? ' · ' : null, h('span', { class: `cv-mk cv-mk-${p.kind}`, 'aria-hidden': 'true' }, p.sym), ` ${p.word ?? p.n}`]);
}
function countWords(marks) {
  const n = {};
  for (const m of marks) n[m.kind] = (n[m.kind] || 0) + 1;
  const parts = W.MARK_ORDER.filter(k => n[k]).map(k => `${n[k]} ${W.MARKS[k].word.toLowerCase()}`);
  return parts.length ? parts.join(', ') : W.MARKS.none.word.toLowerCase();
}
const rowGap = (D, r, cols, f) => !r.opened || cols.some(col => view(D, r, col, f).gap);

// ---- the view ---------------------------------------------------------------------------------------------------

export function render(focus = false) {
  const S = X.S, h = X.h;
  if (S.route.view !== 'coverage') return;
  const D = V().data;
  if (!D || !D.run) {
    X.show(h('section', { id: 'coverage', class: 'view', 'aria-labelledby': 'h-coverage' }, h('div', { class: 'stack' }, h('h1', { id: 'h-coverage' }, C.title), h('p', { class: 'muted' }, C.noRun))));
    if (focus) X.focusHeading();
    return;
  }
  const f = V().f;
  const states = D.scope.states;
  if (!f.state || (f.state !== 'all' && !states.includes(f.state))) f.state = states.includes('normal') ? 'normal' : states[0] || 'all';
  if (f.checks !== 'all' && f.checks !== 'rules' && !Object.hasOwn(D.ai.names || {}, f.checks)) f.checks = 'all';
  const narrow = narrowNow();
  V().narrow = narrow;
  const banners = [
    // a capture running (the summary's line, M5b: how far it is) or stopped ("tell your AI “capture again”")
    D.capture ? h('p', { class: 'banner', role: 'note', id: 'cv-capture' }, D.capture.state === 'running' ? C.running(D.capture.text, D.run) : D.capture.text) : null,
    S.summary?.treeChanged ? h('p', { class: 'banner banner-warn', role: 'note' }, W.WORDS['tree-differs']) : null,
    // the latest capture when it is a first look (M5): the summary's line while the full check after it runs, as Progress
    // says it, else the mock-up's; a newer partial run than the one shown: "Run 0005 · Not a full check: …"
    D.quick ? h('p', { class: 'banner', role: 'note', id: 'cv-first-look' }, D.quick.text || C.quick(D.quick.screens)) : null,
    D.newer ? h('p', { class: 'banner', role: 'note', id: 'cv-newer' }, D.newer.text) : null,
    V().missing ? h('p', { class: 'banner', role: 'note', id: 'cv-missing' }, W.SCREENS.gone(D.run)) : null,
  ];
  X.show(h('section', { id: 'coverage', class: 'view', 'aria-labelledby': 'h-coverage' }, h('div', { class: 'stack' },
    h('div', null, h('h1', { id: 'h-coverage' }, C.title), h('p', { class: 'muted' }, C.sub(D.run, D.fullCheck)), V().updating ? h('p', { class: 'muted small', role: 'status' }, 'Updating…') : null),
    banners, totals(D), gapsPanel(D, narrow), mapPanel(D, narrow), lensPanel(D, narrow))));
  if (focus) X.focusHeading();
}

function meter(n, m) {
  const el = X.h('div', { class: 'meter', 'aria-hidden': 'true' }, X.h('span'));
  el.firstChild.style.width = `${m ? Math.round((n / m) * 100) : 0}%`;
  return el;
}
function totals(D) {
  const h = X.h, T = D.totals;
  const row = (dt, dd, cls = '') => h('div', { class: `cv-row${cls ? ` ${cls}` : ''}` }, h('dt', null, dt), h('dd', null, dd));
  const sc = T.screens, ai = T.ai;
  return h('dl', { class: 'panel-box cv-totals' },
    row(C.screensChecked, [h('span', { class: 'cv-num' }, C.of(sc.checked, sc.total)), meter(sc.checked, sc.total), sc.total > sc.checked ? h('span', { class: 'muted small' }, C.notCheckedN(sc.total - sc.checked)) : null]),
    row(C.aiLooked, ai ? [h('span', { class: 'cv-num' }, C.ofCells(ai.seen, ai.of)), meter(ai.seen, ai.of), ai.of > ai.seen ? h('span', { class: 'muted small' }, C.notN(ai.of - ai.seen)) : null]
      : D.ai.error ? h('span', { class: 'warn' }, C.aiUnreadable(D.ai.run))
        // a first look has no AI review (it hunts the full check): no sentence to tell, the banner says what comes
        : D.kind === 'quick' ? h('span', null, C.aiNotRun(D.run))
          : [h('span', null, C.aiNotRun(D.run)), ' ', h('span', { class: 'cv-say' }, C.tell(C.say.run), ' ', X.copyButton(C.say.run, 'Copy', { id: 'cv-copy-ai', name: C.copy(C.say.run) }))]),
    row(C.pagesOpened, h('span', { class: 'cv-num' }, C.of(T.pages.opened, T.pages.total))),
    row(C.wholeApp, D.wholeLine, 'cv-wide'),
    D.aiLine ? row(C.aiReview, D.aiLine, 'cv-wide') : null);
}

// What wasn't checked, and what to do (§3.3): a list; each row's buttons are ordinary buttons.
function gapsPanel(D, narrow) {
  const h = X.h;
  const row = g => {
    const btns = [];
    if (g.say) btns.push(X.copyButton(g.say, 'Copy', { id: `gap-copy-${g.id}`, name: C.copy(g.say) }));
    if (g.show) {
      const b = h('button', { type: 'button', class: 'b', id: `gap-show-${g.id}`, 'aria-label': C.showOnMap }, narrow ? C.showShort : C.showOnMap);
      b.addEventListener('click', () => showOnMap(g));
      btns.push(b);
    }
    return h('li', { class: `cv-gap cv-gap-${g.kind}` }, h('span', { class: 'cv-mark', 'aria-hidden': 'true' }, g.mark),
      h('div', { class: 'cv-gap-body' },
        h('p', { class: 'cv-gap-line' }, h('b', null, g.line), g.where ? h('span', { class: 'cv-where muted' }, g.where) : null),
        g.why ? h('p', { class: 'small' }, g.why) : null,
        (g.findings || []).map((x, i) => h('p', { class: 'small cv-found' }, h('span', null, x.text), h('a', { class: 'b b-quiet', id: `gap-open-${g.id}-${i}`, href: `#/finding/${x.group}` }, C.openFinding))),
        g.more ? h('p', { class: 'small muted' }, `and ${g.more} more`) : null,
        g.sentence || btns.length ? h('p', { class: 'cv-say' }, g.sentence ? h('span', null, g.sentence) : null, btns) : null));
  };
  const n = D.gaps.length;
  return h('section', { class: 'panel-box cv-gaps', 'aria-labelledby': 'h-gaps' },
    h('h2', { id: 'h-gaps' }, narrow ? h('span', null, `${C.gapsH} (${n})`) : [h('span', null, C.gapsH), h('span', null, C.gapsMore), h('span', { class: 'cv-count' }, String(n))]),
    D.warnings.map(w => h('p', { class: 'warn small', role: 'note' }, w)),
    n ? h('ul', { class: 'cv-gap-list' }, D.gaps.map(row)) : h('p', { class: 'good' }, C.nothingMissing),
    D.fine.length ? [h('h3', { class: 'cv-fine-h' }, C.usuallyFine), h('ul', { class: 'cv-gap-list' }, D.fine.map(row))] : null,
    D.muted.map(m => h('p', { class: 'muted small cv-muted' }, h('span', null, m.line), ' ', h('span', null, m.hint), ' ', h('code', null, m.copy), ' ', X.copyButton(m.copy, 'Copy', { id: `gap-copy-${m.id}`, name: `Copy ${m.copy}` }))));
}

// [Show on map]: State, Checks and "Gaps only" set so the map shows those cells; the focus to the first one.
function showOnMap(g) {
  const D = V().data, f = V().f;
  f.state = g.show.state === 'all' || D.scope.states.includes(g.show.state) ? g.show.state : 'all';
  f.checks = g.show.checks;
  f.show = 'gaps';
  const want = new Set(g.show.cells);
  const cols = columns(D);
  let at = null;
  for (const [ri, r] of D.routes.entries()) {
    for (const [ci, col] of cols.entries()) if (view(D, r, col, f).scenes.some(c => want.has(c.key))) { at = { ri, ci }; break; }
    if (at) break;
  }
  if (at) { V().focus = `cv-${at.ri}-${at.ci}`; V().open.add(at.ri); }
  render();
  focusCell(V().focus);
  // the pages that hold this gap's screens (not every page with some gap under these filters)
  X.announce(C.showing(D.routes.filter(r => r.cells.some(c => want.has(c.key))).length, true));
}
const shownRows = (D, f) => { const cols = columns(D); return D.routes.map((r, ri) => ({ r, ri })).filter(({ r }) => f.show !== 'gaps' || rowGap(D, r, cols, f)); };

function focusCell(id) {
  const el = id && X.$(id);
  if (!el) return;
  // the grid has one tab stop (roving); the phone list's buttons are each their own
  if (el.tagName === 'TD') for (const c of X.main().querySelectorAll('td[data-cv]')) c.setAttribute('tabindex', c === el ? '0' : '-1');
  el.focus();
  el.scrollIntoView?.({ block: 'nearest' });
}

// ---- the map ----------------------------------------------------------------------------------------------------

function filters(D, narrow) {
  const h = X.h, f = V().f;
  const set = (k, v) => { f[k] = v; render(); X.announce(C.showing(shownRows(D, f).length, f.show === 'gaps')); };
  const stateList = [...D.scope.states, 'all'];
  const stateWord = v => (v === 'all' ? W.SCREENS.all : W.STATE_LABEL[v] || v);
  const checks = h('select', { id: 'cv-checks' }, h('option', { value: 'all', selected: f.checks === 'all' }, C.checksAll), h('option', { value: 'rules', selected: f.checks === 'rules' }, C.checksRules),
    Object.keys(D.ai.names || {}).sort((a, b) => W.lensNumber(a) - W.lensNumber(b)).map(id => h('option', { value: id, selected: f.checks === id }, C.checksLens(D.ai.names[id]))));
  checks.addEventListener('change', () => set('checks', checks.value));
  const checksField = h('label', { class: 'field', for: 'cv-checks' }, C.checks, checks);
  if (narrow) {
    const sel = (id, name, list, word, key) => {
      const s = h('select', { id }, list.map(v => h('option', { value: v, selected: f[key] === v }, word(v))));
      s.addEventListener('change', () => set(key, s.value));
      return h('label', { class: 'field', for: id }, name, s);
    };
    return h('div', { class: 'filters cv-filters' }, sel('cv-state', C.state, stateList, stateWord, 'state'), sel('cv-show', C.show, ['all', 'gaps'], v => (v === 'all' ? C.showAll : C.showGaps), 'show'), checksField);
  }
  const seg = (name, list, word, key, prefix) => h('div', { class: 'seg-b', role: 'group', 'aria-label': name }, list.map(v => {
    const b = h('button', { type: 'button', id: `${prefix}-${v}`, 'aria-pressed': f[key] === v ? 'true' : 'false' }, word(v));
    b.addEventListener('click', () => set(key, v));
    return b;
  }));
  return h('div', { class: 'filters cv-filters' },
    h('span', { class: 'cv-fl' }, h('span', { class: 'muted small' }, C.state), seg(C.state, stateList, stateWord, 'state', 'cv-st')),
    checksField,
    h('span', { class: 'cv-fl' }, h('span', { class: 'muted small' }, C.show), seg(C.show, ['all', 'gaps'], v => (v === 'all' ? C.showAll : C.showGaps), 'show', 'cv-show')));
}
function legend(f) {
  const h = X.h;
  const kinds = f.checks === 'rules' ? ['ok', 'not', 'none'] : ['full', 'partly', 'rules', 'not', 'none'];
  return h('p', { class: 'cv-legend small' }, kinds.map(k => h('span', null, h('span', { class: `cv-mk cv-mk-${k}`, 'aria-hidden': 'true' }, W.MARKS[k].sym), ' ', W.MARKS[k].word)));
}

function mapPanel(D, narrow) {
  const h = X.h, f = V().f;
  const cols = columns(D);
  const withOther = f.state !== 'all' && D.scope.states.length > 1;
  const allCols = withOther ? [...cols, { key: 'other', other: true }] : cols;
  const rows = shownRows(D, f);
  const body = rows.length ? (narrow ? list(D, rows, allCols) : grid(D, rows, allCols)) : h('p', { class: 'empty-note' }, C.noGapPages);
  const sel = V().sel;
  const panel = !narrow && sel && rows.some(x => x.ri === sel.ri) ? cellPanel(D, sel) : null;
  return h('section', { class: 'panel-box cv-map', 'aria-labelledby': 'h-map' }, h('h2', { id: 'h-map' }, C.mapH),
    filters(D, narrow), legend(f),
    h('div', { class: `cv-body${f.state === 'all' ? ' cv-all' : ''}` }, h('div', { class: 'cv-grid-wrap' }, body), panel),
    h('p', { class: 'muted small' }, withMarks(C.footnote)));
}
// The footnote's marks in the map's symbol font, as the legend draws them; here they are part of the sentence, so they
// stay readable to assistive technology.
const withMarks = text => String(text).split(/([●◐○✕])/).map((x, i) => (i % 2 ? X.h('span', { class: 'cv-mk' }, x) : x));

function grid(D, rows, cols) {
  const h = X.h, f = V().f;
  const ids = [];
  const head = h('tr', { role: 'row', 'aria-rowindex': '1' }, h('th', { role: 'columnheader', scope: 'col', class: 'cv-page-h' }, C.page),
    cols.map(c => h('th', { role: 'columnheader', scope: 'col' }, c.other ? C.otherStates : [`${W.WHO[c.person] || c.person}·`, h('wbr'), W.WIDTH[c.vp] || c.vp])));
  const body = rows.map(({ r, ri }, i) => {
    const th = h('th', { role: 'rowheader', scope: 'row', class: 'cv-page' }, h('span', { class: 'mono' }, r.route), r.name ? h('span', { class: 'cv-name' }, r.name) : null);
    if (!r.opened) {
      const id = `cv-${ri}-0`; ids.push(id);
      // J/K go to cells of the map (a page × person × width), not to a page that was not opened
      return h('tr', { role: 'row', 'aria-rowindex': String(i + 2) }, th, h('td', { role: 'gridcell', id, 'data-cv': '1', 'data-gap': '0', 'data-ri': String(ri), 'data-ci': '0', colspan: String(cols.length), tabindex: '-1', class: 'cv-cell cv-cell-not', 'aria-selected': 'false', 'aria-label': `${r.route}: ${r.whyText}` },
        h('span', { class: 'cv-mk cv-mk-not', 'aria-hidden': 'true' }, W.MARKS.not.sym), ' ', h('span', null, r.whyText)));
    }
    return h('tr', { role: 'row', 'aria-rowindex': String(i + 2) }, th, cols.map((col, ci) => {
      const v = view(D, r, col, f);
      const id = `cv-${ri}-${ci}`; ids.push(id);
      const sel = V().sel && V().sel.ri === ri && V().sel.ci === ci;
      const kind = v.other || f.state === 'all' ? null : W.coverageMark(v.scenes[0] || null, f.checks).kind;
      // J/K: the cells with a gap of a person × width ("Other states" counts them, it is not one)
      const td = h('td', { role: 'gridcell', id, 'data-cv': '1', 'data-gap': v.gap && !v.other ? '1' : '0', 'data-ri': String(ri), 'data-ci': String(ci), tabindex: '-1',
        class: `cv-cell${kind ? ` cv-k-${kind}` : ''}${sel ? ' cv-sel' : ''}`, 'aria-label': v.name, 'aria-selected': sel ? 'true' : 'false' },
      kind ? marksEl(v) : h('span', { 'aria-hidden': 'true' }, marksEl(v)),
      v.scenes[0]?.changed ? h('span', { class: 'cv-changed small muted' }, ` · ${C.changedSinceAi}`) : null);
      if (!v.other) td.addEventListener('click', () => openCell(ri, ci));
      return td;
    }));
  });
  const focusId = ids.includes(V().focus) ? V().focus : ids[0];
  V().focus = focusId;
  const table = h('table', { class: 'cv-grid', role: 'grid', 'aria-labelledby': 'h-map', 'aria-readonly': 'true', 'aria-rowcount': String(rows.length + 1), 'aria-colcount': String(cols.length + 1) },
    h('thead', null, head), h('tbody', null, body));
  for (const id of ids) { const el = table.querySelector(`[id="${id}"]`); if (el) el.setAttribute('tabindex', id === focusId ? '0' : '-1'); }
  table.addEventListener('keydown', gridKey);
  table.addEventListener('focusin', e => { const c = e.target.closest?.('[data-cv]'); if (c) { V().focus = c.id; for (const x of table.querySelectorAll('[data-cv]')) x.setAttribute('tabindex', x === c ? '0' : '-1'); } });
  return table;
}

// Keys of the grid: arrows, Home/End (Ctrl: the grid's ends), J/K to gaps, Enter/Space opens, by the key's place.
function gridKey(e) {
  const cell = e.target.closest?.('[data-cv]');
  if (!cell || e.altKey || e.metaKey) return;
  const k = W.keyOf(e);
  if (e.ctrlKey && k !== 'Home' && k !== 'End') return;
  const table = e.currentTarget;
  const rows = [...table.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('[data-cv]')]).filter(r => r.length);
  const ri = rows.findIndex(r => r.includes(cell)), ci = rows[ri].indexOf(cell);
  const flat = rows.flat();
  let to = null;
  if (k === 'ArrowRight') to = rows[ri][ci + 1];
  else if (k === 'ArrowLeft') to = rows[ri][ci - 1];
  else if (k === 'ArrowDown') to = rows[ri + 1] && rows[ri + 1][Math.min(ci, rows[ri + 1].length - 1)];
  else if (k === 'ArrowUp') to = rows[ri - 1] && rows[ri - 1][Math.min(ci, rows[ri - 1].length - 1)];
  else if (k === 'Home') to = e.ctrlKey ? flat[0] : rows[ri][0];
  else if (k === 'End') to = e.ctrlKey ? flat[flat.length - 1] : rows[ri][rows[ri].length - 1];
  else if ((k === 'j' || k === 'k') && X.S.keysOn) {
    const i = flat.indexOf(cell);
    const list = k === 'j' ? flat.slice(i + 1) : flat.slice(0, i).reverse();
    to = list.find(c => c.getAttribute('data-gap') === '1');
    if (!to) { e.preventDefault(); e.stopPropagation(); X.announce(k === 'j' ? C.next : C.prev); return; }
  } else if (k === 'Enter' || k === ' ') {
    e.preventDefault(); e.stopPropagation();
    const r = Number(cell.getAttribute('data-ri')), c = Number(cell.getAttribute('data-ci'));
    if (!cell.classList.contains('cv-cell-not') && !isOther(c)) openCell(r, c);
    return;
  } else return;
  e.preventDefault(); e.stopPropagation();
  if (to) focusCell(to.id);
}
const isOther = ci => { const D = V().data; return V().f.state !== 'all' && D.scope.states.length > 1 && ci === columns(D).length; };

function openCell(ri, ci) {
  const D = V().data;
  const r = D.routes[ri], col = columns(D)[ci];
  if (!r || !col) return;
  V().sel = { ri, ci };
  V().focus = `cv-${ri}-${ci}`;
  V().open.add(ri);
  const v = view(D, r, col, V().f);
  const first = v.scenes[0];
  history.replaceState(null, '', first ? `/#/coverage/${D.run}/${encodeURIComponent(first.id)}` : '/#/coverage');
  render();
  X.$('cv-panel-h')?.focus();
}
export function escape() {
  if (!V().sel) return false;
  closePanel();
  return true;
}
function closePanel() {
  V().sel = null;
  history.replaceState(null, '', '/#/coverage');
  render();
  focusCell(V().focus);
}

// What was looked at on one cell (§3.2 "Selected cell panel"): the rule checks, each AI lens, what is open, what to say.
function cellPanel(D, sel) {
  const h = X.h, f = V().f;
  const r = D.routes[sel.ri], col = columns(D)[sel.ci];
  if (!r || !col) return null;
  const v = view(D, r, col, f);
  const close = h('button', { type: 'button', class: 'b b-quiet', id: 'cv-close' }, C.close);
  close.addEventListener('click', closePanel);
  const sevs = W.SEVERITIES;
  const scene = (c, i) => {
    const open = sevs.filter(s => c.open?.[s]).map(s => `${c.open[s]} ${s}`).join(' · ');
    const redirect = /^Not checked: sent to (.+)$/.exec(c.why || '');
    return h('div', { class: 'cv-pscene' },
      h('p', { class: 'small' }, h('span', { class: 'mono' }, r.route), ` · ${W.sceneLabelText(c)}`),
      h('dl', { class: 'facts-dl' },
        h('dt', null, C.ruleChecks), h('dd', null, c.checked ? C.ranIn(D.run) : [h('span', { 'aria-hidden': 'true' }, `${W.MARKS.not.sym} `), c.why, redirect ? `. ${C.judgedAs(redirect[1])}` : '']),
        c.checked ? [h('dt', null, C.aiReview), h('dd', null, c.ai ? C.lensesLooked(c.ai.seen, c.ai.of) : W.MARKS.rules.word, c.changed ? h('span', { class: 'muted' }, ` · ${C.changedSinceAi}`) : null)] : null),
      c.ai && c.ai.lenses.length ? h('ul', { class: 'cv-lenses' }, c.ai.lenses.map(l => h('li', null, h('span', { class: 'cv-ln' }, l.name), h('span', { class: l.status === 'seen' ? '' : 'warn' }, l.text)))) : null,
      c.checked || c.say ? h('dl', { class: 'facts-dl' },
        c.checked ? [h('dt', null, C.openHere), h('dd', null, open || 'None', ' ', h('a', { class: 'b b-quiet', id: `cv-open-${i}`, href: `#/screens/${D.run}/${encodeURIComponent(c.id)}` }, C.openScreen))] : null,
        c.say ? [h('dt', null, C.tellAi), h('dd', null, `“${c.say.say}”`, ' ', X.copyButton(c.say.say, 'Copy', { id: `cv-copy-${i}`, name: C.copy(c.say.say) }))] : null) : null);
  };
  return h('section', { class: 'cv-panel', 'aria-labelledby': 'cv-panel-h' },
    h('div', { class: 'sp-head' }, h('h3', { id: 'cv-panel-h', tabindex: '-1' }, r.name || r.route), close),
    v.scenes.length ? v.scenes.map(scene) : [h('p', { class: 'small' }, h('span', { class: 'mono' }, r.route), ` · ${where(col.person, col.vp, f.state === 'all' ? null : f.state).replace(/, /g, ' · ')}`),
      h('p', null, h('span', { 'aria-hidden': 'true' }, `${W.MARKS.none.sym} `), `${C.noForced}.`)]);
}

// The map on a phone (below 760 px): a list of pages, each a native disclosure; a cell opens the same panel under it.
function list(D, rows, cols) {
  const h = X.h, f = V().f;
  return h('ul', { class: 'cv-list', 'aria-labelledby': 'h-map' }, rows.map(({ r, ri }) => {
    if (!r.opened) {
      return h('li', null, h('details', { class: 'cv-page-d', id: `cv-d-${ri}` }, h('summary', null, h('span', { class: 'mono' }, r.route), h('span', { class: 'cv-sum' }, h('span', { class: 'cv-mk cv-mk-not', 'aria-hidden': 'true' }, `${W.MARKS.not.sym} `), 'Not opened')),
        h('p', { class: 'small pad' }, r.whyText)));
    }
    const pw = cols.filter(c => !c.other);
    const views = pw.map(col => view(D, r, col, f));
    // the page's summary counts its person·width cells by mark ("◐ 4 of 4": all four partly)
    const kinds = f.state === 'all' ? views.flatMap(v => v.scenes.map(c => W.coverageMark(c, f.checks))) : views.map(v => W.coverageMark(v.scenes[0] || null, f.checks));
    const sum = new Set(kinds.map(k => k.kind)).size === 1 && f.state !== 'all' ? { parts: [{ kind: kinds[0].kind, sym: W.MARKS[kinds[0].kind].sym, word: `${kinds.length} of ${kinds.length}` }] } : { parts: W.markParts(kinds) };
    const lines = pw.map((col, ci) => {
      const v = views[ci];
      const b = h('button', { type: 'button', class: 'cv-line', id: `cv-${ri}-${ci}`, 'data-cv': '1', 'aria-label': v.name }, h('span', null, `${W.WHO[col.person]} · ${W.WIDTH[col.vp]}`), h('span', { class: 'cv-line-v', 'aria-hidden': 'true' }, marksEl(v)));
      b.addEventListener('click', () => openCell(ri, ci));
      const sel = V().sel && V().sel.ri === ri && V().sel.ci === ci;
      return [h('li', null, b), sel ? h('li', { class: 'cv-panel-li' }, cellPanel(D, V().sel)) : null];
    });
    const other = cols.find(c => c.other) ? view(D, r, cols.find(c => c.other), f) : null;
    // the status in words for assistive technology (the marks are hidden from it), the marks and counts for the eye
    const sumWords = new Set(kinds.map(k => k.kind)).size === 1 && f.state !== 'all' ? `${W.MARKS[kinds[0].kind].word}, ${kinds.length} of ${kinds.length}` : countWords(kinds);
    const det = h('details', { class: 'cv-page-d', id: `cv-d-${ri}`, open: V().open.has(ri) }, h('summary', null, h('span', null, h('span', { class: 'mono' }, r.route), r.name ? ` · ${r.name}` : ''),
      h('span', { class: 'cv-sum' }, h('span', { class: 'sr' }, `${sumWords}.`), h('span', { 'aria-hidden': 'true' }, marksEl(sum)))),
      h('ul', { class: 'cv-lines' }, lines, other ? h('li', { class: 'cv-other small' }, h('span', null, C.otherStates), h('span', { 'aria-hidden': 'true' }, marksEl(other)), h('span', { class: 'sr' }, other.name)) : null));
    det.addEventListener('toggle', () => { if (det.open) V().open.add(ri); else V().open.delete(ri); });
    return h('li', null, det);
  }));
}

// By lens (§3.2): the rule checks beside the AI review; collapsed by default on a phone.
function lensPanel(D, narrow) {
  const h = X.h;
  if (narrow) {
    const d = h('details', { class: 'panel-box cv-lens-d', id: 'cv-lens-d', open: V().lensOpen }, h('summary', null, `${C.byLens} (${D.byLens.length})`),
      h('ul', { class: 'cv-lens-list' }, D.byLens.map(l => h('li', null, h('b', null, l.name), h('span', { class: 'small' }, `${C.ruleChecks}: ${l.rule}`), h('span', { class: 'small' }, `AI: ${l.ai}`)))));
    d.addEventListener('toggle', () => { V().lensOpen = d.open; });
    return d;
  }
  return h('section', { class: 'panel-box', 'aria-labelledby': 'h-lens' }, h('h2', { id: 'h-lens' }, C.byLens),
    h('table', { class: 'cv-lens' }, h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Lens'), h('th', { scope: 'col' }, C.ruleChecks), h('th', { scope: 'col' }, C.aiCol))),
      h('tbody', null, D.byLens.map(l => h('tr', null, h('th', { scope: 'row' }, l.name), h('td', null, l.rule), h('td', null, l.ai))))));
}
