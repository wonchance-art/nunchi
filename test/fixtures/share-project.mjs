// A synthetic project for `nunchi share` (spec §7.6): visitor and signed-in screens, a screen whose captured text holds
// a secret-shaped string, and everything a pack must never carry planted where capture writes it (the saved login, a
// recording, network.json, console.json, text.txt, aria.yml, canaries) with marker strings a test looks for. Invented
// content only.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeRun, scene, HOSTILE } from './board-project.mjs';
import { tmp } from './tmp.mjs';
import { writeSetup, kst } from '../../src/share/config.mjs';
import { openState } from '../../src/project.mjs';

// strings that must never reach a pack: each is planted in a file the pack must not read
export const NEVER = ['COOKIE-VALUE-1', 'NETWORK-TOKEN-1', 'PAGE-TEXT-ONLY-IN-TEXT-TXT', 'AUTH-COOKIE-SECRET', 'HAR-BODY-SECRET', 'CONSOLE-LINE-SECRET', 'ARIA-NODE-SECRET', 'CANARY-ANSWER-KEY'];
// page text the export keeps by default and leaves out with page text off
export const PAGE_TEXT = ['PAGE-TEXT-CLAIM-1', 'Hello Ana Fern', 'ana-fern-diary'];
// a synthetic key shape (Stripe's live-key prefix and 24 invented characters): what the scrubber calls stripe-live-secret-key
export const FAKE_KEY = `sk_live_${'Zq9'.repeat(8)}`;

export function shareProject({ git = false, name = null, secretScreen = true, kind = 'sweep', id = '0001', into = null } = {}) {
  let root = into ?? tmp('nunchi-share-');
  if (name && !into) { root = join(root, name); mkdirSync(root); }
  if (git && !into) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
  }
  const scenes = [
    scene('/', 'guest', 'normal', 'd', { h1: 'Plant shelf', controls: [{ selector: 'main > a.more', box: [40, 900, 120, 32] }] }),
    scene('/', 'guest', 'normal', 'm', { controls: [{ selector: 'main > a.more', box: [16, 700, 100, 32] }] }),
    scene('/garden', 'guest', 'error', 'd', { controls: [{ selector: 'main p.err', box: [40, 300, 400, 24] }] }),
    scene('/help', 'guest', 'normal', 'd', { h1: 'Help' }),
    scene('/account', 'signed-in', 'normal', 'd', { h1: 'Hello Ana Fern', controls: [{ selector: 'a.diary', box: [40, 200, 200, 32] }] }),
    scene('/account', 'signed-in', 'normal', 'm', { h1: 'Hello Ana Fern' }),
    scene('/account/plots', 'signed-in', 'normal', 'd', { h1: 'Your plots' }),
  ];
  const f = (rule, severity, sc, selector, evidence, lens = 'L1') => ({ lens, rule, severity, scene: sc.id, route: sc.route, viewport: sc.viewport, selector, box: null, evidence });
  const findings = [
    f('raw-error-text', 'high', scenes[2], 'main p.err', { text: `TypeError: PAGE-TEXT-CLAIM-1 ${HOSTILE}` }, 'L6'),
    f('dead-href', 'medium', scenes[0], 'main > a.more', { href: '#' }, 'L3'),
    f('dead-href', 'medium', scenes[1], 'main > a.more', { href: '#' }, 'L3'),
    f('link-unnamed', 'medium', scenes[4], 'a.diary:has-text("Ana Fern diary")', { href: '/people/ana-fern-diary', name: 'Ana Fern diary' }, 'L8'),
    f('target-size-min', 'low', scenes[6], 'nav a', { width: 12 }, 'L8'),
  ];
  const r = writeRun(root, id, { scenes, findings, extraScene: (dir, s) => {
    writeFileSync(join(dir, 'console.json'), JSON.stringify({ errors: ['CONSOLE-LINE-SECRET'] }));
    writeFileSync(join(dir, 'aria.yml'), '- heading "ARIA-NODE-SECRET"\n');
    // capture writes what it scrubbed as a marker: this screen's text held a key
    if (secretScreen && s.route === '/help') writeFileSync(join(dir, 'text.txt'), 'Your key: [secret-shaped: stripe-live-secret-key]\n');
  } });
  if (kind !== 'sweep') {
    const meta = join(r.run, 'run.json');
    const doc = JSON.parse(readFileSync(meta, 'utf8'));
    writeFileSync(meta, JSON.stringify({ ...doc, kind }));
  }
  const nunchi = join(root, '.nunchi');
  writeFileSync(join(nunchi, 'auth.json'), JSON.stringify({ cookies: [{ name: 'sid', value: 'AUTH-COOKIE-SECRET' }] }));
  mkdirSync(join(nunchi, 'har'), { recursive: true });
  writeFileSync(join(nunchi, 'har', 'guest.json'), JSON.stringify({ body: 'HAR-BODY-SECRET' }));
  writeFileSync(join(r.run, 'canaries.json'), JSON.stringify({ planted: [{ key: 'CANARY-ANSWER-KEY' }] }));
  return { root, nunchi, run: r.run, scenes, id };
}
// A "My Drive" folder of a fake Google Drive for desktop under a home of the test's own
export function driveHome(p) {
  const home = join(p.root, 'home');
  const root = join(home, 'Library', 'CloudStorage', 'GoogleDrive-test@example.invalid', 'My Drive');
  mkdirSync(root, { recursive: true });
  return { home, root };
}
export const SETUP = { schema: 1, on: true, app: 'shop', include: { signedIn: false, pageText: false }, when: 'after', doorbell: null, set: { channel: 'cli-tty', by: 'test person', at: '2026-10-16T16:00:00+09:00' }, stopped: null };
// The setup as the person's terminal records it (tests stand in for the person here)
export function setUp(p, dest, extra = {}) {
  const st = openState(p.nunchi);
  writeSetup(st.root.dir, { ...SETUP, ...extra, dest });
  return st;
}
export const now = () => Date.parse('2026-10-16T17:00:00+09:00');
export { kst };
