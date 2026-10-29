#!/usr/bin/env node
/**
 * Package the built extension as a loadable zip.
 *
 * Two artefacts, and the difference matters:
 *
 *   autoflow.zip             the extension itself, with manifest.json at the ROOT of the archive. This is
 *                            what "Load unpacked" and the Web Store both expect.
 *   autoflow-source.zip      the repository, excluding node_modules and dist.
 *
 * A common mistake is zipping the project folder, so the archive contains `dist/manifest.json` instead of
 * `manifest.json`. Chrome then reports "Manifest file is missing or unreadable" with no further
 * explanation. This script asserts the layout before writing the file.
 */
import { createWriteStream } from 'node:fs';
import { readdir, readFile, stat, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const releaseDir = path.join(root, 'release');

// ---------------------------------------------------------------------------------------------
// a minimal zip writer (stored + deflate), so packaging needs no dependency
// ---------------------------------------------------------------------------------------------

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

async function walk(dir, base = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(full, rel)));
    else out.push({ full, rel, size: (await stat(full)).size });
  }
  return out;
}

/** Write a zip. `prefix` is stripped from each stored path. */
async function writeZip(files, outPath) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const data = await readFile(f.full);
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const stored = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(f.rel, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);               // version
    local.writeUInt16LE(0x0800, 6);           // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);               // time
    local.writeUInt16LE(0x21, 12);            // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, stored);

    central.push({ nameBuf, crc, compressed: stored.length, uncompressed: data.length, method, offset });
    offset += local.length + nameBuf.length + stored.length;
  }

  const centralStart = offset;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0x0800, 8);
    h.writeUInt16LE(c.method, 10);
    h.writeUInt16LE(0, 12);
    h.writeUInt16LE(0x21, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.compressed, 20);
    h.writeUInt32LE(c.uncompressed, 24);
    h.writeUInt16LE(c.nameBuf.length, 28);
    h.writeUInt16LE(0, 30);
    h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34);
    h.writeUInt16LE(0, 36);
    h.writeUInt32LE(0, 38);
    h.writeUInt32LE(c.offset, 42);
    chunks.push(h, c.nameBuf);
    offset += h.length + c.nameBuf.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);

  await new Promise((resolve, reject) => {
    const ws = createWriteStream(outPath);
    ws.on('error', reject);
    ws.on('finish', resolve);
    for (const c of chunks) ws.write(c);
    ws.end();
  });
  return { files: central.length, bytes: offset + 22 };
}

// ---------------------------------------------------------------------------------------------

async function main() {
  if (!existsSync(path.join(dist, 'manifest.json'))) {
    console.error('dist/manifest.json is missing - run npm run build first');
    process.exit(1);
  }
  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });

  // ---- the extension
  const files = await walk(dist);
  const rels = files.map((f) => f.rel);
  // the assertion that stops a confusing store rejection
  if (!rels.includes('manifest.json')) {
    console.error('the extension zip would not have manifest.json at its root');
    process.exit(1);
  }

  const extPath = path.join(releaseDir, 'autoflow.zip');
  const extInfo = await writeZip(files, extPath);

  // ---- the source
  const srcFiles = [];
  const SKIP = new Set(['node_modules', '.git', 'dist', 'release', '.pytest_cache']);
  async function collect(dir, base = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await collect(full, rel);
      else srcFiles.push({ full, rel });
    }
  }
  await collect(root);
  const srcPath = path.join(releaseDir, 'autoflow-source.zip');
  const srcInfo = await writeZip(srcFiles, srcPath);

  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));

  // ---- the Firefox build, when it has been built
  const ffDir = path.join(root, 'dist-firefox');
  let ffInfo = null;
  let ffManifest = null;
  if (existsSync(path.join(ffDir, 'manifest.json'))) {
    const ffFiles = await walk(ffDir);
    const ffRels = ffFiles.map((f) => f.rel);
    if (!ffRels.includes('manifest.json')) {
      console.error('the Firefox zip would not have manifest.json at its root');
      process.exit(1);
    }
    const ffPath = path.join(releaseDir, 'autoflow-firefox.zip');
    ffInfo = await writeZip(ffFiles, ffPath);
    ffManifest = JSON.parse(await readFile(path.join(ffDir, 'manifest.json'), 'utf8'));
  }

  console.log('packaged:');
  console.log(`  release/autoflow.zip           ${(extInfo.bytes / 1024).toFixed(0)} KB, ${extInfo.files} files  (Chrome/Edge)`);
  if (ffInfo) {
    console.log(`  release/autoflow-firefox.zip   ${(ffInfo.bytes / 1024).toFixed(0)} KB, ${ffInfo.files} files  (Firefox)`);
  }
  console.log(`  release/autoflow-source.zip    ${(srcInfo.bytes / 1024).toFixed(0)} KB, ${srcInfo.files} files  (source)`);
  console.log(`\n  extension : ${manifest.name} v${manifest.version}`);
  console.log(`  manifest at the root of every zip: yes`);
  if (ffManifest) {
    console.log(`  firefox add-on id : ${ffManifest.browser_specific_settings?.gecko?.id}`);
    console.log(`  firefox min version: ${ffManifest.browser_specific_settings?.gecko?.strict_min_version}`);
    console.log(`  firefox background : ${Object.keys(ffManifest.background ?? {}).join(', ')}`);
  }
  console.log(`\nChromium: chrome://extensions > Developer mode > Load unpacked > dist/`);
  console.log(`Firefox : about:debugging#/runtime/this-firefox > Load Temporary Add-on > dist-firefox/manifest.json`);
  console.log(`\nFor a permanent Firefox install the zip must be signed by Mozilla (addons.mozilla.org), or use the`);
  console.log(`unpacked build with developer mode. Chrome accepts an unpacked folder the same way.`);
}

main().catch((e) => {
  console.error('packaging failed:', e.message);
  process.exit(1);
});
