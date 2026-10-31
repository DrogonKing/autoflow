#!/usr/bin/env node
/**
 * THE REPORT: "when I set the time correctly and then press Pick, the time resets to the default 09."
 *
 * The form's draft is rebuilt from the saved record on any render that does not keep it, and the keep rule only counted
 * STEPS - one empty point with no finder was "no work", so pressing Pick (which renders) rebuilt the form and the schedule
 * came back as 09:00. The time had been typed, accepted by the model, and thrown away.
 *
 * This drives the user's sequence exactly: type a time, press Pick, click an element, and then read the field.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SIM = path.join(ROOT, 'tools', 'sim', 'index.html');
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const profile = autoCleanup(mkdtempSync(path.join(tmpdir(), 'af-time-pick-')));

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
await panel.waitForTimeout(1400);

/**
 * THE PANEL OPENS ON `Automations`, NOT ON `Basic` - so the time field does not exist until the tab is clicked. Measured:
 * `input.time-input` was null on a fresh panel, and the first version of this test waited 30s for a locator that was on
 * another tab.
 */
await panel.evaluate(() => { const b = [...document.querySelectorAll('nav button')].find((x) => /Basic|ساده/.test(x.textContent ?? '')); b?.click(); });
await panel.waitForTimeout(700);

const timeValue = () => panel.evaluate(() => document.querySelector('input.time-input')?.value ?? null);

console.log('\n--- the form starts at its default ---');
const initial = await timeValue();
console.log(`  time: ${initial}`);
check('the default is 09:00:00', initial === '09:00:00', String(initial));

console.log('\n--- type a time, as a person does ---');
await panel.locator('input.time-input').click({ clickCount: 3 });
await panel.locator('input.time-input').fill('');
await panel.locator('input.time-input').type('141530', { delay: 40 });
await panel.locator('input.time-input').blur();
await panel.waitForTimeout(500);
const typed = await timeValue();
console.log(`  time after typing 141530: ${typed}`);
check('the typed time is shown', typed === '14:15:30', String(typed));

console.log('\n--- now press Pick, which is what resets it ---');
await panel.locator('main button.pick').first().click();
await panel.waitForTimeout(500);
const afterPickPress = await timeValue();
console.log(`  time after pressing Pick: ${afterPickPress}`);
check('THE TIME SURVIVES PRESSING PICK', afterPickPress === '14:15:30', String(afterPickPress));

console.log('\n--- and survives the pick landing too ---');
await page.waitForFunction(() => document.documentElement.style.cursor === 'crosshair', null, { timeout: 6000 }).catch(() => {});
await page.bringToFront();
const box = await page.evaluate(() => {
  const el = document.querySelector('#pad2');
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(box.x, box.y);
await panel.waitForTimeout(1400);
await panel.bringToFront();
await panel.waitForTimeout(300);

const final = await timeValue();
const selector = await panel.evaluate(() => {
  const i = [...document.querySelectorAll('main input')].find((x) => /mono/.test(x.className) && !/time-input/.test(x.className));
  return i?.value ?? '';
});
console.log(`  time: ${final}   selector: ${JSON.stringify(selector)}`);
check('the time still survives the pick landing', final === '14:15:30', String(final));
check('and the selector arrived as well, so the fix did not trade one for the other', /pad2/.test(selector), selector);

console.log('\n--- and the schedule the model holds is the typed one ---');
const sched = await panel.evaluate(() => {
  const t = document.querySelector('main')?.innerText ?? '';
  return t.split('\n').filter((l) => /every day|هر روز|14:15/i.test(l)).slice(0, 3);
});
console.log(`  preview: ${JSON.stringify(sched)}`);
check('the preview describes 14:15, not 09:00', sched.some((l) => /14:15/.test(l)), JSON.stringify(sched));

const passed = results.filter((r) => r.ok === true).length;
console.log(`\n${'='.repeat(70)}\n${passed}/${results.length} checks passed`);
for (const r of results.filter((r) => r.ok !== true)) console.log(`  FAIL ${r.name}`);
await ctx.close();
process.exit(passed === results.length ? 0 : 1);
