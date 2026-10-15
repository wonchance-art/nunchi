// Several agents on the board and in `findings` (design 0.1-c §7, M6; the mock-up the owner approved 2026-10-15 KST):
// an AI group's Detail says its reviewer ("confirmed · cross-vendor (OpenAI, as declared)") and who found it ("Claude
// Code (Anthropic) and Codex (OpenAI), as declared"), the findings list says when a kind's groups were found by more
// than one agent, and the Now list's claim and hunt lines carry the name "(as declared)" as their title. Names are
// declared data: clipped and escaped. The browser part needs Chromium (NUNCHI_BROWSER), skipped without one unless
// NUNCHI_REQUIRE_BROWSER is set. Invented content.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startBoard } from '../src/board/server.mjs';
import { reviewerText, foundByText, AGENT_WORDS } from '../src/board/shared.mjs';
import { foldRun, foldAi, emptyState, runForFold, fingerprintOf } from '../src/ledger.mjs';
import { stableJson } from '../src/stable.mjs';
import * as P from '../src/project.mjs';
import * as C from '../src/fix/claims.mjs';
import * as Act from '../src/activity.mjs';
import { smallProject } from './fixtures/board-project.mjs';
import { huntProject, answerAll, deleteAll, tmp } from './fixtures/hunt-run.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
process.env.XDG_STATE_HOME = tmp('nunchi-board-agents-xdg-');
const CLAUDE = { agent: 'Claude Code', vendor: 'Anthropic' }, CODEX = { agent: 'Codex', vendor: 'OpenAI' };
let browser = null, browserOk = true;
before(async () => {
  try { browser = await chromium.launch({ executablePath: process.env.NUNCHI_BROWSER || undefined }); }
  catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(async () => { await browser?.close(); });

test('words: the reviewer (the verdict word, then cross-vendor only when the ledger says so, else same model) and who found it, as declared', () => {
  const v = { status: 'confirmed', by: 'cross-vendor', vendor: 'OpenAI', suspect: false };
  assert.equal(reviewerText(v), 'confirmed · cross-vendor (OpenAI, as declared)');
  assert.equal(reviewerText({ ...v, vendor: null }), 'confirmed · cross-vendor');
  assert.equal(reviewerText({ ...v, by: 'same-model check' }), 'confirmed · same model');
  assert.equal(reviewerText({ status: 'claimed', by: null, vendor: null }), 'not double-checked');
  assert.equal(reviewerText({ status: 'rejected', by: 'same-model check', suspect: true }), 'rejected · same model · suspect');
  assert.equal(reviewerText({ status: 'insufficient', by: 'same-model check', tooFewDecoys: true }), 'insufficient · same model · too few decoys to check the checker: not a double-check');
  assert.equal(foundByText([CLAUDE, CODEX]), 'Claude Code (Anthropic) and Codex (OpenAI), as declared');
  assert.equal(foundByText([CODEX]), 'Codex (OpenAI), as declared');
  assert.equal(foundByText([{ agent: 'Codex', vendor: null }]), 'Codex, as declared', 'a vendor that is not known: the name only');
  assert.equal(foundByText([CLAUDE, CODEX, { agent: 'Third Agent', vendor: 'Example Labs' }]), 'Claude Code (Anthropic), Codex (OpenAI) and Third Agent (Example Labs), as declared');
  assert.equal(foundByText([]), '');
  assert.equal(AGENT_WORDS.agentsFound(2), 'found by 2 agents, as declared');
});

test('cli: a kind found by two agents says so in the findings list; one found by one agent does not', () => {
  const kindLine = agents => {
    const p = huntProject();
    const run = (...a) => execFileSync('node', [CLI, ...a], { cwd: p.cwd, encoding: 'utf8' });
    const plan = JSON.parse(run('hunt', '--plan', '--lens', 'L9', '--json'));
    const u = plan.units.find(x => x.scenes[0].route === '/tasks');
    agents.forEach((who, i) => {
      writeFileSync(join(p.cwd, `${i}.json`), JSON.stringify({ plan: plan.id, ...who, units: [answerAll(u, 'none', deleteAll(i ? 'tasks.guest.normal.d' : 'tasks.guest.normal.m'))] }));
      run('hunt', '--record', `${i}.json`);
    });
    return run('findings', '--all').split('\n').find(l => l.includes('AI · L9.'));
  };
  assert.match(kindLine([CLAUDE, CODEX]), /AI · L9\.destructive-without-confirm — 1 group\(s\) \(found by 2 agents, as declared\) on 1 screen\(s\)/);
  assert.match(kindLine([CODEX]), /AI · L9\.destructive-without-confirm — 1 group\(s\) on 1 screen\(s\)/);
});

// The small project with three AI groups: found by two agents and checked by one of their vendors (same model), found
// by one agent and checked by another vendor (cross-vendor), and claimed only, by an agent with no vendor whose name
// is markup. → { root, nunchi, ids }
function project() {
  const p = smallProject({ prefix: 'nunchi-board-agents-' });
  const st0 = foldRun(emptyState(), { ...runForFold(join(p.nunchi, 'runs', '0001')), stream: 'main' });
  const make = (sc, selector, rule, status, by, vendor, agents) => {
    const f = { source: 'ai', lens: rule.split('.')[0], rule, route: sc.route, scene: sc.id, selector, severity: 'high', evidence: { claim: `Invented claim about ${selector}` } };
    const { fp, group, inputs } = fingerprintOf(f);
    return { fp, group, inputs, lens: f.lens, rule, route: f.route, scene: f.scene, cell: `${sc.person}.${sc.state}.${sc.viewport}`, selector, box: [40, 300, 400, 24], evidence: f.evidence, identity: null,
      status, claimedSeverity: 'high', verdictSeverity: status === 'confirmed' ? 'high' : null, by, vendor, suspect: false, sceneHash: { top: 't', full: 'f', textHash: 'x' }, agents };
  };
  const findings = [
    make(p.scenes[3], 'main p.err', 'L6.vague-error', 'confirmed', 'same-model check', 'OpenAI', [CLAUDE, CODEX]),
    make(p.scenes[0], 'main > a.more', 'L2.inconsistent-term', 'confirmed', 'cross-vendor', 'OpenAI', [CLAUDE]),
    make(p.scenes[2], 'main > a.more', 'L9.destructive-without-confirm', 'claimed', null, null, [{ agent: '<b>Bot</b>', vendor: null }]),
  ];
  const st = foldAi(st0, { run: '0001', stream: 'main', key: 'fixture:agents', findings, seen: [], now: 1_700_000_000_000 });
  mkdirSync(join(p.nunchi, 'state'), { recursive: true });
  writeFileSync(join(p.nunchi, 'state', 'ledger.json'), stableJson(st));
  return { ...p, ids: findings.map(f => f.group) };
}

test('board e2e: Detail says the reviewer and who found it, as declared (two agents, one agent, cross-vendor, same vendor, no vendor); Now\'s lines carry the name "(as declared)"', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = project();
  const sd = P.stateOf(p.nunchi).root.dir;
  // a claim and a hunt in progress, both declared
  assert.equal(C.acquireClaim(sd, { group: p.ids[0], worktree: p.root, branch: 'nunchi/fixes-1015', url: 'http://127.0.0.1:3001', files: ['app/a.js'], agent: 'Claude Code', vendor: 'Anthropic' }).ok, true);
  Act.noteHunt(sd, { agent: 'Codex', vendor: 'OpenAI', stream: 'main', run: '0001', plan: 'p1', lenses: ['L9'], units: 4, answered: 1, complete: 1 });
  const b = await startBoard({ projectDir: p.root });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(b.newLink());
    await page.waitForSelector('#h-progress');
    // one evaluate: each group's Detail facts (by its Group id in the evidence), then the Now list's lines and titles
    const seen = await page.evaluate(async ids => {
      const wait = async fn => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 25)); } return null; };
      const facts = id => {
        const dls = [...document.querySelectorAll('dl.facts-dl')];
        const evidence = dls.find(dl => [...dl.querySelectorAll('dd')].some(dd => dd.textContent === id));
        if (!evidence || !dls.length) return null;
        const out = {};
        for (const dt of dls[0].querySelectorAll('dt')) out[dt.textContent] = { text: dt.nextElementSibling?.textContent ?? null, elements: dt.nextElementSibling?.children.length ?? 0 };
        return out;
      };
      const out = {};
      for (const id of ids) { location.hash = `#/finding/${id}`; out[id] = await wait(() => facts(id)); }
      location.hash = '#/progress';
      out.now = await wait(() => { const li = [...document.querySelectorAll('ul.now li')]; return li.length ? li.map(l => [l.textContent, l.getAttribute('title')]) : null; });
      return out;
    }, p.ids);
    const [both, cross, bot] = p.ids.map(id => seen[id]);
    assert.deepEqual([both.Reviewer.text, both['Found by'].text], ['confirmed · same model', 'Claude Code (Anthropic) and Codex (OpenAI), as declared'], 'two agents; checked by one of their vendors');
    assert.deepEqual([cross.Reviewer.text, cross['Found by'].text], ['confirmed · cross-vendor (OpenAI, as declared)', 'Claude Code (Anthropic), as declared'], 'one agent; checked by another vendor');
    assert.deepEqual([bot.Reviewer.text, bot['Found by']], ['not double-checked', { text: '<b>Bot</b>, as declared', elements: 0 }], 'no vendor: the name only, as text');
    assert.deepEqual(seen.now.map(([, title]) => title), ['Claude Code (as declared)', 'Codex (as declared)']);
    assert.match(seen.now[0][0], /^Claude Code is fixing .+ · just started$/, 'the design\'s words, unchanged');
    assert.equal(seen.now[1][0], 'Codex · AI review L9 · 1/4 units · just started');
  } finally { await context.close(); await b.close(); }
});
