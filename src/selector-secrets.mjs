// Selectors carry an element's id or data-testid, and apps sometimes put a session or key there
// (`div#sess_sk_live_…`). Selectors written by the paint and token records pass through here, so a
// secret-shaped value is replaced by REDACTED and the evidence keeps only where it was.
// The shapes follow the bundle scanner in rules.mjs, without its word boundaries (an id like
// `sess_sk_live_…` has none), plus any 40+ character token mixing letters and digits.
const SHAPES = [
  /sk_(?:live|test)_[0-9A-Za-z]{16,}/g,
  /rk_live_[0-9A-Za-z]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
const LONG = /[A-Za-z0-9_-]{40,}/g;

export function redactSelector(selector) {
  if (typeof selector !== 'string') return selector;
  let s = selector;
  for (const re of SHAPES) s = s.replace(re, 'REDACTED');
  return s.replace(LONG, m => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? 'REDACTED' : m));
}
