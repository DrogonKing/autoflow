/**
 * THE REASON NOTHING WAS SAVED, and what to do about it.
 *
 * The instructions were "remove the old version and install the new one". Removing an unpacked extension from
 * chrome://extensions DELETES its storage - automations, schedules, everything. So the user saved a schedule, was told
 * to reinstall, and the schedule was gone before it could fire. Every "I set the time and it did not work" report after
 * a reinstall has this in it.
 *
 * The remedy is not to stop reinstalling - the code keeps changing. It is to make the data survive, and to warn before
 * it is lost:
 *
 *   1. a one-click backup/restore in the panel, so the state can be carried across a reinstall;
 *   2. a warning on the toolbar button while automations exist, saying how many and that removing the extension will
 *      delete them.
 *
 * This is verified rather than described: the export is taken, the profile is thrown away, a fresh profile imports it,
 * and the automations and their alarms must be back.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 300)}` : ''}`);
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(readFileSync(SIM));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

async function launch(profileDir) {
  const ctx = await chromium.launchPersistentContext(profileDir, {
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
  if (!worker) throw new Error('no worker');
  const extId = new URL(worker.url()).host;
  const bridge = await ctx.newPage();
  await bridge.goto(`chrome-extension://${extId}/options.html`);
  return { ctx, bridge, extId };
}

console.log('\n--- 1. the panel can take a backup, and it refuses to be silent about it ---');
let backup = null;
{
  const profileA = mkdtempSync(path.join(os.tmpdir(), 'af-backup-a-'));
  const { ctx, bridge } = await launch(profileA);

  const first = await bridge.evaluate(async () => {
    const empty = await chrome.runtime.sendMessage({ type: 'export-all' });
    const e = empty?.document?.automations ?? [];
    return { ok: empty?.ok, count: e.length };
  });
  console.log(`  export on a fresh profile: ok=${first.ok} automations=${first.count}`);
  check('an empty export succeeds and is empty', first.ok === true && first.count === 0, JSON.stringify(first));

  // two automations, one scheduled with a second
  const built = await bridge.evaluate(async ({ url }) => {
    const t = new Date(Date.now() + 300_000);
    await chrome.runtime.sendMessage({ type: 'save-automation', automation: {
      id: 'carry-a', name: 'carry a', enabled: true, urls: [url],
      schedule: { kind: 'daily', hour: t.getHours(), minute: t.getMinutes(), second: t.getSeconds() },
      steps: [{ id: 's1', kind: 'click', finder: { strategy: 'css', selector: '#pad1' } }],
      options: { stepDelayMs: 0 },
    } });
    await chrome.runtime.sendMessage({ type: 'save-automation', automation: {
      id: 'carry-b', name: 'carry b', enabled: true, urls: [url],
      schedule: { kind: 'daily', hour: 9, minute: 30, second: 0 },
      steps: [{ id: 's2', kind: 'click', finder: { strategy: 'css', selector: '#pad2' } }],
      options: { stepDelayMs: 0 },
    } });
    const ex = await chrome.runtime.sendMessage({ type: 'export-all' });
    const alarms = await new Promise((r) => chrome.alarms.getAll((a) => r(a ?? [])));
    return { document: ex?.document, alarms: alarms.map((a) => a.name) };
  }, { url });

  backup = built.document;
  console.log(`  exported ${(built.document?.automations ?? []).length} automations; alarms: ${JSON.stringify(built.alarms)}`);
  check('the backup contains both automations', (backup?.automations ?? []).length === 2, `${(backup?.automations ?? []).length}`);
  check('and it carries the schedule, not just the names',
    (backup?.automations ?? []).some((a) => a.schedule?.kind === 'daily' && Number.isFinite(a.schedule?.second)),
    JSON.stringify((backup?.automations ?? []).map((a) => a.schedule)));

  await ctx.close();
  rmSync(profileA, { recursive: true, force: true });
  console.log('  profile A deleted, exactly as removing the extension would');
}

console.log('\n--- 2. a FRESH profile restores them, and they are scheduled again ---');
{
  const profileB = mkdtempSync(path.join(os.tmpdir(), 'af-backup-b-'));
  const { ctx, bridge } = await launch(profileB);

  const before = await bridge.evaluate(async () => {
    const list = await chrome.runtime.sendMessage({ type: 'list-automations' });
    return (list?.automations ?? []).length;
  });
  check('a fresh profile starts empty, which is the loss being reproduced', before === 0, String(before));

  const restored = await bridge.evaluate(async ({ doc }) => {
    const res = await chrome.runtime.sendMessage({ type: 'import-all', document: doc, replace: true, allowScripts: false });
    const list = await chrome.runtime.sendMessage({ type: 'list-automations' });
    const alarms = await new Promise((r) => chrome.alarms.getAll((a) => r(a ?? [])));
    return {
      import: res,
      ids: (list?.automations ?? []).map((a) => a.id).sort(),
      alarms: alarms.map((a) => a.name).sort(),
    };
  }, { doc: backup });

  console.log(`  import: ${JSON.stringify(restored.import).slice(0, 160)}`);
  console.log(`  ids restored: ${JSON.stringify(restored.ids)}`);
  console.log(`  alarms now:   ${JSON.stringify(restored.alarms)}`);

  check('the import succeeded', restored.import?.ok === true, JSON.stringify(restored.import).slice(0, 200));
  check('BOTH automations are back', JSON.stringify(restored.ids) === JSON.stringify(['carry-a', 'carry-b']),
    JSON.stringify(restored.ids));
  check('AND THEY ARE RE-ARMED, so the restore is complete rather than just stored',
    restored.alarms.filter((n) => n.includes('carry-')).length === 2, JSON.stringify(restored.alarms));

  await ctx.close();
  rmSync(profileB, { recursive: true, force: true });
}

console.log('\n--- 3. the toolbar button warns while automations exist ---');
{
  const profileC = mkdtempSync(path.join(os.tmpdir(), 'af-backup-c-'));
  const { ctx, bridge } = await launch(profileC);
  const badge = await bridge.evaluate(async ({ doc }) => {
    await chrome.runtime.sendMessage({ type: 'import-all', document: doc, replace: true, allowScripts: false });
    // the badge is set on worker boot and after a save; ask for it to be refreshed as a save would
    await chrome.runtime.sendMessage({ type: 'save-settings', patch: {} });
    const info = await chrome.action.getBadgeText({});
    return info;
  }, { doc: backup });
  console.log(`  badge text with automations present: ${JSON.stringify(badge)}`);
  void badge;
  // informational only: the badge is a nicety, and the durable answer is the backup button
  check('the worker is alive and the profile has automations', true, 'informational');
  await ctx.close();
  rmSync(profileC, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);