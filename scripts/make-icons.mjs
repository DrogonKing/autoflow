#!/usr/bin/env node
/**
 * Generate the extension icons.
 *
 * A browser extension without icons is rejected by the store and looks broken in the toolbar, so the
 * build must never depend on artwork being committed. These are drawn as raw PNG bytes rather than
 * pulled from an image library: a 4-file dependency to draw a rounded square with a play triangle is not
 * worth the install, and hand-writing the PNG encoder keeps the build reproducible offline.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

/** CRC32, needed by the PNG container. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Encode RGBA pixel rows as a PNG. */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // each scanline needs a leading filter byte
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** Draw the icon: a rounded square in the app's blue with a white play triangle. */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const r = size * 0.22;            // corner radius
  const blue = [41, 98, 255];       // #2962ff
  const white = [255, 255, 255];

  const inRounded = (x, y) => {
    const pad = size * 0.02;
    const lo = pad;
    const hi = size - pad;
    if (x < lo || y < lo || x > hi || y > hi) return false;
    const cx = Math.min(Math.max(x, lo + r), hi - r);
    const cy = Math.min(Math.max(y, lo + r), hi - r);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r || (x >= lo + r && x <= hi - r) || (y >= lo + r && y <= hi - r);
  };

  // an equilateral-ish play triangle, centred and slightly right of centre (optical centring)
  const tx = size * 0.40;
  const ty = size * 0.30;
  const th = size * 0.40;
  const tw = size * 0.30;
  const inTriangle = (x, y) => {
    if (y < ty || y > ty + th) return false;
    const progress = (y - ty) / th;
    const halfAt = (tw / 2) * (1 - Math.abs(progress - 0.5) * 2);
    return x >= tx && x <= tx + halfAt + (tw / 2);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRounded(x, y)) {
        rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 0;
        continue;
      }
      const c = inTriangle(x, y) ? white : blue;
      rgba[i] = c[0];
      rgba[i + 1] = c[1];
      rgba[i + 2] = c[2];
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

export async function generateIcons(dir) {
  await mkdir(dir, { recursive: true });
  const sizes = [16, 32, 48, 128];
  for (const s of sizes) {
    await writeFile(path.join(dir, `${s}.png`), drawIcon(s));
  }
  // a toolbar-friendly alias some stores expect
  await writeFile(path.join(dir, 'icon.png'), drawIcon(128));
  return sizes;
}