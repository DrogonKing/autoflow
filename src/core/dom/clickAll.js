/**
 * Clicking every match, instead of only the first.
 *
 * THE PROBLEM THIS SOLVES. `findElement` returns `chosen[finder.index ?? 0]`, so one `click` step clicks one
 * element. When a page shows ten buttons all labelled "ارسال پی در پی سفارش" (send orders one after another),
 * a single step presses the first in DOM order and stops. The user asked for the other behaviour by name.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE. The interesting logic is not the clicking, it is the ORDER, the COUNT,
 * and the RE-CHECK between clicks. On a live order page the DOM changes when you press one of these buttons:
 * the list may shrink, re-render, or the button may disappear. Clicking a stale NodeList would either click
 * nothing, click the wrong thing, or throw on a detached node. So the decision of "find the next one" is pure
 * and testable, and the caller does the finding - which is what makes it provable without a browser.
 *
 * WHY NOT `Array.from(matches).forEach(click)`. Three concrete failures:
 *   1. A NodeList is live for some selectors and static for others; iterating a live one while the page
 *      re-renders is how you skip or double-click.
 *   2. The element at index 3 before the first click is not necessarily the element at index 3 after it.
 *   3. An exception on match 4 aborts the remaining six with no record of which ones were done.
 */

/** The stored defaults, exported so the UI and the tests use the same numbers. */
export const ALL_DEFAULTS = {
  /** How the list of matches is walked. */
  order: 'reverse',        // 'reverse' | 'forward' | 'as-is'
  /** Stop after this many. 0 means every match. */
  limit: 0,
  /** Pause between clicks, in ms. Not zero by default: a page that re-renders needs a moment. */
  gapMs: 250,
  /** Replace the whole list with this many matches taken one at a time, rather than keeping the first. */
  perElement: true,
};

/**
 * Which match to click next.
 *
 * `taken` is how many have already been clicked. Returns the index into the CURRENT list of candidates, or
 * null when there is nothing left to do. It takes a count rather than an array so it is trivially testable and
 * so the caller cannot accidentally hold a stale reference.
 *
 * `reverse` is the default because a button that sends an order usually moves the page or shifts the list: if
 * the list is being consumed from the top, taking from the bottom means the remaining indices do not move.
 * That is the difference between clicking all ten and clicking five of them twice.
 */
export function nextIndex({ taken, remaining, order = 'reverse', limit = 0 }) {
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  if (limit > 0 && taken >= limit) return null;
  if (order === 'forward') return 0;                    // always the first of what is left
  if (order === 'as-is') return taken < remaining ? taken : null;
  // reverse: the LAST of what is left, so consuming from the end cannot shift the indices still to come
  return remaining - 1;
}

/**
 * The whole plan, decided before anything is clicked.
 *
 * Deliberately returns a description rather than performing anything, so a test can assert the behaviour of
 * ten buttons with no DOM at all, and so the UI can show the user what is about to happen before it happens.
 */
export function planClicks({ count, order = 'reverse', limit = 0 }) {
  if (!Number.isFinite(count) || count <= 0) {
    return { count: 0, indices: [], skipped: 'no matches' };
  }
  const wanted = limit > 0 ? Math.min(count, limit) : count;
  const indices = [];
  if (order === 'forward') {
    for (let i = 0; i < wanted; i++) indices.push(i);
  } else if (order === 'as-is') {
    for (let i = 0; i < wanted; i++) indices.push(i);
  } else {
    // reverse: count down from the end, which is the sequence nextIndex produces given a shrinking list
    for (let i = 0; i < wanted; i++) indices.push(count - 1 - i);
  }
  return { count: wanted, indices, skipped: null };
}

/**
 * Should the run keep going after a click?
 *
 * A separate decision because the honest answer depends on the page: on an order page, a failure part-way
 * through should stop the rest rather than keep firing. The caller passes what happened; this decides.
 */
export function afterClick({ succeeded, taken, total, onErrorPolicy = 'stop' }) {
  if (succeeded) return { action: 'continue' };
  if (onErrorPolicy === 'continue') return { action: 'continue' };
  if (onErrorPolicy === 'skip') return { action: 'continue' };
  return { action: 'stop', reason: `click ${taken} of ${total} failed` };
}

/**
 * A human sentence for the trace, so History says what actually happened.
 *
 * "clicks 2->6" in a trace is not enough to tell whether six were wanted or whether it stopped early - and
 * that distinction is the whole reason this feature exists.
 */
export function describeAllClicks({ clicked, total, stoppedEarly, reason, language = 'en' }) {
  const fa = language === 'fa';
  if (total === 0) return fa ? 'هیچ عنصری پیدا نشد' : 'nothing matched';
  if (stoppedEarly) {
    return fa
      ? `${clicked} از ${total} زده شد، بعد متوقف شد${reason ? ` (${reason})` : ''}`
      : `${clicked} of ${total} clicked, then stopped${reason ? ` (${reason})` : ''}`;
  }
  return fa ? `همهٔ ${clicked} عنصر زده شد` : `all ${clicked} clicked`;
}

/** Bounds for the stored values, so a bad value cannot make the run behave strangely. */
export function normaliseAll(all) {
  if (!all || typeof all !== 'object') return null;
  const order = ['reverse', 'forward', 'as-is'].includes(all.order) ? all.order : 'reverse';
  const limitRaw = Number(all.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 5000) : 0;
  const gapRaw = Number(all.gapMs);
  // A gap below ~50ms is almost certainly a mistake on a page that re-renders: the click lands before the
  // page has processed the previous one. Clamped rather than rejected, so the run still does something.
  const gapMs = Number.isFinite(gapRaw) ? Math.max(50, Math.min(Math.floor(gapRaw), 60_000)) : ALL_DEFAULTS.gapMs;
  return { order, limit, gapMs, perElement: all.perElement !== false };
}
