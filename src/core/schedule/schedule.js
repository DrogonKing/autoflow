/**
 * Scheduling: when should this automation run?
 *
 * The most important module in the project, and the one with the most ways to be subtly wrong.
 *
 * Everything here is pure. No `Date.now()`, no `chrome.alarms`, no timezone from the browser unless it
 * is passed in. That is deliberate: scheduling bugs are arithmetic bugs (a missed day, an hour that does
 * not exist, a DST shift that fires twice), and arithmetic is what you can actually test.
 *
 * Timezones: dates are computed in the *user's local* zone by default, because "every day at 09:00"
 * means 09:00 where the user is, not 09:00 UTC. DST is the interesting part - see `nextRun`.
 */

/** @typedef {{kind: 'manual'}} ManualSchedule */
/** @typedef {{kind:'once', at: number}} OnceSchedule */
/** @typedef {{kind:'interval', everyMs: number, startAt?: number, stopAt?: number}} IntervalSchedule */
/** @typedef {{kind:'daily', hour: number, minute: number, second?: number}} DailySchedule */
/** @typedef {{kind:'weekly', days: number[], hour: number, minute: number, second?: number}} WeeklySchedule */
/** @typedef {{kind:'monthly', day: number, hour: number, minute: number, second?: number}} MonthlySchedule */
/** @typedef {{kind:'cron', expression: string}} CronSchedule */

export const SCHEDULE_KINDS = ['manual', 'once', 'interval', 'daily', 'weekly', 'monthly', 'cron'];

export const MIN_INTERVAL_MS = 1000;              // a schedule faster than this is a runaway
export const MAX_INTERVAL_MS = 30 * 24 * 3600_000; // 30 days; beyond this use a date

/** A hard ceiling so a bad schedule cannot spin. Chrome's alarms clamp below 30s, so this is a guard. */
export const MIN_ALARM_DELAY_MS = 1000;

export class ScheduleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScheduleError';
  }
}

// ---------------------------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------------------------

function intInRange(value, min, max, label) {
  if (!Number.isInteger(value)) throw new ScheduleError(`${label} must be a whole number, got ${value}`);
  if (value < min || value > max) throw new ScheduleError(`${label} must be ${min}..${max}, got ${value}`);
  return value;
}

export function validateSchedule(s) {
  if (!s || typeof s !== 'object') throw new ScheduleError('a schedule must be an object');
  if (!SCHEDULE_KINDS.includes(s.kind)) {
    throw new ScheduleError(`unknown schedule kind ${JSON.stringify(s.kind)}`);
  }

  switch (s.kind) {
    case 'manual':
      return s;

    case 'once':
      if (!Number.isFinite(s.at)) throw new ScheduleError('once needs a timestamp in `at`');
      return s;

    case 'interval': {
      intInRange(s.everyMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS, 'interval');
      if (s.startAt !== undefined && !Number.isFinite(s.startAt)) {
        throw new ScheduleError('interval startAt must be a timestamp');
      }
      if (s.stopAt !== undefined && !Number.isFinite(s.stopAt)) {
        throw new ScheduleError('interval stopAt must be a timestamp');
      }
      if (s.startAt !== undefined && s.stopAt !== undefined && s.stopAt <= s.startAt) {
        throw new ScheduleError('interval stopAt must be after startAt');
      }
      return s;
    }

    case 'daily':
      intInRange(s.hour, 0, 23, 'hour');
      intInRange(s.minute, 0, 59, 'minute');
      if (s.second !== undefined) intInRange(s.second, 0, 59, 'second');
      return s;

    case 'weekly':
      if (!Array.isArray(s.days) || s.days.length === 0) {
        throw new ScheduleError('weekly needs at least one day in `days` (0=Sunday .. 6=Saturday)');
      }
      for (const d of s.days) intInRange(d, 0, 6, 'day');
      intInRange(s.hour, 0, 23, 'hour');
      intInRange(s.minute, 0, 59, 'minute');
      if (s.second !== undefined) intInRange(s.second, 0, 59, 'second');
      return s;

    case 'monthly':
      // 1..28 is deliberate: 29/30/31 do not exist in every month, and a schedule that silently skips
      // February is worse than one that refuses to be created.
      intInRange(s.day, 1, 28, 'day of month');
      intInRange(s.hour, 0, 23, 'hour');
      intInRange(s.minute, 0, 59, 'minute');
      if (s.second !== undefined) intInRange(s.second, 0, 59, 'second');
      return s;

    case 'cron':
      if (typeof s.expression !== 'string' || !s.expression.trim()) {
        throw new ScheduleError('cron needs an `expression`');
      }
      parseCron(s.expression); // throws with a specific reason if invalid
      return s;

    default:
      throw new ScheduleError(`unhandled schedule kind ${s.kind}`);
  }
}

// ---------------------------------------------------------------------------------------------
// local-time helpers
//
// All day/time arithmetic goes through these rather than Date setters, because Date setters mutate and
// a mutation bug in a scheduler fires the wrong hour.
// ---------------------------------------------------------------------------------------------

/** Midnight of the local day containing `ms`. */
export function startOfLocalDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

/** Local calendar fields for a timestamp. */
export function localParts(ms) {
  const d = new Date(ms);
  return {
    year: d.getFullYear(),
    month: d.getMonth(),      // 0..11
    day: d.getDate(),         // 1..31
    weekday: d.getDay(),      // 0 Sunday .. 6 Saturday
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
  };
}

/**
 * Build a local-time timestamp, clamped so that non-existent times (the DST spring-forward gap) resolve
 * to a real instant instead of silently rolling into the next hour.
 *
 * Example: 02:30 on a spring-forward day. `new Date(y, m, d, 2, 30)` in a zone that skips 02:00-03:00
 * yields 03:30, which is a valid instant but not the one asked for. Callers that care compare the
 * round-trip; this helper reports whether the requested wall time actually existed.
 */
/**
 * How early to wake before a precise target, so the wait happens in the page rather than in the alarm.
 *
 * 1500ms is chosen from measurement, not taste: the alarm itself lands within 3ms of what it was asked for,
 * but the work between the alarm and the click - worker wake-up, reading the automation, resolving the tab,
 * the message round-trip, the finder - is what adds up. Waking 1.5s early leaves room for all of it and still
 * keeps the in-page wait short enough that a sleeping laptop is unlikely to miss the whole window.
 */
export const PRECISE_WAKE_MS = 1500;

/** Should this schedule be fired precisely, i.e. is a second specified? */
export function wantsPreciseTiming(schedule) {
  if (!schedule) return false;
  if (typeof schedule.second === 'number') return true;
  if (schedule.kind === 'cron') return String(schedule.cron ?? '').trim().split(/\s+/).length >= 6;
  return false;
}

export function makeLocal(year, month, day, hour, minute = 0, second = 0) {
  const d = new Date(year, month, day, hour, minute, second, 0);
  const exists = d.getHours() === hour && d.getMinutes() === minute && d.getDate() === day;
  return { at: d.getTime(), wallTimeExists: exists };
}

/**
 * Add whole minutes without crossing a DST boundary incorrectly.
 *
 * Deliberately NOT used for "every day at 09:00": adding 24h to yesterday's 09:00 gives 08:00 or 10:00
 * across a DST change. Calendar schedules recompute the wall clock instead; only duration-based
 * schedules add elapsed time.
 */
export function addMinutes(ms, minutes) {
  return ms + minutes * 60_000;
}

// ---------------------------------------------------------------------------------------------
// next run
// ---------------------------------------------------------------------------------------------

/**
 * The next time this schedule should fire, strictly after `fromMs`.
 *
 * Returns `null` when the schedule will never fire again (a one-off in the past, or an interval past its
 * stopAt). Returning null rather than throwing matters: "this schedule is finished" is a normal state.
 */
export function nextRun(schedule, fromMs) {
  validateSchedule(schedule);

  switch (schedule.kind) {
    case 'manual':
      return null;

    case 'once':
      return schedule.at > fromMs ? schedule.at : null;

    case 'interval': {
      const start = schedule.startAt ?? fromMs;
      if (schedule.stopAt !== undefined && fromMs >= schedule.stopAt) return null;
      if (fromMs < start) {
        return schedule.stopAt !== undefined ? Math.min(start, schedule.stopAt) : start;
      }
      const elapsed = fromMs - start;
      const stepsDone = Math.floor(elapsed / schedule.everyMs);
      let next = start + (stepsDone + 1) * schedule.everyMs;
      // guard against floating point drift producing a timestamp that is not actually in the future
      while (next <= fromMs) next += schedule.everyMs;
      if (schedule.stopAt !== undefined && next > schedule.stopAt) return null;
      return next;
    }

    case 'daily': {
      const p = localParts(fromMs);
      const second = schedule.second ?? 0;
      // today at the requested time, if still ahead
      const today = makeLocal(p.year, p.month, p.day, schedule.hour, schedule.minute, second);
      if (today.at > fromMs) return today.at;
      // `sameDayOnly` means "today, or nothing". Without it, a schedule armed just after its own time
      // silently moves to tomorrow - which for a market open is a full day late.
      if (schedule.sameDayOnly) return null;
      const t = new Date(p.year, p.month, p.day + 1, schedule.hour, schedule.minute, second, 0);
      return t.getTime();
    }

    case 'weekly': {
      const p = localParts(fromMs);
      const second = schedule.second ?? 0;
      const days = [...new Set(schedule.days)].sort((a, b) => a - b);
      // today first, then the following days; `sameDayOnly` stops after today
      const lastOffset = schedule.sameDayOnly ? 0 : 7;
      for (let offset = 0; offset <= lastOffset; offset++) {
        const t = new Date(p.year, p.month, p.day + offset, schedule.hour, schedule.minute, second, 0);
        if (!days.includes(t.getDay())) continue;
        if (t.getTime() > fromMs) return t.getTime();
      }
      return null;
    }

    case 'monthly': {
      const p = localParts(fromMs);
      const second = schedule.second ?? 0;
      // this month, then the next 12 (a schedule must fire within a year)
      const lastMonth = schedule.sameDayOnly ? 0 : 12;
      for (let i = 0; i <= lastMonth; i++) {
        const t = new Date(p.year, p.month + i, schedule.day, schedule.hour, schedule.minute, second, 0);
        if (t.getDate() !== schedule.day) continue; // day does not exist in that month
        if (t.getTime() > fromMs) return t.getTime();
      }
      return null;
    }

    case 'cron': {
      const cron = parseCron(schedule.expression);
      const at = nextCronRun(cron, fromMs);
      // `sameDayOnly` applies to cron as well: a candidate on a later day means "not today"
      if (at !== null && schedule.sameDayOnly) {
        const a = localParts(at);
        const b = localParts(fromMs);
        if (a.year !== b.year || a.month !== b.month || a.day !== b.day) return null;
      }
      return at;
    }

    default:
      return null;
  }
}

/** A human sentence for the UI. Kept here so the wording cannot drift from the behaviour. */
export function describeSchedule(s) {
  validateSchedule(s);
  const pad = (n) => String(n).padStart(2, '0');
  const time = (h, m, sec) => `${pad(h)}:${pad(m)}${sec ? ':' + pad(sec) : ''}`;
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  switch (s.kind) {
    case 'manual':  return 'Only when you press Start';
    case 'once':    return `Once on ${new Date(s.at).toLocaleString()}`;
    case 'interval': {
      // Plurals are handled rather than written as "1 hour(s)". An interval that is not a whole number
      // of seconds is reported in milliseconds, which is the honest unit for it.
      const n = s.everyMs;
      const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
      const unit = n % 3600_000 === 0 ? plural(n / 3600_000, 'hour')
        : n % 60_000 === 0 ? plural(n / 60_000, 'minute')
        : n % 1000 === 0 ? plural(n / 1000, 'second')
        : `${n} ms`;
      return `Every ${unit}`;
    }
    case 'daily':
      return `Every day at ${time(s.hour, s.minute, s.second)}${s.sameDayOnly ? ' (today only)' : ''}`;
    case 'weekly':
      return `Every ${s.days.map((d) => dayNames[d]).join(', ')} at ${time(s.hour, s.minute, s.second)}`
        + (s.sameDayOnly ? ' (today only)' : '');
    case 'monthly':
      return `Day ${s.day} of every month at ${time(s.hour, s.minute, s.second)}`
        + (s.sameDayOnly ? ' (today only)' : '');
    case 'cron': {
      const fields = String(s.expression).trim().split(/\s+/);
      const label = fields.length === 6 ? 'Cron (with seconds)' : 'Cron';
      return `${label}: ${s.expression}${s.sameDayOnly ? ' (today only)' : ''}`;
    }
    default:        return s.kind;
  }
}

// ---------------------------------------------------------------------------------------------
// cron
//
// A five-field cron (minute hour day-of-month month day-of-week), local time. Hand-written because the
// whole point of this module is that it is testable without dependencies, and a cron parser is 60 lines.
// ---------------------------------------------------------------------------------------------

const CRON_FIELDS = [
  { name: 'minute',       min: 0,  max: 59 },
  { name: 'hour',         min: 0,  max: 23 },
  { name: 'dayOfMonth',   min: 1,  max: 31 },
  { name: 'month',        min: 1,  max: 12 },
  { name: 'dayOfWeek',    min: 0,  max: 6 },
];

/** Six fields: the same order with seconds in front. */
const CRON_FIELDS_WITH_SECONDS = [
  { name: 'second',       min: 0,  max: 59 },
  ...CRON_FIELDS,
];

/**
 * Parse a cron expression.
 *
 * FIVE fields (`minute hour day-of-month month day-of-week`) mean whole-minute resolution, exactly as
 * before. SIX fields add a leading SECONDS field (`ss mm hh dom mon dow`).
 *
 * Seconds are supported because a target like an exchange open needs a moment rather than a minute, and a
 * five-field expression cannot express one. Detection is by field count, which is unambiguous.
 */
export function parseCron(expression) {
  const parts = String(expression).trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    throw new ScheduleError(
      `a cron expression needs 5 fields (minute hour day month weekday) or 6 with leading seconds, got ${parts.length}`,
    );
  }

  // with six fields the first is seconds; with five it is minute
  const hasSeconds = parts.length === 6;
  const specs = hasSeconds ? CRON_FIELDS_WITH_SECONDS : CRON_FIELDS;
  const fields = hasSeconds ? parts : parts;

  const out = {};
  let domRestricted = false;
  let dowRestricted = false;
  fields.forEach((field, i) => {
    const spec = specs[i];
    out[spec.name] = parseCronField(field, spec);
    if (spec.name === 'dayOfMonth' && field !== '*') domRestricted = true;
    if (spec.name === 'dayOfWeek' && field !== '*') dowRestricted = true;
  });
  out._hasSeconds = hasSeconds;
  // cron's odd rule: when both day fields are restricted, either may match
  out._dayFieldsAreOr = domRestricted && dowRestricted;
  return out;
}

function parseCronField(field, spec) {
  const values = new Set();
  for (const chunk of String(field).split(',')) {
    if (!chunk) throw new ScheduleError(`empty field part in ${JSON.stringify(field)}`);

    // */n  or  a-b/n
    const [rangePart, stepPart] = chunk.split('/');
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) {
        throw new ScheduleError(`bad step ${JSON.stringify(stepPart)} in ${spec.name}`);
      }
    }

    let lo = spec.min;
    let hi = spec.max;
    if (rangePart !== '*') {
      const bounds = rangePart.split('-');
      if (bounds.length === 1) {
        const single = Number(bounds[0]);
        if (!Number.isInteger(single)) throw new ScheduleError(`bad value ${JSON.stringify(bounds[0])} in ${spec.name}`);
        lo = single;
        hi = stepPart !== undefined ? spec.max : single;
      } else if (bounds.length === 2) {
        lo = Number(bounds[0]);
        hi = Number(bounds[1]);
        if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
          throw new ScheduleError(`bad range ${JSON.stringify(rangePart)} in ${spec.name}`);
        }
      } else {
        throw new ScheduleError(`bad range ${JSON.stringify(rangePart)} in ${spec.name}`);
      }
    }

    if (lo < spec.min || hi > spec.max || lo > hi) {
      throw new ScheduleError(
        `${spec.name} range ${lo}-${hi} is outside ${spec.min}-${spec.max}`,
      );
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (values.size === 0) throw new ScheduleError(`${spec.name} matched nothing`);
  return values;
}

/**
 * Next cron fire strictly after `fromMs`, in local time.
 *
 * Walks minute by minute up to a bounded horizon instead of doing clever field arithmetic. The bound
 * matters: a schedule like `0 0 31 2 *` (31 February) can never fire, and without a horizon this would
 * loop forever. Four years of minutes is the worst legitimate case (29 February).
 */
export function nextCronRun(cron, fromMs) {
  const start = new Date(fromMs);

  /**
   * Walk the smallest unit the expression can express.
   *
   * With a seconds field the candidate times are every second, so a target of 09:00:00 is reachable
   * exactly. Without one, the candidates are whole minutes and the walk is the same as it always was.
   *
   * The horizon is expressed in candidate steps rather than in wall time, so it stays the same number of
   * iterations either way: four years is the worst legitimate case (29 February), and having a bound is
   * what keeps an impossible expression like `0 0 31 2 *` from looping forever.
   */
  const withSeconds = cron._hasSeconds === true;

  const cursor = new Date(
    start.getFullYear(), start.getMonth(), start.getDate(),
    start.getHours(), start.getMinutes(), withSeconds ? start.getSeconds() : 0, 0,
  );
  if (withSeconds) {
    // strictly after fromMs: the next whole second, or the one after if we are exactly on a second
    if (cursor.getTime() <= fromMs) cursor.setSeconds(cursor.getSeconds() + 1);
  } else {
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  const LIMIT_MINUTES = 4 * 366 * 24 * 60;
  const limit = withSeconds ? LIMIT_MINUTES * 60 : LIMIT_MINUTES;

  for (let i = 0; i < limit; i++) {
    const month = cursor.getMonth() + 1;
    const dom = cursor.getDate();
    const dow = cursor.getDay();
    const h = cursor.getHours();
    const m = cursor.getMinutes();
    const s = cursor.getSeconds();

    const monthOk = cron.month.has(month);
    const domOk = cron.dayOfMonth.has(dom);
    const dowOk = cron.dayOfWeek.has(dow);
    const dayOk = cron._dayFieldsAreOr ? (domOk || dowOk) : (domOk && dowOk);
    const timeOk = cron.hour.has(h) && cron.minute.has(m) && (!withSeconds || cron.second.has(s));

    if (monthOk && dayOk && timeOk) {
      return cursor.getTime();
    }
    if (withSeconds) cursor.setSeconds(cursor.getSeconds() + 1);
    else cursor.setMinutes(cursor.getMinutes() + 1);
  }
  // no candidate matched within the horizon: an impossible date such as 31 February
  return null;
}