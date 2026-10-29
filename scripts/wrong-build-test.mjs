#!/usr/bin/env node
/**
 * Does Chrome accept the FIREFOX build? If it does, does its toolbar button do anything?
 *
 * This is a hypothesis being measured, not an assumption. The evidence that suggested it:
 *
 *   - the user's screenshot shows the extension icon WITH an orange `!` badge and no side panel open
 *   - they reported only ever seeing `autoflow-firefox.zip` in their downloads folder
 *   - the Firefox manifest has no `side_panel` key, so `chrome.sidePanel` would have no default path
 *   - the Firefox manifest uses `background.scripts`, which Manifest V3 Chrome does not run
 *
 * If Chrome loads the Firefox build "successfully" with an error badge and a dead toolbar button, then
 * loading the wrong archive is a sufficient explanation for "clicking does nothing".
 *
 * Both builds are loaded in turn and asked the same questions, so the two are compared rather than guessed at.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM ||
  '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

async function probe(label, dir) {
  console.log(`\n${'='.repeat(72)}\n${label}\n  dir: ${dir}\n${'='.repeat(72)}`);

  if (!existsSync(path.join(dir, 'manifest.json'))) {
    console.log('  MISSING manifest.json - skipping');
    return null;
  }

  const ctx = await chromium.launchPersistentContext('', {
    headless: true,
    executablePath: existsSync(CHROME) ? CHROME : undefined,
    args: [
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const out = { label, dir };

  // find OUR worker, not a Chrome component extension's worker
  let worker = null;
  {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !worker) {
      for (const w of ctx.serviceWorkers()) {
        const id = new URL(w.url()).host;
        // component extensions have well-known ids; check the runtime name instead of guessing
        try {
          const name = await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? '');
          if (/autoflow/i.test(name)) { worker = w; break; }
        } catch { /* not ours */ }
      }
      if (!worker) await new Promise((r) => setTimeout(r, 300));
    }
  }

  out.serviceWorker = worker ? worker.url() : null;
  console.log(`  service worker : ${out.serviceWorker ?? 'NONE (MV3 Chrome did not run one)'}`);

  if (!worker) {
    // see what the extension actually declared
    const m = JSON.parse(
      (await import('node:fs')).readFileSync(path.join(dir, 'manifest.json'), 'utf8'),
    );
    console.log(`  declared background : ${JSON.stringify(m.background)}`);
    console.log(`  declared side_panel : ${m.side_panel ? JSON.stringify(m.side_panel) : 'ABSENT'}`);
    console.log(`  declared sidebar_action : ${m.sidebar_action ? 'present' : 'absent'}`);
    out.sidePanelApi = 'no worker to ask';
    out.hasDefaultPath = false;
  } else {
    const api = await worker.evaluate(async () => {
      const m = chrome.runtime.getManifest();
      const res = {
        background: JSON.stringify(m.background),
        sidePanelKey: m.side_panel ? JSON.stringify(m.side_panel) : 'ABSENT',
        hasSidePanelApi: typeof chrome.sidePanel !== 'undefined',
        hasDefaultPath: !!m.side_panel?.default_path,
        options: null,
      };
      try {
        res.options = JSON.stringify(await chrome.sidePanel.getOptions({}));
      } catch (e) {
        res.options = `error: ${e?.message || e}`;
      }
      return res;
    });
    Object.assign(out, api);
    console.log(`  declared background : ${api.background}`);
    console.log(`  declared side_panel : ${api.sidePanelKey}`);
    console.log(`  chrome.sidePanel    : ${api.hasSidePanelApi ? 'present' : 'UNDEFINED'}`);
    console.log(`  sidePanel options   : ${api.options}`);
  }

  // what does chrome://extensions report? the error badge comes from here.
  const page = await ctx.newPage();
  await page.goto('chrome://extensions');
  await page.waitForTimeout(2000);
  const extErrors = await page.evaluate(() => {
    const mgr = document.querySelector('extensions-manager');
    const list = mgr?.shadowRoot?.querySelector('extensions-item-list');
    const items = list?.shadowRoot?.querySelectorAll('extensions-item') ?? [];
    const found = [];
    for (const it of items) {
      const name = it.shadowRoot?.querySelector('#name')?.textContent?.trim() ?? '?';
      // the error indicator is exposed as an id or an aria-label on the card
      const errBtn = it.shadowRoot?.querySelector('#errors-button, .error-button, [id*=error]');
      const errText = it.shadowRoot?.textContent?.includes('error') ? 'mentions "error"' : '';
      found.push({ name, hasErrorIndicator: !!errBtn, note: errText });
    }
    return found;
  });
  out.extensionsPage = extErrors;
  console.log('  chrome://extensions reports:');
  for (const e of extErrors) {
    console.log(`    ${e.hasErrorIndicator ? 'ERROR BADGE' : 'no badge  '}  ${e.name}  ${e.note}`);
  }

  // can the panel even be opened, given how the click handler opens it?
  if (worker) {
    const openAttempt = await worker.evaluate(async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const windowId = tabs[0]?.windowId ?? 1;
        await chrome.sidePanel.open({ windowId });
        return 'open() resolved';
      } catch (e) {
        return `open() REJECTED: ${e?.message || e}`;
      }
    });
    out.openAttempt = openAttempt;
    console.log(`  sidePanel.open()    : ${openAttempt}`);
  }

  await ctx.close();
  return out;
}

const chromeBuild = await probe('the CHROMIUM build (dist/)', path.join(ROOT, 'dist'));
const firefoxBuild = await probe('the FIREFOX build loaded into CHROME (dist-firefox/)', path.join(ROOT, 'dist-firefox'));

console.log(`\n${'='.repeat(72)}\nVERDICT\n${'='.repeat(72)}`);
if (chromeBuild) {
  console.log(`  dist/          service worker: ${chromeBuild.serviceWorker ? 'yes' : 'NO'}`);
  console.log(`                 sidePanel opts: ${chromeBuild.options}`);
}
if (firefoxBuild) {
  console.log(`  dist-firefox/  service worker: ${firefoxBuild.serviceWorker ? 'yes' : 'NO'}`);
  console.log(`                 sidePanel opts: ${firefoxBuild.options}`);
  const dead = !firefoxBuild.serviceWorker || String(firefoxBuild.options).includes('error')
    || !/default_path/.test(String(firefoxBuild.options));
  console.log(`\n  Loading the Firefox build in Chrome leaves the toolbar button dead: ${dead ? 'CONFIRMED' : 'not confirmed'}`);
}
