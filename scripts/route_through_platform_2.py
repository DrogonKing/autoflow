#!/usr/bin/env python3
"""
Route the service worker and content script through the platform layer.

The specific Firefox failures being removed:

  tabs.goBack / tabs.goForward   do not exist in Firefox -> the step threw
  sidePanel.*                    does not exist in Firefox -> the panel never opened
  chrome.scripting.executeScript callback form is Chromium-only
  chrome.tabs.sendMessage(msg, cb) callback form is Chromium-only
  chrome.runtime.onMessage must come from the resolved namespace
"""
import pathlib
import re

SRC = pathlib.Path("/root/autoflow/src")
edits = []

# =============================================================================================
# service-worker.js
# =============================================================================================
p = SRC / "background" / "service-worker.js"
text = p.read_text()

# --- the send-to-tab helper
text = text.replace(
    """async function sendToTab(tabId, message, { injectIfMissing = true } = {}) {
  try {
    return await withTimeout(chrome.tabs.sendMessage(tabId, message), 20_000, `message ${message.type}`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    const missing = /Receiving end does not exist|Could not establish connection|message channel closed/i.test(msg);
    if (!missing || !injectIfMissing) throw e;
    // inject and retry once
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['content.js'],
    });
    await new Promise((r) => setTimeout(r, 150));
    return withTimeout(chrome.tabs.sendMessage(tabId, message), 20_000, `message ${message.type} (retry)`);
  }
}""",
    """async function sendToTab(tabId, message, { injectIfMissing = true } = {}) {
  try {
    return await withTimeout(api.tabs.sendMessage(tabId, message), 20_000, `message ${message.type}`);
  } catch (e) {
    // Each browser words this differently:
    //   Chromium: "Could not establish connection. Receiving end does not exist."
    //   Firefox:  "Could not establish connection. Receiving end does not exist."
    //            or "The message port closed before a response was received."
    // All of them mean the same thing here: this tab has no content script yet.
    const msg = String(e?.message ?? e);
    const missing = /Receiving end does not exist|Could not establish connection|message port closed|message channel closed/i.test(msg);
    if (!missing || !injectIfMissing) throw e;
    await api.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['content.js'],
    });
    await new Promise((r) => setTimeout(r, 200));
    return withTimeout(api.tabs.sendMessage(tabId, message), 20_000, `message ${message.type} (retry)`);
  }
}""",
    1,
)
edits.append("worker: sendToTab through the platform layer")

# --- tab operations inside makeHost
pairs = [
    ("await chrome.tabs.get(tabId).catch(() => null)", "await api.tabs.get(tabId).catch(() => null)"),
    ("await chrome.tabs.update(tabId, { url: step.url });", "await api.tabs.update(tabId, { url: step.url });"),
    ("await chrome.tabs.reload(tabId, step.bypassCache ? { bypassCache: true } : {});",
     "await api.tabs.reload(tabId, step.bypassCache ? { bypassCache: true } : undefined);"),
    ("await chrome.tabs.create({ url: step.url, active: step.active !== false });",
     "await api.tabs.create({ url: step.url, active: step.active !== false });"),
    ("const tabs = await chrome.tabs.query({ currentWindow: true });",
     "const tabs = await api.tabs.query({ currentWindow: true });"),
    ("await chrome.tabs.update(target.id, { active: true });", "await api.tabs.update(target.id, { active: true });"),
    ("await chrome.tabs.remove(id);", "await api.tabs.remove(id);"),
    ("await chrome.notifications.create(`autoflow-${Date.now()}`, {", "await api.notifications.create(`autoflow-${Date.now()}`, {"),
    ("await chrome.notifications.create(`autoflow-beep-${Date.now()}`, {", "await api.notifications.create(`autoflow-beep-${Date.now()}`, {"),
    ("const id = await chrome.downloads.download({", "const id = await api.downloads.download({"),
    ("const tab = await chrome.tabs.get(tabId);\n          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });",
     "const tab = await api.tabs.get(tabId);\n          const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });"),
    ("await chrome.downloads.download({ url: dataUrl, filename: step.filename });",
     "await api.downloads.download({ url: dataUrl, filename: step.filename });"),
]
for old, new in pairs:
    n = text.count(old)
    if n == 0:
        raise SystemExit(f"worker: not found -> {old[:70]}")
    text = text.replace(old, new)
    edits.append(f"worker: {old[:44].strip()} ({n}x)")

# --- goBack / goForward, which Firefox lacks entirely
text = text.replace(
    """        case 'back':
        case 'forward': {
          await chrome.tabs.goBack?.(tabId).catch(() => chrome.tabs.update(tabId, {}));
          if (step.kind === 'forward') {
            await chrome.tabs.goForward?.(tabId).catch(() => {});
          }
          await waitForLoad();
          await new Promise((r) => setTimeout(r, opts.navigationSettleMs ?? 800));
          await waitForContent();
          return { [step.kind]: true };
        }""",
    """        case 'back':
        case 'forward': {
          // Firefox has no tabs.goBack/goForward at all; the platform layer reports "not available"
          // instead of throwing, so the step degrades to a no-op that the trace records honestly rather
          // than failing the whole run on a browser where history navigation is simply not reachable.
          const done = step.kind === 'back'
            ? await api.tabs.goBack(tabId)
            : await api.tabs.goForward(tabId);
          if (done === false) {
            return { [step.kind]: false, note: 'history navigation is not available in this browser' };
          }
          await waitForLoad();
          await new Promise((r) => setTimeout(r, opts.navigationSettleMs ?? 800));
          await waitForContent();
          return { [step.kind]: true };
        }""",
    1,
)
edits.append("worker: back/forward degrade honestly where unsupported")

# --- the event listeners must come from the resolved namespace
text = text.replace("chrome.runtime.onInstalled.addListener", "api.runtime.onInstalled.addListener", 1)
text = text.replace("chrome.runtime.onStartup.addListener", "api.runtime.onStartup.addListener", 1)
text = text.replace("chrome.alarms.onAlarm.addListener", "api.alarms.onAlarm.addListener", 1)
text = text.replace("chrome.commands.onCommand.addListener", "api.commands.onCommand.addListener", 1)
text = text.replace("chrome.action.onClicked.addListener", "api.action.onClicked.addListener", 1)
text = text.replace("chrome.runtime.onMessage.addListener", "api.runtime.onMessage.addListener", 1)
edits.append("worker: all event listeners via the platform layer")

# --- the side surface
text = text.replace(
    """  await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});""",
    """  // Chromium: the side panel. Firefox: the sidebar. The platform layer picks.
  await api.side.enableOpenOnClick();""",
    1,
)
text = text.replace(
    """chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId !== undefined) {
    await chrome.sidePanel?.open?.({ windowId: tab.windowId }).catch(() => {});
  }
});""",
    """api.action.onClicked.addListener(async (tab) => {
  // Firefox requires this to happen inside the user gesture of the click, which is exactly here.
  const opened = await api.side.open({ windowId: tab?.windowId });
  if (!opened && tab?.id) {
    // Neither API is available (an old build, or a sidebar the user has not enabled): fall back to the
    // options page so the click is never a dead end.
    await api.runtime.openOptionsPage().catch(() => {});
  }
});""",
    1,
)
edits.append("worker: side surface via the platform layer, with a fallback")

# --- the remaining direct chrome.* calls
for old, new in [
    ("chrome.tabs.query({ active: true, currentWindow: true })", "api.tabs.query({ active: true, currentWindow: true })"),
    ("chrome.tabs.sendMessage(tab.id, { type: 'start-picking' })", "api.tabs.sendMessage(tab.id, { type: 'start-picking' })"),
    ("chrome.tabs.sendMessage(tab.id, { type: 'stop-picking' })", "api.tabs.sendMessage(tab.id, { type: 'stop-picking' })"),
    ("chrome.tabs.sendMessage(targetTabId, {", "api.tabs.sendMessage(targetTabId, {"),
    ("chrome.storage.session.set({ activeRun: publicActiveRun() });", "api.storage.session.set({ activeRun: publicActiveRun() });"),
    ("chrome.storage.session.remove('activeRun');", "api.storage.session.remove('activeRun');"),
    ("chrome.alarms.getAll()", "api.alarms.getAll()"),
    ("chrome.alarms.clear(a.name)", "api.alarms.clear(a.name)"),
    ("chrome.runtime.sendMessage({ type: 'trace', entry, automationId }).catch(() => {});",
     "api.runtime.sendMessage({ type: 'trace', entry, automationId }).catch(() => {});"),
    ("chrome.runtime.sendMessage({ type: 'run-finished', run: finished }).catch(() => {});",
     "api.runtime.sendMessage({ type: 'run-finished', run: finished }).catch(() => {});"),
    ("chrome.runtime.sendMessage({ type: 'element-picked', info: msg.info, finder: msg.finder }).catch(() => {});",
     "api.runtime.sendMessage({ type: 'element-picked', info: msg.info, finder: msg.finder }).catch(() => {});"),
    ("chrome.runtime.getURL('icons/128.png')", "api.runtime.getURL('icons/128.png')"),
    ("chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }).catch(() => {});",
     "api.tabs.create({ url: api.runtime.getURL('options.html') }).catch(() => {});"),
    ("chrome.action.setBadgeText({ text: s?.text ?? '' });", "api.action.setBadgeText({ text: s?.text ?? '' });"),
    ("await chrome.action.setBadgeBackgroundColor({ color: s.color });", "await api.action.setBadgeBackgroundColor({ color: s.color });"),
]:
    n = text.count(old)
    if n == 0:
        raise SystemExit(f"worker: not found -> {old[:80]}")
    text = text.replace(old, new)
    edits.append(f"worker: {old[:46].strip()} ({n}x)")

# the runtime.id checks must use the resolved namespace too
text = text.replace("sender?.id !== chrome.runtime.id", "sender?.id !== api.id")
text = text.replace("url.startsWith(`chrome-extension://${chrome.runtime.id}`)", "url.startsWith(`chrome-extension://${api.id}`)")
text = text.replace("sender?.id === chrome.runtime.id", "sender?.id === api.id")
text = text.replace("chrome.runtime.getManifest()", "api.runtime.getManifest()")

if "from '../platform/api.js'" not in text:
    text = text.replace(
        "import { Runner } from '../core/engine/runner.js';",
        "import { Runner } from '../core/engine/runner.js';\nimport { api } from '../platform/api.js';",
        1,
    )
    edits.append("worker: import the platform layer")

p.write_text(text)

# =============================================================================================
# content.js
# =============================================================================================
p = SRC / "content" / "content.js"
text = p.read_text()

for old, new in [
    ("chrome.runtime.sendMessage({ type: 'element-picked', info, finder });",
     "api.runtime.sendMessage({ type: 'element-picked', info, finder }).catch(() => {});"),
    ("chrome.runtime.sendMessage({ type: 'element-pick-cancelled' });",
     "api.runtime.sendMessage({ type: 'element-pick-cancelled' }).catch(() => {});"),
    ("const res = await chrome.runtime.sendMessage({ type: 'read-file-for-upload', name });",
     "const res = await api.runtime.sendMessage({ type: 'read-file-for-upload', name });"),
    ("chrome.runtime.onMessage.addListener", "api.runtime.onMessage.addListener"),
    ("if (sender?.id !== chrome.runtime.id) {", "if (sender?.id !== api.id) {"),
    ("document.documentElement.setAttribute('data-autoflow-content', chrome.runtime.getManifest().version);",
     "document.documentElement.setAttribute('data-autoflow-content', api.runtime.getManifest().version);"),
    ("""chrome.runtime.sendMessage({
  type: 'content-ready',
  url: location.href,
  isTop: window.top === window,
}).catch(() => {});""",
     """api.runtime.sendMessage({
  type: 'content-ready',
  url: location.href,
  isTop: window.top === window,
}).catch(() => {});"""),
]:
    n = text.count(old)
    if n == 0:
        raise SystemExit(f"content: not found -> {old[:80]}")
    text = text.replace(old, new)
    edits.append(f"content: {old[:46].strip()} ({n}x)")

if "from '../platform/api.js'" not in text:
    text = text.replace(
        "import { findElement, describeElement, buildFinder, isVisible } from '../core/dom/finder.js';",
        "import { api } from '../platform/api.js';\nimport { findElement, describeElement, buildFinder, isVisible } from '../core/dom/finder.js';",
        1,
    )
    edits.append("content: import the platform layer")

p.write_text(text)

print(f"applied {len(edits)} edits:")
for e in edits:
    print(f"  - {e}")

# how many direct calls remain?
print("\n=== remaining direct chrome.* references in src/ ===")
for f in sorted(SRC.rglob("*.js")):
    t = f.read_text()
    # ignore the platform layer itself and comments
    code = re.sub(r"/\*[\s\S]*?\*/", "", t)
    code = re.sub(r"^\s*//.*$", "", code, flags=re.M)
    hits = re.findall(r"\bchrome\.\w+", code)
    if hits and "platform/api.js" not in str(f):
        print(f"  {f.relative_to(SRC)}: {sorted(set(hits))}")