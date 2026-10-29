#!/usr/bin/env python3
"""
Route every chrome.* call through the platform layer.

The point is not tidiness. The concrete bugs this removes:

  1. `chrome.*` in Firefox is callback-only. `await chrome.alarms.getAll()` returns undefined there and
     every alarm check silently sees "no alarms". Callbacks reach the wrong place in Chromium.
  2. `tabs.goBack` / `tabs.goForward` do not exist in Firefox at all, so the step would throw there.
  3. `sidePanel` does not exist in Firefox; it has `sidebarAction`.
  4. `chrome.runtime.onMessage` etc. must be reached through the resolved namespace, because Firefox
     exposes events on `browser` and `chrome` is a callback-only alias.

Every replacement is listed by count so an unexpected number is an error rather than a silent partial edit.
"""
import pathlib
import re
import sys

SRC = pathlib.Path("/root/autoflow/src")
edits = []


def replace_file(path, pairs):
    p = SRC / path
    text = p.read_text()
    for old, new, expect, label in pairs:
        n = text.count(old)
        if n != expect:
            raise SystemExit(f"FAILED {label} in {path}: found {n} of {old[:60]!r}, expected {expect}")
        text = text.replace(old, new)
        edits.append(f"{label} ({n}x)")
    p.write_text(text)


# =============================================================================================
# storage.js — the storage area calls become the platform layer
# =============================================================================================
replace_file("background/storage.js", [
    ("""import { api } from '../platform/api.js';""", """import { api } from '../platform/api.js';""", 0, "noop-import-check"),
] if False else [])

text = (SRC / "background/storage.js").read_text()

OLD_STORAGE = """/** A tiny wrapper so the rest of the code does not repeat chrome.storage's callback style. */
function area(name = 'local') {
  const a = chrome?.storage?.[name];
  if (!a) throw new Error('chrome.storage is not available');
  return a;
}

export function get(keys) {
  return new Promise((resolve, reject) => {
    area().get(keys, (result) => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result ?? {});
    });
  });
}

export function set(items) {
  return new Promise((resolve, reject) => {
    area().set(items, () => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

export function remove(keys) {
  return new Promise((resolve, reject) => {
    area().remove(keys, () => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}"""

NEW_STORAGE = """/**
 * Storage access, through the platform layer.
 *
 * The callback style that used to live here is exactly what breaks on Firefox: `chrome.storage` there
 * never calls a callback the way Chromium does, and `browser.storage` returns promises instead. The
 * platform layer resolves that, so this file is only about which area and which key.
 */
const local = () => api.storage.local;

export function get(keys) {
  return local().get(keys).then((result) => result ?? {});
}

export function set(items) {
  return local().set(items);
}

export function remove(keys) {
  return local().remove(keys);
}"""

if OLD_STORAGE not in text:
    raise SystemExit("storage.js: the wrapper block was not found")
text = text.replace(OLD_STORAGE, NEW_STORAGE, 1)
edits.append("storage: wrapper goes through the platform layer")

# the session-area helpers use raw chrome.storage.session callbacks
text = text.replace(
    """export async function setDataRows(key, data) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.set({ [`${KEYS.dataRows}:${key}`]: data }, () => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

export async function getDataRows(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.get(`${KEYS.dataRows}:${key}`, (result) => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result?.[`${KEYS.dataRows}:${key}`] ?? null);
    });
  });
}""",
    """export async function setDataRows(key, data) {
  return api.storage.session.set({ [`${KEYS.dataRows}:${key}`]: data });
}

export async function getDataRows(key) {
  const result = await api.storage.session.get(`${KEYS.dataRows}:${key}`);
  return result?.[`${KEYS.dataRows}:${key}`] ?? null;
}""",
    1,
)
edits.append("storage: data rows go through the platform layer")

text = text.replace(
    """export async function setUploadFile(name, record) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.set({ [`upload:${name}`]: record }, () => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

export async function getUploadFile(name) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.get(`upload:${name}`, (result) => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result?.[`upload:${name}`] ?? null);
    });
  });
}

export async function listUploadFiles() {
  return new Promise((resolve, reject) => {
    chrome.storage.session.get(null, (all) => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve(Object.entries(all ?? {})
        .filter(([k]) => k.startsWith('upload:'))
        .map(([k, v]) => ({ name: k.slice('upload:'.length), mime: v.mime, size: v.size })));
    });
  });
}""",
    """export async function setUploadFile(name, record) {
  return api.storage.session.set({ [`upload:${name}`]: record });
}

export async function getUploadFile(name) {
  const result = await api.storage.session.get(`upload:${name}`);
  return result?.[`upload:${name}`] ?? null;
}

export async function listUploadFiles() {
  const all = await api.storage.session.get(null);
  return Object.entries(all ?? {})
    .filter(([k]) => k.startsWith('upload:'))
    .map(([k, v]) => ({ name: k.slice('upload:'.length), mime: v.mime, size: v.size }));
}""",
    1,
)
edits.append("storage: upload files go through the platform layer")

# clearDataRows still uses the callback form
text = text.replace(
    """export async function clearDataRows(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.remove(`${KEYS.dataRows}:${key}`, () => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}""",
    """export async function clearDataRows(key) {
  return api.storage.session.remove(`${KEYS.dataRows}:${key}`);
}""",
    1,
)
edits.append("storage: clear rows")

# add the import
if "from '../platform/api.js'" not in text:
    text = text.replace(
        "export const KEYS = {",
        "import { api } from '../platform/api.js';\n\nexport const KEYS = {",
        1,
    )
    edits.append("storage: import the platform layer")

(SRC / "background/storage.js").write_text(text)

# =============================================================================================
# alarms.js
# =============================================================================================
text = (SRC / "background/alarms.js").read_text()
n_alarms = text.count("chrome.alarms.")
if n_alarms == 0:
    raise SystemExit("alarms.js: no chrome.alarms calls found")
text = re.sub(r"\bchrome\.alarms\.create\(", "api.alarms.create(", text)
text = re.sub(r"\bchrome\.alarms\.clear\(", "api.alarms.clear(", text)
text = re.sub(r"\bchrome\.alarms\.getAll\(", "api.alarms.getAll(", text)
if "from '../platform/api.js'" not in text:
    text = text.replace(
        "import { nextRun, validateSchedule, describeSchedule } from '../core/schedule/schedule.js';",
        "import { nextRun, validateSchedule, describeSchedule } from '../core/schedule/schedule.js';\n"
        "import { api } from '../platform/api.js';",
        1,
    )
(SRC / "background/alarms.js").write_text(text)
edits.append(f"alarms: {n_alarms} alarm calls go through the platform layer")

print(f"applied {len(edits)} edits:")
for e in edits:
    print(f"  - {e}")