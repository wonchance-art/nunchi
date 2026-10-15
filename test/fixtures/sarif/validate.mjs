// A minimal JSON Schema validator for the draft-04 keywords the vendored SARIF 2.1.0 schema uses ($ref to its own
// definitions, type, enum, anyOf, oneOf, properties, required, additionalProperties, items, minItems, uniqueItems,
// minimum, maximum, pattern, format uri / uri-reference / date-time). No dependency and no network: the schema is the
// file next to this one (sarif-schema-2.1.0.json, sha256 recorded in test/sarif.test.mjs). A keyword it does not know
// fails the run, so a schema update cannot be checked only in part.
import { readFileSync } from 'node:fs';

const KNOWN = new Set(['$schema', '$ref', 'id', 'title', 'description', 'default', 'definitions', 'type', 'enum', 'anyOf', 'oneOf', 'properties', 'required',
  'additionalProperties', 'items', 'minItems', 'uniqueItems', 'minimum', 'maximum', 'pattern', 'format']);
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));
const is = (t, v) => (t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'string' ? typeof v === 'string'
  : t === 'boolean' ? typeof v === 'boolean' : t === 'null' ? v === null : t === 'array' ? Array.isArray(v) : t === 'object' ? !!v && typeof v === 'object' && !Array.isArray(v) : false);
const FORMATS = {
  uri: s => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/.test(s),
  'uri-reference': s => !/[\s\u0000-\u001f]/.test(s),
  'date-time': s => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s),
};

export function validate(root, doc) {
  const errors = [];
  const resolveRef = ref => {
    const m = /^#\/definitions\/([^/]+)$/.exec(ref);
    if (!m || !root.definitions?.[m[1]]) throw new Error(`unsupported $ref ${ref}`);
    return root.definitions[m[1]];
  };
  const check = (s, v, at, out) => {
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`the validator does not know the keyword "${k}" (at ${at})`);
    if (s.$ref) return check(resolveRef(s.$ref), v, at, out);
    if (s.type && ![].concat(s.type).some(t => is(t, v))) { out.push(`${at}: expected ${[].concat(s.type).join(' or ')}`); return; }
    if (s.enum && !s.enum.some(e => canon(e) === canon(v))) out.push(`${at}: not one of ${s.enum.join(', ')}`);
    if (s.anyOf && !s.anyOf.some(x => { const o = []; check(x, v, at, o); return !o.length; })) out.push(`${at}: matches none of anyOf`);
    if (s.oneOf && s.oneOf.filter(x => { const o = []; check(x, v, at, o); return !o.length; }).length !== 1) out.push(`${at}: does not match exactly one of oneOf`);
    if (typeof v === 'string') {
      if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) out.push(`${at}: does not match ${s.pattern}`);
      if (s.format && FORMATS[s.format] && !FORMATS[s.format](v)) out.push(`${at}: not a ${s.format}`);
      if (s.format && !FORMATS[s.format]) throw new Error(`unknown format ${s.format}`);
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) out.push(`${at}: below ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) out.push(`${at}: above ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) out.push(`${at}: fewer than ${s.minItems} items`);
      if (s.uniqueItems && new Set(v.map(canon)).size !== v.length) out.push(`${at}: items are not unique`);
      if (s.items) v.forEach((x, i) => check(s.items, x, `${at}[${i}]`, out));
    }
    if (is('object', v)) {
      for (const r of s.required || []) if (!Object.hasOwn(v, r)) out.push(`${at}: missing ${r}`);
      for (const [k, x] of Object.entries(v)) {
        if (s.properties && Object.hasOwn(s.properties, k)) check(s.properties[k], x, `${at}.${k}`, out);
        else if (s.additionalProperties === false) out.push(`${at}: unexpected property ${k}`);
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, x, `${at}.${k}`, out);
      }
    }
  };
  check(root, doc, '$', errors);
  return errors;
}

// The vendored schema, read once (no network), and a shortcut for the tests.
export const SCHEMA = JSON.parse(readFileSync(new URL('./sarif-schema-2.1.0.json', import.meta.url), 'utf8'));
export const sarifProblems = doc => validate(SCHEMA, doc);
