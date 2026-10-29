#!/usr/bin/env node
/**
 * Build the extension into `dist/`.
 *
 * Four separate bundles, because each entry point runs in a different world and MV3 is strict about it:
 *
 *   background.js  an ES module service worker (the manifest declares type: module)
 *   content.js     a CLASSIC script - a content script cannot be a module, so everything it imports must
 *                  be bundled into one file
 *   panel.js       a module, loaded by panel.html
 *   options.js     a module, loaded by options.html
 *
 * The content script is the one that would break silently: an `import` statement in a classic script is
 * a syntax error, and the extension would simply never inject.
 */
import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'src');
const out = path.join(root, 'dist');

const shared = {
  bundle: true,
  sourcemap: false,
  minify: false,
  target: ['chrome116'],
  legalComments: 'none',
  logLevel: 'warning',
};

async function iconExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const entries = [
    { in: 'background/service-worker.js', out: 'background.js', format: 'esm' },
    { in: 'content/content.js', out: 'content.js', format: 'iife' },
    { in: 'ui/panel/panel.js', out: 'panel.js', format: 'esm' },
    { in: 'ui/options/options.js', out: 'options.js', format: 'esm' },
  ];

  const results = [];
  for (const e of entries) {
    const inPath = path.join(src, e.in);
    if (!existsSync(inPath)) {
      results.push({ entry: e.out, ok: false, reason: 'entry file missing' });
      continue;
    }
    await build({
      ...shared,
      entryPoints: [inPath],
      outfile: path.join(out, e.out),
      format: e.format,
      // a content script has no module loader, so its bundle must not use top-level await
      supported: e.format === 'iife' ? { 'top-level-await': false } : {},
    });
    results.push({ entry: e.out, ok: true });
  }

  // static files
  await cp(path.join(src, 'manifest.json'), path.join(out, 'manifest.json'));
  // build-banner.js is a plain classic script, not an esbuild entry: MV3's `script-src 'self'` blocks inline
  // script, so the mismatch warning has to be its own file. Copied verbatim.
  for (const f of ['panel.html', 'options.html', 'picker.css', 'build-banner.js']) {
    const p = path.join(src, f);
    if (existsSync(p)) await cp(p, path.join(out, f));
  }
  const localesDir = path.join(src, '_locales');
  if (existsSync(localesDir)) {
    await cp(localesDir, path.join(out, '_locales'), { recursive: true });
  }

  // icons: generated if missing, so a build never fails over artwork
  const iconDir = path.join(src, 'icons');
  const hasIcons = existsSync(iconDir) && (await iconExists(path.join(iconDir, '128.png')));
  if (hasIcons) {
    await cp(iconDir, path.join(out, 'icons'), { recursive: true });
  } else {
    const { generateIcons } = await import('./make-icons.mjs');
    await generateIcons(path.join(out, 'icons'));
    results.push({ entry: 'icons/', ok: true, note: 'generated' });
  }

  // verify the built manifest references files that exist
  const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
  const referenced = new Set([
    manifest.background?.service_worker,
    ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
    manifest.side_panel?.default_path,
    manifest.options_page,
    ...Object.values(manifest.icons ?? {}),
  ].filter(Boolean));
  const missing = [...referenced].filter((f) => !existsSync(path.join(out, f)));

  console.log('build results:');
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.entry}${r.reason ? ` (${r.reason})` : ''}${r.note ? ` (${r.note})` : ''}`);
  }
  if (missing.length) {
    console.error(`\nmanifest references missing files: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('\nmanifest references verified');
}

main().catch((e) => {
  console.error('build failed:', e.message);
  process.exit(1);
});
