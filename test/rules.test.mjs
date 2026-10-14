import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleFindings, secretFindings, mask } from '../src/rules.mjs';

const clean = () => ({
  scene: 'tasks.guest.normal.m', route: '/tasks', viewport: 'm', status: 200,
  pageErrors: [], nativeDialogs: [], requests: [], axe: [],
  measure: {
    viewport: { width: 390, height: 844 }, scrollWidth: 390, cls: 0,
    text: 'Tasks\nWater the fern\nAdd task', mainText: 'Tasks\nWater the fern\nAdd task', clipped: [], images: [], fonts: [{ family: 'Inter', weight: '400', style: 'normal', status: 'loaded' }],
    controls: [{ selector: 'button.add', tag: 'button', name: 'Add task', hasText: true, box: [16, 100, 120, 44], href: null }],
  },
});
const rules = fs => fs.map(f => f.rule).sort();

test('a clean scene has no rule findings', () => {
  assert.deepEqual(ruleFindings(clean()), []);
});

test('L1: status, overflow, clipped text, broken image, failed font, layout shift, page error, failed request', () => {
  const ev = clean();
  ev.status = 500;
  ev.measure.scrollWidth = 912;
  ev.measure.clipped = [{ selector: 'div.clip', box: [0, 0, 80, 24], text: 'long', scrollWidth: 260, clientWidth: 80 }];
  ev.measure.images = [{ selector: 'img', box: [0, 0, 120, 80], src: '/x.png' }];
  ev.measure.fonts.push({ family: 'Brand', weight: '700', style: 'normal', status: 'error' });
  ev.measure.clsBand = 'needs-improvement';
  ev.pageErrors = ['Cannot read properties of null'];
  ev.requests = [{ path: '/api/x', method: 'GET', status: 404, sameOrigin: true, document: false }, { path: '/ok', method: 'GET', status: 200, sameOrigin: true, document: false }, { path: '/x.png', method: 'GET', status: 404, sameOrigin: true, document: false }];
  assert.deepEqual(rules(ruleFindings(ev)), ['broken-image', 'clipped-text', 'failed-request', 'font-not-loaded', 'horizontal-overflow', 'http-status', 'layout-shift', 'page-error']);
});

test('L1: a 1px rounding difference is not overflow; a good CLS band is not a finding', () => {
  const ev = clean();
  ev.measure.scrollWidth = 391;
  ev.measure.clsBand = 'good';
  assert.deepEqual(ruleFindings(ev), []);
});

test('L6: raw error text and missing values', () => {
  const ev = clean();
  ev.measure.text = "Oops: TypeError: Cannot read properties of undefined (reading 'id')\nTotal: NaN\nHello {{ user.name }}\n[object Object]\nDue: undefined";
  const f = ruleFindings(ev);
  assert.deepEqual(rules(f), ['missing-value', 'missing-value', 'missing-value', 'missing-value', 'raw-error-text']);
  assert.deepEqual(f.filter(x => x.rule === 'missing-value').map(x => x.evidence.kind).sort(), ['NaN', '[object Object]', 'undefined', 'unreplaced {{…}}']);
  // the "undefined" inside the raw error line is not counted again: the reported one is "Due: undefined"
  assert.match(f.find(x => x.evidence.kind === 'undefined').evidence.text, /Due: undefined/);
});

test('L6: ordinary words are not raw errors; "undefined" in prose still flags', () => {
  const ev = clean();
  ev.measure.text = 'Errors happen. Type your error report here. Nothing is undefined about our pricing: 30 nan bread.';
  assert.deepEqual(rules(ruleFindings(ev)), ['missing-value']);
});

test('L7: placeholders, coming-soon sprawl, dead hrefs', () => {
  const ev = clean();
  ev.measure.text = 'Lorem ipsum dolor\nContact john@example.com\nTODO: copy\nComing soon\ncoming soon\nComing Soon';
  ev.measure.controls.push({ selector: 'a.archive', tag: 'a', name: 'Archive', hasText: true, box: [0, 0, 60, 20], href: '#', inline: true });
  const f = ruleFindings(ev);
  assert.deepEqual(rules(f), ['coming-soon-sprawl', 'dead-href', 'placeholder-text', 'placeholder-text', 'placeholder-text']);
});

test('L8: axe violations and target sizes (24px minimum, 44px recommended); only inline links exempt', () => {
  const ev = clean();
  ev.axe = [{ id: 'color-contrast', impact: 'serious', nodes: [{ selector: 'p.faint', summary: 'contrast 2.1:1' }] }, { id: 'button-name', impact: 'critical', nodes: [{ selector: 'button.bare', summary: '' }] }];
  ev.measure.controls.push(
    { selector: 'button.tiny', tag: 'button', name: 'Close', hasText: false, box: [0, 0, 20, 20], href: null },
    { selector: 'button.small', tag: 'button', name: 'Pin', hasText: false, box: [0, 0, 32, 32], href: null },
    { selector: 'button.ok', tag: 'button', name: 'Menu', hasText: false, box: [0, 0, 44, 44], href: null },
    { selector: 'a.inline', tag: 'a', name: 'terms', hasText: true, box: [0, 0, 30, 18], href: '/terms', inline: true },
    { selector: 'button.ok-text', tag: 'button', name: 'OK', hasText: true, box: [0, 0, 30, 20], href: null },
  );
  const f = ruleFindings(ev);
  assert.deepEqual(rules(f), ['axe-button-name', 'axe-color-contrast', 'target-size-min', 'target-size-min', 'target-size-recommended']);
  assert.equal(f.find(x => x.rule === 'axe-color-contrast').severity, 'medium');
});

test('L9: native dialogs', () => {
  const ev = clean();
  ev.nativeDialogs = [{ type: 'confirm', message: 'Delete everything?' }];
  assert.deepEqual(rules(ruleFindings(ev)), ['native-dialog']);
});

test('secrets: kinds found, values never kept, service_role JWT recognised, anon JWT ignored', () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = role => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, iss: 'supabase' })}.${'s'.repeat(20)}`;
  const stripe = 'sk_' + 'live_' + 'A1b2C3d4E5f6G7h8I9j0K1l2';
  const scripts = [
    { path: '/app.js', body: `const a="${stripe}"; const k="${jwt('service_role')}";` },
    { path: '/public.js', body: `const anon="${jwt('anon')}";` },
  ];
  const f = secretFindings(scripts);
  assert.deepEqual(f.map(x => [x.evidence.url, x.evidence.kind, x.severity]), [
    ['/app.js', 'stripe-live-secret-key', 'blocker'],
    ['/app.js', 'supabase-service-role-jwt', 'blocker'],
  ]);
  for (const x of f) assert.ok(!JSON.stringify(x).includes(stripe.slice(8)), 'secret value must not appear in a finding');
  assert.equal(mask('sk_live_abcdef'), '', 'location and kind only: no character of the value (D8)');
  for (const x of f) assert.deepEqual(Object.keys(x.evidence).sort(), ['kind', 'url']);
});

test('L1: failures nunchi forced (error/offline states) are not reported as failed requests', () => {
  const ev = clean();
  ev.state = 'error';
  ev.requests = [{ path: '/api/tasks', method: 'GET', status: 500, sameOrigin: true, document: false }];
  assert.deepEqual(ruleFindings(ev), []);
  ev.state = 'normal';
  assert.deepEqual(rules(ruleFindings(ev)), ['failed-request']);
});

test('L2: a forced state that leaves the main area blank', () => {
  const ev = clean();
  ev.state = 'empty';
  ev.measure.mainText = '   ';
  assert.deepEqual(rules(ruleFindings(ev)), ['blank-state']);
  ev.state = 'normal';
  assert.deepEqual(ruleFindings(ev), []);
});

test('L1: failed images are not failed requests (prefetch noise); data, script and style failures are', () => {
  const ev = clean();
  ev.requests = [
    { path: '/hero.png', method: 'GET', status: 404, sameOrigin: true, document: false, type: 'image' },
    { path: '/api/x', method: 'GET', status: 500, sameOrigin: true, document: false, type: 'fetch' },
    { path: '/app.css', method: 'GET', status: 404, sameOrigin: true, document: false, type: 'stylesheet' },
  ];
  assert.deepEqual(ruleFindings(ev).map(f => f.evidence.url).sort(), ['/api/x', '/app.css']);
});

test('L8: 44px guidance only for icon controls; text links and buttons need 24px', () => {
  const ev = clean();
  ev.measure.controls = [
    { selector: 'a.nav', tag: 'a', name: 'Pricing', hasText: true, text: 'Pricing', box: [0, 0, 53, 24], href: '/pricing' },
    { selector: 'button.x', tag: 'button', name: 'Close', hasText: true, text: '×', box: [0, 0, 32, 32], href: null },
    { selector: 'button.svg', tag: 'button', name: '', hasText: false, text: '', box: [0, 0, 40, 40], href: null },
  ];
  assert.deepEqual(ruleFindings(ev).map(f => `${f.rule} ${f.selector}`).sort(), ['target-size-recommended button.svg', 'target-size-recommended button.x']);
});

test('L8: a field described only by its placeholder', () => {
  const ev = clean();
  ev.measure.fields = [
    { selector: 'input.email', box: [0, 0, 300, 40], labelled: false, placeholder: 'Email address' },
    { selector: 'input.name', box: [0, 0, 300, 40], labelled: true, placeholder: 'Your name' },
    { selector: 'input.bare', box: [0, 0, 300, 40], labelled: false, placeholder: '' },
  ];
  assert.deepEqual(ruleFindings(ev).map(f => `${f.rule} ${f.selector}`), ['placeholder-as-label input.email']);
});

test('target size: the WCAG spacing exception passes a small target with room around it; crowded ones fail', () => {
  const ctl = (selector, box, extra = {}) => ({ selector, tag: 'button', name: 'x', hasText: false, text: '', box, inline: false, ...extra });
  const scene = (viewport, controls) => ({ scene: 's', route: '/r', viewport, status: 200, errors: [], pageErrors: [], nativeDialogs: [], requests: [], blocked: [], axe: [],
    measure: { text: '', mainText: '', controls, clipped: [], images: [], links: [], fields: [], styles: [], scrollWidth: 390, scrollHeight: 800, viewport: { width: 390, height: 800 }, fonts: [] } });
  const rules = ev => ruleFindings(ev).map(f => `${f.rule} ${f.selector}`).sort();
  const crowded = [ctl('a', [0, 0, 20, 20]), ctl('b', [20, 0, 20, 20])];
  assert.deepEqual(rules(scene('d', crowded)), ['target-size-min a', 'target-size-min b']);
  const spaced = [ctl('a', [0, 0, 20, 20]), ctl('b', [100, 0, 20, 20])];
  assert.deepEqual(rules(scene('d', spaced)), [], 'passes 2.5.8 by spacing; desktop has no touch guidance');
  assert.deepEqual(rules(scene('m', spaced)), ['target-size-recommended a', 'target-size-recommended b'], 'on the phone it is still small for a finger');
  const textLink = [ctl('open', [0, 0, 42, 20], { hasText: true, text: 'Open', name: 'Open' }), ctl('next', [0, 60, 42, 20], { hasText: true, text: 'Open', name: 'Open' })];
  assert.deepEqual(rules(scene('m', textLink)), [], 'a spaced text link is fine');
});

test('placeholder prose is found, the words used as a name are not', () => {
  const ev = text => ({ scene: 's', route: '/r', viewport: 'd', status: 200, errors: [], pageErrors: [], nativeDialogs: [], requests: [], blocked: [], axe: [],
    measure: { text, mainText: text, controls: [], clipped: [], images: [], links: [], fields: [], styles: [], scrollWidth: 1280, scrollHeight: 800, viewport: { width: 1280, height: 800 }, fonts: [] } });
  assert.deepEqual(ruleFindings(ev('Lorem ipsum dolor sit amet, consectetur.')).filter(f => f.rule === 'placeholder-text').map(f => f.evidence.kind), ['Lorem ipsum']);
  assert.deepEqual(ruleFindings(ev('Generators: UUID Generator, Lorem Ipsum Generator, Password Generator')).filter(f => f.rule === 'placeholder-text'), []);
});

test('raw error text needs the error itself, not prose about it; next/font fallback faces are not the app\'s font', () => {
  const ev = (text, fonts = []) => ({ scene: 's', route: '/r', viewport: 'd', status: 200, errors: [], pageErrors: [], nativeDialogs: [], requests: [], blocked: [], axe: [],
    measure: { text, mainText: text, controls: [], clipped: [], images: [], links: [], fields: [], styles: [], scrollWidth: 1280, scrollHeight: 800, viewport: { width: 1280, height: 800 }, fonts } });
  const has = (e, rule) => ruleFindings(e).some(f => f.rule === rule);
  assert.ok(has(ev('Failed: TypeError: x is undefined'), 'raw-error-text'));
  assert.ok(!has(ev('Prompt: "I am getting a TypeError when calling processData"'), 'raw-error-text'));
  assert.ok(has(ev('', [{ family: 'Inter', weight: '400', style: 'normal', status: 'error' }]), 'font-not-loaded'));
  assert.ok(!has(ev('', [{ family: '__Inter_Fallback_d8ebd1', weight: 'normal', style: 'normal', status: 'error' }]), 'font-not-loaded'));
});

test('quoted error messages and code samples are prose, a bare one on screen is a finding', () => {
  const ev = (text, codeLines = []) => ({ scene: 's', route: '/r', viewport: 'd', status: 200, errors: [], pageErrors: [], nativeDialogs: [], requests: [], blocked: [], axe: [],
    measure: { text, mainText: text, codeLines, controls: [], clipped: [], images: [], links: [], fields: [], styles: [], scrollWidth: 1280, scrollHeight: 800, viewport: { width: 1280, height: 800 }, fonts: [] } });
  const rules = e => ruleFindings(e).map(f => f.rule).filter(r => r === 'raw-error-text' || r === 'missing-value').sort();
  assert.deepEqual(rules(ev("Paste the error 'Cannot read property map of undefined' into the chat.")), []);
  assert.deepEqual(rules(ev('Example:\nconsole.log(undefined)\nTypeError: x is not a function', ['console.log(undefined)', 'TypeError: x is not a function'])), []);
  assert.deepEqual(rules(ev('Hello, undefined! You have NaN tasks.')), ['missing-value', 'missing-value']);
  assert.deepEqual(rules(ev('Error: {"message":"Internal Server Error"}')), ['raw-error-text'], 'raw JSON is not a quotation');
});
