/**
 * ============================================================================================================
 * SEVERAL TIMED EVENTS IN THE BASIC TAB — the view.
 * ============================================================================================================
 *
 * WHAT THE ROW IS. One time, and the points that belong to it. The three example events from the request:
 *
 *     #1 10:32:33.250   چهار pick
 *     #2 10:32:40       سه pick
 *     #3 10:35:00       پنج pick
 *
 * Each row is ONE automation behind the scenes (see core/model/events.js for why), so each has its own alarm and
 * fires independently. The rows are ordered by WHEN THEY NEXT FIRE rather than by the clock face, so 23:50 comes
 * before 00:10 and the list reads in the order things will actually happen.
 *
 * TWO THINGS THIS VIEW MUST NOT DO, both learned from the single-time form it replaces:
 *
 *   1. DO NOT REBUILD ON EVERY RENDER. `timeField` commits on every keystroke and never re-renders, because
 *      rebuilding the view under the typist is what made that control unusable. So the event list lives in
 *      `state.basicEvents` and a keystroke mutates it in place - it is not rebuilt from storage mid-typing.
 *
 *   2. DO NOT LOSE AN UNSAVED ROW. Picking an element triggers a re-render, so the in-memory list is what survives
 *      it. A row built fresh from storage would drop whatever had been typed but not saved, which is the exact fault
 *      reported as "the time resets to 09 when I press Pick".
 */
import { merge, split, makeEvent, emptyPoint, filledPoints, describeEvent, orderByNextRun } from '../../core/model/events.js';

/**
 * The events currently being edited.
 *
 * `state.basicEvents` is the working copy. When it is absent or stale, the list is rebuilt from storage - the same
 * rule the single-time form used, and for the same reason: storage is the truth, except while the user is working.
 */
export function ensureEvents(state, savedBasic, { nextRun } = {}) {
  const savedId = savedBasic?.id ?? 'basic';
  /**
   * A WORKING COPY IS KEPT WHETHER OR NOT IT STILL CONTAINS THE BASE ID.
   *
   * The condition here was `state.basicEvents.some((e) => e.id === savedId)` - "keep the copy only if it still holds a row
   * whose id is the stored record's". MEASURED (`probe-delete-trace`): the user deleted the 09:00 time, which IS the base
   * record, and the surviving row carried `basic-new1`. No row had the base id, so the copy was discarded, the rows were
   * rebuilt from storage, and the time the user had just deleted came back - the delete looked like it did nothing.
   *
   * The question worth asking is not "does the base id still exist" but "is the user working on this form". An unsaved or
   * newly-changed list is the user's work; only a deliberate invalidation (`basicEventsStale`) or an empty copy means
   * storage should win.
   */
  if (state.basicEvents && !state.basicEventsStale && state.basicEvents.length > 0) {
    return state.basicEvents;
  }
  // the records this form owns, in id order, so a saved multi-event setup comes back as the rows it was
  const owned = (state.automations ?? [])
    .filter((a) => a.id === savedId || new RegExp(`^${savedId}-(t|new)\\d+$`).test(a.id))
    .sort((a, b) => {
      // base first, then by the numeric tail of `-t<n>` or `-new<n>`
      const rank = (x) => (x.id === savedId ? 0 : Number((x.id.match(/-(?:t|new)(\d+)$/) ?? [0, 0])[1]));
      return rank(a) - rank(b);
    });

  if (owned.length > 1) {
    state.basicEvents = owned.map((a) => ({
      id: a.id,
      name: a.name ?? '',
      schedule: {
        kind: 'daily',
        hour: a.schedule?.hour ?? 9,
        minute: a.schedule?.minute ?? 0,
        second: a.schedule?.second ?? 0,
        ...(a.schedule?.ms ? { ms: a.schedule.ms } : {}),
      },
      urls: a.urls,
      steps: (a.steps ?? []).map((s, i) => ({ ...s, id: s.id ?? `${a.id}-point-${i + 1}` })),
    }));
  } else {
    state.basicEvents = split(owned[0] ?? savedBasic);
  }
  state.basicEventsStale = false;
  return state.basicEvents;
}

/** The id a new row gets. Derived and unique, never random: an id that changed per render would orphan alarms. */
export function nextEventId(events, baseId) {
  const used = new Set(events.map((e) => e.id));
  let n = 1;
  while (used.has(`${baseId}-new${n}`)) n += 1;
  return `${baseId}-new${n}`;
}

/**
 * Add an empty row, and give it a time that is NOT a copy of the last one.
 *
 * A copy would be a silent duplicate: two automations firing at the same instant with different points, which is
 * almost never what someone adding a row means. A minute later is a starting point they can change, and it is
 * visibly different so the mistake is hard to miss.
 */
export function addEvent(events, baseId, { after } = {}) {
  const last = after ?? events[events.length - 1];
  const s = last?.schedule ?? { hour: 9, minute: 0, second: 0, ms: 0 };
  const totalMinutes = (s.hour ?? 9) * 60 + (s.minute ?? 0) + 1;
  const schedule = {
    kind: 'daily',
    hour: Math.floor(totalMinutes / 60) % 24,
    minute: totalMinutes % 60,
    second: 0,
    ms: 0,
  };
  const ev = makeEvent(nextEventId(events, baseId), schedule);
  return { events: [...events, ev], added: ev };
}

/**
 * Remove one row. The last row cannot be removed: an empty form is not a state this view can express, and removing it
 * would leave Save with nothing to save and no way back.
 */
export function removeEvent(events, id) {
  if (events.length <= 1) return { events, removed: false };
  return { events: events.filter((e) => e.id !== id), removed: true };
}

/**
 * What to store and what to delete, from the rows as they stand.
 *
 * `knownIds` is what storage currently holds for this form, so a row the user deleted is removed rather than left
 * behind firing on its own.
 */
export function eventsToStore(state, events, { baseId = 'basic', storedIds = null } = {}) {
  const saved = (state.automations ?? []).find((a) => a.id === baseId) ?? {};
  const template = {
    name: saved.name ?? 'Basic',
    options: saved.options,
    urls: saved.urls,
    /**
     * Every id this form owns, which is what makes the removal set computable.
     *
     * The pattern accepts `-new<n>` as well as `-t<n>`: `nextEventId()` mints `-new1` for a time the user added, so a
     * newly added time that was then removed did not appear in this list and its record could never be deleted. The
     * pattern is anchored and base-id-scoped, so an automation from the full editor is never claimed.
     */
    /**
     * `storedIds` lets the caller pass what STORAGE actually holds, which is what a deletion needs: the panel's mirror is
     * refreshed by a save, and a deletion is precisely the case that cannot wait for one. Without it, deleting the middle
     * time left its record (and its alarm) behind - measured twice, the form on one time and storage on two.
     */
    knownIds: (storedIds ?? (state.automations ?? []).map((a) => a.id))
      .filter((id) => id === baseId || new RegExp(`^${baseId}-(t|new)\\d+$`).test(id)),
  };
  return merge(baseId, events, { template });
}

export { describeEvent, filledPoints, emptyPoint, orderByNextRun };
