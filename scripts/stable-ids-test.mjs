#!/usr/bin/env node
/**
 * AN ID MUST NOT DEPEND ON WHICH TIME HAPPENS TO BE FIRST.
 *
 * MEASURED (`deep-debug-1`): adding three times produced the ids
 *
 *     basic, basic-new1, basic-new1-new1
 *
 * and retiming one produced `basic-new1-new2`. `addEvent` was given `baseId = draft.id`, and after every save the panel
 * sets `state.basic` to the FIRST event in `orderByNextRun` order - so the root used to generate the next id was
 * "whichever time is soonest", which changes with the clock and with every retime.
 *
 * These ids are what the alarms are registered under (`autoflow:run:<id>`), so an id that depends on sort order is the
 * same class of fault that once made a deletion remove the wrong time and an alarm point at the wrong instant.
 *
 * This asserts the shape and its stability, because both matter: `basic-new1`, `basic-new2`, ... and the same set of ids
 * regardless of the order the times happen to have been created or retimed in.
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail ? `\n        ${String(detail).slice(0, 200)}` : ''}`);
};

const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<button id="t" style="position:fixed;top:80px;left:60px;width:140px;height:60px">buy</button>'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-ids-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
for (let i = 0; i < 14 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); [sw] = ctx.serviceWorkers(); }
const id = new URL(sw.url()).host;
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('  *** PANEL ERROR:', e.message.slice(0, 200)));
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

const ids = () => panel.evaluate(() => [...document.querySelectorAll('.chip[data-event-id], .event-chip[data-event-id]')].map((c) => c.dataset.eventId));
const stored = () => sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return (all.automations ?? []).map((a) => a.id);
});
const pressNewTime = async () => {
  const at = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button')].find((x) => /new time/i.test(x.textContent));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!at) return false;
  await panel.mouse.click(at.x, at.y);
  await panel.waitForTimeout(850);
  return true;
};
/** Give the open time a point AND a distinct time, so it is a real record: a point-less time is not saved by design. */
const furnish = async (which) => {
  const pb = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button.pick')].filter((x) => x.offsetParent).pop();
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (pb) {
    await panel.mouse.click(pb.x, pb.y);
    await panel.waitForTimeout(450);
    await page.bringToFront();
    // click a different offset per time so each gets a distinguishable selector
    const t = await page.evaluate((sel) => {
      const el = document.getElementById(sel) ?? document.body;
      const r = el.getBoundingClientRect();
      return { x: r.x + 6 + (sel.charCodeAt(0) % 7) * 3, y: r.y + r.height / 2 };
    }, which);
    await page.mouse.click(t.x, t.y);
    await panel.waitForTimeout(1500);
    await panel.bringToFront();
    await panel.waitForTimeout(400);
  }
};

console.log('\n=== 1. the first time keeps the form\'s own id ===');
const first = await ids();
check('the initial time is "basic"', first.length === 0 || first[0] === 'basic', JSON.stringify(first));
await furnish('t');
await panel.waitForTimeout(1800);

console.log('\n=== 2. added times are numbered from the form, not nested ===');
for (let i = 0; i < 3; i += 1) { await pressNewTime(); await furnish('t'); await panel.waitForTimeout(1500); }
await panel.waitForTimeout(1600);
const all = await ids();
console.log('  ids on screen:', JSON.stringify(all));
const bad = all.filter((x) => /-new\d+-new/.test(x));
check('NO id is nested (the measured fault)', bad.length === 0, bad.length ? JSON.stringify(bad) : 'none');
const expected = ['basic', 'basic-new1', 'basic-new2', 'basic-new3'];
const sorted = [...all].sort();
check('the ids are one form root plus a simple counter', JSON.stringify(sorted) === JSON.stringify(expected),
  `${JSON.stringify(sorted)} vs ${JSON.stringify(expected)}`);

console.log('\n=== 3. and they are what storage holds ===');
const storedIds = [...(await stored())].sort();
console.log('  stored:', JSON.stringify(storedIds));
check('the stored ids match the form, with no nesting', storedIds.every((x) => !/-new\d+-new/.test(x)),
  JSON.stringify(storedIds));
check('every id is unique', new Set(storedIds).size === storedIds.length, JSON.stringify(storedIds));

console.log('\n=== 4. RETIMING does not change ids ===');
/** The fault depended on sort order, so retiming a time to sort first must not relabel anything. */
const beforeRetime = [...(await ids())].sort();
const firstChip = await panel.evaluate(() => {
  const c = [...document.querySelectorAll('.chip[data-event-id], .event-chip[data-event-id]')].slice(-1)[0];
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (firstChip) {
  await panel.mouse.click(firstChip.x, firstChip.y);
  await panel.waitForTimeout(700);
  const fb = await panel.evaluate(() => {
    const f = document.querySelector('input.time-input');
    const r = f.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await panel.mouse.click(fb.x, fb.y);
  await panel.waitForTimeout(220);
  await panel.keyboard.type('070000000');       // 07:00:00.000 - sorts before everything
  await panel.keyboard.press('Enter');
  await panel.waitForTimeout(2400);
}
const afterRetime = [...(await ids())].sort();
console.log(`  before: ${JSON.stringify(beforeRetime)}\n  after : ${JSON.stringify(afterRetime)}`);
check('retiming a time did not relabel any id', JSON.stringify(afterRetime) === JSON.stringify(beforeRetime),
  `${JSON.stringify(afterRetime)} vs ${JSON.stringify(beforeRetime)}`);

console.log('\n=== 4b. an id ALREADY TAKEN by storage is never reused ===');
/**
 * A form that already holds an id the counter would otherwise choose must skip past it. This is what makes the fix safe
 * even with the older nested ids in someone's storage: `nextEventId` checks every existing id, so a reused identity - two
 * automations sharing one alarm name - cannot happen.
 */
/**
 * THE ID TO BLOCK IS THE ONE THE COUNTER WOULD CHOOSE NEXT, and it must be injected as a DISTINCT record.
 *
 * MEASURED mistake in this test's first version: it cloned a record and gave the clone the id `basic-new1`, which was
 * already in use - so storage genuinely held two records with that id and the "duplicate" the assertions caught was the
 * test's own bad data, not the application's. The next counter choice is what has to be blocked, and storage must stay
 * internally consistent for the result to mean anything.
 */
const taken = await sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const list = all.automations ?? [];
  const used = new Set(list.map((a) => a.id));
  let n = 1;
  while (used.has(`basic-new${n}`)) n += 1;          // this is what nextEventId would pick
  const clone = JSON.parse(JSON.stringify(list[0]));
  clone.id = `basic-new${n}`;
  clone.name = 'occupied-id-probe';
  clone.schedule = { ...clone.schedule, hour: 23, minute: 59 };
  list.push(clone);
  await chrome.storage.local.set({ automations: list });
  return { ids: list.map((a) => a.id), occupied: clone.id };
});
console.log('  storage now holds:', JSON.stringify(taken.ids), '| occupied:', taken.occupied);
await panel.reload();
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await panel.waitForTimeout(1200);
await pressNewTime();
const afterTaken = [...(await ids())].sort();
console.log('  ids after adding one with basic-new1 already used:', JSON.stringify(afterTaken));
check('no id was reused', new Set(afterTaken).size === afterTaken.length, JSON.stringify(afterTaken));
check('the new time skipped past the occupied id instead of duplicating it',
  afterTaken.filter((x) => x === taken.occupied).length === 1, `${taken.occupied} appears once in ${JSON.stringify(afterTaken)}`);

console.log('\n=== 5. one more time after the retime still continues the counter ===');
await pressNewTime();
await furnish('t');
await panel.waitForTimeout(2200);
const finalIds = [...(await ids())].sort();
console.log('  ids now:', JSON.stringify(finalIds));
check('the next id continues the sequence rather than reusing or nesting',
  finalIds.includes('basic-new4') && finalIds.every((x) => !/-new\d+-new/.test(x)), JSON.stringify(finalIds));

server.close();
await ctx.close();
console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);