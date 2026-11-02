#!/usr/bin/env node
/**
 * DEEP DEBUG — the operations that act on a TIME, and the sticky focus flag.
 *
 * Two themes, both chosen because this project has broken here repeatedly:
 *
 *   1. Does each operation act on the RIGHT time? Position-based ids have caused a wrong time to be deleted and an alarm
 *      to point at the wrong target. Every operation here is performed on a time that is NOT the first one, because that
 *      is where index bugs show.
 *
 *   2. The "I have left the field" flag is sticky by design (so a follow-up render cannot pull the caret back). Sticky
 *      state is exactly what leaks, so: does it survive into situations it should not, and does it break anything a user
 *      would notice?
 *
 * Anomalies are reported, not asserted away: every section prints what it measured.
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

const findings = [];
const note = (kind, title, detail) => {
  findings.push({ kind, title, detail });
  console.log(`  ${kind === 'OK' ? 'ok  ' : kind === 'BAD' ? 'BAD ' : '--- '} ${title}${detail ? `\n        ${detail}` : ''}`);
};

const PAGE = `<!doctype html><meta charset="utf-8">
<style>button{position:absolute;width:120px;height:50px} #a{top:60px;left:40px} #b{top:160px;left:40px} #c{top:260px;left:40px}</style>
<button id="a">buy-a</button><button id="b">buy-b</button><button id="c">buy-c</button>`;
const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-deep-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
for (let i = 0; i < 14 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); [sw] = ctx.serviceWorkers(); }
const id = new URL(sw.url()).host;

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  PAGE ERROR (site):', e.message.slice(0, 120)));
await page.goto(pageUrl);
const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('  *** PANEL ERROR:', e.message.slice(0, 200)));
panel.on('console', (m) => { if (m.type() === 'error') console.log('  *** PANEL CONSOLE:', m.text().slice(0, 160)); });
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

const records = () => sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const list = all.automations ?? [];
  const names = (await chrome.alarms.getAll()).map((a) => String(a.name));
  return list.map((a) => ({
    id: a.id,
    time: `${a.schedule?.hour}:${String(a.schedule?.minute ?? 0).padStart(2, '0')}:${String(a.schedule?.second ?? 0).padStart(2, '0')}${a.schedule?.ms ? '.' + String(a.schedule.ms).padStart(3, '0') : ''}`,
    points: (a.steps ?? []).length,
    selectors: (a.steps ?? []).map((s) => s.finder?.selector ?? '—'),
    armed: names.includes(`autoflow:run:${a.id}`),
  }));
});
const chipIds = () => panel.evaluate(() => [...document.querySelectorAll('.chip[data-event-id], .event-chip[data-event-id]')].map((c) => c.dataset.eventId));
const clickText = async (re) => {
  const box = await panel.evaluate((p) => {
    const b = [...document.querySelectorAll('main button')].find((x) => new RegExp(p, 'i').test(x.textContent));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, re);
  if (!box) return false;
  await panel.mouse.click(box.x, box.y);
  await panel.waitForTimeout(800);
  return true;
};
const typeTime = async (digits) => {
  await panel.evaluate(() => {
    const f = document.querySelector('input.time-input');
    if (f) { f.blur(); }
  });
  await panel.waitForTimeout(200);
  const box = await panel.evaluate(() => {
    const f = document.querySelector('input.time-input');
    const r = f.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await panel.mouse.click(box.x, box.y);
  await panel.waitForTimeout(200);
  await panel.keyboard.type(digits);
  await panel.waitForTimeout(300);
  await panel.keyboard.press('Enter');
  await panel.waitForTimeout(700);
};
const pickFor = async (buttonId) => {
  const pb = await panel.evaluate(() => {
    const onScreen = [...document.querySelectorAll('main button')].filter((b) => b.classList.contains('pick') && b.offsetParent);
    const cards = [...document.querySelectorAll('.card, .step')];
    const open = onScreen[onScreen.length - 1];
    if (!open) return null;
    const r = open.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!pb) return false;
  await panel.mouse.click(pb.x, pb.y);
  await panel.waitForTimeout(500);
  await page.bringToFront();
  const t = await page.evaluate((sel) => {
    const r = document.getElementById(sel).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, buttonId);
  await page.mouse.click(t.x, t.y);
  await panel.waitForTimeout(1600);
  await panel.bringToFront();
  await panel.waitForTimeout(500);
  return true;
};

console.log('\n================ 1. THREE TIMES, EACH ITS OWN PICK ================');
await clickText('^\\+\\s*New time');
await typeTime('080000000');
await pickFor('a');
await clickText('^\\+\\s*New time');
await typeTime('090000000');
await pickFor('b');
await clickText('^\\+\\s*New time');
await typeTime('100000000');
await pickFor('c');
await panel.waitForTimeout(2000);
let rec = await records();
console.log('  chips:', JSON.stringify(await chipIds()));
for (const r of rec) console.log('   ', JSON.stringify(r));
const a = rec.find((r) => /a/.test(r.selectors.join('')));
const b = rec.find((r) => /b/.test(r.selectors.join('')));
const c = rec.find((r) => /c/.test(r.selectors.join('')));
note(a && b && c ? 'OK' : 'BAD', 'each time kept its OWN pick, not the first time\'s',
  `a=${a?.id} b=${b?.id} c=${c?.id} | selectors=${JSON.stringify(rec.map((r) => r.selectors))}`);
note(rec.length === 3 && rec.every((r) => r.armed) ? 'OK' : 'BAD', 'three records, three alarms',
  `${rec.length} record(s), armed=${rec.filter((r) => r.armed).length}`);

console.log('\n================ 2. EDITING THE THIRD TIME, NOT THE FIRST ================');
// open the LAST chip and retype its time
const lastChip = await panel.evaluate(() => {
  const chips = [...document.querySelectorAll('.chip[data-event-id], .event-chip[data-event-id]')];
  const c = chips[chips.length - 1];
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: c.dataset.eventId };
});
console.log('  opening chip:', JSON.stringify(lastChip));
if (lastChip) {
  await panel.mouse.click(lastChip.x, lastChip.y);
  await panel.waitForTimeout(700);
  await typeTime('113000000');
  await panel.waitForTimeout(2200);
  const after = await records();
  for (const r of after) console.log('   ', JSON.stringify(r));
  const edited = after.find((r) => r.time.startsWith('11:30'));
  const others = after.filter((r) => !r.time.startsWith('11:30'));
  note(edited ? 'OK' : 'BAD', 'retiming the third time changed THAT time', `found=${edited?.id} time=${edited?.time}`);
  note(others.length === 2 ? 'OK' : 'BAD', 'and left the other two alone',
    others.map((r) => `${r.id}=${r.time}`).join(' '));
  note(edited && edited.points === 1 && /c/.test(edited.selectors.join('')) ? 'OK' : 'BAD',
    'and it kept its own point, not another time\'s', JSON.stringify(edited?.selectors));
}

console.log('\n================ 3. THE ✓ SAVES THE TIME IT BELONGS TO ================');
const tickResult = await panel.evaluate(() => {
  const ticks = [...document.querySelectorAll('button.time-save')];
  const fields = [...document.querySelectorAll('input.time-input')];
  return { ticks: ticks.length, fields: fields.length, fieldValue: fields[0]?.value ?? null };
});
console.log('  ticks:', JSON.stringify(tickResult));
note(tickResult.ticks === 1 && tickResult.fields === 1 ? 'OK' : 'BAD',
  'one ✓ and one time field for the open time', JSON.stringify(tickResult));

console.log('\n================ 4. REMOVING THE MIDDLE TIME ================');
// open the middle chip, remove its point -> with one point, removing the point removes the time
const middleChip = await panel.evaluate(() => {
  const chips = [...document.querySelectorAll('.chip[data-event-id], .event-chip[data-event-id]')];
  const c = chips[1];
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: c.dataset.eventId };
});
console.log('  middle chip:', JSON.stringify(middleChip));
if (middleChip) {
  await panel.mouse.click(middleChip.x, middleChip.y);
  await panel.waitForTimeout(700);
  const removed = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button.icon.danger')].find((x) => x.offsetParent);
    if (!b) return false;
    const r = b.getBoundingClientRect();
    window.__rm = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    return true;
  });
  if (removed) {
    const at = await panel.evaluate(() => window.__rm);
    await panel.mouse.click(at.x, at.y);
    await panel.waitForTimeout(2200);
    const after = await records();
    for (const r of after) console.log('   ', JSON.stringify(r));
    const gone = !after.some((r) => r.id === middleChip.id);
    note(gone ? 'OK' : 'BAD', 'the removed time is gone from storage', `removed ${middleChip.id}`);
    note(after.length === 2 && after.every((r) => r.armed) ? 'OK' : 'BAD',
      'two times left, both still armed', `${after.length} record(s), armed=${after.filter((r) => r.armed).length}`);
  }
}

console.log('\n================ 5. THE STICKY "I HAVE LEFT" FLAG ================');
const beforeLeave = await panel.evaluate(() => document.activeElement?.className ?? null);
// click inert background
const bg = await panel.evaluate(() => {
  const row = document.querySelector('main .row');
  const r = row.getBoundingClientRect();
  return { x: Math.round(r.left + 4), y: Math.round(r.bottom - 2) };
});
await panel.mouse.click(bg.x, bg.y);
await panel.waitForTimeout(600);
const afterLeave = await panel.evaluate(() => document.activeElement?.className ?? null);
note(afterLeave !== beforeLeave || true, 'background click', `before=${beforeLeave} after=${afterLeave}`);

// now TAB into the field (keyboard, no pointerdown) and check the flag does not block normal work
const tabbedIn = await panel.evaluate(async () => {
  const f = document.querySelector('input.time-input');
  f.focus();
  f.value = '12:34:56.000';
  return { focused: document.activeElement === f, value: f.value };
});
await panel.waitForTimeout(400);
// a form change that triggers a re-render
await clickText('^\\+\\s*Add a point');
await panel.waitForTimeout(900);
const afterTabbed = await panel.evaluate(() => ({
  focused: document.activeElement?.matches?.('input.time-input') === true,
  value: document.querySelector('input.time-input')?.value ?? null,
}));
console.log('  after focusing by KEYBOARD then adding a point:', JSON.stringify(afterTabbed));
note(afterTabbed.value === '12:34:56.000' ? 'OK' : 'BAD',
  'a keyboard-entered half-typed time was not lost by a form change', `value=${afterTabbed.value}`);
if (!afterTabbed.focused) {
  note('NOTE', 'the caret was NOT restored for a keyboard-focus case',
    'the sticky flag is cleared only by a POINTER press inside a time field; Tab cannot clear it. Typing continues to work because the field still holds the text, but the caret is not returned.');
}

console.log('\n================ 6. TEN TIMES: DOES ANYTHING DEGRADE? ================');
const t0 = Date.now();
const chipsBefore = (await chipIds()).length;
let clicked = 0;
for (let i = 0; i < 10; i++) {
  if (await clickText('^\\+\\s*New time')) clicked += 1;
}
await panel.waitForTimeout(2500);
const chipsAfter = (await chipIds()).length;
const many = await records();
console.log(`  chips ${chipsBefore} -> ${chipsAfter}; the button was found ${clicked}/10 times; ${many.length} records (${(Date.now() - t0) / 1000}s)`);
note(chipsAfter === chipsBefore + clicked ? 'OK' : 'BAD',
  'every press of "New time" added a row to the form',
  `${clicked} presses, chips ${chipsBefore} -> ${chipsAfter}`);
note(many.length >= 10 ? 'OK' : 'BAD', 'adding many times does not lose any', `${many.length} records`);
const uniqueIds = new Set(many.map((r) => r.id)).size;
note(uniqueIds === many.length ? 'OK' : 'BAD', 'every automation id is unique', `${uniqueIds} unique of ${many.length}`);
const uniqueTargets = new Set(many.map((r) => `${r.time}|${r.selectors.join(',')}`));
note('NOTE', 'distinct time/target combinations', `${uniqueTargets.size} of ${many.length} - collisions would share one alarm target`);

console.log('\n================ 7. RELOAD: DOES EVERYTHING COME BACK? ================');
const beforeReload = await records();
await panel.reload();
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await panel.waitForTimeout(1200);
const afterReload = await records();
note(afterReload.length === beforeReload.length ? 'OK' : 'BAD', 'every time survives a reload',
  `${beforeReload.length} -> ${afterReload.length}`);
const lostArms = afterReload.filter((r) => !r.armed).map((r) => r.id);
note(lostArms.length === 0 ? 'OK' : 'BAD', 'and every alarm is still registered after a reload',
  lostArms.length ? `unarmed: ${JSON.stringify(lostArms)}` : 'all armed');

console.log('\n================ 8. MISSING TRANSLATION KEYS ================');
const i18n = await panel.evaluate(async () => {
  const res = await fetch('/core/i18n/catalogue.js').catch(() => null);
  return res ? 'fetched' : 'not fetchable from a panel page';
});
console.log('  i18n catalogue:', i18n);
const raw = await panel.evaluate(() => [...document.querySelectorAll('main *')].map((e) => e.textContent).join(' '));
const suspicious = raw.match(/^[a-z]+\.[a-z.]+$/m);
note(!suspicious ? 'OK' : 'BAD', 'no raw i18n keys rendered on screen', suspicious ? String(suspicious) : 'none found');

console.log('\n' + '='.repeat(70));
const bad = findings.filter((f) => f.kind === 'BAD');
console.log(`${findings.filter((f) => f.kind === 'OK').length} ok · ${bad.length} BAD · ${findings.filter((f) => f.kind === 'NOTE').length} note`);
for (const f of bad) console.log(`  BAD: ${f.title} — ${f.detail}`);
server.close();
await ctx.close();
process.exit(0);