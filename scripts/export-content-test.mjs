#!/usr/bin/env node
/**
 * A saved automation MUST appear in the export. If it does not, the export is lying about an empty profile — and the
 * last export showed no automations, no alarms and no events at all, which is either a wiped profile or a report that
 * cannot see what is there. Those are very different answers, so this distinguishes them.
 *
 * It saves an automation, then reads back: the raw storage, the automation list, the alarm list, and the text a person
 * actually reads in the export.
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

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-export-')));
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
const bridge = await ctx.newPage();
await bridge.goto(`chrome-extension://${extId}/options.html`);

const page = await ctx.newPage();
await page.goto(url);
await page.bringToFront();
await page.waitForFunction(() => document.documentElement.getAttribute('data-autoflow-content') !== null, null, { timeout: 20_000 });

console.log('\n--- 1. a freshly installed profile is genuinely empty, and the export says so ---');
{
  const before = await bridge.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const d = await chrome.runtime.sendMessage({ type: 'export-diagnostics' });
    return { keys: Object.keys(all), text: d?.text ?? '' };
  });
  console.log(`  storage keys at first load: ${JSON.stringify(before.keys)}`);
  /**
   * Read the SECTION, not just its heading. Asserting on the heading matched the dashes and passed for the wrong
   * reason - the same class of mistake as a regex that matches a timestamp.
   */
  const section = (text, name) => {
    const lines = text.split('\n');
    const i = lines.findIndex((l) => l.startsWith(`-- ${name}`));
    if (i < 0) return '';
    const out = [];
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('-- '); j++) out.push(lines[j]);
    return out.join('\n').trim();
  };
  const automationsBlock = section(before.text, 'automations');
  const alarmsBlock = section(before.text, 'scheduled alarms');
  console.log(`  automations section: ${JSON.stringify(automationsBlock)}`);
  console.log(`  alarms section: ${JSON.stringify(alarmsBlock)}`);
  check('a fresh profile says no automations are saved', /none saved/.test(automationsBlock), automationsBlock);
  check('and says no alarms are registered', /no alarms registered/.test(alarmsBlock), alarmsBlock);
}

console.log('\n--- 2. after saving, the automation is in storage AND in the export ---');
{
  const t = new Date(Date.now() + 30_000);
  const saved = await bridge.evaluate(async ({ hh, mm, ss, url }) => {
    const res = await chrome.runtime.sendMessage({
      type: 'save-automation',
      automation: {
        id: 'export-check', name: 'export check', enabled: true, urls: [url],
        schedule: { kind: 'daily', hour: hh, minute: mm, second: ss },
        steps: [{ id: 's1', kind: 'click', finder: { strategy: 'css', selector: '#pad1' } }],
        options: { stepDelayMs: 0 },
      },
    });
    const all = await chrome.storage.local.get(null);
    const list = await chrome.runtime.sendMessage({ type: 'list-automations' });
    const alarms = await new Promise((r) => chrome.alarms.getAll((a) => r(a ?? [])));
    const d = await chrome.runtime.sendMessage({ type: 'export-diagnostics' });
    return {
      saveResult: res,
      storageKeys: Object.keys(all),
      listed: (list?.automations ?? []).map((a) => a.id),
      alarms: alarms.map((a) => a.name),
      text: d?.text ?? '',
    };
  }, { hh: t.getHours(), mm: t.getMinutes(), ss: t.getSeconds(), url });

  console.log(`  save returned ok=${saved.saveResult?.ok}  schedule=${JSON.stringify(saved.saveResult?.schedule)}`);
  console.log(`  storage keys now: ${JSON.stringify(saved.storageKeys)}`);
  console.log(`  list-automations: ${JSON.stringify(saved.listed)}`);
  console.log(`  alarms: ${JSON.stringify(saved.alarms)}`);

  check('the save reported success', saved.saveResult?.ok === true, JSON.stringify(saved.saveResult));
  check('storage holds the automation', saved.storageKeys.includes('automations'), JSON.stringify(saved.storageKeys));
  check('the automation list includes it', (saved.listed ?? []).includes('export-check'), JSON.stringify(saved.listed));
  check('an alarm was registered', (saved.alarms ?? []).some((n) => n.includes('export-check')), JSON.stringify(saved.alarms));

  // THE POINT: the readable section must show it, or a populated profile looks empty
  const section = saved.text.split('\n');
  const aIdx = section.findIndex((l) => /^-- automations/.test(l));
  const automationsBlock = section.slice(aIdx, aIdx + 4).join('\n');
  console.log('  what a person reads:');
  console.log(automationsBlock.split('\n').map((l) => `      ${l}`).join('\n'));
  check('THE EXPORT LISTS THE AUTOMATION', /export-check|export check/.test(automationsBlock), automationsBlock);

  const alIdx = section.findIndex((l) => /^-- scheduled alarms/.test(l));
  const alarmsBlock = section.slice(alIdx, alIdx + 3).join('\n');
  check('and lists the alarm', /export-check/.test(alarmsBlock), alarmsBlock);

  check('and the arming is in the start decisions, with the target and its date',
    /armed\s+export-check\s+for \d{2}:\d{2}:\d{2}/.test(saved.text), 'no armed line with a target');
}

console.log('\n--- 3. the export states plainly when a profile has NOTHING saved ---');
{
  /**
   * The last export showed empty sections with no explanation, which reads as a mystery. Someone reading it should be
   * told the extension has no automations at all, because that is an answer rather than an absence.
   */
  const text = await bridge.evaluate(async () => {
    const d = await chrome.runtime.sendMessage({ type: 'export-diagnostics' });
    return d?.text ?? '';
  });
  console.log(`  profile section present: ${/-- profile |-- storage |nothing is saved/i.test(text)}`);
  check('the export carries a storage summary so an empty profile is obvious',
    /-- storage summary/.test(text), 'no storage summary section');
}

await ctx.close();
server.close();

console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);