#!/usr/bin/env node
// Statistics for the gate pre-registrations (design 0.1-c §9, docs/prereg-README.md): exact binomial
// (Clopper–Pearson) bounds, exact Poisson bounds, Cohen's kappa, an interval for a paired difference, and seeded
// shuffles, draws and bootstraps. Pure functions: no clock, no randomness of their own, no dependency. A seed in, the
// same numbers out, on every machine (IEEE doubles, operations in a fixed order).
//
// Sides. `sides: 1` is a one-sided bound at `level`; `sides: 2` an equal-tailed interval (each tail (1 − level) / 2).
// The design's pass thresholds are one-sided 95% bounds (3/3 → 36.8%, ≥ 48/56 for 75%, ≥ 135/150 for 85%); its
// reported interval for an estimate (43/50) is the two-sided 95% one. `worked()` prints every such number.
//
//   node scripts/prereg-stats.mjs cp <k> <n> [--sides 1|2] [--level 0.95]
//   node scripts/prereg-stats.mjs min <n> <p0> [--sides 1|2] [--level 0.95]   smallest k whose lower bound is ≥ p0
//   node scripts/prereg-stats.mjs worked                                       the worked-numbers table (markdown)
//   node scripts/prereg-stats.mjs oc                                           the held-out operating characteristic
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const ITER = 200; // bisection steps: far past the precision of a double

function checkCount(k, n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be a whole number ≥ 1 (got ${n})`);
  if (!Number.isInteger(k) || k < 0 || k > n) throw new RangeError(`k must be a whole number from 0 to n (got ${k} of ${n})`);
}
function tailOf({ level = 0.95, sides = 2 } = {}) {
  if (!(level > 0 && level < 1)) throw new RangeError(`level must be between 0 and 1 (got ${level})`);
  if (sides !== 1 && sides !== 2) throw new RangeError(`sides must be 1 or 2 (got ${sides})`);
  return sides === 1 ? 1 - level : (1 - level) / 2;
}

// log of every binomial coefficient C(n, i), i = 0..n, by the recurrence (no factorials, no overflow)
function logChoose(n) {
  const out = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) out[i] = out[i - 1] + Math.log(n - i + 1) - Math.log(i);
  return out;
}
// P(X ≥ k) and P(X ≤ k) for X ~ Binomial(n, p), summed term by term in log space
function binomGE(k, n, p, lc) {
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return 1;
  const lp = Math.log(p), lq = Math.log1p(-p);
  let s = 0;
  for (let i = k; i <= n; i++) s += Math.exp(lc[i] + i * lp + (n - i) * lq);
  return s;
}
function binomLE(k, n, p, lc) {
  if (p <= 0) return 1;
  if (p >= 1) return k === n ? 1 : 0;
  const lp = Math.log(p), lq = Math.log1p(-p);
  let s = 0;
  for (let i = 0; i <= k; i++) s += Math.exp(lc[i] + i * lp + (n - i) * lq);
  return s;
}
// the smallest x in [lo, hi] where `up(x)` holds (up is false then true along the range)
function bisect(up, lo, hi) {
  for (let i = 0; i < ITER; i++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    if (up(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

// Exact (Clopper–Pearson) bounds for k successes in n trials.
//   lower: the p where P(X ≥ k | p) = tail (0 when k = 0); upper: the p where P(X ≤ k | p) = tail (1 when k = n).
export function clopperPearson(k, n, opts = {}) {
  checkCount(k, n);
  const a = tailOf(opts);
  const lc = logChoose(n);
  const lower = k === 0 ? 0 : bisect(p => binomGE(k, n, p, lc) >= a, 0, 1);
  const upper = k === n ? 1 : bisect(p => binomLE(k, n, p, lc) <= a, 0, 1);
  return { k, n, estimate: k / n, lower, upper, level: opts.level ?? 0.95, sides: opts.sides ?? 2 };
}

// The smallest k out of n whose lower bound is ≥ p0 (a pass rule as a count), or null when even n/n is not enough.
export function minCountForLower(n, p0, opts = {}) {
  for (let k = 0; k <= n; k++) if (clopperPearson(k, n, opts).lower >= p0) return k;
  return null;
}
// The largest k out of n whose upper bound is ≤ p0 (an error-rate rule as a count), or null when even 0/n is not enough.
export function maxCountForUpper(n, p0, opts = {}) {
  let best = null;
  for (let k = 0; k <= n; k++) { if (clopperPearson(k, n, opts).upper <= p0) best = k; else break; }
  return best;
}

// Exact (Garwood) bounds for a Poisson count x, e.g. confirmed false positives over clean scenes: divide by the
// number of scenes for a rate per scene.
function poissonLE(x, lam) { let s = 0, t = Math.exp(-lam); for (let i = 0; i <= x; i++) { if (i) t *= lam / i; s += t; } return s; }
export function poissonBounds(x, opts = {}) {
  if (!Number.isInteger(x) || x < 0) throw new RangeError(`x must be a whole number ≥ 0 (got ${x})`);
  const a = tailOf(opts);
  let hi = x + 10;
  while (poissonLE(x, hi) > a) hi *= 2;
  const upper = bisect(lam => poissonLE(x, lam) <= a, 0, hi);
  const lower = x === 0 ? 0 : bisect(lam => 1 - poissonLE(x - 1, lam) >= a, 0, hi);
  return { x, lower, upper, level: opts.level ?? 0.95, sides: opts.sides ?? 2 };
}

// Cohen's kappa for two raters over the same items: pairs = [[labelA, labelB], …] (any strings).
export function cohensKappa(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) throw new RangeError('kappa needs at least one pair of labels');
  const n = pairs.length;
  const a = new Map(), b = new Map();
  let agree = 0;
  for (const [x, y] of pairs) {
    a.set(x, (a.get(x) || 0) + 1); b.set(y, (b.get(y) || 0) + 1);
    if (x === y) agree++;
  }
  const po = agree / n;
  let pe = 0;
  for (const c of [...new Set([...a.keys(), ...b.keys()])].sort()) pe += ((a.get(c) || 0) / n) * ((b.get(c) || 0) / n);
  return { n, po, pe, kappa: pe === 1 ? null : (po - pe) / (1 - pe) };
}

// The standard normal quantile (Acklam's rational approximation, relative error < 1.2e-9).
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new RangeError(`p must be between 0 and 1 (got ${p})`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lowTail = 0.02425;
  if (p < lowTail) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lowTail) return -normalQuantile(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// A paired difference of two proportions over the same n units (Codex − Claude recall by seed, design §9.7 C):
// onlyFirst = units only the first found, onlySecond = units only the second found. Bonett & Price (2012) adjusted
// Wald interval: one pseudo-count added to each discordant cell, n + 2 in the denominators.
export function pairedDifference(onlyFirst, onlySecond, n, opts = {}) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be a whole number ≥ 1 (got ${n})`);
  for (const v of [onlyFirst, onlySecond]) if (!Number.isInteger(v) || v < 0) throw new RangeError(`a discordant count must be a whole number ≥ 0 (got ${v})`);
  if (onlyFirst + onlySecond > n) throw new RangeError('more discordant units than units');
  const z = normalQuantile(1 - tailOf(opts));
  const p1 = (onlyFirst + 1) / (n + 2), p2 = (onlySecond + 1) / (n + 2);
  const d = p1 - p2;
  const se = Math.sqrt((p1 + p2 - d * d) / (n + 2));
  return { estimate: (onlyFirst - onlySecond) / n, adjusted: d, lower: Math.max(-1, d - z * se), upper: Math.min(1, d + z * se), level: opts.level ?? 0.95, sides: opts.sides ?? 2 };
}

// Seeded randomness: mulberry32 and a Fisher–Yates shuffle, the same as bench/fix-gate.mjs's order (so a registered
// order seed gives the order the harness runs).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function seededShuffle(list, seed) {
  const rnd = mulberry32(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
// FNV-1a (32-bit): a name → a sub-seed, so each stratum or participant gets its own stream from one registered seed.
export function subSeed(seed, name) {
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(String(name), 'utf8')) { h ^= ch; h = Math.imul(h, 0x01000193) >>> 0; }
  return (h ^ (seed >>> 0)) >>> 0;
}
const byBytes = (x, y) => Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8'));

// A stratified draw: population = [{id, stratum}], plan = {stratum: count | 'all'}. Within a stratum the ids are
// sorted first (the input order does not matter), then shuffled with the stratum's sub-seed, and the first `count`
// taken. → {strata: {name: {population, taken, ids}}}, the population size kept for weighting back.
export function stratifiedDraw(population, plan, seed) {
  const members = new Map();
  for (const p of population) {
    if (typeof p?.id !== 'string' || typeof p?.stratum !== 'string') throw new TypeError('each member needs a string id and stratum');
    if (!members.has(p.stratum)) members.set(p.stratum, new Set());
    if (members.get(p.stratum).has(p.id)) throw new RangeError(`id ${p.id} twice in stratum ${p.stratum}`);
    members.get(p.stratum).add(p.id);
  }
  const strata = {};
  for (const name of Object.keys(plan).sort(byBytes)) {
    const want = plan[name];
    if (want !== 'all' && !(Number.isInteger(want) && want >= 0)) throw new RangeError(`stratum ${name}: a count ≥ 0 or "all"`);
    const ids = [...(members.get(name) || [])].sort(byBytes);
    const taken = seededShuffle(ids, subSeed(seed, name)).slice(0, want === 'all' ? ids.length : want);
    strata[name] = { population: ids.length, taken: taken.length, ids: taken };
  }
  return { seed: seed >>> 0, strata };
}
// Weighting a stratified sample back to its population: [{population, n, k}] → the population-weighted proportion.
// A stratum with members but no sampled item has no estimate, so it is an error, never a silent 0%.
export function weightedProportion(strata) {
  for (const x of strata) if (x.population > 0 && !(x.n > 0)) throw new RangeError('a stratum with members was not sampled: no estimate can weight it back');
  const total = strata.reduce((s, x) => s + x.population, 0);
  if (!total) return null;
  return strata.reduce((s, x) => s + (x.n ? (x.population / total) * (x.k / x.n) : 0), 0);
}

// Nearest-rank quantile on a sorted list (the board's own definition, src/metrics.mjs): sorted[ceil(q·n) − 1].
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

// A Monte Carlo percentile bootstrap of the mean over units: `resamples` draws of n units with replacement from a
// seeded stream. → {mean, lower, upper}: with sides 1 both are one-sided bounds at `level`; with sides 2, the
// equal-tailed interval. For values on a lattice (found in k of R runs) use `latticeBootstrap`, which is exact.
export function bootstrapMean(values, { seed, resamples = 20000, level = 0.95, sides = 2 } = {}) {
  if (!Array.isArray(values) || !values.length || !values.every(Number.isFinite)) throw new RangeError('bootstrap needs a list of numbers');
  if (!Number.isInteger(seed)) throw new RangeError('bootstrap needs a whole-number seed');
  const a = tailOf({ level, sides });
  const rnd = mulberry32(seed);
  const n = values.length;
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(rnd() * n)];
    means[r] = s / n;
  }
  means.sort();
  const mean = values.reduce((s, v) => s + v, 0) / n;
  return { n, mean, lower: quantile(means, a), upper: quantile(means, 1 - a), resamples, seed, level, sides };
}

// The exact percentile bootstrap of a mean whose values sit on a lattice: each unit's value is j / runs for a whole
// j in [lo, hi] (a seed found in j of 3 runs; a paired difference from −3 to 3). Resampling n units with replacement
// gives a total whose distribution is the n-fold convolution of the units' empirical distribution; it is computed
// exactly, so the bound is the bootstrap's own limit (infinitely many resamples): no seed, no Monte Carlo error.
// Bounds follow the nearest-rank rule of `quantile` (the smallest total whose cumulative probability reaches the tail).
export function latticeBootstrap(values, { runs = 1, level = 0.95, sides = 2 } = {}) {
  if (!Array.isArray(values) || !values.length) throw new RangeError('bootstrap needs a list of numbers');
  if (!Number.isInteger(runs) || runs < 1) throw new RangeError('runs: a whole number ≥ 1');
  const a = tailOf({ level, sides });
  const js = values.map(v => {
    const j = Math.round(v * runs);
    if (!Number.isFinite(v) || Math.abs(v * runs - j) > 1e-9) throw new RangeError(`${v} is not a multiple of 1/${runs}`);
    return j;
  });
  const lo = Math.min(...js), hi = Math.max(...js), n = js.length, w = hi - lo;
  const q = new Float64Array(w + 1);
  for (const j of js) q[j - lo] += 1 / n;
  let dist = Float64Array.of(1);                    // distribution of the shifted total after 0 units
  for (let u = 0; u < n; u++) {
    const next = new Float64Array(dist.length + w);
    for (let s = 0; s < dist.length; s++) { const d = dist[s]; if (d) for (let t = 0; t <= w; t++) if (q[t]) next[s + t] += d * q[t]; }
    dist = next;
  }
  const at = p => { let c = 0; for (let s = 0; s < dist.length; s++) { c += dist[s]; if (c >= p - 1e-12) return (s + n * lo) / (n * runs); } return hi / runs; };
  const mean = js.reduce((s, j) => s + j, 0) / (n * runs);
  return { n, runs, mean, lower: at(a), upper: at(1 - a), level, sides };
}

// The pass probability of a recall rule "lower bound ≥ threshold" for n seeds, `runs` runs each and a true per-run
// recall p, under two models that bracket reality: 'independent' (every run of every seed finds it with probability p
// on its own) and 'all-or-none' (a seed is found in all runs with probability p, else in none).
//   meanBootstrap: the exact bootstrap lower bound of mean-of-runs recall (the held-out primary);
//   majorityCp:    Clopper–Pearson on the seeds found in a majority of runs;
//   singleRunCp:   Clopper–Pearson on one run.
// Exact where it can be (binomial sums); the independent model's bootstrap rule by a seeded simulation of `sims`
// datasets (its Monte Carlo standard error is at most 0.5/√sims).
export function operatingCharacteristic({ n, runs = 3, p, threshold = 0.75, level = 0.95, model = 'independent', sims = 4000, seed = 1 }) {
  const one = { sides: 1, level };
  const kMin = minCountForLower(n, threshold, one);
  const lc = logChoose(n);
  const atLeast = (k, q) => (k === null ? 0 : binomGE(k, n, q, lc));
  const majority = r => { let s = 0; const lr = logChoose(r); for (let i = Math.floor(r / 2) + 1; i <= r; i++) s += binomGE(i, r, p, lr) - (i < r ? binomGE(i + 1, r, p, lr) : 0); return s; };
  const passBoot = vals => latticeBootstrap(vals, { runs, sides: 1, level }).lower >= threshold;
  if (model === 'all-or-none') {
    // the dataset is k seeds always found and n − k never: the bootstrap rule depends on k alone
    let boot = 0;
    for (let k = 0; k <= n; k++) {
      const pk = Math.exp(lc[k] + (k ? k * Math.log(p) : 0) + (n - k ? (n - k) * Math.log1p(-p) : 0));
      if (pk > 1e-15 && passBoot([...Array(k).fill(1), ...Array(n - k).fill(0)])) boot += pk;
    }
    return { n, runs, p, model, meanBootstrap: boot, majorityCp: atLeast(kMin, p), singleRunCp: atLeast(kMin, p), exact: true };
  }
  if (model !== 'independent') throw new RangeError('model: independent or all-or-none');
  const rnd = mulberry32(seed);
  let pass = 0;
  for (let s = 0; s < sims; s++) {
    const vals = new Array(n);
    for (let i = 0; i < n; i++) { let j = 0; for (let r = 0; r < runs; r++) if (rnd() < p) j++; vals[i] = j / runs; }
    if (passBoot(vals)) pass++;
  }
  return { n, runs, p, model, meanBootstrap: pass / sims, majorityCp: atLeast(kMin, majority(runs)), singleRunCp: atLeast(kMin, p), exact: false, sims, seed };
}

// Prevalence- and bias-adjusted kappa for k categories: (k·po − 1) / (k − 1). Reported beside Cohen's kappa, which
// collapses when almost every label is one category.
export function pabak(pairs, categories = 3) {
  if (!Array.isArray(pairs) || !pairs.length) throw new RangeError('PABAK needs at least one pair of labels');
  if (!Number.isInteger(categories) || categories < 2) throw new RangeError('categories: a whole number ≥ 2');
  const po = pairs.filter(([x, y]) => x === y).length / pairs.length;
  return (categories * po - 1) / (categories - 1);
}

// A Williams design: orders of t conditions in which every condition takes every position once and follows every
// other condition once (t even: t orders) or twice (t odd: 2t orders, each order and its reverse).
export function williamsSquare(t) {
  if (!Number.isInteger(t) || t < 2) throw new RangeError('t: a whole number ≥ 2');
  const first = [0];
  for (let j = 1; j < t; j++) first.push(j % 2 ? (j + 1) / 2 : t - j / 2);
  const rows = Array.from({ length: t }, (_, i) => first.map(c => (c + i) % t));
  return t % 2 ? [...rows, ...rows.map(r => [...r].reverse())] : rows;
}

// ---- the worked numbers of docs/prereg-README.md: every figure the design states, recomputed ----

const pct = x => (x * 100).toFixed(1);
export function worked() {
  const one = { sides: 1 }, two = { sides: 2 };
  const cp = (k, n, o) => clopperPearson(k, n, o);
  const rows = [];
  const row = (what, design, value, verdict) => rows.push(`| ${what} | ${design} | ${value} | ${verdict} |`);
  row('3/3 found, lower bound', '37% (§9.1)', `one-sided 95%: ${pct(cp(3, 3, one).lower)}% · two-sided 95%: ${pct(cp(3, 3, two).lower)}%`, 'holds as a one-sided bound');
  const e = cp(43, 50, two);
  row('43/50 correct, interval', '74–94% (§9.2)', `two-sided 95%: ${pct(e.lower)}–${pct(e.upper)}% · one-sided 95% lower: ${pct(cp(43, 50, one).lower)}%`, '**wrong: 73–94%** (two-sided 95%)');
  row('pooled recall, 56 seeds, lower bound ≥ 75%', '≥ 48/56 (§9.1)', `48/56 → ${pct(cp(48, 56, one).lower)}%, 47/56 → ${pct(cp(47, 56, one).lower)}% (one-sided); two-sided needs ${minCountForLower(56, 0.75, two)}/56`, `holds: ${minCountForLower(56, 0.75, one)}/56 (one-sided)`);
  row('precision (b), 150 groups, lower bound ≥ 85%', 'pass at ≥ 135 (§9.2)', `135/150 → ${pct(cp(135, 150, one).lower)}%, 134/150 → ${pct(cp(134, 150, one).lower)}% (one-sided); two-sided needs ${minCountForLower(150, 0.85, two)}/150`, `holds: ${minCountForLower(150, 0.85, one)}/150 (one-sided)`);
  row('precision (a), 50 groups, lower bound ≥ 85%', '"50 labels cannot show ≥ 85%" (§9.2)', `possible only at ≥ ${minCountForLower(50, 0.85, one)}/50 (one-sided), ≥ ${minCountForLower(50, 0.85, two)}/50 (two-sided)`, 'holds near 86%; not for every result');
  row('planted regressions detected', '≥ 28/30 (§9.4)', `28/30 → lower ${pct(cp(28, 30, one).lower)}% (one-sided), ${pct(cp(28, 30, two).lower)}% (two-sided)`, 'a count rule; supports "sensitivity ≥ 80%"');
  row('false alarms on clean fixes', '≤ 1/20 (§9.4)', `1/20 → upper ${pct(cp(1, 20, one).upper)}% (one-sided), ${pct(cp(1, 20, two).upper)}% (two-sided)`, 'a count rule; supports "≤ 22%"');
  row('0 regressions in N, true rate', '≤ 3/N (§9.4)', `N = 20: ${pct(cp(0, 20, one).upper)}% vs 15.0% · N = 30: ${pct(cp(0, 30, one).upper)}% vs 10.0% · N = 40: ${pct(cp(0, 40, one).upper)}% vs 7.5%`, 'holds (one-sided 95%: 1 − 0.05^(1/N) < 3/N)');
  row('re-check: false "gone"', '≤ 1/30 (§9.4)', `1/30 → upper ${pct(cp(1, 30, one).upper)}% (one-sided)`, 'a count rule');
  row('re-check: false "still there"', '≤ 3/30 (§9.4)', `3/30 → upper ${pct(cp(3, 30, one).upper)}% (one-sided)`, 'a count rule');
  row('fix loop, 90% of seeded fixes gone', '≥ 90% (spec §8)', `36/40 → ${pct(cp(36, 40, two).lower)}–${pct(cp(36, 40, two).upper)}% (two-sided); a lower bound ≥ 90% needs ${minCountForLower(40, 0.9, one)}/40 or ${minCountForLower(60, 0.9, one)}/60`, 'a point estimate (registered), interval reported');
  const fp = x => (poissonBounds(x, one).upper / 60).toFixed(3);
  row('clean scenes, ≤ 0.1 confirmed FP per scene, upper bound', '"gated on the upper bound" (§9.3)', `60 scenes: 0 FP → ${fp(0)}, 1 → ${fp(1)}, 2 → ${fp(2)} per scene (exact Poisson, one-sided)`, 'passes with ≤ 1 confirmed FP in 60 scenes');
  row('rule precision on field apps', '≥ 85%, lower bound reported (§9.2)', `85/100 → ${pct(cp(85, 100, two).lower)}–${pct(cp(85, 100, two).upper)}% (two-sided); a lower bound ≥ 85% needs ${minCountForLower(100, 0.85, one)}/100`, 'a point estimate (as the design says)');
  return ['| What | Design says | Recomputed | Verdict |', '|---|---|---|---|', ...rows].join('\n');
}

// The held-out operating characteristic of docs/prereg-heldout.md: pass probabilities of the registered rule and
// the two it replaced, at n = 80 seeds, 3 runs, threshold 75%.
export function heldoutOc({ n = 80, ps = [0.7, 0.75, 0.8, 0.85] } = {}) {
  const f = x => `${Math.round(x * 100)}%`;
  const rows = ['| True per-run recall | Model | Mean of runs, bootstrap bound (registered) | Majority of 3, Clopper–Pearson (replaced) | One run, Clopper–Pearson |', '|---|---|---|---|---|'];
  for (const model of ['independent', 'all-or-none']) for (const p of ps) {
    const r = operatingCharacteristic({ n, runs: 3, p, model });
    rows.push(`| ${f(p)} | ${model} | ${f(r.meanBootstrap)} | ${f(r.majorityCp)} | ${f(r.singleRunCp)} |`);
  }
  return rows.join('\n');
}

function cli(argv) {
  const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? Number(argv[i + 1]) : fallback; };
  const o = { sides: opt('--sides', 2), level: opt('--level', 0.95) };
  const [cmd, x, y] = argv;
  if (cmd === 'cp') {
    const r = clopperPearson(Number(x), Number(y), o);
    return `${x}/${y} = ${pct(r.estimate)}% · ${o.sides === 1 ? 'one' : 'two'}-sided ${o.level * 100}%: lower ${pct(r.lower)}%, upper ${pct(r.upper)}%`;
  }
  if (cmd === 'min') {
    const k = minCountForLower(Number(x), Number(y), o);
    return k === null ? `no count out of ${x} has a lower bound ≥ ${y}` : `${k}/${x} (lower bound ${pct(clopperPearson(k, Number(x), o).lower)}%)`;
  }
  if (cmd === 'worked') return worked();
  if (cmd === 'oc') return heldoutOc();
  throw new Error('usage: prereg-stats.mjs cp <k> <n> | min <n> <p0> [--sides 1|2] [--level 0.95] | worked | oc');
}

// Run as a command only when this file is the program, however it was reached (a link, a junction, a short or
// differently cased Windows path).
const realOrSelf = p => { try { return realpathSync.native(p); } catch { return p; } };
if (process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url))) {
  try { console.log(cli(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(2); }
}
