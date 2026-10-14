// Decision time (design 0.1-c §3.5): the time from the board showing a group to the person's first key on it. The
// page measures it (board/shared.mjs DecisionClock: paused while the tab is hidden and after 30 s without input,
// capped at 120 s); the board server keeps it here, in the state store's `metrics.json`. Never sent anywhere.
//
// - one entry per decision (a single group) or per batch (recorded once, with its size), keyed by the decision's or
//   the batch's id; *Later* is kept apart (deciding "not now" is not deciding);
// - no clock and no randomness of its own: the document is a function of what was recorded (sorted keys, stable JSON).
import { join } from 'node:path';
import { readDoc, updateDoc } from './state.mjs';
import { CAP_MS } from './board/shared.mjs';

export const metricsPath = stateDir => join(stateDir, 'metrics.json');
const BUCKETS = ['singles', 'batches', 'later'];
const NOTE = 'decision times measured by the board (design §3.5), in milliseconds; local only, never sent';
const isEntry = e => !!e && Number.isInteger(e.ms) && e.ms >= 0 && e.ms <= CAP_MS && (e.size === undefined || (Number.isInteger(e.size) && e.size >= 1));
export const isMetricsDoc = d => !!d && typeof d === 'object' && BUCKETS.every(b => d[b] === undefined || (d[b] && typeof d[b] === 'object' && !Array.isArray(d[b]) && Object.values(d[b]).every(isEntry)));
const READ = { validate: isMetricsDoc, why: 'is not a nunchi metrics file', fix: 'delete it (only decision times are lost)' };
const ID = /^[\w-]{1,40}$/;

// Records one measurement; the same id twice is kept once (a retried request does not count twice).
// → the bucket it went to, or null when the reading was not usable.
export function recordDecisionTime(file, { id, ms, size = 1, later = false }, { generation = null } = {}) {
  if (!ID.test(String(id)) || !Number.isFinite(ms) || ms < 0 || !Number.isInteger(size) || size < 1) return null;
  const entry = { ms: Math.min(CAP_MS, Math.round(ms)), ...(size > 1 ? { size } : {}) };
  const bucket = later ? 'later' : size > 1 ? 'batches' : 'singles';
  updateDoc(file, doc => {
    const cur = doc || { schema: 1, note: NOTE };
    if (cur[bucket]?.[id]) return doc;
    return { ...cur, schema: 1, note: NOTE, [bucket]: { ...(cur[bucket] || {}), [id]: entry } };
  }, { read: READ, prev: false, generation });
  return bucket;
}

export function readMetrics(file) { return readDoc(file, READ).doc; }

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null);
// Singles and batches apart (design §3.5: `nunchi trust` prints them separately), Later apart.
export function decisionTimes(doc) {
  const out = {};
  for (const b of BUCKETS) {
    const list = Object.values(doc?.[b] || {}).map(e => e.ms).sort((x, y) => x - y);
    out[b] = { n: list.length, median: quantile(list, 0.5), p90: quantile(list, 0.9), ...(b === 'batches' || b === 'later' ? { groups: Object.values(doc?.[b] || {}).reduce((n, e) => n + (e.size || 1), 0) } : {}) };
  }
  return out;
}
const secs = ms => (ms === null ? '—' : `${Math.round(ms / 100) / 10} s`);
export function formatDecisionTimes(t) {
  if (!t.singles.n && !t.batches.n && !t.later.n) return 'decision time: nothing measured yet (decide in the board: nunchi open)';
  return [`decision time (board): singles median ${secs(t.singles.median)}, p90 ${secs(t.singles.p90)} (${t.singles.n})`,
    `  batches median ${secs(t.batches.median)}, p90 ${secs(t.batches.p90)} (${t.batches.n} batches, ${t.batches.groups} groups)`,
    `  later, apart: median ${secs(t.later.median)} (${t.later.n})`].join('\n');
}
