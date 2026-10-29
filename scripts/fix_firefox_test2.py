#!/usr/bin/env python3
"""
Make the Firefox test able to reach an extension page.

WebDriver refuses to navigate to a `moz-extension://` URL:

    unsupported operation: Navigation to "moz-extension://.../panel.html" is not allowed in this context

That is a capability restriction, not a permission problem: the driver has no way to authorise a
navigation into an extension origin. The way around it is to have the BROWSER open the tab, in the
privileged chrome context, and then let the driver switch to the tab that appeared.

This also means the test exercises the real path: `browser.*` is reachable only from an extension page, so
an extension page is the only honest place to drive the extension from.
"""
import pathlib

p = pathlib.Path("/root/autoflow/scripts/firefox-test.mjs")
src = p.read_text()

# ---- 1. add the context + handle helpers to the WebDriver class
OLD_CLASS_TAIL = """  async execute(script, args = []) {
    const v = await this.request('POST', `/session/${this.sessionId}/execute`, {
      script, args,
    });
    return v;
  }
}"""

NEW_CLASS_TAIL = """  async execute(script, args = []) {
    const v = await this.request('POST', `/session/${this.sessionId}/execute`, {
      script, args,
    });
    return v;
  }

  /** geckodriver extension: run the script in the browser chrome process instead of the page. */
  async setContext(context) {
    return this.request('POST', `/session/${this.sessionId}/moz/context`, { context });
  }

  async handles() {
    return this.request('GET', `/session/${this.sessionId}/window/handles`);
  }

  async currentHandle() {
    return this.request('GET', `/session/${this.sessionId}/window`);
  }

  async switchTo(handle) {
    return this.request('POST', `/session/${this.sessionId}/window`, { handle });
  }

  /**
   * Open an extension page and return the driver handle for it.
   *
   * The driver cannot navigate to `moz-extension://`, so the browser opens the tab in the chrome context
   * and the driver then finds which handle is new. Diffing the handle list avoids depending on how a
   * handle is encoded, which differs between Firefox versions.
   */
  async openExtensionPage(url) {
    const before = await this.handles().catch(() => []);

    await this.setContext('chrome');
    let opened = null;
    try {
      opened = await this.execute(`
        const url = arguments[0];
        const tab = gBrowser.addTab(url, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          inBackground: false,
        });
        return { ok: true, label: String(tab.label || ''), href: String(tab.linkedBrowser.currentURI.spec) };
      `, [url]);
    } finally {
      await this.setContext('content');
    }

    // the new tab takes a moment to register with the driver
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const now = await this.handles().catch(() => []);
      const added = now.filter((h) => !before.includes(h));
      if (added.length) return { handle: added[0], opened };
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`the extension page did not appear as a driver handle (opened: ${JSON.stringify(opened)})`);
  }
}"""

if OLD_CLASS_TAIL not in src:
    raise SystemExit("the WebDriver class tail was not found")
src = src.replace(OLD_CLASS_TAIL, NEW_CLASS_TAIL, 1)

# ---- 2. the panel navigation becomes openExtensionPage + switchTo
OLD_NAV = """    const panelUrl = `moz-extension://${addonId}/panel.html`;
    await wd.navigate(panelUrl);
    await new Promise((r) => setTimeout(r, 1500));"""

NEW_NAV = """    const panelUrl = `moz-extension://${addonId}/panel.html`;
    // Not wd.navigate: the driver refuses to navigate into an extension origin, so the browser opens it.
    const panelTab = await wd.openExtensionPage(panelUrl);
    await wd.switchTo(panelTab.handle);
    await new Promise((r) => setTimeout(r, 2000));
    check('an extension page can be opened and reached', true, `handle ${panelTab.handle}`);"""

if OLD_NAV not in src:
    raise SystemExit("the panel navigation block was not found")
src = src.replace(OLD_NAV, NEW_NAV, 1)

# ---- 3. the second navigation back to the panel (before the run) needs the same treatment
OLD_RETURN = """    // Find the tab id for the test page from the extension side, then run against it explicitly. The run
    // is targeted by `tabId` rather than the active tab, so the test does not depend on which tab Firefox
    // considers focused in headless mode.
    await wd.navigate(panelUrl);
    await new Promise((r) => setTimeout(r, 800));"""

NEW_RETURN = """    // Find the tab id for the test page from the extension side, then run against it explicitly. The run
    // is targeted by `tabId` rather than the active tab, so the test does not depend on which tab Firefox
    // considers focused in headless mode. The panel tab is still open, so it is switched back to.
    await wd.switchTo(panelTab.handle);
    await new Promise((r) => setTimeout(r, 800));"""

if OLD_RETURN not in src:
    raise SystemExit("the panel return block was not found")
src = src.replace(OLD_RETURN, NEW_RETURN, 1)

# ---- 4. after the run, going back to the page: switch by URL rather than navigate, so the extension tab
#        is not lost. Actually the test page tab is still open, so find it again by navigating a new page.
OLD_READBACK = """    // read the page back
    await wd.navigate(pageUrl);
    await new Promise((r) => setTimeout(r, 1200));"""

NEW_READBACK = """    // read the page back. The driver's current handle is the extension tab, so switch to the test page's
    // handle; navigating would be refused or would replace the extension tab.
    if (testTabHandle) {
      await wd.switchTo(testTabHandle);
      await new Promise((r) => setTimeout(r, 500));
    } else {
      await wd.navigate(pageUrl);
      await new Promise((r) => setTimeout(r, 1200));
    }"""

if OLD_READBACK not in src:
    raise SystemExit("the read-back block was not found")
src = src.replace(OLD_READBACK, NEW_READBACK, 1)

# ---- 5. remember the test page's handle when it is first opened
OLD_FIRST_PAGE = """    // ---- a real page action, through the content script
    await wd.navigate(pageUrl);
    await new Promise((r) => setTimeout(r, 2500));"""

NEW_FIRST_PAGE = """    // ---- a real page action, through the content script
    await wd.navigate(pageUrl);
    // remember this handle: the test switches between the page and the extension tab, and Firefox has one
    // handle per top-level context
    const testTabHandle = await wd.currentHandle();
    await new Promise((r) => setTimeout(r, 2500));"""

if OLD_FIRST_PAGE not in src:
    raise SystemExit("the first page-open block was not found")
src = src.replace(OLD_FIRST_PAGE, NEW_FIRST_PAGE, 1)

p.write_text(src)
print("firefox-test.mjs: extension pages are opened by the browser, and the driver switches handles")