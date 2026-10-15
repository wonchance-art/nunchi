import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  clopperPearson, minCountForLower, maxCountForUpper, poissonBounds, cohensKappa, normalQuantile, pairedDifference,
  mulberry32, seededShuffle, subSeed, stratifiedDraw, weightedProportion, quantile, bootstrapMean, worked,
} from '../scripts/prereg-stats.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const near = (a, b, tol = 1e-9, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not within ${tol} of ${b}`);
const one = { sides: 1 }, two = { sides: 2 };

test('Clopper–Pearson: closed forms at 0/n and n/n, one- and two-sided', () => {
  for (const n of [1, 3, 20, 30, 56, 150]) {
    near(clopperPearson(n, n, one).lower, Math.pow(0.05, 1 / n), 1e-12, `${n}/${n} one-sided`);
    near(clopperPearson(n, n, two).lower, Math.pow(0.025, 1 / n), 1e-12, `${n}/${n} two-sided`);
    near(clopperPearson(0, n, one).upper, 1 - Math.pow(0.05, 1 / n), 1e-12, `0/${n} one-sided`);
    assert.equal(clopperPearson(0, n, two).lower, 0);
    assert.equal(clopperPearson(n, n, two).upper, 1);
  }
});

test('Clopper–Pearson: the design\'s numbers against exact rational arithmetic (computed apart, 12 digits)', () => {
  // reference values: bisection on the binomial tails with exact fractions (Python fractions + math.comb)
  const e = clopperPearson(43, 50, two);
  near(e.lower, 0.732603997503, 1e-9, '43/50 lower');
  near(e.upper, 0.94180829966, 1e-9, '43/50 upper');
  near(clopperPearson(48, 56, one).lower, 0.756971473081, 1e-9, '48/56');
  near(clopperPearson(47, 56, one).lower, 0.736302419437, 1e-9, '47/56');
  near(clopperPearson(135, 150, one).lower, 0.850198374164, 1e-9, '135/150');
  near(clopperPearson(134, 150, one).lower, 0.842505565742, 1e-9, '134/150');
  near(clopperPearson(28, 30, one).lower, 0.804673956346, 1e-9, '28/30');
  near(clopperPearson(1, 20, one).upper, 0.216106164207, 1e-9, '1/20');
});

test('Clopper–Pearson: symmetric, monotonic, and a one-sided bound is the two-sided 90% one', () => {
  for (const [k, n] of [[0, 7], [3, 10], [43, 50], [100, 100]]) {
    const a = clopperPearson(k, n, two), b = clopperPearson(n - k, n, two);
    near(a.lower, 1 - b.upper, 1e-12, `${k}/${n} symmetry`);
    const c = clopperPearson(k, n, one), d = clopperPearson(k, n, { sides: 2, level: 0.9 });
    near(c.lower, d.lower, 1e-12); near(c.upper, d.upper, 1e-12);
    assert.ok(a.lower <= k / n && k / n <= a.upper);
  }
  let last = -1;
  for (let k = 0; k <= 30; k++) { const l = clopperPearson(k, 30, one).lower; assert.ok(l > last || (k === 0 && l === 0)); last = l; }
  assert.throws(() => clopperPearson(5, 4), RangeError);
  assert.throws(() => clopperPearson(1, 0), RangeError);
  assert.throws(() => clopperPearson(1, 4, { sides: 3 }), RangeError);
  assert.throws(() => clopperPearson(1, 4, { level: 1 }), RangeError);
});

test('pass rules as counts: the design\'s thresholds', () => {
  assert.equal(minCountForLower(56, 0.75, one), 48);    // §9.1: ≥ 48/56
  assert.equal(minCountForLower(56, 0.75, two), 49);
  assert.equal(minCountForLower(150, 0.85, one), 135);  // §9.2 (b): ≥ 135/150
  assert.equal(minCountForLower(150, 0.85, two), 137);
  assert.equal(minCountForLower(50, 0.85, one), 47);    // so 50 labels can show ≥ 85% only at ≥ 47/50
  assert.equal(minCountForLower(3, 0.75, one), null);   // 3 seeds can never show 75%
  assert.equal(maxCountForUpper(20, 0.25, one), 1);     // 1/20 → 21.6%, 2/20 → 28.3%
  assert.equal(maxCountForUpper(20, 0.3, one), 2);
  assert.equal(maxCountForUpper(3, 0.1, one), null);
  // the rule of three (§9.4): 0 in N gives a one-sided 95% upper bound below 3/N
  for (let n = 1; n <= 200; n++) assert.ok(clopperPearson(0, n, one).upper < 3 / n, `N = ${n}`);
});

test('exact Poisson bounds: closed form at 0 and known table values', () => {
  near(poissonBounds(0, one).upper, -Math.log(0.05), 1e-9);
  const p = poissonBounds(3, two);              // Garwood: 0.6187, 8.7673
  near(p.lower, 0.618672, 1e-6); near(p.upper, 8.767273, 1e-6);
  assert.equal(poissonBounds(0, two).lower, 0);
  assert.throws(() => poissonBounds(-1), RangeError);
});

test('Cohen\'s kappa: a textbook 2×2 example and the edges', () => {
  const pairs = [...Array(20).fill(['yes', 'yes']), ...Array(5).fill(['yes', 'no']), ...Array(10).fill(['no', 'yes']), ...Array(15).fill(['no', 'no'])];
  const k = cohensKappa(pairs);
  near(k.po, 0.7, 1e-12); near(k.pe, 0.5, 1e-12); near(k.kappa, 0.4, 1e-12);
  assert.equal(cohensKappa([['a', 'a'], ['b', 'b']]).kappa, 1);
  assert.equal(cohensKappa([['a', 'a'], ['a', 'a']]).kappa, null);   // no variation: kappa is undefined
  assert.throws(() => cohensKappa([]), RangeError);
});

test('normal quantile and the paired difference (Bonett–Price)', () => {
  near(normalQuantile(0.975), 1.959963984540054, 5e-9);
  near(normalQuantile(0.95), 1.6448536269514722, 5e-9);
  near(normalQuantile(0.001), -3.090232306167813, 5e-9);
  // the formula by hand: 2 units only the first found, 5 only the second, 64 units
  const p1 = 3 / 66, p2 = 6 / 66, d = p1 - p2, se = Math.sqrt((p1 + p2 - d * d) / 66);
  const r = pairedDifference(2, 5, 64, one);
  near(r.estimate, -3 / 64, 1e-15); near(r.adjusted, d, 1e-15);
  near(r.lower, d - 1.6448536269514722 * se, 1e-8);
  const s = pairedDifference(5, 2, 64, two), t = pairedDifference(2, 5, 64, two);
  near(s.lower, -t.upper, 1e-12);                   // swapping the two agents mirrors the interval
  assert.ok(pairedDifference(0, 0, 64, one).lower < 0, 'no discordant units still leaves uncertainty');
  assert.throws(() => pairedDifference(40, 30, 64), RangeError);
});

test('seeded shuffle: the fix-gate harness\'s order (spec §6.7: order seed 1 → P01, P18, P03, P15)', () => {
  const fixes = JSON.parse(readFileSync(new URL('../bench/fixes/pebble.json', import.meta.url), 'utf8')).fixes.map(f => f.seed);
  assert.deepEqual(seededShuffle(fixes, 1), ['P01', 'P18', 'P03', 'P15']);
  assert.deepEqual(seededShuffle(fixes, 1), seededShuffle(fixes, 1));
  const r = mulberry32(42), x = [r(), r(), r()];
  assert.ok(x.every(v => v >= 0 && v < 1));
  assert.deepEqual(x, (() => { const q = mulberry32(42); return [q(), q(), q()]; })());
  assert.notEqual(subSeed(1, 'confirmed'), subSeed(1, 'rejected'));
  assert.equal(subSeed(1, 'confirmed'), subSeed(1, 'confirmed'));
});

test('stratified draw: input order does not matter, counts and "all", population kept for weighting', () => {
  const pop = [];
  for (let i = 0; i < 30; i++) pop.push({ id: `c${String(i).padStart(2, '0')}`, stratum: 'confirmed' });
  for (let i = 0; i < 7; i++) pop.push({ id: `i${i}`, stratum: 'insufficient' });
  const plan = { confirmed: 10, insufficient: 'all', rejected: 20 };
  const a = stratifiedDraw(pop, plan, 99), b = stratifiedDraw([...pop].reverse(), plan, 99);
  assert.deepEqual(a, b);
  assert.equal(a.strata.confirmed.taken, 10);
  assert.equal(a.strata.confirmed.population, 30);
  assert.equal(new Set(a.strata.confirmed.ids).size, 10);
  assert.equal(a.strata.insufficient.taken, 7);
  assert.deepEqual(a.strata.rejected, { population: 0, taken: 0, ids: [] });
  assert.notDeepEqual(stratifiedDraw(pop, plan, 100).strata.confirmed.ids, a.strata.confirmed.ids);
  assert.throws(() => stratifiedDraw([{ id: 'x', stratum: 's' }, { id: 'x', stratum: 's' }], { s: 1 }, 1), RangeError);
  near(weightedProportion([{ population: 90, n: 10, k: 9 }, { population: 10, n: 10, k: 5 }]), 0.86, 1e-12);
});

test('quantile and the seeded bootstrap: deterministic, bracketing the mean', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2);   // nearest rank, as src/metrics.mjs
  assert.equal(quantile([1, 2, 3, 4], 0.9), 4);
  assert.equal(quantile([], 0.5), null);
  const v = [...Array(48).fill(1), ...Array(8).fill(0)];
  const a = bootstrapMean(v, { seed: 7, resamples: 5000 }), b = bootstrapMean(v, { seed: 7, resamples: 5000 });
  assert.deepEqual(a, b);
  assert.ok(a.lower < a.mean && a.mean < a.upper);
  near(a.mean, 48 / 56, 1e-15);
  assert.throws(() => bootstrapMean(v, {}), RangeError);
});

test('the command line prints a pass rule as a count', () => {
  const out = execFileSync(process.execPath, ['scripts/prereg-stats.mjs', 'min', '56', '0.75', '--sides', '1'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /^48\/56 \(lower bound 75\.7%\)/);
  assert.match(worked(), /\| 43\/50 correct, interval \| 74–94% \(§9\.2\) \| two-sided 95%: 73\.3–94\.2%/);
});
