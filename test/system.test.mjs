import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystem, parityFindings } from '../src/system.mjs';

const scene = (route, person = 'guest', viewport = 'd', extra = {}) => ({ id: `${route}.${person}.normal.${viewport}`, route, person, viewport, state: 'normal', status: 'captured', redirected: false, httpStatus: 200, ...extra });
const btn = (extra = {}) => ({ role: 'button', selector: 'main > button', color: 'rgb(255, 255, 255)', background: 'rgb(47, 93, 80)', fontSize: '16px', fontWeight: '600', fontFamily: 'system-ui', radius: '8px', shadow: null, height: 44, ...extra });
const h1 = (extra = {}) => ({ role: 'h1', selector: 'main > h1', color: 'rgb(29, 31, 35)', background: 'rgba(0, 0, 0, 0)', fontSize: '28px', fontWeight: '700', fontFamily: 'system-ui', radius: '0px', shadow: null, height: null, ...extra });
const rules = r => r.findings.map(f => `${f.rule} ${f.route}`).sort();

test('L4: a one-off button shape, heading size and heading colour are found; shared and variant values are not', () => {
  const routes = ['/a', '/b', '/c', '/d', '/e'];
  const entries = routes.map(r => scene(r));
  const rows = new Map(entries.map(e => [e.id, [btn(), h1()]]));
  rows.set('/e.guest.normal.d', [btn({ height: 52, radius: '24px', fontWeight: '800' }), h1({ fontSize: '40px', color: 'rgb(90, 90, 255)' })]);
  rows.set('/c.guest.normal.d', [btn(), btn({ height: 36 }), h1()]);   // a size variant: same radius and weight
  rows.set('/d.guest.normal.d', [btn(), btn({ background: 'rgb(255, 255, 255)', color: 'rgb(47, 93, 80)' }), h1(), { ...h1(), role: 'h2', fontSize: '20px' }, { ...h1(), role: 'h1', fontSize: '22px', selector: 'aside > h1' }]);
  const r = buildSystem({ entries, rowsByScene: rows });
  assert.deepEqual(rules(r), ['one-off-button-shape /e', 'one-off-heading-color /e', 'one-off-heading-size /e'],
    'a secondary colour is not a new shape; a second h1 size on a page that also uses the usual one is a variant');
  const f = r.findings.find(x => x.rule === 'one-off-heading-size');
  assert.deepEqual([f.evidence.value, f.evidence.usual, f.evidence.usualScreens], ['40px', '28px', 4]);
  assert.equal(r.system.viewports.d.size.buttonShapes, 3, 'the inventory still lists the size variant');
  assert.deepEqual(r.system.viewports.d['h1.fontSize'].map(x => x.value), ['28px', '22px', '40px']);
});

test('L4: too few screens to know the usual value, error pages, icon and tiny buttons, and persons are handled', () => {
  const three = ['/a', '/b', '/c'].map(r => scene(r));
  const rows = new Map(three.map(e => [e.id, [btn()]]));
  rows.set('/c.guest.normal.d', [btn({ radius: '20px' })]);
  assert.deepEqual(rules(buildSystem({ entries: three, rowsByScene: rows })), [], 'three screens are not enough to call one of them odd');

  const routes = ['/a', '/b', '/c', '/d', '/err', '/icons'];
  const entries = [...routes.map(r => scene(r, 'guest', 'd', r === '/err' ? { httpStatus: 500 } : {})), ...['/a', '/b'].map(r => scene(r, 'signed-in'))];
  const rows2 = new Map(entries.map(e => [e.id, [btn()]]));
  rows2.set('/err.guest.normal.d', [btn({ height: 32, radius: '6px', fontWeight: '500' })]);
  rows2.set('/icons.guest.normal.d', [btn(), btn({ background: 'rgba(0, 0, 0, 0)', radius: '0px', height: 44 }), btn({ height: 18, radius: '4px' })]);
  assert.deepEqual(rules(buildSystem({ entries, rowsByScene: rows2 })), [], 'a framework error page, an icon-only button and an 18px control are not button shapes');
});

test('L10: a desktop control the phone hides outside a menu, or lacks, is missing-on-phone; menus and renamed icons are fine', () => {
  const d = scene('/tasks', 'signed-in', 'd'), m = scene('/tasks', 'signed-in', 'm');
  const c = (name, selector = 'main > button') => ({ name, selector });
  const controlsByScene = new Map([
    [d.id, { visible: [c('Export', 'main > div > button'), c('Add task'), c('Settings', 'nav > a'), c('Archive', 'main > a'), c(''), c('Help', 'footer > a')], hidden: [] }],
    [m.id, { visible: [c('Add task'), c('Open menu')], hidden: [{ name: 'Ex port', menu: false, selector: 'main > div > button' }, { name: 'Settings', menu: true, selector: 'nav > a' }, { name: 'help', menu: true, selector: 'footer > a' }] }],
  ]);
  const f = parityFindings({ entries: [d, m], controlsByScene });
  assert.deepEqual(f.map(x => [x.evidence.name, x.evidence.onPhone, x.scene, x.selector]), [['Export', 'hidden', m.id, 'main > div > button'], ['Archive', 'absent', m.id, 'main > a']]);
  assert.deepEqual(parityFindings({ entries: [d], controlsByScene }), [], 'no phone scene, nothing to compare');
});

test('L10: desktop navigation behind a phone menu button that renders it only when opened is not missing', () => {
  const d = scene('/app', 'guest', 'd'), m = scene('/app', 'guest', 'm');
  const nav = name => ({ name, selector: `aside a.${name}`, inNav: true });
  const withToggle = new Map([[d.id, { visible: [nav('Tasks'), nav('Notes'), { name: 'Export', selector: 'main > button' }], hidden: [] }],
    [m.id, { visible: [{ name: 'Toggle Sidebar', selector: 'header > button', menuToggle: true }], hidden: [] }]]);
  assert.deepEqual(parityFindings({ entries: [d, m], controlsByScene: withToggle }).map(f => f.evidence.name), ['Export'], 'content controls still count');
  const noToggle = new Map([[d.id, withToggle.get(d.id)], [m.id, { visible: [], hidden: [] }]]);
  assert.deepEqual(parityFindings({ entries: [d, m], controlsByScene: noToggle }).map(f => f.evidence.name), ['Tasks', 'Notes', 'Export'], 'no menu button: the navigation is gone');
});
