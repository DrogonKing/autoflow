#!/usr/bin/env python3
"""
Finish routing: the post-install handler, the alarm handler's tab use, and both UI pages.

The UI pages matter for the same reason as the worker: `chrome.runtime.sendMessage(msg, cb)` is
Chromium's callback form. Firefox's `chrome.*` alias does not reliably invoke that callback, so the panel
would show "no response" on every action while working perfectly in Chromium.
"""
import pathlib

SRC = pathlib.Path("/root/autoflow/src")
edits = []


def swap(path, old, new, label):
    p = SRC / path
    text = p.read_text()
    n = text.count(old)
    if n == 0:
        raise SystemExit(f"FAILED {label}: not found in {path}")
    p.write_text(text.replace(old, new))
    edits.append(f"{label} ({n}x)")


# --- the post-install handler still calls the side panel directly
swap(
    "background/service-worker.js",
    "    await chrome.sidePanel?.open?.({ windowId: tab.windowId }).catch(() => {});",
    "    await api.side.open({ windowId: tab.windowId });",
    "worker: the action-click handler uses the platform side surface",
)

# --- the alarm handler uses tabs directly
swap(
    "background/service-worker.js",
    """      const tabs = await chrome.tabs.query({});
      const match = tabs.find((t) => patterns.some((p) => (t.url ?? '').includes(p.replace(/\\*/g, ''))));
      if (match) tabId = match.id;
      else if (patterns[0] && !patterns[0].includes('*')) {
        const created = await chrome.tabs.create({ url: patterns[0], active: false });""",
    """      const tabs = await api.tabs.query({});
      const match = tabs.find((t) => patterns.some((p) => (t.url ?? '').includes(p.replace(/\\*/g, ''))));
      if (match) tabId = match.id;
      else if (patterns[0] && !patterns[0].includes('*')) {
        const created = await api.tabs.create({ url: patterns[0], active: false });""",
    "worker: the scheduled-run handler uses the platform tabs",
)

# the earlier action-click replacement produced a duplicate listener; make sure there is exactly one
p = SRC / "background" / "service-worker.js"
text = p.read_text()
OLD_DUP = """api.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId !== undefined) {
    await api.side.open({ windowId: tab.windowId });
  }
});"""
NEW_DUP = """// (the action-click handler is defined once, below, and also falls back to the options page)"""
if OLD_DUP in text and text.count("api.action.onClicked.addListener") > 1:
    text = text.replace(OLD_DUP, NEW_DUP, 1)
    p.write_text(text)
    edits.append("worker: removed the duplicate action-click listener")

# --- the panel
swap(
    "ui/panel/panel.js",
    """const send = (msg) => new Promise((resolve) => {
  chrome.runtime.sendMessage(msg, (res) => resolve(res ?? { ok: false, error: 'no response' }));
});""",
    """/**
 * Send a message to the service worker.
 *
 * NOT the callback form. `chrome.runtime.sendMessage(msg, cb)` is Chromium's shape; on Firefox the
 * `chrome.*` alias is callback-only in a way that does not reliably invoke that callback, so the panel
 * would report "no response" for every action while working perfectly in Chromium. The platform layer
 * returns a promise and works on both.
 */
const send = (msg) => api.runtime.sendMessage(msg)
  .then((res) => res ?? { ok: false, error: 'no response' })
  .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));""",
    "panel: messaging through the platform layer",
)
swap(
    "ui/panel/panel.js",
    "      onclick: () => chrome.runtime.openOptionsPage(),",
    "      onclick: () => api.runtime.openOptionsPage(),",
    "panel: openOptionsPage",
)
swap(
    "ui/panel/panel.js",
    "chrome.runtime.onMessage.addListener((msg) => {",
    "api.runtime.onMessage.addListener((msg) => {",
    "panel: the message listener",
)
swap(
    "ui/panel/panel.js",
    "import { readCsv } from '../../core/io/csv.js';",
    "import { readCsv } from '../../core/io/csv.js';\nimport { api } from '../../platform/api.js';",
    "panel: import the platform layer",
)

# --- the options page
swap(
    "ui/options/options.js",
    """const send = (msg) => new Promise((resolve) => {
  chrome.runtime.sendMessage(msg, (res) => resolve(res ?? { ok: false, error: 'no response' }));
});""",
    """// promise-based, so it works on Firefox as well as Chromium (see ui/panel/panel.js for the reason)
const send = (msg) => api.runtime.sendMessage(msg)
  .then((res) => res ?? { ok: false, error: 'no response' })
  .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));""",
    "options: messaging through the platform layer",
)
swap(
    "ui/options/options.js",
    "  root.append(el('p', { class: 'hint', text: `Version ${chrome.runtime.getManifest().version}` }));",
    """  root.append(el('p', { class: 'hint', text: `Version ${api.runtime.getManifest().version}`
    + ` · ${api.side.kind() === 'sidebar' ? 'Firefox sidebar' : 'Chrome side panel'}` }));""",
    "options: version and platform, through the layer",
)
# the options page needs the import at the top
p = SRC / "ui" / "options" / "options.js"
text = p.read_text()
if "from '../../platform/api.js'" not in text:
    marker = "const el = (tag, props = {}, ...children) => {"
    text = text.replace(marker, "import { api } from '../../platform/api.js';\n\n" + marker, 1)
    p.write_text(text)
    edits.append("options: import the platform layer")

print(f"applied {len(edits)} edits:")
for e in edits:
    print(f"  - {e}")

print("\n=== remaining direct chrome.* in src/ (outside the platform layer) ===")
import re
found = False
for f in sorted(SRC.rglob("*.js")):
    if "platform/api.js" in str(f):
        continue
    t = f.read_text()
    code = re.sub(r"/\*[\s\S]*?\*/", "", t)
    code = re.sub(r"^\s*//.*$", "", code, flags=re.M)
    hits = re.findall(r"\bchrome\.\w+", code)
    if hits:
        found = True
        print(f"  {f.relative_to(SRC)}: {sorted(set(hits))}")
if not found:
    print("  none - every call goes through the platform layer")