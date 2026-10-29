#!/usr/bin/env node
/**
 * Build the Firefox version.
 *
 * Firefox and Chromium want different manifests for the same source. Four differences are real, and each
 * one is a hard failure if ignored:
 *
 *  1. background. A Firefox MV3 background service worker MUST be paired with `background.scripts`, which
 *     web-ext reports as the error BACKGROUND_SERVICE_WORKER_NOFALLBACK. Firefox runs the `scripts` array
 *     as an ES module event page, which is what our code is written for.
 *  2. An explicit add-on id is REQUIRED in MV3 (web-ext error ADDON_ID_REQUIRED).
 *  3. `sidePanel` is not a Firefox permission, and sidePanel is not a Firefox API: the sidebar is
 *     `sidebar_action`. Permission in, permission out, key in.
 *  4. `browser_specific_settings.gecko.data_collection_permissions` is required for new Firefox add-ons,
 *     and the value is not "none" - it is a list, and `none` is the one our data policy actually matches.
 *
 * The content script is built as a CLASSIC script for both, because `world: "MAIN"` is not something we
 * need and a module content script is not universally supported in the Firefox version range.
 */
import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'src');
const out = path.join(root, 'dist-firefox');

/** The add-on id. A stable id is required in MV3, and it also makes an update land on the same install. */
const ADDON_ID = 'autoflow@drogon.site';

/**
 * The minimum Firefox version.
 *
 * 140, not 115, and the reason is concrete: `browser_specific_settings.gecko.data_collection_permissions`
 * is REQUIRED for a new add-on and was introduced in Firefox 140. Declaring 115 while that key is present
 * produces KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION, meaning the key would be ignored on 115-139 - so the
 * consent declaration a reviewer looks for would silently not exist. Stating 140 is the honest choice: it
 * is the oldest version on which this manifest means what it says.
 */
const MIN_FIREFOX = '140.0';

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
      ...{
        bundle: true,
        sourcemap: false,
        minify: false,
        target: ['firefox140'],
        legalComments: 'none',
        logLevel: 'warning',
      },
      entryPoints: [inPath],
      outfile: path.join(out, e.out),
      format: e.format,
      supported: e.format === 'iife' ? { 'top-level-await': false } : {},
    });
    results.push({ entry: e.out, ok: true });
  }

  // ---- the manifest, derived from the Chromium one so the two cannot drift
  const base = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'));
  const manifest = { ...base };

  manifest.background = {
    // Firefox runs this as an ES module event page. `service_worker` is deliberately NOT declared: web-ext
    // reports BACKGROUND_SERVICE_WORKER_IGNORED for it, because Firefox ignores that key entirely. The
    // Chromium build has its own manifest with `service_worker` and no `scripts`, which is the correct
    // shape on each side; declaring both here would be a manifest that contradicts itself.
    scripts: ['background.js'],
    type: 'module',
  };

  // sidePanel is a Chromium-only permission, and the sidebar is the Firefox equivalent
  manifest.permissions = (base.permissions ?? []).filter((p) => p !== 'sidePanel');

  manifest.sidebar_action = {
    default_title: 'AutoFlow',
    default_icon: base.action?.default_icon ?? base.icons,
    default_panel: 'panel.html',
    open_at_install: false,
  };
  // `side_panel` is not a Firefox manifest key and would be an unknown-property warning
  delete manifest.side_panel;

  // a stable id, required in MV3
  manifest.browser_specific_settings = {
    gecko: {
      id: ADDON_ID,
      strict_min_version: MIN_FIREFOX,
      /**
       * Required for new add-ons. `required: []` is rejected by web-ext ("must NOT have fewer than 1
       * items"), so the documented value for "this add-on collects nothing" is used instead.
       *
       * It is accurate rather than a formality: this extension has no server, makes no network request,
       * and a test asserts that `fetch`, XHR, WebSocket and sendBeacon appear nowhere in the shipped
       * source. See docs/SECURITY.md.
       */
      data_collection_permissions: {
        required: ['none'],
        optional: [],
      },
    },
    /**
     * Firefox for Android is explicitly not a target, and saying so is better than leaving the key out.
     *
     * The UI is a `sidebar_action`, and Firefox for Android has no sidebar, so the panel would be
     * unreachable there. 142 is where data_collection_permissions arrived on Android. Declaring it
     * silences KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION and states a real constraint instead of
     * leaving a warning that looks like an oversight.
     */
    gecko_android: {
      strict_min_version: '142.0',
    },
  };

  // Firefox's MV3 supports the same keys, but `minimum_chrome_version` is meaningless there
  delete manifest.minimum_chrome_version;

  await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // ---- static files
  // build-banner.js included for the same reason as in build.mjs: MV3 blocks inline script, so the mismatch
  // warning is a separate classic script that both pages load with <script src>.
  for (const f of ['panel.html', 'options.html', 'picker.css', 'build-banner.js']) {
    const p = path.join(src, f);
    if (existsSync(p)) await cp(p, path.join(out, f));
  }
  const locales = path.join(src, '_locales');
  if (existsSync(locales)) await cp(locales, path.join(out, '_locales'), { recursive: true });

  const iconDir = path.join(src, 'icons');
  const hasIcons = existsSync(iconDir) && (await access(path.join(iconDir, '128.png')).then(() => true).catch(() => false));
  if (hasIcons) {
    await cp(iconDir, path.join(out, 'icons'), { recursive: true });
  } else {
    // the Chromium build generates them; reuse that so the two builds cannot differ
    const chromiumIcons = path.join(root, 'dist', 'icons');
    if (existsSync(chromiumIcons)) await cp(chromiumIcons, path.join(out, 'icons'), { recursive: true });
    else {
      const { generateIcons } = await import('./make-icons.mjs');
      await generateIcons(path.join(out, 'icons'));
    }
    results.push({ entry: 'icons/', ok: true, note: 'reused or generated' });
  }

  // ---- verify every referenced file exists, because a missing one is a silent no-op at runtime
  const referenced = new Set([
    ...(manifest.background?.scripts ?? []),
    ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
    manifest.sidebar_action?.default_panel,
    manifest.options_page,
    ...Object.values(manifest.icons ?? {}),
  ].filter(Boolean));
  const missing = [...referenced].filter((f) => !existsSync(path.join(out, f)));

  console.log('firefox build results:');
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.entry}${r.reason ? ` (${r.reason})` : ''}${r.note ? ` (${r.note})` : ''}`);
  }
  if (missing.length) {
    console.error(`\nmanifest references missing files: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('\nmanifest references verified');
  console.log(`add-on id : ${ADDON_ID}`);
  console.log(`strict_min_version: ${manifest.browser_specific_settings.gecko.strict_min_version}`);
  console.log(`background          : ${Object.keys(manifest.background).join(', ')}`);
}

main().catch((e) => {
  console.error('firefox build failed:', e.message);
  process.exit(1);
});