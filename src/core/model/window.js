/**
 * THE WINDOW TAB'S MODEL: a start instant with millisecond precision, and an optional end.
 *
 * WHAT THE USER ASKED FOR, in their words:
 *   "بشه بهش زمان با دقت میلی ثانیه داد ... اون زمان ابتدا داشته باشه ولی انتهاش اجباری نباشه مثلا شروع 08:44:45.500 باشه
 *    انتهاش دو حالت اگر خالی بود انقدر کلیک کنه تا گزینه استاپ رو دستی بزنم یا انتهاش زمان داشته باشه 08:50:33:200"
 *
 * Note the two separators in their message: `08:44:45.500` (a dot before the milliseconds) and `08:50:33:200` (a COLON). Both
 * are accepted, because a user who typed one and had it rejected would read that as the field being broken.
 *
 * WHY THIS IS A MODULE AND NOT CODE INSIDE THE PANEL: the panel runs `chrome.runtime.onMessage` at file scope, so it cannot be
 * imported by a unit test - a test written against it would have to hold a COPY of the parser, and a copy is never wrong. That
 * exact arrangement is how the click-gap field rejected Persian digits while its test stayed green. One implementation, imported
 * by both.
 */

import { normaliseDigits } from '../text/digits.js';

const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(n).padStart(3, '0');

/**
 * THE LONGEST WINDOW A TYPED END CAN DESCRIBE, in milliseconds. Twelve hours.
 *
 * This exists to tell two IDENTICAL-LOOKING cases apart, which is the only hard part of the end field:
 *
 *   start 23:50, end 00:10  ->  the end is EARLIER in the day, and the window really does cross midnight. Allowed. Span: 20 min.
 *   start 08:44, end 08:30  ->  the end is earlier in the day too, but this is a MISTAKE. Span if rolled: 23 h 46 min.
 *
 * Both present as "the end time-of-day is less than the start's", so the time-of-day alone cannot distinguish them. The resulting
 * span can: a window of half a day or less is a plausible crossing, and anything longer is far more likely to be a typo than an
 * intention - and the user has a better way to say "run for a very long time": leave the end EMPTY. Refusing a mistyped end beats
 * silently starting an all-day run on a trading page.
 */
export const MAX_WINDOW_SPAN_MS = 12 * 60 * 60 * 1000;

/**
 * Parse a wall-clock time into a datetime-of-day, milliseconds included.
 *
 * ACCEPTED SHAPES, all of which the user may reasonably type:
 *   `08:44:45.500`   the documented form
 *   `08:44:45:500`   a colon before the milliseconds - this is how it appeared in the request
 *   `08:44:45`       no milliseconds, taken as `.000`
 *   `8:44:45.5`      single digits and one-digit milliseconds, widened (`5` -> `500`, not `005`)
 *   `۰۸:۴۴:۴۵٫۵۰۰`  Persian digits and the Persian DECIMAL separator U+066B
 *
 * A trailing `٫` (U+066B) is a decimal point in Persian; `٬` (U+066C) is a thousands separator and is rejected here by simply
 * not being a digit or a separator this parser accepts. Conflating the two once turned `8,450,000` into a parse failure elsewhere
 * in this project, so the distinction is deliberate.
 *
 * @returns {{hour:number, minute:number, second:number, ms:number} | null} `null` when the text is not a time at all.
 */
export function parseTimeOfDay(text) {
  if (text === null || text === undefined) return null;
  // normalise digits first, then the Persian decimal separator, then trim
  let s = normaliseDigits(String(text)).trim();
  if (!s) return null;
  s = s.replace(/\u066B/g, '.').replace(/\u060C|\u066C/g, '');   // ٫ -> '.', drop ٬ and the Arabic comma

  /**
   * THE SEPARATOR BEFORE THE MILLISECONDS MAY BE `.` OR `:`. Both appear in the request, so both are accepted. Everything else
   * must be digits and colons - a stray letter makes the whole field invalid rather than silently zero.
   */
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:[.:](\d{1,3}))?$/.exec(s);
  if (!m) return null;

  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = m[3] === undefined ? 0 : Number(m[3]);
  /**
   * ONE-DIGIT MILLISECONDS ARE WIDENED, NOT PADDED WITH LEADING ZEROS: `.5` means five hundred milliseconds, which is what a
   * person writing a decimal fraction means. `.05` is fifty, `.005` is five.
   */
  const ms = m[4] === undefined ? 0 : Number(m[4].padEnd(3, '0'));

  if (hour > 23 || minute > 59 || second > 59 || ms > 999) return null;
  return { hour, minute, second, ms };
}

/** Format a time-of-day back into `HH:MM:SS.mmm`, which is the shape the field shows and the record stores. */
export function formatTimeOfDay({ hour = 0, minute = 0, second = 0, ms = 0 } = {}) {
  return `${pad2(hour)}:${pad2(minute)}:${pad2(second)}.${pad3(ms)}`;
}

/**
 * The absolute instant a time-of-day means, on a given day.
 *
 * `nowMs` decides the day, so the caller controls it: the panel passes the wall clock, a test passes a fixed instant. A time
 * already past today is NOT silently rolled to tomorrow here - `resolveStartInstant` does that, because the two questions
 * ("what instant on this day" and "is that still ahead of me") deserve separate answers and separate tests.
 */
export function instantOnDay(nowMs, time) {
  const d = new Date(nowMs);
  d.setHours(time.hour, time.minute, time.second, time.ms);
  return d.getTime();
}

/**
 * WHEN THE WINDOW SHOULD START, given the typed start and the current instant.
 *
 * THE RULE: use today. If that instant has already passed, use tomorrow and say so.
 *
 * The "say so" is the point. A start time that has passed cannot be honoured, and the two alternatives are both bad in silence:
 * running immediately ignores what the user typed, and refusing makes the tab look broken. Rolling to tomorrow and REPORTING it
 * (`rolledToTomorrow: true`) is the only option that keeps the user's intent and tells them what will happen.
 *
 * MEASURED LESSON FROM THE SAME PROJECT: a schedule whose instant is in the past is reported by the engine as
 * `FIRED TOO LATE by 86 423 068 ms` and skipped. That is why this function exists rather than letting the scheduler discover
 * it.
 */
export function resolveStartInstant(startText, nowMs) {
  const time = parseTimeOfDay(startText);
  if (!time) return { ok: false, error: 'invalid-time', time: null, atMs: null, rolledToTomorrow: false };

  const today = instantOnDay(nowMs, time);
  if (today > nowMs) {
    return { ok: true, error: null, time, atMs: today, rolledToTomorrow: false };
  }
  /**
   * `+1 day` via `setDate` rather than adding 86 400 000 ms: a day is not a fixed number of milliseconds, and adding a fixed
   * span across a DST boundary lands on the wrong wall-clock time - the same trap the schedule module documents.
   */
  const d = new Date(today);
  d.setDate(d.getDate() + 1);
  d.setHours(time.hour, time.minute, time.second, time.ms);
  return { ok: true, error: null, time, atMs: d.getTime(), rolledToTomorrow: true };
}

/**
 * THE END, WHICH IS OPTIONAL.
 *
 *   empty  -> `{ kind: 'none' }`                      keep clicking until the user presses stop
 *   a time -> `{ kind: 'at', atMs }`                  stop at that instant
 *
 * AN END EARLIER THAN THE START IS AN ERROR, not an adjustment. If the start is at 08:44:45.500 and the end says 08:30:00.000,
 * the user has mistyped something; silently treating it as "tomorrow" would start an eight-hour run nobody asked for. The error
 * names both values so the fix is obvious.
 *
 * An end EQUAL to the start is allowed and means a window that never opens - reported, not rejected, because it is a legitimate
 * way to describe "do nothing" while editing.
 */
export function resolveEndInstant(endText, startAtMs) {
  const raw = endText === null || endText === undefined ? '' : String(endText).trim();
  if (!raw) return { kind: 'none', atMs: null, error: null, time: null };

  const time = parseTimeOfDay(raw);
  if (!time) return { kind: 'none', atMs: null, error: 'invalid-time', time: null };

  /**
   * THE END IS ON THE SAME DAY AS THE START, so it is resolved against the start's day rather than against "now". A window that
   * begins at 23:50 and ends at 00:10 crosses midnight, and that is handled by adding a day when the end time-of-day is earlier
   * than the start's - see below.
   */
  const startDay = new Date(startAtMs);
  const endOnSameDay = new Date(startDay);
  endOnSameDay.setHours(time.hour, time.minute, time.second, time.ms);

  let atMs = endOnSameDay.getTime();
  const startTimeOfDay = startDay.getHours() * 3_600_000 + startDay.getMinutes() * 60_000
    + startDay.getSeconds() * 1_000 + startDay.getMilliseconds();
  const endTimeOfDay = time.hour * 3_600_000 + time.minute * 60_000 + time.second * 1_000 + time.ms;

  /**
   * MIDNIGHT CROSSING, DECIDED BY THE RESULTING SPAN - see `MAX_WINDOW_SPAN_MS` for why the time-of-day cannot decide it.
   *
   * An end time-of-day EARLIER than the start's means either a window running past midnight or a typo. Rolling the end to the next
   * day is right for the first and disastrous for the second, so the span it would produce is what chooses.
   */
  if (endTimeOfDay < startTimeOfDay) {
    endOnSameDay.setDate(endOnSameDay.getDate() + 1);
    endOnSameDay.setHours(time.hour, time.minute, time.second, time.ms);
    const rolled = endOnSameDay.getTime();

    if (rolled - startAtMs > MAX_WINDOW_SPAN_MS) {
      /**
       * TOO LONG TO BE A MIDNIGHT CROSSING. Reported as `end-before-start` with the span, so the message can say what is wrong
       * rather than only that something is. `atMs` stays null: there is no coherent instant to arm a timer for.
       */
      return {
        kind: 'at', atMs: null, time, error: 'end-before-start', wouldHaveCrossedMs: rolled - startAtMs,
      };
    }
    return { kind: 'at', atMs: rolled, time, error: null };
  }

  if (atMs < startAtMs) {
    // unreachable from the arithmetic above, kept so a future change cannot silently reintroduce an end in the past
    return { kind: 'at', atMs: null, time, error: 'end-before-start' };
  }
  return { kind: 'at', atMs, time, error: null };
}

/**
 * THE ID AND NAME THE WINDOW TAB'S RECORD USES.
 *
 * A fixed id, like the Basic tab's `basic`, so the tab edits ONE record rather than accumulating one per save. Exported because
 * the panel, the scheduled-run path and the tests all have to agree on it, and a string literal in three places is how they stop
 * agreeing.
 */
export const WINDOW_ID = 'window';
export const WINDOW_NAME = 'Window';

/**
 * THE AUTOMATION RECORD FOR THE WINDOW TAB.
 *
 * `steps` is the picked points IN ORDER; the runner's window loop already repeats them, so a record with three picks performs
 * three clicks per round - no `loop` step is needed or wanted here, because a `loop` inside a window would nest repetition in a
 * way the tab does not describe.
 *
 * `urls` is carried from the points' own host when the caller knows it, which is what gives a scheduled run a page to open. An
 * empty `urls` makes a scheduled run fall to the active tab - documented behaviour, but not what a window run wants.
 */
export function buildWindowAutomation({ plan, steps, urls = [], name = WINDOW_NAME }) {
  if (!plan?.ok) throw new Error(`cannot build a window automation from an unusable plan: ${plan?.error ?? 'no plan'}`);
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('a window automation needs at least one point');
  return {
    id: WINDOW_ID,
    name,
    enabled: false,                 // armed only by an explicit save, never by opening the tab
    urls,
    schedule: { kind: 'once', at: plan.atMs },
    options: { ...plan.options },   // `window: true` and, when there is one, `untilMs`
    steps,
  };
}

/**
 * THE WHOLE RECORD'S WINDOW, validated together.
 *
 * Returns the `options` fragment the runner reads (`window`, `untilMs`) plus the schedule boundary (`atMs`) and any error. The
 * caller never has to re-derive anything: a validated result is ready to store.
 */
export function buildWindowPlan({ startText, endText, nowMs }) {
  const start = resolveStartInstant(startText, nowMs);
  if (!start.ok) {
    return { ok: false, error: start.error, start, end: null, atMs: null, options: null };
  }
  const end = resolveEndInstant(endText, start.atMs);
  if (end.error === 'invalid-time') {
    return { ok: false, error: 'invalid-end', start, end, atMs: null, options: null };
  }
  if (end.error === 'end-before-start') {
    return { ok: false, error: 'end-before-start', start, end, atMs: null, options: null };
  }

  /**
   * THE OPTIONS THE ENGINE READS. `window: true` is what makes an empty end mean "endless window" rather than "ordinary run" -
   * the runner's `resolveWindowEnd` needs that flag, because an endless window and a plain one-shot run are otherwise identical.
   */
  const options = end.kind === 'at'
    ? { window: true, untilMs: end.atMs }
    : { window: true };

  return { ok: true, error: null, start, end, atMs: start.atMs, options };
}