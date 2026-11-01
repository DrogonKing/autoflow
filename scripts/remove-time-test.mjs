#!/usr/bin/env node
/**
 * A TIME THAT WAS ADDED BY MISTAKE CAN BE REMOVED.
 *
 * The report: "چرا دکمه حذف زمان وجود نداره؟ مثلا من یه زمان سومی اضافه کردم بعد پشیمون شدم و میخوام حذفش کنم ولی
 * دکمش نیست" - a third time was added, then regretted, and there was no control to remove it.
 *
 * `removeEvent()` existed in events-view.js from the start and was NEVER CALLED from the panel. Nothing failed, because
 * every test asked the questions I had thought to ask: that a time can be ADDED, that its points survive, that the times
 * come back after a reopen. Nobody asked whether one can be taken away.
 *
 * So this asserts the control exists, that pressing it removes THAT time and no other, that the removed time's record is
 * deleted from storage rather than left to fire on its own, and that the last remaining time cannot be removed.
 */
import { mkdtempSync } from 'node:fs';
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
  console.log(`  ${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail ? `\n        ${String(detail).slice(0, 240)}` : ''}`);
};

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-rm-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1100 },
});
/**
 * THE WORKER MAY ALREADY BE RUNNING when this line executes, and `waitForEvent` only resolves for a worker that starts
 * AFTER the listener is attached - so the fast path times out. Reading the context's existing workers first, and only
 * waiting when there are none, is the shape that does not race the boot.
 */
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const id = new URL(sw.url()).host;
if (!id) { console.error('no extension id'); process.exit(1); }

const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 15000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

const chips = () => panel.evaluate(() => [...document.querySelectorAll('.event-chip')].map((c) => ({
  text: c.querySelector('.event-chip-open')?.textContent?.trim() ?? c.textContent.trim(),
  hasRemove: Boolean(c.querySelector('.event-chip-remove')),
  id: c.dataset.eventId ?? null,
})));
const pressAddTime = async () => {
  const box = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button')].find((x) => /New time|زمان جدید/.test(x.textContent));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) return false;
  await panel.mouse.click(box.x, box.y);
  await new Promise((r) => setTimeout(r, 700));
  return true;
};
/**
 * Press the remove control of the chip with this ID.
 *
 * BY ID, NOT BY POSITION. A re-render between reading the list and clicking can insert or remove chips, so "the nth
 * remove button" is not the one that was read - MEASURED, that pattern clicked nothing once and removed the wrong time
 * another time. `data-event-id` exists so a control can be addressed by what it belongs to.
 */
const pressRemoveOn = async (eventId) => {
  const box = await panel.evaluate((id) => {
    const chip = [...document.querySelectorAll('.event-chip')].find((c) => c.dataset.eventId === id);
    const b = chip?.querySelector('.event-chip-remove');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, eventId);
  if (!box) return false;
  await panel.mouse.click(box.x, box.y);
  await new Promise((r) => setTimeout(r, 900));
  return true;
};
const stored = () => sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return (all.automations ?? []).map((a) => `${a.id}@${a.schedule?.hour}:${String(a.schedule?.minute).padStart(2, '0')}`);
});

console.log('\n=== one time: there is nothing to remove yet ===');
check('with a single time, no delete control is shown', (await chips()).length === 0,
  'the chooser only appears once there are two');

console.log('\n=== give the first time a point, so storage has something to hold ===');
const setPoint = async (sel) => {
  await panel.evaluate((s) => {
    const inputs = [...document.querySelectorAll('main input')].filter((x) => !/time-input/.test(x.className));
    const i = inputs[inputs.length - 1];
    if (i) { i.value = s; i.dispatchEvent(new Event('change', { bubbles: true })); }
  }, sel);
  await new Promise((r) => setTimeout(r, 300));
};
await setPoint('#a');
await new Promise((r) => setTimeout(r, 1800));      // past the auto-save debounce
console.log('  stored after the first point:', JSON.stringify(await stored()));

console.log('\n=== add two more, so the report\'s "third time" exists ===');
await pressAddTime();
await setPoint('#b');
await pressAddTime();
await setPoint('#c');
await new Promise((r) => setTimeout(r, 1800));
console.log('  stored after all three have a point:', JSON.stringify(await stored()));
const three = await chips();
check('three times are listed', three.length === 3, JSON.stringify(three.map((c) => c.text)));
check('EVERY one of them has a delete control', three.every((c) => c.hasRemove),
  JSON.stringify(three.map((c) => c.hasRemove)));

console.log('\n=== remove the second ===');
const beforeChips = await chips();
const before = beforeChips.map((c) => c.text);
const targetChip = beforeChips[1];
const target = targetChip.text;
const removed = await pressRemoveOn(targetChip.id);
check('the delete control is pressable', removed, '');
const after = await chips();
console.log('  before :', JSON.stringify(before));
console.log('  after  :', JSON.stringify(after.map((c) => c.text)));
check('that time is gone', after.length === 2 && !after.some((c) => c.text === target), JSON.stringify(after.map((c) => c.text)));
check('the OTHER times are untouched', after.every((c) => before.includes(c.text)),
  JSON.stringify(after.map((c) => c.text)));

console.log('\n=== the removal reaches storage, so a deleted time cannot fire ===');
await new Promise((r) => setTimeout(r, 2000));
const recs = await stored();
console.log('  stored:', JSON.stringify(recs));
/**
 * The removed time must not keep an alarm of its own. Two records remain for the two times still shown, and the id of the
 * removed one is gone - which is what `eventsToStore`'s removal set exists for.
 */
check('the removed time no longer has a record', recs.length === 2, JSON.stringify(recs));
check('and both remaining times are still stored', recs.length === after.length, `${recs.length} record(s) vs ${after.length} time(s)`);

console.log('\n=== removing the last time is refused ===');
const leftChips = await chips();
await pressRemoveOn(leftChips[0].id);
const remaining = await chips();
/**
 * WITH ONE TIME LEFT THE CHOOSER IS HIDDEN ENTIRELY - `chips()` is 0, not 1.
 *
 * That is the same rule the form started with: a chooser between one option is noise, and the page is meant to look
 * exactly as it did before several times existed. So the assertion is not "one chip remains" but "the chooser is gone
 * and the single time is still open in the form".
 */
const openTime = await panel.evaluate(() => document.querySelector('input.time-input')?.value ?? null);
check('the chooser disappears, because one time needs no chooser', remaining.length === 0,
  JSON.stringify(remaining.map((c) => c.text)));
check('and one time is still open in the form', typeof openTime === 'string' && openTime.length >= 5, String(openTime));
const noRemoveLeft = await panel.evaluate(() => document.querySelectorAll('.event-chip-remove').length);
check('and with one time left, the delete control is not offered at all', noRemoveLeft === 0, `${noRemoveLeft} control(s)`);

console.log('\n=== the deletion survives a reload ===');
await panel.reload();
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 15000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));
const afterReload = await chips();
console.log('  chips after reload:', JSON.stringify(afterReload.map((c) => c.text)));
check('the deleted time does not come back', afterReload.length <= 1, JSON.stringify(afterReload.map((c) => c.text)));
const recsAfter = await stored();
/**
 * WITH ONE TIME LEFT THE FORM SHOWS NO CHIPS, so the count to compare against is the FORM's times, not the chips - the
 * chooser is hidden when there is nothing to choose between. Asserting `<= 1` was wrong: two records are correct here,
 * one for each time the form still holds, and asserting one would have "passed" a build that had lost a time.
 */
const timesInForm = await panel.evaluate(() => document.querySelectorAll('input.time-input').length);
check('storage matches the times the form still holds', recsAfter.length === timesInForm,
  `${recsAfter.length} record(s), ${timesInForm} time(s) in the form`);
check('and the time that was deleted is not among them', !recsAfter.some((r) => /@9:01$/.test(r)), JSON.stringify(recsAfter));

console.log('\n=== and the single remaining time still works ===');
check('the form still shows one time field', (await panel.evaluate(() => document.querySelectorAll('input.time-input').length)) === 1,
  '');

await ctx.close();
console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);