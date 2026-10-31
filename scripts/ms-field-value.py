import pathlib
import sys

p = pathlib.Path('/root/autoflow/src/ui/panel/panel.js')
s = p.read_text()
before = s

# ---------------------------------------------------------------------------------------------
# 1. the field's INITIAL value must include the fraction when the schedule has one.
#    Building it from hour/minute/second alone renders "13:50:01" for a schedule that fires at
#    13:50:01.500 - the user cannot see the value they set, which is how a lead goes missing.
# ---------------------------------------------------------------------------------------------
old_value = """      value: `${String(sched.hour ?? 9).padStart(2, '0')}:${String(sched.minute ?? 0).padStart(2, '0')}:${String(sched.second ?? 0).padStart(2, '0')}`,"""
new_value = """      value: timeFieldValue(sched),"""
assert old_value in s, 'the value expression was not found'
s = s.replace(old_value, new_value, 1)

# ---------------------------------------------------------------------------------------------
# 2. the helper itself, next to formatTimeDigits so the two cannot disagree about the layout.
# ---------------------------------------------------------------------------------------------
anchor = """export function parseTypedTime(text) {"""
helper = """/**
 * The text a time field should show for a schedule.
 *
 * Exists as a function because there are two callers and they must agree: the Basic form and the automation editor. The
 * thing they have to agree about is the FRACTION - a schedule at 13:50:01.500 rendered as "13:50:01" hides the very
 * number the user came here to set, and a hidden value is one that gets silently dropped on the next edit.
 *
 * The fraction is only shown when it is non-zero, so the ordinary case stays as short as it was: "09:00:00" rather than
 * "09:00:00.000".
 */
export function timeFieldValue(sched) {
  const h = String(sched?.hour ?? 9).padStart(2, '0');
  const m = String(sched?.minute ?? 0).padStart(2, '0');
  const sec = String(sched?.second ?? 0).padStart(2, '0');
  const ms = Number(sched?.ms ?? 0);
  if (!ms) return `${h}:${m}:${sec}`;
  return `${h}:${m}:${sec}.${String(ms).padStart(3, '0')}`;
}

export function parseTypedTime(text) {"""
assert anchor in s, 'parseTypedTime anchor not found'
s = s.replace(anchor, helper, 1)

p.write_text(s)
print('panel.js: field value + timeFieldValue added')
print('changed:', s != before)
