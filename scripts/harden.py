#!/usr/bin/env python3
"""
Security hardening pass.

Each change here maps to a finding from scripts/security_scan.py and scripts/security_audit.py. The
reasoning is in the code comments so a future reader sees why, not just what.
"""
import pathlib
import re
import sys

SRC = pathlib.Path("/root/autoflow/src")
changes = []


def edit(path, old, new, label, required=True):
    p = SRC / path
    text = p.read_text()
    if old not in text:
        if required:
            raise SystemExit(f"FAILED {label}: anchor not found in {path}")
        return False
    if text.count(old) != 1:
        raise SystemExit(f"FAILED {label}: anchor appears {text.count(old)} times in {path}")
    p.write_text(text.replace(old, new, 1))
    changes.append(label)
    return True


def edit_all(path, old, new, label, expect=None):
    p = SRC / path
    text = p.read_text()
    n = text.count(old)
    if n == 0:
        raise SystemExit(f"FAILED {label}: anchor not found in {path}")
    if expect is not None and n != expect:
        raise SystemExit(f"FAILED {label}: expected {expect} occurrences, found {n}")
    p.write_text(text.replace(old, new))
    changes.append(f"{label} ({n}x)")
    return n


# =============================================================================================
# FINDING 4 — the innerHTML sink in the el() helper
# =============================================================================================
# The prop is never used anywhere, so it is dead code that exists only as a latent XSS sink. Deleting it
# is strictly better than guarding it: there is no call site to keep working.
edit(
    "ui/panel/panel.js",
    """    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);""",
    """    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    // There is deliberately no `html` prop. It existed and was never used, so it was a latent XSS sink:
    // a template value or an extracted page value could have been interpolated into markup inside an
    // extension page, which runs with more privilege than the page itself. Use `text` instead - it
    // cannot carry markup - and build structure with elements.
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);""",
    "S1: removed the unused innerHTML sink from the panel helper",
)

edit(
    "ui/options/options.js",
    """    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);""",
    """    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    // no `html` prop, for the same reason as the panel helper: textContent cannot carry markup
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);""",
    "S1b: same removal in the options helper",
)

# =============================================================================================
# FINDING 3 — sender validation in the background message handler
# =============================================================================================
edit(
    "background/service-worker.js",
    """chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  const handle = async () => {""",
    """/**
 * Which messages a CONTENT SCRIPT is allowed to send.
 *
 * The background listener is reachable from every content-script instance, and this extension injects into
 * every page (`<all_urls>` with `all_frames: true`). A frame from any origin therefore has a content
 * script in it. The page itself cannot call `chrome.runtime.sendMessage` - `externally_connectable` is
 * not declared, which is deliberate - but the content script can, and an attacker who finds any way to
 * drive it must not be able to start runs or delete data.
 *
 * So the rule is a positive list, by the sender's shape:
 *   - a content script has a `sender.tab` and its `sender.url` is an http(s) page
 *   - an extension page (the panel, the options page) has no `sender.tab`, and its origin is our own
 * Anything else is refused.
 */
const CONTENT_SCRIPT_MESSAGES = new Set([
  'content-ready',
  'element-picked',
  'element-pick-cancelled',
  'run-status',
]);

function classifySender(sender) {
  // Our own extension pages: no tab, and the origin is the extension itself.
  if (!sender?.tab && sender?.id === chrome.runtime.id) return 'extension-page';
  // A content script: it has a tab and the sender url is a web page, not an extension page.
  if (sender?.tab && /^https?:/i.test(sender.url ?? sender.tab.url ?? '')) return 'content-script';
  return 'unknown';
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  const origin = classifySender(sender);

  // Refuse anything from an unrecognised sender outright, rather than trying to reason about it.
  if (origin === 'unknown') {
    try {
      sendResponse({ ok: false, error: 'refused: unrecognised message sender' });
    } catch { /* port closed */ }
    return true;
  }

  // A content script gets the small positive list and nothing else. This is what stops a page-side
  // context from starting a run, changing settings, or deleting an automation.
  if (origin === 'content-script' && !CONTENT_SCRIPT_MESSAGES.has(msg.type)) {
    try {
      sendResponse({ ok: false, error: `refused: a page cannot send "${msg.type}"` });
    } catch { /* port closed */ }
    return true;
  }

  const handle = async () => {""",
    "S2: background message handler now classifies and restricts the sender",
)

# The content script's own listener has the mirror-image rule: only the extension may talk to it.
edit(
    "content/content.js",
    """chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  switch (msg.type) {""",
    """chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  /**
   * Only the extension itself may drive this content script.
   *
   * A page cannot send runtime messages (no `externally_connectable`), but a page CAN post a window
   * message, and a future mistake in this file could let that reach here. Checking the sender costs
   * nothing and closes the class of bug where page-controlled input performs an action.
   */
  if (sender?.id !== chrome.runtime.id) {
    return false;
  }
  // An extension page must not be able to trigger page actions by mistake either: every message this
  // script accepts is sent by the service worker, which always has a sender.tab.
  if (!sender?.tab) return false;

  switch (msg.type) {""",
    "S3: content script now rejects any sender that is not the extension's own worker",
)

# =============================================================================================
# FINDING 2 — import validation
# =============================================================================================
storage_import_old = """export async function importAll(doc, { replace = false } = {}) {
  const incoming = Array.isArray(doc) ? doc : doc?.automations;
  if (!Array.isArray(incoming)) throw new Error('the file does not contain a list of automations');

  const existing = replace ? [] : await listAutomations();
  const byId = new Map(existing.map((a) => [a.id, a]));
  const imported = [];
  const skipped = [];

  incoming.forEach((raw, i) => {
    try {
      const a = migrateAutomation(raw);
      if (!a.name || !Array.isArray(a.steps) || a.steps.length === 0) {
        throw new Error('missing a name or steps');
      }
      // a re-import must not overwrite a local automation with the same id unless replacing
      if (byId.has(a.id) && !replace) {
        a.id = `${a.id}-imported-${i}`;
      }
      byId.set(a.id, a);
      imported.push(a);
    } catch (e) {
      skipped.push({ index: i, name: raw?.name ?? '(unnamed)', reason: e.message });
    }
  });

  const merged = [...byId.values()];
  await set({ [KEYS.automations]: merged, [KEYS.schemaVersion]: CURRENT_SCHEMA });
  return { imported: imported.length, skipped };
}"""

storage_import_new = '''/**
 * Step kinds an imported file is allowed to contain without a warning.
 *
 * `runScript` is deliberately excluded. An automation file is something a user downloads from a forum or
 * receives from a colleague, and a `runScript` step is arbitrary JavaScript executed in whatever page the
 * automation later runs on - with access to that page's session, forms and data. A file that carries one
 * must not be imported silently, so it is flagged and the caller decides.
 *
 * The same reasoning applies to a `goto` step pointing at a remote host, which is how a run could be
 * pointed at an endpoint that receives a template value.
 */
const STEP_KINDS_WITHOUT_WARNING = new Set([
  'click', 'fill', 'clear', 'check', 'select', 'hover', 'focus', 'blur', 'submit', 'scroll',
  'key', 'wait', 'waitFor', 'goto', 'reload', 'back', 'forward', 'newTab', 'switchTab', 'closeTab',
  'loop', 'if', 'setVariable', 'extract', 'notify', 'sound', 'download', 'screenshot',
  'stop', 'break', 'continue',
]);

/** Every step in an automation, including nested ones inside loops and branches. */
function allSteps(steps, out = []) {
  for (const s of steps ?? []) {
    if (!s || typeof s !== 'object') continue;
    out.push(s);
    for (const key of ['steps', 'then', 'else']) {
      if (Array.isArray(s[key])) allSteps(s[key], out);
    }
  }
  return out;
}

/**
 * Inspect an automation for anything that should not be imported without the user knowing.
 *
 * Returns a list of concrete concerns, each naming the step. This is a report, not a gate: it exists so
 * the UI can ask, rather than so an import can be silently refused - a user importing their own backup
 * must not be blocked by their own legitimate script step.
 */
export function auditImportedAutomation(automation) {
  const concerns = [];
  const steps = allSteps(automation?.steps);

  for (const step of steps) {
    if (!STEP_KINDS_WITHOUT_WARNING.has(step.kind)) {
      concerns.push({
        stepId: step.id,
        kind: step.kind,
        severity: step.kind === 'runScript' ? 'high' : 'medium',
        detail: step.kind === 'runScript'
          ? 'runs arbitrary JavaScript in whatever page this automation later operates on'
          : `unrecognised step kind "${step.kind}" - it will fail or do nothing`,
      });
    }
    if (step.kind === 'runScript' && typeof step.code === 'string' && step.code.length > 2000) {
      concerns.push({
        stepId: step.id,
        kind: step.kind,
        severity: 'medium',
        detail: `the script is ${step.code.length} characters, which is unusually large for a step`,
      });
    }
    if (step.kind === 'goto' && typeof step.url === 'string' && /\\$\\{/.test(step.url)) {
      concerns.push({
        stepId: step.id,
        kind: step.kind,
        severity: 'medium',
        detail: 'navigates to a URL built from a template, which can send data to another host',
      });
    }
    // a finder that can reach a different origin is not itself dangerous, but a very long selector is a
    // sign of a hand-crafted payload rather than a recorded one
    if (step.finder?.selector && step.finder.selector.length > 800) {
      concerns.push({
        stepId: step.id,
        kind: step.kind,
        severity: 'low',
        detail: `the selector is ${step.finder.selector.length} characters long`,
      });
    }
  }

  return concerns;
}

export async function importAll(doc, { replace = false, allowScripts = false } = {}) {
  const incoming = Array.isArray(doc) ? doc : doc?.automations;
  if (!Array.isArray(incoming)) throw new Error('the file does not contain a list of automations');

  const existing = replace ? [] : await listAutomations();
  const byId = new Map(existing.map((a) => [a.id, a]));
  const imported = [];
  const skipped = [];
  const flagged = [];

  incoming.forEach((raw, i) => {
    try {
      if (!raw || typeof raw !== 'object') throw new Error('not an object');
      const a = migrateAutomation(raw);
      if (!a.name || !Array.isArray(a.steps) || a.steps.length === 0) {
        throw new Error('missing a name or steps');
      }
      // a step list can be arbitrarily nested; a bound stops a crafted file from exhausting the stack
      const steps = allSteps(a.steps);
      if (steps.length > 20_000) {
        throw new Error(`contains ${steps.length} steps, which is beyond any real automation`);
      }
      for (const s of steps) {
        if (typeof s.kind !== 'string') throw new Error('a step has no kind');
      }

      const concerns = auditImportedAutomation(a);
      const hasScript = concerns.some((c) => c.severity === 'high');
      flagged.push(...concerns.map((c) => ({ ...c, automationName: a.name })));

      // A script-carrying automation is held back unless the caller explicitly allows it. Importing
      // everything and warning afterwards would be theatre: by then the step is saved and could run.
      if (hasScript && !allowScripts) {
        skipped.push({
          index: i,
          name: a.name,
          reason: 'contains a script step; re-import with scripts allowed to accept it',
        });
        return;
      }

      // a re-import must not overwrite a local automation with the same id unless replacing
      if (byId.has(a.id) && !replace) {
        a.id = `${a.id}-imported-${i}`;
      }
      byId.set(a.id, a);
      imported.push(a);
    } catch (e) {
      skipped.push({ index: i, name: raw?.name ?? '(unnamed)', reason: e.message });
    }
  });

  const merged = [...byId.values()];
  await set({ [KEYS.automations]: merged, [KEYS.schemaVersion]: CURRENT_SCHEMA });
  return { imported: imported.length, skipped, concerns: flagged };
}'''

edit("background/storage.js", storage_import_old, storage_import_new,
     "S4: import now validates structure, bounds nesting, and holds back script steps")

# export should not silently ship a script step either - say so in the document
edit(
    "background/storage.js",
    """export async function exportAll() {
  const [automations, settings] = await Promise.all([listAutomations(), getSettings()]);
  return {
    format: 'autoflow-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    automations,
    settings,
  };
}""",
    """export async function exportAll() {
  const [automations, settings] = await Promise.all([listAutomations(), getSettings()]);
  // Say in the document itself whether it carries script steps, so whoever receives the file can decide
  // before importing rather than discovering it afterwards.
  const concerns = automations.flatMap((a) => auditImportedAutomation(a).map((c) => ({ ...c, automation: a.name })));
  return {
    format: 'autoflow-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    containsScripts: concerns.some((c) => c.severity === 'high'),
    concerns,
    automations,
    settings,
  };
}""",
    "S5: export declares whether it carries script steps",
)

# the worker passes the flag through
edit(
    "background/service-worker.js",
    """      case 'import-all': {
        const report = await importAll(msg.document, { replace: msg.replace === true });
        await rescheduleAll(await listAutomations());
        return { ok: true, ...report };
      }""",
    """      case 'import-all': {
        const report = await importAll(msg.document, {
          replace: msg.replace === true,
          // a script step is only accepted when the caller has explicitly confirmed it, which the UI does
          // after showing the user what the file contains
          allowScripts: msg.allowScripts === true,
        });
        await rescheduleAll(await listAutomations());
        return { ok: true, ...report };
      }

      case 'audit-import': {
        // a dry run, so the UI can show what a file contains BEFORE importing anything
        const incoming = Array.isArray(msg.document) ? msg.document : msg.document?.automations;
        if (!Array.isArray(incoming)) throw new Error('the file does not contain a list of automations');
        const concerns = incoming.flatMap((a) => auditImportedAutomation(a)
          .map((c) => ({ ...c, automationName: a?.name ?? '(unnamed)' })));
        return {
          ok: true,
          count: incoming.length,
          containsScripts: concerns.some((c) => c.severity === 'high'),
          concerns,
        };
      }""",
    "S6: a dry-run audit message so the UI can warn before importing",
)

edit(
    "background/service-worker.js",
    """import {
  listAutomations, getAutomation, saveAutomation, deleteAutomation, duplicateAutomation,
  getSettings, saveSettings, recordRun, listRuns, clearRuns,
  getDataRows, setDataRows, exportAll, importAll,
} from './storage.js';""",
    """import {
  listAutomations, getAutomation, saveAutomation, deleteAutomation, duplicateAutomation,
  getSettings, saveSettings, recordRun, listRuns, clearRuns,
  getDataRows, setDataRows, exportAll, importAll, auditImportedAutomation,
} from './storage.js';""",
    "S6b: import the auditor",
)

# =============================================================================================
# FINDING 5 — unused permissions, and FINDING 1 — the unimplemented upload step
# =============================================================================================
edit(
    "manifest.json",
    """  "permissions": [
    "storage",
    "unlimitedStorage",
    "alarms",
    "tabs",
    "scripting",
    "activeTab",
    "contextMenus",
    "notifications",
    "sidePanel",
    "downloads",
    "webNavigation"
  ],""",
    """  "permissions": [
    "storage",
    "alarms",
    "tabs",
    "scripting",
    "notifications",
    "sidePanel",
    "downloads"
  ],""",
    "S7: removed four permissions the code never uses (contextMenus, activeTab, webNavigation, unlimitedStorage)",
)

edit(
    "manifest.json",
    """  "web_accessible_resources": [
    {
      "resources": ["picker.css", "icons/*"],
      "matches": ["<all_urls>"]
    }
  ]""",
    """  "web_accessible_resources": [
    {
      "resources": ["icons/*"],
      "matches": ["<all_urls>"]
    }
  ]""",
    "S8: picker.css is no longer exposed to every origin (only extension pages load it)",
)

# ---------------------------------------------------------------------------------------------
print(f"applied {len(changes)} security edits:")
for c in changes:
    print(f"  - {c}")