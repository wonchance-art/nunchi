import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleFindings, secretFindings, mask } from '../src/rules.mjs';

const clean = () => ({
  scene: 'tasks.guest.normal.m', route: '/tasks', viewport: 'm', status: 200,
  pageErrors: [], nativeDialogs: [], requests: [], axe: [],
  measure: {
    viewport: { width: 390, height: 844 }, scrollWidth: 390, cls: 0,
    text: 'Tasks\nWater the fern\nAdd task', clipped: [], images: [], fonts: [{ family: 'Inter', weight: '400', style: 'normal', status: 'loaded' }],
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

test('secrets: kinds found, values masked, service_role JWT recognised, anon JWT ignored', () => {
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
  assert.equal(mask('sk_live_abcdef'), 'sk_l…');
});
