import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = '/root/autoflow/dist';
const CHROME = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const ctx = await chromium.launchPersistentContext('', {
  headless: true, executablePath: CHROME,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-sandbox', '--disable-dev-shm-usage'],
});
let w = null;
{ const d = Date.now() + 12000;
  while (Date.now() < d && !w) {
    for (const x of ctx.serviceWorkers()) {
      try { if (/autoflow/i.test(await x.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { w = x; break; } } catch {}
    }
    if (!w) await new Promise(r => setTimeout(r, 300));
  } }
const facts = await w.evaluate(() => ({
  typeof_browser: typeof globalThis.browser,
  browser_has_runtime: typeof globalThis.browser?.runtime,
  browser_runtime_id: globalThis.browser?.runtime?.id ?? null,
  browser_equals_chrome: (() => { try { return globalThis.browser === globalThis.chrome; } catch { return 'n/a'; } })(),
  typeof_chrome_sidebarAction: typeof globalThis.chrome?.sidebarAction,
  typeof_browser_sidebarAction: typeof globalThis.browser?.sidebarAction,
  typeof_chrome_sidePanel: typeof globalThis.chrome?.sidePanel,
  ua_has_firefox: /firefox/i.test(globalThis.navigator?.userAgent ?? ''),
  ua: globalThis.navigator?.userAgent,
}));
console.log(JSON.stringify(facts, null, 2));
console.log('\nTHE OLD isFirefox() would return:', facts.typeof_browser !== 'undefined' && facts.browser_has_runtime ? 'TRUE  <-- WRONG, this is Chrome' : 'false');
await ctx.close();
