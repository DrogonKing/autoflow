#!/usr/bin/env node
/**
 * MANY points, MANY picks, and exactly ONE message each.
 *
 * The report, 1.23.0: "the error is gone only for the first pick; for the rest it still comes, but it still works and does
 * not affect the function." That shape - selector lands AND complaint appears - is a DUPLICATE message: the first copy
 * takes the step and consumes the target, so every later copy finds nothing and prints the sentence.
 *
 * MEASURED before the fix, driving the editor: 2 messages per click, one `from=content-script` and one from the worker's
 * forward. This asserts one, with ENOUGH points that the "only one point, so take it" rule cannot hide a duplicate.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SIM = path.join(ROOT, 'tools', 'sim', 'index.html');
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const profile = mkdtempSync(path.join(tmpdir(), 'af-once-'));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${detail}` : ''}`);
};

const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [
    `--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`,
    '--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
  ],
});

let worker = null;
for (let i = 0; i < 80 && !worker; i++) {
  for (const w of ctx.serviceWorkers()) {
    try { if (/autoflow/i.test(await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { worker = w; break; } } catch {}
  }
  if (!worker) await new Promise((r) => setTimeout(r, 250));
}
if (!worker) { console.log('no worker'); process.exit(1); }
const extId = new URL(worker.url()).host;

const page = await ctx.newPage();
await page.goto(`file://${SIM}`);
await page.waitForFunction(() => document.documentElement.getAttribute('data-autoflow-content') !== null, null, { timeout: 15000 });

const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`);
await panel.waitForTimeout(1200);

await panel.evaluate(async () => {
  await chrome.runtime.sendMessage({ type: 'save-automation', automation: {
    id: 'once-case', name: 'Four steps', enabled: false, urls: ['file:///*'],
    steps: [1, 2, 3, 4].map((n) => ({ id: `step-${n}`, kind: 'click', finder: { strategy: 'css', selector: '' } })),
    schedule: { kind: 'manual' },
  } });
  return true;
});
await panel.reload();
await panel.waitForTimeout(1600);
const trap = async () => panel.evaluate(() => {
  window.__all = [];
  chrome.runtime.onMessage.addListener((m, sender) => {
    try { window.__all.push({ t: m?.type, from: sender?.tab ? 'content' : 'page', at: Date.now() }); } catch {}
  });
});
await trap();

await panel.evaluate(() => { const b = [...document.querySelectorAll('nav button')].find((x) => /Automations/.test(x.textContent ?? '')); b?.click(); });
await panel.waitForTimeout(600);
await panel.evaluate(() => { const b = [...document.querySelectorAll('main button')].find((x) => /✎|Edit|ویرایش/.test(x.textContent ?? '')); b?.click(); });
await panel.waitForTimeout(800);

check('the editor shows four points, so a single-point shortcut cannot hide a duplicate',
  (await panel.locator('main button.pick').count()) >= 4, String(await panel.locator('main button.pick').count()));

const pads = ['#pad1', '#pad2', '#pad3'];
for (let i = 0; i < pads.length; i++) {
  const before = await panel.evaluate(() => (window.__all ?? []).length);
  await panel.locator('main button.pick').nth(i).click();
  await panel.waitForTimeout(400);
  await page.waitForFunction(() => document.documentElement.style.cursor === 'crosshair', null, { timeout: 6000 }).catch(() => {});
  await page.bringToFront();
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, pads[i]);
  await page.mouse.click(box.x, box.y);
  await panel.waitForTimeout(1300);
  await panel.bringToFront();
  await panel.waitForTimeout(250);

  const msgs = await panel.evaluate((b) => (window.__all ?? []).slice(b).filter((m) => m.t === 'element-picked'), before);
  const text = await panel.evaluate(() => document.querySelector('main')?.innerText ?? '');
  const complained = /no point was waiting|هیچ نقطه‌ای منتظرش نبود/i.test(text);
  check(`pick ${i + 1}: exactly ONE element-picked message`, msgs.length === 1,
    `${msgs.length} message(s): ${JSON.stringify(msgs.map((m) => m.from))}`);
  check(`pick ${i + 1}: no "no point was waiting" complaint`, complained === false,
    complained ? 'the complaint came back' : 'no complaint');
}

const passed = results.filter((r) => r.ok === true).length;
console.log(`\n${'='.repeat(70)}\n${passed}/${results.length} checks passed`);
for (const r of results.filter((r) => r.ok !== true)) console.log(`  FAIL ${r.name}`);
await ctx.close();
process.exit(passed === results.length ? 0 : 1);
