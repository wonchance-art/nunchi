// PNG first views for the fix loop's visual-drift check (design 0.1-c §4.4, §4.5): a small decoder for the PNGs
// Chromium writes (8-bit greyscale, RGB or RGBA, with or without alpha, not interlaced) and a pixel comparison.
// The per-pixel colour distance is pixelmatch's (ISC licence, Mapbox): YIQ, blended onto white, threshold 0.1
// (adopted as an algorithm in design §10; no dependency). JPEGs are never compared (their noise is not a change).
import { inflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

// → { width, height, data: RGBA bytes } or throws on a PNG this decoder does not read.
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let at = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at), kind = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    at += 12 + len;
  }
  if (depth !== 8 || !CHANNELS[type] || interlace !== 0 || !width || !height) throw new Error(`a PNG this decoder does not read (depth ${depth}, colour type ${type}, interlace ${interlace})`);
  if (width * height > 64e6) throw new Error('PNG too large');
  const ch = CHANNELS[type], stride = width * ch;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('PNG data is short');
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[x - ch] : 0, b = up ? up[x] : 0, c = up && x >= ch ? up[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[x] = v & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += ch) {
    if (ch === 4) { data[i * 4] = px[j]; data[i * 4 + 1] = px[j + 1]; data[i * 4 + 2] = px[j + 2]; data[i * 4 + 3] = px[j + 3]; }
    else if (ch === 3) { data[i * 4] = px[j]; data[i * 4 + 1] = px[j + 1]; data[i * 4 + 2] = px[j + 2]; data[i * 4 + 3] = 255; }
    else if (ch === 2) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = px[j]; data[i * 4 + 3] = px[j + 1]; }
    else { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = px[j]; data[i * 4 + 3] = 255; }
  }
  return { width, height, data };
}

// pixelmatch's colour distance (YIQ, each pixel blended onto white by its alpha).
const blend = (c, a) => 255 + (c - 255) * a;
function colorDelta(a, i, b, j) {
  const a1 = a[i + 3] / 255, a2 = b[j + 3] / 255;
  const r1 = blend(a[i], a1), g1 = blend(a[i + 1], a1), b1 = blend(a[i + 2], a1);
  const r2 = blend(b[j], a2), g2 = blend(b[j + 1], a2), b2 = blend(b[j + 2], a2);
  const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
  const iq = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
  const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
  return 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q;
}
export const PIXEL_THRESHOLD = 0.1;

// Pixels that differ between two decoded images, outside `masks` ([x, y, w, h] in image pixels). Images of different
// sizes differ everywhere. → { differ, compared, share }.
export function pixelDiff(a, b, { masks = [], threshold = PIXEL_THRESHOLD } = {}) {
  if (a.width !== b.width || a.height !== b.height) return { differ: Math.max(a.width * a.height, b.width * b.height), compared: Math.max(a.width * a.height, b.width * b.height), share: 1 };
  const masked = new Uint8Array(a.width * a.height);
  for (const [mx, my, mw, mh] of masks) {
    const x0 = Math.max(0, Math.floor(mx)), y0 = Math.max(0, Math.floor(my)), x1 = Math.min(a.width, Math.ceil(mx + mw)), y1 = Math.min(a.height, Math.ceil(my + mh));
    for (let y = y0; y < y1; y++) masked.fill(1, y * a.width + x0, y * a.width + Math.max(x0, x1));
  }
  const max = 35215 * threshold * threshold;
  let differ = 0, compared = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    if (masked[y * a.width + x]) continue;
    compared++;
    const k = (y * a.width + x) * 4;
    if (a.data[k] === b.data[k] && a.data[k + 1] === b.data[k + 1] && a.data[k + 2] === b.data[k + 2] && a.data[k + 3] === b.data[k + 3]) continue;
    if (colorDelta(a.data, k, b.data, k) > max) differ++;
  }
  return { differ, compared, share: compared ? differ / compared : 0 };
}
