// Who hunted, verified or is fixing (design 0.1-c §7, M6). Agents say who they are and the engine records what they
// declared; it never checks it, so it is always shown as declared (a claim's `declaredAgent` and `declaredVendor`, an
// answers file's `agent` and `vendor`, an AI item's `agents`). A declared name is data: one line of at most 40
// characters, without control characters, compared without regard to case.
export const NAME_MAX = 40;
// C0 and C1 controls, DEL, bidi marks, embeddings, overrides and isolates, line and paragraph separators, BOM
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;

// → { name } (null when nothing was declared) or { error } (`what`: the field, for the message).
export function declaredName(v, what = 'agent') {
  if (v === undefined || v === null) return { name: null };
  if (typeof v !== 'string') return { error: `${what} must be a short name (text), e.g. "Codex"` };
  if (CONTROL.test(v.replace(/[\t\n\r]/g, ' '))) return { error: `${what} must not hold control characters` };
  const s = v.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!s) return { error: `${what} must be a short name, e.g. "Codex" (leave it out when you do not say)` };
  if (s.length > NAME_MAX) return { error: `${what} must be at most ${NAME_MAX} characters` };
  return { name: s };
}
// How two declared names are compared (and an agent's answers are kept apart): case and width do not matter. '' for none.
export const nameKey = n => (typeof n === 'string' && n ? n.normalize('NFKC').toLowerCase() : '');
export const sameName = (a, b) => !!nameKey(a) && nameKey(a) === nameKey(b);

// A list of declared { agent, vendor } pairs, each once (by name, case aside), in one order; pairs with neither are
// left out. Anything that is not a valid declared name is dropped (the list may come from a file anything can write).
export function agentList(list) {
  const out = new Map();
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x !== 'object') continue;
    const a = declaredName(x.agent, 'agent'), v = declaredName(x.vendor, 'vendor');
    if (a.error || v.error || (!a.name && !v.name)) continue;
    const k = `${nameKey(a.name)}\0${nameKey(v.name)}`;
    if (!out.has(k)) out.set(k, { agent: a.name, vendor: v.name });
  }
  return [...out.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, v]) => v);
}

// "Claude Code and Codex (declared)", for a line of text.
export function agentsText(list, { empty = 'an agent that did not say who it is' } = {}) {
  const names = agentList(list).map(x => (x.agent ? `${x.agent}${x.vendor ? ` (${x.vendor})` : ''}` : `an agent of ${x.vendor}`));
  if (!names.length) return empty;
  const joined = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${joined}, as declared`;
}
