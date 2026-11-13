#!/usr/bin/env node
/**
 * READ THE LIVE TAB: where the gear is, and what the end field does when typed into.
 *
 * Written because two faults survived a reading of the source: the settings gear was not found by the selector the test used, and a
 * typed END time did not reach the model. Both are questions about the live DOM, so both are answered from the live DOM rather than
 * from another look at the source.
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installProfileSweep } from './lib/profile.mjs';

installProfileSweep();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const main = async () => {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(os.tmpdir(), 'autoflow-win-')), {
    executablePath: CHROME, headless: false,
    args: [`--disable-extensions-except=${path.join(ROOT, 'dist')}`, `--load-extension=${path.join(ROOT, 'dist')}`,
      '--no-first-run', '--no-default-browser-check'],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 25000 }).catch(() => null);
  if (!sw) throw new Error('no service worker appeared');
  const extId = new URL(sw.url()).host;

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  await panel.waitForFunction(() => document.querySelectorAll('nav.tabs button').length > 0, { timeout: 25000 });
  await panel.evaluate(() => {
    const b = [...document.querySelectorAll('nav.tabs button')].find((x) => /Window|پنجره/.test(x.textContent));
    b?.click();
  });
  await panel.waitForTimeout(1200);

  const dom = await panel.evaluate(() => {
    const rows = [...document.querySelectorAll('.win-times')];
    return {
      rowCount: rows.length,
      perRow: rows.map((r) => [...r.querySelectorAll('button')].map((b) => ({ cls: b.className, title: b.title, text: b.textContent.trim() }))),
      timeSettingsTotal: document.querySelectorAll('.time-settings').length,
      inputsTotal: document.querySelectorAll('.win-times .time-input').length,
    };
  });
  console.log('=== the time rows, and every button inside them ===');
  console.log(JSON.stringify(dom, null, 2));

  // THE OUTER HTML ANSWERS WHERE THE GEAR IS, and what timeField actually returned
  const html = await panel.evaluate(() => {
    const row = document.querySelector('.win-times');
    return row ? row.outerHTML.slice(0, 1200) : null;
  });
  console.log('\n=== the first time row, as HTML ===');
  console.log(html);

  const endSel = '.win-times .time-input >> nth=1';
  await panel.click(endSel);
  await panel.evaluate(() => { document.querySelectorAll('.win-times .time-input')[1].select(); });
  await panel.keyboard.type('205033200', { delay: 40 });
  console.log('\ntyped value in the field :', JSON.stringify(await panel.evaluate(() => document.querySelectorAll('.win-times .time-input')[1].value)));

  // blur, then let the auto-save timer run
  await panel.evaluate(() => document.activeElement.blur());
  await panel.waitForTimeout(1600);
  const afterBlur = await panel.evaluate(() => ({
    field: document.querySelectorAll('.win-times .time-input')[1]?.value ?? null,
    summary: document.querySelector('.win-summary')?.textContent?.trim() ?? null,
    error: document.querySelector('.win-error')?.textContent?.trim() ?? null,
  }));
  console.log('\n=== after blur + the auto-save delay ===');
  console.log(JSON.stringify(afterBlur, null, 2));

  const rec = await panel.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'list-automations' });
    const w = (r?.automations ?? []).find((a) => a.id === 'window');
    if (!w) return null;
    return {
      scheduleAt: w.schedule?.at ?? null,
      scheduleKind: w.schedule?.kind ?? null,
      untilMs: w.options?.untilMs ?? null,
      hasUntil: Object.prototype.hasOwnProperty.call(w.options ?? {}, 'untilMs'),
      steps: w.steps?.length ?? 0,
      urls: w.urls,
    };
  });
  console.log('\n=== the stored window record ===');
  console.log(JSON.stringify(rec, null, 2));

  await ctx.close();
};
main().catch((e) => { console.error(e); process.exit(1); });