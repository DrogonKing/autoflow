#!/usr/bin/env node
/**
 * The Pick confirmation, with THREE points on the panel.
 *
 * The reported fault was visual: "when it goes green, all the previously created picks go green too, when only the
 * selected one should." That needs more than one point to observe at all, which is why the existing single-point
 * browser checks could not have caught it.
 *
 * The test asserts the PROPERTY rather than one example - after a pick lands, the count of green buttons must be
 * EXACTLY ONE, and it must be the point that was picked - and it also asserts the old behaviour is gone by counting
 * before the pick, when the count must be zero.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();

const DIST = '/root/autoflow/dist';
const SIM = '/root/autoflow/tools/sim/index.html';
const CHROME = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const server = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(readFileSync(SIM)); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-pickconfirm-')));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-sandbox',
    '--disable-dev-shm-usage', '--disable-features=DisableLoadExtensionCommandLineSwitch'],
});

let worker = null;
for (let i = 0; i < 80 && !worker; i++) {
  for (const w of ctx.serviceWorkers()) {
    try { if (/autoflow/i.test(await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { worker = w; break; } } catch {}
  }
  if (!worker) await new Promise((r) => setTimeout(r, 250));
}
if (!worker) { console.error('FAIL no worker'); await ctx.close(); server.close(); process.exit(1); }
const extId = new URL(worker.url()).host;

const page = await ctx.newPage();
await page.goto(url);
await page.bringToFront();
await page.waitForFunction(() => document.documentElement.getAttribute('data-autoflow-content') !== null, null, { timeout: 20000 });

const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('  [PANEL ERROR]', String(e?.stack ?? e).slice(0, 200)));
await panel.goto(`chrome-extension://${extId}/panel.html`);
await panel.waitForTimeout(1600);
await panel.evaluate(() => {
  const b = [...document.querySelectorAll('nav button')].find((x) => /^\s*Basic\s*$/i.test(x.textContent ?? ''));
  b?.click();
});
await panel.waitForTimeout(700);

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); if (detail !== undefined) console.log(`        ${detail}`); }
  else { fail += 1; console.log(`  FAIL ${label}`); console.log(`        ${detail}`); }
};

/** Every pick button, with the class and text that decide its colour. */
const buttons = () => panel.evaluate(() => [...document.querySelectorAll('main button.pick')].map((b, i) => ({
  i, text: b.textContent.trim(), cls: b.className,
  bg: getComputedStyle(b).backgroundColor, border: getComputedStyle(b).borderTopColor,
})));

const clickAddPoint = async () => {
  await panel.evaluate(() => document.querySelector('input.time-input')?.blur());
  await panel.waitForTimeout(450);
  const box = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button')].find((x) => /^\+\s*(add a point|افزودن نقطه)/i.test(x.textContent.trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (box) await panel.mouse.click(box.x, box.y);
  await panel.waitForTimeout(700);
};

console.log('\n--- build a form with THREE points ---');
await clickAddPoint();
await clickAddPoint();
let bs = await buttons();
console.log(`  points: ${bs.length}`);
check('there are three Pick buttons to tell apart, which the single-point checks could not do', bs.length === 3, JSON.stringify(bs.map((b) => b.text)));

console.log('\n--- nothing has been picked yet, so nothing may be green ---');
const greenCount = (list) => list.filter((b) => b.cls.includes('picked')).length;
check('no button is green before any pick', greenCount(bs) === 0, JSON.stringify(bs.map((b) => b.cls)));

console.log('\n--- pick the SECOND point ---');
/** Click a specific pick button, then click a distinct element on the page so the pick lands on THAT point. */
const pickPoint = async (index, targetSelector) => {
  await panel.evaluate(() => document.querySelector('input.time-input')?.blur());
  await panel.waitForTimeout(400);
  const box = await panel.evaluate((idx) => {
    const b = [...document.querySelectorAll('main button.pick')][idx];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, index);
  if (!box) return false;
  await panel.mouse.click(box.x, box.y);
  await panel.waitForTimeout(700);
  // now click the target on the page
  const tbox = await page.evaluate((sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, targetSelector);
  if (!tbox) return false;
  await page.mouse.click(tbox.x, tbox.y);
  await panel.waitForTimeout(900);
  return true;
};

const picked2 = await pickPoint(1, '#pad2');
check('the pick on point 2 was performed', picked2, 'clicked Pick on index 1 then #pad2 on the page');

bs = await buttons();
console.log(`  button states: ${JSON.stringify(bs.map((b) => ({ t: b.text, c: b.cls })))}`);
console.log(`  green: ${greenCount(bs)}  backgrounds: ${JSON.stringify(bs.map((b) => b.bg))}`);

check('EXACTLY ONE button is green, which is the reported fault', greenCount(bs) === 1,
  `${greenCount(bs)} green of ${bs.length}`);
check('and it is the point that was picked (index 1)',
  bs[1].cls.includes('picked') && !bs[0].cls.includes('picked') && !bs[2].cls.includes('picked'),
  JSON.stringify(bs.map((b) => b.cls)));
check('the green is actually rendered, not only applied as a class',
  bs[1].bg === 'rgb(46, 160, 67)', `index1 bg=${bs[1].bg}`);
check('the confirmation reads as a confirmation', /picked|برداشته/i.test(bs[1].text), bs[1].text);

console.log('\n--- the confirmation must expire, and take the green with it ---');
await panel.waitForTimeout(2000);
bs = await buttons();
check('after the confirmation window nothing is green', greenCount(bs) === 0,
  JSON.stringify(bs.map((b) => ({ t: b.text, c: b.cls }))));

console.log('\n--- and the first point was not polluted by any of it ---');
bs = await buttons();
check('point 1 is still idle', bs[0].cls === 'pick', bs[0].cls);
check('point 3 is still idle', bs[2].cls === 'pick', bs[2].cls);

console.log(`\n${'='.repeat(78)}`);
console.log(`${pass}/${pass + fail} checks passed`);

await ctx.close();
server.close();
process.exit(fail === 0 ? 0 : 1);
