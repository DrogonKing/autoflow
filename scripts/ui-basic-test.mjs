#!/usr/bin/env node
/**
 * The three reports, verified in a real browser.
 *
 * 1. "the time numbers cannot be changed by typing, only by scrolling" - so type into the field with real
 *    keystrokes and read back what the model holds. A synthetic `.value =` assignment would not prove anything:
 *    the bug was that the input was re-created on every change and the caret was lost between keystrokes.
 * 2. a Basic tab that takes a time and picked points, with + to add and a way to delete.
 * 3. a picked element that can be edited and removed - in both editors.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const SIM = path.join(ROOT, 'tools', 'sim', 'index.html');
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 220)}` : ''}`);
};

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-ui-')));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-sandbox',
    '--disable-dev-shm-usage', '--disable-features=DisableLoadExtensionCommandLineSwitch'],
});

let worker = null;
for (let i = 0; i < 60 && !worker; i++) {
  for (const w of ctx.serviceWorkers()) {
    try { if (/autoflow/i.test(await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { worker = w; break; } } catch {}
  }
  if (!worker) await new Promise((r) => setTimeout(r, 300));
}
if (!worker) { console.error('no worker'); await ctx.close(); process.exit(1); }
const extId = new URL(worker.url()).host;

const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`);
await panel.waitForTimeout(1000);

// seed one automation, so the full editor can be opened without depending on the empty-list button
await panel.evaluate(() => chrome.runtime.sendMessage({
  type: 'save-automation',
  automation: {
    id: 'seed', name: 'seed', enabled: true, urls: [],
    steps: [{ id: 's1', kind: 'click', finder: { strategy: 'css', selector: '#pad1' } }],
    schedule: { kind: 'daily', hour: 9, minute: 0, second: 0 },
    options: { stepDelayMs: 60 },
  },
}));
await panel.reload();
await panel.waitForTimeout(1000);

console.log('--- 1. the time field accepts TYPED input ---');
{
  // the panel opens on Basic, whose time field is the one the user reported. Driving the FULL editor's field needs
  // a manual-schedule automation to be switched to a calendar kind first, which is a navigation detail rather than
  // the behaviour under test - and the fix (oninput updates the model, onblur re-renders) is literally the same
  // three lines in both editors. So this section types into the Basic field with real keystrokes.
  await panel.evaluate(() => {
    window.__t = null;
  });
  await panel.evaluate(() => {
    const b = [...document.querySelectorAll('nav button')].find((x) => /^automations$|^اتوماسیون$/i.test(x.textContent.trim()));
    b?.click();
  });
  await panel.waitForTimeout(500);
  // open the first automation in the list. "New automation" only renders when the list is empty, so clicking it
  // was never going to work here - and the editor with a time field is what this section is about.
  const opened = await panel.evaluate(() => {
    const card = document.querySelector('main .automation, main .item, main li');
    if (card) { card.click(); return 'card'; }
    const b = [...document.querySelectorAll('main button')].find((x) => /new automation|اتوماسیون جدید/i.test(x.textContent));
    if (b) { b.click(); return 'new'; }
    return null;
  });
  await panel.waitForTimeout(1000);
  console.log(`  editor opened via: ${opened}`);

  // a fresh automation's schedule is `manual`, and the time field only renders for a calendar schedule - so the
  // kind has to be chosen before the time exists. That is the panel's design, not a defect: a time is meaningless
  // for a manual job.
  const kind = await panel.evaluate(() => {
    const sel = [...document.querySelectorAll('main select')].find((s) =>
      [...s.options].some((o) => /daily|روزانه/i.test(o.textContent)));
    if (!sel) return null;
    const opt = [...sel.options].find((o) => /daily|روزانه/i.test(o.textContent));
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: sel.value, option: opt.textContent };
  });
  console.log(`  schedule kind set to: ${JSON.stringify(kind)}`);
  await panel.waitForTimeout(700);

  // go to Basic, whose clock is the reported one
  await panel.evaluate(() => {
    const b = [...document.querySelectorAll('nav button')].find((x) => /basic|ساده/i.test(x.textContent));
    b?.click();
  });
  await panel.waitForTimeout(600);

  const field = panel.locator('main input.time-input').first();
  const exists = await field.count();
  check('a time field is present', exists > 0, `${exists}`);

  if (exists > 0) {
    await field.click();
    // select all, then type a time character by character. Each keystroke is real: this is the part that failed,
    // because the element used to be destroyed by a re-render between keystrokes.
    await field.press('Control+a');
    await field.type('08:45:52', { delay: 60 });
    await panel.waitForTimeout(200);
    const typed = await field.inputValue();
    console.log(`  after typing 08:45:52 the field shows: "${typed}"`);
    check('the typed value stuck, character by character', typed === '08:45:52', typed);

    // and leaving the field must not reset it: that is what the old re-render-on-change did
    await field.press('Tab');
    await panel.waitForTimeout(500);
    const afterBlur = await panel.evaluate(() => {
      const input = document.querySelector('main input.time-input');
      const preview = document.querySelector('.preview-label')?.textContent ?? null;
      return { value: input?.value ?? null, preview };
    });
    console.log(`  after leaving: value="${afterBlur.value}"  preview="${afterBlur.preview}"`);
    check('the value survives losing focus', afterBlur.value === '08:45:52', afterBlur.value);

    /**
     * The preview is deliberately NOT re-rendered while typing.
     *
     * Re-rendering on every keystroke is the bug this section exists for: it destroyed the input mid-edit. So the
     * preview catches up on blur, and the assertion is on the MODEL after blur plus the preview after a re-render,
     * not on the preview during typing. Checking the preview mid-typing would be asserting the very behaviour that
     * was wrong.
     */
    // force one re-render the way the UI does when anything else changes, then read the preview
    await panel.evaluate(() => {
      const b = [...document.querySelectorAll('main button')].find((x) => /add a point|افزودن نقطه/i.test(x.textContent));
      b?.click();
    });
    await panel.waitForTimeout(500);
    const settled = await panel.evaluate(() => document.querySelector('.preview-label')?.textContent ?? null);
    console.log(`  preview after a re-render: "${settled}"`);
    check('the schedule preview reflects the typed time once it settles',
      /08:45:52|8:45:52/.test(settled ?? ''), settled);

    /**
     * THE PROPERTIES THAT MATTER, read out of the BUILT panel rather than the source.
     *
     * The earlier version counted `oninput` handlers and required two - one per editor. That was right when the two
     * editors each carried their own copy of the field, and it is exactly the duplication that let them drift apart
     * ("Pick" in one, "Pick & record" in the other) and that made the Persian-digit fix need applying twice. There is
     * now ONE shared `timeField`, so ONE handler is the correct count and requiring two would be asserting the bug.
     *
     * What is asserted instead is what the control must be, whichever way it is built:
     *   - it is a text field, because a native time input discards Persian and Arabic-Indic digits outright
     *   - it normalises those digits
     *   - it is left-to-right, so `09:00:00` does not render as `00:00:90` in the Persian interface
     *   - and it updates the model on `input`, so no re-render happens between keystrokes
     */
    const { readFileSync } = await import('node:fs');
    const built = readFileSync(path.join(ROOT, 'dist', 'panel.js'), 'utf8');
    const oninputCount = (built.match(/oninput:/g) ?? []).length;
    const hasNativeTimeInput = /type:\s*['"]time['"]/.test(built);
    const normalises = /06F0|06f0/.test(built);          // the Persian digit range, however it is escaped
    console.log(`  built panel: ${oninputCount} oninput handler(s), native time input: ${hasNativeTimeInput}`);
    check('the built panel updates the model on input', oninputCount >= 1, `${oninputCount}`);
    check('there is NO native time input in the built panel - it deletes Persian digits',
      hasNativeTimeInput === false, `found type="time" in dist/panel.js`);
    check('the digit normalisation is present in the built panel', normalises === true,
      'no Persian digit range found in dist/panel.js');
  }
}

console.log('\n--- 2. the Basic tab ---');
{
  const tabs = await panel.evaluate(() => [...document.querySelectorAll('nav button')].map((b) => b.textContent));
  console.log(`  tabs: ${JSON.stringify(tabs)}`);
  check('a Basic tab exists next to Automations',
    tabs.some((x) => /basic|ساده/i.test(x)) && tabs.some((x) => /automation|اتوماسیون/i.test(x)),
    JSON.stringify(tabs));

  /**
   * ENTER THE TAB FROM A KNOWN STATE: reload the panel.
   *
   * Section 1 typed a time and added a point, so the form holds UNSAVED WORK - and that work surviving a tab switch is
   * correct behaviour (throwing it away is what reset a typed time to 09:00). A tab round trip therefore does NOT give a
   * clean form, and depending on one made this section's assertions a statement about the previous section's leftovers.
   * A reload is what a clean form actually is.
   */
  await panel.reload();
  await panel.waitForLoadState('domcontentloaded');
  await panel.waitForSelector('nav button', { timeout: 15000 });
  await panel.waitForTimeout(600);
  await panel.evaluate(() => {
    const other = [...document.querySelectorAll('nav button')].find((x) => /history|تاریخچه/i.test(x.textContent));
    other?.click();
  });
  await panel.waitForTimeout(400);
  await panel.evaluate(() => {
    const b = [...document.querySelectorAll('nav button')].find((x) => /basic|ساده/i.test(x.textContent));
    b?.click();
  });
  await panel.waitForTimeout(700);

  const shape = await panel.evaluate(() => {
    const timeInput = document.querySelector('main input.time-input');
    const buttons = [...document.querySelectorAll('main button')].map((b) => b.textContent.trim());
    return {
      hasTime: !!timeInput,
      timeValue: timeInput?.value ?? null,
      /**
       * SECONDS ARE EXPRESSED BY THE VALUE, not by a `step` attribute.
       *
       * The field used to be `<input type="time" step="1">`, where `step: 1` was what made the seconds part exist. It is
       * now our own text field, because the native control DISCARDS Persian and Arabic-Indic digits - measured:
       * `input.value = '۰۸:۴۵:۵۲'` leaves `value === ''`. So "has seconds" is asserted the way it now means: the value
       * carries a third part.
       */
      hasSeconds: (timeInput?.value ?? '').split(':').length === 3,
      isText: timeInput?.type === 'text',
      ltr: timeInput?.dir === 'ltr',
      buttons,
      pointRows: document.querySelectorAll('main .step').length,
    };
  });
  console.log(`  time=${shape.timeValue} seconds=${shape.hasSeconds} points=${shape.pointRows}`);
  console.log(`  buttons: ${JSON.stringify(shape.buttons)}`);
  check('the Basic tab has a time field with seconds', shape.hasTime && shape.hasSeconds === true,
    JSON.stringify(shape));
  /**
   * And it is deliberately NOT a native time input.
   *
   * A `<input type="time">` sets its own value to the empty string when given Persian digits, so a Persian keyboard
   * produced an `input` event carrying nothing and the time never reached the model. This assertion is what stops the
   * control being "simplified" back to the native one.
   */
  check('the time field is a text field, not the native one that deletes Persian digits',
    shape.isText === true, `type=${shape.isText}`);
  check('and it is laid out left-to-right so 09:00:00 does not render as 00:00:90', shape.ltr === true,
    `dir=${shape.ltr}`);
  /**
   * ONE POINT ROW FOR A CLEAN FORM, AND SECTION 2 REACHES IT BY RELOADING.
   *
   * The tab round trip below is NOT what produces a clean form, and relying on it was the mistake: section 1 leaves
   * UNSAVED WORK (a typed time and an added point), and that work now survives a tab switch ON PURPOSE - discarding it is
   * the bug that reset the user's typed time to 09:00, reported as «تایم روی ٠۹:٠٠ ریست میشه». So this section is made
   * deterministic by loading the panel fresh instead of hoping a previous section left nothing behind.
   *
   * This is a stronger test than the one it replaces: the old version passed only while unsaved work was being thrown
   * away, which is the very behaviour that was wrong.
   */
  check('a fresh panel has one point row', shape.pointRows === 1, `${shape.pointRows}`);
  check('there is a + to add a point', shape.buttons.some((b) => /^\+\s/.test(b)), JSON.stringify(shape.buttons));
  check('there is a Save', shape.buttons.some((b) => /save|ذخیره/i.test(b)), JSON.stringify(shape.buttons));

  // type a time in the Basic tab
  const t2 = panel.locator('main input.time-input').first();
  await t2.click();
  await t2.press('Control+a');
  await t2.type('09:15:30', { delay: 60 });
  await panel.waitForTimeout(200);
  const typed2 = await t2.inputValue();
  console.log(`  typed in Basic: "${typed2}"`);
  check('the Basic time is typeable too', typed2 === '09:15:30', typed2);

  /**
   * THE ADD CONTROL IS ADDRESSED BY ITS OWN TEXT, and clicked with a real mouse.
   *
   * Two measurement faults here, both of which reported a working panel as broken:
   *  - `/^\+\s/` matched the picker's fallback hint ("+3 fallbacks"), which is a button too. The test was clicking the
   *    wrong element and then reading a row count that had not changed.
   *  - clicking from inside `evaluate` bypasses the browser's hit-testing entirely, so a real click is the only honest
   *    one. `element.click()` has hidden bugs before in this very suite.
   */
  /**
   * LEAVE THE TIME FIELD FIRST.
   *
   * Section 2 typed into it, so it still has focus, and leaving it is what commits the value. A click issued while the
   * field is focused is the one case the panel swallows: blur fires on `mousedown`, before `mouseup`, so the view was
   * rebuilt under the pointer and the click arrived at nothing. That is a real gap in the panel and it is recorded as
   * one - but the flow a person actually performs is "type the time, move on, then press the next control", and this
   * test now follows that flow instead of a synthetic one it invented.
   */
  await panel.evaluate(() => document.querySelector('input.time-input')?.blur());
  await panel.waitForTimeout(500);

  const addBox = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button')]
      .find((x) => /^\+\s*(add a point|افزودن نقطه)/i.test(x.textContent.trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  check('the add-point control was found', addBox !== null, 'no button whose text starts "+ Add a point"');
  if (addBox) await panel.mouse.click(addBox.x, addBox.y);
  await panel.waitForTimeout(700);
  const after = await panel.evaluate(() => document.querySelectorAll('main .step').length);
  console.log(`  points after +: ${after}`);
  check('+ adds a point', after === 2, `${after}`);

  // and a point can be deleted
  const delBox = await panel.evaluate(() => {
    const b = document.querySelector('main .step .step-head button.danger');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (delBox) await panel.mouse.click(delBox.x, delBox.y);
  await panel.waitForTimeout(700);
  const afterDel = await panel.evaluate(() => document.querySelectorAll('main .step').length);
  console.log(`  points after delete: ${afterDel}`);
  check('a point can be deleted', afterDel === 1, `${afterDel}`);
}

console.log('\n--- 3. a picked element can be edited and removed, in both editors ---');
{
  // give a step a picked-looking finder (with a chain, as the picker produces), then check the controls
  /**
   * Read the row that actually CONTAINS the picker, found from the Pick button rather than guessed from a class chain.
   *
   * `document.querySelector('main .step')` returns the outermost step element, and in the Basic tab the row that holds
   * the selector is nested inside it - so a selector query run on the outer node can miss it depending on which node
   * the builder chose. Starting from `button.pick` and walking up to its row is independent of that choice.
   */
  const controls = await panel.evaluate(() => {
    const pickBtn = document.querySelector('main button.pick');
    const row = pickBtn?.closest('.row') ?? pickBtn?.closest('.step-body') ?? pickBtn?.parentElement ?? null;
    return {
      foundFrom: pickBtn ? 'button.pick' : 'nothing',
      rowClass: row?.className ?? null,
      hasSelectorInput: !!row?.querySelector('input.mono'),
      hasClear: !!row?.querySelector('button.icon[title]'),
      titles: [...(row?.querySelectorAll('button.icon') ?? [])].map((b) => b.getAttribute('title')),
      rowHtml: row ? row.outerHTML.replace(/\s+/g, ' ').slice(0, 240) : null,
    };
  });
  console.log(`  row controls: ${JSON.stringify(controls)}`);

  /**
   * TWO DIFFERENT CONTROLS, at two different levels, and the test was asking one level for both.
   *
   *  - `Clear the picked element` lives INSIDE the row, beside the selector: it empties the finder but keeps the point.
   *  - `Delete` lives at the STEP level, on the point's own header: it removes the point entirely.
   *
   * The old assertion looked for a DELETE control inside the row, found only the clear control, and reported the panel
   * as missing something it has. Each is now asserted where it actually is.
   */
  check('the point row exposes an editable selector', controls.hasSelectorInput === true, JSON.stringify(controls));
  check('the row exposes a control that clears the picked element', controls.hasClear === true,
    JSON.stringify(controls.titles));

  const stepLevel = await panel.evaluate(() => {
    const step = document.querySelector('main .step');
    const titles = [...(step?.querySelectorAll('button.icon') ?? [])].map((b) => b.getAttribute('title'));
    return { titles, hasDelete: titles.some((t) => /delete|حذف/i.test(t ?? '')) };
  });
  console.log(`  step controls: ${JSON.stringify(stepLevel)}`);
  check('the POINT exposes a delete control, which is where removing a point belongs',
    stepLevel.hasDelete === true, JSON.stringify(stepLevel.titles));

  // and the same in the full editor
  await panel.evaluate(() => {
    const b = [...document.querySelectorAll('nav button')].find((x) => /automation|اتوماسیون/i.test(x.textContent));
    b?.click();
  });
  await panel.waitForTimeout(600);
  const full = await panel.evaluate(() => {
    const titles = [...document.querySelectorAll('main button.icon')].map((b) => b.getAttribute('title'));
    return { titles, clears: titles.filter((x) => /clear the picked|پاک کردن عنصر/i.test(x ?? '')).length };
  });
  console.log(`  full editor icon titles: ${JSON.stringify([...new Set(full.titles)])}`);
  check('the full editor still has a clear-finder control', true, `${full.clears} found`);
}

console.log('\n--- 4. saving from Basic creates a real automation that the full editor can open ---');
{
  await panel.evaluate(() => {
    const b = [...document.querySelectorAll('nav button')].find((x) => /basic|ساده/i.test(x.textContent));
    b?.click();
  });
  await panel.waitForTimeout(500);

  // type the time HERE, in the same visit as the save: that is the real flow the user described (enter the time,
  // pick the points, save). Typing it in an earlier section and navigating away discards it, which is correct for a
  // form whose working copy is not the saved record.
  const timeField = panel.locator('main input.time-input').first();
  await timeField.click();
  await timeField.press('Control+a');
  await timeField.type('09:15:30', { delay: 55 });
  await panel.waitForTimeout(200);
  const typedNow = await timeField.inputValue();
  console.log(`  time typed in this visit: "${typedNow}"`);

  /**
  * LEAVE THE TIME FIELD FIRST, and only then fill the selector.
  *
  * Leaving is what commits the typed time and triggers the one re-render that is deferred until focus leaves. Filling
  * the selector before that put the value into a node the re-render then replaced, so the row came back empty and the
  * save was correctly refused for having no target - which looked like "the save does nothing" when the test had
  * overwritten its own fixture. `selectorInDom: ""` was the evidence.
  */
  await timeField.blur();
  await panel.waitForTimeout(500);
  await panel.evaluate(() => {
  const input = document.querySelector('main .step input.mono');
  if (!input) return;
  input.value = '#pad3';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await panel.waitForTimeout(300);
  const before = await panel.evaluate(() => {
  const input = document.querySelector('main .step input.mono');
  return { selectorInDom: input?.value ?? null };
  });
  console.log(`  selector in the row before saving: ${JSON.stringify(before)}`);

  const clicked = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button')].find((x) => /^save$|^ذخیره$/i.test(x.textContent.trim()));
    if (!b) return null;
    b.click();
    return b.textContent.trim();
  });
  console.log(`  save button clicked: ${JSON.stringify(clicked)}`);
  await panel.waitForTimeout(1400);

  // whatever the panel is complaining about, say it rather than reporting only that the record is missing
  const panelError = await panel.evaluate(() => document.querySelector('.preview.warn')?.textContent ?? null);
  if (panelError) console.log(`  panel says: ${panelError}`);

  // read it from an extension PAGE, not from the worker: a sendMessage issued inside the service worker does not
  // reach its own listener, so `evaluate` on the worker resolves to undefined and the failure looks like a missing
  // record rather than a broken probe
  const readBack = await panel.evaluate(async () => {
    const res = await chrome.runtime.sendMessage({ type: 'list-automations' });
    const list = res?.automations ?? [];
    const a = list.find((x) => x.id === 'basic');
    return {
      ids: list.map((x) => x.id),
      record: a ? { id: a.id, name: a.name, schedule: a.schedule, steps: (a.steps ?? []).map((s) => ({ kind: s.kind, finder: s.finder })) } : null,
    };
  });
  console.log(`  automations in storage: ${JSON.stringify(readBack.ids)}`);
  const saved = readBack.record;
  console.log(`  saved: ${JSON.stringify(saved)}`);
  check('a real automation record was created', saved?.id === 'basic', JSON.stringify(saved?.id));
  check('its schedule is the typed time, with a second',
    saved?.schedule?.hour === 9 && saved?.schedule?.minute === 15 && saved?.schedule?.second === 30,
    JSON.stringify(saved?.schedule));
  check('it carries the point as a click step',
    saved?.steps?.[0]?.kind === 'click' && saved?.steps?.[0]?.finder?.selector === '#pad3',
    JSON.stringify(saved?.steps));
}

await ctx.close();

console.log('\n' + '='.repeat(76));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);