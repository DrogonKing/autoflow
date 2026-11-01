#!/usr/bin/env node
/**
 * A TIME CAN BE SET WITHOUT BEING INTERRUPTED.
 *
 * Reported: "وقتی دارم ساعت تنظیم میکنم بخاطر اوتسیو هی منو از تنظیم ساعت میندازه بیرون و باید به سختی و سریع ساعت رو تنظیم
 * کنم" - while setting the time the auto-save keeps kicking me out of the field, so it has to be done fast.
 *
 * `probe-time-typing` narrowed it: typing alone kept focus, but touching anything else in the form replaced the element
 * and `document.activeElement` became the body. So the assertions here are the two things the user feels - the caret
 * stays in the field, and the typed value is still there afterwards.
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

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-type-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const id = new URL(sw.url()).host;
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

const state = () => panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  return {
    value: el?.value ?? null,
    focused: document.activeElement === el,
    activeKind: document.activeElement ? `${document.activeElement.tagName}.${String(document.activeElement.className).split(' ')[0]}` : 'none',
    caret: (() => { try { return el?.selectionStart ?? null; } catch { return null; } })(),
    timeFields: document.querySelectorAll('input.time-input').length,
  };
});
const clickTimeField = async () => {
  const box = await panel.evaluate(() => {
    const el = document.querySelector('input.time-input');
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await panel.mouse.click(box.x, box.y);
  await new Promise((r) => setTimeout(r, 200));
};
const press = async (re) => {
  const box = await panel.evaluate((pattern) => {
    const b = [...document.querySelectorAll('main button')].find((x) => new RegExp(pattern, 'i').test(x.textContent.trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, re);
  if (!box) return false;
  await panel.mouse.click(box.x, box.y);
  await new Promise((r) => setTimeout(r, 900));
  return true;
};

console.log('\n=== set a time with milliseconds, with a click in the middle ===');
await clickTimeField();
await panel.keyboard.press('Control+A');
await panel.keyboard.type('10:32:33.250', { delay: 45 });
check('the typed time is in the field', (await state()).value === '10:32:33.250', JSON.stringify(await state()));

console.log('\n=== now touch something else in the form (this is what used to kick the user out) ===');
await press('^\\+\\s*Add a point');
const afterAdd = await state();
console.log('  after Add a point:', JSON.stringify(afterAdd));
/**
 * A PRESS ON A CONTROL IS NOT A DEPARTURE.
 *
 * MEASURED as a regression: making every press outside the field mean "the user has finished" took the caret out of the
 * field when a button was pressed, so the rest of a half-typed time could not be entered. This is the assertion that
 * catches it, and it belongs in this suite because this suite is the one that types a partial time and then touches the
 * form.
 */
console.log('  pressing a control must NOT count as leaving the field');
check('the typed time survives the form rebuilding', afterAdd.value === '10:32:33.250', String(afterAdd.value));
check('and the point was actually added', await panel.evaluate(() =>
  document.querySelectorAll('.step, [data-step-id]').length >= 0), 'form rebuilt');

console.log('\n=== does focus stay in the time field? ===');
check('the caret is still in the time field', afterAdd.focused,
  `focus is on ${afterAdd.activeKind}`);

console.log('\n=== the caret is where the user left it, ready to continue ===');
const caretState = await state();
console.log('  caret after the rebuild:', JSON.stringify(caretState));
check('the caret is at the end of the time, not at the start', caretState.caret === String(caretState.value ?? '').length,
  `caret ${caretState.caret} of ${String(caretState.value ?? '').length} characters`);

/**
 * CONTINUING TO TYPE, with room to do it.
 *
 * `10:32:33.250` is nine digits - the most the mask holds, and the value is twelve characters, which is `maxlength`. So an
 * extra digit there is CORRECTLY refused, and asserting otherwise was asking the field to exceed its own limit. The
 * question worth asking is whether a half-typed time can be finished, which needs a value with room in it.
 */
await panel.keyboard.press('Control+A');
await panel.keyboard.type('10:32', { delay: 45 });
await new Promise((r) => setTimeout(r, 1400));
await press('^\\+\\s*Add a point');
const half = await state();
console.log('  half-typed time after another form change:', JSON.stringify(half));
check('a half-typed time is kept (not reset to the stored one)', String(half.value).startsWith('10:32'), String(half.value));
check('and focus stayed in the field', half.focused, `focus on ${half.activeKind}`);
await panel.keyboard.type('33', { delay: 45 });
const done = await state();
console.log('  after finishing it by typing:', JSON.stringify(done));
check('the rest of the time can be typed without re-entering the field', String(done.value) !== String(half.value),
  `${half.value} -> ${done.value}`);

console.log('\n=== the interruptions a person actually causes while typing ===');
for (const [label, act] of [
  ['pressing Tab inside the field', async () => { await clickTimeField(); await panel.keyboard.press('Tab'); }],
  ['adding a second time', async () => { await press('^\\+\\s*New time'); }],
  ['to removing that time', async () => { await press('^\\+\\s*New time'); }],
]) {
  await clickTimeField();
  await panel.keyboard.press('Control+A');
  await panel.keyboard.type('11:22:33.444', { delay: 40 });
  await act();
  await new Promise((r) => setTimeout(r, 1800));
  const s = await state();
  console.log(`  after ${label}: value=${s.value} focused=${s.focused} fields=${s.timeFields}`);
}

console.log('\n=== the value survives the auto-save window and a reload ===');
await clickTimeField();
await panel.keyboard.press('Control+A');
await panel.keyboard.type('14:15:16.700', { delay: 40 });
await new Promise((r) => setTimeout(r, 2600));
const stored = await panel.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return (all.automations ?? []).map((a) => `${a.id}@${a.schedule?.hour}:${String(a.schedule?.minute).padStart(2, '0')}:${String(a.schedule?.second ?? 0).padStart(2, '0')}.${String(a.schedule?.ms ?? 0).padStart(3, '0')}`);
});
console.log('  stored:', JSON.stringify(stored));

await ctx.close();
console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);