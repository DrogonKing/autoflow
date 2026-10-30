/**
 * The content script.
 *
 * It is the page-side half of the runner's host: it receives one already-resolved step, performs it with
 * the DOM modules, and answers with a result or an error. It holds no run state of its own — loops,
 * variables and branching all live in the service worker — because a page can navigate mid-run and take
 * any local state with it.
 *
 * It also implements the element picker, which is the other thing that has to run here.
 */

import { api } from '../platform/api.js';
import { safeSend } from '../platform/serialise.js';
import { findElement, findAll, describeElement, buildFinder, isVisible } from '../core/dom/finder.js';
import { afterClick, describeAllClicks, normaliseAll, pickNext } from '../core/dom/clickAll.js';
import {
  realClick, fillElement, selectOption, pressKeys, scrollAction, ActionError,
} from '../core/dom/actions.js';

const PICKER_ATTR = 'data-autoflow-pick';

/**
 * Answer a message.
 *
 * Two failure modes are handled, both of which are silent without this:
 *
 *   - the port is gone (a closed panel), so sending throws and there is nothing to do about it
 *   - the payload contains something a message port cannot carry. A runtime message is structured-cloned,
 *     and a function cannot be cloned. Chromium drops such a property; Firefox throws
 *     "Function object could not be cloned" and the whole step fails. Values here come from a web page, so
 *     `value` on a plain element can be a function the page defined.
 */
function reply(sendResponse, payload) {
  const outcome = safeSend(sendResponse, payload, 'the step result');
  if (!outcome.sent && outcome.secondError) {
    // even the sanitised form could not be sent: report the reason in the simplest shape that can travel
    try {
      sendResponse({ ok: false, error: `the reply could not be sent: ${outcome.firstError}` });
    } catch { /* the port is gone */ }
  }
}

/**
 * Click every match, re-resolving the list between clicks.
 *
 * Why re-resolve: the page is live. On an order page the list collapses as each button is pressed, so an
 * index into a snapshot taken at the start stops pointing at anything. Re-resolving and always taking the
 * same POSITION (the last, by default) is what makes "click all ten" actually click ten.
 *
 * The loop is bounded by `all.limit` and by a sanity ceiling, so a page that keeps producing new matches
 * cannot spin forever - which is the failure mode that would fire orders.
 */
async function clickEveryMatch(step, all) {
  const started = Date.now();
  /**
   * The hard stop, and it is now REPORTED rather than silent.
   *
   * It used to stop at 200 while the panel validated up to 5000, so a limit of 3000 announced "all 200 clicked"
   * with `stoppedEarly: false` - a completed run as far as anyone could see. When the ceiling is reached the result
   * now says so, because "I stopped" and "I finished" are different answers to a question about orders.
   */
  const CEILING = 200;
  let clicked = 0;
  let stoppedEarly = false;
  let reason = '';

  /**
   * The elements already clicked, BY IDENTITY.
   *
   * A WeakSet, not a set of indices. An index is only meaningful while the list is being consumed: on a page
   * whose matches stay put, "the last one" is the same element every time. That is not hypothetical - this
   * loop, in its first version, clicked one button 159 times on the simulation page until the run timed out.
   * Identity is the thing that is actually true: has this element been pressed.
   *
   * Weak so a node the page discards is not kept alive, and so an element the page re-creates counts as new.
   */
  const done = new WeakSet();

  /**
   * The number of matches seen on the FIRST pass, which is the number the user cares about.
   *
   * It used to be overwritten on every pass, so the final report came from the last pass - by which time a list
   * that shrinks as it is clicked (a real order list does) is empty, and a completed run of ten announced
   * "10 of 0 clicked". The value reported is a property of the list when it was found, not of the leftovers.
   */
  let total = 0;
  let firstPassTotal = 0;
  let hitCeiling = false;

  for (let pass = 0; pass < CEILING; pass++) {
    // the whole candidate list on this pass, filtered the same way a single click would be
    const found = findAll(document, step.finder, { requireVisible: true, requireActionable: true });
    total = found.elements.length;
    if (pass === 0) firstPassTotal = total;
    if (pass === CEILING - 1 && (found.elements ?? []).length > 1) {
      // the ceiling is a safety stop, not a completion: say so rather than letting the result read as "all of them"
      hitCeiling = true;
    }
    const el = pickNext({
      candidates: found.elements,
      isVisited: (x) => done.has(x),
      order: all.order,
      taken: clicked,
      limit: all.limit,
    });
    if (!el) break;                    // nothing left unvisited: finished, not stuck

    let ok = true;
    try {
      realClick(el, { button: step.button, clickCount: step.clickCount ?? 1 });
      done.add(el);
    } catch (e) {
      ok = false;
      reason = String(e?.message ?? e);
    }

    const decision = afterClick({
      // the total reported to the policy is the first-pass count, so "how many of how many" stays meaningful while
      // the list is being consumed
      succeeded: ok, taken: clicked + 1, total: Math.max(firstPassTotal, clicked + 1), onErrorPolicy: step.onError,
    });
    if (ok) clicked += 1;
    if (decision.action === 'stop') {
      stoppedEarly = true;
      reason = decision.reason ?? reason;
      break;
    }

    // give the page a moment to process the click before looking again
    if (all.gapMs > 0 && Date.now() - started < 120_000) {
      await new Promise((r) => setTimeout(r, all.gapMs));
    }
  }

  return {
    how: `${clicked} of ${Math.max(firstPassTotal, clicked)} clicked (${all.order})`
      + (hitCeiling ? ` - STOPPED AT THE CEILING of ${CEILING}` : ''),
    clicked,
    total: Math.max(firstPassTotal, clicked),
    // the ceiling is a different outcome from "finished", and a caller that cannot tell them apart will report a
    // truncated run as a complete one
    hitCeiling,
    stoppedEarly: stoppedEarly || hitCeiling,
    summary: describeAllClicks({
      clicked,
      total: Math.max(firstPassTotal, clicked),
      stoppedEarly,
      reason,
      language: globalThis.document?.documentElement?.getAttribute('data-autoflow-lang'),
    }),
  };
}

/**
 * Perform one step.
 *
 * @param {Object} step an already template-resolved step from the runner
 * @returns {Promise<Object>} a result the trace can record
 */
/**
 * Sleep until a wall-clock instant, as precisely as a page can.
 *
 * WHY NOT ONE setTimeout. A single long timer drifts with page throttling and with the event loop being busy;
 * it can also be silently clamped in a background tab. So this corrects: it sleeps most of the remaining time,
 * then re-reads the clock and sleeps again, and finally spins on a short interval for the last few
 * milliseconds. `Date.now()` is the reference, not a counter, so drift cannot accumulate.
 *
 * A background tab is throttled to roughly one timer per second by the browser, which no page can override.
 * That is stated in the documentation rather than hidden: for a second-accurate click the tab must be visible.
 */
async function waitUntil(targetMs) {
  const remaining = () => targetMs - Date.now();

  // Phase 1: sleep in chunks, re-reading the clock so a throttled timer cannot overshoot.
  // A BACKGROUND TAB throttles setTimeout to about once per second, so this phase can return up to a second
  // early - which was measured: five runs landed 479-756ms BEFORE the target for exactly this reason.
  while (remaining() > 250) {
    await new Promise((r) => setTimeout(r, Math.min(remaining() - 200, 500)));
  }

  // Phase 2: the last stretch on a short timer. This is where the accuracy comes from, and it only works
  // when the tab is not throttled - i.e. visible.
  while (remaining() > 30) {
    await new Promise((r) => setTimeout(r, 5));
  }

  // Phase 3: the final window without timers at all. Bounded to the last 30ms so it cannot burn the CPU for
  // a noticeable stretch, and it is the only way to land inside the same frame as the target.
  while (remaining() > 0) {
    // deliberate spin, bounded above
  }
  return Date.now() - targetMs;
}

/**
 * Is this tab going to be throttled? True when it is hidden or not the active tab.
 *
 * Used to WARN rather than to refuse: a background tab can still be clicked, it just cannot promise a second.
 */
function tabIsThrottled() {
  try {
    if (document.visibilityState === 'hidden') return true;
    return document.hidden === true;
  } catch {
    return false;
  }
}

async function performStep(step) {
  const needsElement = step.kind !== 'wait' && step.kind !== 'goto' && step.kind !== 'reload' &&
    step.kind !== 'back' && step.kind !== 'forward' && step.kind !== 'newTab' &&
    step.kind !== 'switchTab' && step.kind !== 'closeTab' && step.kind !== 'runScript' &&
    step.kind !== 'notify' && step.kind !== 'sound' && step.kind !== 'download' &&
    step.kind !== 'screenshot' && step.kind !== 'stop' && step.kind !== 'screenshot';

  // ---- precise timing: hold the step until its target instant
  //
  // `atMs` is set by the worker when the schedule carried a second. The wait happens HERE rather than in the
  // worker because the page's timer is the last thing before the click, and every millisecond spent in the
  // worker's path is a millisecond of lateness.
  let waitedMs = null;
  let waitWasThrottled = false;
  if (Number.isFinite(step.atMs) && step.atMs > Date.now()) {
    // recorded BEFORE the wait: a throttled tab is the single reason a precise schedule can still miss, so the
    // trace has to say whether it was throttled rather than leaving the offset unexplained
    const throttled = tabIsThrottled();
    waitedMs = await waitUntil(step.atMs);
    if (throttled) {
      // surfaced, not swallowed: this is the difference between "clicked at 09:00:00.02" and "clicked early"
      waitWasThrottled = true;
    }
  }

  let el = null;
  let how = '';
  if (needsElement && step.finder) {
    const found = findElement(document, step.finder, {
      requireVisible: step.kind !== 'check' && step.kind !== 'fill',
      requireActionable: step.kind === 'click' || step.kind === 'hover',
    });
    if (!found.element) {
      throw new ActionError(
        `could not find ${how || 'the element'} - nothing matched (tried: ${
          (found.tried ?? []).map((t) => t.how).join('; ')})`,
        { tried: found.tried, finder: step.finder },
      );
    }
    el = found.element;
    how = found.how;
  }

  /**
   * THE TIMING REPORT WAS DEFINED AND NEVER USED.
   *
   * MEASURED: this helper existed, and `withTiming` had exactly ONE occurrence in the file - its own definition. So
   * `timingOffsetMs` and `timingThrottled` never reached a step result, which means a run never reported how late its
   * precise click actually landed. That is the number every "the click missed the second" report depends on, and it was
   * being computed and discarded.
   *
   * It is applied where the results leave: `runStep`'s own return, via `report`. One place, so a new step kind cannot
   * forget it.
   */
  const withTiming = (r) => (waitedMs === null ? r
    : { ...r, timingOffsetMs: waitedMs, ...(waitWasThrottled ? { timingThrottled: true } : {}) });

  /**
   * ONE EXIT POINT, so the timing report cannot be forgotten.
   *
   * Wrapping the switch rather than patching each of the fourteen `return` statements: a missed return would silently drop
   * `timingOffsetMs` again, and that is exactly the bug being fixed.
   */
  const result = await (async () => {
  switch (step.kind) {
    case 'click': {
      // ---- click EVERY match, when the step asks for it
      //
      // The finding above resolved one element. With `clickAll` set the step means "every match", so the list
      // is re-resolved before each click instead of being captured once. That matters on a live page: pressing
      // one of these buttons usually makes the list shrink or re-render, and an index into a stale snapshot
      // would then click nothing, click the wrong thing, or throw on a detached node.
      //
      // The ORDER and the STOPPING RULE come from core/dom/clickAll.js, which is pure and separately tested.
      const all = normaliseAll(step.clickAll);
      if (all) {
        return await clickEveryMatch(step, all);
      }
      return { how, ...realClick(el, { button: step.button, clickCount: step.clickCount ?? 1 }) };
    }

    case 'fill':
      return { how, ...fillElement(el, step.value ?? '', { clearFirst: step.clearFirst !== false }) };

    case 'clear':
      return { how, ...fillElement(el, '', { clearFirst: true }) };

    case 'check':
      return { how, ...fillElement(el, step.checked ? 'true' : 'false') };

    case 'select':
      return { how, ...selectOption(el, step.values ?? step.value) };

    case 'hover': {
      const rect = el.getBoundingClientRect();
      const w = el.ownerDocument.defaultView;
      const opts = {
        bubbles: true, cancelable: true, composed: true, view: w,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      };
      el.dispatchEvent(new w.MouseEvent('mouseover', opts));
      el.dispatchEvent(new w.MouseEvent('mouseenter', { ...opts, bubbles: false }));
      el.dispatchEvent(new w.MouseEvent('mousemove', opts));
      return { how, hovered: true };
    }

    case 'focus':
      el.focus?.();
      return { how, focused: el.ownerDocument.activeElement === el };

    case 'blur':
      el.blur?.();
      return { how, blurred: true };

    case 'submit': {
      const form = el.tagName === 'FORM' ? el : el.form ?? el.closest?.('form');
      if (!form) throw new ActionError('there is no form to submit around this element');
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return { how, submitted: true };
    }

    case 'scroll': {
      if (step.target === 'element' && step.finder) {
        el.scrollIntoView?.({ block: step.block ?? 'center', inline: 'nearest' });
        return { how, method: 'scrollIntoView' };
      }
      return scrollAction({ target: step.target ?? 'window', mode: step.mode ?? 'by', x: step.x ?? 0, y: step.y ?? 0, el });
    }

    case 'key':
      return { how, ...(await pressKeys(el, step.keys, { gapMs: step.gapMs ?? 0, holdMs: step.holdMs ?? 0 })) };

    case 'wait':
      await new Promise((r) => setTimeout(r, step.ms));
      return { waited: step.ms };

    case 'waitFor': {
      const timeout = step.timeoutMs ?? 15_000;
      const poll = step.pollMs ?? 200;
      const started = Date.now();
      let last = null;
      while (Date.now() - started <= timeout) {
        last = observe(step.finder, step.condition);
        if (conditionMatches(step.condition, last)) {
          return { how, matchedAfterMs: Date.now() - started, observed: last };
        }
        await new Promise((r) => setTimeout(r, poll));
      }
      // Report what was last seen. "Timed out" alone leaves the user unable to tell whether the element
      // was missing, hidden, or simply had different text.
      const seen = last === null
        ? 'nothing observed'
        : `found=${last.found} value=${JSON.stringify(String(last.value ?? '').slice(0, 80))}`
          + ` flags=${JSON.stringify(last.flags ?? {})} count=${last.count ?? 0}`;
      throw new ActionError(
        `waited ${timeout} ms for a condition that did not become true (last observed: ${seen})`,
      );
    }

    case 'extract': {
      if (!step.finder) throw new ActionError('extract needs a finder');
      const found = findElement(document, step.finder, { requireVisible: false });
      const source = step.source ?? 'text';
      if (source === 'count') return { value: String(found.candidates ?? 0) };
      if (!found.element) {
        // a missing element extracts an empty string rather than failing the run: a page that has not
        // rendered yet is a normal situation, and the user's next step decides what to do about it
        return { value: '', found: false };
      }
      const e = found.element;

      /**
       * Read the requested source and ALWAYS return a string.
       *
       * A reply travels over a message port, which structured-clones it, and a function is not cloneable.
       * That is easy to hit by accident: `e.value` on a plain <div> is `undefined`, but on a page that has
       * put a function on the property it is a function, and a branch that falls through can return
       * `getAttribute` itself. Chromium drops such a property silently; Firefox throws
       * "Function object could not be cloned". Coercing here makes the reply serialisable on both, and the
       * value a user gets is the same either way.
       */
      const read = () => {
        switch (source) {
          case 'value': return e.value;
          case 'attribute': return step.attribute ? e.getAttribute(step.attribute) : '';
          case 'html': return e.innerHTML;
          case 'text': return (e.textContent ?? '').trim();
          default: return (e.textContent ?? '').trim();
        }
      };

      let raw;
      try {
        raw = read();
      } catch (err) {
        throw new ActionError(`could not read the ${source} of the element: ${err?.message ?? err}`);
      }
      if (raw === null || raw === undefined) return { value: '', found: true, how: found.how };
      if (typeof raw === 'object') {
        // an object would be a surprising thing to extract; its string form is what a template can use
        try {
          return { value: JSON.stringify(raw), found: true, how: found.how, note: 'the value was an object' };
        } catch {
          return { value: String(raw), found: true, how: found.how };
        }
      }
      return { value: String(raw), found: true, how: found.how };
    }

    case 'upload': {
      /**
       * Attach a file to a file input.
       *
       * A page cannot set `input.files` itself - the property is read-only to page script - which is why
       * the DOM cannot be used to fake a user's file choice. An extension can construct a File and a
       * DataTransfer and assign that, which is the same mechanism a user's picker ultimately produces.
       * Only files already fetched by the extension can be attached: a path on disk is not reachable.
       */
      if (!el || el.tagName !== 'INPUT' || el.type !== 'file') {
        throw new ActionError('upload needs a file input (<input type="file">)');
      }
      const files = Array.isArray(step.files) ? step.files : [step.files].filter(Boolean);
      if (files.length === 0) throw new ActionError('upload needs at least one file');

      const built = [];
      for (const spec of files) {
        const name = typeof spec === 'string' ? spec : spec.name;
        if (!name) throw new ActionError('each uploaded file needs a name');
        // the content is fetched by the extension itself, never by this page-side code, so no page
        // permission or CORS rule is involved
        const res = await api.runtime.sendMessage({ type: 'read-file-for-upload', name });
        if (!res?.ok) throw new ActionError(res?.error || `could not read the file ${name}`);
        const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
        built.push(new File([bytes], name, { type: res.mime || 'application/octet-stream' }));
      }

      const dt = new DataTransfer();
      for (const f of built) dt.items.add(f);
      el.files = dt.files;
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return { how, method: 'data-transfer', files: built.map((f) => f.name) };
    }

    case 'runScript': {
      // Runs in the page's main world via a DOM script element, so it can reach page globals. The
      // extension's own privileged APIs are deliberately out of reach from here.
      const result = await runInPage(step.code);
      return { result };
    }

    case 'screenshot':
      return { note: 'handled by the service worker (captureVisibleTab)' };

    case 'notify':
      return { note: 'handled by the service worker' };

    case 'sound':
      return { note: 'handled by the service worker' };

    case 'download':
      return { note: 'handled by the service worker' };

    default:
      throw new ActionError(`the page side does not handle step kind "${step.kind}"`);
  }
  })();
  return withTiming(result);
}

/** Read the page for a condition, returning the shape the condition evaluator expects. */
function observe(finder, condition) {
  if (!finder || (condition && ['url', 'title', 'variable', 'js'].includes(condition.source))) {
    if (condition?.source === 'url') return { value: location.href };
    if (condition?.source === 'title') return { value: document.title };
    return { value: null, found: false, flags: {} };
  }
  const result = findElement(document, finder, { requireVisible: false });
  const el = result.element ?? null;
  const found = Boolean(el);
  // `candidates` is how many matched, which is what a count condition needs. Reading `el.count` was the
  // bug: an Element has no such property, and on a miss it threw instead of reporting a count of zero.
  const count = result.candidates ?? 0;
  const flags = found
    ? {
        visible: isVisible(el),
        hidden: !isVisible(el),
        checked: el.checked === true,
        unchecked: el.checked !== true,
        enabled: el.disabled !== true,
        disabled: el.disabled === true,
      }
    : { visible: false, hidden: false, checked: false, unchecked: false, enabled: false, disabled: false };
  const value = found
    ? (condition?.source === 'value' ? el.value
      : condition?.source === 'attribute' ? el.getAttribute(condition.attribute)
      : el.textContent?.trim() ?? '')
    : null;
  return { value, found, flags, count, how: result.how, matched: count };
}

/** The page-side mirror of core/engine/conditions.js, kept minimal because the evaluator runs in the worker. */
function conditionMatches(condition, observed) {
  const cmp = condition.comparator;
  if (cmp === 'exists') return observed.found;
  if (cmp === 'notExists') return !observed.found;
  if (['visible', 'hidden', 'checked', 'unchecked', 'enabled', 'disabled'].includes(cmp)) {
    return observed.flags?.[cmp] === true;
  }
  if (!observed.found) return false;
  const a = String(observed.value ?? '');
  const b = String(condition.value ?? '');
  const ci = condition.caseSensitive !== true;
  const A = ci ? a.toLowerCase() : a;
  const B = ci ? b.toLowerCase() : b;
  switch (cmp) {
    case 'eq': return A === B;
    case 'neq': return A !== B;
    case 'contains': return A.includes(B);
    case 'notContains': return !A.includes(B);
    case 'startsWith': return A.startsWith(B);
    case 'endsWith': return A.endsWith(B);
    case 'matches': try { return new RegExp(b, ci ? 'i' : '').test(a); } catch { return false; }
    case 'gt': return Number(a) > Number(b);
    case 'gte': return Number(a) >= Number(b);
    case 'lt': return Number(a) < Number(b);
    case 'lte': return Number(a) <= Number(b);
    case 'empty': return a.trim() === '';
    case 'notEmpty': return a.trim() !== '';
    default: return false;
  }
}

/**
 * Run code in the page's main world.
 *
 * A `script` element is used rather than `eval` so the code executes with the page's globals. Anything
 * the page returns synchronously is captured; async results are not awaited, because a message channel
 * that could be blocked indefinitely by page code is a deadlock waiting to happen.
 */
function runInPage(code) {
  return new Promise((resolve) => {
    const token = `autoflow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const holder = document.createElement('div');
    holder.id = token;
    holder.style.display = 'none';
    // The holder MUST be in the document, because the injected script finds it with getElementById to
    // publish its result. Without this line the script ran, found nothing, and every runScript step
    // returned "no synchronous result" - a value could never come back. Found by running a runScript step
    // against a real page; the unit tests did not cover the return path.
    document.documentElement.appendChild(holder);
    const script = document.createElement('script');
    script.textContent = `(function(){
      var out;
      try { out = (function(){ ${code} })(); }
      catch (e) { out = { __autoflowError: String(e && e.message || e) }; }
      var el = document.getElementById(${JSON.stringify(token)});
      if (el) el.setAttribute('data-result', JSON.stringify(out === undefined ? null : out));
    })();`;
    document.documentElement.appendChild(script);
    script.remove();
    const result = holder.getAttribute('data-result');
    holder.remove();
    if (result === null) {
      resolve({ note: 'the script produced no synchronous result', hint: 'the code must `return` a value' });
      return;
    }
    try {
      const parsed = JSON.parse(result);
      if (parsed && parsed.__autoflowError) resolve({ error: parsed.__autoflowError });
      else resolve(parsed);
    } catch {
      resolve({ note: 'the script result was not JSON-serialisable' });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// element picker
// ---------------------------------------------------------------------------------------------

let picking = false;
let pickerOverlay = null;
let lastHover = null;

function ensureOverlay() {
  if (pickerOverlay) return pickerOverlay;
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed', 'pointer-events:none', 'z-index:2147483647',
    'border:2px solid #2962ff', 'background:rgba(41,98,255,0.14)',
    'border-radius:2px', 'transition:all 40ms linear', 'display:none',
  ].join(';');
  document.documentElement.appendChild(el);
  pickerOverlay = el;
  return el;
}

function positionOverlay(target) {
  const overlay = ensureOverlay();
  if (!target) {
    overlay.style.display = 'none';
    return;
  }
  const r = target.getBoundingClientRect();
  overlay.style.display = 'block';
  overlay.style.left = `${r.left}px`;
  overlay.style.top = `${r.top}px`;
  overlay.style.width = `${r.width}px`;
  overlay.style.height = `${r.height}px`;
}

function isOurUi(node) {
  return node === pickerOverlay || node?.closest?.('[data-autoflow-ui]') != null;
}

function onPickerMove(e) {
  const target = e.target;
  if (isOurUi(target)) return;
  lastHover = target;
  positionOverlay(target);
}

function onPickerClick(e) {
  e.preventDefault();
  e.stopPropagation();
  const target = e.target;
  if (isOurUi(target)) return;
  stopPicking();
  const info = describeElement(target);
  const finder = buildFinder(target);
  /**
   * THE PAGE TRAVELS WITH THE PICK.
   *
   * The worker stores it per automation, because a Basic automation has no URL pattern and a scheduled run needs a page
   * to go to. Measured: without this, a scheduled Basic automation reported "no URL pattern, so a scheduled run has no
   * safe tab" and clicked nothing. The content script knows its own location, so it says so.
   */
  api.runtime.sendMessage({ type: 'element-picked', info, finder, url: location.href }).catch(() => {});
}

function onPickerKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    stopPicking();
    api.runtime.sendMessage({ type: 'element-pick-cancelled' }).catch(() => {});
  }
}

function startPicking() {
  if (picking) return;
  picking = true;
  document.addEventListener('mousemove', onPickerMove, true);
  document.addEventListener('click', onPickerClick, true);
  document.addEventListener('keydown', onPickerKey, true);
  document.documentElement.style.cursor = 'crosshair';
}

function stopPicking() {
  picking = false;
  document.removeEventListener('mousemove', onPickerMove, true);
  document.removeEventListener('click', onPickerClick, true);
  document.removeEventListener('keydown', onPickerKey, true);
  document.documentElement.style.cursor = '';
  positionOverlay(null);
}

// ---------------------------------------------------------------------------------------------
// message handling
// ---------------------------------------------------------------------------------------------

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  /**
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
  if (sender?.id !== api.id) {
    return false;
  }
  /**
   * Refuse a sender that is a WEB PAGE.
   *
   * The check is written against the thing being guarded, not against a scheme literal. A previous version
   * compared to `chrome-extension://` and therefore rejected the extension's own background page on
   * Firefox, where the scheme is `moz-extension://` - so every page action failed there with "the page gave
   * no answer". What matters is that the sender is not http(s); any extension scheme is ours.
   */
  const senderUrl = String(sender?.url ?? '');
  if (senderUrl && /^(https?|ftp|data|blob|file):/i.test(senderUrl)) {
    return false;
  }
  // and an unknown scheme is not ours either
  if (senderUrl && !/^[a-z-]+-extension:\/\//i.test(senderUrl)) {
    return false;
  }

  switch (msg.type) {
    /**
     * The page's own click log, for the diagnostic export.
     *
     * Comes from the page rather than from here: the question under investigation is when the browser dispatched
     * the click, and only the page's own handler knows that.
     */
    case 'get-click-log': {
      /**
       * Read the page's own log through the DOM, because this script runs in an isolated world and cannot see the
       * page's `window` variables. The test field publishes its log as JSON in a data attribute for exactly this
       * reason; a page that does not publish one simply returns an empty list.
       */
      let clicks = [];
      try {
        const raw = document.documentElement.getAttribute('data-autoflow-clicks');
        if (raw) clicks = JSON.parse(raw);
      } catch { /* malformed or absent: an empty log, not an error */ }
      sendResponse({ ok: true, clicks: Array.isArray(clicks) ? clicks : [] });
      return true;
    }

    case 'ping':
      // used by the worker to check the page is still there before each step
      reply(sendResponse, { ok: true, url: location.href, readyState: document.readyState });
      return true;

    case 'perform-step':
      performStep(msg.step)
        .then((result) => reply(sendResponse, { ok: true, result }))
        .catch((err) => reply(sendResponse, {
          ok: false,
          error: err?.message ?? String(err),
          name: err?.name ?? 'Error',
          detail: err?.detail ?? null,
        }));
      return true;

    case 'observe':
      try {
        reply(sendResponse, { ok: true, observed: observe(msg.finder, msg.condition) });
      } catch (e) {
        reply(sendResponse, { ok: false, error: e.message });
      }
      return true;

    case 'start-picking':
      startPicking();
      reply(sendResponse, { ok: true });
      return true;

    case 'stop-picking':
      stopPicking();
      reply(sendResponse, { ok: true });
      return true;

    case 'highlight': {
      if (msg.finder) {
        try {
          /**
           * `element`, NOT `elements`.
           *
           * MEASURED: `findElement` returns `{ element, how, candidates, tried }` - a single element - so this destructured
           * a name that does not exist, leaving `undefined`, and the next line called `getBoundingClientRect()` on it. Every
           * `highlight` message therefore threw, which is the typing indicator an `if` step uses to show what it is looking
           * at: the feature looked like it did nothing.
           */
          const { element } = findElement(document, msg.finder, { requireVisible: false });
          if (element) {
            const r = element.getBoundingClientRect();
            const overlay = ensureOverlay();
            overlay.style.display = 'block';
            overlay.style.left = `${r.left}px`;
            overlay.style.top = `${r.top}px`;
            overlay.style.width = `${r.width}px`;
            overlay.style.height = `${r.height}px`;
            overlay.style.borderColor = '#00c853';
            setTimeout(() => positionOverlay(null), msg.ms ?? 1500);
          }
        } catch { /* a highlight must never break anything */ }
      }
      reply(sendResponse, { ok: true });
      return true;
    }

    default:
      return false;
  }
});

// A marker in the DOM, because the page cannot see this script's `chrome` object: content scripts run
// in an isolated world. This is how the extension's presence is observable from outside, and it lets the
// test suite verify injection rather than assume it.
try {
  document.documentElement.setAttribute('data-autoflow-content', api.runtime.getManifest().version);
  if (window.top === window) document.documentElement.setAttribute('data-autoflow-top', '1');
} catch { /* a sandboxed frame has no runtime; not fatal */ }

// Tell the worker this frame is alive, so it can pick the right frame to act in.
api.runtime.sendMessage({
  type: 'content-ready',
  url: location.href,
  isTop: window.top === window,
}).catch(() => {});
