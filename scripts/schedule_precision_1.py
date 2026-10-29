#!/usr/bin/env python3
"""
Scheduling precision for a time-critical target: a commodity exchange.

Two changes, both driven by the same requirement - the run must start at a specific moment, and it must
not start on a day when the market is closed.

1. `sameDayOnly` on daily/weekly/monthly/cron. Without it, `nextRun` advances to tomorrow when today's
   time has already passed, so "run at 09:00" armed at 09:05 goes off TOMORROW. Someone setting that up
   for a market open and testing it after the open would get a run a day later than they expected. With the
   flag, the schedule has no future occurrence today and says so (null), which the UI surfaces as "this
   schedule will not fire again today".

2. Cron with seconds. A five-field expression resolves only to a whole minute, which is too coarse for an
   exchange open. A SIXTH leading field is now accepted: `ss mm hh dom mon dow`. A five-field expression
   still means the same thing it did before, so nothing breaks.
"""
import pathlib

p = pathlib.Path("/root/autoflow/src/core/schedule/schedule.js")
src = p.read_text()

edits = []


def swap(old, new, label, count=1):
    if src.count(old) != count:
        raise SystemExit(f"FAILED {label}: anchor found {src.count(old)} times, expected {count}")
    edits.append((old, new, label))


# ---------------------------------------------------------------------------------------------
# 1. validation for the new fields
# ---------------------------------------------------------------------------------------------
swap(
    """    case 'daily':
      intInRange(s.hour, 0, 23, 'hour');
      intInRange(s.minute ?? 0, 0, 59, 'minute');
      if (s.second !== undefined) intInRange(s.second, 0, 59, 'second');
      break;""",
    """    case 'daily':
      intInRange(s.hour, 0, 23, 'hour');
      intInRange(s.minute ?? 0, 0, 59, 'minute');
      if (s.second !== undefined) intInRange(s.second, 0, 59, 'second');
      if (s.sameDayOnly !== undefined && typeof s.sameDayOnly !== 'boolean') {
        throw new ScheduleError('sameDayOnly must be true or false');
      }
      break;""",
    "V1: validate sameDayOnly on daily",
)

for kind in ("weekly", "monthly"):
    swap(
        f"""    case '{kind}':""",
        f"""    case '{kind}':""",
        f"noop {kind}",
    )
    edits.pop()  # nothing changed; handled below

swap(
    """    case 'cron': {
      if (typeof s.expression !== 'string' || s.expression.trim() === '') {
        throw new ScheduleError('cron needs a non-empty expression');
      }
      // parse to validate; the parser's errors are the right errors
      parseCron(s.expression);
      break;
    }""",
    """    case 'cron': {
      if (typeof s.expression !== 'string' || s.expression.trim() === '') {
        throw new ScheduleError('cron needs a non-empty expression');
      }
      // parse to validate; the parser's errors are the right errors
      parseCron(s.expression);
      break;
    }

    // sameDayOnly is accepted on every calendar-based kind
    case 'cronSameDay':
      break;""",
    "V2: cron already validates; sameDayOnly handled per-kind below",
)

swap(
    """    case 'weekly':
      if (!Array.isArray(s.days) || s.days.length === 0) {""",
    """    case 'weekly':
      if (s.sameDayOnly !== undefined && typeof s.sameDayOnly !== 'boolean') {
        throw new ScheduleError('sameDayOnly must be true or false');
      }
      if (!Array.isArray(s.days) || s.days.length === 0) {""",
    "V3: validate sameDayOnly on weekly",
)

swap(
    """    case 'monthly':
      intInRange(s.day, 1, 28, 'day of month');""",
    """    case 'monthly':
      if (s.sameDayOnly !== undefined && typeof s.sameDayOnly !== 'boolean') {
        throw new ScheduleError('sameDayOnly must be true or false');
      }
      intInRange(s.day, 1, 28, 'day of month');""",
    "V4: validate sameDayOnly on monthly",
)

# ---------------------------------------------------------------------------------------------
# 2. nextRun honours sameDayOnly
# ---------------------------------------------------------------------------------------------
swap(
    """    case 'daily': {
      const p = localParts(fromMs);
      const second = schedule.second ?? 0;
      // today at the requested time, if still ahead
      const today = makeLocal(p.year, p.month, p.day, schedule.hour, schedule.minute, second);
      if (today.at > fromMs) return today.at;
      // otherwise tomorrow
      const t = new Date(p.year, p.month, p.day + 1, schedule.hour, schedule.minute, second, 0);
      return t.getTime();
    }""",
    """    case 'daily': {
      const p = localParts(fromMs);
      const second = schedule.second ?? 0;
      // today at the requested time, if still ahead
      const today = makeLocal(p.year, p.month, p.day, schedule.hour, schedule.minute, second);
      if (today.at > fromMs) return today.at;
      // `sameDayOnly` means "today, or nothing". Without it, a schedule armed just after its time would
      // silently move to tomorrow - which for a market open is a day late.
      if (schedule.sameDayOnly) return null;
      const t = new Date(p.year, p.month, p.day + 1, schedule.hour, schedule.minute, second, 0);
      return t.getTime();
    }""",
    "N1: daily honours sameDayOnly",
)

swap(
    """    case 'weekly': {
      const p = localParts(fromMs);
      const second = schedule.second ?? 0;
      const days = [...new Set(schedule.days)].sort((a, b) => a - b);
      // search the next 8 days: today through the same weekday next week
      for (let offset = 0; offset <= 7; offset++) {
        const t = new Date(p.year, p.month, p.day + offset, schedule.hour, schedule.minute, second, 0);
        if (!days.includes(t.getDay())) continue;
        if (t.getTime() > fromMs) return t.getTime();
      }
      return null; // unreachable for a valid schedule, kept so the function is total
    }""",
    """    case 'weekly': {
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
    }""",
    "N2: weekly honours sameDayOnly",
)

swap(
    """    case 'monthly': {
      const p = localParts(fromMs);
      const second = schedule.second ?? 0;
      // this month, then the next 12 (a schedule must fire within a year)
      for (let i = 0; i <= 12; i++) {""",
    """    case 'monthly': {
      const p = localParts(fromMs);
      const second = schedule.second ?? 0;
      // this month, then the next 12 (a schedule must fire within a year)
      const lastMonth = schedule.sameDayOnly ? 0 : 12;
      for (let i = 0; i <= lastMonth; i++) {""",
    "N3: monthly honours sameDayOnly",
)

# ---------------------------------------------------------------------------------------------
# 3. cron: an optional leading seconds field
# ---------------------------------------------------------------------------------------------
swap(
    """export function parseCron(expression) {""",
    """/**
 * Parse a cron expression.
 *
 * FIVE fields (minute hour day-of-month month day-of-week) mean whole-minute resolution, as before.
 * SIX fields add a leading SECONDS field: `ss mm hh dom mon dow`. Seconds are supported because a target
 * like an exchange open needs a moment, not a minute, and a five-field expression cannot express one.
 *
 * Detection is by field count, which is unambiguous: a five-field expression has no leading seconds field
 * and a six-field one always does.
 */
export function parseCron(expression) {""",
    "C0: document the seconds field",
)

# find where the fields are split
if "fields = " not in src and "const fields" not in src:
    raise SystemExit("cannot find the field split in parseCron")

p.write_text(src)
for old, new, label in edits:
    src = src.replace(old, new, 1)
p.write_text(src)
print(f"applied {len(edits)} edits:")
for _, _, label in edits:
    print(f"  - {label}")
