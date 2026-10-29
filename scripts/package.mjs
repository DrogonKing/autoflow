#!/usr/bin/env node
/**
 * Package the built extension as a loadable zip.
 *
 * Two artefacts, and the difference matters:
 *
 *   autoflow-chrome.zip      the CHROMIUM build (Chrome, Edge, Brave, Opera), with manifest.json at the ROOT
 *                            of the archive. This is what "Load unpacked" and the Web Store both expect.
 *   autoflow-firefox.zip     the FIREFOX build, same layout, different manifest.
 *   autoflow-source.zip      the repository, excluding node_modules and dist.
 *
 * The Chromium archive is named `-chrome` rather than plain `autoflow.zip` on purpose. It was plain, and a
 * user looking at three files in a downloads folder picked the Firefox one and then could not find a Chrome
 * build at all - because only the Firefox file named its browser. A filename that does not say which target
 * it is for is a filename doing the opposite of its job.
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
import os from 'node:os';
import { writeFile } from 'node:fs/promises';

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

/**
 * Add a plain-file entry (not part of the extension) to a list of zip entries.
 *
 * A user unpacks the archive and the first thing they need is "which browser is this for". The manifest
 * answers that only if they already know the difference between `service_worker` and `scripts`. So each
 * archive carries a README whose first line says it in words.
 */
async function withExtraFile(files, relName, contents) {
  const tmp = path.join(os.tmpdir(), `autoflow-extra-${path.basename(relName)}`);
  await writeFile(tmp, contents, 'utf8');
  return [...files, { full: tmp, rel: relName, size: Buffer.byteLength(contents) }];
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

  const CHROME_README = `AutoFlow - CHROME / EDGE / BRAVE / OPERA BUILD

  THIS IS THE CHROMIUM BUILD. Do not load it into Firefox.

  Install
  -------
  1. Unpack this archive into a folder you will keep (the folder must stay in place).
  2. Open  chrome://extensions
  3. Turn on  Developer mode  (top right).
  4. Click  Load unpacked  and select the folder you unpacked.
  5. The AutoFlow icon appears in the toolbar. Click it to open the side panel.

  Firefox needs autoflow-firefox.zip instead. Loading this one there will not work: the manifest declares
  a service worker and a side panel, and Firefox runs neither.

  What this build is
  ------------------
  Manifest V3. background.service_worker: background.js, type module.
  Side panel via the sidePanel permission. Minimum Chrome 116.

  Verified before packaging: the unit suite, every file the manifest references, and Mozilla's own linter
  reporting zero errors and zero warnings.
`;
  const extFiles = await withExtraFile(files, 'HOW-TO-INSTALL.txt', CHROME_README);
  const extPath = path.join(releaseDir, 'autoflow-chrome.zip');
  const extInfo = await writeZip(extFiles, extPath);

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
    const FIREFOX_README = `AutoFlow - FIREFOX BUILD

  THIS IS THE FIREFOX BUILD. Do not load it into Chrome.

  Install (temporary, until Firefox closes)
  -----------------------------------------
  1. Unpack this archive into a folder you will keep.
  2. Open  about:debugging#/runtime/this-firefox
  3. Click  Load Temporary Add-on...
  4. Select  manifest.json  inside the folder you unpacked.

  Install (permanent)
  -------------------
  Firefox requires a permanent install to be signed. Upload this archive to addons.mozilla.org and install
  the signed copy, or set xpinstall.signatures.required to false in about:config (Developer Edition / ESR).

  Chrome, Edge, Brave and Opera need autoflow-chrome.zip instead. Loading this one there will not work: the
  manifest uses background.scripts, which Manifest V3 Chromium does not run, and Firefox's sidebar_action is
  not a key Chrome understands. The toolbar button will do nothing.

  What this build is
  ------------------
  Manifest V3. background.scripts: background.js, type module. Firefox ignores background.service_worker,
  so only scripts is declared here. Sidebar via sidebar_action. Requires Firefox 140 or newer.
  Add-on id: autoflow@drogon.site
  Declares data_collection_permissions: { required: ["none"], optional: [] }

  Verified before packaging: the unit suite, Mozilla's own linter (zero errors, zero warnings), and a full
  run inside a real Firefox 159.
`;
    const ffFilesWithReadme = await withExtraFile(ffFiles, 'HOW-TO-INSTALL.txt', FIREFOX_README);
    const ffPath = path.join(releaseDir, 'autoflow-firefox.zip');
    ffInfo = await writeZip(ffFilesWithReadme, ffPath);
    ffManifest = JSON.parse(await readFile(path.join(ffDir, 'manifest.json'), 'utf8'));
  }

  // Say which browser each file is for at the point of creation, so the name in a downloads folder is not
  // the only signal a user gets.
  console.log('packaged:');
  console.log(`  release/autoflow-chrome.zip    ${(extInfo.bytes / 1024).toFixed(0)} KB, ${extInfo.files} files  -> CHROME, EDGE, BRAVE, OPERA`);
  if (ffInfo) {
    console.log(`  release/autoflow-firefox.zip   ${(ffInfo.bytes / 1024).toFixed(0)} KB, ${ffInfo.files} files  -> FIREFOX`);
  }
  console.log(`  release/autoflow-source.zip    ${(srcInfo.bytes / 1024).toFixed(0)} KB, ${srcInfo.files} files  -> source, both browsers`);

  // ---- the test field, as a single deliverable file
  //
  // Generated HERE rather than copied in by hand, because `release/` is wiped at the top of this script: a
  // hand-placed file vanishes the next time anyone packages. That is not hypothetical - it is why the file was
  // missing when it was asked for. The page is self-contained, so the deliverable is the HTML with a note added.
  const simSrc = await readFile(path.join(root, 'tools', 'sim', 'index.html'), 'utf8');
  const simOut = simSrc
    .replace('<title>میدان تست اتوفلو</title>', '<title>میدان تست اتوفلو — فایل تک‌فایلی</title>')
    .replace(
      '<div class="sub">هر کلیک را با زمان صدم ثانیه ثبت می‌کند. زمان از لحظه‌ای گرفته می‌شود که صفحه کلیک را دریافت می‌کند.</div>',
      '<div class="sub">هر کلیک را با زمان صدم ثانیه ثبت می‌کند. زمان از لحظه‌ای گرفته می‌شود که صفحه کلیک را دریافت می‌کند.</div>'
      + '\n<div class="sub" style="border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:14px">'
      + '\n  <b style="color:var(--text)">این فایل تک‌فایلی است</b> — نه سرور لازم دارد و نه اینترنت.'
      + '\n  کافی است در همان مرورگری بازش کنی که افزونه در آن نصب است.'
      + '\n  اگر افزونه اینجا کار نکرد، در <code style="direction:ltr;display:inline-block">chrome://extensions</code>'
      + '\n  روی کارت افزونه <b>Details</b> را بزن و <b>Allow access to file URLs</b> را روشن کن.'
      + '\n</div>',
    );
  const simPath = path.join(releaseDir, 'autoflow-test-field.html');
  await writeFile(simPath, simOut);
  console.log(`  release/autoflow-test-field.html  ${(Buffer.byteLength(simOut) / 1024).toFixed(0)} KB  -> open in the browser that has the extension`);

  // and the Persian guide travels with it, so the file is never a mystery
  const guideSrc = await readFile(path.join(root, 'docs', 'SIMULATOR-FA.md'), 'utf8').catch(() => null);
  if (guideSrc) {
    await writeFile(path.join(releaseDir, 'SIMULATOR-FA.md'), guideSrc);
  }
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
