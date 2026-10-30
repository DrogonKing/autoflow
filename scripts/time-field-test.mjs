#!/usr/bin/env node
/**
 * The time field in a real browser, with the keystrokes a Persian keyboard actually produces.
 *
 * The reported failures, in the user's words:
 *   "خود انتخاب ساعتم مشکل داره همه چیزش رو میشه پاک کرد یا اعداد بالاتر از استاندارد بهش داد مثل مثلا دقیقه ۱۰۰"
 *   "وقتی با کیبورد فارسی تایپ میکنم بجای اینکه مثل انگلیسی از چپ شروع کنه از راست شروع میکنه عدد گذاری"
 *   and the run itself: a typed time was never stored, so the 09:00:00 default armed for tomorrow and nothing fired.
 *
 * The clicks are real mouse clicks at element coordinates: `element.click()` inside `evaluate` bypasses the browser's
 * hit-testing and layout, which previously made a WORKING button read as broken.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const SIM = path.join(ROOT, 'tools', 'sim', 'index.html');
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 260)}` : ''}`);
};

const server = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(readFileSync(SIM)); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(path.join(os.tmpdir(), 'af-timefield-'));
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
if (!worker) { console.error('no worker'); await ctx.close(); process.exit(1); }
const extId = new URL(worker.url()).host;

const page = await ctx.newPage();
await page.goto(url);
await page.bringToFront();
await page.waitForFunction(() => document.documentElement.getAttribute('data-autoflow-content') !== null, null, { timeout: 20_000 });

const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('  [PANEL ERROR]', String(e?.stack ?? e).slice(0, 400)));
await panel.goto(`chrome-extension://${extId}/panel.html`);
await panel.waitForSelector('nav', { timeout: 20_000 });
await panel.evaluate(() => {
  const b = [...document.querySelectorAll('nav button')].find((x) => /^\s*Basic\s*$/i.test(x.textContent ?? ''));
  b?.click();
});
await panel.waitForTimeout(600);

const fieldHandle = () => panel.$('input.time-input');
const readField = () => panel.evaluate(() => {
  const i = document.querySelector('input.time-input');
  return i ? { value: i.value, dir: i.dir, caret: i.selectionStart } : null;
});
/**
 * What the panel believes the schedule is.
 *
 * TWO WRONG INSTRUMENTS BEFORE THIS ONE, and both reported a working model as broken:
 *
 *  - reading `.preview-label` directly returns the OLD text, because the preview is deliberately not re-rendered while
 *    the field has focus. Rebuilding the view under the typist is what made this control untypeable once already.
 *  - clicking "+ Add a point" DOES re-render, but that action does not set `basicKeepDraft`, so the view rebuilds from
 *    storage and throws the half-typed value away - the test was destroying the very thing it was checking.
 *
 * Leaving the field is the documented trigger (the re-render happens once, when focus leaves) and it is what a person
 * does: type a time, then move on. So the field is blurred and the preview is then read.
 */
const model = async () => {
  await panel.evaluate(() => document.querySelector('input.time-input')?.blur());
  await panel.waitForTimeout(450);
  return panel.evaluate(() => document.querySelector('.preview-label')?.textContent?.trim() ?? null);
};
/** The element that carries the REASON a time was refused, addressed by its own class. */
const hint = () => panel.evaluate(() => {
  const x = document.querySelector('main .time-hint');
  if (!x) return null;
  return { text: (x.textContent ?? '').trim(), warn: x.className.includes('warn') };
});
const clearField = async () => {
  await panel.evaluate(() => {
    const i = document.querySelector('input.time-input');
    i.focus();
    i.setSelectionRange(0, i.value.length);
  });
  await panel.keyboard.press('Backspace');
  await panel.waitForTimeout(250);
};
const typeInto = async (text) => {
  await panel.evaluate(() => document.querySelector('input.time-input').focus());
  await panel.keyboard.insertText(text);
  await panel.waitForTimeout(400);
};

console.log('\n--- 1. the field is ours, not the native one ---');
{
  const f = await readField();
  console.log(`  ${JSON.stringify(f)}`);
  const attrs = await panel.evaluate(() => {
    const i = document.querySelector('input.time-input');
    const cs = getComputedStyle(i);
    return { type: i.type, dir: i.dir, bidi: cs.unicodeBidi, direction: cs.direction, textAlign: cs.textAlign };
  });
  console.log(`  computed: ${JSON.stringify(attrs)}`);
  check('a time field exists', f !== null, 'not found');
  check('it is a text field', attrs.type === 'text', attrs.type);
  check('it is left-to-right', attrs.direction === 'ltr', attrs.direction);
  check('AND its editing direction is pinned, which is the "starts from the right" report',
    attrs.bidi === 'plaintext' || attrs.bidi === 'isolate', `unicode-bidi=${attrs.bidi}`);
}

console.log('\n--- 2. THE REPORTED EXAMPLE: ۱۳۵۱۲۱ becomes ۱۳:۵۱:۲۱ ---');
{
  /**
   * "اعداد ساعت رو باید دوتا دوتا بگیره مثلا وقتی عدد ۱۳۵۱۲۱ رو میدم خودش تبدیلش کنه به ۱۳:۵۱:۲۱، برای هم فارسی هم
   * انگلیسی" - a run of digits groups itself, in either script.
   */
  for (const [label, typed, expected] of [
    ['Persian', '۱۳۵۱۲۱', '13:51:21'],
    ['Western', '135121', '13:51:21'],
    ['Arabic-Indic', '١٣٥١٢١', '13:51:21'],
  ]) {
    await clearField();
    await typeInto(typed);
    const f = await readField();
    const m = await model();
    console.log(`  ${label}: typed "${typed}" -> field "${f?.value}"  model "${m}"`);
    check(`${label} digits group into ${expected}`, f?.value === expected, `${typed} -> ${f?.value}`);
    check(`${label}: and the model takes it`, /13:51:21/.test(m ?? ''), String(m));
  }
}

console.log('\n--- 3. colons are DERIVED, so they cannot be deleted ---');
{
  /**
   * "':' نباید پاک بشه درحالی که وقتی اعداد ساعت‌ها رو پاک میکنم اونم پاک میشه" - the colon used to be stored text, so
   * removing digits around it could take it too. It is now drawn from whatever digits remain, so every intermediate
   * value is the digits plus their own separators - there is no state holding a stray colon or a missing one.
   */
  await clearField();
  await typeInto('۱۳۵۱');
  const full = await readField();
  console.log(`  after typing ۱۳۵۱: "${full?.value}"`);
  check('four digits group as 13:51', full?.value === '13:51', String(full?.value));

  // delete twice with real key presses and watch the structure stay consistent
  const seen = [];
  for (let i = 0; i < 4; i++) {
    await panel.keyboard.press('Backspace');
    await panel.waitForTimeout(220);
    const v = (await readField())?.value ?? '';
    seen.push(v);
  }
  console.log(`  backspace sequence: ${JSON.stringify(seen)}`);
  check('every intermediate value is the digits plus their derived separators',
    seen.every((v) => v === v.replace(/[^0-9:]/g, '') && !/:$/.test(v) && !/^:/.test(v)),
    JSON.stringify(seen));
  check('the colon disappears only when the digits it separated are gone',
    seen.includes('13:5') || seen.includes('135'), JSON.stringify(seen));
  check('and it never survives alone', !seen.some((v) => /^:+$/.test(v)), JSON.stringify(seen));
}

console.log('\n--- 4. the model follows every keystroke, including before it is complete ---');
{
  await clearField();
  await typeInto('۱۳');
  const f = await readField();
  const m = await model();
  console.log(`  two digits: field="${f?.value}"  model="${m}"`);
  check('two digits are a whole hour', f?.value === '13', String(f?.value));
  check('and the model reads it as 13:00, not as incomplete', /13:00/.test(m ?? ''), String(m));
}

console.log('\n--- 5. what must NOT be accepted ---');
{
  await clearField();
  await typeInto('۲۵');
  const h = await hint();
  const m = await model();
  console.log(`  hour 25: hint=${JSON.stringify(h)}  model="${m}"`);
  check('an impossible hour is refused', !/25/.test(m ?? ''), String(m));
  check('AND a reason is shown next to the field', h !== null && h.warn === true, JSON.stringify(h));

  await clearField();
  await typeInto('۱۳۹۹');
  const h2 = await hint();
  console.log(`  minute 99: hint=${JSON.stringify(h2)}`);
  check('an impossible minute is refused with a reason', h2 !== null && h2.warn === true, JSON.stringify(h2));

  await clearField();
  await typeInto('۱۳۵۱۹۹');
  const h3 = await hint();
  console.log(`  second 99: hint=${JSON.stringify(h3)}`);
  check('an impossible second is refused with a reason', h3 !== null && h3.warn === true, JSON.stringify(h3));
}

console.log('\n--- 6. clearing the field must NOT schedule midnight ---');
{
  await clearField();
  const f = await readField();
  const h = await hint();
  const m = await model();
  console.log(`  empty field: field="${f?.value}"  hint=${JSON.stringify(h)}  model="${m}"`);
  check('an empty field is empty', f?.value === '', String(f?.value));
  check('AND it does not become 00:00', !/00:00/.test(m ?? ''), String(m));
  check('AND it says the time is not usable yet', h !== null, JSON.stringify(h));
}

console.log('\n--- 7. the caret follows the typing, left to right ---');
{
  /**
   * "when I type with the Persian keyboard it starts from the right instead of like English". Typed character by
   * character, because that is when the caret moves - assigning the value would not exercise it at all.
   */
  await clearField();
  await panel.evaluate(() => document.querySelector('input.time-input').focus());
  await panel.keyboard.insertText('۱۴');
  await panel.waitForTimeout(200);
  const afterHour = await readField();
  console.log(`  after '۱۴': value="${afterHour?.value}" caret=${afterHour?.caret}`);
  check('the caret is at the END after typing two digits, not at position 0',
    (afterHour?.caret ?? 0) >= (afterHour?.value ?? '').length, JSON.stringify(afterHour));

  await panel.keyboard.insertText('\u066B');
  await panel.keyboard.insertText('۳۰');
  await panel.waitForTimeout(300);
  const afterAll = await readField();
  console.log(`  after the separator and '۳۰': value="${afterAll?.value}" caret=${afterAll?.caret}`);
  check('the caret is still at the end after the whole time',
    (afterAll?.caret ?? 0) === (afterAll?.value ?? '').length, JSON.stringify(afterAll));
  check('and the value is a proper time', /14:30/.test(afterAll?.value ?? ''), String(afterAll?.value));
}

console.log('\n--- 8. a valid nearest time survives a save, which is the actual complaint ---');
{
  /**
   * The end-to-end property: type a time a couple of seconds ahead, save, and the model must hold it - not the 09:00
   * default. Asserted against what is STORED, because a panel that shows the right time while storing the old one is
   * exactly the reported situation.
   */
  await clearField();
  const soon = new Date(Date.now() + 45_000);
  const hh = String(soon.getHours()).padStart(2, '0');
  const mm = String(soon.getMinutes()).padStart(2, '0');
  const ss = String(soon.getSeconds()).padStart(2, '0');
  await typeInto(`${hh}:${mm}:${ss}`);
  const f = await readField();
  console.log(`  typed "${hh}:${mm}:${ss}" -> field "${f?.value}"`);

  /**
   * THE ORDER MATTERS: blur FIRST, then the selector.
   *
   * Leaving the time field is what commits the typed value and triggers the re-render. Filling the selector before that
   * put a value in a DOM node the re-render then replaced, so the row came back empty and the save was refused for
   * having no target - reported here as "the save did nothing" when the test had simply overwritten its own fixture.
   */
  await model();
  await panel.evaluate(() => {
    const i = [...document.querySelectorAll('main .step input.mono')][0];
    if (!i) return;
    i.value = '#pad1';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await panel.waitForTimeout(300);
  const ready = await panel.evaluate(() => [...document.querySelectorAll('main .step input.mono')].map((i) => i.value));
  console.log(`  selector in the row before saving: ${JSON.stringify(ready)}`);

  const saveBox = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button')].find((x) => /^\s*(save|ذخیره)/i.test(x.textContent ?? ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (saveBox) await panel.mouse.click(saveBox.x, saveBox.y);
  await panel.waitForTimeout(900);

  // WHAT THE SAVE ITSELF SAID, and what the tab looks like now: a save that is REFUSED is the panel telling us why,
  // and that message is the only thing that distinguishes "refused" from "silently lost".
  const afterSave = await panel.evaluate(() => ({
    body: (document.body.innerText ?? '').replace(/\n+/g, ' | ').slice(0, 500),
    button: (() => {
      const b = [...document.querySelectorAll('main button')].find((x) => /save|saved|ذخیره/i.test(x.textContent ?? ''));
      return b ? { text: b.textContent.trim(), cls: b.className, title: b.getAttribute('title') ?? '' } : null;
    })(),
    selectorInRow: [...document.querySelectorAll('.step input.mono')].map((i) => i.value),
    warn: [...document.querySelectorAll('.warn')].map((x) => (x.textContent ?? '').trim()).filter(Boolean).slice(0, 3),
  }));
  console.log(`  after save: button=${JSON.stringify(afterSave.button)}`);
  console.log(`  selector in the row: ${JSON.stringify(afterSave.selectorInRow)}`);
  console.log(`  warnings: ${JSON.stringify(afterSave.warn)}`);

  /**
   * Read through the extension's OWN message API, from the panel page.
   *
   * Two wrong attempts before this one, and both were about the reading rather than the saving: guessing at a storage
   * key returned nothing, and evaluating `chrome.storage.local.get(null)` inside the service worker returned `{}` -
   * the worker's Playwright context does not see the extension's storage partition. `list-automations` is the call the
   * panel itself makes, so it cannot disagree with what the panel shows.
   */
  const listed = await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'list-automations' })
    .then((r) => ({ ok: r?.ok, ids: (r?.automations ?? []).map((a) => a.id), all: r?.automations ?? [] }))
    .catch((e) => ({ ok: false, error: String(e?.message ?? e) })));
  console.log(`  list-automations -> ok=${listed.ok} ids=${JSON.stringify(listed.ids)}`);
  const storedBasic = (listed.all ?? []).find((a) => a.id === 'basic') ?? null;
  console.log(`  stored: ${JSON.stringify(storedBasic?.schedule)}`);
  check('the typed time is what got STORED, not the 09:00 default',
    Number(storedBasic?.schedule?.hour) === Number(hh) && Number(storedBasic?.schedule?.minute) === Number(mm),
    JSON.stringify(storedBasic));
  check('and it kept the seconds, so the schedule is precise',
    Number(storedBasic?.schedule?.second) === Number(ss), JSON.stringify(storedBasic?.schedule));
}

await ctx.close();
server.close();

console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);
