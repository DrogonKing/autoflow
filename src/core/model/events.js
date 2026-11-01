/**
 * SEVERAL TIMED EVENTS, EACH WITH ITS OWN POINTS.
 *
 * THE REQUEST (1.30 beta): "the Basic tab can only have one time with several picks. Can it take several different times,
 * each with its own picks? For example 10:32:33.250 with four picks, 10:32:40.000 with three, 10:35:00.000 with five."
 *
 * WHAT MAKES THIS MORE THAN A UI LIST. A schedule becomes exactly ONE chrome alarm, and one alarm maps to one
 * automation. So three events are not one automation with three times - they are THREE automations, each with one time
 * and its own steps, each armed separately. Everything in this file exists to make that mapping true and reversible.
 *
 * The alternative, a single automation whose steps each carry a time, was rejected on a concrete ground: the run engine,
 * the history, the run lock and the "did it arm?" diagnostics all assume one schedule per automation. Making a step
 * hold a schedule would put a second timing model beside the first, and the two would disagree the first time either
 * changed. Three records cost two extra alarm slots and reuse every existing path.
 *
 * THE TWO OPERATIONS THAT MATTER AND ARE EASY TO GET WRONG:
 *
 *   split()  one existing automation -> a list of events. An automation made before this feature has ONE time and all
 *            the points, so the split is lossless and must stay that way: the first event keeps the original id, so a
 *            run armed for tomorrow still points at a record that still exists.
 *
 *   merge()  the events -> the automations to store. This must be a DIFF, not a rewrite: records are matched by id, so
 *            renaming or retiming an event updates its record, and an unrelated automation in the same list is never
 *            touched. Rebuilding the list from scratch would delete automations the user made in the full editor.
 */

/** A point inside an event: the same shape the Basic form already produces. */
export const emptyPoint = (id) => ({ id, kind: 'click', finder: { strategy: 'css', selector: '' } });

/** A fresh event at a given time. */
export function makeEvent(id, schedule) {
  return { id, schedule, name: '', steps: [emptyPoint(`${id}-point-1`)] };
}

/**
 * How many points an event has, counting only ones that actually name an element.
 *
 * Used for the summary line rather than for validation: an event with an empty point is a half-finished edit, not an
 * error, and refusing to save it would lose the other events' work.
 */
export function filledPoints(event) {
  return (event?.steps ?? []).filter((s) => s?.finder && Object.keys(s.finder).some((k) => k !== 'strategy' && s.finder[k])).length;
}

/** An event needs at least one point that names an element. */
export function eventIsReady(event) {
  return filledPoints(event) > 0;
}

/**
 * ONE AUTOMATION -> A LIST OF EVENTS.
 *
 * A record saved before this feature holds one schedule and every point, so the first event takes both and the rest are
 * empty of points but carry a time, which is the useful starting state: the user asked for three times, and they get
 * three rows with the original time and points on the first.
 *
 * THE FIRST EVENT KEEPS THE ORIGINAL ID. Re-minting it would orphan a pending alarm on the next save, and an automation
 * the user had already scheduled would stop firing with no message.
 */
export function split(automation, { extraTimes = [] } = {}) {
  const base = automation ?? {};
  const id = base.id ?? 'basic';
  const schedule = base.schedule ?? { kind: 'daily', hour: 9, minute: 0, second: 0, ms: 0 };
  const steps = (base.steps ?? []).map((s, i) => ({ ...s, id: s.id ?? `${id}-point-${i + 1}` }));

  const events = [{
    id,
    schedule: {
      kind: 'daily',
      hour: schedule.hour ?? 9,
      minute: schedule.minute ?? 0,
      second: schedule.second ?? 0,
      ...(schedule.ms ? { ms: schedule.ms } : {}),
    },
    name: base.name ?? '',
    // the tabs/url patterns travel with the FIRST event, because a record with none falls back to the remembered Pick
    // page - and moving them to a later event would change where the first one runs
    urls: base.urls,
    steps: steps.length ? steps : [emptyPoint(`${id}-point-1`)],
  }];

  for (const t of extraTimes) {
    events.push(makeEvent(t.id, t.schedule));
  }
  return events;
}

/**
 * A LIST OF EVENTS -> THE AUTOMATIONS TO STORE, plus the ids that are no longer wanted.
 *
 * The caller stores `save` and removes `remove`. Both are explicit: a merge that only returned the list to keep would
 * make deleting the last event impossible, because an empty list and "no change" would look the same.
 *
 * The FIRST event keeps the base id (so an existing armed alarm keeps pointing at a live record). Later events get a
 * STABLE derived id, not a random one: an id that changes between saves would orphan the alarm of every event but the
 * first, which is the same fault that once made picks vanish when step ids were re-minted per render.
 */
export function merge(baseId, events, { template = {} } = {}) {
  const save = [];
  const remove = [];
  const seen = new Set();

  events.forEach((ev, i) => {
    const id = i === 0 ? baseId : `${baseId}-t${i}`;
    seen.add(id);
    save.push({
      // the template carries fields this form does not edit (options, the pick-page memory); spreading it first means
      // a save from Basic cannot silently drop something the full editor set
      ...template,
      id,
      name: ev.name?.trim() ? ev.name.trim() : (i === 0 ? (template.name ?? 'Basic') : `${template.name ?? 'Basic'} ${i + 1}`),
      enabled: true,
      // THE SPREAD ORDER MATTERS, and it is the same trap documented in basicDraft(): putting `kind: 'daily'` first
      // lets a stored cron or manual kind overwrite it, and this form then edits a schedule it cannot render. The
      // event's fields come first and the form's own kind is written last.
      schedule: { ...ev.schedule, kind: 'daily' },
      /**
       * ONLY POINTS THAT ACTUALLY NAME AN ELEMENT ARE STORED.
       *
       * MEASURED (1.30 dev, `save-button-test`): the single-time form filtered these before saving, and this path did
       * not - so a form with NO usable point still produced a record with one empty step, `steps.length` was 1 rather
       * than 0, the "at least one point" refusal never fired, and the button showed "✓ Saved" for a save that would
       * fail at run time. The filter belongs here, in the one place that decides what a record contains, rather than at
       * each call site.
       */
      steps: ev.steps
        .filter((s) => s?.finder && Object.keys(s.finder).some((k) => k !== 'strategy' && s.finder[k]))
        .map((s, k) => ({ ...s, id: s.id ?? `${id}-point-${k + 1}` })),
      ...(ev.urls ? { urls: ev.urls } : {}),
    });
  });

  // ids this form owns: the base and its derived times. Anything else in storage belongs to the full editor.
  const ownPattern = new RegExp(`^${baseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-t\\d+)?$`);
  for (const id of template.knownIds ?? []) {
    if (ownPattern.test(id) && !seen.has(id)) remove.push(id);
  }

  return { save, remove };
}

/**
 * A plain description of when an event fires, for the row's own label.
 *
 * Kept here rather than in the view so the same string is used by the tests: a time shown one way in the list and
 * another in the run history is how a user comes to doubt both.
 */
export function describeEvent(schedule) {
  const h = String(schedule?.hour ?? 0).padStart(2, '0');
  const m = String(schedule?.minute ?? 0).padStart(2, '0');
  const s = String(schedule?.second ?? 0).padStart(2, '0');
  const ms = Number(schedule?.ms ?? 0);
  return ms ? `${h}:${m}:${s}.${String(ms).padStart(3, '0')}` : `${h}:${m}:${s}`;
}

/**
 * The next time each event fires, in the order they will actually happen.
 *
 * NOT sorted by clock time, and that is deliberate: 23:50 comes before 00:10 on the clock but after it in real life, so
 * ordering by the hour would tell the user their events run in an order they do not. Each event's own next occurrence is
 * computed against the same "now", and those instants are what get sorted.
 */
export function orderByNextRun(events, nextRunFn, now = Date.now()) {
  return events
    .map((ev, i) => {
      let at = null;
      try {
        at = nextRunFn({ kind: 'daily', ...ev.schedule }, now);
      } catch {
        at = null; // an unparseable time is not orderable; it sorts last rather than throwing out the whole list
      }
      return { ev, i, at };
    })
    .sort((a, b) => {
      if (a.at === null && b.at === null) return a.i - b.i;
      if (a.at === null) return 1;
      if (b.at === null) return -1;
      return a.at - b.at;
    })
    .map((x) => x.ev);
}
