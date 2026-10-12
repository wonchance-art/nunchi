// Stable serialization: sorted keys, fixed indentation, trailing newline.
// Every file the engine writes goes through here so equal data gives equal bytes.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) if (value[k] !== undefined) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

export const stableJson = value => JSON.stringify(sortKeys(value), null, 2) + '\n';

export function writeStable(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' || value instanceof Uint8Array ? value : stableJson(value));
}

export const sha = (data, n = 16) => createHash('sha256').update(data).digest('hex').slice(0, n);
