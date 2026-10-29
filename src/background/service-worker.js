/**
 * The service worker: run orchestration, alarms and messaging.
 *
 * It owns the real Host for the runner. Everything that is not page-side lives here: navigation, tabs,
 * notifications, downloads, screenshots, and the alarm that starts a scheduled run.
 *
 * The design constraint that shapes all of it: a service worker is killed when idle. So the only state
 * that survives is what is in chrome.storage, and every entry point has to rebuild from storage rather
 * than from a module-level variable. A run in progress is the exception — it keeps the worker alive via
 * its own activity — but even that is written to storage so the UI can show it after a restart.
 */

import { Runner } from '../core/engine/runner.js';
import { api } from '../platform/api.js';
import { cloneableOrString } from '../platform/serialise.js';
import { validateAutomation } from '../core/model/steps.js';
import {
  listAutomations, getAutomation, saveAutomation, deleteAutomation, duplicateAutomation,
  getSettings, saveSettings, recordRun, listRuns, clearRuns,
  getDataRows, setDataRows, exportAll, importAll, auditImportedAutomation,
  getUploadFile, setUploadFile, listUploadFiles,
} from './storage.js';
import {
  rescheduleAll, scheduleOne, cancelOne, automationIdFromAlarm, ALARM_PREFIX, listScheduled,
} from './alarms.js';

/** The run currently in progress, if any. Mirrored into session storage for the UI. */
let activeRun = null;

class StepTimeout extends Error {
  constructor(message) {
    super(message);
    this.name = 'StepTimeout';
  }
}

/** Wrap a promise with a timeout, because a content script that never answers must not hang a run. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new StepTimeout(`${label} took longer than ${ms} ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Send one message to a tab's content script.
 *
 * Tabs that were loaded before the extension was installed have no content script, and the error for that
 * is indistinguishable from "the page is gone" unless it is handled here. Injecting on demand is what
 * makes the first run work on an already-open page.
 */
async function sendToTab(tabId, message, { injectIfMissing = true } = {}) {
  try {
    // The payload crosses a message port, which structured-clones it. A function anywhere inside would
    // fail the send on Firefox; sanitising here means a page-derived value can never break the channel.
    const safeMessage = message?.step ? { ...message, step: cloneableOrString(message.step) } : message;
    return await withTimeout(api.tabs.sendMessage(tabId, safeMessage), 20_000, `message ${message.type}`);
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
}

/**
 * Build the Host the Runner drives.
 *
 * Each method's job is narrow: translate an abstract step into a browser action, and report a failure
 * with enough context that the trace explains what happened.
 */
function makeHost(tabId, { stopFlag, onTrace, opts }) {
  const startedAt = Date.now();

  async function waitForLoad(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tab = await api.tabs.get(tabId).catch(() => null);
      if (!tab) return false;
      if (tab.status === 'complete') return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  /** Wait until the content script answers a ping, so the run does not act on a page that is reloading. */
  async function waitForContent(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await sendToTab(tabId, { type: 'ping' }, { injectIfMissing: true });
        if (res?.ok) return true;
      } catch { /* not there yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  return {
    now: () => Date.now(),

    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

    stopRequested: () => stopFlag.stopped === true,

    async isAlive() {
      const tab = await api.tabs.get(tabId).catch(() => null);
      return Boolean(tab);
    },

    onTrace,

    async execute(step) {
      switch (step.kind) {
        case 'goto': {
          await api.tabs.update(tabId, { url: step.url });
          await waitForLoad();
          await new Promise((r) => setTimeout(r, opts.navigationSettleMs ?? 800));
          const ok = await waitForContent();
          if (!ok) throw new Error(`the page at ${step.url} did not become ready`);
          return { navigated: step.url };
        }

        case 'reload': {
          await api.tabs.reload(tabId, step.bypassCache ? { bypassCache: true } : undefined);
          await waitForLoad();
          await new Promise((r) => setTimeout(r, opts.navigationSettleMs ?? 800));
          await waitForContent();
          return { reloaded: true };
        }

        case 'back':
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
        }

        case 'newTab': {
          const tab = await api.tabs.create({ url: step.url, active: step.active !== false });
          if (step.active !== false) {
            await waitForLoad();
            await new Promise((r) => setTimeout(r, opts.navigationSettleMs ?? 800));
          }
          return { tabId: tab.id };
        }

        case 'switchTab': {
          let target = null;
          if (step.tabIndex !== undefined) {
            const tabs = await api.tabs.query({ currentWindow: true });
            target = tabs[step.tabIndex] ?? null;
          } else if (step.urlMatch) {
            const tabs = await api.tabs.query({ currentWindow: true });
            target = tabs.find((t) => (t.url ?? '').includes(step.urlMatch)) ?? null;
          }
          if (!target) throw new Error('no tab matched the switch request');
          await api.tabs.update(target.id, { active: true });
          if (step.runIn !== false) {
            const ok = await waitForContent();
            if (!ok) throw new Error('the target tab has no reachable page');
          }
          return { tabId: target.id };
        }

        case 'closeTab': {
          let id = tabId;
          if (step.tabIndex !== undefined) {
            const tabs = await api.tabs.query({ currentWindow: true });
            id = tabs[step.tabIndex]?.id ?? tabId;
          }
          await api.tabs.remove(id);
          return { closed: id };
        }

        case 'notify': {
          await api.notifications.create(`autoflow-${Date.now()}`, {
            type: 'basic',
            iconUrl: api.runtime.getURL('icons/128.png'),
            title: step.title || 'AutoFlow',
            message: step.message,
            priority: 1,
          });
          return { notified: true };
        }

        case 'sound': {
          // An offscreen document is the only way to make a sound from a service worker; a short beep is
          // not worth that machinery, so the nearest thing is a notification with sound enabled by the OS.
          await api.notifications.create(`autoflow-beep-${Date.now()}`, {
            type: 'basic',
            iconUrl: api.runtime.getURL('icons/128.png'),
            title: 'AutoFlow',
            message: step.message || 'Step reached',
            silent: false,
            priority: 2,
          });
          return { sounded: true };
        }

        case 'download': {
          let url = step.url;
          if (!url) {
            const blob = new Blob([String(step.content ?? '')], { type: step.mime ?? 'text/plain' });
            url = URL.createObjectURL(blob);
          }
          const id = await api.downloads.download({
            url,
            filename: step.filename || `autoflow-${Date.now()}.txt`,
            saveAs: step.saveAs === true,
          });
          return { downloadId: id };
        }

        case 'screenshot': {
          const tab = await api.tabs.get(tabId);
          const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          if (step.filename) {
            await api.downloads.download({ url: dataUrl, filename: step.filename });
          }
          return { captured: true, bytes: dataUrl.length };
        }

        default: {
          // Everything else is performed in the page, and the content script answers with an envelope.
          // It MUST be unwrapped here: passing it through meant an `ok:false` looked like a success, so a
          // missing element or a rejected fill was recorded as step-ok and the run said "finished".
          const res = await sendToTab(tabId, { type: 'perform-step', step });
          if (!res) {
            throw new Error(`the page gave no answer for the ${step.kind} step`);
          }
          if (res.ok === false) {
            const err = new Error(res.error || `the ${step.kind} step failed in the page`);
            err.name = res.name || 'ActionError';
            if (res.detail) err.detail = res.detail;
            throw err;
          }
          // A reply has already crossed a message port, so it is cloneable by construction. What is checked
          // here is that it is an object, because a step that returns a bare value would confuse the trace.
          return res.result ?? {};
        }
      }
    },

    async readCondition(condition) {
      if (condition.source === 'url' || condition.source === 'title') {
        const tab = await api.tabs.get(tabId).catch(() => null);
        return {
          value: condition.source === 'url' ? (tab?.url ?? '') : (tab?.title ?? ''),
          found: Boolean(tab),
          flags: {},
        };
      }
      try {
        const res = await sendToTab(tabId, { type: 'observe', finder: condition.finder, condition });
        if (res?.ok) return res.observed;
      } catch { /* fall through */ }
      return { value: null, found: false, flags: {}, count: 0 };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// running an automation
// ---------------------------------------------------------------------------------------------

export async function startAutomation(automationId, { tabId, trigger = 'manual', row = null, vars = {} } = {}) {
  if (activeRun) {
    throw new Error(`a run is already in progress (${activeRun.name}); stop it first`);
  }

  const automation = await getAutomation(automationId);
  if (!automation) throw new Error(`no automation with id ${automationId}`);
  validateAutomation(automation);

  const settings = await getSettings();
  const opts = { ...automation.options };
  const targetTabId = tabId ?? (await api.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!targetTabId) throw new Error('there is no active tab to run in');

  const stopFlag = { stopped: false };
  activeRun = {
    id: automationId,
    name: automation.name,
    tabId: targetTabId,
    startedAt: Date.now(),
    trigger,
    stopFlag,
    trace: [],
  };

  await api.storage.session.set({ activeRun: publicActiveRun() });
  await setBadge('running');

  const tracer = (entry) => {
    // keep a bounded trace in memory; a long loop would otherwise grow without limit
    if (activeRun && activeRun.trace.length < 5000) activeRun.trace.push(entry);
    api.runtime.sendMessage({ type: 'trace', entry, automationId }).catch(() => {});
  };

  const host = makeHost(targetTabId, { stopFlag, onTrace: tracer, opts });
  const runner = new Runner(host, { maxStepsExecuted: opts.maxStepsExecuted ?? 200_000 });

  if (settings.showStatusBadge !== false) {
    api.tabs.sendMessage(targetTabId, {
      type: 'run-status',
      status: 'running',
      name: automation.name,
    }).catch(() => {});
  }

  let result;
  try {
    result = await runner.run(automation, { vars, row: row ?? undefined, signal: stopFlag });
  } catch (e) {
    result = { reason: 'step-error', trace: activeRun?.trace ?? [], error: e, vars: {}, steps: 0, elapsedMs: 0 };
  }

  const finished = {
    id: `run${Date.now().toString(36)}`,
    automationId,
    name: automation.name,
    reason: result.reason,
    steps: result.steps,
    elapsedMs: result.elapsedMs,
    startedAt: activeRun?.startedAt ?? Date.now(),
    trigger,
    error: result.error ? { message: result.error.message ?? String(result.error), stepId: result.error.stepId } : null,
    trace: result.trace?.slice(-200) ?? [],
  };

  activeRun = null;
  await api.storage.session.remove('activeRun');
  await recordRun(finished).catch(() => {});
  await setBadge(null);
  api.tabs.sendMessage(targetTabId, { type: 'run-status', status: 'idle' }).catch(() => {});
  api.runtime.sendMessage({ type: 'run-finished', run: finished }).catch(() => {});

  // a scheduled automation must arm its next occurrence, or it runs once and stops forever
  try {
    const fresh = await getAutomation(automationId);
    if (fresh?.schedule && fresh.schedule.kind !== 'manual') {
      await scheduleOne(fresh);
    }
  } catch { /* the run already finished; a schedule failure must not look like a run failure */ }

  return finished;
}

export function stopActiveRun() {
  if (!activeRun) return false;
  activeRun.stopFlag.stopped = true;
  return true;
}

function publicActiveRun() {
  if (!activeRun) return null;
  return {
    id: activeRun.id,
    name: activeRun.name,
    tabId: activeRun.tabId,
    startedAt: activeRun.startedAt,
    trigger: activeRun.trigger,
    steps: activeRun.trace.filter((t) => t.type === 'step-ok' || t.type === 'step-fail').length,
  };
}

async function setBadge(state) {
  const map = {
    running: { text: '▶', color: '#2962ff' },
    error: { text: '!', color: '#d32f2f' },
    done: { text: '✓', color: '#2e7d32' },
  };
  const s = map[state];
  try {
    await api.action.setBadgeText({ text: s?.text ?? '' });
    if (s) await api.action.setBadgeBackgroundColor({ color: s.color });
  } catch { /* badge is cosmetic */ }
}

// ---------------------------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------------------------

/**
 * Set the click behaviour, at MODULE LOAD as well as on install.
 *
 * `onInstalled` fires once per install/update. `openPanelOnActionClick` was measured still `false` in a fresh
 * Chrome, so relying on that one event left the toolbar button dead - which is the reported bug. The worker
 * runs at extension load and after every wake, so doing it here as well makes the state self-healing rather
 * than dependent on a single event that had evidently not taken effect.
 *
 * Idempotent, so running it repeatedly costs nothing.
 */
async function ensureClickOpensPanel() {
  try {
    const ok = await api.side.enableOpenOnClick();
    if (!ok) console.info('[autoflow] setPanelBehavior unavailable; api.action.onClicked will open it');
    return ok;
  } catch (e) {
    // worth a line in the console: a failure here is why a toolbar button can look dead
    console.warn('[autoflow] could not set the panel click behaviour:', String(e?.message || e));
    return false;
  }
}

api.runtime.onInstalled.addListener(async (details) => {
  // Each step is wrapped, because throwing here aborted the rest: `await rescheduleAll(...)` above the
  // panel call meant one failure stopped the other, and the panel call was what the user could see.
  try {
    const automations = await listAutomations();
    await rescheduleAll(automations);
  } catch (e) {
    console.warn('[autoflow] rescheduling at install failed:', String(e?.message || e));
  }

  await ensureClickOpensPanel();

  if (details.reason === 'install') {
    // open the options page once, so a new user sees what this is rather than an empty panel
    api.tabs.create({ url: api.runtime.getURL('options.html') }).catch(() => {});
  }
});

// also at load and on every worker wake, so the behaviour is never left unset
ensureClickOpensPanel();

api.runtime.onStartup.addListener(async () => {
  // every alarm is re-derived from storage: an alarm set before a restart cannot be trusted
  const automations = await listAutomations();
  await rescheduleAll(automations);
});

api.alarms.onAlarm.addListener(async (alarm) => {
  const id = automationIdFromAlarm(alarm.name);
  if (!id) return;
  try {
    const automation = await getAutomation(id);
    if (!automation || automation.enabled === false) return;

    // Find or make a tab for this automation. Reusing the active tab would hijack whatever the user is
    // doing, so a matching tab is preferred and a new one is created only if none matches.
    let tabId = null;
    const patterns = automation.urls?.length ? automation.urls : [];
    if (patterns.length) {
      const tabs = await api.tabs.query({});
      const match = tabs.find((t) => patterns.some((p) => (t.url ?? '').includes(p.replace(/\*/g, ''))));
      if (match) tabId = match.id;
      else if (patterns[0] && !patterns[0].includes('*')) {
        const created = await api.tabs.create({ url: patterns[0], active: false });
        tabId = created.id;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!tabId) {
      const active = await api.tabs.query({ active: true, currentWindow: true });
      tabId = active[0]?.id ?? null;
    }
    if (!tabId) throw new Error('no tab available to run in');

    // a CSV-driven automation iterates its rows
    const data = automation.dataSource?.key ? await getDataRows(automation.dataSource.key) : null;
    if (Array.isArray(data) && data.length) {
      for (const row of data) {
        await startAutomation(id, { tabId, trigger: 'schedule', row });
      }
    } else {
      await startAutomation(id, { tabId, trigger: 'schedule' });
    }
  } catch (e) {
    await recordRun({
      id: `run${Date.now().toString(36)}`,
      automationId: id,
      name: '(scheduled)',
      reason: 'step-error',
      steps: 0,
      elapsedMs: 0,
      trigger: 'schedule',
      error: { message: String(e?.message ?? e) },
      trace: [],
    }).catch(() => {});
    await setBadge('error');
  }
});

api.commands.onCommand.addListener(async (command) => {
  const settings = await getSettings();
  if (settings.shortcutsEnabled === false) return;

  if (command === 'panic-stop') {
    stopActiveRun();
    return;
  }
  if (command === 'start-stop') {
    if (activeRun) stopActiveRun();
    else {
      const automations = await listAutomations();
      const first = automations.find((a) => a.enabled);
      if (first) await startAutomation(first.id).catch(() => {});
    }
    return;
  }
  if (command === 'pick-element') {
    const tab = (await api.tabs.query({ active: true, currentWindow: true }))[0];
    if (tab?.id) api.tabs.sendMessage(tab.id, { type: 'start-picking' }).catch(() => {});
    return;
  }
});

/**
 * Open the side panel / sidebar when the toolbar button is clicked.
 *
 * On CHROMIUM this handler must NOT open the panel itself. `setPanelBehavior({ openPanelOnActionClick: true })`
 * already makes the browser open it, so a second mechanism exists for a single click - and the browser has
 * consumed the user gesture by then, so `sidePanel.open()` is rejected with
 *
 *     "`sidePanel.open()` may only be called in response to a user gesture."
 *
 * That rejection was unhandled and surfaced to the user as an extension ERROR BADGE on the toolbar icon, for a
 * button that otherwise looked broken. Measured in a real Chrome, not inferred.
 *
 * Firefox has no `setPanelBehavior`, so on Firefox this handler IS the mechanism.
 */
api.action.onClicked.addListener(async (tab) => {
  /**
   * Try to open it, on BOTH platforms, and never let a failure escape.
   *
   * Why not "return early on Chromium, the browser handles it": that relies on
   * `setPanelBehavior({ openPanelOnActionClick: true })` having taken effect. It is set in `onInstalled`,
   * and it was MEASURED still `false` shortly after a fresh load - a race, and if it loses, an early return
   * leaves the toolbar button dead. That is the bug being fixed, reintroduced by the fix for it.
   *
   * So the handler always attempts the open, and treats a rejection as a non-event:
   *
   *   - flag ON  -> the browser already opened the panel, this call is rejected, we swallow it. Correct
   *                 outcome, no error badge.
   *   - flag OFF -> this call is the only mechanism, and it works because `onClicked` IS a user gesture.
   *
   * Either way the user gets a panel. The `.catch` in the platform layer already turns a documented
   * rejection into `false`, so nothing unhandled reaches the console or the badge.
   */
  try {
    await api.side.open({ windowId: tab?.windowId });
  } catch {
    // a click that cannot open the panel is not worth an error badge; the user can simply click again
  }
});

// ---------------------------------------------------------------------------------------------
// messaging from the UI
// ---------------------------------------------------------------------------------------------

/**
 * Which messages a CONTENT SCRIPT is allowed to send.
 *
 * The background listener is reachable from every content-script instance, and this extension injects into
 * every page (`<all_urls>` with `all_frames: true`). A frame from any origin therefore has a content
 * script in it. The page itself cannot call `chrome.runtime.sendMessage` - `externally_connectable` is
 * not declared, which is deliberate - but the content script can, and an attacker who finds any way to
 * drive it must not be able to start runs or delete data.
 *
 * The discriminator is `sender.url`, measured in a real browser rather than assumed:
 *
 *   extension page (panel.html)   id=<ours>  tab=YES  url="chrome-extension://<id>/panel.html"
 *   content script                id=<ours>  tab=YES  url="http://127.0.0.1:35997/"
 *
 * Both carry a tab, and both carry our id, so neither of those distinguishes them. Only the URL scheme
 * does. An earlier version of this function tested for the absence of `tab` and therefore classified the
 * panel as unknown and refused every message from its own UI.
 */
const CONTENT_SCRIPT_MESSAGES = new Set([
  'content-ready',
  'element-picked',
  'element-pick-cancelled',
  'run-status',
]);

function classifySender(sender) {
  if (sender?.id !== api.id) return 'unknown';
  const url = String(sender.url ?? sender.tab?.url ?? '');
  // The base URL carries the right scheme for this browser: `chrome-extension://` on Chromium,
  // `moz-extension://` on Firefox. A hardcoded scheme literal classified our own panel as "internal" on
  // Firefox, which happened to be harmless but was wrong.
  const base = api.runtime.baseUrl();
  const anyExtensionScheme = /^[a-z-]+-extension:\/\//i.test(url);
  if (base && url.startsWith(base)) return 'extension-page';
  if (anyExtensionScheme && !/^[a-z-]+-extension:\/\/[a-z0-9]{32}\//i.test(url)) {
    // an extension-scheme url that is not ours and not a UUID-served temporary add-on: another extension
    return 'unknown';
  }
  if (anyExtensionScheme) return 'extension-page';
  if (/^https?:\/\//i.test(url)) return 'content-script';
  // No URL at all: an internal caller (the worker's own alarm handler, or an injected script).
  return 'internal';
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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

  const handle = async () => {
    switch (msg.type) {
      case 'content-ready':
        return { ok: true };

      case 'element-picked':
        api.runtime.sendMessage({ type: 'element-picked', info: msg.info, finder: msg.finder }).catch(() => {});
        return { ok: true };

      case 'start-run':
        // `tabId` is optional. Without it the active tab is used, which is what the panel's Run button
        // wants; with it the run targets a named tab, so an automation can be pointed at a tab that is not
        // in front - and so a test can drive a page without stealing focus.
        return {
          ok: true,
          run: await startAutomation(msg.automationId, {
            trigger: msg.trigger ?? 'manual',
            vars: msg.vars,
            tabId: typeof msg.tabId === 'number' ? msg.tabId : undefined,
          }),
        };

      case 'stop-run':
        return { ok: true, stopped: stopActiveRun() };

      case 'get-active-run':
        return { ok: true, run: publicActiveRun() };

      case 'ping-tab': {
        const tab = (await api.tabs.query({ active: true, currentWindow: true }))[0];
        if (!tab?.id) throw new Error('no active tab');
        const res = await sendToTab(tab.id, { type: 'ping' });
        return { ok: true, page: res };
      }

      case 'pick-element': {
        const tab = (await api.tabs.query({ active: true, currentWindow: true }))[0];
        if (!tab?.id) throw new Error('no active tab');
        await sendToTab(tab.id, { type: 'start-picking' });
        return { ok: true };
      }

      case 'reschedule': {
        const automations = await listAutomations();
        return { ok: true, results: await rescheduleAll(automations) };
      }

      case 'schedule-one': {
        const automation = await getAutomation(msg.automationId);
        if (!automation) throw new Error('no such automation');
        return { ok: true, ...(await scheduleOne(automation)) };
      }

      case 'list-scheduled': {
        const automations = await listAutomations();
        return { ok: true, items: await listScheduled(automations) };
      }

      case 'cancel-alarms': {
        const all = await api.alarms.getAll();
        const mine = all.filter((a) => a.name.startsWith(ALARM_PREFIX));
        await Promise.all(mine.map((a) => api.alarms.clear(a.name)));
        return { ok: true, cleared: mine.length };
      }

      // ---- storage, answered here so the UI has one message surface
      case 'list-automations':
        return { ok: true, automations: await listAutomations() };

      case 'save-automation': {
        const saved = await saveAutomation(msg.automation);
        return { ok: true, automation: saved };
      }

      case 'duplicate-automation': {
        const copy = await duplicateAutomation(msg.id);
        return { ok: true, automation: copy };
      }

      case 'delete-automation': {
        const removed = await deleteAutomation(msg.id);
        await cancelOne(msg.id);
        return { ok: true, removed };
      }

      case 'get-settings':
        return { ok: true, settings: await getSettings() };

      case 'save-settings':
        return { ok: true, settings: await saveSettings(msg.patch ?? {}) };

      case 'list-runs':
        return { ok: true, runs: await listRuns() };

      case 'clear-runs':
        await clearRuns();
        return { ok: true };

      case 'store-data-rows':
        await setDataRows(msg.key, msg.rows ?? []);
        return { ok: true, count: (msg.rows ?? []).length };

      case 'get-data-rows':
        return { ok: true, rows: await getDataRows(msg.key) };

      case 'export-all':
        return { ok: true, document: await exportAll() };

      case 'import-all': {
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
      }

      case 'read-file-for-upload': {
        /**
         * Serve a file's bytes to the content script.
         *
         * The page side cannot read an extension file, so the worker reads it and hands over base64. Only
         * files the user explicitly added to an upload step can be requested, and the name is checked
         * against that set, so this is not a general file-read primitive.
         */
        const name = String(msg.name ?? '');
        if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
          throw new Error('refusing a file name with a path component');
        }
        const stored = await getUploadFile(name);
        if (!stored) throw new Error(`no uploaded file named "${name}" is available`);
        return { ok: true, base64: stored.base64, mime: stored.mime };
      }

      case 'add-upload-file': {
        // kept in session storage: it is only needed while a run happens, and a user's document should not
        // be written to disk for the browser to keep
        const name = String(msg.name ?? '');
        if (!name || name.length > 200) throw new Error('a file needs a name of at most 200 characters');
        const url = String(msg.dataUrl ?? '');
        if (!/^data:[^;]*;base64,/.test(url)) throw new Error('the file content must be a base64 data URL');
        if (url.length > 12 * 1024 * 1024) throw new Error('the file is larger than 8 MB');
        const mime = /^data:([^;]*);/.exec(url)?.[1] || 'application/octet-stream';
        await setUploadFile(name, { base64: url.split(',')[1], mime, size: url.length });
        return { ok: true, name, mime };
      }

      case 'list-upload-files': {
        const files = await listUploadFiles();
        return { ok: true, files };
      }

      case 'cancel-picking': {
        const tab = (await api.tabs.query({ active: true, currentWindow: true }))[0];
        if (tab?.id) api.tabs.sendMessage(tab.id, { type: 'stop-picking' }).catch(() => {});
        return { ok: true };
      }

      case 'diagnostics': {
        const automations = await listAutomations();
        const alarms = await api.alarms.getAll();
        return {
          ok: true,
          diagnostics: {
            extension: {
              version: api.runtime.getManifest().version,
              manifestVersion: api.runtime.getManifest().manifest_version,
            },
            environment: {
              userAgent: navigator.userAgent,
              language: navigator.language,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              now: new Date().toISOString(),
            },
            counts: {
              automations: automations.length,
              enabled: automations.filter((a) => a.enabled !== false).length,
              scheduledAlarms: alarms.filter((a) => a.name.startsWith(ALARM_PREFIX)).length,
              runsRecorded: (await listRuns()).length,
            },
            activeRun: publicActiveRun(),
            automations: automations.map((a) => ({
              id: a.id,
              name: a.name,
              steps: a.steps.length,
              schedule: a.schedule?.kind ?? 'manual',
            })),
            alarms: alarms.map((a) => ({ name: a.name, at: new Date(a.scheduledTime).toISOString() })),
          },
        };
      }

      default:
        return { ok: false, error: `unknown message type ${msg.type}` };
    }
  };

  handle()
    .then((res) => { try { sendResponse(res); } catch { /* port closed */ } })
    .catch((e) => { try { sendResponse({ ok: false, error: String(e?.message ?? e) }); } catch { /* port closed */ } });
  return true; // async response
});