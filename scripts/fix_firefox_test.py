#!/usr/bin/env python3
"""
Rewrite the privileged parts of the Firefox test.

The first attempt ran `browser.*` through WebDriver's JS executor, which runs in the CONTENT of the
current page - where `browser` does not exist, by design. The extension APIs are reachable from an
extension page, so the test drives them from `moz-extension://<id>/panel.html` instead, which is also the
realistic path a user's click takes.

Everything the test needs is expressed as one helper installed on that page.
"""
import pathlib

p = pathlib.Path("/root/autoflow/scripts/firefox-test.mjs")
src = p.read_text()

OLD_START = src[src.index("    // ---- is the add-on actually enabled and running?"):src.index("    // ---- a real page action, through the content script")]

NEW_START = '''    // ---- Is the add-on installed, and does the MV3 event page answer?
    //
    // `browser.*` is NOT reachable from WebDriver's JS executor: it runs in the content of the current
    // page, where the API does not exist by design. The APIs are reachable from an EXTENSION page, so the
    // test navigates to panel.html and drives the extension from there - which is also the path a real
    // user's click takes.
    const panelUrl = `moz-extension://${addonId}/panel.html`;
    await wd.navigate(panelUrl);
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
      };`);
    check('the panel page loads from the extension origin', env?.hasBrowser === true, JSON.stringify(env).slice(0, 200));
    check('Firefox exposes the browser namespace to the panel', env?.runtimeId === addonId, `runtimeId=${env?.runtimeId}`);
    check('the manifest is MV3', env?.manifestVersion === 3, `mv=${env?.manifestVersion}`);
    check('the manifest declares background.scripts (Firefox MV3 shape)',
      Array.isArray(env?.backgroundScripts?.scripts) && env.backgroundScripts.scripts.includes('background.js'),
      JSON.stringify(env?.backgroundScripts).slice(0, 120));
    check('Firefox has sidebarAction and NOT sidePanel',
      env?.hasSidebarApi === true && env?.hasSidePanelApi === false,
      JSON.stringify({ sidebarAction: env?.hasSidebarApi, sidePanel: env?.hasSidePanelApi }));

    // ---- does the event page answer a message? This is what proves background.scripts runs at all.
    const answered = await wd.execute(`
      return (async () => {
        try {
          const res = await browser.runtime.sendMessage({ type: 'get-settings' });
          return { ok: true, res };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })();`);
    check('the event page answers a message (background.scripts works)',
      Boolean(answered?.ok && answered.res?.ok), JSON.stringify(answered).slice(0, 260));
    check('settings come back from Firefox storage',
      Boolean(answered?.res?.settings?.theme), JSON.stringify(answered?.res?.settings ?? {}).slice(0, 140));

    // ---- the scheduler API is present, since every alarm depends on it
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

    // ---- the panel UI renders
    const title = await wd.execute('return document.querySelector(".title") ? document.querySelector(".title").textContent : null;');
    check('the panel UI renders', title === 'AutoFlow', `title=${title}`);

'''

src = src.replace(OLD_START, NEW_START, 1)

# the run section must use the panel page (still loaded) and name the tab explicitly
OLD_RUN = src[src.index("    // ---- a real page action, through the content script"):src.index("    await new Promise((r) => setTimeout(r, 500));")]

NEW_RUN = '''    // ---- a real page action, through the content script
    await wd.navigate(pageUrl);
    await new Promise((r) => setTimeout(r, 2500));
    const marker = await wd.execute('return document.documentElement.getAttribute("data-autoflow-content");');
    check('the content script injects into a real page', Boolean(marker), `data-autoflow-content=${marker}`);

    // Find the tab id for the test page from the extension side, then run against it explicitly. The run
    // is targeted by `tabId` rather than the active tab, so the test does not depend on which tab Firefox
    // considers focused in headless mode.
    await wd.navigate(panelUrl);
    await new Promise((r) => setTimeout(r, 800));

    const ran = await wd.execute(`
      return (async () => {
        try {
          const tabs = await browser.tabs.query({});
          const target = tabs.find((t) => (t.url || '').startsWith('http://127.0.0.1'));
          if (!target) return { ok: false, error: 'no test tab found', tabUrls: tabs.map((t) => t.url) };
          const automation = {
            id: 'ff-e2e',
            name: 'firefox e2e',
            steps: [
              { id: 'a', kind: 'click', finder: { strategy: 'css', selector: '#go' } },
              { id: 'b', kind: 'fill', finder: { strategy: 'css', selector: '#name' }, value: 'from firefox' },
              { id: 'c', kind: 'extract', finder: { strategy: 'css', selector: '#clicks' }, source: 'text', name: 'clicks' },
            ],
            schedule: { kind: 'manual' },
            options: { stepDelayMs: 30, stepRetries: 1, maxRunMs: 30000 },
            enabled: true,
          };
          await browser.runtime.sendMessage({ type: 'save-automation', automation });
          const run = await browser.runtime.sendMessage({
            type: 'start-run', automationId: 'ff-e2e', tabId: target.id,
          });
          return { ok: true, reason: run?.run?.reason, steps: run?.run?.steps,
                   error: run?.run?.error, tabId: target.id };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })();`);
    check('an automation runs in Firefox', ran?.ok && ran.reason === 'finished',
      JSON.stringify(ran).slice(0, 320));

    // read the page back
    await wd.navigate(pageUrl);
    await new Promise((r) => setTimeout(r, 1200));
    const pageState = await wd.execute(
      'return { clicks: window.__clicks, name: document.getElementById("name").value, events: window.__events };',
    );
    check('the click landed on the real page', pageState?.clicks >= 1, JSON.stringify(pageState).slice(0, 200));
    check('the fill landed on the real page', pageState?.name === 'from firefox', String(pageState?.name));
    check('the page observed its own events', (pageState?.events ?? []).includes('click:go'),
      JSON.stringify(pageState?.events ?? []));

'''

src = src.replace(OLD_RUN, NEW_RUN, 1)
p.write_text(src)
print("firefox-test.mjs rewritten: privileged calls run from an extension page, and the run targets a tab id")

# check it parses
import subprocess
r = subprocess.run(["node", "--check", str(p)], capture_output=True, text=True,
                   env={"PATH": "/opt/node24/bin:/usr/bin:/bin"})
print("parse:", "ok" if r.returncode == 0 else r.stderr[:600])