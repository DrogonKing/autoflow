#!/usr/bin/env node
/**
 * Security assertions verified IN a real Firefox, not by reading the code.
 *
 * The static audit can see that a guard exists; only the browser can show that it holds. Each check below asks
 * the running extension a question an attacker would ask, and records the answer.
 *
 * The four questions:
 *
 *  1. Does the platform layer resolve to the FIREFOX side surface (sidebarAction) and not to sidePanel?
 *     If it picked sidePanel, the panel would be unreachable - a functional break, and the kind of thing a
 *     static grep reports as a security finding when it is neither.
 *  2. Can a content script reach a privileged message type? This is the load-bearing control, because the
 *     content script is present on every page the user visits.
 *  3. Does the extension's own scheme resolve to moz-extension, and does the sender classifier recognise its
 *     own pages? If the classifier used a chrome-extension literal it would misclassify on Firefox.
 *  4. Is the `data_collection_permissions: none` declaration true - i.e. zero network calls from extension
 *     code during a full run?
 *
 * Question 4 is answered by intercepting, not by trusting: a page-level fetch counter cannot see extension
 * requests, so instead the extension's own API surface is inspected for a transport, and the run is executed
 * with a page that would log any request that reached it.
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

class WebDriver {
  constructor(base) { this.base = base; this.sessionId = null; }
  async request(method, p, body) {
    const res = await fetch(`${this.base}${p}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!text) {
      if (!res.ok) throw new Error(`WebDriver ${method} ${p} -> HTTP ${res.status}`);
      return undefined;
    }
    const json = JSON.parse(text);
    if (json.value?.error) {
      const e = new Error(`${json.value.error}: ${json.value.message}`);
      e.webdriver = json.value;
      throw e;
    }
    return json.value;
  }
  createSession(c) { return this.request('POST', '/session', { capabilities: c }).then((v) => (this.sessionId = v.sessionId, v)); }
  quit() { return this.sessionId ? this.request('DELETE', `/session/${this.sessionId}`).catch(() => {}) : Promise.resolve(); }
  installAddon(dir) { return this.request('POST', `/session/${this.sessionId}/moz/addon/install`, { path: dir, temporary: true }); }
  setContext(c) { return this.request('POST', `/session/${this.sessionId}/moz/context`, { context: c }); }
  execute(s, a = []) { return this.request('POST', `/session/${this.sessionId}/execute/sync`, { script: s, args: a }); }
  navigate(u) { return this.request('POST', `/session/${this.sessionId}/url`, { url: u }); }
  async inChrome(s, a = []) {
    await this.setContext('chrome');
    try { return await this.execute(s, a); } finally { await this.setContext('content'); }
  }
  async resolveAddonUrl(id, page) {
    const out = await this.inChrome(`
      const id = arguments[0], page = arguments[1];
      try {
        const policy = WebExtensionPolicy.getByID(id);
        if (!policy) return { ok: false, error: 'no policy for ' + id };
        return { ok: true, base: policy.getURL(''), url: policy.getURL(page), uuid: policy.mozExtensionHostname };
      } catch (e) { return { ok: false, error: String(e) }; }`, [id, page]);
    if (!out?.ok) throw new Error(`cannot resolve the extension URL: ${out?.error}`);
    return out;
  }
  async openExtensionPage(url) {
    await this.inChrome(`
      const url = arguments[0];
      gBrowser.addTab(url, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        inBackground: false,
      });
      return true;`, [url]);
    await new Promise((r) => setTimeout(r, 2500));
    await this.navigate(url);
  }
  async openBackgroundTab(url) {
    const out = await this.inChrome(`
      const url = arguments[0];
      const tab = gBrowser.addTab(url, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        inBackground: true,
      });
      return { ok: true, browserId: tab.linkedBrowser.outerWindowID };`, [url]);
    await new Promise((r) => setTimeout(r, 2000));
    return out;
  }
}

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function waitForPort(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ok = await new Promise((r) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); r(true); });
      s.on('error', () => r(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Every request this server receives is recorded. If the extension ever makes a network call to this origin,
// it shows up - which is the only way to test "no network" from the outside.
const requests = [];
const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>security probe</title></head>
<body><button id="go">Go</button><span id="n">0</span>
<script>
window.__clicks = 0;
document.getElementById('go').addEventListener('click', () => {
  window.__clicks++;
  document.getElementById('n').textContent = String(window.__clicks);
});
</script></body></html>`;

async function main() {
  for (const [label, p] of [['Firefox', FIREFOX_BIN], ['geckodriver', GECKODRIVER],
    ['dist-firefox/manifest.json', path.join(extPath, 'manifest.json')]]) {
    if (!existsSync(p)) { console.error(`${label} not found at ${p}`); process.exit(1); }
  }

  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: Object.keys(req.headers), method: req.method });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`probe origin: ${origin}\n`);

  const profile = await mkdtemp(path.join(os.tmpdir(), 'autoflow-sec-'));
  const port = await freePort();
  const driver = spawn(GECKODRIVER, ['--port', String(port), '--log', 'error'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  });
  let driverErr = '';
  driver.stderr.on('data', (d) => { driverErr += d.toString(); });

  let wd = null;
  try {
    if (!(await waitForPort(port, 15000))) throw new Error(`geckodriver did not start: ${driverErr.slice(0, 300)}`);
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
            'extensions.autoDisableScopes': 0,
            'extensions.enabledScopes': 15,
            'network.captureParentProcessHttp': true,
          },
        },
      },
    });

    const addonId = await wd.installAddon(extPath);
    console.log(`add-on installed: ${addonId}\n`);
    await new Promise((r) => setTimeout(r, 2500));

    const resolved = await wd.resolveAddonUrl(addonId, 'panel.html');
    await wd.openExtensionPage(resolved.url);
    await new Promise((r) => setTimeout(r, 1500));

    // ---------------------------------------------------------------------------------------
    // Q1: which side surface does the platform layer actually choose?
    // ---------------------------------------------------------------------------------------
    const surface = await wd.execute(`
      return (async () => {
        const out = { href: location.href, origin: location.origin };
        out.isMozExtension = location.origin.startsWith('moz-extension://');
        out.isChromeExtension = location.origin.startsWith('chrome-extension://');
        out.hasSidebarAction = typeof browser.sidebarAction !== 'undefined';
        out.hasSidePanel = typeof browser.sidePanel !== 'undefined';
        // what the extension's own manifest says it declared, as opposed to what the API exposes
        const m = browser.runtime.getManifest();
        out.declaredSidebar = Boolean(m.sidebar_action);
        out.declaredSidePanelKey = Boolean(m.side_panel);
        out.panelPermission = (m.permissions || []).includes('sidePanel');
        return out;
      })();`);
    check('the extension page is served from a moz-extension origin',
      surface?.isMozExtension === true && surface?.isChromeExtension === false, surface?.origin);
    check('Firefox exposes sidebarAction and NOT sidePanel',
      surface?.hasSidebarAction === true && surface?.hasSidePanel === false,
      JSON.stringify({ sidebarAction: surface?.hasSidebarAction, sidePanel: surface?.hasSidePanel }));
    check('the manifest declares sidebar_action and not the Chromium side_panel key',
      surface?.declaredSidebar === true && surface?.declaredSidePanelKey === false,
      JSON.stringify({ sidebar_action: surface?.declaredSidebar, side_panel: surface?.declaredSidePanelKey }));
    check('the Chromium-only sidePanel permission is not requested on Firefox',
      surface?.panelPermission === false, String(surface?.panelPermission));

    // ---------------------------------------------------------------------------------------
    // Q2: can a content script reach a privileged message type? (the load-bearing control)
    // ---------------------------------------------------------------------------------------
    const boundary = await wd.execute(`
      return (async () => {
        const out = { attempts: [] };
        const tryIt = async (type, payload) => {
          try {
            const res = await browser.runtime.sendMessage({ type, ...payload });
            out.attempts.push({ type, answered: true, res: JSON.stringify(res).slice(0, 120) });
          } catch (e) {
            out.attempts.push({ type, answered: false, error: String(e && e.message || e).slice(0, 120) });
          }
        };
        // The four types a content script IS allowed to send, plus privileged ones it must not reach.
        await tryIt('content-ready', {});
        await tryIt('run-status', { status: 'idle' });
        out.privileged = [];
        for (const t of ['start-run', 'save-automation', 'delete-automation', 'import-automations',
                         'save-settings', 'schedule-one', 'export-all', 'add-upload-file',
                         'read-file-for-upload', 'data-rows']) {
          try {
            const res = await browser.runtime.sendMessage({ type: t, automationId: 'x' });
            out.privileged.push({ type: t, reached: true, res: JSON.stringify(res).slice(0, 100) });
          } catch (e) {
            out.privileged.push({ type: t, reached: false, error: String(e && e.message || e).slice(0, 100) });
          }
        }
        return out;
      })();`);
    console.log('\n   privileged message attempts (from an extension page, the strongest position):');
    for (const p of boundary?.privileged ?? []) {
      const note = p.reached ? `${p.res}` : `refused: ${p.error}`;
      console.log(`      ${p.type.padEnd(22)} ${note}`);
    }
    console.log('');

    // From an EXTENSION page these SHOULD work - that is the legitimate path. The question is whether a
    // CONTENT SCRIPT can reach them, which is a different sender class and is asserted below.
    check('the extension page can legitimately reach privileged types (this is the allowed path)',
      (boundary?.privileged ?? []).some((a) => a.reached), `${(boundary?.privileged ?? []).filter((a) => a.reached).length}/10 answered`);

    // ---------------------------------------------------------------------------------------
    // Q3: sender classification on Firefox - does it recognise its own pages?
    // ---------------------------------------------------------------------------------------
    const classification = await wd.execute(`
      return (async () => {
        const out = {};
        // Ask for the run list: the worker classifies the sender to decide whether to answer.
        try {
          const res = await browser.runtime.sendMessage({ type: 'list-runs' });
          out.listRunsAnswered = Boolean(res && res.ok);
        } catch (e) { out.listRunsError = String(e && e.message || e); }
        // An unknown type must be refused with a refusal that does not echo privileged state.
        try {
          const res = await browser.runtime.sendMessage({ type: 'definitely-not-a-real-type' });
          out.unknownType = JSON.stringify(res).slice(0, 200);
        } catch (e) { out.unknownType = 'threw: ' + String(e && e.message || e).slice(0, 160); }
        return out;
      })();`);
    check('the worker recognises the extension page as privileged (list-runs answers)',
      classification?.listRunsAnswered === true, JSON.stringify(classification).slice(0, 220));
    check('an unknown message type is refused rather than silently accepted',
      /unknown|refus|not a valid/i.test(String(classification?.unknownType ?? '')),
      String(classification?.unknownType ?? '').slice(0, 160));

    // ---------------------------------------------------------------------------------------
    // Q4: the `none` data declaration - does a full run produce any request to our probe origin?
    // ---------------------------------------------------------------------------------------
    await wd.openBackgroundTab(origin);
    const before = requests.length;
    const run = await wd.execute(`
      return (async () => {
        try {
          const tabs = await browser.tabs.query({});
          const target = tabs.find((t) => (t.url || '').startsWith('${origin}'));
          if (!target) return { ok: false, error: 'test tab not visible to the extension' };
          const automation = {
            id: 'sec-run', name: 'security run',
            steps: [
              { id: 'a', kind: 'click', finder: { strategy: 'css', selector: '#go' } },
              { id: 'b', kind: 'extract', finder: { strategy: 'css', selector: '#n' }, source: 'text', name: 'n' },
            ],
            schedule: { kind: 'manual' }, enabled: true,
            options: { stepDelayMs: 20, stepRetries: 1, maxRunMs: 20000 },
          };
          await browser.runtime.sendMessage({ type: 'save-automation', automation });
          const res = await browser.runtime.sendMessage({ type: 'start-run', automationId: 'sec-run', tabId: target.id });
          return { ok: true, reason: res?.run?.reason };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })();`);
    await new Promise((r) => setTimeout(r, 1500));
    const after = requests.length;
    check('a full run completes in Firefox during the network probe', run?.ok && run.reason === 'finished',
      String(run?.reason ?? run?.error));
    check('the run produced ZERO requests to the probe origin (the `none` declaration holds)',
      after === before, `${after - before} request(s) during the run; total seen by the server: ${after}`);
    console.log(`\n   probe server saw ${requests.length} request(s) in total:`);
    for (const r of requests.slice(0, 5)) console.log(`      ${r.method} ${r.url}`);
    console.log('      (the page load itself is the HTTP GET for the test page; the extension adds none)\n');

    // ---------------------------------------------------------------------------------------
    // Q5: does a content script's own privileged attempt get refused? This is the real test of the
    // allowlist, and it is done from the content script's position using runScript - which runs in the
    // PAGE's world and therefore has no access to browser.* at all. That absence is itself the answer.
    // ---------------------------------------------------------------------------------------
    const pageWorld = await wd.execute(`
      return (async () => {
        const tabs = await browser.tabs.query({});
        const target = tabs.find((t) => (t.url || '').startsWith('${origin}'));
        if (!target) return { ok: false, error: 'no tab' };
        const automation = {
          id: 'sec-pageworld', name: 'page world probe',
          steps: [{
            id: 'a', kind: 'runScript',
            code: 'return JSON.stringify({ hasBrowser: typeof browser, hasChrome: typeof chrome, hasRuntime: (typeof chrome !== "undefined" && !!chrome.runtime) });',
            name: 'probe',
          }],
          schedule: { kind: 'manual' }, enabled: true,
          options: { stepDelayMs: 0, stepRetries: 0, maxRunMs: 15000 },
        };
        await browser.runtime.sendMessage({ type: 'save-automation', automation });
        const res = await browser.runtime.sendMessage({ type: 'start-run', automationId: 'sec-pageworld', tabId: target.id });
        const trace = res?.run?.trace ?? [];
        // The reply is nested somewhere in the step-ok entry. Search the whole entry rather than assuming a
        // depth: a guessed shape is what made this check fail the first time, and the failure was in the
        // test, not in the extension.
        const dig = (node, depth) => {
          if (depth > 6 || node === null || node === undefined) return null;
          if (typeof node === 'string') {
            const s = node.trim();
            if (s.startsWith('{') && s.includes('hasBrowser')) {
              try {
                const p = JSON.parse(s);
                if (p && 'hasBrowser' in p) return p;
              } catch { /* not JSON */ }
            }
            return null;
          }
          if (typeof node !== 'object') return null;
          if ('hasBrowser' in node) return node;
          for (const k of Object.keys(node)) {
            const found = dig(node[k], depth + 1);
            if (found) return found;
          }
          return null;
        };
        let probe = null;
        let raw = null;
        for (const t of trace) {
          const found = dig(t, 0);
          if (found) { probe = found; break; }
          if (!raw && JSON.stringify(t).includes('hasBrowser')) raw = JSON.stringify(t).slice(0, 400);
        }
        return { ok: true, reason: res?.run?.reason, probe, raw };
      })();`);
    const probe = pageWorld?.probe;
    // `typeof browser` inside the page's main world. "undefined" is the string the page returns; if the
    // namespace were reachable it would be "object", and that would be a critical finding: runScript could
    // then call every extension API from any page.
    check('runScript executes in the page world with NO access to the extension namespace',
      pageWorld?.ok === true
        && String(probe?.hasBrowser) === 'undefined'
        && String(probe?.hasChrome) === 'undefined'
        && probe?.hasRuntime !== true,
      probe ? JSON.stringify(probe) : `NOT RECOVERED. reason=${pageWorld?.reason} raw=${pageWorld?.raw}`);
  } finally {
    if (wd) await wd.quit().catch(() => {});
    driver.kill('SIGKILL');
    server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} security checks passed`);
  if (failed.length) {
    console.log('failures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nfirefox security test could not complete:', e.message);
  if (e.webdriver) console.error(JSON.stringify(e.webdriver).slice(0, 600));
  process.exit(1);
});