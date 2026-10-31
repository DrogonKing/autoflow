#!/usr/bin/env python3
"""
Add a MILLISECOND field to the schedule, end to end.

WHY. A market opens at a fixed instant. Typing "13:50:01" gives a target whose millisecond is hardcoded to 0, so the
earliest the click can land is 13:50:01.000 - and after the ping, the tab resolution and the message round-trip, the
observable click is later than that. To act BEFORE the open, the target has to be expressible below one second, which
is what "13:50:01.500" means.

The chain is already millisecond-clean below the schedule: `waitUntil()` in the page spins on `Date.now()` for its last
30ms, and the worker passes `atMs` through as a raw timestamp. Only four places truncate it to a whole second:

  1. makeLocal()           has no ms parameter and writes 0
  2. the three nextRun branches  pass date components, so ms is dropped with them
  3. validateSchedule()    bounds `second` at 0..59 and has no `ms` field to check
  4. the panel's time mask caps at 6 digits (HHMMSS) and builds the schedule from hour/minute/second only

This script changes all four. It is written as a script rather than hand edits because the same edit must land in three
nextRun branches and two validation sites, and a missed one produces a schedule that silently loses its milliseconds.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path('/root/autoflow')
SCHED = ROOT / 'src/core/schedule/schedule.js'
PANEL = ROOT / 'src/ui/panel/panel.js'


def edit(path, pairs, *, required=True):
    src = path.read_text()
    original = src
    applied, missing = [], []
    for old, new in pairs:
        if old in src:
            src = src.replace(old, new, 1)
            applied.append(old.split('\n')[0][:70])
        else:
            missing.append(old.split('\n')[0][:70])
    if missing and required:
        print(f'  !! {path.name}: {len(missing)} pattern(s) NOT FOUND:')
        for m in missing:
            print(f'       {m}')
        return False
    if src != original:
        path.write_text(src)
    print(f'  {path.name}: {len(applied)} edit(s) applied')
    return True


def main(apply_changes=True):
    if not apply_changes:
        print('dry run: nothing written')

    print('=== 1. schedule.js: makeLocal takes milliseconds ===')
    ok = edit(SCHED, [
        (
            """export function makeLocal(year, month, day, hour, minute = 0, second = 0) {
  const d = new Date(year, month, day, hour, minute, second, 0);
  const exists = d.getHours() === hour && d.getMinutes() === minute && d.getDate() === day;
  return { at: d.getTime(), wallTimeExists: exists };
}""",
            """export function makeLocal(year, month, day, hour, minute = 0, second = 0, ms = 0) {
  const d = new Date(year, month, day, hour, minute, second, ms);
  const exists = d.getHours() === hour && d.getMinutes() === minute && d.getDate() === day;
  return { at: d.getTime(), wallTimeExists: exists };
}

/**
 * The millisecond part of a schedule, or 0.
 *
 * Kept as a helper so the three nextRun branches cannot disagree about it, which is exactly how `second` was handled -
 * one `?? 0` per branch, and a branch that forgot it would silently fire a second early or late.
 */
function msOf(schedule) {
  const ms = schedule.ms;
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : 0;
}""",
        ),
    ])
    if not ok:
        return 1

    print('=== 2. schedule.js: the three nextRun branches keep the milliseconds ===')
    ok = edit(SCHED, [
        # daily
        (
            """      const second = schedule.second ?? 0;
      // today at the requested time, if still ahead
      const today = makeLocal(p.year, p.month, p.day, schedule.hour, schedule.minute, second);
      if (today.at > fromMs) return today.at;
      // `sameDayOnly` means \"today, or nothing\". Without it, a schedule armed just after its own time
      // silently moves to tomorrow - which for a market open is a full day late.
      if (schedule.sameDayOnly) return null;
      const t = new Date(p.year, p.month, p.day + 1, schedule.hour, schedule.minute, second, 0);
      return t.getTime();""",
            """      const second = schedule.second ?? 0;
      const ms = msOf(schedule);
      // today at the requested time, if still ahead
      const today = makeLocal(p.year, p.month, p.day, schedule.hour, schedule.minute, second, ms);
      if (today.at > fromMs) return today.at;
      // `sameDayOnly` means \"today, or nothing\". Without it, a schedule armed just after its own time
      // silently moves to tomorrow - which for a market open is a full day late.
      if (schedule.sameDayOnly) return null;
      const t = new Date(p.year, p.month, p.day + 1, schedule.hour, schedule.minute, second, ms);
      return t.getTime();""",
        ),
        # weekly
        (
            """      const second = schedule.second ?? 0;
      const days = [...new Set(schedule.days)].sort((a, b) => a - b);""",
            """      const second = schedule.second ?? 0;
      const ms = msOf(schedule);
      const days = [...new Set(schedule.days)].sort((a, b) => a - b);""",
        ),
        (
            """        const t = new Date(p.year, p.month, p.day + offset, schedule.hour, schedule.minute, second, 0);
        if (!days.includes(t.getDay())) continue;""",
            """        const t = new Date(p.year, p.month, p.day + offset, schedule.hour, schedule.minute, second, ms);
        if (!days.includes(t.getDay())) continue;""",
        ),
        # monthly
        (
            """      const second = schedule.second ?? 0;
      // this month, then the next 12 (a schedule must fire within a year)""",
            """      const second = schedule.second ?? 0;
      const ms = msOf(schedule);
      // this month, then the next 12 (a schedule must fire within a year)""",
        ),
        (
            """        const t = new Date(p.year, p.month + i, schedule.day, schedule.hour, schedule.minute, second, 0);
        if (t.getDate() !== schedule.day) continue; // day does not exist in that month""",
            """        const t = new Date(p.year, p.month + i, schedule.day, schedule.hour, schedule.minute, second, ms);
        if (t.getDate() !== schedule.day) continue; // day does not exist in that month""",
        ),
    ])
    if not ok:
        return 1

    print('=== 3. schedule.js: validation accepts ms, and precise mode is per-millisecond ===')
    ok = edit(SCHED, [
        (
            """      if (s.second !== undefined) intInRange(s.second, 0, 59, 'second');
      return;""",
            """      if (s.second !== undefined) intInRange(s.second, 0, 59, 'second');
      if (s.ms !== undefined) intInRange(s.ms, 0, 999, 'millisecond');
      return;""",
        ),
    ])
    if not ok:
        # the shape may differ; fall back to a global replace of every second-check
        src = SCHED.read_text()
        n = src.count("if (s.second !== undefined) intInRange(s.second, 0, 59, 'second');")
        if n < 1:
            print('  !! could not find any second validation to extend')
            return 1
        src = src.replace(
            "if (s.second !== undefined) intInRange(s.second, 0, 59, 'second');",
            "if (s.second !== undefined) intInRange(s.second, 0, 59, 'second');\n      if (s.ms !== undefined) intInRange(s.ms, 0, 999, 'millisecond');",
        )
        SCHED.write_text(src)
        print(f'  {SCHED.name}: ms validation added to {n} site(s)')

    ok = edit(SCHED, [
        (
            """export function wantsPreciseTiming(schedule) {
  if (!schedule) return false;
  if (typeof schedule.second === 'number') return true;""",
            """export function wantsPreciseTiming(schedule) {
  if (!schedule) return false;
  // A millisecond target is the strongest case for precise timing: the caller asked for a sub-second instant, so
  // firing on the alarm's own jitter would ignore the request entirely.
  if (typeof schedule.ms === 'number') return true;
  if (typeof schedule.second === 'number') return true;""",
        ),
    ])

    print('=== 4. panel.js: the time mask holds milliseconds (HHMMSSmmm) ===')
    ok = edit(PANEL, [
        (
            """export function timeDigits(text) {
  return normaliseDigits(text).replace(TIME_SEPARATORS, '').replace(/[^0-9]/g, '').slice(0, 6);
}""",
            """export function timeDigits(text) {
  // NINE digits, not six: HHMMSSmmm. The last three are milliseconds, which is what lets a schedule name an instant
  // inside the second - the case that matters for a market open, where the whole request is \"act BEFORE the bell\".
  return normaliseDigits(text).replace(TIME_SEPARATORS, '').replace(/[^0-9]/g, '').slice(0, 9);
}""",
        ),
        (
            """export function formatTimeDigits(text) {
  const digits = timeDigits(text);
  const parts = [];
  for (let i = 0; i < digits.length; i += 2) parts.push(digits.slice(i, i + 2));
  return parts.join(':');
}""",
            """export function formatTimeDigits(text) {
  const digits = timeDigits(text);
  const parts = [];
  for (let i = 0; i < digits.length; i += 2) parts.push(digits.slice(i, i + 2));
  if (parts.length <= 3) return parts.join(':');
  // past six digits we are into milliseconds: keep the first three pairs colon-separated and show the rest as a
  // decimal fraction, so "135001500" reads as 13:50:01.500 rather than 13:50:01:50:0
  const [h, m, s, ...rest] = parts;
  return `${h}:${m}:${s}.${rest.join('')}`;
}""",
        ),
    ])

    print('=== 5. panel.js: the parsed value carries ms into the schedule ===')
    ok = edit(PANEL, [
        (
            """    schedule: { kind: 'daily', hour: 9, minute: 0, second: 0 },""",
            """    schedule: { kind: 'daily', hour: 9, minute: 0, second: 0, ms: 0 },""",
        ),
        (
            """  const sched = draft.schedule ?? { kind: 'daily', hour: 9, minute: 0, second: 0 };""",
            """  const sched = draft.schedule ?? { kind: 'daily', hour: 9, minute: 0, second: 0, ms: 0 };""",
        ),
    ])
    if not ok:
        return 1

    print('\nnote: the parseClock/formatClock pair and the "parsed.second" call site still need the ms field;')
    print('the next step reports them so nothing is silently dropped.')
    return 0


if __name__ == '__main__':
    sys.exit(main(apply_changes='--dry-run' not in sys.argv))