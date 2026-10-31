#!/usr/bin/env node
/**
 * Build the extension.
 *
 * TWO FLAGS, FOUR ARTEFACTS. `--firefox` picks the target manifest, `--lite` picks the variant:
 *
 *   (no flags)          dist/                 chromium, every tab
 *   --lite              dist-lite/            chromium, Basic only
 *   --firefox           dist-firefox/         firefox,  every tab
 *   --firefox --lite    dist-firefox-lite/    firefox,  Basic only
 *
 * WHY ONE SCRIPT AND NOT FOUR. A second copy of this file per variant is the thing that drifts: the next
 * fix lands in one copy and not the other, and the variant quietly rots while every test still passes on
 * the one that was edited. So the target and the variant are OPTIONS here, and the two build scripts that
 * used to exist separately now both call `buildExtension`.
 *
 * WHY `__LITE__` IS A BUILD-TIME CONSTANT. esbuild substitutes it, folds the guard, and then drops the
 * functions nothing references any more - measured at 64.5 KB off panel.js. A runtime setting (a stored
 * preference, a query parameter) CANNOT do that: the code still ships, and the parser still has to walk it.
 * That is the entire difference between a lite BUILD and a lite SETTING.
 *
 * THE MANIFEST IS TRANSFORMED, NOT REBUILT. An earlier version of this file constructed the Firefox
 * manifest from scratch by listing the keys it wanted, and that silently dropped five of them -
 * `default_locale`, `commands`, `content_scripts`, `web_accessible_resources`, and `side_panel`. The
 * `default_locale` loss was caught by CI (the add-on linter: NO_DEFAULT_LOCALE, which is an ERROR when
 * `_locales` exists); the other four would have shipped as a Firefox build with no content script and no
 * keyboard commands, which is to say a build that does nothing. Copying the shared manifest and editing the
 * keys that genuinely differ is the version that cannot lose a key by omission.
 */
import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'src');

const LITE = process.argv.includes('--lite');
const FIREFOX = process.argv.includes('--firefox');
const VARIANT = LITE ? 'lite' : 'full';

/** The add-on id. A stable id is required for Firefox MV3, and it also makes an update land on the same install. */
const ADDON_ID = 'autoflow@drogon.site';

/**
 * The minimum Firefox version.
 *
 * 140, not 115, and the reason is concrete: `browser_specific_settings.gecko.data_collection_permissions`
 * is REQUIRED for a new add-on and was introduced in Firefox 140. Declaring 115 while that key is present
 * produces KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION, meaning the key would be ignored on 115-139 - so the
 * consent declaration a reviewer looks for would silently not exist. Stating 140 is the honest choice: it is
 * the oldest version on which this manifest means what it says.
 */
const MIN_FIREFOX = '140.0';

/**
 * A SEPARATE OUTPUT DIRECTORY PER COMBINATION.
 *
 * Not tidiness: with one directory the second build silently replaces the first, packaging then writes both
 * zips from whichever ran last, and the result looks like a success while shipping the same artifact twice.
 */
function outputDir() {
  if (FIREFOX) return path.join(root, LITE ? 'dist-firefox-lite' : 'dist-firefox');
  return path.join(root, LITE ? 'dist-lite' : 'dist');
}

async function iconExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Firefox from the shared manifest, by SUBTRACTION AND SUBSTITUTION rather than by listing keys.
 *
 * Everything the two browsers agree on stays as-is, and only what actually differs is touched:
 *
 *   sidePanel permission    Firefox has no such permission; the sidebar is declared as `sidebar_action`
 *   side_panel              the Chromium key; replaced by sidebar_action
 *   minimum_chrome_version  meaningless in Firefox
 *   background              Firefox ignores `service_worker` and runs `scripts` (type module)
 *   options_page            Firefox prefers `options_ui`
 *   action.default_popup    must NOT be set, or the toolbar button opens a popup instead of the sidebar
 */
function firefoxManifest(base) {
  const manifest = structuredClone(base);

  // a permission Firefox does not have
  manifest.permissions = (manifest.permissions ?? []).filter((p) => p !== 'sidePanel');

  // the sidebar: Chromium's side_panel becomes Firefox's sidebar_action
  const panelPath = manifest.side_panel?.default_path ?? 'panel.html';
  delete manifest.side_panel;
  manifest.sidebar_action = { default_panel: panelPath, default_title: manifest.action?.default_title ?? manifest.name };

  // meaningless outside Chromium
  delete manifest.minimum_chrome_version;

  // the toolbar button opens the sidebar, so it must not carry a popup
  if (manifest.action) delete manifest.action.default_popup;

  // Firefox runs background.scripts; it does not implement background.service_worker
  manifest.background = { scripts: ['background.js'], type: 'module' };

  // options_ui is the Firefox-preferred spelling of the same thing
  if (manifest.options_page) {
    manifest.options_ui = { page: manifest.options_page, open_in_tab: true };
    delete manifest.options_page;
  }

  manifest.browser_specific_settings = {
    gecko: {
      id: ADDON_ID,
      strict_min_version: MIN_FIREFOX,
      data_collection_permissions: { required: ['none'] },
    },
  };

  return manifest;
}

/**
 * The panel's tab list lives in the source as `__LITE__ ? [basic] : [all]`, and esbuild folds it. Nothing here
 * needs to filter it at runtime, and doing so would defeat the point.
 */
async function buildExtension() {
  const out = outputDir();
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const shared = {
    bundle: true,
    sourcemap: false,
    // Minified for lite only. That build's reason to exist is size; leaving names readable in the normal build
    // keeps its stack traces useful, which matters more there.
    minify: LITE,
    target: FIREFOX ? ['firefox140'] : ['chrome116'],
    legalComments: 'none',
    logLevel: 'warning',
    define: { __LITE__: String(LITE) },
  };

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
      // the content script has no module loader, so its bundle must not use top-level await
      supported: e.format === 'iife' ? { 'top-level-await': false } : {},
    });
    results.push({ entry: e.out, ok: true });
  }

  // ---------------------------------------------------------------------------------------------
  // the manifest, named for its variant
  // ---------------------------------------------------------------------------------------------
  const base = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'));
  const manifest = FIREFOX ? firefoxManifest(base) : base;

  if (LITE) {
    /**
     * THE NAME SAYS LITE, because the name is what a user sees in `chrome://extensions` and in the toolbar
     * tooltip. With both builds loaded and both called "AutoFlow", there is no way to tell which one is
     * running - which is exactly the confusion a second build is meant to avoid.
     *
     * The VERSION stays identical to the normal build on purpose: lite is the same release with fewer tabs,
     * not a separate product on its own release cadence, and both are cut from one commit.
     */
    manifest.name = `${base.name} Lite`;
    manifest.short_name = `${base.short_name || base.name} Lite`;
    manifest.description = `${base.description} (Lite: Basic tab only, no editors or logs.)`;
  }
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(
    path.join(out, 'build-variant.json'),
    JSON.stringify({ variant: VARIANT, target: FIREFOX ? 'firefox' : 'chrome', lite: LITE }, null, 2),
  );

  // static files
  // build-banner.js is a plain classic script, not an esbuild entry: MV3's `script-src 'self'` blocks inline
  // script, so the mismatch warning has to be its own file. Copied verbatim.
  for (const f of ['panel.html', 'options.html', 'picker.css', 'build-banner.js']) {
    const p = path.join(src, f);
    if (existsSync(p)) await cp(p, path.join(out, f));
  }
  const localesDir = path.join(src, '_locales');
  if (existsSync(localesDir)) await cp(localesDir, path.join(out, '_locales'), { recursive: true });

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
  const referenced = new Set([
    manifest.background?.service_worker,
    ...(manifest.background?.scripts ?? []),
    ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
    manifest.side_panel?.default_path,
    manifest.sidebar_action?.default_panel,
    manifest.options_page,
    manifest.options_ui?.page,
    ...Object.values(manifest.icons ?? {}),
  ].filter(Boolean));
  const missing = [...referenced].filter((f) => !existsSync(path.join(out, f)));

  /**
   * A GUARD FOR THE CLASS OF MISTAKE THAT GOT HERE. The from-scratch manifest dropped five keys and only one
   * was caught by the add-on linter. Comparing against the shared manifest after the transform catches the rest
   * at build time, where it costs a rebuild rather than a release.
   */
  if (FIREFOX) {
    const expectedAbsent = new Set(['side_panel', 'minimum_chrome_version', 'options_page']);
    const lost = Object.keys(base).filter((k) => !(k in manifest) && !expectedAbsent.has(k));
    if (lost.length) {
      console.error(`the Firefox manifest dropped keys the shared one declares: ${lost.join(', ')}`);
      process.exit(1);
    }
    if (!manifest.default_locale) {
      console.error('the Firefox manifest has no default_locale, but _locales exists - the linter rejects that');
      process.exit(1);
    }
  }

  console.log(`build results (${VARIANT}${FIREFOX ? ', firefox' : ''} -> ${path.relative(root, out)}/):`);
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.entry}${r.reason ? ` (${r.reason})` : ''}${r.note ? ` (${r.note})` : ''}`);
  }
  if (missing.length) {
    console.error(`\nmanifest references missing files: ${missing.join(', ')}`);
    process.exit(1);
  }

  // report the panel size, because it is the number this variant exists to move
  const panelBytes = (await readFile(path.join(out, 'panel.js'))).length;
  console.log(`  panel.js  ${(panelBytes / 1024).toFixed(1)} KB${LITE ? '  (lite)' : ''}`);

  return out;
}

export { buildExtension, outputDir, LITE, FIREFOX };

// only run when invoked directly, so build-firefox.mjs can import it without building twice
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await buildExtension();
}
