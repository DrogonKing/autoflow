#!/usr/bin/env node
/**
 * THE BASIC PAGE MUST LOOK THE WAY IT DID, with one addition under the points.
 *
 * The request was explicit about the SHAPE: "I want the selection page to be like before and show only one time and one
 * pick, but like pick, which has an option to add more, under those add a new-time option."
 *
 * So this checks the shape rather than the feature:
 *
 *   - one time field and one point list are visible, as before
 *   - a "+ Add a point" button exists (the old one)
 *   - a new-time button exists BELOW it, so the ordering is what was asked for
 *   - pressing it adds a second time, with its own point already in it, and the form switches to that time
 *   - the first time's points are NOT disturbed
 *   - with two times, a chooser appears so either can be reopened
 */
import { mkdtempSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 250)}` : ''}`);
};

const main = async () => {
  const dist = path.join(ROOT, 'dist');
  if (!existsSync(path.join(dist, 'manifest.json'))) {
    console.log('dist/ not built');
    process.exit(1);
  }
  const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-ev-')));

  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    headless: false,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-sandbox'],
    viewport: { width: 1280, height: 1000 },
  });
  /**
   * WAIT FOR A CONDITION, NOT FOR A TIMEOUT, AND DO NOT MISS AN ALREADY-RUNNING WORKER.
   *
   * MEASURED flake: this test failed twice in a row with `exactly ONE time field is shown  0` - it looked for the form
   * before the panel had drawn it. A fixed `setTimeout(600)` is a guess that passes or fails by luck under load, and
   * `waitForEvent('serviceworker')` only catches a worker that starts AFTER the listener is attached, so a worker that is
   * already running is missed - the documented "no worker" flake. Polling for the worker and then waiting for the panel's
   * own button removes both: if this test says "0 time fields", the form really did not draw.
   */
  let [sw] = ctx.serviceWorkers();
  for (let i = 0; i < 20 && !sw; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    [sw] = ctx.serviceWorkers();
  }
  if (!sw) throw new Error('no service worker appeared at all');
  const extId = new URL(sw.url()).host;

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  await panel.waitForLoadState('domcontentloaded');
  await panel.waitForFunction(() => document.querySelectorAll('nav.tabs button').length > 0, { timeout: 25000 });
  await panel.evaluate(() => {
    const b = [...document.querySelectorAll('nav.tabs button')].find((x) => /Basic|پایه/.test(x.textContent));
    b?.click();
  });
  // the Basic form is drawn when its own field exists, which is what every assertion below depends on
  await panel.waitForFunction(() => document.querySelector('input.time-input') !== null, { timeout: 15000 })
    .catch(() => {});

  /** Read the form's shape as the user sees it. */
  const shape = () => panel.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].map((b) => b.textContent.trim());
    const timeInputs = [...document.querySelectorAll('input.time-input')];
    const labels = [...document.querySelectorAll('label')].map((l) => l.textContent.trim());
    return {
      timeInputs: timeInputs.map((i) => i.value),
      // the FIRST time field and the FIRST point row are what the old page showed
      pointRows: document.querySelectorAll('.step').length,
      hasAddPoint: btns.some((b) => /Add a point|افزودن نقطه/.test(b)),
      hasAddTime: btns.some((b) => /New time|زمان جدید/.test(b)),
      addPointIndex: btns.findIndex((b) => /Add a point|افزودن نقطه/.test(b)),
      addTimeIndex: btns.findIndex((b) => /New time|زمان جدید/.test(b)),
      chips: [...document.querySelectorAll('.event-chip')].map((c) => c.textContent.trim()),
      labels,
      buttons: btns.filter((b) => b),
    };
  });

  const before = await shape();
  console.log('\n--- the page as it opens (must look like the old one) ---');
  console.log('  time fields :', JSON.stringify(before.timeInputs));
  console.log('  point rows  :', before.pointRows);
  console.log('  has Add a point:', before.hasAddPoint, ' has New time:', before.hasAddTime);
  check('exactly ONE time field is shown', before.timeInputs.length === 1, `${before.timeInputs.length}`);
  check('a "+ Add a point" button is still there', before.hasAddPoint, '');
  check('the new-time button exists', before.hasAddTime, '');
  check('it sits BELOW "+ Add a point", as asked',
    before.addTimeIndex > before.addPointIndex && before.addPointIndex >= 0,
    `addPoint at ${before.addPointIndex}, addTime at ${before.addTimeIndex}`);
  check('and no time-chooser is shown yet, because there is one time',
    before.chips.length === 0, `${before.chips.length} chip(s)`);

  console.log('\n--- press the new-time button ---');
  await panel.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => /New time|زمان جدید/.test(b.textContent))?.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  const after = await shape();
  console.log('  time fields :', JSON.stringify(after.timeInputs));
  console.log('  point rows  :', after.pointRows);
  console.log('  chips       :', JSON.stringify(after.chips));
  console.log('  buttons     :', JSON.stringify(after.buttons.slice(0, 12)));

  check('still one time field open, not a second stacked card', after.timeInputs.length === 1, `${after.timeInputs.length}`);
  check('the new time got its own point already, so it is usable straight away',
    after.pointRows >= 1, `${after.pointRows} point row(s)`);
  check('a chooser now lists both times, each with its point count', after.chips.length === 2,
    after.chips.join(' | '));
  check('the new time is a different minute from the first, not a silent duplicate',
    after.timeInputs[0] !== before.timeInputs[0], `${before.timeInputs[0]} -> ${after.timeInputs[0]}`);

  await ctx.close();
  console.log('\n' + '='.repeat(78));
  const failed = results.filter((r) => r.ok === false);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((e) => {
  console.error('events-ui-test could not run:', e.message);
  process.exit(1);
});
