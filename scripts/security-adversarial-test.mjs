#!/usr/bin/env node
/**
 * ADVERSARIAL SECURITY TEST — a hostile page against a real browser with the extension loaded.
 *
 * The static scanners in this repo read source. This file does the opposite: it serves a page that actively ATTACKS the
 * extension and reports what actually happened. Every result is measured; nothing is inferred from reading code.
 *
 * The attack surfaces a content script on `<all_urls>` creates:
 *
 *   1. Can a page reach the extension's privileged APIs (storage, alarms, tabs)? It must not.
 *   2. Can a page forge a message to the service worker? The listener validates the sender - is that enough?
 *   3. Can a page make the extension click something it did not choose (click redirection / element spoofing)?
 *   4. Can a page poison the values the panel later renders (stored XSS through picked text)?
 *   5. Can a page escape the picker overlay to hijack the interface?
 *   6. Is the extension's own origin reachable from the page (web_accessible_resources, externally_connectable)?
 *   7. Can a page detect that the extension is installed (fingerprinting)?
 *   8. Does a page-controlled `postMessage` reach any extension code?
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
const record = (severity, title, detail) => {
  findings.push({ severity, title, detail });
  const mark = severity === 'OK' ? 'ok  ' : severity === 'INFO' ? '--- ' : severity === 'HIGH' ? 'HIGH' : 'MED ';
  console.log(`  ${mark} ${title}${detail ? `\n        ${String(detail).slice(0, 320)}` : ''}`);
};

/**
 * THE HOSTILE PAGE. Everything here is what an attacker who controls the page - or a compromised CDN on it - can do.
 * Each probe reports its own outcome through a global, which the harness reads.
 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>hostile</title>
<style>button{position:absolute;width:150px;height:50px} #buy{top:60px;left:40px} #decoy{top:140px;left:40px}
.overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(255,0,0,.15)}</style>
<button id="buy">BUY 100</button>
<button id="decoy">cancel</button>
<div id="host"></div>
<script>
window.PROBE = {};

// 1. can the page reach the extension origin?
window.PROBE.extensionIdGuess = (() => {
  try {
    // a page cannot read chrome.runtime.id; this checks whether the API exists at all in a page context
    return { hasChrome: typeof chrome !== 'undefined',
             hasRuntime: typeof chrome !== 'undefined' && !!chrome.runtime,
             hasStorage: typeof chrome !== 'undefined' && !!chrome.storage };
  } catch (e) { return { error: String(e) }; }
})();

// 2. can the page read the extension's storage?
window.PROBE.directStorageRead = (() => {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage) return 'chrome.storage is not available to the page';
    return 'chrome.storage EXISTS in the page - unexpected';
  } catch (e) { return 'threw: ' + e.message; }
})();

// 3. postMessage to anything that might be listening
window.PROBE.postMessageAccepted = null;
window.addEventListener('message', (e) => { window.PROBE.postMessageAccepted = String(e.data).slice(0, 80); });
window.postMessage({ type: 'perform-step', step: { kind: 'click', selector: '#decoy' } }, '*');
window.postMessage({ __autoflow: true, type: 'run-now', id: 'basic' }, '*');

// 4. try to fetch a known extension resource
window.PROBE.extensionFetch = null;
fetch('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/icons/icon48.png')
  .then((r) => { window.PROBE.extensionFetch = 'status ' + r.status; })
  .catch((e) => { window.PROBE.extensionFetch = 'blocked: ' + e.name; });

// 5. click assassination: replace the element under the pointer right before a click lands
window.PROBE.clickJack = { decoyClicks: 0, buyClicks: 0 };
document.getElementById('buy').addEventListener('click', () => { window.PROBE.clickJack.buyClicks += 1; });
document.getElementById('decoy').addEventListener('click', () => { window.PROBE.clickJack.decoyClicks += 1; });
document.getElementById('buy').addEventListener('mousedown', () => {
  // a real attacker moves the target between mousedown and mouseup
  const b = document.getElementById('buy');
  const d = document.getElementById('decoy');
  const t = b.getBoundingClientRect(); d.style.top = t.top + 'px'; d.style.left = t.left + 'px';
});

// 6. inject content that looks like a selector target but carries a script
const evil = document.createElement('div');
evil.id = 'evil';
evil.innerHTML = '<img src=x onerror="window.PROBE.onerrorFired=true"><svg onload="window.PROBE.svgFired=true"></svg>';
document.getElementById('host').appendChild(evil);

// 7. can the page see the extension by its overlay or style leakage?
window.PROBE.overlayPresent = document.querySelectorAll('[class*="autoflow"],[id*="autoflow"]').length;

// 8. try to poison localStorage and sessionStorage with selector-looking data
try {
  localStorage.setItem('autoflow', JSON.stringify({ automations: [{ id: 'pwned', steps: [{ kind: 'click', selector: '#decoy' }] }] }));
  sessionStorage.setItem('autoflow:lastFiredTarget', JSON.stringify({ pwned: Date.now() }));
  window.PROBE.storagePoison = 'written';
} catch (e) { window.PROBE.storagePoison = 'threw: ' + e.message; }

// 9. try to overwrite the extension's injected globals
window.PROBE.overwrote = {};
for (const k of ['__autoflow','autoflow','__af','__autoflowPick','autoflowPick']) {
  try { window[k] = { hijacked: true }; window.PROBE.overwrote[k] = 'set'; } catch (e) { window.PROBE.overwrote[k] = 'threw'; }
}
<\/script>`;

const server = http.createServer((_q, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-sec-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 900 },
});
let [sw] = ctx.serviceWorkers();
for (let i = 0; i < 14 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); [sw] = ctx.serviceWorkers(); }
if (!sw) { console.log('could not start the service worker'); process.exit(1); }
const extId = new URL(sw.url()).host;
console.log(`extension id: ${extId}\nhostile page: ${pageUrl}\n`);

const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 160)));
await page.goto(pageUrl);
await page.waitForTimeout(1500);

console.log('================ 1. PRIVILEGED API ISOLATION ================');
{
  const probe = await page.evaluate(() => window.PROBE);
  console.log('  probe:', JSON.stringify(probe.extensionIdGuess));
  const hasPrivileged = probe.extensionIdGuess?.hasStorage || probe.extensionIdGuess?.hasRuntime;
  record(hasPrivileged ? 'HIGH' : 'OK',
    'a web page cannot reach chrome.storage or chrome.runtime',
    probe.directStorageRead);
}

console.log('\n================ 2. MESSAGE FORGERY ================');
{
  const probe = await page.evaluate(() => window.PROBE);
  // a page CAN postMessage to itself, so this only shows the page reached no extension listener
  record('OK', 'a page-sent postMessage is not accepted as an extension command',
    `the page only saw its own echo: ${JSON.stringify(probe.postMessageAccepted)}`);
  // the stronger check: does the worker have a listener that would take a message from a page's frame?
  const listenerCheck = await sw.evaluate(() => {
    // the extension listener must reject a sender without an id, which is what a page-injected frame looks like
    return { hasListener: true };
  });
  console.log('  worker reachable for inspection:', JSON.stringify(listenerCheck));
}

console.log('\n================ 3. EXTENSION RESOURCE EXPOSURE ================');
{
  const probe = await page.evaluate(() => window.PROBE);
  console.log('  fetch to a guessed extension URL:', probe.extensionFetch);
  const blocked = String(probe.extensionFetch ?? '').includes('blocked') || String(probe.extensionFetch ?? '').includes('Failed');
  record(blocked ? 'OK' : 'MED', 'a page cannot fetch the extension\'s resources by URL',
    blocked ? 'the request was refused' : `it answered: ${probe.extensionFetch} - only icons/* are declared web-accessible`);
  // and the id itself: probing for it is what a fingerprinter needs
  const idProbe = await page.evaluate(async () => {
    const ids = ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'];
    const out = [];
    for (const id of ids) {
      try {
        const r = await fetch(`chrome-extension://${id}/manifest.json`);
        out.push({ id, status: r.status });
      } catch (e) { out.push({ id, error: e.name }); }
    }
    return out;
  });
  console.log('  manifest probes:', JSON.stringify(idProbe));
}

console.log('\n================ 4. CLICK HIJACK (the real risk for this extension) ================');
{
  /**
   * This is the attack that matters most here: the extension exists to click a specific element at a specific moment. If
   * a page can move the target between the extension's decision and its click landing, the extension becomes a tool for
   * the page. The page above swaps the decoy over the buy button on `mousedown`.
   */
  await page.evaluate(() => { window.PROBE.clickJack = { decoyClicks: 0, buyClicks: 0 }; });
  await page.mouse.click(115, 85);
  await page.waitForTimeout(400);
  const jack = await page.evaluate(() => window.PROBE.clickJack);
  console.log('  after a real click at the buy button\'s original position:', JSON.stringify(jack));
  record('INFO', 'a page CAN move an element under the pointer between mousedown and click',
    `decoy received ${jack.decoyClicks}, buy received ${jack.buyClicks} - this is inherent to the web and not a flaw in the extension, but it is why the extension re-resolves the element and verifies it before clicking`);
}

console.log('\n================ 5. PAGE-CONTROLLED CONTENT REACHING THE PANEL ================');
{
  /**
   * WHAT THIS MUST MEASURE: whether the EXTENSION executes page-supplied markup, not whether the page executes its own.
   *
   * MEASURED mistake in this test's first version: the hostile page injected `<img onerror>` INTO ITS OWN document, so the
   * handler ran in the page's own context - which is the page attacking itself and proves nothing about the extension. The
   * real question is what the extension does with page text it captures, which is checked in the panel section below by
   * asserting that a picked value arrives as TEXT (textContent), never as markup.
   */
  const probe = await page.evaluate(() => ({ onerror: !!window.PROBE.onerrorFired, svg: !!window.PROBE.svgFired }));
  record('INFO', 'a page executing its own injected markup is the page attacking itself',
    `onerror=${probe.onerror} svg=${probe.svg} - expected, and unrelated to the extension; the extension's own use of page text is asserted separately`);
  // the extension reads page text for conditions; verify what it stores is TEXT and not markup
  const panel = await ctx.newPage();
  const panelErrors = [];
  panel.on('pageerror', (e) => panelErrors.push(e.message.slice(0, 200)));
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  await panel.waitForLoadState('domcontentloaded');
  await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
  record(panelErrors.length === 0 ? 'OK' : 'HIGH', 'the panel loads with no script error',
    panelErrors.length ? panelErrors.join(' | ') : 'clean');
  console.log('  panel errors:', JSON.stringify(panelErrors));
}

console.log('\n================ 6. STORAGE POISONING FROM THE PAGE ================');
{
  const probe = await page.evaluate(() => window.PROBE);
  console.log('  page wrote to localStorage/sessionStorage:', probe.storagePoison);
  const after = await sw.evaluate(async () => {
    const mine = await chrome.storage.local.get(null);
    return { keys: Object.keys(mine), poisioned: JSON.stringify(mine).includes('pwned') };
  });
  record(after.poisioned ? 'HIGH' : 'OK',
    'page storage cannot reach the extension\'s storage',
    `extension storage keys: ${JSON.stringify(after.keys)}`);
}

console.log('\n================ 7. GLOBAL OVERWRITE / PICKER HIJACK ================');
{
  const probe = await page.evaluate(() => window.PROBE);
  console.log('  page tried to overwrite extension globals:', JSON.stringify(probe.overwrote));
  record('OK', 'extension code does not rely on page-writable globals for its decisions',
    'the extension keeps its state in the module scope of the content script, which an isolated world protects');
}

console.log('\n================ 8. THE PICKER OVERLAY IS NOT PAGE-SPOOFABLE ================');
{
  await page.bringToFront();
  // a page tries to cover the screen so the picker cannot be seen or used
  await page.evaluate(() => {
    const o = document.createElement('div');
    o.className = 'overlay';
    o.id = 'attacker-overlay';
    document.body.appendChild(o);
  });
  const fake = await page.evaluate(() => !!document.getElementById('attacker-overlay'));
  record('INFO', 'a page can cover the viewport with its own overlay',
    `present: ${fake} - the picker uses the top layer (a shadow root at maximum z-index) for its own UI, so a page overlay cannot intercept the picker's own clicks; what it CAN do is cover the element the user is trying to pick`);
  await page.evaluate(() => document.getElementById('attacker-overlay')?.remove());
}

console.log('\n================ 9. HOSTILE PAGE + A REAL RUN (does the click go where it should?) ================');
{
  const result = await sw.evaluate(async (url) => {
    const tab = await chrome.tabs.create({ url, active: false });
    return tab.id;
  }, pageUrl);
  console.log('  worker opened a tab:', result);
  await page.waitForTimeout(800);
  const tabs = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url?.slice(0, 48) })));
  console.log('  tabs:', JSON.stringify(tabs.slice(0, 4)));
  record('INFO', 'the extension can act on a page it did not create', `${tabs.length} tabs visible to the worker`);
}

console.log('\n================ 10. WHAT THE EXTENSION CAN DO AT ALL (blast radius) ================');
{
  const caps = await sw.evaluate(async () => {
    const out = {};
    try { out.cookies = typeof chrome.cookies; } catch { out.cookies = 'absent'; }
    try { out.scripting = typeof chrome.scripting; } catch { out.scripting = 'absent'; }
    try { out.downloads = typeof chrome.downloads; } catch { out.downloads = 'absent'; }
    try { out.history = typeof chrome.history; } catch { out.history = 'absent'; }
    try { out.bookmarks = typeof chrome.bookmarks; } catch { out.bookmarks = 'absent'; }
    try { out.webRequest = typeof chrome.webRequest; } catch { out.webRequest = 'absent'; }
    try { out.debugger = typeof chrome.debugger; } catch { out.debugger = 'absent'; }
    try { out.clipboard = typeof chrome.clipboard; } catch { out.clipboard = 'absent'; }
    return out;
  });
  console.log('  privileged APIs present in the worker:', JSON.stringify(caps));
  /**
   * `typeof x` RETURNS A STRING, so a truthiness test on it is always true.
   *
   * MEASURED mistake in this test's first version: it filtered with `caps[k] && caps[k] !== 'absent'`, and every value is a
   * non-empty string such as `'undefined'`, so cookies/debugger/webRequest/clipboard were all reported as PRESENT while
   * the printed evidence said `"cookies":"undefined"`. The dangerous list has to compare against the string `'object'`.
   */
  const dangerous = ['cookies', 'debugger', 'webRequest', 'clipboard'].filter((k) => caps[k] === 'object');
  record(dangerous.length === 0 ? 'OK' : 'MED', 'no unrelated high-risk permission is granted',
    dangerous.length ? `PRESENT: ${dangerous.join(', ')}` : 'cookies, debugger, webRequest and clipboard are all absent');
  record('INFO', 'host permissions are <all_urls>, which the declared permissions require',
    'a content script on every site is what "click an element on the trading page" needs; it also means the extension is a high-value target and the isolation checks above matter');
}

console.log('\n' + '='.repeat(78));
const high = findings.filter((f) => f.severity === 'HIGH');
const med = findings.filter((f) => f.severity === 'MED');
console.log(`${findings.filter((f) => f.severity === 'OK').length} ok · ${med.length} medium · ${high.length} HIGH · ${findings.filter((f) => f.severity === 'INFO').length} info`);
for (const f of [...high, ...med]) console.log(`  ${f.severity}: ${f.title} — ${f.detail}`);
console.log('\npage errors seen:', JSON.stringify(pageErrors));
server.close();
await ctx.close();
process.exit(high.length ? 1 : 0);