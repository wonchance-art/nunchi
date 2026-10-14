// Selectors carry an element's id or data-testid, and apps sometimes put a session or key there
// (`div#sess_sk_live_…`). Selectors written by the paint and token records pass through here.
// First the evidence scrubber (rules.mjs scrubSecrets), so the output is the same `[secret-shaped: <kind>]`
// as everywhere else. Its patterns start at a word boundary, which an id like `sess_sk_live_…` does not have
// (`_` is a word character), so the same kinds are matched again here without the boundary, plus any 40+
// character token mixing letters and digits (`long-token`): ids that long are opaque values, not names.
import { scrubSecrets } from './rules.mjs';

const UNBOUNDED = [
  { kind: 'stripe-live-secret-key', re: /sk_live_[0-9A-Za-z]{16,}/g },
  { kind: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
  { kind: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: 'slack-token', re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'openai-api-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
];
const LONG = /[A-Za-z0-9_-]{40,}/g;

export function redactSelector(selector) {
  if (typeof selector !== 'string') return selector;
  let s = scrubSecrets(selector);
  for (const { kind, re } of UNBOUNDED) s = s.replace(re, `[secret-shaped: ${kind}]`);
  return s.replace(LONG, m => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? '[secret-shaped: long-token]' : m));
}
