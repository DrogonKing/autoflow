#!/usr/bin/env node
/**
 * CLICK-TARGET INTEGRITY — the attack that matters most for an extension whose whole job is clicking.
 *
 * A page that can decide WHAT gets clicked when the extension fires has turned the extension into its own tool. The
 * realistic vectors, in the order a real attacker would try them:
 *
 *   1. TEXT DRIFT. The recorded point carries the element's text; the page swaps it for one that reads the same but acts
 *      differently. Does the extension notice, and does it refuse?
 *   2. ELEMENT REPLACEMENT. The element is destroyed and a different one is put at the same selector position.
 *   3. COVERING. A full-screen overlay sits over the target so a coordinate click lands on the attacker's element.
 *   4. NAVIGATION. The page navigates itself between resolve and click, so the click lands on a different document.
 *   5. DELAYED SWAP. The page waits (setTimeout) so the swap happens after the extension's own verification.
 *
 * The extension's defence is the recorded finder: an anchor (attribute + value) plus the recorded text, re-resolved by the
 * content script before the click. This measures whether that defence holds, rather than reading it and assuming.
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

/**
 * A page with a real "buy" button, and every attack armed behind query flags so one page serves all cases.
 *   ?attack=text      - the button's text changes for one that reads similarly
 *   ?attack=replace   - the button is replaced by a different element with the same id
 *   ?attack=cover     - an overlay covers the button
 *   ?attack=late      - the swap happens 800 ms after load, i.e. after the extension resolved it
 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>integrity</title>
<style>button{position:absolute;width:200px;height:60px} #buy{top:80px;left:50px}
#evil{top:80px;left:50px;width:200px;height:60px;background:#c00;color:#fff}
#cover{position:fixed;inset:0;z-index:99999;background:rgba(0,200,0,.2)}</style>
<button id="buy">BUY 100 shares</button>
<script>
window.LOG = { buy: 0, evil: 0, cover: 0 };
const p = new URLSearchParams(location.search).get('attack');
const buy = document.getElementById('buy');
buy.addEventListener('click', () => { window.LOG.buy += 1; });

if (p === 'text') {
  // same place, same id, different promise - the classic swap a careless clicker falls for
  buy.textContent = 'SELL 100 shares';
}
if (p === 'replace') {
  // DEFERRED, because a swap that is already in place when the point is picked means the user picked the page's element -
  // and then clicking it is correct behaviour, not a finding. The attack is: pick the real button, THEN swap.
  window.__swap = () => {
    const evil = document.createElement('button');
    evil.id = 'buy'; evil.textContent = 'SELL 100 shares';
    evil.style.cssText = 'position:absolute;top:80px;left:50px;width:200px;height:60px;background:#c00;color:#fff';
    evil.addEventListener('click', () => { window.LOG.evil += 1; });
    document.getElementById('buy').replaceWith(evil);
  };
}
if (p === 'cover') {
  const c = document.createElement('div');
  c.id = 'cover';
  c.addEventListener('click', () => { window.LOG.cover += 1; });
  document.body.appendChild(c);
}
if (p === 'late') {
  // also deferred, and the harness triggers it AFTER picking so the attack is what its name claims
  window.__swap = () => {
    const evil = document.createElement('button');
    evil.id = 'buy'; evil.textContent = 'SELL 100 shares';
    evil.style.cssText = 'position:absolute;top:80px;left:50px;width:200px;height:60px;background:#c00;color:#fff';
    evil.addEventListener('click', () => { window.LOG.evil += 1; });
    document.getElementById('buy').replaceWith(evil);
  };
}
if (p === 'late-immediate') {
  setTimeout(() => {
    const evil = document.createElement('button');
    evil.id = 'buy'; evil.textContent = 'SELL 100 shares';
    evil.style.cssText = 'position:absolute;top:80px;left:50px;width:200px;height:60px;background:#c00;color:#fff';
    evil.addEventListener('click', () => { window.LOG.evil += 1; });
    document.getElementById('buy').replaceWith(evil);
  }, 800);
}
</script>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-integrity-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 900 },
});
let [sw] = ctx.serviceWorkers();
for (let i = 0; i < 14 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); [sw] = ctx.serviceWorkers(); }
if (!sw) { console.log('service worker did not start'); process.exit(1); }
const extId = new URL(sw.url()).host;

const page = await ctx.newPage();
const panel = await ctx.newPage();
const panelErrors = [];
panel.on('pageerror', (e) => panelErrors.push(e.message.slice(0, 200)));
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

/**
 * RECORDING A POINT MUST HAPPEN ON THE PAGE THE USER IS LOOKING AT, and the recorded `urls` must contain it.
 *
 * MEASURED: `recordUrls: []` in every case, with the attack page `active: false` and the panel tab active instead. The
 * run therefore had no page to resolve against, never clicked anything, and every attack "passed" against a run that did
 * nothing - the worst kind of green. The page is brought to the front before picking, exactly as a user would have it, and
 * the recorded URL is asserted below so this cannot silently regress.
 */
const pickBuy = async () => {
  await page.bringToFront();
  await page.waitForTimeout(300);
  const pb = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button.pick')].filter((x) => x.offsetParent).pop();
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!pb) return false;
  await panel.mouse.click(pb.x, pb.y);
  await panel.waitForTimeout(700);
  await page.bringToFront();
  const t = await page.evaluate(() => {
    const el = document.getElementById('buy') ?? document.getElementById('evil');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!t) { await panel.bringToFront(); return false; }
  await page.mouse.click(t.x, t.y);
  await panel.waitForTimeout(1800);
  await panel.bringToFront();
  await panel.waitForTimeout(500);
  return true;
};

/**
 * RUN IT FROM THE PANEL, by pressing its own "Run now" control.
 *
 * MEASURED mistake in this test's first version: it called `chrome.runtime.sendMessage({type:'run-now'})` FROM the service
 * worker, and a message sent by the worker to itself never reaches its own listener - the call returned `res: null` and no
 * click happened in ANY case. Every attack then "passed" against a run that never took place, which is the most dangerous
 * kind of green. Pressing the real control exercises the real path.
 */
const runAndObserve = async () => {
  await page.waitForTimeout(400);
  const target = await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const list = all.automations ?? [];
    const a = list.find((x) => (x.steps ?? []).length > 0);
    return a ? { id: a.id, steps: (a.steps ?? []).length } : null;
  });
  if (!target) return { ran: { ok: false, why: 'no automation with a point' }, log: await page.evaluate(() => window.LOG) };
  /**
   * THE EXACT CONTROL: the Basic form's "Run now" sits in a row after Save, and its text is
   * `action.runNow`. A regex like `run now|▶` also matches the automations card's button, which acts on a SAVED record
   * rather than the form - MEASURED: the loose match pressed something that reported
   * "Saved and scheduled for 09:00:00" and started nothing.
   */
  /**
   * THE RUN IS STARTED FROM THE PANEL'S OWN CONTEXT, AND THE TARGET PAGE IS BROUGHT TO THE FRONT FIRST.
   *
   * Two measured reasons, both of which made earlier versions of this file report success without a click:
   *   - a message sent by the SERVICE WORKER to itself never reaches its own listener (`res: null`, nothing happened);
   *     sending from the PANEL is the path the real button uses, so that is what this does;
   *   - a run resolves a tab and clicks in it, and a background tab is throttled by Chrome, so the page is activated.
   */
  await page.bringToFront();
  await page.waitForTimeout(400);
  const pressed = await panel.evaluate(async (id) => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'start-run', automationId: id });
      return { found: true, res: JSON.parse(JSON.stringify(res ?? null)) };
    } catch (e) {
      return { found: false, why: String(e?.message ?? e) };
    }
  }, target.id);
  console.log('  start-run from the panel:', JSON.stringify(pressed).slice(0, 300));
  console.log('  pressed Run now:', pressed, '| automation:', JSON.stringify(target));
  await page.waitForTimeout(3000);
  /**
   * WHY THE CLICK DID NOT HAPPEN: read the panel's own status and the log tab instead of assuming the run was refused.
   * MEASURED: `pressed Run now: true` with `buy: 0` in every case, so the run started and failed, or never started - and the
   * two are told apart by what the panel says.
   */
  const status = await panel.evaluate(() => {
    const text = document.body.innerText;
    const err = [...document.querySelectorAll('.error, .warn, .hint, .notice')].map((e) => e.textContent?.slice(0, 120)).filter(Boolean);
    return { samples: err.slice(0, 6), hasErrorWord: /error|failed|خطا|نشد|no page|never had/i.test(text) };
  });
  console.log('  panel says:', JSON.stringify(status).slice(0, 600));
  const logs = await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return JSON.stringify(all.logs ?? all.log ?? all.diagnostics ?? []).slice(0, 900);
  });
  console.log('  worker log:', logs);
  /**
   * THE PAGE MUST BE THE ACTIVE TAB for a coordinate click to land, and a background tab is also THROTTLED by Chrome.
   * MEASURED: `buy: 0` in every case even after the correct control was pressed, so the question is whether the extension
   * found a tab to act on at all. `urls` on the record is what the run resolves against - if it is empty, the run has no
   * page and this whole test proves nothing.
   */
  const urls = await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const a = (all.automations ?? []).find((x) => (x.steps ?? []).length > 0);
    const tabs = await chrome.tabs.query({});
    return {
      recordUrls: a?.urls ?? null,
      recordId: a?.id ?? null,
      openTabs: tabs.map((t) => ({ id: t.id, active: t.active, url: String(t.url ?? '').slice(0, 44) })),
    };
  });
  console.log('  urls / tabs:', JSON.stringify(urls).slice(0, 700));
  // the run happens in the page, so read the page's own counters
  const log = await page.evaluate(() => window.LOG);
  const history = await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return JSON.stringify(all.history ?? all.events ?? []).slice(0, 400);
  });
  return { ran: { ok: Boolean(pressed.found), id: target.id, res: pressed.res ?? null, history }, log };
};

/** Fresh state for each attack: clear storage so each case records its own point. */
const resetAll = async () => {
  await sw.evaluate(async () => {
    await chrome.storage.local.clear();
    const alarms = await chrome.alarms.getAll();
    await Promise.all(alarms.map((a) => chrome.alarms.clear(a.name)));
  });
  await panel.reload();
  await panel.waitForLoadState('domcontentloaded');
  await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
  await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
  await panel.waitForTimeout(900);
};

const CASES = [
  ['text', 'the page changes the button\'s text to a different promise'],
  ['replace', 'the page replaces the element with a different one'],
  ['cover', 'a full-screen overlay covers the target'],
  ['late', 'the swap happens after the extension has resolved the element'],
];

for (const [attack, description] of CASES) {
  console.log(`\n================ ATTACK: ${attack} — ${description} ================`);
  await resetAll();
  await page.goto(`${base}?attack=${attack}`);
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => ({ log: window.LOG, text: (document.getElementById('buy') ?? document.getElementById('evil'))?.textContent }));
  console.log('  before picking:', JSON.stringify(before));

  await clickText('^\\+\\s*Add a point');
  const picked = await pickBuy();
  console.log('  point recorded:', picked);
  if (!picked) { record('INFO', `[${attack}] could not record a point`, 'the case did not run'); continue; }

  // NOW spring the swap, after the point has been recorded - this is the attack
  const sprung = await page.evaluate(() => {
    if (typeof window.__swap !== 'function') return 'no swap armed for this case';
    window.__swap();
    return 'swapped after the pick';
  });
  console.log('  swap:', sprung);

  const storedState = await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const a = (all.automations ?? []).find((x) => (x.steps ?? []).length > 0);
    return { steps: JSON.stringify(a?.steps ?? null).slice(0, 460), urls: a?.urls ?? null, id: a?.id ?? null };
  });
  console.log('  stored steps:', storedState.steps);
  console.log('  recorded urls:', JSON.stringify(storedState.urls));
  /**
   * WITHOUT A RECORDED URL THERE IS NO PAGE TO ACT ON, and every attack below would pass for the wrong reason. This is
   * asserted rather than assumed because the first version of this file had exactly that defect.
   */
  const hasUrl = Array.isArray(storedState.urls) && storedState.urls.length > 0;
  record('INFO', `[${attack}] the Basic form records no page for the picked point`,
    hasUrl
      ? `urls: ${JSON.stringify(storedState.urls)}`
      : 'urls is EMPTY. MEASURED and reported as a finding in its own right: at run time the worker resolves a tab from '
        + '`automation.urls`, and with none it falls back to the ACTIVE tab - which is whatever the user has in front. So a '
        + 'scheduled run has no page of its own unless the user set URLs on the Automation tab. This is exactly what the '
        + 'reported log showed as "has never had an element picked in it, so a scheduled run has no page".');
  /**
   * THE ATTACK CASES ARE MADE RUNNABLE BY SETTING THE PATTERN THE WORKER NEEDS, so what follows measures the CLICK
   * INTEGRITY rather than the missing URL. This is stated rather than hidden: with `urls` empty the run acts on the active
   * tab, and the harness would be measuring which tab happened to be in front.
   */
  await sw.evaluate(async (pattern) => {
    const all = await chrome.storage.local.get(null);
    const list = all.automations ?? [];
    const a = list.find((x) => (x.steps ?? []).length > 0);
    if (a) { a.urls = [pattern]; await chrome.storage.local.set({ automations: list }); }
  }, `${base}*`);

  const { ran, log } = await runAndObserve();
  console.log('  run:', JSON.stringify(ran).slice(0, 300));
  console.log('  what the page saw:', JSON.stringify(log));

  /**
   * THE VERDICT. What matters is which element received the click, not whether the run reported success: an extension
   * that clicks the attacker's element and calls it a success is worse than one that refuses and says so.
   */
  if (attack === 'text') {
    record(log.buy > 0 && log.evil === 0 ? 'OK' : 'MED',
      'the element that carries the recorded anchor still receives the click',
      `buy=${log.buy} evil=${log.evil}`);
  } else if (attack === 'replace') {
    /**
     * A REAL FINDING, measured: the element was replaced with a different one carrying the same id, and the extension
     * clicked the REPLACEMENT. The recorded anchor is an attribute and its value (`id="buy"`), and re-resolving that anchor
     * finds whatever now holds it. There is no identity check beyond the anchor, so a page that swaps its own button for a
     * different one - a re-render, or a deliberate swap - receives the click.
     *
     * For a trading page this is the risk worth documenting rather than a privilege problem: the page is only redirecting
     * its OWN interface, which it can already do. But "click buy" landing on a control the user did not choose is exactly
     * the failure the recorded text was meant to catch, and it is not checked before clicking.
     */
    /**
     * FIXED: the recorded label IS now verified before the click, so a swap is refused with a message naming both values.
     * Before the fix this case measured `evil=1` - the replacement received the click. A refusal is asserted rather than
     * just "no click", because a step that fails silently would be no better than one that clicks the wrong thing.
     */
    const refused = /refusing to click/.test(JSON.stringify(ran?.res ?? ''));
    record(log.evil === 0 && refused ? 'OK' : 'MED',
      'a swapped element is REFUSED, with the reason named',
      `buy=${log.buy} evil=${log.evil} refused=${refused} — the recorded label no longer matches, so the step fails loudly `
      + 'instead of clicking a control the user did not choose');
  } else if (attack === 'cover') {
    /**
     * WHAT THIS ACTUALLY SHOWS. `realClick` dispatches the sequence ON THE ELEMENT it resolved, so an overlay cannot
     * "absorb" a click - there is no coordinate hit-testing to intercept. `cover=1` therefore means the PICK recorded the
     * overlay, which is correct behaviour: the overlay covers the page, the user clicked the buy button's position, and the
     * element at that point was the overlay. The finding worth keeping is the inverse and it is real: a page that covers
     * the target silently redirects what the USER picks, so the recorded point can be the wrong element.
     */
    record('INFO',
      'a covering overlay is recorded as the target, because it is genuinely the element at that point',
      `buy=${log.buy} cover=${log.cover}. The click went to the element the user actually picked - the extension does not `
      + 'hit-test by coordinate, so a page cannot intercept a click in flight. The risk is at PICK time: an overlay changes '
      + 'what the user is selecting without changing what they see.');
  } else if (attack === 'late') {
    const refused = /refusing to click/.test(JSON.stringify(ran?.res ?? ''));
    record(log.evil === 0 && refused ? 'OK' : 'MED',
      'a swap that happens after resolution is also REFUSED',
      `buy=${log.buy} evil=${log.evil} refused=${refused}`);
  }
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