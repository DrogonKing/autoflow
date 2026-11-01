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
  if (state.basicEvents && !state.basicEventsStale && state.basicEvents.some((e) => e.id === savedId)) {
    return state.basicEvents;
  }
  // the records this form owns, in id order, so a saved multi-event setup comes back as the rows it was
  const owned = (state.automations ?? [])
    .filter((a) => a.id === savedId || new RegExp(`^${savedId}-t\\d+$`).test(a.id))
    .sort((a, b) => {
      const rank = (x) => (x.id === savedId ? 0 : Number(x.id.slice(`${savedId}-t`.length)));
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
export function eventsToStore(state, events, { baseId = 'basic' } = {}) {
  const saved = (state.automations ?? []).find((a) => a.id === baseId) ?? {};
  const template = {
    name: saved.name ?? 'Basic',
    options: saved.options,
    urls: saved.urls,
    // every id this form owns, which is what makes the removal set computable
    knownIds: (state.automations ?? [])
      .map((a) => a.id)
      .filter((id) => id === baseId || new RegExp(`^${baseId}-t\\d+$`).test(id)),
  };
  return merge(baseId, events, { template });
}

export { describeEvent, filledPoints, emptyPoint, orderByNextRun };
