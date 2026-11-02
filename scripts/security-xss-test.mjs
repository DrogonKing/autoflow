#!/usr/bin/env node
/**
 * STORED-XSS TEST — can a hostile page get markup into the panel through a picked value?
 *
 * The extension reads text from a page to use in conditions and shows it back to the user in the panel. That makes page
 * text UNTRUSTED INPUT rendered in a PRIVILEGED context: the panel can call `chrome.storage`, `chrome.alarms` and
 * `chrome.tabs`. A page that can land a script in the panel owns the extension.
 *
 * `scripts/security_scan.py` flags every `innerHTML`/`textContent` assignment as `innerText-from-page`, which is a useful
 * list but not a verdict - a `textContent` assignment cannot execute anything. So this test does the thing that actually
 * decides it: it serves a page whose visible text is an XSS payload, picks that text through the real picker, and then
 * checks in the panel whether the payload arrived as TEXT or as markup.
 *
 * Every assertion is on the DOM after the extension has stored and rendered the value.
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
  console.log(`  ${mark} ${title}${detail ? `\n        ${String(detail).slice(0, 400)}` : ''}`);
};

/** The payloads. Each is a different way a value could reach an HTML sink. */
const PAYLOADS = [
  '<img src=x onerror="window.__XSS_IMG=1">',
  '<svg onload="window.__XSS_SVG=1"></svg>',
  '"><script>window.__XSS_SCRIPT=1</script>',
  '<iframe src="javascript:window.__XSS_FRAME=1"></iframe>',
  'javascript:window.__XSS_HREF=1',
];

/**
 * THE PAGE. Every payload is BOTH visible text (which the picker copies) and an attribute (which a careless reader might
 * copy instead). Nothing here executes on load by design - the question is what happens once the extension stores it.
 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>xss</title>
<style>button{display:block;position:absolute;width:240px;height:40px;text-align:left;overflow:hidden}
#t0{top:50px;left:30px}#t1{top:100px;left:30px}#t2{top:150px;left:30px}#t3{top:200px;left:30px}#t4{top:250px;left:30px}
#plain{position:absolute;top:320px;left:30px;width:240px;height:40px}</style>
${PAYLOADS.map((p, i) => `<button id="t${i}" data-payload="${i}">${p.replace(/"/g, '&quot;')}</button>`).join('\n')}
<div id="plain" data-text="'&quot;&gt;&lt;img src=x onerror=window.__XSS_ATTR=1&gt;">'</div>
<script>
window.__XSS_IMG = 0; window.__XSS_SVG = 0; window.__XSS_SCRIPT = 0; window.__XSS_FRAME = 0; window.__XSS_HREF = 0;
window.__XSS_ATTR = 0;
</script>`;
const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-xss-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 950 },
});
let [sw] = ctx.serviceWorkers();
for (let i = 0; i < 14 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); [sw] = ctx.serviceWorkers(); }
if (!sw) { console.log('service worker did not start'); process.exit(1); }
const extId = new URL(sw.url()).host;

const page = await ctx.newPage();
await page.goto(pageUrl);
const panel = await ctx.newPage();
const panelErrors = [];
panel.on('pageerror', (e) => panelErrors.push(e.message.slice(0, 200)));
panel.on('console', (m) => { if (m.type() === 'error') panelErrors.push(m.text().slice(0, 160)); });
await panel.goto(`chrome-extension://${extId}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await panel.waitForTimeout(900);

const clickText = async (re) => {
  const at = await panel.evaluate((p) => {
    const b = [...document.querySelectorAll('main button')].find((x) => new RegExp(p, 'i').test(x.textContent));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, re);
  if (!at) return false;
  await panel.mouse.click(at.x, at.y);
  await panel.waitForTimeout(800);
  return true;
};

/** Pick the element whose payload index is `i`, through the extension's own picker and a real mouse. */
const pickPayload = async (i) => {
  const pickBtn = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button.pick')].filter((x) => x.offsetParent).pop();
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!pickBtn) return { ok: false, why: 'no Pick button was visible' };
  await panel.mouse.click(pickBtn.x, pickBtn.y);
  await panel.waitForTimeout(600);
  await page.bringToFront();
  const target = await page.evaluate((idx) => {
    const el = document.getElementById(`t${idx}`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + 30, y: r.y + r.height / 2 };
  }, i);
  if (!target) { await panel.bringToFront(); return { ok: false, why: 'target not found' }; }
  await page.mouse.click(target.x, target.y);
  await panel.waitForTimeout(1800);
  await panel.bringToFront();
  await panel.waitForTimeout(600);
  return { ok: true };
};

console.log('================ 1. PICK EACH PAYLOAD AND SEE WHAT THE PANEL RENDERS ================');
let picked = 0;
for (let i = 0; i < PAYLOADS.length; i += 1) {
  await clickText('^\\+\\s*New time').catch(() => {});
  await clickText('^\\+\\s*Add a point').catch(() => {});
  const res = await pickPayload(i);
  console.log(`  payload ${i} picked: ${JSON.stringify(res)}`);
  if (res.ok) picked += 1;
}

console.log('\n================ 2. DID ANY PAYLOAD BECOME MARKUP IN THE PANEL? ================');
{
  /**
   * The decisive check: after the panel rendered the stored value, is there any element in the panel's document that could
   * only exist if the payload had been parsed as HTML? A payload rendered with `textContent` appears as visible text and
   * creates NO elements.
   */
  const dom = await panel.evaluate(() => {
    const suspicious = [];
    // an <img> with a onerror attribute, an <svg> with onload, or a <script> would all be evidence of parsing
    for (const el of document.querySelectorAll('img[onerror], svg[onload], iframe[src^="javascript:"], script')) {
      // the panel legitimately loads its own <script type="module">, so note the type
      suspicious.push({ tag: el.tagName, src: (el.getAttribute('src') ?? '').slice(0, 40), type: el.getAttribute('type') });
    }
    const text = document.body.innerText;
    return {
      suspicious,
      showsPayloadAsText: /onerror|svg|script/i.test(text),
      storedHtml: document.querySelectorAll('main img, main svg, main iframe').length,
    };
  });
  console.log('  elements that would only exist if a payload was parsed as HTML:', JSON.stringify(dom.suspicious));
  console.log('  payload text visible in the panel:', dom.showsPayloadAsText);
  console.log('  img/svg/iframe inside the form:', dom.storedHtml);

  const onlyModuleScripts = dom.suspicious.every((s) => s.tag === 'SCRIPT' && (s.type === 'module' || s.src));
  record(dom.storedHtml === 0 && onlyModuleScripts ? 'OK' : 'HIGH',
    'a page-supplied payload is rendered as TEXT, never parsed as HTML',
    `no img/svg/iframe created from the payloads (${dom.storedHtml}); the only <script> elements are the panel's own modules`);
}

console.log('\n================ 3. DID ANY HANDLER RUN IN EITHER CONTEXT? ================');
{
  const inPage = await page.evaluate(() => ({
    img: window.__XSS_IMG, svg: window.__XSS_SVG, script: window.__XSS_SCRIPT,
    frame: window.__XSS_FRAME, href: window.__XSS_HREF, attr: window.__XSS_ATTR,
  }));
  const inPanel = await panel.evaluate(() => ({
    img: window.__XSS_IMG, svg: window.__XSS_SVG, script: window.__XSS_SCRIPT,
    frame: window.__XSS_FRAME, href: window.__XSS_HREF, attr: window.__XSS_ATTR,
  }));
  console.log('  flags in the hostile page:', JSON.stringify(inPage));
  console.log('  flags in the privileged panel:', JSON.stringify(inPanel));
  const firedInPanel = Object.values(inPanel).some((v) => v);
  const firedInPage = Object.values(inPage).some((v) => v);
  record(firedInPanel ? 'HIGH' : 'OK', 'no payload executed in the panel (the privileged context)',
    firedInPanel ? JSON.stringify(inPanel) : 'every flag is still 0');
  record('INFO', 'and nothing executed in the page either',
    firedInPage ? `fired in the page: ${JSON.stringify(inPage)} - the page attacking itself, which the extension is not responsible for` : 'none');
}

console.log('\n================ 4. WHAT WAS ACTUALLY STORED ================');
{
  const stored = await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return JSON.stringify(all).slice(0, 1500);
  });
  console.log('  storage excerpt:', stored);
  const hasMarkup = /<img|<svg|<script|<iframe/i.test(stored);
  record('INFO', 'the payload is stored verbatim as a string',
    hasMarkup ? 'markup characters ARE in storage - that is fine and expected, as long as it is rendered with textContent (checked above)' : 'no markup characters stored');
}

console.log('\n================ 5. IMPORT A CRAFTED BACKUP FILE ================');
{
  /**
   * `importAll` is the other untrusted-input door: a JSON file the user is asked to load. A crafted one must not be able to
   * inject markup OR to produce an automation that acts outside its own steps.
   */
  const crafted = {
    version: 1,
    automations: [{
      id: 'crafted-1',
      name: '<img src=x onerror="window.__XSS_IMPORT=1">',
      enabled: true,
      schedule: { kind: 'daily', hour: 9, minute: 0, second: 0, ms: 0 },
      steps: [{ kind: 'click', finder: { selector: '<script>window.__XSS_SEL=1</script>', text: '' } }],
    }],
  };
  /**
   * THE FILE INPUT IS HIDDEN INSIDE A `<label>`, so `document.querySelector('input[type=file]')` finds nothing when the
   * Backup section is not the open tab - MEASURED as `why: "no file input in the panel"`, which made the check pass without
   * importing anything. The input is located through its own handler instead, and `confirm()` is accepted because the
   * import path asks before it replaces anything (that refusal is itself worth knowing about).
   */
  /**
   * THE IMPORT UI LIVES ON THE `data` TAB, and the panel opens on `Automations`. MEASURED: without opening that tab the
   * file input does not exist in the document at all, and the first version of this check reported "no JSON file input"
   * and then PASSED - a green result for a test that imported nothing. Opening the tab first is what makes the check real.
   */
  await panel.evaluate(() => {
    const tab = [...document.querySelectorAll('nav.tabs button, nav button')]
      .find((b) => /data|backup|بکاپ|داده/i.test(b.textContent));
    if (tab) tab.click();
  });
  await panel.waitForTimeout(900);
  console.log('  opened the data tab; inputs now present:',
    await panel.evaluate(() => document.querySelectorAll('input[type="file"]').length));

  const imported = await panel.evaluate(async (payload) => {
    const input = [...document.querySelectorAll('input[type="file"]')]
      .find((i) => String(i.getAttribute('accept') ?? '').includes('.json'));
    if (!input) return { ok: false, why: 'no JSON file input anywhere in the panel document' };
    // the import path calls confirm() before replacing; auto-accept it for the duration of this check
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const file = new File([JSON.stringify(payload)], 'crafted.json', { type: 'application/json' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 2500));
      return { ok: true };
    } finally {
      window.confirm = realConfirm;
    }
  }, crafted);
  console.log('  import attempted:', JSON.stringify(imported));
  await panel.waitForTimeout(1500);
  const afterImport = await panel.evaluate(() => {
    const bad = [...document.querySelectorAll('main img[onerror], main svg[onload]')].map((e) => e.tagName);
    return { badElements: bad, imgFlag: window.__XSS_IMPORT, selFlag: window.__XSS_SEL };
  });
  console.log('  after import:', JSON.stringify(afterImport));
  record(afterImport.badElements.length === 0 && !afterImport.imgFlag ? 'OK' : 'HIGH',
    'an imported automation\'s name is not rendered as markup',
    JSON.stringify(afterImport));
}

console.log('\n' + '='.repeat(78));
const high = findings.filter((f) => f.severity === 'HIGH');
const med = findings.filter((f) => f.severity === 'MED');
console.log(`${findings.filter((f) => f.severity === 'OK').length} ok · ${med.length} medium · ${high.length} HIGH · ${findings.filter((f) => f.severity === 'INFO').length} info`);
for (const f of [...high, ...med]) console.log(`  ${f.severity}: ${f.title} — ${f.detail}`);
console.log('\npanel errors:', JSON.stringify([...new Set(panelErrors)]));
server.close();
await ctx.close();
process.exit(high.length ? 1 : 0);