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
  rescheduleAll, scheduleOne, cancelOne, automationIdFromAlarm, ALARM_PREFIX, listScheduled,
} from './alarms.js';
import { nextRun, wantsPreciseTiming, PRECISE_WAKE_MS } from '../core/schedule/schedule.js';
import { clockOffset } from '../core/clock/skew.js';
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
function makeHost(tabId, { stopFlag, onTrace, opts }) {
  const startedAt = Date.now();

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
      const tab = await api.tabs.get(tabId).catch(() => null);
      return Boolean(tab);
    },

    onTrace,

    async execute(step) {
      // Attach the precise target to the step that will act. It is put on the step rather than in a global so
      // the content script cannot act on a stale value from a previous run in the same tab.
      if (pendingAtMs !== null && step.kind !== 'wait' && step.kind !== 'notify' && step.kind !== 'goto') {
        /**
         * Bring the tab to the front first, when the automation asks for it.
         *
         * WHY: Chromium throttles setTimeout in a background tab to roughly once per second, which makes a
         * second-accurate wait impossible - measured as five runs landing 479-756ms EARLY, all of them. A
         * visible tab is not throttled, and `tabs.update({active:true})` is the only way an extension can lift
         * it. It is opt-in because taking focus is a visible, intrusive action.
         */
        if (opts.focusBeforePrecise) {
          try {
            await api.tabs.update(tabId, { active: true });
            await api.windows.update?.((await api.tabs.get(tabId))?.windowId, { focused: true });
            // a short settle: the throttle decision is made per task, and one frame is enough for it to lift
            await new Promise((r) => setTimeout(r, 60));
          } catch {
            // focus is best-effort; the run still proceeds, just possibly throttled and reported as such
          }
        }
        const withTarget = step.atMs === undefined ? { ...step, atMs: pendingAtMs } : step;
        pendingAtMs = null;       // once only: a later step must not wait for a moment already passed
        step = withTarget;
      }
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
            /**
             * A DATA URL, not a blob URL.
             *
             * `URL.createObjectURL` does not exist in a Manifest V3 service worker - there is no document and no
             * blob registry - so any download step that carried content threw. A data URL is just a string and works
             * from the worker. It is base64, so it is about a third larger; that is the price of it working at all.
             */
            url = `data:${step.mimeType || 'application/octet-stream'};base64,${await bytesToBase64(blob)}`;
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

  recordEvent({ kind: 'start-request', automationId, trigger: opts.trigger ?? 'manual', lateByMs: opts.lateByMs });

  for (;;) {
    if (!activeRun && !startingUp) {
      const token = { claimedAt: Date.now() };
      startingUp = token;                     // synchronous: no await between the test above and this
      // logged HERE, at the instant of acceptance, before any await. Recorded later it landed after the run it
      // started, which read as if the run were accepted once it had already finished.
      recordEvent({ kind: 'start-accepted', automationId, trigger: opts.trigger ?? 'manual' });
      try {
        // the acceptance is logged INSIDE the locked body, at the moment it is accepted. Logging it after the await
        // put ACCEPTED after FINISHED in the trail, which reads as if the run were accepted once it had already
        // ended - unhelpful in precisely the case this log exists for.
        return await startAutomationLocked(automationId, { ...opts, token });
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
  const opts = { ...automation.options, atMs };
  const targetTabId = tabId ?? (await api.tabs.query({ active: true, currentWindow: true }))[0]?.id;
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
  recordEvent({
    kind: 'run-finished', automationId, reason: finished.reason, steps: finished.steps,
    error: finished.error?.message ?? null,
  });
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
  // recorded FIRST, before anything can throw: the previous version's failure mode was an alarm that arrived and
  // then died inside this handler, leaving no evidence that it had ever fired
  recordEvent({ kind: 'alarm-fired', automationId: id, alarmName: alarm.name, scheduledTime: alarm.scheduledTime });
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
      /**
       * A pattern is turned into a REGEX, not into a literal with the stars deleted.
       *
       * The old code removed the stars and used `includes`, so `https://x.test/order/*` became a search for
       * `https://x.test/order/` - a different URL space than the pattern described - and a pattern of a single star
       * became the empty string, which matched EVERY tab. A regex keeps the star meaning "anything here", which is
       * what the field says it does.
       */
      const escapeForRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const asRegex = (pattern) => {
        const body = String(pattern).split('*').map(escapeForRegex).join('.*');
        return new RegExp(`^${body}$`, 'i');
      };
      const match = tabs.find((tab) => {
        const url = tab.url ?? '';
        return patterns.some((pattern) => {
          if (asRegex(pattern).test(url)) return true;
          // a saved pattern with no wildcard is treated as a prefix, because a live tab URL almost never equals it
          // character for character
          return !String(pattern).includes('*') && url.startsWith(String(pattern));
        });
      });
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
      if (next && next - now <= PRECISE_WAKE_MS + 5000) {
        atMs = next;                            // early, as designed
      } else {
        // was there a target we just missed? ask for the occurrence at or before now
        const planned = nextRun(automation.schedule, now - LATE_TOLERANCE_MS);
        if (planned && now - planned <= LATE_TOLERANCE_MS) {
          lateBy = now - planned;
          atMs = null;                          // too late to wait for it; run now
        }
      }
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
    // `startAutomation` queues a scheduled trigger itself now, so this is a plain call. Keeping a retry loop
    // here as well would be two mechanisms for one rule, and the outer one would hide the inner one's timeout.
    const runWhenSlotIsFree = (extra = {}) =>
      startAutomation(id, { tabId, trigger: 'schedule', atMs, ...extra });

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
        await scheduleOne(again);
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
        }));
        const header = buildHeader({
          version: manifest.version,
          browser: (() => { try { return api.runtime.getBrowserInfo ? 'firefox' : (navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome'); } catch { return 'unknown'; } })(),
          platform: navigator.userAgent,
          timezoneOffsetMin: new Date().getTimezoneOffset(),
        });
        const events = await readEvents();
        const doc = buildExport({
          header,
          events,
          runs: runs.slice(0, 40),
          automations,
          alarms: alarms.map((a) => ({ name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes })),
          // the page's own log is fetched from the page rather than duplicated here, so it is the page's truth
          pageLogs: Array.isArray(msg.pageLogs) ? msg.pageLogs : [],
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