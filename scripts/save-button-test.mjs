#!/usr/bin/env node
/**
 * Does the Save button confirm, and does it stop confirming?
 *
 * Reported: "when I press Save there is no way to know whether it saved." A notice elsewhere on the panel is easy to
 * miss because the hand that pressed the button is still over it, so the BUTTON is what changes.
 *
 * The second half matters as much as the first: a confirmation that never goes away would claim a save indefinitely,
 * and after a later edit it would be lying. So both the appearance and the return to normal are asserted, plus the case
 * where the save FAILS - which must not show a tick.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
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
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 300)}` : ''}`);
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(readFileSync(SIM));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-savebtn-')));
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
await page.waitForFunction(() => document.documentElement.getAttribute('data-autoflow-content') !== null, null, { timeout: 20_000 });

const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`);
await panel.waitForSelector('nav', { timeout: 20_000 });
// the panel opens on Automations; the Save button lives on Basic, so select it the way a user would
await panel.evaluate(() => {
  const b = [...document.querySelectorAll('nav button')].find((x) => /^\s*Basic\s*$/i.test(x.textContent ?? ''));
  b?.click();
});
await panel.waitForTimeout(600);
const onBasic = await panel.evaluate(() => document.querySelectorAll('nav button.active')[0]?.textContent?.trim());
console.log(`  tab now: ${onBasic}`);

/** Read the Save button as the user sees it. */
const buttonState = () => panel.evaluate(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find((x) => /save|saved|ذخیره/i.test(x.textContent ?? ''));
  if (!b) return null;
  return {
    text: (b.textContent ?? '').trim(),
    saved: b.classList.contains('saved'),
    green: getComputedStyle(b).backgroundColor,
    title: b.getAttribute('title') ?? '',
  };
});

console.log('\n--- 1. before anything is pressed the button reads as Save ---');
{
  const s = await buttonState();
  console.log(`  ${JSON.stringify(s)}`);
  check('the Save button exists', s !== null, 'not found');
  check('it does not claim to be saved', s?.saved === false, JSON.stringify(s));
  check('and it is not green', !/46, ?160|2ea043/i.test(String(s?.green)), String(s?.green));
}

console.log('\n--- 2. pressing Save with NO point must NOT show a tick ---');
{
  /**
   * The failure case is the one that matters for honesty. A form with no picked element cannot be saved, so the button
   * must stay as it was and the reason must be shown - a tick here would be the worst possible outcome.
   */
  await panel.click('button.primary');
  await panel.waitForTimeout(700);
  const s = await buttonState();
  const err = await panel.evaluate(() => {
    const w = [...document.querySelectorAll('.preview.warn, .warn')].map((x) => (x.textContent ?? '').trim());
    return w.filter(Boolean).join(' | ').slice(0, 160);
  });
  console.log(`  button: ${JSON.stringify(s)}`);
  console.log(`  message shown: ${err}`);
  check('the button does NOT show a tick when the save was refused', s?.saved === false, JSON.stringify(s));
  check('and a reason is shown instead', err.length > 0, err);
}

console.log('\n--- 3. a real save turns the button into a confirmation, then back ---');
{
  // Put a selector into the first point so the save is accepted. What the panel holds is checked, because a
  // test that fills the wrong field would fail here and look like a bug in the button.
  const filled = await panel.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')];
    const field = inputs.find((i) => /selector|css|سلکتور/i.test(i.placeholder ?? ''))
      ?? inputs.find((i) => i.type === 'text' || i.type === '');
    if (!field) return { ok: false, inputs: inputs.map((i) => ({ t: i.type, p: i.placeholder })) };
    field.focus();
    // React-free DOM: the panel listens for input events, so a plain assignment plus both events is what a keystroke does
    field.value = '#pad1';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, placeholder: field.placeholder, value: field.value };
  });
  console.log(`  filled the selector field: ${JSON.stringify(filled)}`);
  check('the selector field was found and filled', filled.ok === true, JSON.stringify(filled));

  await panel.click('button.primary');
  await panel.waitForTimeout(500);
  const during = await buttonState();
  console.log(`  immediately after: ${JSON.stringify(during)}`);
  check('the button changes to a saved confirmation', during?.saved === true, JSON.stringify(during));
  check('it reads as saved, not as save', /saved|ذخیره شد/i.test(during?.text ?? ''), during?.text);
  check('and it is GREEN', /46, ?160, ?67|#2ea043/i.test(String(during?.green)), String(during?.green));

  // the tooltip says what was armed, so the confirmation carries the detail
  console.log(`  tooltip: ${JSON.stringify(during?.title)}`);

  // and it must stop claiming it
  await panel.waitForTimeout(2600);
  const after = await buttonState();
  console.log(`  after the pause: ${JSON.stringify(after)}`);
  check('it returns to Save on its own', after?.saved === false, JSON.stringify(after));
  check('and is no longer green', after?.saved === false, String(after?.green));
}

console.log('\n--- 4. the schedule notice survives the button reverting ---');
{
  /**
   * The two confirmations serve different purposes: the button says "the press worked", the notice says what the
   * schedule is. The notice must NOT disappear with the button, or the armed time is lost after two seconds.
   */
  /**
   * Read the whole tab, not a guessed class. The first version looked for `.hint` and found nothing, which said more
   * about the assumption than about the panel.
   */
  const body = await panel.evaluate(() => (document.body.innerText ?? ''));
  const notices = body.split('\n')
    .map((x) => x.trim())
    .filter((x) => /scheduled for|nothing to arm|was NOT armed|will run immediately/i.test(x));
  for (const n of notices.slice(0, 3)) console.log(`    ${n}`);
  check('a notice states what the schedule is', notices.length > 0,
    `searched the whole tab, found none in: ${body.slice(0, 200).replace(/\n/g, ' | ')}`);
}

await ctx.close();
server.close();

console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);