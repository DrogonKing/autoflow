/**
 * A small, bounded event log for the things that decide whether a click happens.
 *
 * WHY: three attempts at "one of eight did not fire" were resolved by reading code and guessing which path was
 * taken. The paths are invisible from outside - an alarm that never fired, an alarm that fired but whose run was
 * refused, and a run that started but whose step failed all look identical in the run history, and one of them
 * leaves no run record at all. A short ordered log of the decisions removes the guessing.
 *
 * It is deliberately tiny and bounded: this is a diagnostic, not telemetry. Nothing leaves the machine unless the
 * user exports it, there is no network code here, and the oldest entries are dropped so a long-running extension
 * cannot grow its storage without limit.
 *
 * Kept pure (no storage, no chrome API) so the trimming rules can be tested without a browser.
 */

/** How many events to keep. Enough for a burst of automations plus their completions, small enough to export. */
export const MAX_EVENTS = 400;

/**
 * Add an event, returning the new list. Oldest are dropped first.
 *
 * @param {Array} events  existing events, oldest first
 * @param {{kind: string, at?: number, [key: string]: any}} event
 */
export function pushEvent(events, event) {
  const list = Array.isArray(events) ? events.slice() : [];
  const entry = { at: event.at ?? Date.now(), ...event };
  list.push(entry);
  if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
  return list;
}

/** Drop the noisy-but-uninteresting repeats, so one misbehaving path cannot push out the evidence. */
export function summarise(events) {
  const list = Array.isArray(events) ? events : [];
  const byKind = {};
  for (const e of list) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  return {
    count: list.length,
    firstAt: list[0]?.at ?? null,
    lastAt: list[list.length - 1]?.at ?? null,
    byKind,
  };
}

/**
 * The events worth putting at the top of an export: everything that touched a start decision, in order.
 *
 * A whole log is useful; this is what a person reads first.
 */
export function decisionTrail(events) {
  /**
   * EVERY kind that touches a start decision. This list was missing `armed`, `fired-late` and `fired-too-late`, all
   * of which were being RECORDED and then dropped before the section a person reads - so the export showed the alarm
   * firing with no line saying when it had been armed for, which is exactly the line that would have exposed a
   * whole-day jump. A writer and a reader with different lists is the same failure as two code paths disagreeing.
   */
  const KINDS = new Set([
    'alarm-armed', 'armed', 'alarm-fired', 'alarm-late', 'fired-late', 'fired-too-late',
    're-armed', 'arm-skipped', 'arm-failed', 'storm-refused',
    'save-request', 'save-armed-nothing',
    'start-request', 'start-refused', 'start-queued',
    'start-accepted', 'run-finished', 'run-abandoned', 'worker-boot',
  ]);
  return (Array.isArray(events) ? events : []).filter((e) => KINDS.has(e.kind));
}