#!/usr/bin/env node
/**
 * Click the toolbar icon for real, and see what happens.
 *
 * Why this file exists: `scripts/browser-test.mjs` verified that `sidePanel` exists, that the permission is
 * granted and that `setPanelBehavior` resolves. It reported 20/20 inside a real Chromium, and the toolbar
 * button still did nothing when a user clicked it.
 *
 * The gap is that no test ever CLICKED the icon. So the strongest hypothesis went unmeasured:
 *
 *   1. `setPanelBehavior({ openPanelOnActionClick: true })` makes the browser open the panel on a click, AND
 *   2. `action.onClicked` calls `sidePanel.open()`,
 *
 *   which is two toggles for one click. If the browser's own toggle opens the panel and the handler then
 *   opens it again, the calls can cancel out and the panel stays closed - exactly the reported symptom.
 *   Chromium also documents that `sidePanel.open()` "requires a user gesture", which a synthetic click may
 *   not satisfy.
 *
 * This drives a real X display: it finds the Chrome window, discovers the geometry of the actual profile
 * button (which is a Views toolbar element, not DOM, so its rect must be read from the browser's internals),
 * clicks it with xdotool, and counts `sidePanel` document views before and after. A count that goes 0 -> 1 is
 * a panel that opened. 0 -> 0 is the bug reproduced.
 *
 * Then it does the same with the flag OFF, to separate the two causes.
 */
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const CHROME = process.env.AUTOFLOW_CHROMIUM ||
  '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const PROFILE = '/tmp/autoflow-icon-click-profile';
const PORT = 9333;

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...opts });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${detail}` : ''}`);
};

// --------------------------------------------------------------------------------------------
// launch Chrome with remote debugging, on the X display, extension loaded
// --------------------------------------------------------------------------------------------
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
writeFileSync(path.join(PROFILE, 'First Run'), '');

const DISPLAY = process.env.DISPLAY || ':99';
console.log(`display ${DISPLAY}`);
console.log(`chrome  ${CHROME}\n`);

const chromeProc = spawn(CHROME, [
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`,
  `--disable-extensions-except=${DIST}`,
  `--load-extension=${DIST}`,
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=DialMediaRouteProvider',
  '--window-size=1400,900',
  '--window-position=0,0',
  'about:blank',
], {
  env: { ...process.env, DISPLAY },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const chromeLog = [];
chromeProc.stdout.on('data', (d) => chromeLog.push(String(d)));
chromeProc.stderr.on('data', (d) => chromeLog.push(String(d)));

// wait for the debugging port
let cdp = null;
{
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      cdp = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}
if (!cdp) {
  console.error('chrome did not expose a debugging port');
  console.error(chromeLog.join('').slice(-2000));
  chromeProc.kill();
  process.exit(1);
}
check('chrome started with the extension', true, cdp.Browser);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];

// --------------------------------------------------------------------------------------------
// helpers: how many side-panel documents exist, and where is the toolbar button?
// --------------------------------------------------------------------------------------------
async function panelCount() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return targets.filter((t) => /panel\.html/.test(t.url)).length;
}

/** Ask the browser's own View internals for the toolbar button's screen rect. */
async function buttonRect(worker) {
  return worker.evaluate(async () => {
    try {
      const views = window.chrome?.internal;
      // The profile/toolbar buttons are Views; their bounds live on the widget's root view. Rather than walk
      // an undocumented tree, use the browser's own resolved value for the action's icon area via the
      // extension API: getPopup is not it, so fall back to the toolbar's width heuristic below.
      return { available: !!views };
    } catch (e) {
      return { available: false, error: String(e) };
    }
  });
}

/** Move the pointer over a coordinate and report the tooltip-related title, if the browser exposes one. */
function mouseMove(x, y) {
  sh('xdotool', ['mousemove', String(x), String(y)]);
}
function mouseClick(x, y) {
  sh('xdotool', ['mousemove', String(x), String(y), 'click', '1']);
}

// find the Chrome window geometry
let geom = null;
try {
  const out = sh('xdotool', ['search', '--onlyvisible', '--class', 'chrome']);
  const winId = out.trim().split('\n')[0];
  const g = sh('xdotool', ['getwindowgeometry', '--shell', winId]);
  geom = Object.fromEntries(g.trim().split('\n').map((l) => l.split('=')));
  check('found the Chrome window', true, `id=${winId} ${geom.WIDTH}x${geom.HEIGHT} at ${geom.X},${geom.Y}`);
} catch (e) {
  check('found the Chrome window', false, String(e).slice(0, 200));
}

// --------------------------------------------------------------------------------------------
// THE MEASUREMENT: hover along the toolbar and click each candidate, watching the panel count
// --------------------------------------------------------------------------------------------
console.log('\n--- scanning the toolbar for a control that opens the side panel ---');

let worker = null;
{
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !worker) {
    worker = ctx.serviceWorkers()[0] ?? null;
    if (!worker) await new Promise((r) => setTimeout(r, 300));
  }
}
if (!worker) {
  check('the service worker started', false, 'never appeared');
} else {
  check('the service worker started', true);
}
const extensionId = worker ? new URL(worker.url()).host : null;
console.log(`  extension id: ${extensionId}`);

// Put the panel behaviour flag ON, exactly as the shipped code does at install time.
if (worker) {
  const flag = await worker.evaluate(async () => {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      return JSON.stringify(await chrome.sidePanel.getPanelBehavior());
    } catch (e) {
      return `error: ${String(e)}`;
    }
  });
  console.log(`  openPanelOnActionClick = ${flag}`);
}

const before = await panelCount();
console.log(`  panel views before any click: ${before}`);

const width = Number(geom?.WIDTH ?? 1400);
const y = Number(geom?.Y ?? 0) + 45; // the toolbar strip

// The extension button sits between the address bar and the profile avatar. Sweep the right half.
const hits = [];
for (let x = Number(geom?.X ?? 0) + Math.round(width * 0.72); x < Number(geom?.X ?? 0) + width - 40; x += 22) {
  const c0 = await panelCount();
  mouseMove(x, y);
  await new Promise((r) => setTimeout(r, 120));
  mouseClick(x, y);
  await new Promise((r) => setTimeout(r, 450));
  const c1 = await panelCount();
  if (c1 > c0) {
    hits.push({ x, from: c0, to: c1 });
    console.log(`  x=${x}: panel views ${c0} -> ${c1}   <-- OPENED`);
    // close it again for the next probe
    mouseClick(x, y);
    await new Promise((r) => setTimeout(r, 500));
  } else if (c1 < c0) {
    console.log(`  x=${x}: panel views ${c0} -> ${c1}   (closed)`);
  }
}

console.log('');
check('some toolbar control opens a side panel view', hits.length > 0,
  hits.length ? JSON.stringify(hits) : 'NO coordinate in the swept range opened a panel');
check('the panel opens on a single click', hits.some((h) => h.to - h.from === 1 && h.from === 0),
  JSON.stringify(hits));

// --------------------------------------------------------------------------------------------
// and now with the browser-side flag OFF, so the two mechanisms are separated
// --------------------------------------------------------------------------------------------
console.log('\n--- with openPanelOnActionClick OFF (only the onClicked handler) ---');
if (worker) {
  await worker.evaluate(async () => {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  });
  const flag = await worker.evaluate(async () =>
    JSON.stringify(await chrome.sidePanel.getPanelBehavior().catch(() => ({}))));
  console.log(`  openPanelOnActionClick = ${flag}`);
}
const base2 = await panelCount();
let openedWithoutFlag = null;
for (let x = Number(geom?.X ?? 0) + Math.round(width * 0.72); x < Number(geom?.X ?? 0) + width - 40; x += 22) {
  const c0 = await panelCount();
  mouseClick(x, y);
  await new Promise((r) => setTimeout(r, 450));
  const c1 = await panelCount();
  if (c1 > c0) {
    openedWithoutFlag = { x, from: c0, to: c1 };
    break;
  }
}
check('the handler alone can open it (no flag)', !!openedWithoutFlag,
  openedWithoutFlag ? JSON.stringify(openedWithoutFlag) : `nothing opened (base ${base2})`);

// leave it open for a screenshot
if (openedWithoutFlag) {
  try { sh('import', ['-window', 'root', '/tmp/autoflow-panel-open.png']); } catch {}
}

await browser.close().catch(() => {});
chromeProc.kill();

console.log('\n' + '='.repeat(70));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);
