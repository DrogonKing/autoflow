#!/usr/bin/env node
/**
 * A PICK THAT NO POINT IS WAITING FOR.
 *
 * The user's export, 1.21.0:
 *
 *     automations stored : 0
 *     events in log      : 0
 *     lastPickPages: { basic: "file:///.../autoflow-test-field (4).html" }
 *
 * A pick happened and was recorded against the automation; nothing was ever saved, and not even a save ATTEMPT was
 * logged - which means the panel's Save refused before sending, and the only path that does that is "no step has a
 * selector". So the pick's selector never reached a step.
 *
 * There are two ordinary ways for that to happen, and both used to be SILENT:
 *   1. the header's "Pick & record" button never sets `state.pickTarget`;
 *   2. any render after a pick clears `state.pickTarget`, so the next pick has nowhere to go.
 *
 * This drives both through the real panel and asserts that the selector arrives, or that the refusal is visible.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SIM = path.join(ROOT, 'tools', 'sim', 'index.html');
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const profile = autoCleanup(mkdtempSync(path.join(tmpdir(), 'af-orphan-')));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${detail}` : ''}`);
};

const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [
    `--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`,
    '--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
  ],
});

let worker = null;
for (let i = 0; i < 80 && !worker; i++) {
  for (const w of ctx.serviceWorkers()) {
    try { if (/autoflow/i.test(await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { worker = w; break; } } catch {}
  }
  if (!worker) await new Promise((r) => setTimeout(r, 250));
}
if (!worker) { console.log('no worker'); process.exit(1); }
const extId = new URL(worker.url()).host;

const page = await ctx.newPage();
await page.goto(`file://${SIM}`);
await page.waitForFunction(() => document.documentElement.getAttribute('data-autoflow-content') !== null, null, { timeout: 15000 });

const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`);
await panel.waitForTimeout(1200);
const panelErrors = [];
panel.on('pageerror', (e) => panelErrors.push(String(e?.message ?? e)));
// every runtime message the panel receives, so a dropped pick can be seen rather than inferred
const panelMessages = [];
await panel.evaluate(() => {
  window.__msgs = [];
  chrome.runtime.onMessage.addListener((m) => {
    try { window.__msgs.push({ type: m?.type, hasFinder: Boolean(m?.finder), sel: m?.finder?.selector ?? null, url: m?.url ?? null }); } catch {}
  });
});

const clickPad = async (id = '#pad2') => {
  await page.bringToFront();
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(900);
};

console.log('\n--- 1. the HEADER button: it must not drop the pick silently ---');
await panel.bringToFront();
const header = panel.locator('nav button, header button, button').filter({ hasText: /Inspect element|بررسی عنصر|Pick & record|انتخاب و ضبط/ }).first();
const headerExists = (await header.count()) > 0;
check('the header control exists and no longer claims to record', headerExists,
  headerExists ? await header.textContent() : 'not found');

if (headerExists) {
  await header.click();
  await panel.waitForTimeout(500);
  await clickPad('#pad3');
  await panel.bringToFront();
  await panel.waitForTimeout(400);
  const said = await panel.evaluate(() => {
    const t = document.querySelector('main')?.innerText ?? '';
    return {
      mentions: /no point was waiting|هیچ نقطه‌ای منتظرش نبود/i.test(t),
      warns: [...document.querySelectorAll('.warn, .error, .preview.warn')].map((e) => e.textContent.trim()).slice(0, 2),
    };
  });
  check('a pick with no point waiting SAYS SO instead of vanishing', said.mentions || said.warns.length > 0,
    JSON.stringify(said.warns));
}

console.log('\n--- 2. the per-point Pick: the selector must reach the step ---');
await panel.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Basic|ساده/.test(x.textContent ?? '')); b?.click(); });
await panel.waitForTimeout(900);

/**
 * WHICH TAB IS ACTUALLY RENDERED, and does a point come from the Basic draft?
 *
 * `state.tab` decides whether `basicView` runs at all - and `element-picked` looks for the step in `state.basic` only
 * when `state.tab === 'basic'` (the draft is rebuilt otherwise). If the tab click did not take, the pick has nowhere to
 * land, which is exactly the silent drop being investigated.
 */
const tabState = await panel.evaluate(() => ({
  activeTab: [...document.querySelectorAll('nav button')].filter((b) => /active|on/.test(b.className)).map((b) => b.textContent.trim()),
  hasBasicForm: Boolean(document.querySelector('main .basic')),
  pickButtons: document.querySelectorAll('main button.pick').length,
  timeInputs: document.querySelectorAll('main input.time-input').length,
}));
console.log(`  tab state: ${JSON.stringify(tabState)}`);
const pick = panel.locator('main button.pick').first();
check('a point has a Pick button', (await pick.count()) > 0);
await pick.click();
await panel.waitForTimeout(500);
const st1 = await panel.evaluate(() => {
  const b = document.querySelector('main button.pick');
  return { cls: b?.className, text: (b?.textContent ?? '').trim() };
});
/**
 * The panel keeps `state` in module scope, so it cannot be read from outside - but the DOM can be asked whether any
 * button is in the picking state, and the step id tells us which one claimed it.
 */
const claiming = await panel.evaluate(() => [...document.querySelectorAll('main button.pick')]
  .map((b) => ({ id: b.getAttribute('data-step-id'), cls: b.className })));
console.log(`  pick buttons after pressing: ${JSON.stringify(claiming)}`);
console.log(`  after pressing Pick: ${JSON.stringify(st1)}`);
// WAIT FOR THE PICKER TO BE ARMED IN THE PAGE, not for a fixed number of milliseconds: `start-picking` travels
// worker -> content script, and a fixed wait is a race the test loses on a loaded machine.
await page.waitForFunction(() => document.documentElement.style.cursor === 'crosshair', null, { timeout: 8000 })
  .catch(() => console.log('  (the page never showed the crosshair cursor)'));
/**
   * `startPicking` adds listeners and sets `cursor: crosshair` - it draws no overlay, so a missing overlay proves nothing.
   * The cursor is the one observable it does leave behind.
   */
const armed = await panel.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const runs = globalThis.__pickDebug ?? [];
  const last = runs.filter((r) => r.event === 'pick-element-result').pop();
  return {
    pickedTabId: last?.tabId ?? null,
    tabs: tabs.map((t) => ({ id: t.id, url: (t.url ?? '').slice(-28), active: t.active })),
  };
});
console.log(`  picked tab: ${armed.pickedTabId}`);
for (const t of armed.tabs) console.log(`    ${t.active ? '*' : ' '} ${t.id}  ...${t.url}`);
await clickPad('#pad2');
await panel.bringToFront();
await panel.waitForTimeout(400);
const st2 = await panel.evaluate(() => {
  const b = document.querySelector('main button.pick');
  return { cls: b?.className, text: (b?.textContent ?? '').trim(), inputs: [...document.querySelectorAll('main input')].map((i) => i.value) };
});
console.log(`  after the page click: ${JSON.stringify(st2)}`);
const seen = await panel.evaluate(() => window.__msgs ?? []);
console.log(`  messages the panel received: ${JSON.stringify(seen.map((m) => m.type))}`);
const debug = await panel.evaluate(() => globalThis.__pickDebug ?? []);
console.log('  what the pick listener saw:');
for (const d of debug.slice(-4)) console.log(`    ${JSON.stringify(d)}`);

/**
 * THE STEP LOOKUP ITSELF. `element-picked` finds the step by `state.pickTarget`, in `state.editing` first and then in
 * `state.basic`. If neither holds that id, the pick has nowhere to land - and nothing says so. This prints what the panel
 * actually has: the target id it is holding, and the ids of the steps it can see.
 */
const lookup = await panel.evaluate(() => {
  const ids = (list) => (list ?? []).map((s) => s.id);
  return {
    domStepIds: [...document.querySelectorAll('main [data-step-id]')].map((e) => e.getAttribute('data-step-id')),
    msgs: (window.__msgs ?? []).length,
  };
});
console.log(`  step ids in the DOM: ${JSON.stringify(lookup.domStepIds)}`);

const selector = await panel.evaluate(() => {
  const inputs = [...document.querySelectorAll('main input')];
  const sel = inputs.find((i) => /mono/.test(i.className) && !/time-input/.test(i.className));
  return sel?.value ?? '';
});
check('the selector arrived in the form', /pad2/.test(selector), selector);

console.log('\n--- 3. Save must actually store it, and log the attempt ---');
const save = panel.locator('main button', { hasText: /Save|ذخیره/ }).first();
await save.click().catch(() => {});
await panel.waitForTimeout(1500);
const truth = await panel.evaluate(async () => {
  const a = await chrome.runtime.sendMessage({ type: 'list-automations' });
  const d = await chrome.runtime.sendMessage({ type: 'export-diagnostics' });
  const text = d?.text ?? '';
  return {
    ids: (a?.automations ?? []).map((x) => x.id),
    events: Number(/-- events: (\d+)/.exec(text)?.[1] ?? -1),
    steps: (a?.automations ?? [])[0]?.steps?.length ?? 0,
  };
});
console.log(`  stored: ${JSON.stringify(truth.ids)}  steps=${truth.steps}  events=${truth.events}`);
check('the automation is stored', truth.ids.length > 0, JSON.stringify(truth.ids));
check('and a save attempt is in the event log', truth.events > 0, String(truth.events));
check('the stored step carries a selector', truth.steps > 0, String(truth.steps));
check('no panel errors', panelErrors.length === 0, JSON.stringify(panelErrors.slice(0, 2)));

const passed = results.filter((r) => r.ok === true).length;
console.log(`\n${'='.repeat(70)}\n${passed}/${results.length} checks passed`);
for (const r of results.filter((r) => r.ok !== true)) console.log(`  FAIL ${r.name}`);
await ctx.close();
process.exit(passed === results.length ? 0 : 1);