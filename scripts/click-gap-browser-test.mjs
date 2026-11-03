#!/usr/bin/env node
/**
 * THE CLICK GAP, measured in a real browser with real clicks.
 *
 * The unit tests prove the arithmetic against a virtual clock. This proves the thing the user asked for: three picks on ONE
 * time, with a 20 ms gap, actually land 20 ms apart - and that a different time keeps firing them together.
 *
 * The page records `performance.now()` at the moment each button receives its click, so the interval reported is the
 * interval the page observed, not one the extension claims.
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';
import { assertFreshBuild } from './lib/fresh-build.mjs';

installProfileSweep();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

// Refuse to measure a bundle that predates its source. MEASURED three times: a stale dist/ made a fix look broken twice and
// hid a real bug once. See scripts/lib/fresh-build.mjs.
assertFreshBuild(ROOT);

const findings = [];
const record = (sev, title, detail) => {
  findings.push({ sev, title, detail });
  console.log(`  ${sev === 'OK' ? 'ok  ' : sev === 'INFO' ? '--- ' : sev === 'HIGH' ? 'HIGH' : 'MED '} ${title}${detail ? `\n        ${String(detail).slice(0, 300)}` : ''}`);
};

/** Three buttons that record the exact instant each one is clicked. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>gap</title>
<style>button{position:absolute;width:180px;height:44px} #b1{top:60px;left:40px} #b2{top:120px;left:40px} #b3{top:180px;left:40px}</style>
<button id="b1">one</button><button id="b2">two</button><button id="b3">three</button>
<script>
window.HITS = [];
for (const id of ['b1','b2','b3']) {
  document.getElementById(id).addEventListener('click', () => {
    window.HITS.push({ id, t: performance.now() });
  });
}
</script>`;
const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-gap-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 950 },
});
let [sw] = ctx.serviceWorkers();
for (let i = 0; i < 20 && !sw; i += 1) { await new Promise((r) => setTimeout(r, 500)); [sw] = ctx.serviceWorkers(); }
if (!sw) { console.log('no service worker'); process.exit(1); }
const extId = new URL(sw.url()).host;

const page = await ctx.newPage();
await page.goto(pageUrl);
const panel = await ctx.newPage();
const panelErrors = [];
panel.on('pageerror', (e) => panelErrors.push(e.message.slice(0, 200)));
await panel.goto(`chrome-extension://${extId}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForFunction(() => document.querySelectorAll('nav.tabs button').length > 0, { timeout: 25000 });
await panel.evaluate(() => [...document.querySelectorAll('nav.tabs button')].find((b) => /Basic|پایه/.test(b.textContent))?.click());
await panel.waitForFunction(() => document.querySelector('input.time-input') !== null, { timeout: 15000 });

const clickText = async (re) => {
  const at = await panel.evaluate((p) => {
    const b = [...document.querySelectorAll('main button')].find((x) => new RegExp(p, 'i').test(x.textContent));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, re);
  if (!at) return false;
  await panel.mouse.click(at.x, at.y);
  await panel.waitForTimeout(750);
  return true;
};

const pickBtn = async (id) => {
  const pb = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button.pick')].filter((x) => x.offsetParent).pop();
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!pb) return false;
  await panel.mouse.click(pb.x, pb.y);
  await panel.waitForTimeout(600);
  await page.bringToFront();
  const t = await page.evaluate((sel) => {
    const el = document.getElementById(sel);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await page.mouse.click(t.x, t.y);
  await panel.waitForTimeout(1500);
  await panel.bringToFront();
  await panel.waitForTimeout(400);
  return true;
};

const records = () => sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return (all.automations ?? []).map((a) => ({
    id: a.id,
    time: `${a.schedule?.hour}:${String(a.schedule?.minute ?? 0).padStart(2, '0')}:${String(a.schedule?.second ?? 0).padStart(2, '0')}:${String(a.schedule?.ms ?? 0).padStart(3, '0')}`,
    steps: (a.steps ?? []).length,
    gap: a.options?.clickGapMs ?? null,
    urls: a.urls ?? [],
  }));
});

const runIt = async (id) => {
  await page.evaluate(() => { window.HITS = []; });
  await page.bringToFront();
  await page.waitForTimeout(300);
  const res = await panel.evaluate(async (aid) => {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'start-run', automationId: aid });
      return JSON.parse(JSON.stringify(r ?? null));
    } catch (e) { return { error: String(e?.message ?? e) }; }
  }, id);
  await page.waitForTimeout(3000);
  const hits = await page.evaluate(() => window.HITS);
  return { res, hits };
};

console.log('================ SETUP: three picks on the first time ================');
for (const b of ['b1', 'b2', 'b3']) {
  await clickText('^\\+\\s*Add a point');
  const ok = await pickBtn(b);
  console.log(`  picked ${b}:`, ok);
}
await panel.waitForTimeout(2200);
let rec = await records();
console.log('  records:', JSON.stringify(rec));
const base = rec.find((r) => r.steps === 3) ?? rec[0];
if (!base) { console.log('no record with three picks'); process.exit(1); }

// a page to resolve against is required for a run to click at all
const pattern = `${pageUrl}*`;
await sw.evaluate(async ({ id, pattern }) => {
  const all = await chrome.storage.local.get(null);
  const list = all.automations ?? [];
  const a = list.find((x) => x.id === id);
  if (a) { a.urls = [pattern]; await chrome.storage.local.set({ automations: list }); }
}, { id: base.id, pattern });

console.log('\n================ 1. GAP 0 — the picks fire together ================');
{
  const { res, hits } = await runIt(base.id);
  const at = hits.map((h) => h.t);
  const gaps = at.slice(1).map((t, i) => Math.round(t - at[i]));
  console.log('  hits:', JSON.stringify(hits.map((h) => h.id)), '| gaps(ms):', JSON.stringify(gaps));
  console.log('  run:', res?.run?.reason ?? JSON.stringify(res).slice(0, 120));
  record(hits.length === 3 ? 'OK' : 'MED', 'all three picks fired', `${hits.length} hits`);
  record(gaps.every((g) => Math.abs(g) < 12) ? 'OK' : 'MED',
    'with no gap they land together', `gaps ${JSON.stringify(gaps)} — a real click costs a millisecond or two, which is not the gap`);
}

console.log('\n================ 2. SET THE GAP TO 20 ms THROUGH THE UI ================');
{
  // open the ⚙ for this time and type 20
  /**
   * THE GEAR IS BESIDE THE TIME FIELD, not on the chip.
   *
   * MEASURED while building this feature: the chip row is hidden when there is only one time - a chooser with one choice is
   * noise, and two existing tests assert it - so a gear that lived only on the chip was unreachable in the common case. The
   * mark now sits on the field the user is editing, which is the selected time.
   */
  const opened = await panel.evaluate((id) => {
    const gear = document.querySelector('.time-with-save .time-settings');
    if (gear) {
      const r = gear.getBoundingClientRect();
      return { ok: true, where: 'beside the time field', x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    const chip = [...document.querySelectorAll('.event-chip')].find((c) => c.dataset.eventId === id);
    if (!chip) {
      // report what IS there, so a missing chip is distinguishable from a renamed class or an unrendered section
      // search the WHOLE document, not just `main`: the chip row may be rendered outside it, and looking only inside `main`
      // reported "chip not found" while the element existed elsewhere
      return {
        ok: false,
        why: 'chip not found',
        chipsAnywhere: [...document.querySelectorAll('.event-chip')].map((c) => c.dataset.eventId),
        settingsAnywhere: document.querySelectorAll('.event-chip-settings').length,
        pickersAnywhere: document.querySelectorAll('.event-picker').length,
        inMain: { chips: document.querySelectorAll('main .event-chip').length, pickers: document.querySelectorAll('main .event-picker').length },
        mainHasTimesLabel: /Times|زمان‌ها/.test(document.querySelector('main')?.innerText ?? ''),
        timesLabelAnywhere: [...document.querySelectorAll('label')].map((l) => l.textContent?.slice(0, 20)),
      };
    }
    const chipGear = chip.querySelector('.event-chip-settings');
    if (!chipGear) return { ok: false, why: 'no gear on the chip and none beside the field' };
    const r = chipGear.getBoundingClientRect();
    return { ok: true, where: 'chip', x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, base.id);
  console.log('  ⚙ located:', JSON.stringify(opened));
  record(opened.ok ? 'OK' : 'HIGH', 'every time has a small settings affordance', JSON.stringify(opened));
  if (opened.ok) {
    await panel.mouse.click(opened.x, opened.y);
    await panel.waitForTimeout(700);
    const field = await panel.evaluate(() => {
      const f = document.querySelector('input.gap-input');
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, value: f.value };
    });
    console.log('  gap field:', JSON.stringify(field));
    record(field ? 'OK' : 'HIGH', 'the settings row opens with the gap field', JSON.stringify(field));
    if (field) {
      await panel.mouse.click(field.x, field.y);
      await panel.waitForTimeout(200);
      await panel.keyboard.press('Control+a');
      await panel.keyboard.type('20');
      await panel.keyboard.press('Enter');
      await panel.waitForTimeout(2200);
      const after = await records();
      console.log('  records after setting:', JSON.stringify(after));
      const target = after.find((r) => r.id === base.id);
      record(target?.gap === 20 ? 'OK' : 'HIGH', 'the gap was saved on THAT time', `clickGapMs=${target?.gap}`);
      const others = after.filter((r) => r.id !== base.id);
      record(others.every((r) => (r.gap ?? 0) === 0) ? 'OK' : 'HIGH',
        'and no other time was touched', JSON.stringify(others.map((r) => `${r.id}=${r.gap}`)));
    }
  }
}

console.log('\n================ 3. GAP 20 — the picks are 20 ms apart ================');
{
  const { res, hits } = await runIt(base.id);
  const at = hits.map((h) => h.t);
  const gaps = at.slice(1).map((t, i) => Math.round(t - at[i]));
  console.log('  hits:', JSON.stringify(hits.map((h) => h.id)), '| gaps(ms):', JSON.stringify(gaps));
  console.log('  run:', res?.run?.reason ?? JSON.stringify(res).slice(0, 120));
  record(hits.length === 3 ? 'OK' : 'MED', 'all three still fired with a gap set', `${hits.length} hits`);
  /**
   * THE MEASUREMENT IS THE WHOLE POINT. A browser cannot promise a millisecond, so the assertion allows a small window
   * around 20 ms - but it must be clearly not zero and clearly not the sum-with-click-duration (which would be ~22+ and
   * grow). The printed gaps are the evidence.
   */
  /**
   * THE GAP IS A FLOOR, so the measured interval is the gap PLUS the click's own round trip (a few milliseconds). The window
   * is therefore asymmetric: it must not be below the gap, and a page whose round trip is slow legitimately lands above it.
   * MEASURED at 20 ms: 24/24 ms in two consecutive runs, with the engine's own trace agreeing.
   */
  const near20 = gaps.length === 2 && gaps.every((g) => g >= 19 && g <= 34);
  record(near20 ? 'OK' : 'HIGH', 'the picks land about 20 ms apart', `gaps ${JSON.stringify(gaps)}`);
}

console.log('\n================ 4. A SECOND TIME IS UNAFFECTED ================');
{
  await clickText('^\\+\\s*New time');
  await panel.waitForTimeout(600);
  for (const b of ['b1', 'b2']) {
    await clickText('^\\+\\s*Add a point');
    await pickBtn(b);
  }
  await panel.waitForTimeout(2200);
  const all = await records();
  console.log('  records:', JSON.stringify(all));
  const second = all.find((r) => r.id !== base.id && r.steps >= 2);
  record(second ? 'OK' : 'MED', 'a second time exists with its own picks', JSON.stringify(second));
  if (second) {
    record((second.gap ?? 0) === 0 ? 'OK' : 'HIGH',
      'the second time has NO gap, because it was never set on it', `clickGapMs=${second.gap}`);
    await sw.evaluate(async ({ id, pattern }) => {
      const all2 = await chrome.storage.local.get(null);
      const list = all2.automations ?? [];
      const a = list.find((x) => x.id === id);
      if (a) { a.urls = [pattern]; await chrome.storage.local.set({ automations: list }); }
    }, { id: second.id, pattern });
    const { hits } = await runIt(second.id);
    const at = hits.map((h) => h.t);
    const gaps = at.slice(1).map((t, i) => Math.round(t - at[i]));
    console.log('  second time hits:', JSON.stringify(hits.map((h) => h.id)), '| gaps(ms):', JSON.stringify(gaps));
    record(gaps.every((g) => Math.abs(g) < 12) ? 'OK' : 'HIGH',
      'the second time still fires its picks TOGETHER - the gap did not leak', `gaps ${JSON.stringify(gaps)}`);
  }
}

console.log('\n' + '='.repeat(78));
const high = findings.filter((f) => f.sev === 'HIGH');
const med = findings.filter((f) => f.sev === 'MED');
console.log(`${findings.filter((f) => f.sev === 'OK').length} ok · ${med.length} medium · ${high.length} HIGH · ${findings.filter((f) => f.sev === 'INFO').length} info`);
for (const f of [...high, ...med]) console.log(`  ${f.sev}: ${f.title} — ${f.detail}`);
console.log('\npanel errors:', JSON.stringify([...new Set(panelErrors)]));
server.close();
await ctx.close();
process.exit(high.length ? 1 : 0);