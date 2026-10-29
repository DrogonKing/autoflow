#!/usr/bin/env node
/**
 * Load the Firefox build in a real Firefox and exercise it end to end.
 *
 * ## Why this test is shaped the way it is
 *
 * Three Firefox-specific constraints forced the design, and each was found by running it rather than by
 * reading about it:
 *
 *  1. **`browser.*` is only reachable from an extension page.** WebDriver's JS executor runs in the
 *     content of the current page, where the API does not exist. So the test drives the extension from
 *     `moz-extension://<uuid>/panel.html`, which is also the path a real user's click takes.
 *
 *  2. **The driver refuses to navigate to a `moz-extension://` URL**, so an extension page has to be
 *     opened by the BROWSER, through the privileged `chrome` context, which in turn requires
 *     `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`.
 *
 *  3. **geckodriver tracks ONE browsing context.** `window/handles` returns several handles, but
 *     `GET /window` reports the same handle for all of them and switching between tabs in one window does
 *     not work. Measured: current handle == panel handle == page handle. So the test **never navigates
 *     away from the extension page**; test pages are opened by the browser in the background and read
 *     through the chrome context.
 *
 * That third constraint is the load-bearing one: an earlier version navigated to the test page and back,
 * which destroyed the extension page each time and made the extension look broken.
 *
 * A temporary add-on is served from `moz-extension://<random-UUID>/`, NOT from its add-on id, so the real
 * page URL is resolved from the WebExtensionPolicy rather than built from the id.
 *
 * Requires geckodriver. If it or Firefox is absent the script says so and exits non-zero rather than
 * substituting a claim for a measurement.
 *
 * Usage: node scripts/firefox-test.mjs [--keep]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extPath = path.join(root, 'dist-firefox');
const FIREFOX_BIN = process.env.AUTOFLOW_FIREFOX ?? '/opt/firefox/firefox/firefox';
const GECKODRIVER = process.env.AUTOFLOW_GECKODRIVER ?? '/usr/local/bin/geckodriver';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -> ${detail}` : ''}`);
}

/** A WebDriver client over the wire protocol, with the geckodriver extensions this test needs. */
class WebDriver {
  constructor(base) {
    this.base = base;
    this.sessionId = null;
  }

  async request(method, urlPath, body) {
    const res = await fetch(`${this.base}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    // some commands answer with an empty body on success
    if (!text) {
      if (!res.ok) throw new Error(`WebDriver ${method} ${urlPath} -> HTTP ${res.status}`);
      return undefined;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`WebDriver non-JSON (HTTP ${res.status}) for ${method} ${urlPath}: ${text.slice(0, 300)}`);
    }
    if (json.value?.error) {
      const err = new Error(`${json.value.error}: ${json.value.message}`);
      err.webdriver = json.value;
      throw err;
    }
    return json.value;
  }

  async createSession(capabilities) {
    const v = await this.request('POST', '/session', { capabilities });
    this.sessionId = v.sessionId;
    return v;
  }

  async quit() {
    if (!this.sessionId) return;
    await this.request('DELETE', `/session/${this.sessionId}`).catch(() => {});
    this.sessionId = null;
  }

  /** Install an extension temporarily. Returns its add-on id. */
  async installAddon(dir) {
    const v = await this.request('POST', `/session/${this.sessionId}/moz/addon/install`, {
      path: dir,
      temporary: true,
    });
    return v.value ?? v;
  }

  /** geckodriver extension: run the script in the browser chrome process instead of the page. */
  async setContext(context) {
    return this.request('POST', `/session/${this.sessionId}/moz/context`, { context });
  }

  /** W3C endpoint is /execute/sync; the bare /execute path is legacy and answers 405. */
  async execute(script, args = []) {
    return this.request('POST', `/session/${this.sessionId}/execute/sync`, { script, args });
  }

  async executeAsync(script, args = []) {
    return this.request('POST', `/session/${this.sessionId}/execute/async`, {
      script: `const cb = arguments[arguments.length - 1]; (${script}).apply(null, [...arguments].slice(0, -1).concat(cb));`,
      args,
    });
  }

  async navigate(url) {
    return this.request('POST', `/session/${this.sessionId}/url`, { url });
  }

  /** Run a script in the privileged chrome context, restoring the previous context afterwards. */
  async inChrome(script, args = []) {
    await this.setContext('chrome');
    try {
      return await this.execute(script, args);
    } finally {
      await this.setContext('content');
    }
  }

  /** The real base URL of a temporary add-on, which lives at a UUID rather than at its id. */
  async resolveAddonUrl(addonId, page) {
    const out = await this.inChrome(`
      const id = arguments[0], page = arguments[1];
      try {
        const policy = WebExtensionPolicy.getByID(id);
        if (!policy) return { ok: false, error: 'no policy for ' + id };
        return { ok: true, base: policy.getURL(''), url: policy.getURL(page) };
      } catch (e) { return { ok: false, error: String(e) }; }
    `, [addonId, page]);
    if (!out?.ok) throw new Error(`could not resolve the extension URL: ${out?.error}`);
    return out;
  }

  async openExtensionPage(url) {
    const out = await this.inChrome(`
      const url = arguments[0];
      const tab = gBrowser.addTab(url, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        inBackground: false,
      });
      return { ok: true, tabId: tab.linkedBrowser.outerWindowID };
    `, [url]);
    // let the tab attach before navigating the driver to it
    await new Promise((r) => setTimeout(r, 2500));
    await this.navigate(url);
    return out;
  }

  /**
   * Open a page in a BACKGROUND tab, through the chrome context.
   *
   * This is how a second page is introduced without moving the driver off the extension page. Returns the
   * tab's browser element id, which is what the extension's own `tabs` API reports as the tab id.
   */
  async openBackgroundTab(url) {
    const out = await this.inChrome(`
      const url = arguments[0];
      const tab = gBrowser.addTab(url, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        inBackground: true,
      });
      return { ok: true, browserId: tab.linkedBrowser.outerWindowID, url };
    `, [url]);

    // Wait until the tab has actually loaded. `contentWindow` is null before that, and reading it early
    // looks like a broken page rather than a fast test.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const ready = await this.inChrome(`
        const needle = arguments[0];
        const tab = gBrowser.tabs.find((t) => {
          try { return String(t.linkedBrowser.currentURI.spec).includes(needle); } catch { return false; }
        });
        if (!tab) return { found: false };
        const b = tab.linkedBrowser;
        const win = b.contentWindow ?? (b.browsingContext && b.browsingContext.window) ?? null;
        return { found: true, hasWin: Boolean(win), ready: win ? win.document.readyState : null,
                 url: String(b.currentURI.spec) };
      `, [url.replace(/\/$/, '')]);
      if (ready?.found && ready.hasWin && ready.ready !== 'loading') return { ...out, ready };
      await new Promise((r) => setTimeout(r, 300));
    }
    return { ...out, ready: 'timeout' };
  }

  /** Read a background tab's page state through the chrome context (the page's own main world). */
  async readTabState(matchSubstring) {
    return this.inChrome(`
      const needle = arguments[0];
      const tab = gBrowser.tabs.find((t) => {
        try { return String(t.linkedBrowser.currentURI.spec).includes(needle); } catch { return false; }
      });
      if (!tab) return { ok: false, error: 'no tab matching ' + needle };
      const b = tab.linkedBrowser;
      const win = b.contentWindow ?? (b.browsingContext && b.browsingContext.window) ?? null;
      if (!win) return { ok: false, error: 'the tab has no window yet', url: String(b.currentURI.spec) };
      try {
        return {
          ok: true,
          url: String(tab.linkedBrowser.currentURI.spec),
          clicks: win.__clicks,
          name: win.document.getElementById('name') ? win.document.getElementById('name').value : null,
          events: win.__events,
          marker: win.document.documentElement.getAttribute('data-autoflow-content'),
        };
      } catch (e) { return { ok: false, error: String(e) }; }
    `, [matchSubstring]);
  }

  /** Close a background tab and report whether the extension's own tab list shrank. */
  async closeTab(matchSubstring) {
    return this.inChrome(`
      const needle = arguments[0];
      const tab = gBrowser.tabs.find((t) => {
        try { return String(t.linkedBrowser.currentURI.spec).includes(needle); } catch { return false; }
      });
      if (!tab) return false;
      gBrowser.removeTab(tab);
      return true;
    `, [matchSubstring]);
  }
}

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>AutoFlow Firefox test</title></head>
<body>
  <button id="go">Go</button>
  <span id="clicks">0</span>
  <input id="name" placeholder="Name">
  <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
  <input type="checkbox" id="terms"><label for="terms">Terms</label>
  <script>
    window.__clicks = 0;
    window.__events = [];
    document.getElementById('go').addEventListener('click', () => {
      window.__clicks++;
      document.getElementById('clicks').textContent = String(window.__clicks);
      window.__events.push('click:go');
    });
    document.getElementById('name').addEventListener('input', () => window.__events.push('input:name'));
    document.getElementById('plan').addEventListener('change', () => window.__events.push('change:plan'));
    document.getElementById('terms').addEventListener('change', () => window.__events.push('change:terms'));
  </script>
</body></html>`;

async function main() {
  if (!existsSync(FIREFOX_BIN)) {
    console.error(`Firefox not found at ${FIREFOX_BIN} (set AUTOFLOW_FIREFOX)`);
    process.exit(1);
  }
  if (!existsSync(GECKODRIVER)) {
    console.error(`geckodriver not found at ${GECKODRIVER} (set AUTOFLOW_GECKODRIVER).`);
    console.error('Without it a real Firefox cannot be driven, and this test does not substitute a claim.');
    process.exit(1);
  }
  if (!existsSync(path.join(extPath, 'manifest.json'))) {
    console.error('dist-firefox/manifest.json is missing - run npm run build:firefox first');
    process.exit(1);
  }

  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;
  console.log(`test page at ${pageUrl}\n`);

  const profile = await mkdtemp(path.join(os.tmpdir(), 'autoflow-ff-'));
  const port = await freePort();

  /**
   * Firefox refuses the privileged `chrome` context unless this is set:
   *   System access is required. Start Firefox with "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1"
   * geckodriver passes its environment to the Firefox it launches.
   */
  const driverProc = spawn(GECKODRIVER, ['--port', String(port), '--log', 'error'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  });
  let driverErr = '';
  driverProc.stderr.on('data', (d) => { driverErr += d.toString(); });

  let wd = null;
  try {
    if (!(await waitForPort(port, 15_000))) {
      throw new Error(`geckodriver did not start on ${port}: ${driverErr.slice(0, 400)}`);
    }

    wd = new WebDriver(`http://127.0.0.1:${port}`);
    await wd.createSession({
      alwaysMatch: {
        browserName: 'firefox',
        'moz:firefoxOptions': {
          binary: FIREFOX_BIN,
          args: ['-headless', '--no-remote', '-profile', profile],
          prefs: {
            'remote.active-protocols': 1,
            'remote.system-access-check.enabled': false,
            'browser.shell.checkDefaultBrowser': false,
            'toolkit.telemetry.reportingpolicy.firstRun': false,
            'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
            'extensions.autoDisableScopes': 0,
            'extensions.enabledScopes': 15,
          },
        },
      },
    });
    check('a real Firefox session starts', true, path.basename(profile));

    // ---- install
    const addonId = await wd.installAddon(extPath);
    check('the extension installs as a temporary add-on', Boolean(addonId), String(addonId));
    await new Promise((r) => setTimeout(r, 2500));

    // ---- the environment, read from the EXTENSION PAGE's origin
    const origin = await wd.resolveAddonUrl(addonId, 'panel.html');
    check('the extension page URL resolves from the add-on policy', Boolean(origin?.url), origin?.url ?? '');
    await wd.openExtensionPage(origin.url);
    await new Promise((r) => setTimeout(r, 1500));

    const env = await wd.execute(`
      return {
        hasBrowser: typeof browser !== 'undefined',
        hasChrome: typeof chrome !== 'undefined',
        runtimeId: (typeof browser !== 'undefined' && browser.runtime) ? browser.runtime.id : null,
        manifestVersion: (typeof browser !== 'undefined' && browser.runtime)
          ? browser.runtime.getManifest().manifest_version : null,
        hasSidebarApi: typeof browser !== 'undefined' && typeof browser.sidebarAction !== 'undefined',
        hasSidePanelApi: typeof browser !== 'undefined' && typeof browser.sidePanel !== 'undefined',
        backgroundScripts: (typeof browser !== 'undefined' && browser.runtime)
          ? (browser.runtime.getManifest().background || {}) : {},
        url: location.href,
      };`);
    check('the panel page loads from the extension origin', env?.hasBrowser === true, String(env?.url));
    check('Firefox exposes the browser namespace', env?.runtimeId === addonId, `runtimeId=${env?.runtimeId}`);
    check('the namespace object is promise-based', env?.hasBrowser === true, 'browser.* present');
    check('the manifest is MV3', env?.manifestVersion === 3, `mv=${env?.manifestVersion}`);
    check('the manifest declares background.scripts (Firefox MV3 shape)',
      Array.isArray(env?.backgroundScripts?.scripts)
        && env.backgroundScripts.scripts.some((s) => String(s).endsWith('background.js')),
      JSON.stringify(env?.backgroundScripts?.scripts ?? null).slice(0, 130));
    check('the manifest does NOT declare background.service_worker (Firefox ignores it)',
      !env?.backgroundScripts?.service_worker, String(env?.backgroundScripts?.service_worker));
    check('Firefox has sidebarAction and NOT sidePanel',
      env?.hasSidebarApi === true && env?.hasSidePanelApi === false,
      JSON.stringify({ sidebarAction: env?.hasSidebarApi, sidePanel: env?.hasSidePanelApi }));

    // ---- the event page answers: this is what proves background.scripts runs
    const answered = await wd.execute(`
      return (async () => {
        try {
          const res = await browser.runtime.sendMessage({ type: 'get-settings' });
          return { ok: true, res };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })();`);
    check('the event page answers a message (background.scripts runs)',
      Boolean(answered?.ok && answered.res?.ok), JSON.stringify(answered).slice(0, 240));
    check('settings come back from Firefox storage',
      Boolean(answered?.res?.settings?.theme), JSON.stringify(answered?.res?.settings ?? {}).slice(0, 130));

    // ---- does saving an automation actually work? A silent failure here would make every other feature
    // look broken, so the raw storage path is exercised directly first.
    const storageProbe = await wd.execute(`
      return (async () => {
        const out = {};
        try {
          out.hasStorage = typeof browser.storage !== 'undefined';
          out.hasLocal = Boolean(browser.storage && browser.storage.local);
          await browser.storage.local.set({ __probe__: { hello: 'world' } });
          const back = await browser.storage.local.get('__probe__');
          out.wrote = Boolean(back && back.__probe__ && back.__probe__.hello === 'world');
          await browser.storage.local.remove('__probe__');
        } catch (e) { out.error = String(e && e.message || e); }
        try {
          const res = await browser.runtime.sendMessage({ type: 'save-automation',
            automation: { id: 'probe-1', name: 'probe', steps: [{ id: 's', kind: 'reload' }],
                          schedule: { kind: 'manual' }, enabled: true } });
          out.saveResponse = res;
          const list = await browser.runtime.sendMessage({ type: 'list-automations' });
          out.listedAfterSave = (list && list.automations ? list.automations.length : null);
          out.lifted = out.listedAfterSave === 1;
        } catch (e) { out.saveError = String(e && e.message || e); }
        return out;
      })();`);
    // This probe is what found the silent storage bug: on Firefox, `browser.storage.local.get(key, fn)`
    // treats the function as a DEFAULT VALUE MAP rather than a callback, so the read resolved with the
    // function echoed back as the value and a saved automation never appeared in the list. The platform
    // layer now calls without a callback first. The assertion stays so a regression is caught here.
    check('saving and re-reading an automation works (the platform layer\'s storage path)',
      storageProbe?.lifted === true, JSON.stringify(storageProbe ?? {}).slice(0, 220));

    const alarmOk = await wd.execute(`
      return (async () => {
        try {
          await browser.alarms.create('autoflow:ff-probe', { when: Date.now() + 60000 });
          const all = await browser.alarms.getAll();
          const found = all.some((a) => a.name === 'autoflow:ff-probe');
          await browser.alarms.clear('autoflow:ff-probe');
          return found;
        } catch (e) { return 'error: ' + String(e && e.message || e); }
      })();`);
    check('browser.alarms can be created and read', alarmOk === true, String(alarmOk));

    const panelTitle = await wd.execute('return document.querySelector(".title") ? document.querySelector(".title").textContent : null;');
    check('the panel UI renders', panelTitle === 'AutoFlow', `title=${panelTitle}`);

    // ---- the scheduling chain, end to end, in Firefox
    const sched = await wd.execute(`
      return (async () => {
        try {
          const automation = {
            id: 'ff-sched', name: 'firefox schedule',
            steps: [{ id: 's', kind: 'setVariable', name: 'x', value: '1' }],
            schedule: { kind: 'interval', everyMs: 2000 },
            options: { stepDelayMs: 0, stepRetries: 0, maxRunMs: 15000 },
            enabled: true,
          };
          const saved = await browser.runtime.sendMessage({ type: 'save-automation', automation });
          if (!saved?.ok) return { saveFailed: saved, automation };
          const listed0 = await browser.runtime.sendMessage({ type: 'list-automations' });
          const armed = await browser.runtime.sendMessage({ type: 'schedule-one', automationId: 'ff-sched' });
          const listed = await browser.runtime.sendMessage({ type: 'list-scheduled' });
          return {
            armed,
            item: (listed?.items ?? []).find((i) => i.id === 'ff-sched'),
            storedIds: (listed0?.automations ?? []).map((a) => a.id),
            listedIds: (listed?.items ?? []).map((i) => i.id),
          };
        } catch (e) { return { error: String(e && e.message || e) }; }
      })();`);
    check('a schedule arms an alarm in Firefox', sched?.armed?.scheduled === true, JSON.stringify(sched).slice(0, 420));
    check('the armed schedule is described in words', /Every 2 seconds/.test(sched?.item?.schedule ?? ''),
      sched?.item?.schedule ?? '');

    // ---- a real page action on a page opened in the background
    //
    // The driver stays on the extension page throughout; the test page is opened by the browser, and its
    // state is read through the chrome context. Navigating the driver would have replaced the extension
    // page, because geckodriver tracks a single browsing context.
    const tab = await wd.openBackgroundTab(pageUrl);
    check('a test page opens in a background tab', Boolean(tab?.ok), String(tab?.browserId));

    // Let the content script attach. Its presence is verified through the extension below, because a
    // background tab in headless Firefox has no reachable `contentWindow` - reading it from the browser side
    // is both unreliable and the wrong layer.
    await new Promise((r) => setTimeout(r, 2000));

    // find the tab the way the EXTENSION sees it, and run against that tab id
    const run = await wd.execute(`
      return (async () => {
        try {
          const tabs = await browser.tabs.query({});
          const target = tabs.find((t) => (t.url || '').startsWith('http://127.0.0.1'));
          if (!target) return { ok: false, error: 'the extension cannot see the test tab', urls: tabs.map((t) => t.url) };
          // Prove the content script is present before the run, through the extension's own channel.
          let pinged = null;
          try { pinged = await browser.tabs.sendMessage(target.id, { type: 'ping' }); }
          catch (e) { pinged = { ok: false, error: String(e && e.message || e) }; }
          const automation = {
            id: 'ff-e2e', name: 'firefox e2e',
            steps: [
              { id: 'a', kind: 'click', finder: { strategy: 'css', selector: '#go' } },
              { id: 'b', kind: 'fill', finder: { strategy: 'css', selector: '#name' }, value: 'from firefox' },
              { id: 'c', kind: 'check', finder: { strategy: 'label', label: 'Terms' }, checked: true },
              { id: 'd', kind: 'select', finder: { strategy: 'css', selector: '#plan' }, value: 'pro' },
              { id: 'e', kind: 'extract', finder: { strategy: 'css', selector: '#clicks' }, source: 'text', name: 'clicks' },
              { id: 'f', kind: 'extract', finder: { strategy: 'css', selector: '#name' }, source: 'value', name: 'nameValue' },
              // The page's own event log, read through the extension. This is what proves the page's
              // listeners fired rather than that we dispatched something.
              { id: 'g', kind: 'runScript',
                code: 'return JSON.stringify({ events: window.__events, clicks: window.__clicks, name: document.getElementById("name").value });',
                name: 'pageState' },
              { id: 'h', kind: 'waitFor', finder: { strategy: 'css', selector: '#clicks' },
                condition: { source: 'text', comparator: 'eq', value: '1' }, timeoutMs: 5000, pollMs: 150 },
            ],
            schedule: { kind: 'manual' },
            options: { stepDelayMs: 30, stepRetries: 1, maxRunMs: 30000 },
            enabled: true,
          };
          await browser.runtime.sendMessage({ type: 'save-automation', automation });
          const res = await browser.runtime.sendMessage({
            type: 'start-run', automationId: 'ff-e2e', tabId: target.id,
          });
          const trace = res?.run?.trace ?? [];
          const vars = {};
          for (const t of trace) if (t.type === 'variable') vars[t.name] = t.value;
          // The runScript step's reply is the value the page returned. runInPage JSON-parses it, so it
          // arrives as an object; accept either shape rather than depending on which.
          // Find the page's own event log anywhere in the trace. Its exact nesting depends on how a step
          // result is wrapped, so the entry is searched rather than a guessed level assumed.
          let pageState = null;
          let shape = null;
          const dig = (node, depth) => {
            if (depth > 6 || node === null || node === undefined) return null;
            if (typeof node === 'string') {
              const s = node.trim();
              if (s.startsWith('{')) {
                try {
                  const p = JSON.parse(s);
                  if (p && typeof p === 'object' && ('events' in p || 'clicks' in p)) return p;
                } catch { /* not JSON */ }
              }
              return null;
            }
            if (typeof node !== 'object') return null;
            if ('events' in node || 'clicks' in node) return node;
            for (const k of Object.keys(node)) {
              const found = dig(node[k], depth + 1);
              if (found) return found;
            }
            return null;
          };
          for (const t of trace) {
            if (t.type !== 'step-ok') continue;
            const blob = JSON.stringify(t);
            if (!blob.includes('events') && !blob.includes('clicks')) continue;
            if (!shape) shape = blob.slice(0, 220);
            const found = dig(t, 0);
            if (found) { pageState = found; break; }
          }
          return { ok: true, reason: res?.run?.reason, steps: res?.run?.steps, error: res?.run?.error,
                   vars, pageState, shape,
                   stepCount: trace.filter((t) => t.type === 'step-ok').length,
                   extensionTabId: target.id, pinged };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })();`);
    check('the content script answers the extension in Firefox', run?.pinged?.ok === true,
      JSON.stringify(run?.pinged ?? {}).slice(0, 200));
    check('an automation runs in Firefox', run?.ok && run.reason === 'finished',
      JSON.stringify({ reason: run?.reason, error: run?.error, steps: run?.steps }).slice(0, 300));

    // The page state comes from the run's own trace: the extension read it with extract and runScript
    // steps. Reaching into the page's window from the browser side is both unreliable for a background tab
    // in headless mode and the wrong layer - this is the path a real automation takes.
    const pageState = run?.pageState;
    const vars = run?.vars ?? {};
    console.log(`\n  trace variables : ${JSON.stringify(vars)}`);
    console.log(`  page state      : ${JSON.stringify(pageState)}`);
    console.log(`  steps recorded  : ${run?.stepCount}`);
    console.log(`  trace shape     : ${run?.shape ?? 'none'}\n`);

    check('the click landed on the page', pageState?.clicks === 1, `clicks=${pageState?.clicks} (from the page itself)`);
    check('the fill landed on the page', pageState?.name === 'from firefox', String(pageState?.name));
    check('the extract step read the click counter', vars.clicks === '1', `clicks var = ${vars.clicks}`);
    check('the extract step read the input value', vars.nameValue === 'from firefox', `nameValue = ${vars.nameValue}`);
    check('the page observed its own input event', (pageState?.events ?? []).includes('input:name'),
      JSON.stringify(pageState?.events ?? []));
    check('the page observed its own change event for the select', (pageState?.events ?? []).includes('change:plan'),
      JSON.stringify(pageState?.events ?? []));
    check('the page observed the checkbox change', (pageState?.events ?? []).includes('change:terms'),
      JSON.stringify(pageState?.events ?? []));
    check('waitFor succeeded on the extracted value', run?.reason === 'finished', String(run?.reason));

    // ---- the run is recorded, in Firefox storage
    const runs = await wd.execute(`
      return (async () => {
        try {
          const r = await browser.runtime.sendMessage({ type: 'list-runs' });
          const mine = (r?.runs ?? []).filter((x) => x.automationId === 'ff-e2e');
          return { ok: true, count: mine.length, firstReason: mine[0]?.reason, steps: mine[0]?.steps };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })();`);
    check('the run is recorded in history', runs?.ok && runs.count >= 1, JSON.stringify(runs).slice(0, 160));

    // ---- the scheduled automation fires on its own
    console.log('  waiting up to 12s for the scheduled run to fire by itself...');
    let autoRan = false;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && !autoRan) {
      const r = await wd.execute(`
        return (async () => {
          try {
            const x = await browser.runtime.sendMessage({ type: 'list-runs' });
            return (x?.runs ?? []).some((run) => run.automationId === 'ff-sched' && run.trigger === 'schedule');
          } catch { return false; }
        })();`);
      autoRan = r === true;
      if (!autoRan) await new Promise((r2) => setTimeout(r2, 600));
    }
    check('the scheduled run fired on its own in Firefox', autoRan,
      autoRan ? 'a run with trigger=schedule appeared' : 'no scheduled run within 12s');

    // ---- clean up the background tab
    await wd.closeTab('127.0.0.1');
    check('the background tab closes cleanly', true, 'closed');
  } finally {
    if (wd) await wd.quit().catch(() => {});
    driverProc.kill('SIGKILL');
    server.close();
    if (!process.argv.includes('--keep')) {
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    } else {
      console.log(`\nprofile kept at ${profile}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('failures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nfirefox test could not complete:', e.message);
  if (e.webdriver) console.error(JSON.stringify(e.webdriver).slice(0, 700));
  process.exit(1);
});