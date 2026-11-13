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
import { cloneableOrString, bytesToBase64 } from '../platform/serialise.js';
import { validateAutomation } from '../core/model/steps.js';
import {
  listAutomations, getAutomation, saveAutomation, deleteAutomation, duplicateAutomation,
  getSettings, saveSettings, recordRun, listRuns, clearRuns,
  getDataRows, setDataRows, exportAll, importAll, auditImportedAutomation,
  getUploadFile, setUploadFile, listUploadFiles,
  recordEvent, clearEvents, flushEvents, readEvents,
} from './storage.js';
import {
  rescheduleAll, scheduleOne, cancelOne, automationIdFromAlarm, startLatencyMs, recordFiredTarget,
  /**
   * `listScheduled` WAS NEVER IMPORTED.
   *
   * MEASURED: `list-scheduled` answered `{ ok: false, error: "listScheduled is not defined" }` while the alarm itself was
   * correctly registered - so the panel could not show which automations were armed, and the failure looked like "nothing
   * is scheduled" rather than like an error in the code. It predates the 1.18.0 review; nothing in the unit suite calls
   * this message, which is why it survived.
   */
  listScheduled,
  /**
   * THESE TWO WERE USED AND NEVER IMPORTED, in the tree this fix lands on.
   *
   * `recordStartLatency` is called by every scheduled run as it finishes (line ~587), so the run completed and then threw
   * ReferenceError - and the next-day re-arm, which happens after that call, never ran. A daily automation would run once
   * and stop, with a `scheduled: true` in the log to say otherwise.
   *
   * `ALARM_PREFIX` is used by `cancel-alarms` and by the `diagnostics` handler, so both crashed: the "cancel everything"
   * button and the alarm section of the diagnostic export.
   *
   * Both are exported by alarms.js; neither was in this list. `tests/worker-imports.test.js` now checks the whole class.
   */
  recordStartLatency, ALARM_PREFIX,
} from './alarms.js';
import { nextRun, wantsPreciseTiming, PRECISE_WAKE_MS } from '../core/schedule/schedule.js';
import { clockOffset } from '../core/clock/skew.js';
import { matchesPattern } from '../core/net/match-pattern.js';
import { buildHeader, buildExport, exportAsText } from '../core/diag/report.js';

/** The run currently in progress, if any. Mirrored into session storage for the UI. */
let activeRun = null;

/**
 * A claim on the run slot, held from the instant a start is accepted until `activeRun` is assigned.
 *
 * Why it exists: the slot was checked and then assigned several awaits later, so concurrent starts all passed the
 * check. This is set synchronously before the first await and cleared if the start fails, which makes "one run at
 * a time" true rather than intended.
 */
let startingUp = null;

/**
 * How long a scheduled start waits in the queue for its turn.
 *
 * Automations that share a target second all arrive together, each armed and waiting for that same instant, so
 * they need their turn in sequence rather than being dropped. Eight automations on one second is what an order
 * window looks like; 45s covers that comfortably and still bounds a wedged run.
 */
const SCHEDULE_QUEUE_WAIT_MS = 45_000;

/**
 * How late a missed schedule may be and still run.
 *
 * If the machine slept through the target, running is still useful while the window is open and pointless once it
 * has closed. Ten seconds is the compromise: it covers a suspended laptop waking, a busy profiler, or a slow alarm,
 * and it does not silently fire an order minutes after the moment has passed. Beyond this the run is recorded as
 * missed rather than executed.
 */
const LATE_TOLERANCE_MS = 10_000;

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
  /**
   * THE PAYLOAD IS BUILT ONCE, OUTSIDE THE `try`.
   *
   * The payload crosses a message port, which structured-clones it; a function anywhere inside would fail the send on
   * Firefox, so the step is sanitised here.
   *
   * MEASURED (`send-to-tab-retry.test`): this was declared with `const` INSIDE the `try` and used by the retry in the
   * `catch`. Out of scope there, so the retry threw `ReferenceError: safeMessage is not defined` - content.js was
   * injected and the message was never re-sent. The first attempt after an extension reload, or on a freshly opened tab,
   * is exactly the case the retry exists for; and for a scheduled precise run the first element step has already consumed
   * `atMs`, so the runner's retry has no target time left and the click can fire before its instant.
   */
  const safeMessage = message?.step ? { ...message, step: cloneableOrString(message.step) } : message;
  try {
    /**
     * THE CAP DEPENDS ON WHAT THE STEP IS ALLOWED TO DO.
     *
     * MEASURED: a flat 20s timeout covered every message to a tab, so a `wait`, `waitFor` or `clickAll` step whose own
     * budget is longer was killed at 20 seconds with "message <type> timed out" - the step never got to fail on its own
     * terms, and a legitimate long wait looked like a broken connection. `waitForLoad` alone allows 30s.
     *
     * The step's own budget decides. Anything under 20s stays at 20s, and the ceiling is ten minutes so a stale message
     * cannot hang a run forever.
     */
    const budget = Number.isFinite(message?.timeoutMs) ? message.timeoutMs : 20_000;
    const cap = Math.min(Math.max(budget + 5_000, 20_000), 10 * 60_000);
    return await withTimeout(api.tabs.sendMessage(tabId, safeMessage), cap, `message ${message.type}`);
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
    // the RETRY must send what was actually intended to be sent. `message` is the caller's raw object, which
    // `cloneableOrString` was applied to for the wire; sending the raw one again could fail on the same value that
    // the sanitising exists to handle, and the retry would then fail for a reason unrelated to the
    // "content script was missing" case it is there for.
    return withTimeout(api.tabs.sendMessage(tabId, safeMessage), 20_000, `message ${message.type} (retry)`);
  }
}

/**
 * Build the Host the Runner drives.
 *
 * Each method's job is narrow: translate an abstract step into a browser action, and report a failure
 * with enough context that the trace explains what happened.
 */
function makeHost(initialTabId, { stopFlag, onTrace, opts }) {
  let tabId = initialTabId;
  const startedAt = Date.now();
  let lastAliveAt = 0;
  let lastAlive = false;

  /**
   * The precise instant this run must act at, consumed once by the first element step.
   *
   * Declared here, at the top of the closure, because `execute` below refers to it inside an object literal
   * evaluated during the return - a `let` declared after that point is in the temporal dead zone and throws
   * "pendingAtMs is not defined" the moment the first step runs. That is exactly what happened.
   */
  let pendingAtMs = (opts && opts.atMs !== undefined) ? opts.atMs : null;

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
      if (Date.now() - lastAliveAt < 50 && lastAlive) return true;
      const tab = await api.tabs.get(tabId).catch(() => null);
      lastAlive = Boolean(tab);
      lastAliveAt = Date.now();
      return lastAlive;
    },

    onTrace,

    async execute(step) {
      switch (step.kind) {
        case 'goto': {
          lastAliveAt = 0;
          await api.tabs.update(tabId, { url: step.url });
          await waitForLoad();
          await new Promise((r) => setTimeout(r, opts.navigationSettleMs ?? 800));
          const ok = await waitForContent();
          if (!ok) throw new Error(`the page at ${step.url} did not become ready`);
          return { navigated: step.url };
        }

        case 'reload': {
          lastAliveAt = 0;
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
          lastAliveAt = 0;
          const tab = await api.tabs.create({ url: step.url, active: step.active !== false });
          if (step.active !== false) {
            if (tab?.id != null) tabId = tab.id;
            await waitForLoad();
            await new Promise((r) => setTimeout(r, opts.navigationSettleMs ?? 800));
          }
          return { tabId: tab.id };
        }

        case 'switchTab': {
          lastAliveAt = 0;
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
            tabId = target.id;
            const ok = await waitForContent();
            if (!ok) throw new Error('the target tab has no reachable page');
          }
          return { tabId: target.id };
        }

        case 'closeTab': {
          lastAliveAt = 0;
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
            const blob = new Blob([String(step.content ?? '')], { type: step.mimeType || step.mime || 'application/octet-stream' });
            /**
             * A DATA URL, not a blob URL.
             *
             * `URL.createObjectURL` does not exist in a Manifest V3 service worker - there is no document and no
             * blob registry - so any download step that carried content threw. A data URL is just a string and works
             * from the worker. It is base64, so it is about a third larger; that is the price of it working at all.
             */
            url = `data:${step.mimeType || step.mime || 'application/octet-stream'};base64,${await bytesToBase64(blob)}`;
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
          // Attach the precise target only to a page-side step; worker-side steps must not consume it.
          if (pendingAtMs !== null) {
            /**
             * Bring the tab to the front first, when the automation asks for it.
             * Background-tab timer throttling makes a second-accurate wait impossible, so focus is best-effort.
             */
            if (opts.focusBeforePrecise) {
              try {
                await api.tabs.update(tabId, { active: true });
                await api.windows.update((await api.tabs.get(tabId))?.windowId, { focused: true });
                await new Promise((r) => setTimeout(r, 60));
              } catch {
                // focus is best-effort; the run still proceeds, just possibly throttled
              }
            }
            const withTarget = step.atMs === undefined ? { ...step, atMs: pendingAtMs } : step;
            pendingAtMs = null;
            step = withTarget;
          }
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

/**
 * @param atMs  Optionally, the wall-clock instant this run must act at. Set for a schedule that carries a
 *              second: the alarm arrives early and the first awaited step holds until exactly this moment.
 *              Passed as `vars.__atMs` so it travels through the runner without changing every step's shape,
 *              and read in `execute` below.
 */
export async function startAutomation(automationId, opts = {}) {
  /**
   * THE GUARD IS CLAIMED BEFORE THE FIRST await, and no caller may start a second run by configuration.
   *
   * It used to read `if (activeRun) throw` and set `activeRun` three awaits later (getAutomation, getSettings,
   * tabs.query). Between the check and the set the function yields, so every caller that arrived in that window
   * also saw a free slot. Measured: two concurrent calls both started, and eight concurrent calls ALL started -
   * eight runs overwriting each other's activeRun, trace and stop flag. That is the lost run in "seven of eight".
   *
   * There is no await between the test and the claim, which on a single-threaded event loop is what makes it
   * atomic. The claim is released on every failure path, so a rejected start cannot wedge the extension.
   *
   * SCHEDULED CALLERS QUEUE INSTEAD OF BEING REFUSED. That is the difference between the alarm handler and a
   * person pressing Run: a schedule that collides with another schedule must still run, in turn, or the click is
   * lost - and eight automations on one second is what an order window looks like, not a mistake. A press of Run
   * while something is already running is still refused, because that is a person who can see what is happening.
   */
  const queue = opts.trigger === 'schedule';
  const deadline = Date.now() + (queue ? SCHEDULE_QUEUE_WAIT_MS : 0);
  let depth = 0;
  /**
   * HOW LONG THIS RUN SPENT WAITING FOR THE SLOT.
   *
   * MEASURED (B4): `recordStartLatency(startedAt - firedAt)` is the wake-up cost - and it silently includes any time
   * spent queued behind another automation. The latency sample drives the wake margin, so one 6-second queue wait took
   * the margin from 1580 ms to 7500 ms, and the decay is `max(new, 0.8 * old)` so five fast runs afterwards left it at
   * 3466 ms. A margin that large means the alarm wakes the worker seconds before the target, which is how a click aimed
   * at a second lands early.
   *
   * A queue wait is not a property of the machine, so it is measured separately and subtracted.
   */
  let queuedMs = 0;
  const waitStartedAt = Date.now();

  recordEvent({ kind: 'start-request', automationId, trigger: opts.trigger ?? 'manual', lateByMs: opts.lateByMs });

  for (;;) {
    if (!activeRun && !startingUp) {
      const token = { claimedAt: Date.now() };
      startingUp = token;                     // synchronous: no await between the test above and this
      // the slot is free now: any delay up to this instant was the queue, not the worker waking up
      queuedMs = depth > 0 ? Date.now() - waitStartedAt : 0;
      // logged HERE, at the instant of acceptance, before any await. Recorded later it landed after the run it
      // started, which read as if the run were accepted once it had already finished.
      recordEvent({ kind: 'start-accepted', automationId, trigger: opts.trigger ?? 'manual' });
      try {
        // the acceptance is logged INSIDE the locked body, at the moment it is accepted. Logging it after the await
        // put ACCEPTED after FINISHED in the trail, which reads as if the run were accepted once it had already
        // ended - unhelpful in precisely the case this log exists for.
        return await startAutomationLocked(automationId, { ...opts, token, queuedMs });
      } catch (e) {
        if (startingUp === token) startingUp = null;
        recordEvent({ kind: 'start-refused', automationId, reason: String(e?.message ?? e) });
        throw e;
      }
    }
    if (!queue || Date.now() >= deadline) {
      recordEvent({
        kind: 'start-refused', automationId,
        reason: `slot busy with ${activeRun?.name ?? 'starting'} after ${depth} waits`,
      });
      throw new Error(`a run is already in progress (${activeRun?.name ?? 'starting'}); stop it first`);
    }
    // a scheduled run waits its turn rather than vanishing
    depth += 1;
    if (depth === 1) {
      recordEvent({ kind: 'start-queued', automationId, behind: activeRun?.name ?? 'starting', depth });
    }
    await new Promise((r) => setTimeout(r, 60));
  }
}

/**
 * The body of a run's start, called with the slot already claimed.
 *
 * Split out only so the claim can be made before any await; every rule from the old function is unchanged.
 */
async function startAutomationLocked(automationId, {
  tabId, trigger = 'manual', row = null, vars = {}, atMs = null, token,
}) {
  const automation = await getAutomation(automationId);
  if (!automation) throw new Error(`no automation with id ${automationId}`);
  validateAutomation(automation);

  const settings = await getSettings();
  const opts = { focusBeforePrecise: settings.focusBeforePrecise !== false, ...automation.options, atMs };
  /**
   * WHICH TAB THE RUN ACTS ON.
   *
   * THE ACTIVE TAB IS THE WRONG FIRST ANSWER FOR A MANUAL RUN, and that is a measured fault rather than a preference: the Run
   * button lives in the panel, so at the moment it is pressed the ACTIVE TAB IS THE PANEL - which has no content script and no
   * page to click. MEASURED in a real browser: pressing Run ended the run with "the page gave no answer for the click step",
   * while the same record clicked 360 times when the alarm fired it.
   *
   * So a tab matching one of the automation's OWN `urls` patterns is preferred, and the active tab is the fallback. An automation
   * with no patterns - the documented Basic case - behaves exactly as it did.
   */
  let targetTabId = tabId ?? null;
  if (targetTabId === null) {
    const patterns = Array.isArray(automation.urls) ? automation.urls.filter((u) => typeof u === 'string' && u.trim()) : [];
    if (patterns.length) {
      const all = await api.tabs.query({}).catch(() => []);
      const match = all.find((t) => {
        const u = t?.url ?? '';
        // only real pages: an extension page or a browser-internal page has no content script and no clickable element
        if (!/^https?:/i.test(u)) return false;
        return patterns.some((p) => {
          // a pattern is a URL (optionally with a trailing wildcard), compared as a case-insensitive prefix
          const base = String(p).replace(/\*+$/, '').toLowerCase();
          if (!base) return false;
          return u.toLowerCase().startsWith(base) || u.toLowerCase().includes(base);
        });
      });
      if (match?.id !== undefined) {
        targetTabId = match.id;
        recordEvent({ kind: 'target-tab', automationId, how: 'url-pattern', tabId: match.id });
      }
    }
    if (targetTabId === null) {
      targetTabId = (await api.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null;
      if (targetTabId !== null) recordEvent({ kind: 'target-tab', automationId, how: 'active', tabId: targetTabId });
    }
  }
  if (!targetTabId) throw new Error('there is no active tab to run in');

  // `pendingAtMs` lives inside makeHost, above; it is per-run by construction there.

  const stopFlag = { stopped: false };
  if (startingUp !== token) {
    // another start took over while this one was awaiting (only possible if the claim was released incorrectly)
    throw new Error('this start was superseded by another run');
  }
  startingUp = null;                 // the real flag is about to be set, in the same tick
  activeRun = {
    id: automationId,
    name: automation.name,
    tabId: targetTabId,
    startedAt: Date.now(),
    // when the alarm that started this run fired, so the wake margin can be calibrated against reality.
    // Only the alarm path supplies it; a manual run has no alarm and no margin to calibrate.
    firedAt: Number.isFinite(opts?.firedAt) ? opts.firedAt : null,
    // the scheduled instant this run was for, so the post-run re-arm can record it as fired (B1/B2)
    scheduledTarget: Number.isFinite(opts?.scheduledTarget) ? opts.scheduledTarget : null,
    // how long this run waited for the slot before it started; subtracted from the latency sample (B4)
    queuedMs: Number.isFinite(opts?.queuedMs) ? opts.queuedMs : 0,
    trigger,
    stopFlag,
    trace: [],
  };

  /**
   * EVERYTHING AFTER THE CLAIM LIVES INSIDE try/finally (B6).
   *
   * `activeRun` is the mutual-exclusion lock: while it is set, every later run is refused. The claim above is made
   * before any of the work below, and any of `storage.session.set`, `setBadge`, `makeHost` or the session write can
   * throw - a quota error, a closed tab, a worker being torn down. Without the `finally`, a single throw left the lock
   * held and EVERY subsequent run refused until the browser restarted, with no error to explain it.
   *
   * The slot is released here rather than at the end of the function so that the release happens on every exit path,
   * including the ones that end in a thrown error.
   */
  let released = false;
  const releaseSlot = async () => {
    if (released) return;
    released = true;
    activeRun = null;
    try { await api.storage.session.set({ activeRun: null }); } catch { /* the badge is cosmetic; keep going */ }
    try { await setBadge('idle'); } catch { /* ditto */ }
  };

  try {
  await api.storage.session.set({ activeRun: publicActiveRun() });
  await setBadge('running');
  /**
   * TELL THE INTERFACE A RUN HAS STARTED.
   *
   * The panel hears `trace` messages but only refreshed on its OWN actions, so a Stop button appeared (or did not) by luck. The
   * worker knows the transition exactly here, so it says so - which is what makes a running window visible, and what makes its
   * Stop control appear while it still matters.
   */
  await announceRun('started', automation.id);

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

  /**
   * AND TELL IT WHEN THE RUN IS OVER, for the same reason: the Stop control has to go away, and a stale one is worse than none.
   * Sent before the record is written, so a slow storage write cannot leave a run looking active.
   */
  await announceRun('finished', automation.id, result.reason);

  const finished = {
    id: `run${Date.now().toString(36)}`,
    automationId,
    name: automation.name,
    reason: result.reason,
    steps: result.steps,
    elapsedMs: result.elapsedMs,
    startedAt: activeRun?.startedAt ?? Date.now(),
    firedAt: activeRun?.firedAt ?? null,
    scheduledTarget: activeRun?.scheduledTarget ?? null,
    queuedMs: activeRun?.queuedMs ?? 0,
    trigger,
    error: result.error ? { message: result.error.message ?? String(result.error), stepId: result.error.stepId } : null,
    trace: result.trace?.slice(-200) ?? [],
  };

  await releaseSlot();
  /**
   * How long the scheduled path took to get going, so the next wake margin is based on this machine.
   *
   * Measured from the alarm FIRING to the runner starting - not from the target, because the alarm is deliberately
   * set early and that early part is the margin under test. `targetAt` was referenced here before it existed, so the
   * sample was never taken and the margin could not adapt at all.
   */
  if (trigger === 'schedule' && Number.isFinite(finished.startedAt) && Number.isFinite(finished.firedAt)) {
    /**
     * THE QUEUE WAIT IS SUBTRACTED, not measured as if it were the machine.
     *
     * MEASURED (B4): without this, one automation waiting behind another recorded the wait as worker latency and took
     * the wake margin from 1580 ms to 7500 ms - and the margin only comes back down by 20% per fast run, so it stayed
     * inflated for the rest of the session. The margin exists to cover worker boot, settings, tab resolution and the
     * message round-trip; a queue is none of those.
     */
    const queuedMsLocal = Number.isFinite(finished?.queuedMs) ? finished.queuedMs : 0;
    const wake = Math.max(0, finished.startedAt - finished.firedAt - queuedMsLocal);
    await recordStartLatency(wake).catch(() => {});
    if (queuedMsLocal > 250) {
      recordEvent({ kind: 'start-queued-wait', automationId, queuedMs: queuedMsLocal, sampleMs: wake });
    }
  }
  recordEvent({
    kind: 'run-finished', automationId, reason: finished.reason, steps: finished.steps,
    error: finished.error?.message ?? null,
  });
  await api.storage.session.remove('activeRun');
  await recordRun(finished).catch(() => {});
  await setBadge(null);
  api.tabs.sendMessage(targetTabId, { type: 'run-status', status: 'idle' }).catch(() => {});
  api.runtime.sendMessage({ type: 'run-finished', run: finished }).catch(() => {});

  /**
   * A scheduled automation must arm its NEXT occurrence, or it runs once and stops forever.
   *
   * `preferNext: true` is the whole of B1. Without it, `scheduleOne` saw the target this run had just used, called it
   * "just missed", returned `scheduled: true`, and never created an alarm - so a daily automation ran once. MEASURED
   * before the fix: a run finishing 5s and 70s after its target both left `ALARM=undefined`.
   *
   * The occurrence that just fired is also recorded, so a restart or an import inside the same two minutes cannot treat
   * it as missed and run it a second time (B2).
   */
  try {
    /**
     * WHICH TARGET THIS RUN WAS FOR is read off the run record, not from a local.
     *
     * `attemptedTarget` does not exist in `finishRun`'s scope - it is local to the alarm handler - so the first version
     * of this fix referenced a variable that was not there. A `ReferenceError` inside the `try` would have been swallowed
     * by the surrounding catch and the re-arm would have silently not happened, which is the same class of failure as
     * the bug being fixed.
     */
    const ranFor = Number.isFinite(finished?.scheduledTarget) ? finished.scheduledTarget : null;
    if (Number.isFinite(ranFor)) await recordFiredTarget(automationId, ranFor);
    const fresh = await getAutomation(automationId);
    if (fresh?.schedule && fresh.schedule.kind !== 'manual') {
      await scheduleOne(fresh, { preferNext: true });
    }
  } catch { /* the run already finished; a schedule failure must not look like a run failure */ }

  return finished;
  } finally {
    /**
     * THE LOCK IS RELEASED ON EVERY EXIT PATH, including a throw from storage, the badge, or the host setup.
     *
     * Measured: without this, one failed `storage.session.set` left `activeRun` set and every later run was refused
     * until the worker restarted - reported to the user as "Run now does nothing" with no error anywhere. `releaseSlot`
     * is idempotent, so the normal path releasing it earlier is harmless.
     */
    await releaseSlot();
    try { await api.storage.session.remove('activeRun'); } catch { /* best effort */ }
    try { await setBadge(null); } catch { /* best effort */ }
  }
}

export function stopActiveRun() {
  if (!activeRun) return false;
  activeRun.stopFlag.stopped = true;
  if (activeRun.tabId != null) api.tabs.sendMessage(activeRun.tabId, { type: 'abort-step' }).catch(() => {});
  return true;
}

function publicActiveRun() {
  if (!activeRun) return null;
  return {
    /**
     * `id` IS THE AUTOMATION'S ID, and that is what every reader wants: the panel marks the running tab, the Window tab shows its
     * own Stop control, and the Automation list highlights the row. MEASURED, and it cost a browser run: the Window tab compared
     * `run.automationId` - a property this function does not send - so its Stop button never rendered, and an endless run had no
     * way to be stopped from the tab that started it.
     *
     * `automationId` is included as well, because a reader that has been written against the other name should not break and
     * because having both named is cheaper than having two readers disagree.
     */
    id: activeRun.id,
    automationId: activeRun.id,
    name: activeRun.name,
    tabId: activeRun.tabId,
    startedAt: activeRun.startedAt,
    trigger: activeRun.trigger,
    steps: activeRun.trace.filter((t) => t.type === 'step-ok' || t.type === 'step-fail').length,
  };
}

/**
 * TELL EVERY OPEN INTERFACE THAT A RUN'S STATE CHANGED.
 *
 * A one-way broadcast, deliberately: the panel may not be open, and a failure to deliver must never affect the run. The panel's
 * listener refreshes its active-run state and re-renders, which is what keeps a Stop control honest.
 */
async function announceRun(phase, automationId, reason = null) {
  try {
    await api.runtime.sendMessage({ type: 'run-state', phase, automationId, reason }).catch(() => {});
  } catch {
    // no receiver is a normal case, not an error
  }
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
  try {
    // every alarm is re-derived from storage: an alarm set before a restart cannot be trusted
    const automations = await listAutomations();
    await rescheduleAll(automations);
  } catch (e) {
    console.warn('[autoflow]', e);
  }
});

api.alarms.onAlarm.addListener(async (alarm) => {
  const alarmFiredAt = Date.now();
  let attemptedTarget = Number.isFinite(alarm.scheduledTime) ? alarm.scheduledTime : null;
  const id = automationIdFromAlarm(alarm.name);
  // recorded FIRST, before anything can throw: the previous version's failure mode was an alarm that arrived and
  // then died inside this handler, leaving no evidence that it had ever fired
  recordEvent({ kind: 'alarm-fired', automationId: id, alarmName: alarm.name, scheduledTime: alarm.scheduledTime });
  if (!id) return;
  try {
    const automation = await getAutomation(id);
    if (!automation || automation.enabled === false || !automation.schedule || automation.schedule.kind === 'manual') return;

    // Find or make a tab for this automation. Reusing the active tab would hijack whatever the user is
    // doing, so a matching tab is preferred and a new one is created only if none matches.
    let tabId = null;
    const patterns = automation.urls?.length ? automation.urls : [];
    if (patterns.length) {
      const tabs = await api.tabs.query({});
      /**
       * A pattern is turned into a REGEX, not into a literal with the stars deleted.
       *
       * The old code removed the stars and used `includes`, so `https://x.test/order/*` became a search for
       * `https://x.test/order/` - a different URL space than the pattern described - and a pattern of a single star
       * became the empty string, which matched EVERY tab. A regex keeps the star meaning "anything here", which is
       * what the field says it does.
       */
      /**
       * THE PATTERN IS MATCHED AGAINST THE URL'S HOST, by a real match-pattern parser.
       *
       * MEASURED with the substitution this replaces (`pattern.split('*').map(escape).join('.*')`), for
       * `*://*.example.com/*`:
       *
       *     https://evil.com/x.example.com/y   -> MATCH   (the domain was only in the PATH)
       *     https://example.com/              -> no match (Chrome's `*.` includes the bare domain)
       *
       * The first row is the dangerous one: a URL on an unrelated host matched because the regex could not tell the host
       * from the path, so clicks and form fills could be delivered to a site the user never named. The second row is the
       * ordinary failure - the user's own site did not match its own pattern.
       */
      const match = tabs.find((tab) => {
        const url = tab.url ?? '';
        return patterns.some((pattern) => matchesPattern(url, pattern));
      });
      if (match) tabId = match.id;
      else {
        /**
         * NO MATCH: OPEN THE PATTERN'S OWN SITE, or fail with a reason.
         *
         * A SCHEDULED run must never fall back to the active tab - that fallback is what made a mismatched automation
         * click on whatever the user happened to be looking at. A concrete URL can be opened deliberately; a wildcard
         * cannot, so it is refused rather than guessed at.
         *
         * A MANUAL run is different, and the difference is handled below: the user is looking at the page and pressed
         * Run, so "this tab" is what they mean.
         */
        /**
         * NO `throw` HERE. THIS WAS THE REGRESSION.
         *
         * MEASURED against v1.18.0, where the user's automation worked: the old path ended with a fallback to the active
         * tab. That fallback had to go (B5: it delivered clicks to an unrelated page), but the replacement threw from
         * inside this `else` - so execution never reached the remembered-page block below, which is where a Basic
         * automation is supposed to find its page. A Basic automation has no URL pattern, so it landed here EVERY time.
         *
         * The fix is ordering, not a new rule: try every source of a page first, and refuse only when none of them
         * produces one.
         */
        const concrete = patterns.map((p) => String(p)).find((p) => !p.includes('*')
          && !p.startsWith('<all_urls>') && /^[a-z][a-z0-9+.-]*:\/\//i.test(p));
        if (concrete) {
          const created = await api.tabs.create({ url: concrete, active: false });
          tabId = created.id;
          await new Promise((r) => setTimeout(r, 1500));
        } else {
          recordEvent({ kind: 'no-matching-tab', automationId: id, patterns });
        }
      }
    }
    /**
     * A pattern that resolves to nothing is a REFUSAL, not an invitation.
     *
     * The old code ended with "use the active tab of whatever window is in front", so an automation whose site was not
     * open ran its clicks on an unrelated page - a form fill on the wrong site is worse than not running.
     */
    if (!tabId) {
      /**
       * THIS HANDLER IS A SCHEDULED RUN BY DEFINITION, so there is no manual case to allow here.
       *
       * MEASURED, twice: the first version of this fix removed the active-tab fallback for manual runs too, which broke
       * every automation the user built without a URL pattern; the second version tried to restore it HERE, inside the
       * alarm handler, where `trigger` does not exist - so the handler threw `trigger is not defined` and the run was
       * recorded as a step-error with zero steps. Both were the same mistake in different clothes: the wrong place for
       * the rule.
       *
       * The manual path needs no fallback at all, because `startAutomationLocked` already resolves `tabId ?? the active
       * tab` before it claims the slot. A scheduled run is the case that must NOT guess: nobody is watching, so a click
       * on an unrelated page is worse than no click.
       */
      /**
       * THE PAGE THIS AUTOMATION WAS BUILT ON, if nothing better is known.
       *
       * MEASURED (user's log): a Basic automation - whose form never asks for a URL - failed with "no URL pattern, so a
       * scheduled run has no safe tab" and clicked nothing. Removing the active-tab fallback was right (B5: it delivered
       * clicks to an unrelated site) but it left this case with no answer at all.
       *
       * The remembered page is not a guess: it is the page the user was looking at when they picked the element this
       * automation clicks. It is only consulted AFTER the patterns have been tried, and only as a last resort.
       */
      const remembered = (await getSettings().catch(() => ({})))?.lastPickPages?.[id];
      if (typeof remembered === 'string' && /^(https?|file):/i.test(remembered)) {
        const open = (await api.tabs.query({})).find((t) => t.url === remembered);
        if (open?.id) {
          tabId = open.id;
          recordEvent({ kind: 'tab-from-memory', automationId: id, url: remembered });
        } else {
          const created = await api.tabs.create({ url: remembered, active: false });
          tabId = created.id;
          await new Promise((r) => setTimeout(r, 1500));
          recordEvent({ kind: 'tab-reopened', automationId: id, url: remembered });
        }
      }
    }
    if (!tabId) {
      throw new Error(patterns.length
        ? `no open tab matches ${patterns.filter((p) => String(p).trim()).join(', ')} - open the site, or give the automation a concrete URL`
        : 'this automation has never had an element picked in it, so a scheduled run has no page - pick one of its steps once, or add a URL');
    }

    // For a schedule with a second, the alarm arrived early on purpose. The target instant is recomputed from
    // the schedule instead of being carried on the alarm, so a worker restart between arming and firing cannot
    // lose it. If the alarm somehow fires after the target, this is null and the run starts immediately.
    let atMs = null;
    let lateBy = 0;
    if (wantsPreciseTiming(automation.schedule)) {
      /**
       * The alarm fired EARLY on purpose, so the schedule's next occurrence from *now* is the instant we are early
       * for - no arithmetic needed. (The first attempt subtracted a second from the alarm time, which landed
       * before the target and asked for the NEXT DAY's occurrence: the run waited for tomorrow and the click never
       * happened. Measured, not reasoned about.)
       *
       * LATE IS HANDLED TOO, and it is the other half of "it did not fire when its time came". If the machine was
       * asleep or the browser was busy, the alarm fires after the target. `nextRun` then returns the NEXT
       * occurrence - tomorrow - and the old code saw a target far away and dropped the run silently. Late by a
       * few seconds is still worth acting on for a window that is open; late by minutes is not. So the tolerance
       * is explicit and the lateness is recorded.
       */
      const now = Date.now();
      const next = nextRun(automation.schedule, now);
      /**
       * THE WINDOW MUST GROW WITH THE MARGIN.
       *
       * This threshold was `PRECISE_WAKE_MS + 5000`, a fixed 6.5s. Once the wake margin became adaptive and could
       * reach 20s, an alarm armed 20s early woke the worker with the target 20s away - outside this window - so the
       * code concluded it was early for a FUTURE occurrence, set `atMs = null` and fired immediately. The precise
       * path was skipped exactly when it was needed most.
       *
       * The window is now the margin that was actually used, which the alarm handler can compute from the same
       * latency sample `scheduleOne` uses, plus slack for the wake itself.
       */
      // the SAME formula as scheduleOne - two numbers that must agree, so they are derived from one sample the same way
      const expectedMargin = Math.min(await startLatencyMs() + PRECISE_WAKE_MS, 20_000);
      if (next && next - now <= expectedMargin + 5000) {
        atMs = next;                            // early, as designed
      } else {
        // was there a target we just missed? ask for the occurrence at or before now
        const planned = nextRun(automation.schedule, now - LATE_TOLERANCE_MS - 1);
        if (planned && planned <= now && now - planned <= LATE_TOLERANCE_MS) {
          lateBy = now - planned;
          atMs = null;                          // too late to wait for it; run now
          attemptedTarget = planned;
          // reported, not just computed: "it fired late" and "it fired on time" must be distinguishable in the export
          recordEvent({ kind: 'fired-late', automationId: id, lateByMs: lateBy });
        } else {
          const missedTarget = nextRun(automation.schedule, now - 26 * 3600_000);
          recordEvent({
            kind: 'fired-too-late',
            automationId: id,
            lateByMs: missedTarget && missedTarget <= now ? now - missedTarget : null,
            toleranceMs: LATE_TOLERANCE_MS,
          });
          await scheduleOne(automation, { now, preferNext: true }).catch(() => {});
          return;
        }
      }
    }

    if (Number.isFinite(atMs)) attemptedTarget = atMs;
    else if (!Number.isFinite(attemptedTarget)) {
      attemptedTarget = nextRun(automation.schedule, alarmFiredAt - 120_000) ?? alarm.scheduledTime ?? Date.now();
    }

    /**
     * RUN IT, WAITING FOR THE SLOT IF ANOTHER SCHEDULED RUN IS STILL GOING.
     *
     * THE BUG THIS FIXES, reported from a real test: two of five scheduled automations never fired. The cause was
     * not timing precision - it was a collision. Every alarm that shares a second arrives together, and
     * `startAutomation` refuses while `activeRun` is set, so the second and later ones were rejected with
     * "a run is already in progress". That refusal was then recorded as a run with reason `step-error`, so a run
     * that never happened looked like a run that failed.
     *
     * A millisecond gap between clicks would not have helped: the earlier runs are still armed, waiting for the
     * same precise instant, and their wait does not end just because the step is finished. What is needed is to
     * QUEUE, not to spread out by milliseconds - and five automations aimed at one second is not an accident, it
     * is exactly what an order window looks like.
     *
     * The wait is bounded: if the slot has not freed by then, the refusal is reported rather than hidden.
     */
    /**
     * `startAutomation` queues a scheduled trigger itself now, so this is a plain call. Keeping a retry loop here as
     * well would be two mechanisms for one rule, and the outer one would hide the inner one's timeout.
     *
     * `firedAt` is carried through so the run can report how long the scheduled path took to get going - that sample
     * is what the alarm's wake margin adapts to. Without it the margin stayed a constant guess.
     */
    /**
     * REFUSE A STORM.
     *
     * Measured failure mode: nine firings one second apart for the same automation, from a re-arm that kept asking
     * for the occurrence that had just failed. Each firing looked reasonable in isolation and the whole thing was
     * useless - no clicks, and the user only saw "it did not work".
     *
     * More than three firings inside ten seconds for one automation cannot be legitimate: the shortest schedule the
     * model allows is a whole second, and even that would not be armed this way. The firing is recorded and dropped,
     * which stops the storm while leaving evidence of it.
     */
    const recent = (globalThis.__recentFirings ??= new Map());
    const history = (recent.get(id) ?? []).filter((t) => alarmFiredAt - t < 10_000);
    history.push(alarmFiredAt);
    recent.set(id, history);
    if (history.length > 3) {
      recordEvent({ kind: 'storm-refused', automationId: id, firingsIn10s: history.length });
      /**
       * REFUSING THE FIRING MUST NOT ALSO KILL THE SCHEDULE.
       *
       * MEASURED (B3): this branch returned without re-arming. `chrome.alarms` entries are ONE-SHOT, so refusing the
       * firing left the automation with no alarm at all - it would never run again until the next browser start, and
       * nothing said so. The guard's job is to stop a storm, not to disable a schedule the user set.
       *
       * The next occurrence is resolved the same way the failure path does it, from one millisecond after the target
       * that was refused, with `preferNext` so the refused occurrence cannot come back as "just missed". The `try` is
       * deliberate: if the arithmetic fails there is nothing useful to do here, and a recurrence of the storm would be
       * worse than a missing alarm that the next startup re-arms anyway.
       */
      try {
        const fresh = await getAutomation(id);
        const from = Number.isFinite(atMs) ? atMs + 1 : Date.now();
        if (fresh) await scheduleOne(fresh, { now: Math.max(from, Date.now()), preferNext: true });
      } catch { /* the storm is already stopped; the next startup re-arms from storage */ }
      return;
    }

    /**
     * The instant this firing was FOR. `atMs` when the precise path resolved it; otherwise the alarm's own scheduled
     * time, which for a non-precise schedule IS the target. Used by the failure path to re-arm for the NEXT occurrence
     * rather than for the one that just failed.
     */
    const runWhenSlotIsFree = (extra = {}) =>
      startAutomation(id, { tabId, trigger: 'schedule', atMs, firedAt: alarmFiredAt, scheduledTarget: attemptedTarget, ...extra });

    // a CSV-driven automation iterates its rows
    const data = automation.dataSource?.key ? await getDataRows(automation.dataSource.key) : null;
    if (Array.isArray(data) && data.length) {
      for (const row of data) {
        await runWhenSlotIsFree({ row });
      }
    } else {
      await runWhenSlotIsFree();
 }
 if (lateBy > 0) {
   // recorded, not hidden: a click that lands 4s after 09:00:00 is a different event from one that lands on time
   console.warn(`[autoflow] ${id} fired ${lateBy}ms late - the machine or the browser was busy at its time`);
   recordEvent({ kind: 'alarm-late', automationId: id, lateByMs: lateBy });
 }
  } catch (e) {
    /**
     * RE-ARM DESPITE THE FAILURE.
     *
     * The next occurrence was only armed on the success path, so a start that failed once silently ended the
     * schedule: the automation never fired again and nothing said so. A schedule is a standing instruction; a failed
     * run is one missed attempt, not a reason to cancel the instruction. The failure is still recorded, and the
     * re-arm is best-effort so it cannot mask the original error.
     */
    try {
      const again = await getAutomation(id);
      if (again?.enabled !== false && again?.schedule && again.schedule.kind !== 'manual') {
        /**
         * RE-ARM FOR THE NEXT OCCURRENCE, NOT FOR THE ONE THAT JUST FAILED.
         *
         * `scheduleOne(x)` means "the next occurrence from now", and when the failure happens BEFORE the target that
         * is the SAME occurrence, seconds away. So a failing start re-armed the instant it had just failed, the alarm
         * fired again, failed again - a storm of alarms that consumed the very second it was aiming at. Measured: nine
         * firings one second apart and not a single click.
         *
         * Asking from one millisecond after the failed target makes the next occurrence the following one. A second
         * guard refuses to re-arm at all if that computation lands back in the past, so no arithmetic mistake here can
         * ever produce a storm again.
         */
        /**
         * ASK FROM THE FAILED TARGET, AND NEVER RE-ARM A MOMENT THAT IS ALREADY IN THE PAST.
         *
         * MEASURED (your log, 1.34.0): `basic-new1` fired at 18:45:05.517, re-armed for its 18:45:07.000 target, and fired
         * again at 18:45:06.534 - then again at 18:45:07.551. Three firings inside two seconds, and the reason is that
         * `scheduleOne` arms PRECISE_WAKE_MS (1500ms) EARLY:
         *
         *     18:45:07.000 target, armed at 18:45:05.500  <- already in the past when the re-arm ran at 18:45:05.528
         *
         * so the alarm was created with a time behind `now` and Chrome fired it immediately. `attemptedTarget + 1` is not
         * enough, because the wake happens a whole margin before the target it is aiming at.
         *
         * `Math.max(after, Date.now())` did not help either: `after` is the target, which is still ahead, and
         * `scheduleOne` then subtracts the margin again. The fix is to ask from a point that leaves room for the margin,
         * so the arm lands in the future.
         */
        const margin = Math.min(await startLatencyMs() + PRECISE_WAKE_MS, 20_000);
        const after = Number.isFinite(attemptedTarget) ? attemptedTarget + 1 : Date.now();
        const askedFrom = Math.max(after, Date.now() + margin);
        const armed = await scheduleOne(again, { now: askedFrom, preferNext: true });
        if (!armed?.scheduled || (armed.target ?? armed.at) <= Date.now()) {
          recordEvent({ kind: 'arm-skipped', automationId: id, note: 'the next occurrence did not resolve to the future' });
        } else {
          recordEvent({ kind: 're-armed', automationId: id, target: armed.target, afterFailedTarget: attemptedTarget ?? null });
        }
      }
    } catch { /* the re-arm failing must not replace the original error */ }
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
  try {
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
  } catch (e) {
    console.warn('[autoflow]', e);
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
/**
 * What a CONTENT SCRIPT may ask for. Anything not in this list is refused from a page.
 *
 * `remember-pick-page` is deliberately NOT here: it is called by the extension's own panel, and a page must not be able
 * to change where an automation is pointed.
 */
/**
 * The pick currently in progress, so the page a pick came from can be recorded against the right automation.
 *
 * `element-picked` arrives from the content script with no idea which automation it is for - the panel knows, because it
 * started the pick. Carrying it here is what lets the worker keep the record without the panel being involved.
 */
let pendingPick = null;

/** Store the page an automation was built on. Used only when a scheduled run has no URL pattern to go on. */
async function setPickPage(automationId, url) {
  if (!automationId || !/^(https?|file):/i.test(String(url ?? ''))) return false;
  try {
    const s = await getSettings();
    const map = { ...(s.lastPickPages ?? {}), [automationId]: String(url) };
    await saveSettings({ lastPickPages: map });
    return true;
  } catch { return false; }
}

const CONTENT_SCRIPT_MESSAGES = new Set([
  'content-ready',
  'element-picked',
  'element-pick-cancelled',
  'run-status',
  /**
   * `read-file-for-upload` was missing here, so the content script's request was refused and the upload step could
   * never work. It is safe to allow: it takes a NAME from the extension's own stored upload list and returns bytes
   * for that name only, so a page cannot use it to read anything the user did not already store in the extension.
   */
  'read-file-for-upload',
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
  /**
   * A page on another scheme is a PAGE, not this extension talking to itself.
   *
   * `file://` and `ftp://` fell through to 'internal', which is the most privileged class - so a page opened from
   * disk could send any message the panel can. The test field the user works with is served over file://, which is
   * how this matters in practice and not just in theory.
   */
  if (/^(file|ftp|data|blob):/i.test(url)) return 'content-script';
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

      case 'element-picked': {
        /**
         * THE WORKER RECORDS THE PAGE ITSELF.
         *
         * This is the moment the page is known for certain - the content script is running in it. Recording it here
         * rather than in the panel means the record survives the panel being closed, which is the normal state when a
         * schedule fires.
         *
         * The automation it belongs to comes from the pick that was started: `pick-element` carries `automationId`, and
         * `pendingPick` holds it while the user is choosing.
         */
        const forAutomation = pendingPick?.automationId ?? null;
        if (forAutomation && typeof msg.url === 'string') {
          await setPickPage(forAutomation, msg.url);
        }
        pendingPick = null;
        /**
         * THE WORKER DOES NOT FORWARD THIS. The content script's `runtime.sendMessage` already reaches the panel.
         *
         * MEASURED (user report, 1.23.0): one click, TWO `element-picked` messages at the panel - the first from the
         * content script, the second from this forward. The first copy found the step and consumed `state.pickTarget`;
         * every later copy found nothing and took the `else` branch, which is the sentence the user kept seeing:
         * "but no point was waiting for it". The selector had landed, which is why it "still worked" and the message
         * looked like noise - it was noise, produced here.
         *
         * A message sent with `runtime.sendMessage` from a content script is delivered to every extension context that
         * listens, so forwarding it adds a second delivery rather than adding reach.
         */
        return { ok: true };
      }

      /**
       * A CANCELLED PICK MUST REACH THE PANEL (B11).
       *
       * The type was in the content-script allowlist and the panel listened for it, but there was no case here - so the
       * message fell through to the default and was never forwarded. The panel's Pick button stayed in its
       * "picking" state forever after the user pressed Escape on the page, with no way to tell that nothing was coming.
       */
      case 'element-pick-cancelled':
        api.runtime.sendMessage({ type: 'element-pick-cancelled' }).catch(() => {});
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

      /**
       * Measure the offset between this machine and a server, from THREE samples spread over time.
       *
       * The samples used to be taken back to back, milliseconds apart, so their sub-second phase was identical and
       * the median of three removed nothing - it only made the reading look stable. A short pause between samples
       * moves the phase, at the cost of about 300ms of latency for a control the user pressed on purpose.
       *
       * A TIMEOUT is now applied to each request. Without one, a slow or hanging server left the panel waiting
       * forever, which is a worse outcome than a failed measurement.
       */
      case 'measure-clock-offset': {
        /**
         * Compare this machine's clock with a server's, using one same-origin HEAD request.
         *
         * The extension made NO network requests before this. Adding one is a deliberate trade and is stated
         * in the docs: it is the only way to know whether the machine's clock is seconds off, and a schedule
         * that acts at the wrong real moment is the one failure the extension cannot otherwise detect. The
         * request carries nothing - no body, no cookies of ours, no identifiers - and only the `Date`
         * response header is read.
         *
         * `msg.url` is required so this never fires against an address the user did not intend; the caller
         * passes the URL of the tab the automation targets.
         */
        const url = typeof msg.url === 'string' ? msg.url : null;
        if (!url || !/^https?:/i.test(url)) {
          throw new Error('a http(s) url is required to measure the offset');
        }
        const samples = [];
        for (let i = 0; i < 3; i++) {
          /**
           * A TIMEOUT per request, and a PAUSE between samples.
           *
           * Without a timeout, a slow or hanging server left the panel waiting forever - a failed measurement is a
           * better outcome than a control that never returns. Without the pause, the three samples were taken
           * milliseconds apart, so their sub-second phase was identical and the median removed nothing: it made the
           * reading look stable without making it more accurate. A pause of about a tenth of a second moves the
           * phase enough for the median to mean something, at a cost of ~200ms on a button the user pressed.
           */
          if (i > 0) await new Promise((r) => setTimeout(r, 30 + i * 57));
          const t0 = Date.now();
          const res = await fetch(url, {
            method: 'HEAD',
            cache: 'no-store',
            credentials: 'omit',
            signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
              ? AbortSignal.timeout(8000)
              : undefined,
          });
          const header = res.headers.get('date');
          const t1 = Date.now();
          if (!header) throw new Error('the server sent no Date header');
          const parsed = new Date(header).getTime();
          if (!Number.isFinite(parsed)) throw new Error('the Date header could not be parsed');
          samples.push(clockOffset({ t0, t1, serverStamp: parsed }));
        }
        // the median of three, because a single sample can be spoiled by a routed request; the median also
        // makes the result stable between two runs, which matters when the user is watching the number
        const sorted = [...samples].sort((a, b) => a.offsetMs - b.offsetMs);
        const median = sorted[1];
        return {
          ok: true,
          offsetMs: median.offsetMs,
          rttMs: median.rttMs,
          uncertaintyMs: median.uncertaintyMs,
          trustworthy: samples.every((s) => s.trustworthy),
          samples: samples.map((s) => ({ offsetMs: s.offsetMs, rttMs: s.rttMs })),
          measuredAt: Date.now(),
        };
      }

      case 'ping-tab': {
        /**
         * Ping a tab, and say WHICH tab was pinged.
         *
         * `msg.tabId` is honoured when given. "The active tab" is ambiguous - it can be an extension page,
         * which no content script is injected into, so the ping then fails with
         * "Cannot access contents of url chrome-extension://..." and reads as a broken message channel when
         * it is really a wrongly-chosen tab. A caller that knows which tab it means should say so.
         *
         * The resolved id is returned either way, so a caller can see what was actually pinged instead of
         * having to infer it.
         */
        const tabId = Number.isInteger(msg.tabId)
          ? msg.tabId
          : (await api.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (!tabId) throw new Error('no active tab');
        const res = await sendToTab(tabId, { type: 'ping' });
        return { ok: true, tabId, page: res };
      }

      /**
       * THE PAGE A PICK CAME FROM IS REMEMBERED, because a scheduled run has to know where to go.
       *
       * MEASURED (user's log, 1.19.0):
       *
       *     runs:  basic  step-error  ERROR: this automation has no URL pattern, so a scheduled run has no safe tab
       *
       * The Basic form never asks for a URL, so every automation built there had no pattern - and removing the
       * active-tab fallback (correctly, B5) left those automations unable to run on a schedule at all. The page is
       * known at the one moment the user is actually pointing at it: when they pick an element in it.
       */
      /**
       * A pick in progress is remembered by the WORKER, not by the panel.
       *
       * MEASURED: the first version stored the page from the panel's message handler, so the record only existed while
       * the panel was open - and the case that matters is a scheduled run with the panel closed. The worker receives the
       * pick from the content script either way, so the worker is where the record has to live.
       *
       * `automationId` is supplied by the panel when it starts the pick, because that is the only moment anything knows
       * which automation the pick is for.
       */
      case 'remember-pick-page': {
        const id = String(msg.automationId ?? '');
        if (!id) return { ok: false, error: 'no automationId' };
        if (!/^(https?|file):/i.test(String(msg.url ?? ''))) return { ok: false, error: 'not a page url' };
        await setPickPage(id, String(msg.url));
        return { ok: true };
      }

      case 'pick-element': {
        /**
         * NEVER PICK IN OURSELVES.
         *
         * The active tab is the PANEL when the panel is opened as a tab, or when it is the only tab in its window - and
         * `start-picking` then went to the panel, which has no picker. The panel showed "Picking…" while nothing
         * anywhere responded, and the only exit was to click something, which recorded nothing useful.
         *
         * A page is what can be picked in, so a page is what is looked for: the last-focused real page first, then any
         * page at all. Reporting "no page" is better than starting a pick that cannot work.
         */
        /**
         * PICKABLE MEANS THE CONTENT SCRIPT CAN RUN THERE.
         *
         * "Not our own tab" was too loose: `about:blank`, `chrome://`, `devtools://` and `view-source:` are all not
         * ours and none of them can host a content script, so a pick aimed at one failed with "Cannot access contents
         * of url ... Extension manifest must request permission to access this host". Measured, and it is what a
         * newly-opened tab looks like.
         *
         * The condition is now positive - an http(s) or file URL - which is exactly the set where picking is possible.
         */
        const canPickIn = (t) => Boolean(t?.id) && /^(https?|file):/i.test(String(t?.url ?? ''));
        const pages = (await api.tabs.query({})).filter(canPickIn);
        if (!pages.length) throw new Error('no page to pick from - open the site you want to pick in');

        const active = (await api.tabs.query({ active: true, lastFocusedWindow: true })).filter(canPickIn);
        const target = active[0] ?? pages[pages.length - 1];
        /**
         * WHICH AUTOMATION IS THIS PICK FOR, and the page it is happening in.
         *
         * Both are recorded now: the automation from the caller (the panel's Pick button knows its step), and the page
         * from the tab being picked in. If the pick is cancelled the record is simply overwritten next time, so there is
         * nothing to undo.
         */
        pendingPick = {
          automationId: typeof msg.automationId === 'string' ? msg.automationId : null,
          tabId: target.id,
        };
        if (pendingPick.automationId) await setPickPage(pendingPick.automationId, target.url);
        await sendToTab(target.id, { type: 'start-picking' });
        return { ok: true, tabId: target.id, url: target.url };
      }

      case 'reschedule': {
        const automations = await listAutomations();
        return { ok: true, results: await rescheduleAll(automations) };
      }

      /**
       * Build the diagnostic export.
       *
       * Assembled in the worker because this is the only place that can see the alarms, the run history and the
       * event log together. Nothing leaves the machine: the text is returned to the caller, which offers it as a
       * download. There is no network code on this path.
       */
      case 'export-diagnostics': {
        // queued appends are flushed first: an export taken straight after a test would otherwise miss the newest
        // events, which are the ones being investigated
        await flushEvents();
        const manifest = api.runtime.getManifest();
        const s = await getSettings();
        const alarms = await api.alarms.getAll().catch(() => []);
        const runs = await listRuns().catch(() => []);
        const automations = (await listAutomations()).map((a) => ({
          id: a.id, name: a.name, enabled: a.enabled !== false, schedule: a.schedule,
          urls: a.urls ?? [], steps: (a.steps ?? []).map((x) => ({ kind: x.kind, id: x.id })),
          /**
           * THE OPTIONS ARE INCLUDED BECAUSE THE LOG MUST BE ABLE TO ANSWER ITS OWN QUESTIONS.
           *
           * MEASURED: the user reported "the gap between picks was not applied" and the export could not settle it - it
           * listed the automations without their options, so neither of us could tell whether the gap had been stored at
           * all. The per-time settings `clickGapMs` and the other runner options now appear, so a future report like this
           * is answered by the file rather than by a round of questions.
           */
          options: a.options ?? {},
        }));
        const header = buildHeader({
          version: manifest.version,
          browser: (() => { try { return api.runtime.getBrowserInfo ? 'firefox' : (navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome'); } catch { return 'unknown'; } })(),
          platform: navigator.userAgent,
          timezoneOffsetMin: new Date().getTimezoneOffset(),
        });
        const events = await readEvents();
        /**
         * Counts, so an empty profile can be told apart from a report that lost its data. The last export showed no
         * automations, no alarms and no events with nothing explaining why, and that reads as a fault rather than as
         * "nothing is saved".
         */
        const allLocal = await api.storage.local.get(null).catch(() => ({}));
        const storageSummary = {
          automations: automations.length,
          alarms: alarms.length,
          runs: runs.length,
          events: events.length,
          settingsKeys: Object.keys(allLocal ?? {}).length,
          firstLoad: Object.keys(allLocal ?? {}).length === 0,
        };
        const doc = buildExport({
          header,
          events,
          runs: runs.slice(0, 40),
          automations,
          alarms: alarms.map((a) => ({ name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes })),
          // the page's own log is fetched from the page rather than duplicated here, so it is the page's truth
          pageLogs: Array.isArray(msg.pageLogs) ? msg.pageLogs : [],
          storageSummary,
          settings: { ...s, diagnosticEvents: `(${events.length} events, listed above)` },
          includedPaths: [
            'src/background/service-worker.js: alarm -> decision -> run',
            'src/core/diag/events.js: bounded local event log',
            'the test page, if its export button was pressed',
          ],
        });
        return { ok: true, text: exportAsText(doc), doc };
      }

      case 'clear-diagnostics': {
        await clearEvents();
        return { ok: true };
      }

      /**
       * Write one numbered event, for testing that the log is in order.
       *
       * Exists because the appends are queued to stop concurrent writes clobbering each other, and a queue that is
       * not FIFO would scramble the trail - which is the one thing the trail is for. Only reachable from an
       * extension page.
       */
      case 'record-test-event': {
        recordEvent({ kind: 'ordering-probe', n: msg.n });
        return { ok: true };
      }

      /** Tabs that might have the content script, so the export can ask each one for its click log. */
      case 'list-runnable-tabs': {
        const all = await api.tabs.query({});
        return {
          ok: true,
          tabs: all
            .filter((t) => t.id != null && /^(https?|file):/i.test(t.url ?? ''))
            .map((t) => ({ id: t.id, url: t.url, title: t.title })),
        };
      }

      /**
       * One tab's own click log.
       *
       * The page holds the truth about when a click reached it: an extension that reported its own timestamps
       * would be reporting the very thing under suspicion. So this asks the page rather than reconstructing.
       */
      case 'page-log': {
        try {
          const res = await api.tabs.sendMessage(msg.tabId, { type: 'get-click-log' });
          return { ok: true, clicks: res?.clicks ?? [] };
        } catch (e) {
          return { ok: false, error: String(e?.message ?? e) };
        }
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
        const incoming = msg.automation ?? {};
        recordEvent({
          kind: 'save-request',
          automationId: incoming.id ?? null,
          scheduleKind: incoming.schedule?.kind ?? null,
          stepCount: Array.isArray(incoming.steps) ? incoming.steps.length : 0,
          name: incoming.name ?? null,
        });
        const saved = await saveAutomation(msg.automation);
        /**
         * ARM OR DISARM THE SCHEDULE. This was missing, and it is why a saved time never fired.
         *
         * `rescheduleAll` at worker start deliberately leaves existing alarms alone, so a restart cannot disturb a
         * valid pending alarm. The consequence was that nothing ever created an alarm for an automation the user had
         * just saved: the panel wrote the record and returned. Reported as "I set a time and saved it, and it did not
         * activate" - and the export confirmed it, showing a stale alarm from an earlier session and no alarm at all
         * for the new target time.
         *
         * Failure here must not fail the save: the record is already stored, and a schedule that could not be armed
         * is reported rather than silently swallowed.
         */
        let schedule = { scheduled: false, reason: 'not attempted' };
        try {
          schedule = saved.enabled === false || saved.schedule?.kind === 'manual'
            ? { scheduled: false, reason: 'manual' }
            : await scheduleOne(saved);
          if (schedule.scheduled) {
            recordEvent({ kind: 'armed', automationId: saved.id, at: schedule.at, target: schedule.target, precise: schedule.precise, via: 'save' });
          }
        } catch (e) {
          schedule = { scheduled: false, reason: String(e?.message ?? e) };
          recordEvent({ kind: 'arm-failed', automationId: saved.id, error: schedule.reason });
        }
        /**
         * A STALE ALARM IS ONLY STALE IF THE SCHEDULE IS GONE.
         *
         * This cancelled the alarm on ANY unsuccessful arm. MEASURED (`three-times-test`, intermittent): three times were
         * stored, each with its own point and target, and one of them had NO alarm - `alarm names:
         * ["autoflow:run:basic-new2","autoflow:run:basic-new1"]` with the third record present and correct. The cause is
         * here: one arm attempt on `basic` did not report success, so a perfectly good alarm that was already registered
         * for that automation was CLEARED - and the time would then never fire, with the panel showing it as saved and
         * armed.
         *
         * Cancelling is right for the two cases where an alarm must not exist: the automation is gone or disabled, or its
         * schedule is manual. For a transient arm failure the previous alarm is better than none: it is still the right
         * time to fire, and re-arming happens on the next save, the next run and every worker start.
         */
        const gone = saved.enabled === false || !saved.schedule || saved.schedule.kind === 'manual';
        if (!schedule.scheduled && gone) {
          await cancelOne(saved.id);
        }
        /**
         * A SAVE THAT ARMED NOTHING SAYS SO, and it is recorded too.
         *
         * The export that prompted this had no automations, no alarms and no events, which could equally mean the
         * extension lost everything or that Save had never worked. Both are `ok: true` from the panel's point of view,
         * and a schedule that arms nothing is exactly the case worth reporting.
         */
        if (!schedule.scheduled) {
          recordEvent({
            kind: 'save-armed-nothing',
            automationId: saved.id,
            reason: schedule.reason ?? 'unknown',
            manual: saved.schedule?.kind === 'manual',
          });
        }
        return { ok: true, automation: saved, schedule };
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
        /**
         * RE-ARM WHAT WAS RESTORED. A restore that writes the records but arms no alarms looks complete and is not:
         * the automations would sit there until the next worker start re-schedules them, and a schedule saved for a
         * time in between would be missed. The count is returned so the panel can say so.
         */
        const report = await importAll(msg.document, {
          replace: msg.replace === true,
          // a script step is only accepted when the caller has explicitly confirmed it, which the UI does
          // after showing the user what the file contains
          allowScripts: msg.allowScripts === true,
        });
        /**
         * WHAT WAS IMPORTED IS NOT ARMED, and what was already here still is.
         *
         * MEASURED (B7): rearming everything meant a restored file armed and started automations the user had never seen -
         * a file is data from outside this machine, and nothing in it should be able to schedule an order before a person
         * has read it. Imported records now arrive `enabled: false`, so `rescheduleAll` skips them by itself; this call
         * exists to keep the EXISTING schedules correct, which a replace can disturb.
         *
         * A restore that produced nothing returns `refused` (storage refused to erase), and nothing is rearmed.
         */
        const rearm = report.refused ? [] : await rescheduleAll(await listAutomations());
        const rearmed = rearm.filter((r) => r.ok && r.at).length;
        recordEvent({ kind: 'imported', imported: report.imported ?? 0, rearmed, replace: msg.replace === true, refused: report.refused === true });
        return { ok: report.refused !== true, ...report, rearmed };
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
        /**
         * Cancelling must reach the SAME tab that is picking, and that tab is not necessarily the active one - the user
         * may have switched tabs since. Asking the page is more reliable than guessing: every content script is told to
         * stop, and a page that is not picking ignores it.
         */
        // the same set the pick could have started in, so a cancel reaches exactly where a pick might be running
        const pages = (await api.tabs.query({})).filter((t) => Boolean(t?.id)
          && /^(https?|file):/i.test(String(t?.url ?? '')));
        let stopped = 0;
        for (const t of pages) {
          const res = await api.tabs.sendMessage(t.id, { type: 'stop-picking' }).catch(() => null);
          if (res?.ok) stopped += 1;
        }
        return { ok: true, stopped };
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
