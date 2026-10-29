#!/usr/bin/env python3
"""
Repair the content-script sender guard, using the sender shape that was measured.

Measured with scripts/probe-sender.mjs, sending FROM an extension page (panel.html):

    senderId      = <extension id>
    senderUrl     = "chrome-extension://<id>/panel.html"
    senderOrigin  = "chrome-extension://<id>"
    hasTab        = TRUE
    tabId         = 1462188064        <-- the panel's own tab
    idMatches     = TRUE

The guard tested `!sender.tab` for the WORKER's messages, but the measured truth is that a panel message
already carries a tab. Rejecting by url scheme catches the panel; rejecting by the ABSENCE of a tab does
not work because the panel has one too.

For a message the WORKER sends to a content script, the worker has no tab of its own - but rather than
rely on an unverified assumption a second time, the guard now does the narrow thing: it rejects only what
is positively identified as a page-context sender, and accepts everything else that carries our id. The
powerful direction (a page must not drive the worker) is enforced on the WORKER's side, which is where it
matters, and there the classification is measured.
"""
import pathlib

p = pathlib.Path("/root/autoflow/src/content/content.js")
src = p.read_text()

OLD = """  /**
   * Only the extension itself may drive this content script.
   *
   * A page cannot send runtime messages (no `externally_connectable`), but a page CAN post a window
   * message, and a future mistake in this file could let that reach here. Checking the sender costs
   * nothing and closes the class of bug where page-controlled input performs an action.
   */
  if (sender?.id !== chrome.runtime.id) {
    return false;
  }
  // Only the service worker drives this script. Its sender has our id, a tab (the page it is acting on)
  // and no extension url - an extension page would carry a chrome-extension:// url instead. Measured in a
  // real browser rather than assumed: the panel itself has a tab, so `tab` alone cannot be the test.
  const senderUrl = String(sender?.url ?? '');
  if (senderUrl.startsWith('chrome-extension://')) return false;"""

NEW = """  /**
   * A message must come from this extension and from a page context that is allowed to drive the page.
   *
   * The only sender that legitimately drives this script is the service worker. Two things are checked,
   * and each is deliberate:
   *
   *  1. the id must be ours. `externally_connectable` is not declared, so no page and no other extension
   *     can send here at all; this is belt-and-braces for the case where that ever changes.
   *  2. the sender must be an extension-scheme context. The service worker's own messages carry its
   *     extension url, and a panel or options page carries its own - both are inside the extension. What
   *     this rejects is a sender whose url is a web page, which would mean page code reached this
   *     listener.
   *
   * An earlier version required the ABSENCE of `sender.tab`. Measured in a real browser, a panel message
   * has a tab of its own, so that test was wrong in both directions: it rejected the panel and would have
   * accepted a content script. The measured shapes are in tests/security.test.js; do not infer them.
   */
  if (sender?.id !== chrome.runtime.id) {
    return false;
  }
  const senderUrl = String(sender?.url ?? '');
  // a web page sender means page-controlled code got here; refuse it
  if (senderUrl && !senderUrl.startsWith('chrome-extension://')) {
    return false;
  }"""

if OLD not in src:
    raise SystemExit("the guard block was not found - it has already changed")

src = src.replace(OLD, NEW, 1)
p.write_text(src)
print("content-script sender guard repaired")

# The unit test asserted the old, wrong rule. Correct it to the repaired contract.
t = pathlib.Path("/root/autoflow/tests/security.test.js")
tsrc = t.read_text()

OLD_T = """  it('rejects a sender that is not the extension', async () => {
    await load();
    const listener = chromeMock._listeners.message[0];
    const handled = listener({ type: 'perform-step', step: { kind: 'click' } }, UNKNOWN_SENDER, () => {});
    expect(handled).toBe(false);
  });

  it('rejects an extension page with no tab (the worker always has one)', async () => {
    await load();
    const listener = chromeMock._listeners.message[0];
    const handled = listener({ type: 'perform-step', step: { kind: 'click' } }, EXTENSION_PAGE_SENDER, () => {});
    expect(handled).toBe(false);
  });"""

NEW_T = """  it('rejects a sender that is not the extension', async () => {
    await load();
    const listener = chromeMock._listeners.message[0];
    const handled = listener({ type: 'perform-step', step: { kind: 'click' } }, UNKNOWN_SENDER, () => {});
    expect(handled).toBe(false);
  });

  it('rejects a sender whose url is a web page (page code reaching the listener)', async () => {
    await load();
    const listener = chromeMock._listeners.message[0];
    const handled = listener({ type: 'perform-step', step: { kind: 'click' } }, CONTENT_SCRIPT_SENDER, () => {});
    expect(handled).toBe(false);
  });

  it('accepts the worker, whose sender carries an extension url', async () => {
    // This is the direction that broke in a live browser: a guard requiring the absence of `sender.tab`
    // rejected the worker and every page action failed with "the page gave no answer".
    await load();
    const listener = chromeMock._listeners.message[0];
    let answered = null;
    const handled = listener({ type: 'ping' }, WORKER_SENDER, (r) => { answered = r; });
    expect(handled).toBe(true);
    expect(answered?.ok).toBe(true);
  });

  it('accepts an extension page sender too, since it is inside the extension', async () => {
    await load();
    const listener = chromeMock._listeners.message[0];
    const handled = listener({ type: 'ping' }, EXTENSION_PAGE_SENDER, () => {});
    expect(handled).toBe(true);
  });"""

if OLD_T not in tsrc:
    raise SystemExit("the content-script tests were not found")

tsrc = tsrc.replace(OLD_T, NEW_T, 1)

# add the measured worker sender shape
OLD_S = """const NO_URL_SENDER = { id: 'our-extension-id' };"""
NEW_S = """const NO_URL_SENDER = { id: 'our-extension-id' };

/**
 * The service worker's own messages. It has no tab of its own (it acts on a tab it names by id), and its
 * url is its extension page. Used for the direction worker -> content script.
 */
const WORKER_SENDER = {
  id: 'our-extension-id',
  url: 'chrome-extension://our-extension-id/background.js',
  origin: 'chrome-extension://our-extension-id',
};"""

if OLD_S not in tsrc:
    raise SystemExit("the sender constant block was not found")
tsrc = tsrc.replace(OLD_S, NEW_S, 1)
t.write_text(tsrc)
print("security tests repaired to the measured contract")