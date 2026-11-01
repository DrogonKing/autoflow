/**
 * The side panel.
 *
 * Plain DOM rather than a framework: the panel is a few screens, and a framework would add a build step,
 * a bundle size, and a class of bugs (stale closures over async results) for no benefit here. Every
 * render is a full rebuild of a small subtree, which is simpler to reason about than reconciliation.
 *
 * The scheduling editor is the most-developed part, because scheduling is the feature that actually
 * differentiates this from a macro recorder.
 */

import { describeSchedule, nextRun, SCHEDULE_KINDS, ScheduleError, validateSchedule } from '../../core/schedule/schedule.js';
import { STEP_KINDS, STEP_LABELS, BLOCK_KINDS, makeStep, countSteps } from '../../core/model/steps.js';
import { describeCondition } from '../../core/engine/conditions.js';
import { readCsv } from '../../core/io/csv.js';
import { api } from '../../platform/api.js';
import { applyToDocument, translator } from '../../core/i18n/i18n.js';
import { ALL_DEFAULTS, normaliseAll } from '../../core/dom/clickAll.js';
import { describeSkew, shouldWarn } from '../../core/clock/skew.js';
import { ensureEvents, addEvent, removeEvent, eventsToStore, orderByNextRun, describeEvent, filledPoints } from './events-view.js';

/**
 * The visible name of a step kind.
 *
 * Falls back to the model's own English label, so a kind added to the model before the catalogue still reads
 * as "Fill field" rather than as "step.fill". The model remains the source of truth for which kinds exist;
 * the catalogue only decides what they are called.
 */
const kindLabel = (kind) => (t.has(`step.${kind}`) ? t(`step.${kind}`) : (STEP_LABELS[kind] ?? kind));

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    // There is deliberately no `html` prop. It existed and was never used, so it was a latent XSS sink:
    // a template value or an extracted page value could have been interpolated into markup inside an
    // extension page, which runs with more privilege than the page itself. Use `text` instead - it
    // cannot carry markup - and build structure with elements.
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    /**
     * THE VALUE IS SET AS A PROPERTY, not only as an attribute.
     *
     * A `<textarea>` has no `value` CONTENT attribute: `setAttribute('value', ...)` writes an attribute the element
     * ignores, so `.value` stayed empty and the code editor opened blank every time - the script step looked empty
     * and the user had no way to tell that the code was there (bug C2). Setting the property as well makes every
     * control start out holding the value it is supposed to show.
     */
    else if (k === 'value') {
      node.value = String(v);
      node.setAttribute('value', String(v));
    }
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

/**
 * Send a message to the service worker.
 *
 * NOT the callback form. `chrome.runtime.sendMessage(msg, cb)` is Chromium's shape; on Firefox the
 * `chrome.*` alias is callback-only in a way that does not reliably invoke that callback, so the panel
 * would report "no response" for every action while working perfectly in Chromium. The platform layer
 * returns a promise and works on both.
 */
const send = (msg) => api.runtime.sendMessage(msg)
  .then((res) => res ?? { ok: false, error: 'no response' })
  .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));

/**
 * The translator, and why it is module scope rather than passed down.
 *
 * Every view calls `t('key')`. Threading it through every function would touch a hundred signatures for one
 * value that is fixed for the lifetime of a render, so it lives here and is rebuilt whenever the render
 * begins. `t` is reassigned (not mutated) so a stale closure cannot hold an old language.
 *
 * It starts as English so a string rendered before settings arrive is readable rather than a raw key.
 */
let t = translator('en');

/**
 * WHICH TABS EXIST.
 *
 * In a lite build only `basic` remains, and the flag is a build-time constant on purpose: writing
 * `__LITE__ ? [...] : [...]` lets esbuild evaluate it, drop the other branch, and then drop the view
 * functions that nothing references any more. A runtime check would keep every line in the bundle.
 *
 * It sits above `state` because the panels it removes are defined further down and the constant has to be
 * visible to the bundler from one place.
 */
const TAB_LIST = __LITE__
  ? [['basic', 'tab.basic']]
  : [['basic', 'tab.basic'], ['automations', 'tab.automations'], ['scheduled', 'tab.scheduled'], ['data', 'tab.data'], ['history', 'tab.history'], ['log', 'tab.log']];

const state = {
  automations: [],
  settings: {},
  runs: [],
  activeRun: null,
  editing: null,          // the automation currently open in the editor
  schedulePreview: null,
  csv: null,              // { columns, rows }
  dataKey: null,
  // 'basic' exists in BOTH builds; 'automations' does not exist in lite, so opening there would render nothing
  tab: __LITE__ ? 'basic' : 'automations',
  pickTarget: null,       // the step id awaiting an element pick
  clockSkew: null,        // { offsetMs, rttMs, trustworthy, warn, applied } - measured, never applied silently
  clockSkewError: null,   // why the measurement could not be taken, shown next to the button that tried
  backupNote: null,       // the result of the last backup or restore, so it is not a silent operation
  basicSavedAt: null,     // when Save last succeeded, so the button can confirm for a moment and then stop
  pickSavedAt: null,      // when a pick last landed, so the Pick button can confirm the same way
  pickSavedFor: null,     // WHICH point it landed for - without this the confirmation shows on every point
  pickCancelled: null,    // when a pick was last cancelled, so the fact is not silent
  timeError: null,        // why the typed time was not accepted, shown where the time is typed
  basicNotice: null,      // what Save did with the schedule: armed for an instant, or not scheduled at all
};

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : '-');

/**
 * "in 3 days" / "2 min ago", in the current language.
 *
 * Pluralisation is handled per language rather than with an `s` suffix. English needs one/other; Persian does
 * not inflect after a number at all, so appending an `s` there would be nonsense. Keeping the rule with the
 * language is why this is not a single template string.
 */
function relTime(ms) {
  if (!ms) return '-';
  const d = ms - Date.now();
  const abs = Math.abs(d);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const fa = t.language === 'fa';
  let unit;
  if (days >= 1) {
    unit = fa ? `${days} روز` : `${days} day${days === 1 ? '' : 's'}`;
  } else if (hours >= 1) {
    unit = fa ? `${hours} ساعت` : `${hours} hour${hours === 1 ? '' : 's'}`;
  } else if (mins >= 1) {
    unit = fa ? `${mins} دقیقه` : `${mins} min`;
  } else {
    unit = fa ? 'کمتر از یک دقیقه' : 'under a minute';
  }
  if (d >= 0) return fa ? `${unit} دیگر` : `in ${unit}`;
  return fa ? `${unit} پیش` : `${unit} ago`;
}

const REASON_LABEL = {
  finished: 'history.ok',
  'stopped-by-user': 'history.stopped',
  'step-error': 'history.failed',
  'run-timeout': 'history.timedOut',
  'step-limit': 'history.stepLimit',
  aborted: 'history.aborted',
};

/**
 * A SCHEDULE DESCRIPTION THAT CANNOT THROW.
 *
 * `describeSchedule` validates the schedule first and throws `ScheduleError` for one the model would refuse. The
 * panel renders a LIST of automations, and one of them carrying a broken schedule used to take the whole list down
 * with it: the exception happened inside a render, so the panel showed nothing at all rather than one bad row
 * (bug M1). The bad schedule now says so and the rest of the list survives.
 */
function scheduleLabel(schedule) {
  try {
    return describeSchedule(schedule);
  } catch (e) {
    return 'invalid schedule';
  }
}

async function refresh() {
  const res = await send({ type: 'list-automations' }).catch(() => null);
  if (res?.ok) state.automations = res.automations;
  const active = await send({ type: 'get-active-run' });
  if (active?.ok) state.activeRun = active.run;
  /**
   * THE RUN HISTORY IS REFRESHED TOO.
   *
   * `state.runs` was only ever filled at boot, so the History tab showed whatever was there when the panel opened -
   * and the Clear button appeared to do nothing, because the list it cleared was the one being re-rendered from a
   * stale copy. Every refresh now asks for the runs as well (bug C6).
   */
  const runs = await send({ type: 'list-runs' }).catch(() => null);
  if (runs?.ok) state.runs = runs.runs;
  render();
}

/**
 * Pick up the language preference and apply it to the document.
 *
 * Called before the first render: `dir` and the font stack have to be set before content is painted, or a
 * Persian panel flickers left-to-right for a frame. Re-decided on every settings change so switching language
 * re-renders in place without a reload.
 */
/**
 * Measure the clock offset and decide, but do not change anything.
 *
 * Cached, because a HEAD request on every render would be both wasteful and visible to the target server. The
 * stored value is used until the user asks for a re-measurement.
 */
async function refreshClockSkew(force = false) {
  const stored = state.settings?.lastClockOffsetMs;
  const threshold = Number(state.settings?.skewWarnThresholdMs ?? 1000);
  if (!force && Number.isFinite(stored)) {
    state.clockSkew = {
      offsetMs: stored, rttMs: null, trustworthy: true, warn: shouldWarn(stored, threshold),
    };
    return state.clockSkew;
  }
  // which server to ask: the automation's own target site, so the comparison is with the clock that matters
  const target = state.editing?.urls?.[0];
  const url = typeof target === 'string' && /^https?:/i.test(target) ? target : null;
  if (!url) {
    /**
     * SAY WHY, instead of doing nothing.
     *
     * The measurement needs an http(s) address because the offset is read from a server's `Date` header, and a
     * `file://` page has no server. That check existed, but it returned silently - so on the test field the user
     * actually works with, the one control meant to catch a clock error did nothing at all and looked broken. It
     * matters: an 8-second clock error was found on this machine by other means.
     */
    state.clockSkew = null;
    state.clockSkewError = t('clock.needsHttp');
    return null;
  }
  state.clockSkewError = null;
  const res = await send({ type: 'measure-clock-offset', url }).catch(() => null);
  if (!res?.ok) { state.clockSkew = null; return null; }
  await send({ type: 'save-settings', patch: { lastClockOffsetMs: res.offsetMs } });
  state.settings = { ...state.settings, lastClockOffsetMs: res.offsetMs };
  state.clockSkew = {
    offsetMs: res.offsetMs, rttMs: res.rttMs, trustworthy: res.trustworthy,
    warn: shouldWarn(res.offsetMs, threshold),
  };
  return state.clockSkew;
}

async function applyLanguage() {
  const res = await send({ type: 'get-settings' }).catch(() => null);
  if (res?.ok) state.settings = res.settings ?? {};
  const preference = state.settings?.language ?? 'system';
  const browserLanguage = globalThis.navigator?.language ?? 'en';
  // resolveLanguage is imported through the translator helper so the rule lives in one place
  const { resolveLanguage } = await import('../../core/i18n/i18n.js');
  const language = resolveLanguage(preference, browserLanguage);
  t = translator(language);
  applyToDocument(document, language);
  state.language = language;
  return language;
}

// ---------------------------------------------------------------------------------------------
// schedule editor
// ---------------------------------------------------------------------------------------------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function scheduleEditor(onChange) {
  const s = state.editing.schedule ?? { kind: 'manual' };
  const wrap = el('div', { class: 'sched' });

  const setKind = (kind) => {
    const next = kind === 'daily' ? { kind, hour: 9, minute: 0 }
      : kind === 'weekly' ? { kind, days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }
      : kind === 'monthly' ? { kind, day: 1, hour: 9, minute: 0 }
      : kind === 'interval' ? { kind, everyMs: 300_000 }
      : kind === 'once' ? { kind, at: Date.now() + 3_600_000 }
      : kind === 'cron' ? { kind, expression: '0 9 * * 1-5' }
      : { kind: 'manual' };
    state.editing.schedule = next;
    onChange();
  };

  const kindRow = el('div', { class: 'row' },
    el('label', { text: t('field.when') }),
    el('select', {
      class: 'grow',
      onchange: (e) => setKind(e.target.value),
    }, ...[
      ['manual', 'Only when I press Start'],
      ['once', 'Once, at a date and time'],
      ['interval', 'Repeatedly, every…'],
      ['daily', 'Every day at a time'],
      ['weekly', 'On chosen weekdays'],
      ['monthly', 'Day of the month'],
      ['cron', 'Cron expression'],
    ].map(([v, label]) => el('option', { value: v, text: label, selected: s.kind === v }))),
  );
  wrap.append(kindRow);

  const number = (value, opts, oninput) => el('input', {
    type: 'number', value: String(value ?? ''), ...opts, onchange: (e) => oninput(e.target.value),
  });

  if (s.kind === 'once') {
    const dt = new Date(s.at ?? Date.now() + 3_600_000);
    const pad = (n) => String(n).padStart(2, '0');
    const local = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    wrap.append(el('div', { class: 'row' },
      el('label', { text: t('field.at') }),
      el('input', {
        type: 'datetime-local', class: 'grow', value: local,
        onchange: (e) => {
          const v = new Date(e.target.value).getTime();
          if (Number.isFinite(v)) {
            state.editing.schedule = { kind: 'once', at: v };
            onChange();
          }
        },
      }),
    ));
  }

  if (s.kind === 'interval') {
    const mss = s.everyMs ?? 300_000;
    const unit = mss % 3_600_000 === 0 ? 'hours' : mss % 60_000 === 0 ? 'minutes' : 'seconds';
    const divisor = { hours: 3_600_000, minutes: 60_000, seconds: 1000 }[unit];
    wrap.append(el('div', { class: 'row' },
      el('label', { text: t('field.every') }),
      number(Math.round(mss / divisor), { min: '1', class: 'small' }, (v) => {
        state.editing.schedule = { ...s, everyMs: Math.max(1000, Number(v) * divisor) };
        onChange();
      }),
      el('select', {
        onchange: (e) => {
          const d = { hours: 3_600_000, minutes: 60_000, seconds: 1000 }[e.target.value];
          state.editing.schedule = { ...s, everyMs: Math.max(1000, Math.round(mss / divisor) * d) };
          onChange();
        },
      }, ...['seconds', 'minutes', 'hours'].map((u) => el('option', { value: u, text: u, selected: u === unit }))),
    ));
    // an interval without a stop is a schedule that runs forever; offer the bound
    wrap.append(el('div', { class: 'row' },
      el('label', { text: t('field.stopAfter') }),
      el('input', {
        type: 'datetime-local', class: 'grow',
        value: s.stopAt ? new Date(s.stopAt - new Date(s.stopAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '',
        onchange: (e) => {
          const v = e.target.value ? new Date(e.target.value).getTime() : undefined;
          state.editing.schedule = { ...s, stopAt: v };
          onChange();
        },
      }),
    ));
  }

  if (s.kind === 'daily' || s.kind === 'weekly' || s.kind === 'monthly') {
    if (s.kind === 'weekly') {
      const row = el('div', { class: 'row wrap' }, el('label', { text: t('field.days') }));
      for (let i = 0; i < 7; i++) {
        const on = (s.days ?? []).includes(i);
        row.append(el('button', {
          class: `day ${on ? 'on' : ''}`,
          text: WEEKDAYS[i].slice(0, 3),
          onclick: (e) => {
            const days = new Set(s.days ?? []);
            if (days.has(i)) days.delete(i); else days.add(i);
            if (days.size === 0) return; // a weekly schedule with no days never fires
            e.currentTarget.classList.toggle('on');
            state.editing.schedule = { ...s, days: [...days].sort((a, b) => a - b) };
            onChange();
          },
        }));
      }
      wrap.append(row);
    }
    if (s.kind === 'monthly') {
      wrap.append(el('div', { class: 'row' },
        el('label', { text: t('field.day') }),
        number(s.day ?? 1, { min: '1', max: '28', class: 'small' }, (v) => {
          state.editing.schedule = { ...s, day: Math.min(28, Math.max(1, Number(v))) };
          onChange();
        }),
        el('span', { class: 'hint', text: t('sched.monthlyDayHint') }),
      ));
    }
    /**
     * THE TIME IS TYPED, NOT ONLY SCROLLED.
     *
     * Reported: "the time numbers cannot be changed by typing, only by scrolling and clicking". The cause was this
     * field calling `onChange()` on every `change` event, and `onChange` re-renders the whole view - so the input
     * element was destroyed and rebuilt while it had focus, and the caret went with it. A `type="time"` control is
     * perfectly typeable; it was being re-created underneath the typist.
     *
     * So the model is updated in place here and re-rendering is DEFERRED to `blur`, when the user has finished. The
     * hint about the seconds is a fixed element whose text is updated rather than a conditional node, because a
     * conditional node would be a reason to re-render.
     */
    /**
     * One element reporting TWO things: why a value was refused, or that seconds are in play.
     *
     * The reason wins when there is one, because a refused time is a problem the user has to fix, and the seconds hint
     * is only informative. Both are written into the same node rather than swapped, since creating a node conditionally
     * would be a reason to re-render - and re-rendering under the typist is what made this control untypeable.
     */
    const timeHint = el('span', { class: 'hint time-hint', text: '' });
    const refreshTimeHint = (hasSecond) => {
      if (state.timeError) {
        timeHint.className = 'hint time-hint warn time-error';
        timeHint.textContent = t(`time.error.${state.timeError}`);
        return;
      }
      timeHint.className = 'hint time-hint';
      timeHint.textContent = hasSecond ? t('sched.secondHint') : '';
    };
    const commitTime = (value, { rerender }) => {
      /**
       * The digits are normalised BEFORE parsing, so a Persian or Arabic keyboard works.
       *
       * A native `<input type="time">` discards non-ASCII digits, so with a Persian keyboard the `input` event fires
       * with a value the browser has already emptied - the user types and nothing changes. Normalising here fixes the
       * full editor; the basic view has its own copy of this logic and is fixed the same way.
       */
      const parsed = parseTypedTime(value);
      state.timeError = parsed.ok ? null : parsed.error;
      if (parsed.ok) {
        const next = { ...(state.editing.schedule ?? s), hour: parsed.hour, minute: parsed.minute };
        if (parsed.precise) next.second = parsed.second;
        else delete next.second;
        /**
         * THE MILLISECONDS ARE DELETED WHEN THERE ARE NONE, for the same reason `second` is: an undefined field and a
         * zero field mean different things to `wantsPreciseTiming`, and leaving a stale `ms: 0` behind would keep a
         * schedule in precise mode after the user removed the fraction - waking the worker 1.5s early for nothing.
         */
        if (parsed.ms > 0) next.ms = parsed.ms;
        else delete next.ms;
        state.editing.schedule = next;
      }
      // refreshed EITHER WAY: a rejection has to be visible next to the field, not only absent from the model
      refreshTimeHint(parsed.ok && (parsed.precise || parsed.ms > 0));
      if (rerender) onChange();
    };

    refreshTimeHint(typeof s.second === 'number' || Number(s.ms) > 0);
    wrap.append(el('div', { class: 'row' },
      el('label', { text: t('field.time') }),
      timeField({
        focusKey: 'editor-time',
        value: `${String(s.hour ?? 9).padStart(2, '0')}:${String(s.minute ?? 0).padStart(2, '0')}`
          + (typeof s.second === 'number' ? `:${String(s.second).padStart(2, '0')}` : ''),
        onCommit: (v, opts) => commitTime(v, opts),
        onHint: refreshTimeHint,
      }),
      timeHint,
    ));

    // ---- the clock warning, shown where the time is chosen
    //
    // A measurement and its consequences, not an automatic correction. The user asked for the offset to be
    // REPORTED and, separately, for an option to apply it - so it is a warning plus a switch, never a silent
    // adjustment. It appears only for a precise schedule, because only then can whole seconds matter.
    // why the measurement could not be taken, when it could not: saying nothing looked like a broken button
    if (state.clockSkewError) {
      wrap.append(el('div', { class: 'hint warn', text: state.clockSkewError }));
    }
    if (typeof s.second === 'number' && state.clockSkew && state.clockSkew.warn) {
      wrap.append(el('div', { class: 'skew-warn' },
        el('strong', { text: t('skew.title') }),
        el('div', { text: describeSkew(state.clockSkew, t.language) }),
        el('div', { class: 'hint', text: t('skew.consequence') }),
        // NO APPLY BUTTON, by decision. An earlier version had one; it was removed because the measurement's
        // uncertainty is about half a second, so applying it would move an order by an amount that could be in
        // the wrong direction. Re-measuring is offered because it is free and the reading can go stale.
        el('div', { class: 'skew-actions' },
          el('button', {
            text: t('skew.recheck'),
            onclick: async () => { await refreshClockSkew(true); render(); },
          }),
          el('button', {
            text: t('skew.syncHint'),
            title: t('skew.syncHintTitle'),
            onclick: () => { refreshClockSkew(true).then(() => render()); },
          })),
      ));
    }
  }

  if (s.kind === 'cron') {
    wrap.append(el('div', { class: 'row' },
      el('label', { text: t('field.expression') }),
      el('input', {
        class: 'grow', value: s.expression ?? '', placeholder: t('sched.cronPlaceholder'),
        onchange: (e) => {
          // the OTHER FIELDS ARE KEPT: replacing the schedule outright dropped `sameDayOnly`, so ticking "today only"
          // and then typing a cron expression silently turned it off again
          state.editing.schedule = { ...s, kind: 'cron', expression: e.target.value };
          onChange();
        },
      }),
    ));
    wrap.append(el('div', { class: 'hint', text: t('sched.cronHelp') }));
    wrap.append(el('div', {
      class: 'hint',
      text: t('sched.cronSecondsHelp')
        + 'e.g.  0 0 9 * * 1-5  = weekdays at 09:00:00',
    }));
  }

  // A calendar schedule normally rolls to the next day when its time has passed. For a deadline that is
  // the wrong behaviour, so it can be constrained to today only.
  if (s.kind === 'cron' || s.kind === 'daily' || s.kind === 'weekly' || s.kind === 'monthly') {
    wrap.append(el('div', { class: 'row' },
      el('input', {
        type: 'checkbox', id: 'same-day', checked: s.sameDayOnly === true,
        onchange: (e) => {
          state.editing.schedule = { ...s, sameDayOnly: e.target.checked };
          onChange();
        },
      }),
      el('label', { for: 'same-day', text: t('field.todayOnly') }),
      el('span', { class: 'hint', text: t('timer.noRollover') }),
    ));
  }

  // the preview: what will actually happen, and when
  try {
    /**
     * THE SNAPSHOT, NOT THE LIVE FIELD.
     *
     * `state.editing.schedule` is `undefined` for an automation that has no schedule yet, and the preview read it
     * directly - so the editor showed "Invalid schedule: ..." for a perfectly ordinary automation. The snapshot `s`
     * is the schedule this editor was built for, and it is always defined.
     */
    validateSchedule(s);
    const label = describeSchedule(s);
    const upcoming = [];
    let cursor = Date.now();
    if (s.kind !== 'manual') {
      for (let i = 0; i < 3; i++) {
        const n = nextRun(s, cursor);
        if (n === null) break;
        upcoming.push(n);
        cursor = n;
      }
    }
    wrap.append(el('div', { class: 'preview' },
      el('div', { class: 'preview-label', text: label }),
      // the parameter is named `ts` because `t` is the module's translator, and shadowing it here would have
      // turned every `t(...)` in this function into a number
      ...upcoming.map((ts) => el('div', { class: 'preview-next', text: `next: ${fmtTime(ts)}  (${relTime(ts)})` })),
      upcoming.length === 0 && s.kind !== 'manual'
        ? el('div', { class: 'preview-warn', text: t('sched.willNotFire') })
        : null,
    ));
  } catch (e) {
    wrap.append(el('div', { class: 'preview warn', text: `Invalid schedule: ${e.message}` }));
  }

  return wrap;
}

// ---------------------------------------------------------------------------------------------
// step editor
// ---------------------------------------------------------------------------------------------

/**
 * The Pick control, and the way OUT of it.
 *
 * WHY THIS IS ONE FUNCTION. The panel has two views that pick - the full editor and the simplified one - and they had
 * drifted: 'Pick & record' appeared in the simplified view while the editor said 'Pick', for the same action. Building
 * the button in one place is what stops that happening again, and it is also where the missing cancel belongs.
 *
 * There was NO WAY TO CANCEL. Escape works inside the page, but a pick is started from the panel and the panel did not
 * listen for it - so pressing Pick by mistake left the only exit as clicking an element, which then got recorded as the
 * target. Misclicks must be recoverable.
 */
function pickControl({ step, redraw, rerender }) {
  // `rerender` accepted as an alias so an older call site cannot silently pass the wrong behaviour
  redraw = redraw ?? rerender;
  const picking = state.pickTarget === step.id;
  /**
   * A pick that just landed says so, the way Save does.
   *
   * Held as an expiry timestamp rather than a timeout, so a re-render cannot leave it stuck claiming a pick that has
   * since been replaced - the lesson from the Save button, applied before it can bite again.
   */
  /**
   * ONLY THE POINT THAT WAS PICKED CONFirms.
   *
   * MEASURED BUG: the condition was `state.pickSavedAt && state.pickTarget === null` - a timestamp with no record of
   * WHICH point it belonged to. Since `pickTarget` is null once a pick lands, that was true for every Pick button on
   * the panel, so all of them went green at once. Reported as "when it goes green, all the previously created picks go
   * green too, when only the selected one should" - visual only, the behaviour was right.
   *
   * The identity of the point is now part of the state, so the confirmation is per-point like the picking state already
   * was. Two points can never confirm for one pick, which is the property the test asserts.
   */
  const justPicked = state.pickSavedFor === step.id && state.pickTarget === null
    && Date.now() - (state.pickSavedAt ?? 0) < 1500;

  /**
   * `redraw` is supplied by the caller and MUST preserve the form's working copy.
   *
   * In the simplified view a plain re-render rebuilds the draft from storage, which drops the `pickTarget` that was
   * just set - so the button never entered its picking state and the click looked like it did nothing. MEASURED: the
   * message reached the worker and returned `ok: true`, yet the button stayed unchanged. The caller passes the helper
   * that keeps the draft (`keepDraftThen`); the full editor passes its own render, which has no draft to keep.
   */
  const btn = el('button', {
    class: picking ? 'pick picking' : (justPicked ? 'pick picked' : 'pick'),
    text: picking ? t('ui.picking') : (justPicked ? t('ui.picked') : t('ui.pick')),
    title: picking ? t('ui.pickingTitle') : t('ui.pickTitle'),
    // the point this button belongs to, so the confirmation can find the CURRENT button after a re-render replaces it
    'data-step-id': step.id,
    onclick: async () => {
      if (picking) { cancelPick(redraw); return; }
      state.pickTarget = step.id;
      state.pickSavedAt = null;      // the new pick supersedes the previous confirmation
      state.pickSavedFor = null;
      // recorded so a lost target can be SEEN: the ring is the only observer of the moment the message arrives
      recordPickDebug({ event: 'pressed', stepId: step.id, tab: state.tab, basicSteps: (state.basic?.steps ?? []).map((s) => s.id) });
      /**
       * SAY WHICH AUTOMATION THIS PICK IS FOR.
       *
       * The worker records the page a pick came from against an automation, and this is the only moment anything knows
       * the pairing: a Basic automation has no URL pattern, so without it a scheduled run has no page to go to - measured
       * in the user's own export ("no URL pattern, so a scheduled run has no safe tab").
       */
      const owner = state.basic?.steps?.some((s) => s.id === step.id) ? state.basic : state.editing;
      const res = await send({ type: 'pick-element', automationId: owner?.id ?? null })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      recordPickDebug({ event: 'pick-element-result', ok: res?.ok === true, error: res?.error ?? null, tabId: res?.tabId ?? null });
      if (!res?.ok) {
        state.pickTarget = null;
        state.pickError = String(res?.error ?? 'could not start the picker');
        /**
         * THE ERROR HAS TO BE VISIBLE, IN THE TAB THE USER IS LOOKING AT.
         *
         * `redraw()` rebuilds the simple form from storage, which throws the draft away - so an error stored on the draft
         * was never rendered, and a failed pick looked like a pick that did nothing. Measured: the fault case showed an
         * empty selector with no message anywhere, while the reason ("no page to pick from") was known all along.
         *
         * And it is not only the simple form: from any other tab the error had nowhere to go at all, so a failed pick
         * was silent everywhere except the one tab it did not belong to (bug C7). Both places now get it.
         */
        if (state.tab === 'basic') state.basicError = state.pickError;
        else state.panelNotice = state.pickError;
        redraw();
        return;
      }
      redraw();
    },
  });
  /**
   * THE CONFIRMATION CLEARS ITSELF, without a re-render.
   *
   * MEASURED: the green stayed forever unless something else re-rendered, because the class is computed when the view is
   * built and nothing builds it again - `before the window nothing is green` passed and `after the window nothing is
   * green` failed, with the button still reading "Picked" two seconds later.
   *
   * A re-render would clear it, and is the wrong instrument: rebuilding the view 1.5 seconds after a pick would replace
   * a field the user may be typing in, which is the fault this panel has already had once. So the class, the text and
   * the title are restored on THIS element, and the state is reset so any later render agrees. If the element has since
   * been replaced the update is skipped - harmless, because the new render computes the same expiry and finds it over.
   */
  if (justPicked) {
    setTimeout(() => {
      if (state.pickSavedFor === step.id) { state.pickSavedAt = null; state.pickSavedFor = null; }
      /**
       * THE CURRENT BUTTON IS FOUND, not the one this closure captured.
       *
       * MEASURED: the first version updated `btn` directly and the green never went away - the pick itself triggers a
       * re-render, so the node the timer held had been replaced and the update landed on an element nobody could see.
       * Every sample from 300ms to 3500ms read "✓ Picked". Looking the button up by the point it belongs to is
       * independent of which render produced it, and a missing button is simply nothing to do - the next render
       * computes the expiry from the state that was cleared above.
       */
      const live = document.querySelector(`main button.pick[data-step-id="${step.id}"]`);
      if (!live) return;
      live.classList.remove('picked');
      live.textContent = t('ui.pick');
      live.title = t('ui.pickTitle');
    }, 1500);
  }

  /**
   * While a pick is live, the button that started it is the button that stops it - the same place the user is already
   * looking, and the same gesture. An explicit "Cancel pick" button is added next to it as well, because a button that
   * has changed meaning needs its escape hatch to be visible rather than remembered.
   */
  if (!picking) return btn;
  return el('span', { class: 'pick-wrap' },
    btn,
    el('button', {
      class: 'icon cancel-pick', text: '✕', title: t('ui.cancelPickTitle'),
      // the SAME redraw the button uses: clearing the target on the draft is pointless if the re-render then rebuilds
      // the draft from storage and the stale target survives
      onclick: () => cancelPick(redraw),
    }),
  );
}

/** Tell the page to stop picking and forget the target. Both halves, or the overlay stays on the page. */
function cancelPick(redraw) {
  state.pickTarget = null;
  state.pickCancelled = Date.now();
  // fire and forget: the page's own Escape path is the same call, and a failure here must not block the panel
  send({ type: 'cancel-picking' }).catch(() => {});
  /**
   * REDRAW LAST, AND ALWAYS.
   *
   * `pickTarget` lives on `state`, not on the form's draft, so a plain re-render is safe here - the form's working copy
   * is only at risk for step edits. That distinction is why this takes a redraw callback at all: the simplified view
   * must rebuild without discarding the draft, and the caller knows which it needs.
   */
  if (typeof redraw === 'function') redraw();
  else render();
}

function stepRow(step, list, index, rerender) {
  const isBlock = BLOCK_KINDS.has(step.kind);
  const row = el('div', { class: 'step' });

  const header = el('div', { class: 'step-head' },
    el('span', { class: `step-kind k-${step.kind}`, text: kindLabel(step.kind) }),
    el('span', { class: 'step-summary', text: summariseStep(step) }),
    el('span', { class: 'spacer' }),
    el('button', { class: 'icon', title: t('action.moveUp'), text: t('ui.moveUp'), onclick: () => {
      if (index === 0) return;
      [list[index - 1], list[index]] = [list[index], list[index - 1]];
      rerender();
    } }),
    el('button', { class: 'icon', title: t('action.moveDown'), text: t('ui.moveDown'), onclick: () => {
      if (index >= list.length - 1) return;
      [list[index + 1], list[index]] = [list[index], list[index + 1]];
      rerender();
    } }),
    el('button', { class: 'icon danger', title: t('action.delete'), text: t('ui.close'), onclick: () => {
      list.splice(index, 1);
      rerender();
    } }),
  );
  row.append(header);

  const body = el('div', { class: 'step-body' });

  // ---- finder: the field every element step needs
  const needsElement = ['click', 'fill', 'clear', 'check', 'select', 'hover', 'focus', 'blur',
    'submit', 'extract', 'waitFor'].includes(step.kind);
  if (needsElement) {
    const finder = step.finder ?? { strategy: 'css', selector: '' };
    body.append(el('div', { class: 'row' },
      el('label', { text: t('field.find') }),
      el('select', {
        onchange: (e) => { step.finder = { ...finder, strategy: e.target.value }; rerender(); },
      }, ...['css', 'xpath', 'text', 'id', 'name', 'label', 'placeholder', 'aria', 'role', 'point']
        .map((s) => el('option', {
          value: s,
          // The value stays the raw token, because that is what the finder matches on; only the visible label
          // is translated. A strategy with no catalogue entry falls back to the token, which is still correct.
          text: t.has(`find.${s}`) ? t(`find.${s}`) : s,
          selected: finder.strategy === s,
        }))),
      el('input', {
        class: 'grow mono',
        value: finder.selector ?? finder.xpath ?? finder.text ?? finder.id ?? finder.name ??
               finder.label ?? finder.placeholder ?? finder.aria ?? finder.role ?? '',
        placeholder: t('field.selector'),
        onchange: (e) => {
          // The property name is the MODEL's key and must never be translated. Two of these were routed
          // through t() while translating the labels, which in Persian would have written `finder['متن']`
          // and silently dropped the selector the user typed. Caught by reading this line, not by a test.
          const key = { css: 'selector', xpath: 'xpath', text: 'text', id: 'id', name: 'name',
            label: 'label', placeholder: 'placeholder', aria: 'aria', role: 'role' }[finder.strategy];
          if (key) {
            /**
             * EDITING A PICKED FINDER MUST DROP ITS FALLBACK CHAIN.
             *
             * `buildFinder` records a chain of fallbacks alongside the primary strategy, and the finder tries
             * the chain when the primary matches nothing. So typing a corrected selector left the OLD chain in
             * place: if the new selector had a typo it silently fell back to the element originally picked,
             * and the step clicked the wrong thing while appearing to work. This is why a picked finder felt
             * impossible to correct - the correction was there, but outvoted.
             *
             * Only `chain` is dropped; the primary strategy the user chose is kept.
             */
            const { chain, ...rest } = finder;
            step.finder = { ...rest, [key]: e.target.value };
          }
          rerender();
        },
      }),
      pickControl({ step, rerender: () => render() }),
      finder.chain?.length
        ? el('span', { class: 'hint', title: finder.chain.join('\n'), text: `+${finder.chain.length} fallbacks` })
        : null,
      positionalWarning(finder)
        ? el('span', { class: 'hint warn', title: t('finder.positionalTitle'), text: '⚠' })
        : null,
      // A picked finder could not be undone at all - there was no reset and no delete. Clearing resets to a
      // plain CSS strategy with an empty selector, which is the state a new step starts in.
      (finder.chain?.length || Object.keys(finder).some((k) => k !== 'strategy'))
        ? el('button', {
          class: 'icon', text: '✕', title: t('finder.clear'),
          onclick: () => {
            // keep the strategy the user is looking at, drop everything that came from the picker
            step.finder = { strategy: finder.strategy ?? 'css' };
            rerender();
          },
        })
        : null,
    ));

    /**
     * A POINT FINDER NEEDS COORDINATES, and the selector field cannot hold them.
     *
     * The strategy select offers "point", but the row above it edits `selector`/`xpath`/`text`... - none of which is a
     * coordinate - so choosing "point" produced a finder that could not be filled in and could not be saved. These two
     * inputs are where the coordinates go.
     */
    if (finder.strategy === 'point') {
      const xInput = el('input', { type: 'number', class: 'tiny', min: '0', value: String(finder.x ?? 0) });
      const yInput = el('input', { type: 'number', class: 'tiny', min: '0', value: String(finder.y ?? 0) });
      const commitPoint = () => {
        step.finder = { ...finder, strategy: 'point', x: Number(xInput.value), y: Number(yInput.value) };
        rerender();
      };
      xInput.addEventListener('change', commitPoint);
      yInput.addEventListener('change', commitPoint);
      body.append(el('div', { class: 'row opts' },
        el('label', { text: 'x' }),
        xInput,
        el('label', { text: 'y' }),
        yInput,
      ));
    }

    // ---- click EVERY match, not only the first
    //
    // Only offered for `click`, because that is the case the user hit: ten buttons with the same label, and a
    // single step pressing one of them. `findElement` returns `chosen[index ?? 0]`, so this is not a tuning
    // option but a genuinely different behaviour, and it says what it will do rather than making the user
    // infer it from a count.
    if (step.kind === 'click') {
      const all = normaliseAll(step.clickAll) ?? {};
      const on = step.clickAll && typeof step.clickAll === 'object';
      const setAll = (patchObj) => {
        /**
         * THE VALUES ARE CLAMPED HERE, not at save time.
         *
         * `gapMs` below 50 and a `limit` outside its range were written straight into the step, and the model refused
         * them at Save - so a single stray keystroke made the whole automation unsaveable, with the reason buried in a
         * message the user never saw. `normaliseAll` clamps to what the engine can actually honour.
         */
        step.clickAll = normaliseAll({ ...ALL_DEFAULTS, ...all, ...patchObj });
        rerender();
      };
      body.append(el('div', { class: 'row opts' },
        el('label', { text: t('all.everyMatch') }),
        el('input', {
          type: 'checkbox', id: `all-${step.id}`, checked: on,
          onchange: (e) => {
            step.clickAll = e.target.checked ? { ...ALL_DEFAULTS } : null;
            rerender();
          },
        }),
        // a label for the checkbox, then the options, which only make sense when it is on
        el('label', { for: `all-${step.id}`, text: t('all.clickEveryMatch') }),
      ));

      if (on) {
        body.append(el('div', { class: 'row opts' },
          el('label', { text: t('all.order') }),
          el('select', {
            onchange: (e) => setAll({ order: e.target.value }),
          },
            el('option', { value: 'reverse', text: t('all.reverse'), selected: all.order === 'reverse' }),
            el('option', { value: 'forward', text: t('all.forward'), selected: all.order === 'forward' }),
            el('option', { value: 'as-is', text: t('all.asIs'), selected: all.order === 'as-is' })),
          el('label', { text: t('all.limit') }),
          el('input', {
            type: 'number', class: 'tiny', min: '0', max: '5000', placeholder: t('all.limitAll'),
            value: all.limit ? String(all.limit) : '',
            onchange: (e) => setAll({ limit: e.target.value === '' ? 0 : Number(e.target.value) }),
          }),
          el('label', { text: t('all.gap') }),
          el('input', {
            type: 'number', class: 'tiny', min: '50', max: '60000',
            value: String(all.gapMs ?? ALL_DEFAULTS.gapMs),
            onchange: (e) => setAll({ gapMs: Number(e.target.value) }),
          }),
          el('span', { class: 'hint', text: t('all.gapHint') }),
        ));
        body.append(el('p', { class: 'hint', text: t('all.warning') }));
      }
    }
  }

  // ---- kind-specific fields
  if (step.kind === 'fill') {
    body.append(el('div', { class: 'row' },
      el('label', { text: t('field.value') }),
      el('input', {
        class: 'grow', value: step.value ?? '',
        placeholder: t('ph.template'),
        onchange: (e) => { step.value = e.target.value; rerender(); },
      }),
    ));
  }
  if (step.kind === 'click') {
    body.append(el('div', { class: 'row wrap' },
      el('label', { text: t('field.button') }),
      el('select', { onchange: (e) => { step.button = e.target.value; rerender(); } },
        ...['left', 'right', 'middle'].map((b) => el('option', { value: b, text: b, selected: (step.button ?? 'left') === b }))),
      el('label', { text: t('field.clicks') }),
      el('select', { onchange: (e) => { step.clickCount = Number(e.target.value); rerender(); } },
        ...[1, 2, 3].map((n) => el('option', { value: String(n), text: String(n), selected: (step.clickCount ?? 1) === n }))),
      /**
       * A BURST, for the clicks that have to land faster than a hand could press them.
       *
       * `repeat` is how many times this step clicks and `repeatGapMs` the pause between them - and the pause may be
       * zero, which is the point: a gap of 0 is what makes a burst of ten clicks take no time at all.
       */
      el('label', { text: t('field.repeat') }),
      el('input', {
        type: 'number', class: 'tiny', min: '1', max: '10000', value: String(step.repeat ?? 1),
        onchange: (e) => {
          step.repeat = Math.max(1, Math.min(10000, Math.floor(Number(e.target.value) || 1)));
          rerender();
        },
      }),
      el('label', { text: t('field.repeatGap') }),
      el('input', {
        type: 'number', class: 'tiny', min: '0', max: '60000', value: String(step.repeatGapMs ?? 0),
        onchange: (e) => {
          step.repeatGapMs = Math.max(0, Math.min(60000, Number(e.target.value) || 0));
          rerender();
        },
      }),
    ));
  }
  if (step.kind === 'check') {
    body.append(el('div', { class: 'row' },
      el('label', { text: t('field.state') }),
      el('select', { onchange: (e) => { step.checked = e.target.value === 'true'; rerender(); } },
        el('option', { value: 'true', text: t('step.check'), selected: step.checked === true }),
        el('option', { value: 'false', text: t('step.uncheck'), selected: step.checked !== true })),
    ));
  }
  if (step.kind === 'select') {
    body.append(el('div', { class: 'row' },
      el('label', { text: t('field.option') }),
      el('input', {
        class: 'grow', value: step.value ?? '', placeholder: t('ph.optionValue'),
        onchange: (e) => { step.value = e.target.value; rerender(); },
      }),
    ));
  }
  if (step.kind === 'wait') {
    body.append(el('div', { class: 'row' },
      el('label', { text: t('step.wait') }),
      el('input', {
        type: 'number', class: 'small', value: String(step.ms ?? 1000), min: '0',
        onchange: (e) => { step.ms = Math.max(0, Number(e.target.value)); rerender(); },
      }),
      el('span', { class: 'hint', text: t('hint.ms') }),
    ));
  }
  if (step.kind === 'goto' || step.kind === 'newTab') {
    body.append(el('div', { class: 'row' },
      el('label', { text: t('field.url') }),
      el('input', {
        class: 'grow mono', value: step.url ?? '', placeholder: t('ph.url'),
        onchange: (e) => { step.url = e.target.value; rerender(); },
      }),
    ));
  }
  if (step.kind === 'key') {
    body.append(el('div', { class: 'row' },
      el('label', { text: t('field.keys') }),
      el('input', {
        class: 'grow mono', value: Array.isArray(step.keys) ? step.keys.join('+') : (step.keys ?? ''),
        placeholder: t('ph.keyChord'),
        onchange: (e) => { step.keys = e.target.value; rerender(); },
      }),
      el('label', { text: t('field.gap') }),
      el('input', {
        type: 'number', class: 'small', value: String(step.gapMs ?? 0), min: '0',
        onchange: (e) => { step.gapMs = Number(e.target.value); rerender(); },
      }),
      el('span', { class: 'hint', text: t('hint.msBetweenKeys') }),
    ));
  }
  if (step.kind === 'scroll') {
    body.append(el('div', { class: 'row' },
      el('label', { text: t('hint.by') }),
      el('input', {
        type: 'number', class: 'small', value: String(step.y ?? 0),
        onchange: (e) => { step.y = Number(e.target.value); rerender(); },
      }),
      el('span', { class: 'hint', text: t('hint.scrollPx') }),
    ));
  }
  if (step.kind === 'setVariable') {
    body.append(el('div', { class: 'row' },
      el('label', { text: t('field.name') }),
      el('input', { class: 'small mono', value: step.name ?? '', onchange: (e) => { step.name = e.target.value; rerender(); } }),
      el('input', {
        class: 'grow', value: step.value ?? '', placeholder: t('ph.anyValue'),
        onchange: (e) => { step.value = e.target.value; rerender(); },
      }),
    ));
  }
  if (step.kind === 'extract') {
    body.append(el('div', { class: 'row' },
      el('label', { text: t('field.into') }),
      el('input', { class: 'small mono', value: step.name ?? '', onchange: (e) => { step.name = e.target.value; rerender(); } }),
      el('select', { onchange: (e) => { step.source = e.target.value; rerender(); } },
        ...['text', 'value', 'attribute', 'html', 'count'].map((s) =>
          el('option', { value: s, text: s, selected: (step.source ?? 'text') === s }))),
    ));
  }
  if (step.kind === 'notify') {
    body.append(el('div', { class: 'row' },
      el('label', { text: t('field.message') }),
      el('input', {
        class: 'grow', value: step.message ?? '', placeholder: t('ph.textOrVariable'),
        onchange: (e) => { step.message = e.target.value; rerender(); },
      }),
    ));
  }
  if (step.kind === 'runScript') {
    body.append(el('textarea', {
      class: 'code', rows: '3', value: step.code ?? '',
      placeholder: t('ph.script'),
      onchange: (e) => { step.code = e.target.value; },
    }));
  }

  // ---- loops and branches
  if (step.kind === 'loop') {
    body.append(el('div', { class: 'row' },
      el('label', { text: t('field.type') }),
      el('select', { onchange: (e) => { step.loopType = e.target.value; rerender(); } },
        // `label`, not `t`: `t` is the module's translator, and shadowing it here made every `t(...)` in this
        // function a number instead of a translated string
        ...[['count', 'a number of times'], ['while', 'while a condition holds'], ['forEach', 'for each item in a list']]
          .map(([v, label]) => el('option', { value: v, text: label, selected: (step.loopType ?? 'count') === v }))),
    ));
    if ((step.loopType ?? 'count') === 'count') {
      body.append(el('div', { class: 'row' },
        el('label', { text: t('field.times') }),
        el('input', {
          type: 'number', class: 'small', value: String(step.count ?? 1), min: '1',
          onchange: (e) => { step.count = Math.max(1, Number(e.target.value)); rerender(); },
        }),
      ));
    }
    if (step.loopType === 'forEach') {
      body.append(el('div', { class: 'row' },
        el('label', { text: t('field.list') }),
        el('input', {
          class: 'grow mono', value: step.listVariable ?? '', placeholder: t('ph.listVariable'),
          onchange: (e) => { step.listVariable = e.target.value; rerender(); },
        }),
      ));
    }
    if (step.loopType === 'while') {
      body.append(el('div', { class: 'row' },
        el('label', { text: t('field.max') }),
        el('input', {
          type: 'number', class: 'small', value: String(step.maxIterations ?? 100), min: '1',
          onchange: (e) => { step.maxIterations = Math.max(1, Number(e.target.value)); rerender(); },
        }),
        el('span', { class: 'hint', text: t('hint.loopIterations') }),
      ));
      body.append(conditionEditor(step, 'condition', rerender));
    }
  }

  if (step.kind === 'if') {
    body.append(conditionEditor(step, 'condition', rerender));
    body.append(el('div', { class: 'row' },
      el('label', { text: t('field.runsFor') }),
      el('span', { class: 'hint', text: t('hint.loopVars') }),
    ));
  }

  // ---- nested steps
  if (isBlock) {
    const nested = step.kind === 'if' ? (step.then ?? []) : (step.steps ?? []);
    if (step.kind === 'if' && !step.then) step.then = nested;
    if (step.kind === 'loop' && !step.steps) step.steps = nested;
    body.append(stepsEditor(nested, rerender, 'then'));
    if (step.kind === 'if') {
      const elseList = step.else ?? [];
      if (!step.else) step.else = elseList;
      body.append(el('div', { class: 'sub-label', text: t('hint.otherwise') }));
      body.append(stepsEditor(elseList, rerender, 'else'));
    }
  }

  // ---- shared options
  body.append(el('div', { class: 'row opts' },
    el('label', { text: t('field.delay') }),
    el('input', {
      type: 'number', class: 'tiny', value: String(step.delayMs ?? ''), placeholder: t('ph.empty'), min: '0',
      onchange: (e) => { step.delayMs = e.target.value === '' ? undefined : Number(e.target.value); },
    }),
    el('span', { class: 'hint', text: t('field.delayUnit') }),
    el('label', { text: t('field.retries') }),
    el('input', {
      type: 'number', class: 'tiny', value: String(step.retries ?? ''), placeholder: t('ph.empty'), min: '0', max: '50',
      onchange: (e) => { step.retries = e.target.value === '' ? undefined : Number(e.target.value); },
    }),
    el('label', { text: t('field.onError') }),
    el('select', { onchange: (e) => { step.onError = e.target.value || undefined; } },
      el('option', { value: '', text: t('onError.stop'), selected: !step.onError }),
      el('option', { value: 'continue', text: t('onError.continue'), selected: step.onError === 'continue' }),
      el('option', { value: 'skip', text: t('onError.skip'), selected: step.onError === 'skip' })),
  ));

  row.append(body);
  return row;
}

function conditionEditor(host, key, rerender) {
  /**
   * A CONDITION HAS A TARGET, and the default carries one.
   *
   * The default used to be `{ source: 'text', comparator: 'exists' }` - with no finder, and no control to add one.
   * An `if` step therefore had nothing to point at, could not be saved, and the user was told only that the save
   * failed. The finder is part of the default now, and the row below renders it for every source that reads the page.
   */
  const c = host[key] ?? { source: 'text', comparator: 'exists', finder: { strategy: 'css', selector: '' } };
  host[key] = c;
  const wrap = el('div', { class: 'cond' });
  wrap.append(el('div', { class: 'row' },
    el('label', { text: t('step.if') }),
    el('select', {
      onchange: (e) => {
        const [source, comparator] = e.target.value.split('|');
        c.source = source;
        c.comparator = comparator;
        rerender();
      },
    }, ...[
      ['text', 'exists', 'the text exists'],
      ['text', 'notExists', 'no match at all'],
      ['text', 'visible', 'is visible'],
      ['text', 'hidden', 'is hidden'],
      ['text', 'eq', 'text equals'],
      ['text', 'contains', 'text contains'],
      ['text', 'matches', 'text matches regex'],
      ['value', 'eq', 'value equals'],
      ['value', 'notEmpty', 'value is not empty'],
      // `js` is NOT a source and never was - it was accepted, never evaluated, and is a hazard rather than a feature.
      // The attribute source replaces it, because "the href of this link equals ..." is a condition people actually want.
      ['attribute', 'eq', 'attribute equals'],
      ['count', 'countGt', 'count is more than'],
      ['count', 'countLt', 'count is less than'],
      ['url', 'contains', 'the URL contains'],
      ['title', 'contains', 'the page title contains'],
      ['variable', 'eq', 'a variable equals'],
      ['text', 'checked', 'is checked'],
      ['text', 'enabled', 'is enabled'],
    ].map(([s, cmp, label]) => el('option', {
      value: `${s}|${cmp}`, text: label, selected: c.source === s && c.comparator === cmp,
    }))),
  ));

  /**
   * THE TARGET, for every source that reads the page.
   *
   * `url`, `title` and `variable` read something that is not an element, so they need no finder. Every other source
   * does - and there was no row for it, so an `if` step could not say WHICH element it was about and could not be
   * saved at all (bug C3). The row is the same one an ordinary step has, pick button included.
   */
  if (!['url', 'title', 'variable'].includes(c.source)) {
    c.finder ??= { strategy: 'css', selector: '' };
    const finder = c.finder;
    wrap.append(el('div', { class: 'row' },
      el('label', { text: t('field.find') }),
      el('select', {
        onchange: (e) => { c.finder = { ...finder, strategy: e.target.value }; rerender(); },
      }, ...['css', 'xpath', 'text', 'id', 'name', 'label', 'placeholder', 'aria', 'role', 'point']
        .map((s) => el('option', {
          value: s,
          text: t.has(`find.${s}`) ? t(`find.${s}`) : s,
          selected: finder.strategy === s,
        }))),
      el('input', {
        class: 'grow mono',
        value: finder.selector ?? finder.xpath ?? finder.text ?? finder.id ?? finder.name ??
               finder.label ?? finder.placeholder ?? finder.aria ?? finder.role ?? '',
        placeholder: t('field.selector'),
        onchange: (e) => {
          // `finderKey`, not `key`: `key` is this function's own parameter (the property on the host step)
          const finderKey = { css: 'selector', xpath: 'xpath', text: 'text', id: 'id', name: 'name',
            label: 'label', placeholder: 'placeholder', aria: 'aria', role: 'role' }[finder.strategy];
          if (finderKey) {
            // editing drops the fallback chain: it pointed at the ORIGINALLY picked element and would outvote a
            // corrected selector when the new one missed
            const { chain, ...rest } = finder;
            c.finder = { ...rest, [finderKey]: e.target.value };
          }
          rerender();
        },
      }),
      // the pick control needs a step-shaped object, so the condition's own finder is exposed as one
      pickControl({
        step: {
          id: host.id,
          get finder() { return c.finder; },
          set finder(v) { c.finder = v; },
        },
        rerender: () => render(),
      }),
    ));
  }

  /**
   * THE NAME OF THE VARIABLE, and the name of the attribute.
   *
   * Both are part of the condition's meaning and neither had a control, so a condition on a variable or on an
   * attribute could not be filled in - and could not be saved.
   */
  if (c.source === 'variable') {
    wrap.append(el('div', { class: 'row' },
      el('label', { text: 'variable' }),
      el('input', {
        class: 'grow mono', value: c.variable ?? '', placeholder: 'variable name',
        onchange: (e) => { c.variable = e.target.value; rerender(); },
      }),
    ));
  }
  if (c.source === 'attribute') {
    wrap.append(el('div', { class: 'row' },
      el('label', { text: 'attribute' }),
      el('input', {
        class: 'grow mono', value: c.attribute ?? '', placeholder: 'attribute name',
        onchange: (e) => { c.attribute = e.target.value; rerender(); },
      }),
    ));
  }

  if (c.comparator !== 'exists' && c.comparator !== 'notExists' &&
      !['visible', 'hidden', 'checked', 'unchecked', 'enabled', 'disabled', 'empty', 'notEmpty'].includes(c.comparator)) {
    wrap.append(el('div', { class: 'row' },
      el('label', { text: t('field.value') }),
      el('input', {
        class: 'grow', value: c.value ?? '', placeholder: t('ph.compareAgainst'),
        onchange: (e) => { c.value = e.target.value; rerender(); },
      }),
    ));
  }
  wrap.append(el('div', { class: 'hint', text: describeCondition(c) }));
  return wrap;
}

function summariseStep(step) {
  const f = step.finder;
  const where = f ? (f.selector || f.text || f.xpath || f.id || f.name || f.label || f.placeholder || f.aria || f.role || '?') : '';
  switch (step.kind) {
    case 'click': return where;
    case 'fill': return `${where} ← ${String(step.value ?? '').slice(0, 40)}`;
    case 'check': return `${where} → ${step.checked ? 'checked' : 'unchecked'}`;
    case 'select': return `${where} → ${step.value ?? ''}`;
    case 'wait': return `${step.ms} ms`;
    case 'waitFor': return `until ${describeCondition(step.condition)}`;
    case 'goto': return String(step.url ?? '').slice(0, 60);
    case 'loop': return (step.loopType ?? 'count') === 'count' ? `${step.count}×`
      : step.loopType === 'forEach' ? `each of ${step.listVariable ?? '?'}`
      : `while ${describeCondition(step.condition)}`;
    case 'if': return describeCondition(step.condition);
    case 'setVariable': return `${step.name} = ${String(step.value ?? '').slice(0, 30)}`;
    case 'extract': return `${where} → ${step.name}`;
    case 'key': return Array.isArray(step.keys) ? step.keys.join('+') : String(step.keys ?? '');
    case 'keydown': return '';
    case 'notify': return String(step.message ?? '').slice(0, 40);
    case 'runScript': return String(step.code ?? '').slice(0, 40);
    case 'scroll': return `${step.y ?? 0} px`;
    case 'stop': return step.reason ? String(step.reason).slice(0, 40) : 'end the run';
    default: return where;
  }
}

function stepsEditor(list, rerender, label) {
  const wrap = el('div', { class: 'steps' });
  if (label) wrap.append(el('div', { class: 'sub-label', text: label }));
  list.forEach((s, i) => wrap.append(stepRow(s, list, i, rerender)));

  const addRow = el('div', { class: 'row add' },
    el('select', { class: 'grow', id: 'add-kind' },
      ...STEP_KINDS.map((k) => el('option', { value: k, text: kindLabel(k) })),
    ),
    el('button', {
      class: 'primary', text: t('hint.addStep'),
      onclick: (e) => {
        const sel = e.currentTarget.previousElementSibling;
        const kind = sel.value;
        const defaults = {
          click: { finder: { strategy: 'css', selector: '' } },
          fill: { finder: { strategy: 'css', selector: '' }, value: '' },
          wait: { ms: 1000 },
          goto: { url: '' },
          loop: { loopType: 'count', count: 3, steps: [] },
          if: { condition: { source: 'text', comparator: 'exists', finder: { strategy: 'css', selector: '' } }, then: [], else: [] },
          waitFor: { finder: { strategy: 'css', selector: '' }, condition: { source: 'text', comparator: 'visible' }, timeoutMs: 15000 },
          setVariable: { name: '', value: '' },
          notify: { message: '' },
          key: { keys: '' },
          scroll: { y: 300 },
        };
        list.push(makeStep(kind, defaults[kind] ?? {}));
        rerender();
      },
    }),
  );
  wrap.append(addRow);
  return wrap;
}

// ---------------------------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------------------------

/**
 * The simple view: a time, and a list of points to click at that time. Nothing else.
 *
 * WHY IT EDITS A REAL AUTOMATION RATHER THAN ITS OWN RECORD. A second kind of saved job would need its own
 * scheduler path, its own run path, its own history and its own diagnostics - and every one of those is already
 * built, tested and (after several bugs) trusted. So this is a different EDITOR over the same record: one
 * automation with a fixed id, always `daily` with a second, whose steps are one click each. The full editor can
 * still open it, which is the escape hatch when a job outgrows this form.
 */
const BASIC_ID = 'basic';
const BASIC_NAME_KEY = 'basic.name';

/**
 * FINDERS FROM A PICK, kept OUTSIDE the draft.
 *
 * MEASURED, and this is the fault that read as "پیک کار نمیکند": `element-picked` set `step.finder` on the draft and
 * called `render()`, but any render that does not keep the draft rebuilds it from storage via `basicDraft()` - and the
 * finder was gone. The button still said "✓ Picked", because its class comes from `state.pickSavedFor` (an id), not from
 * the finder, so the UI claimed success with an empty selector underneath.
 *
 * It also explains why it sometimes worked: with no intervening render the draft survived.
 *
 * Keeping the finders here means a rebuild cannot lose them - the map is the record, the draft is only a view of it.
 */
function rememberFinder(stepId, finder) {
  if (!stepId || !finder) return;
  state.pickedFinders = { ...(state.pickedFinders ?? {}), [stepId]: finder };
}

/**
 * Apply every remembered finder to a draft's steps, in place.
 *
 * THE MAP IS AUTHORITATIVE for any step it has an entry for. The first version of this added a condition -
 * `!(s.finder && Object.keys(s.finder).length > 1)` - meant to keep an existing good finder. It did the opposite: an
 * EMPTY finder is `{ strategy: 'css', selector: '' }`, which has exactly one key, so the guard read it as "a real finder
 * already exists" and skipped the entry. Measured: `the picked element reached the form` failing with the map populated
 * and the field empty. A condition that has to be right about an unrelated shape is a second bug waiting to happen - the
 * entry exists or it does not.
 */
function applyPickedFinders(steps) {
  const map = state.pickedFinders ?? {};
  for (const s of steps ?? []) {
    if (s?.id && map[s.id]) s.finder = { ...map[s.id] };
    for (const key of ['steps', 'then', 'else']) {
      if (Array.isArray(s?.[key])) applyPickedFinders(s[key]);
    }
  }
  return steps;
}

function basicDraft() {
  const existing = state.automations.find((a) => a.id === BASIC_ID);
  if (existing) {
    // an editor over a real record: take the stored steps, but never its schedule kind, because this form is
    // always a daily time
    return {
      ...existing,
      /**
       * THE SPREAD ORDER IS THE WHOLE FIX.
       *
       * `{ kind: 'daily', ...(existing.schedule ?? {}) }` put the STORED kind last, so a saved `cron` or `manual`
       * schedule overwrote the `daily` this form is built around - and the form then edited a schedule kind it does
       * not know how to show. The stored fields are spread first and the form's own kind is written last, so the
       * form always edits a daily schedule and keeps the hour it had.
       */
      schedule: {
        ...(existing.schedule ?? {}),
        kind: 'daily',
        hour: existing.schedule?.hour ?? 9,
        minute: existing.schedule?.minute ?? 0,
        second: existing.schedule?.second ?? 0,
        ...(existing.schedule?.ms ? { ms: existing.schedule.ms } : {}),
      },
      steps: applyPickedFinders((existing.steps ?? []).map((s) => ({ ...s }))),
    };
  }
  /**
   * A FRESH DRAFT NEEDS A STABLE STEP ID.
   *
   * MEASURED, and this is why picks kept vanishing: this function runs on every render that does not keep the draft, and
   * `makeStep` mints a NEW random id each time. `state.pickTarget` holds the id the button had when it was pressed, so as
   * soon as one such render happened the pick arrived for an id that no longer existed - and the listener dropped it in
   * silence. Observed directly: the Pick button carried `smvuzxgjy1`, the form below it carried `smvuzxhtp2` a few hundred
   * milliseconds later.
   *
   * That also explains why it sometimes worked: with no render between the press and the click on the page, the id
   * survived. A fault that depends on timing is the worst kind to report, because the report is "it does not work".
   *
   * The first point of the simple form is positional - it IS "point 1" - so its id is derived rather than random.
   */
  return {
    id: BASIC_ID,
    name: t(BASIC_NAME_KEY),
    enabled: true,
    urls: [],
    schedule: { kind: 'daily', hour: 9, minute: 0, second: 0, ms: 0 },
    steps: applyPickedFinders([{ id: `${BASIC_ID}-point-1`, kind: 'click', finder: { strategy: 'css', selector: '' } }]),
    options: { stepDelayMs: 0, stepRetries: 2, maxRunMs: 30 * 60_000 },
    createdAt: Date.now(),
  };
}

function basicView(rerender) {
  const wrap = el('div', { class: 'basic' });
  /**
   * The form is rebuilt from the SAVED record on every render, unless that render was caused by the form itself.
   *
   * Reported as "duplicate points that cannot be removed": a draft kept in memory across visits came back with
   * points the user had deleted, and the saved record was ignored. Storage is the truth, so the default is to
   * rebuild. The single exception is a re-render caused by the form (adding, deleting, reordering, picking) -
   * `state.basicKeepDraft` is set by exactly those, so their result is not thrown away. A flag that had to be right
   * on every path was the earlier, fragile version of this.
   */
  /**
   * AN UNSAVED FORM SURVIVES A RENDER.
   *
   * `basicDraft()` builds its point list from the SAVED record, which is empty until Save - so any render that did not
   * keep the draft silently threw away the points the user had added, and the pick that was in flight went with them.
   * MEASURED: `pick-confirm-test` added two points to reach three, pressed Pick, and the panel came back with ONE button.
   *
   * Keeping the draft in memory is what the flag is for, but the flag only knew about actions the form itself triggered.
   * A render caused by anything else - a status update, a settings refresh, a pick arriving - dropped the work. So the
   * draft is now kept whenever it HAS unsaved content, which is a property of the draft rather than a flag somebody has
   * to remember to set.
   */
  /**
   * KEEPING UNSAVED WORK MUST NOT OUTLIVE THE SAVE.
   *
   * MEASURED: the first version of this kept any draft with more than one point, so a form left over from a previous run
   * came back with two points where the saved record has one - `ui-basic-test` reported "it starts with one click point: 2"
   * and every count after that was off by one.
   *
   * `basicStale` already records the moments the stored record is the truth (after a save, and on leaving the tab), so it
   * takes precedence. The rule is: keep the draft while the user is working on it, rebuild it whenever storage has moved
   * on.
   */
  const hasFinder = (s) => Boolean(s?.finder && Object.keys(s.finder).some((k) => k !== 'strategy' && s.finder[k]));
  /**
   * ANY UNSAVED CHANGE COUNTS, NOT ONLY AN ADDED POINT.
   *
   * MEASURED (user report, 1.24.0): "when I set the time and then press Pick, the time resets to 09". The condition here
   * only looked at STEPS - one empty point with no finder was "no work", so `basicDraft()` rebuilt the form from storage
   * and the schedule came back as the 09:00 default. The time had been typed, accepted by the model, and then thrown
   * away by a render that Pick itself triggered.
   *
   * A form has more state than its list of points. The comparison is against the SAVED record, which is the only honest
   * definition of "unsaved": anything that differs is the user's work.
   */
  const savedBasic = state.automations?.find((a) => a.id === BASIC_ID) ?? null;
  const draftDiffers = (() => {
    if (!state.basic) return false;
    const draft = state.basic;
    // a time that differs from the saved one (or any time at all, when nothing is saved yet)
    const ds = draft.schedule ?? null;
    const ss = savedBasic?.schedule ?? null;
    if (!ss || !ds) return Boolean(ds) !== Boolean(ss);
    if (ds.hour !== ss.hour || ds.minute !== ss.minute || ds.second !== ss.second) return true;
    if ((draft.name ?? '') !== (savedBasic?.name ?? '')) return true;
    // and a point that has a finder, or more points than were saved
    return (draft.steps ?? []).length > (savedBasic?.steps ?? []).length
      || (draft.steps ?? []).some(hasFinder);
  })();
  const unsavedWork = Boolean(state.basic) && !state.basicStale
    && ((state.basic.steps ?? []).length > 1 || (state.basic.steps ?? []).some(hasFinder) || draftDiffers);
  /**
   * A TYPED TIME IS UNSAVED WORK, AND IT MUST BE ABLE TO OVERRIDE A STALE FLAG.
   *
   * MEASURED (`pick-digits-test`, and it is the general fault behind "the time resets"): `Tab` commits the field with
   * `{ rerender: true }`, the render consults `state.basicStale`, and because an earlier auto-save had set that flag the
   * form was rebuilt from storage - dropping the time the user had just typed. The field showed 08:45:52, `Tab` was
   * pressed, and it came back as 09:00.
   *
   * `eventsDiffer` answers the only question that matters here: does the working copy disagree with what is stored? If it
   * does, the working copy is the truth, whatever any flag says.
   */
  const eventsDiffer = (() => {
    const saved = state.automations?.find((a) => a.id === BASIC_ID) ?? null;
    const rows = state.basicEvents ?? [];
    if (!rows.length) return false;
    const stored = (state.automations ?? []).filter((a) => a.id === BASIC_ID || /^basic-t\d+$/.test(a.id));
    if (stored.length !== rows.length) return true;
    return rows.some((ev) => {
      const rec = stored.find((a) => a.id === ev.id);
      if (!rec) return true;
      return Number(rec.schedule?.hour ?? -1) !== Number(ev.schedule?.hour ?? -2)
        || Number(rec.schedule?.minute ?? -1) !== Number(ev.schedule?.minute ?? -2)
        || Number(rec.schedule?.second ?? -1) !== Number(ev.schedule?.second ?? -2)
        || Number(rec.schedule?.ms ?? 0) !== Number(ev.schedule?.ms ?? 0)
        || (rec.steps ?? []).length !== (ev.steps ?? []).length;
    });
  })();
  const keepWorkingCopy = unsavedWork || eventsDiffer;
  if (!state.basic || (!state.basicKeepDraft && !keepWorkingCopy)) {
    state.basic = basicDraft();
    state.basicStale = false;
  } else {
    // the form changed itself and the result must survive any follow-up build in this render sequence
    bodyKeptDraftForFollowUp = true;
  }
  state.basicKeepDraft = false;
  const draft = state.basic;

  /**
   * AUTO-SAVE: A CHANGE TO THE FORM SAVES ITSELF, SHORTLY AFTER THE EDITING STOPS.
   *
   * Asked for: "بهش اتوسیو هم اضافه کن بعد هر تغییر یا اضافه یا حذف کردن خودش خودکار سیو بشه چون ممکنه بعضی اوقات
   * گزینه سیو زده بشه" - add auto-save so that after any change, addition or deletion it saves itself, because
   * sometimes the Save button is missed.
   *
   * WHY A DEBOUNCE AND NOT A SAVE PER KEYSTROKE. Typing "10:32:33.250" is nine keystrokes; nine saves would be nine
   * storage writes, nine alarm registrations and nine entries in the run history for one intended change. So the save
   * waits for a pause in the editing.
   *
   * WHY NOT ON blur EITHER. A blur fires when the user reaches for Pick, so saving then would re-render the form under
   * the pointer - the exact fault that made the time field "reset" in 1.24.0.
   *
   * THE SAVE IS THE SAME `save()` THE BUTTON CALLS. Not a second path: a lighter version would be free to disagree with
   * the real one, and the disagreement would be about which points were stored.
   */
  const AUTO_SAVE_DELAY_MS = 1200;
  let autoSaveTimer = null;
  const autoSave = () => {
    if (state.tab !== 'basic') return;              // the user has moved on; the stale flag handles that case
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
      autoSaveTimer = null;
      if (state.tab !== 'basic') return;
      /**
       * NEVER SAVE WHILE THE USER IS MID-EDIT.
       *
       * MEASURED (`pick-digits-test`): the auto-save armed by one section fired while the next section was typing, and
       * although it no longer re-renders, the state it wrote (and the stale flag it set) reached the NEXT render - which
       * then rebuilt the form from storage and replaced the half-typed time. The commit log showed the typed value never
       * reached the model at all.
       *
       * So the debounce is not enough on its own: while ANY input in the form has focus, the save is rescheduled rather
       * than run. A person who is still typing has not finished, and saving before they have is what makes a form fight
       * its own user.
       */
      // NOTE: a "do not save while an input has focus" rule was tried here and REMOVED. MEASURED (`three-times-test`):
      // it delayed the save past the field's blur commit, and a later render then committed a half-typed buffer -
      // 10:32:40 was stored as 1:00:00, because the field held "1" at that moment. Deferring a save is not free.
      /**
       * SAVE WHAT IS USABLE, NEVER REFUSE THE WHOLE FORM OVER ONE UNFINISHED POINT.
       *
       * MEASURED (`second-pick-test`): the first version returned early unless EVERY time had at least one pickable
       * point. So while the user was midway through a form - one point picked, the next just added - nothing was stored
       * at all, and the next render rebuilt the rows from a storage that held nothing. That is the other half of "the
       * second pick disappears".
       *
       * `save()` already refuses an empty record and already drops points without a finder, so the only thing this gate
       * needs to decide is whether the attempt is worth making. One usable point anywhere is enough.
       */
      const anyUsable = (state.basicEvents ?? []).some((e) => (e.steps ?? []).some((s) => s?.finder
        && Object.keys(s.finder).some((k) => k !== 'strategy' && s.finder[k])));
      if (!anyUsable) return;
      await save({ silent: true });
    }, AUTO_SAVE_DELAY_MS);
  };

  // the pick and delete handlers live outside this closure, so they need handles to the same auto-save
  state.basicAutoSave = autoSave;
  state.basicCancelAutoSave = () => { if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; } };

  /** Mutate the draft and re-render without discarding it. */
  const keepDraftThen = (fn) => {
    fn();
    state.basicKeepDraft = true;
    /**
     * EVERY FORM EDIT GOES THROUGH HERE - add, delete, reorder, re-time, pick - so arming the auto-save in this one
     * place covers all of them without each control having to remember to ask for it.
     */
    autoSave();
    rerender();
  };
  const sched = draft.schedule ?? { kind: 'daily', hour: 9, minute: 0, second: 0, ms: 0 };

  wrap.append(el('p', { class: 'hint', text: t('basic.intro') }));

  // ---- THE TIMES. One is open at a time, shown exactly as the single-time form was: a time and its points.
  //
  // `state.basicOpen` is which event the form below is editing. Defaulting to the first keeps the page identical to
  // the old one for anyone who never presses the new button.
  const events = ensureEvents(state, savedBasic, { nextRun });
  const ordered = orderByNextRun(events, nextRun);
  const baseId = draft.id ?? BASIC_ID;
  const openId = ordered.some((e) => e.id === state.basicOpen) ? state.basicOpen : ordered[0]?.id;
  state.basicOpen = openId;
  const ev = ordered.find((e) => e.id === openId) ?? ordered[0];

  // ---- the times, as a compact list above the form. One row per time, each showing how many points it has, because
  // the point count is what makes three similar-looking times distinguishable at a glance.
  if (ordered.length > 1) {
    const list = el('div', { class: 'row' });
    list.append(el('label', { text: t('basic.times') }));
    const picker = el('div', { class: 'grow event-picker' });
    ordered.forEach((e, index) => {
      /**
       * EACH TIME HAS ITS OWN DELETE CONTROL, because "I added a third time and changed my mind" had no way out.
       *
       * The delete lives ON the chip rather than in a menu: the chip is the time, so removing it is where a person looks.
       * A chip is not a button any more - a button inside a button is invalid HTML and gives the inner control an
       * unpredictable hit area - so the wrapper is a plain div holding two buttons.
       *
       * The last remaining time cannot be deleted: a form with no time has nothing to show and no way back. The button is
       * hidden rather than shown-and-refusing, so the rule is visible instead of learned by pressing.
       */
      const chip = el('div', { class: e.id === openId ? 'event-chip active' : 'event-chip' },
        el('button', {
          class: 'event-chip-open',
          title: `${describeEvent(e.schedule)}`,
          text: `${describeEvent(e.schedule)} · ${filledPoints(e)}`,
          onclick: () => {
            state.basicOpen = e.id;
            // the draft is kept so a time typed but not saved is not thrown away by switching rows
            state.basicKeepDraft = true;
            rerender();
          },
        }),
        ordered.length > 1
          ? el('button', {
            class: 'event-chip-remove',
            // the accessible name carries the time, so a screen reader does not announce "✕" six times
            title: t('basic.removeTimeTitle').replace('{time}', describeEvent(e.schedule)),
            text: '\u2715',
            onclick: () => {
              const { events: next, removed } = removeEvent(state.basicEvents ?? [], e.id);
              if (!removed) {
                state.basicNotice = t('basic.lastEvent');
                rerender();
                return;
              }
              state.basicEvents = next;
              // if the open time is the one going away, open the first that is left
              if (state.basicOpen === e.id) state.basicOpen = next[0]?.id ?? null;
              /**
               * ONE PLACE DECIDES WHAT IS STORED, AND THE SAVE IS THAT PLACE.
               *
               * MEASURED (`remove-time-test`), two attempts:
               *   1. doing nothing here left the deleted time's record and alarm in storage;
               *   2. sending `delete-automation` from here RACED with the auto-save that the same action armed - the
               *      save wrote records for the remaining times while the delete removed one of them, and the deleted
               *      time came back on the next reload.
               *
               * `save()` already computes what to delete (`eventsToStore().remove`) and already writes the rest, in one
               * sequential step. So a deletion does not need its own channel: it needs a save to run, and that save must
               * know the record existed. `knownIds` comes from `state.automations`, so the mirror is what has to be kept
               * intact until then - not pruned early, which is what made the removal set incomplete.
               */
              state.basicKeepDraft = true;
              /**
               * CANCEL THE PENDING SAVE, then arm a fresh one.
               *
               * MEASURED (`remove-time-test`): a save armed before the deletion fired afterwards carrying the list the
               * deletion had just changed, and the removed time came back on the next reload. `autoSave()` debounces, so
               * "arm another" alone would leave the earlier timer to fire first.
               */
              if (typeof state.basicCancelAutoSave === 'function') state.basicCancelAutoSave();
              rerender();
              /**
               * SAVE NOW, NOT ON THE DEBOUNCE.
               *
               * MEASURED (`remove-time-test`): a deletion followed by a reload within the 1.2s debounce left the removed
               * time's record in storage, so it came back - "I deleted it and it reappeared". A debounce exists to
               * collapse a burst of keystrokes; a deletion is one deliberate act with nothing to collapse, and the user
               * may well close the panel or reload straight after it.
               *
               * `save()` is in scope here because this handler runs at click time, after the view has been built.
               */
              save({ silent: true });
            },
          })
          : null,
      );
      chip.dataset.eventId = e.id;
      picker.append(chip);
    });
    list.append(picker);
    wrap.append(list);
  }

  // ---- THE OPEN TIME: one time field and its points, which is the shape the page always had.
  const evHint = el('span', { class: 'hint time-hint', text: '' });
  const commit = (value) => {
    const parsed = parseTypedTime(value);
    evHint.textContent = parsed.ok ? '' : t(`time.error.${parsed.error}`);
    evHint.className = parsed.ok ? 'hint time-hint' : 'hint time-hint warn time-error';
    if (!parsed.ok) return;
    ev.schedule = { kind: 'daily', hour: parsed.hour, minute: parsed.minute, second: parsed.second, ms: parsed.ms };
    draft.schedule = ev.schedule;
    state.basic = draft;
    /**
     * THE USER HAS JUST TYPED A TIME, SO THE WORKING COPY IS THE TRUTH.
     *
     * MEASURED (`pick-digits-test`): a pick in an earlier section armed the auto-save, which set `basicStale` - the flag
     * that says "storage has moved on, rebuild from it". The user then typed 08:45:52, and the `Tab` that followed
     * committed the field with `{ rerender: true }`; the render honoured the flag, rebuilt from storage, and the typed
     * time was replaced by the stored one. The field showed 08:45:52 and then 09:00:00.
     *
     * Typing is the clearest possible statement that the working copy is current, so the flag is cleared here. This is
     * the same rule the form already applies elsewhere: storage is the truth only when it holds everything.
     */
    state.basicStale = false;
    state.basicEventsStale = false;
    /**
     * THE PREVIEW IS REFRESHED HERE, IN THE FUNCTION THAT WROTE THE VALUE.
     *
     * Not from the field's `onEdit`, because that looked the hook up on `state` and could find one built by a different
     * render - and a re-seed replaces the event objects, so the older hook described the older schedule. Refreshing at
     * the point of the write removes the question of which closure is in scope.
     */
    if (typeof state.basicRefreshPreview === 'function') state.basicRefreshPreview();
  };
  wrap.append(el('div', { class: 'row' },
    el('label', { text: t('basic.time') }),
    timeField({
      // one key per time: a key derived from position would move when a row is added or deleted
      focusKey: `basic-time:${ev.id ?? 'basic'}`,
      value: timeFieldValue(ev.schedule),
      onCommit: (v, opts) => { commit(v); if (opts.rerender) keepDraftThen(() => {}); },
      // a typed time is a change to the form like any other, so it arms the same auto-save
      onEdit: () => {
        // the preview follows the typed time immediately; the auto-save follows shortly after
        if (typeof state.basicRefreshPreview === 'function') state.basicRefreshPreview();
        autoSave();
      },
    }),
    evHint,
  ));

  // ---- the points of THE OPEN TIME
  wrap.append(el('div', { class: 'row' },
    el('label', { text: t('basic.points') }),
    el('span', { class: 'hint', text: `${ev.steps.length}` }),
  ));

  ev.steps.forEach((step, i) => {
    const finder = step.finder ?? { strategy: 'css', selector: '' };
    const picked = pickerSummary(finder);

    wrap.append(el('div', { class: 'step' },
      el('div', { class: 'step-head' },
        el('span', { class: 'step-kind', text: `#${i + 1}` }),
        el('span', { class: 'step-summary', text: picked.label }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'icon', title: t('action.moveUp'), text: t('ui.moveUp'), onclick: () => {
          if (i === 0) return;
          [ev.steps[i - 1], ev.steps[i]] = [ev.steps[i], ev.steps[i - 1]];
          keepDraftThen(() => {});
        } }),
        el('button', { class: 'icon', title: t('action.moveDown'), text: t('ui.moveDown'), onclick: () => {
          if (i >= ev.steps.length - 1) return;
          [ev.steps[i + 1], ev.steps[i]] = [ev.steps[i], ev.steps[i + 1]];
          keepDraftThen(() => {});
        } }),
        el('button', { class: 'icon danger', title: t('action.delete'), text: t('ui.close'), onclick: () => {
          // A TIME WITH NO POINTS IS NOT A TIME. Removing the last point removes that time, unless it is the only
          // time left - in which case the row is emptied instead, because a form with no time at all has nothing to
          // show and no way back.
          if (ev.steps.length > 1) {
            keepDraftThen(() => ev.steps.splice(i, 1));
            return;
          }
          if (state.basicEvents.length > 1) {
            state.basicEvents = state.basicEvents.filter((e) => e.id !== ev.id);
            state.basicOpen = null;
            state.basicKeepDraft = true;
            rerender();
            return;
          }
          keepDraftThen(() => { step.finder = { strategy: 'css', selector: '' }; ev.steps.splice(i, 1, { ...step }); });
        } }),
      ),
      el('div', { class: 'step-body' },
        el('div', { class: 'row' },
          pickControl({ step, redraw: () => { state.basicKeepDraft = true; render(); } }),
          el('input', {
            class: 'grow mono',
            value: finder.selector ?? finder.xpath ?? finder.text ?? finder.id ?? finder.name ??
                   finder.label ?? finder.placeholder ?? finder.aria ?? finder.role ?? '',
            placeholder: t('field.selector'),
            onchange: (e) => {
              const key = { css: 'selector', xpath: 'xpath', text: 'text', id: 'id', name: 'name',
                label: 'label', placeholder: 'placeholder', aria: 'aria', role: 'role' }[finder.strategy] ?? 'selector';
              const { chain, ...rest } = finder;
              keepDraftThen(() => { step.finder = { ...rest, strategy: finder.strategy ?? 'css', [key]: e.target.value }; });
            },
          }),
          finder.chain?.length
            ? el('span', { class: 'hint', title: finder.chain.join('\n'), text: `+${finder.chain.length}` })
            : null,
          positionalWarning(finder)
            ? el('span', { class: 'hint warn', title: t('finder.positionalTitle'), text: '\u26a0' })
            : null,
          (finder.chain?.length || Object.keys(finder).some((k) => k !== 'strategy'))
            ? el('button', {
              class: 'icon', text: '\u2715', title: t('finder.clear'),
              onclick: () => keepDraftThen(() => { step.finder = { strategy: finder.strategy ?? 'css' }; }),
            })
            : null,
        ),
      ),
    ));
  });

  // ---- add a point to the OPEN time
  wrap.append(el('div', { class: 'row' },
    el('button', {
      class: 'grow', text: t('basic.addPoint'),
      onclick: () => {
        keepDraftThen(() => ev.steps.push({
          id: `${ev.id}-point-${ev.steps.length + 1}-${Math.random().toString(36).slice(2, 7)}`,
          kind: 'click',
          finder: { strategy: 'css', selector: '' },
        }));
      },
    }),
  ));

  /**
   * ---- NEW TIME. Sits directly under "+ Add a point" and behaves the same way: it adds one more of the thing, at the
   * same level. What it adds is a time that starts with ONE EMPTY POINT ALREADY IN IT, so the row is usable the moment
   * it appears - the user pressed "new time", not "new time, then also press Add a point".
   *
   * Its time is the open event's plus one minute rather than a copy, because two events at the same instant with
   * different points is almost never what someone adding a row means and is hard to notice afterwards.
   */
  wrap.append(el('div', { class: 'row' },
    el('button', {
      class: 'grow', text: t('basic.addTime'),
      onclick: () => {
        const { events: next, added } = addEvent(state.basicEvents, baseId, { after: ev });
        state.basicEvents = next;
        state.basicOpen = added.id;     // open the new time, so the next click on Pick lands in it
        state.basicKeepDraft = true;
        rerender();
      },
    }),
  ));

  // the record's own schedule mirrors the OPEN time, so the rest of the form and the save path see one consistent value
  draft.schedule = ev.schedule;

  // ---- save, and run now
  /**
   * @param {{ silent?: boolean }} [opts] `silent` is used by the auto-save: a refusal that the user did not ask for is
   *   not reported, because merely typing a time would otherwise raise "at least one point is needed" before there is
   *   any point to give it.
   */
  const save = async (opts = {}) => {
    /**
     * EVERY TIME IS SAVED, and each becomes its own automation.
     *
     * A schedule is one alarm and one alarm is one automation, so three times are three records rather than one record
     * with three times. Nothing below this line is timing-aware, which is the point: the run engine, the history, the
     * run lock and the "did it arm?" diagnostics all keep working on the shape they already understand.
     *
     * An event with NO usable point is skipped rather than saved with none, because an automation with no steps fails
     * at run time and reads as a broken clicker rather than an unfinished form.
     */
    /**
     * ASK THE WORKER WHAT IS STORED, rather than trusting the panel's mirror. One extra round-trip per save, and it is
     * the difference between a deleted time being gone and it still having an alarm of its own.
     */
    let storedIds = null;
    try {
      // the reply is an envelope: { ok, automations }
      const listing = await send({ type: 'list-automations' });
      if (listing?.ok && Array.isArray(listing.automations)) storedIds = listing.automations.map((a) => a.id);
    } catch { /* fall back to the mirror; a save must not fail because a listing did */ }
    const { save: all, remove: gone } = eventsToStore(state, state.basicEvents ?? [], { baseId: draft.id ?? BASIC_ID, storedIds });
    const usable = all.filter((a) => a.steps.length > 0);

    if (usable.length === 0) {
      if (!opts.silent) {
        state.basicError = t('basic.needPoint');
        rerender();
      }
      return false;
    }

    state.basicError = null;
    state.basicNotice = null;
    /**
     * SAVE FIRST, THEN DELETE - the reverse of what this did, and the order matters.
     *
     * MEASURED (`probe-delete-trace`): the user removed the 09:00 time and kept 09:01. Deleting before saving meant the
     * removal ran against ids the save was about to reuse, and the outcome was `delete-automation:basic-new1` - the time
     * that was KEPT - while `basic@9:00`, the one removed, stayed in storage with its alarm.
     *
     * Saving first makes every surviving time's record exist under its own id, and the deletion afterwards can only touch
     * ids that no event claims.
     */
    let res = null;
    for (const a of usable) {
      res = await send({ type: 'save-automation', automation: a });
      if (!res?.ok) { state.basicError = res?.error ?? 'save failed'; rerender(); return false; }
    }
    // and then a time the user removed must not keep firing on its own
    for (const id of gone) {
      if (usable.some((a) => a.id === id)) continue;   // never delete a record that was just written
      await send({ type: 'delete-automation', id });
    }
    if (res && usable.length > 1) {
      // report the LAST alarm, but say how many times were armed, so a multi-time save is not silent about it
      res = { ...res, armedCount: usable.length };
    }
    const clean = { ...usable[0], steps: usable[0].steps };
    /**
     * THE ANSWER IS REPORTED, because a caller has to be able to act on it.
     *
     * `save()` used to return nothing, so "Run now" could not tell a refused save from a good one and started the
     * PREVIOUSLY saved automation - the user pressed Run now on a form that had just been rejected, and an old run
     * went off instead. `false` means "nothing was saved"; `true` means "what you see is now what is stored".
     */
    if (clean.steps.length === 0) {
      state.basicError = t('basic.needPoint');
      rerender();
      return false;
    }
    await refresh();
    state.basic = { ...clean };
    state.basicStale = false;
    /**
     * THE EVENTS WORKING COPY IS RE-SEEDED FROM STORAGE, and this is a real fault that was reported as
     * "باگ دوم فقط زمان اولی رو شلیک کرد و pickهای زمان دوم و سوم شلیک نشدن" - only the first time fired.
     *
     * `clean` is ONE record - the first event - because that is what `res` and the notice are about. Leaving
     * `basicEvents` untouched meant the panel held two different pictures after a three-time save: three rows in the
     * working copy and one record in `state.basic`. Any later render that rebuilds the rows from the draft could then
     * produce a single row and drop the other two, which loses the points that were picked into them.
     *
     * Marking the copy stale makes `ensureEvents` rebuild all three from the records that were just written, so the one
     * the save produced. MEASURED before the fix: three records and three alarms in storage, while the panel could come
     * back to one row.
     */
    /**
     * NO RE-SEED HERE, AND THAT IS THE FIX.
     *
     * Three rounds of this feature were broken by re-seeding `basicEvents` from storage after a save, each time in a
     * different way that looked like a different bug:
     *
     *   1. unconditionally  -> times that had no point yet vanished while the user was still working on them
     *   2. on equal counts  -> one time with two points compared equal to one time with one point, so the second point
     *                          was deleted right after being picked ("the second pick disappears and it says saved")
     *   3. on equal totals  -> a pick armed the save, the save re-seeded, and the NEXT render committed a half-typed
     *                          buffer: 10:32:40 was stored as 1:00:00
     *
     * Every one of those was a consequence of the form holding TWO representations of the same work. The working copy is
     * already written by the save (`state.basic = clean` below, and the events are the source of the records), so a
     * re-seed has nothing to correct - it can only destroy something the user has not saved.
     *
     * The rule this file keeps arriving at, stated once: STORAGE IS THE TRUTH ONLY WHEN NOTHING IS UNSAVED. A save is not
     * a moment when nothing is unsaved - it is a moment when part of it just became saved.
     */
    state.basicSavedAt = Date.now();      // the button shows a tick for a moment, which is the only confirmation the user asked for

    /**
     * SAY WHAT HAPPENED TO THE SCHEDULE.
     *
     * `save-automation` now reports whether it armed an alarm, and this is the only place a user would ever look. An
     * export with no automations and no alarms could not distinguish "the save was refused", "the save worked but armed
     * nothing" and "nothing was ever saved" - and all three looked identical from the panel too.
     */
    const sched = res.schedule ?? {};
    if (sched.scheduled) {
      /**
       * THE TARGET INSTANT, and the whole day, not only the day of the month.
       *
       * `when.getDate() === new Date().getDate()` compared the day of the month only, so an alarm armed for
       * TOMORROW at 09:00 read as "today" - because tomorrow has the same date number as today in the same month -
       * and the notice said "scheduled for 09:00" with no date, which is exactly the whole-day jump the notice
       * exists to expose. The worker may also report the target as `target` rather than `at`, and both are read here.
       */
      const targetMs = Number.isFinite(sched.target) ? sched.target : sched.at;
      const when = Number.isFinite(targetMs) ? new Date(targetMs) : null;
      const time = when ? `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}:${String(when.getSeconds()).padStart(2, '0')}` : '';
      const now = new Date();
      const sameDay = when
        ? when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth() && when.getDate() === now.getDate()
        : true;
      state.basicNotice = t('basic.armedFor')
        .replace('{time}', time)
        .replace('{day}', sameDay ? '' : when.toLocaleDateString());
    } else if (sched.reason === 'manual') {
      state.basicNotice = t('basic.notScheduled');
    } else if (Number.isFinite(sched.justMissedMs)) {
      state.basicNotice = t('basic.justMissed').replace('{sec}', String(Math.round(sched.justMissedMs / 1000)));
    } else {
      state.basicNotice = t('basic.armFailed').replace('{reason}', String(sched.reason ?? 'unknown'));
    }

    /**
     * A SILENT SAVE DOES NOT REBUILD THE VIEW AT ALL.
     *
     * MEASURED (1.31.0 dev, `three-times-test`), two attempts and two failures:
     *   1. `rerender()` straight away rebuilt the form while the pointer was on its way to the next control -
     *      "Element is not attached to the DOM", "<html> intercepts pointer events".
     *   2. deferring it to `afterCurrentInteraction` only moved the problem: the render then landed on the NEXT
     *      control's mouseup and detached the element that click was aimed at.
     *
     * Both are the fault this project already documented in 1.24.0 - a rebuild under the pointer swallows the click -
     * and the conclusion is that an AUTOMATIC save must not touch the DOM. There is nothing for it to draw: the form
     * already shows exactly what the user typed, and the tick and the armed-time notice belong to the Save button, which
     * the user pressed deliberately.
     *
     * So the silent save writes storage and arms the alarm, and leaves the view alone. The explicit save still
     * re-renders immediately, because pressing it IS the end of the interaction.
     */
    if (!opts.silent) rerender();
    return true;
  };

  /**
   * THE SAVE BUTTON CONFIRMS ITSELF.
   *
   * Reported: "there is no way to tell whether it saved." The notice under the row is easy to miss, because the hand
   * that pressed the button is still over it. So the BUTTON is what changes: a tick and a green face for a couple of
   * seconds, with the armed time as its tooltip.
   *
   * The state is held as an expiry timestamp rather than a timeout, so a re-render cannot leave it stuck on - which
   * would make the confirmation lie, and a confirmation that lies is worse than none.
   */
  const saveState = state.basicSavedAt && Date.now() - state.basicSavedAt < 2500 ? 'saved' : 'idle';
  const saveBtn = el('button', {
    class: saveState === 'saved' ? 'primary grow saved' : 'primary grow',
    text: saveState === 'saved' ? t('basic.saved') : t('basic.save'),
    title: saveState === 'saved' && state.basicNotice ? state.basicNotice : '',
    onclick: save,
  });
  if (saveState === 'saved') {
    // return to the normal face on its own, so the button cannot claim a stale save indefinitely
    setTimeout(() => { state.basicSavedAt = null; rerender(); }, 2500 - (Date.now() - state.basicSavedAt));
  }

  wrap.append(el('div', { class: 'row' },
    saveBtn,
    el('button', {
      class: 'grow', text: t('action.runNow'),
      onclick: async () => {
        // THE SAVE HAS TO SUCCEED FIRST: a refused save left the OLD automation in place, and starting it anyway
        // ran something the user was not looking at (bug M5)
        const ok = await save();
        if (!ok) return;
        const res = await send({ type: 'start-run', automationId: BASIC_ID });
        if (!res?.ok) { state.basicError = res?.error ?? 'could not start'; rerender(); }
        else await refresh();
      },
    }),
  ));

  if (state.basicError) wrap.append(el('div', { class: 'preview warn', text: state.basicError }));

  /**
   * WHAT SAVE DID, shown next to the button that did it.
   *
   * This lives here, in the view that OWNS the save, and not in the shared schedule editor where it was first put by
   * mistake: `basicView` sets the notice and never rendered it, so the message existed only as a tooltip. It survives
   * the button's own confirmation reverting, because the button says "the press worked" and this says what the
   * schedule is - two different facts, and the second one is the useful one two seconds later.
   */
  if (state.basicNotice) wrap.append(el('div', { class: 'hint saved-note', text: state.basicNotice }));

  // ---- what will happen, computed by the same scheduler the worker uses
  const previewHost = el('div', { class: 'preview' });
  /**
   * THE PREVIEW IS REFRESHED IN PLACE, WITHOUT REBUILDING THE FORM.
   *
   * The auto-save deliberately does not re-render - a rebuild under the pointer swallows the click, measured twice - but
   * the preview is only built during a render, so after typing a time it kept describing the OLD value.
   * MEASURED (`pick-digits-test`): the field held 08:45:52 while the preview still said "Every day at 09:00".
   *
   * `refreshPreview()` rewrites the text of this block and touches nothing else, so the input keeps its focus, its
   * caret, and the value the user just typed. It is called on every keystroke, which is cheap: two date computations and
   * three text nodes.
   */
  const refreshPreview = () => {
    previewHost.textContent = '';
    // READ AT CALL TIME. A closure captured from an earlier render describes that render's schedule, so after a re-seed
    // the preview lagged one edit behind: the field showed 08:45:52 while this still said 09:00.
    const live = state.basic?.schedule ?? draft.schedule;
    try {
      const label = describeSchedule(live);
      const upcoming = [];
      let cursor = Date.now();
      for (let i = 0; i < 2; i++) {
        const n = nextRun(live, cursor);
        if (n === null) break;
        upcoming.push(n);
        cursor = n;
      }
      previewHost.className = 'preview';
      previewHost.append(el('div', { class: 'preview-label', text: label }));
      for (const t2 of upcoming) {
        previewHost.append(el('div', { class: 'preview-next', text: `next: ${fmtTime(t2)}  (${relTime(t2)})` }));
      }
    } catch (e) {
      previewHost.className = 'preview warn';
      previewHost.append(el('div', { text: `${e.message}` }));
    }
    return previewHost;
  };
  wrap.append(refreshPreview());
  state.basicRefreshPreview = refreshPreview;

  return wrap;
}

/**
 * Normalise the digits a person actually types.
 *
 * WHY: with a Persian keyboard the digits arrive as ۰۱۲۳۴۵۶۷۸۹ (U+06F0..) or, with an Arabic one, as ٠١٢٣٤٥٦٧٨٩
 * (U+0660..). A native `<input type="time">` ignores those, so the user types a time, the field looks changed, and the
 * model is never updated - reported as "when I type with the Persian keyboard the numbers do not change, it has to be
 * English".
 *
 * This is INTERFACE, not data: the digits are a keyboard convention, not a number system the extension should store.
 * Only digit characters are translated, so a malformed time stays malformed and is rejected by the usual validation
 * rather than being silently rewritten into a valid one.
 */
export function normaliseDigits(text) {
  return String(text ?? '')
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/**
 * Normalise the digits a person actually types, then keep only what a time can contain.
 *
 * WHY THIS EXISTS AT ALL, measured rather than assumed:
 *
 *     input.value = '08:45:52'   ->  '08:45:52'
 *     input.value = '۰۸:۴۵:۵۲'   ->  ''          <- the browser DISCARDS it
 *     input.value = '٠٩:٣٠:٠٥'    ->  ''
 *
 * A native `<input type="time">` sets its own value to the empty string when given Persian or Arabic-Indic digits, so
 * the `input` event carried nothing, the model was never updated, and the field looked broken - reported as "when I
 * type with the Persian keyboard the numbers do not change, it has to be English". Nothing downstream can repair a
 * value that is discarded before any handler runs, which is why this is a text field and not a time input.
 *
 * The character filter is part of the fix, not tidiness: a Persian keyboard's `:` sits on a different key, and a stray
 * letter would make the whole value unparseable while looking almost right. Digit translation happens FIRST, so a
 * malformed time stays malformed and is rejected by the normal validation instead of being repaired into a valid one.
 */
/**
 * Every character a keyboard may send where a Western keyboard has `:`.
 *
 * THE BUG THIS FIXES, measured: with a Persian keyboard the separator is not U+003A. It is often U+066B (٫, the Arabic
 * decimal separator), U+066C (٬), U+061B (؛), or a fullwidth U+FF1A - and all of them were being DELETED by the
 * character filter, so `۱۲:۳۰` became `1230`, which is not a time, so the value was rejected in silence and the model
 * kept whatever it had before. That is the whole of "when I type with the Persian keyboard it does not change".
 */
/**
 * Every character that can appear where a Western keyboard has `:`, all of which are simply dropped now.
 *
 * They are dropped rather than read as separators because the separators are structural: the digits are what the user
 * provides, in any script, and the colons are produced by `formatTimeDigits`. A separator character in the input is
 * therefore noise, whether it is an ASCII colon, an Arabic decimal mark, or a fullwidth one.
 */
const TIME_SEPARATORS = /[\u066B\u066C\u061B\uFF1A\uFE55\u05C3\u2236\u002E\u06D4]/g;

/** Just the digits, translated from any script and capped at the six a time can hold. */
export function timeDigits(text) {
  // NINE digits, not six: HHMMSSmmm. The last three are milliseconds, which is what lets a schedule name an instant
  // inside the second - the case that matters for a market open, where the whole request is "act BEFORE the bell".
  return normaliseDigits(text).replace(TIME_SEPARATORS, '').replace(/[^0-9]/g, '').slice(0, 9);
}

/**
 * Format a run of digits as a time: two, then two, then two.
 *
 * This is the whole of "اعداد ساعت رو باید دوتا دوتا بگیره" - and because the colons are DRAWN rather than stored, they
 * also cannot be deleted by accident, which was the first report. A pasted `09:30:05` goes through the same path: the
 * colons are stripped and regenerated in the same places.
 */
export function formatTimeDigits(text) {
  const digits = timeDigits(text);
  const parts = [];
  for (let i = 0; i < digits.length; i += 2) parts.push(digits.slice(i, i + 2));
  if (parts.length <= 3) return parts.join(':');
  // past six digits we are into milliseconds: keep the first three pairs colon-separated and show the rest as a
  // decimal fraction, so "135001500" reads as 13:50:01.500 rather than 13:50:01:50:0
  const [h, m, s, ...rest] = parts;
  return `${h}:${m}:${s}.${rest.join('')}`;
}

/** Kept for the existing callers: the number of parts a value has, which decides minute vs precise. */
export function countTimeParts(text) {
  return formatTimeDigits(text).split(':').filter(Boolean).length;
}

/**
 * Where the caret goes after the value has been re-formatted.
 *
 * Counts how many DIGITS sat before the caret and returns the position after that many digits in the new text, stepping
 * past a separator the formatting inserted there - so the next keystroke lands in the group the user is filling rather
 * than before the colon.
 */
export function caretAfterFormatting(raw, caret, formatted) {
  const rawText = String(raw ?? '');
  const upTo = rawText.slice(0, Math.max(0, Math.min(caret ?? 0, rawText.length)));
  const digitsBefore = timeDigits(upTo).length;
  const out = String(formatted ?? '');
  if (digitsBefore === 0) return 0;

  let seen = 0;
  let i = 0;
  for (; i < out.length; i++) {
    if (/[0-9]/.test(out[i])) {
      seen += 1;
      if (seen === digitsBefore) { i += 1; break; }
    }
  }
  // step past the separator the formatting just inserted, so typing continues in the next group
  if (out[i] === ':' && i < out.length - 1) i += 1;
  return i;
}

/** The position of the caret as a DIGIT index, which is what all the editing operations work in. */
export function caretDigitIndex(raw, caret) {
  const rawText = String(raw ?? '');
  return timeDigits(rawText.slice(0, Math.max(0, Math.min(caret ?? 0, rawText.length)))).length;
}

/**
 * Parse a typed time, and say WHY when it is not one.
 *
 * The reason is the point. Every rejection used to be silent: the field showed the user's text, the model did not
 * change, and nothing anywhere said the time was unusable - so a schedule that had already passed stayed in place and
 * the user waited for a run that was never going to happen. Returning `{ ok: false, error }` lets the panel say it.
 *
 * The rules encode what a time IS, and they are deliberately strict about structure:
 *   - an empty field is not a time (it is an incomplete one, and clearing the field must not schedule midnight)
 *   - a single separator is not a time, and must not silently become 00:00
 *   - a part with more than two digits is a typo, not a number to wrap - `14:144` is rejected, not read as 14:99
 *   - a trailing separator means the next part is still being typed, so the value is incomplete rather than clamped
 *   - `9:00` means MINUTE precision. Seconds are never invented, because inventing them turns a minute-precision
 *     schedule into a precise one, and precise schedules are the ones where whole seconds matter.
 */
/**
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

export function parseTypedTime(text) {
  /**
   * PARSED FROM THE DIGITS, because the grouping is the field's job now.
   *
   * The user provides digits and the field draws the colons, so there is no such thing as a "misplaced separator" to
   * reject - and the two values that used to fail for structural reasons are the ones being reported:
   *
   *     '13'      -> 13:00      two digits mean 13:00, not "incomplete"
   *     '13:5'    -> 13:05      a half-group is padded, because that is what the field displays
   *     '135121'  -> 13:51:21   six digits are grouped two by two
   *
   * What is still refused is a value that cannot be a time at all - an impossible hour or minute, or more digits than
   * a time has - and each refusal carries its name so the panel can say it.
   */
  const digits = timeDigits(text);
  if (digits === '') return { ok: false, error: 'empty' };
  if (digits.length > 9) return { ok: false, error: 'tooManyDigits' };

  /**
   * A PARTIAL GROUP IS PADDED ON THE LEFT, and the direction matters.
   *
   * Measured: with `padEnd`, `'13:5'` read as 13:50 and a lone `'1'` read as hour 10 - both wrong in the same way. A
   * partial group is the START of a group, so it is the leading digit: `'13:5'` is thirteen-oh-five and `'1'` is one
   * o'clock. It is also the only rule that reads a complete and a partial group consistently, which is why `'13'` and
   * `'13:5'` cannot disagree about the hour.
   */
  const h = Number(digits.slice(0, 2).padStart(2, '0'));
  const m = Number(digits.slice(2, 4).padStart(2, '0'));
  const precise = digits.length > 4;
  const s = precise ? Number(digits.slice(4, 6).padStart(2, '0')) : 0;

  /**
   * THE MILLISECONDS. Seven-or-more digits means the user typed a fraction of a second, which is the whole reason this
   * control accepts nine: a market opens at a fixed instant and the request is to act BEFORE it, so the target has to be
   * expressible as 13:50:01.500 rather than snapped to 13:50:01.000.
   *
   * A partial fraction is padded on the RIGHT, unlike the hour, because it is a decimal fraction: '.5' is 500 ms and
   * '.05' is 50 ms. Padding it on the left would read '500' as '005' and turn a half-second lead into five milliseconds.
   */
  const ms = digits.length > 6 ? Number(digits.slice(6, 9).padEnd(3, '0')) : 0;

  if (h > 23) return { ok: false, error: 'hourRange' };
  if (m > 59) return { ok: false, error: 'minuteRange' };
  if (precise && s > 59) return { ok: false, error: 'secondRange' };

  return { ok: true, hour: h, minute: m, second: s, ms, precise: precise || ms > 0 };
}

/**
 * The time field, shared by both views.
 *
 * `dir="ltr"` even in the Persian interface: a time is digits and colons, not Persian prose, and under RTL the sequence
 * `09:00:00` renders as `00:00:90` - which is not cosmetic on a control whose whole job is to be read correctly.
 *
 * It never re-renders on `input`. Rebuilding the view under the typist is what made this control untypeable once
 * already, so the model is written on every keystroke and the view is rebuilt once, when focus leaves.
 */
/**
 * Run something AFTER the interaction that is currently in progress has finished.
 *
 * WHY THIS EXISTS, measured. A blur fires on `mousedown`, which happens BEFORE `mouseup` and `click`. So a handler that
 * re-renders inside blur replaces the element the pointer is already down on, and the click is then delivered to
 * nothing. For the user that is "I type a time, click Add a point, and nothing happens" - the first click after leaving
 * the time field is swallowed. Deferring by one task is not enough: `mouseup` is its own task and lands after a
 * `setTimeout(0)`, so the same thing happens.
 *
 * The honest fix is to wait for the interaction to complete: if a pointer is currently down, the re-render waits for
 * `mouseup`. The timer is the escape hatch for every blur that has no click behind it - Tab, or the window losing focus
 * - so nothing is left un-refreshed.
 */
function afterCurrentInteraction(fn) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    document.removeEventListener('mouseup', run, true);
    fn();
  };
  /**
   * `mouseup` IS ONE EVENT TOO EARLY - THE CLICK COMES AFTER IT.
   *
   * MEASURED (`probe-add-point`): blur the time field, then click "+ Add a point" and the point was NOT added, while a
   * direct DOM click added it. The sequence:
   *
   *   mousedown on the button  -> the field blurs -> this helper waits for mouseup
   *   mouseup                  -> this helper re-renders IMMEDIATELY -> the button under the pointer is replaced
   *   click                    -> dispatched to a node that no longer exists, so the button never hears it
   *
   * The old comment said the deferral existed "so the click that caused this blur can finish", and mouseup was taken to be
   * that point. It is not: `click` is dispatched after `mouseup`. Deferring by one task lets the click be delivered first,
   * which is what the deferral was always for.
   *
   * The timeout stays as the fallback for a blur with no click behind it, so a keyboard-only edit still refreshes.
   */
  document.addEventListener('mouseup', () => setTimeout(run, 0), { capture: true, once: true });
  setTimeout(run, 250);   // a blur with no click behind it must still refresh, and promptly
}

function timeField({ value, placeholder, onCommit, onHint, rerender, onEdit, focusKey = null }) {
  /**
   * A MASKED FIELD. It holds a run of DIGITS; the colons are drawn.
   *
   * The two reports are the same mistake seen twice - the field treated `:` as something the user types:
   *
   *  - "':' نباید پاک بشه ... وقتی اعداد ساعت‌ها رو پاک میکنم اونم پاک میشه" - the colon was stored text, so deleting
   *    digits around it could take it with them, leaving a field holding `13` and looking broken.
   *  - "اعداد ساعت رو باید دوتا دوتا بگیره مثلا ۱۳۵۱۲۱ رو بدم خودش ۱۳:۵۱:۲۱ کنه" - a run of digits should group itself.
   *
   * So the buffer is digits only and the separators are produced by `formatTimeDigits`. A colon cannot be deleted
   * because it is never stored, and grouping is automatic for any script - `۱۳۵۱۲۱`, `135121` and a pasted
   * `13:51:21` all arrive as the same six digits.
   */
  const input = el('input', {
    type: 'text',
    inputmode: 'numeric',
    dir: 'ltr',
    class: 'grow mono time-input',
    /**
     * A STABLE NAME FOR THIS FIELD, so a re-render can put the user back in it.
     *
     * `renderTree()` begins with `root.replaceChildren()`, so every re-render destroys the input the user is typing into
     * and the browser moves focus to the body - measured as `focused: false` after touching anything else in the form.
     * `render()` captures the focused element's key and its caret before the rebuild and restores both afterwards.
     *
     * The key is the OWNING TIME plus the role, not the position in the DOM: adding or removing a row renumbers
     * positions, and a key that moved would put the caret in a different time's field.
     */
    'data-focus-key': focusKey ?? 'basic-time',
    value: formatTimeDigits(value),
    placeholder: placeholder ?? 'HH:MM:SS',
    autocomplete: 'off',
    spellcheck: 'false',
    /**
     * TWELVE, NOT EIGHT.
     *
     * MEASURED (user report, on 1.21.0 but still present in 1.31.0): "باگ اول کمتر از ثانیه نمیذاره انتخاب کنم و
     * نمیتونم میلی ثانیه اضافه کنم" - they could not enter a fraction of a second.
     *
     * `HH:MM:SS` is eight characters and `HH:MM:SS.mmm` is twelve, so with `maxlength: 8` the browser REFUSED the
     * seventh character and the fraction was unreachable by typing. The mask accepts nine DIGITS, which is three more
     * than this attribute allowed.
     *
     * The panel's own tests missed it because they used `keyboard.insertText()`, which sets the value through the
     * `input` event and is not subject to `maxlength` - the same class of blind spot as `element.click()` skipping
     * hit-testing. `probe-maxlength.mjs` types one keystroke at a time, which is what a person does, and it reproduced
     * the refusal immediately.
     */
    maxlength: '12',
    /**
     * Only digits are let through, and the caret is placed in DIGIT space.
     *
     * `beforeinput` is not used because it is not reliably cancelled in every engine; filtering on `input` and
     * re-rendering is uniform, and the caret mapping is what stops it jumping.
     */
    oninput: (e) => {
      const formatted = formatTimeDigits(e.target.value);
      const caret = caretAfterFormatting(e.target.value, e.target.selectionStart, formatted);
      e.target.value = formatted;
      try { e.target.setSelectionRange(caret, caret); } catch { /* not focusable */ }
      onCommit(formatted, { rerender: false });
      if (onHint) onHint(countTimeParts(formatted) > 2);
      // a keystroke IS a change to the form: without this the auto-save was never armed by a typed time, which is the
      // most common edit there is
      if (onEdit) onEdit();
    },
    /**
     * BACKSPACE IS HANDLED IN DIGIT SPACE, and this is the part that has to be explicit.
     *
     * With the colon derived, a caret sitting just after a separator would make plain backspace delete nothing visible -
     * the field would look stuck. So backspace removes the digit BEFORE the caret and re-formats, which is both what the
     * user means and what makes the separator around it disappear correctly.
     */
    onkeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); return; }

      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      const before = e.target.value;
      const start = e.target.selectionStart ?? 0;
      const end = e.target.selectionEnd ?? 0;
      // a selection is just removed; the browser handles it and `input` re-formats
      if (start !== end) return;

      const at = caretDigitIndex(before, start);
      const digits = timeDigits(before);
      let next;
      let nextCaretDigit;
      if (e.key === 'Backspace') {
        if (at === 0) { e.preventDefault(); return; }          // nothing before the caret, and the colon must not go
        next = digits.slice(0, at - 1) + digits.slice(at);
        nextCaretDigit = at - 1;
      } else {
        if (at >= digits.length) { e.preventDefault(); return; }
        next = digits.slice(0, at) + digits.slice(at + 1);
        nextCaretDigit = at;
      }
      e.preventDefault();
      const formatted = formatTimeDigits(next);
      e.target.value = formatted;
      // place the caret after `nextCaretDigit` digits of the NEW text
      let seen = 0;
      let pos = 0;
      while (pos < formatted.length && seen < nextCaretDigit) {
        if (/[0-9]/.test(formatted[pos])) seen += 1;
        pos += 1;
      }
      try { e.target.setSelectionRange(pos, pos); } catch { /* not focusable */ }
      onCommit(formatted, { rerender: false });
      if (onHint) onHint(countTimeParts(formatted) > 2);
    },
    onblur: (e) => {
      const formatted = formatTimeDigits(e.target.value);
      e.target.value = formatted;
      onCommit(formatted, { rerender: false });
      if (onHint) onHint(countTimeParts(formatted) > 2);
      /**
       * The re-render waits for the click that caused this blur to finish.
       *
       * MEASURED: running it inline replaced the element under the pointer before `mouseup`, so the click was delivered
       * to nothing - "I type a time, click Add a point, and nothing happens". Nothing is lost by waiting, because the
       * model was already written above.
       */
      if (onEdit) onEdit();
      afterCurrentInteraction(() => onCommit(formatted, { rerender: true }));
    },
    onchange: (e) => onCommit(formatTimeDigits(e.target.value), { rerender: false }),
    // A paste of '09:30:05' goes through `input`, where the separators are stripped and regenerated in place
    onpaste: () => { /* handled by `input` */ },
  });
  void placeholder; void rerender;
  return input;
}

/** A short description of what a finder points at, for the collapsed row. */
function pickerSummary(finder) {
  const value = finder.selector ?? finder.text ?? finder.id ?? finder.xpath ?? finder.aria ?? finder.placeholder;
  if (!value) return { label: '—', detail: null };
  return { label: String(value).slice(0, 60), detail: finder.strategy };
}

/**
 * A warning when a picked selector depends on an element's POSITION.
 *
 * Why this is shown and not fixed silently: a picker that cannot find an identifying attribute has no better
 * selector to offer, and saying nothing is how a click ends up in the wrong window. Measured: two byte-identical
 * order windows produce different selectors that differ only in `nth-of-type`, and closing the first one redirects a
 * saved click to whatever took its place. There is no selector that survives that - so the user has to know.
 */
function positionalWarning(finder) {
  const sel = finder?.selector;
  if (typeof sel !== 'string' || !sel) return null;
  if (finder.anchored === true) return null;            // anchored: identifies the thing, not its position
  if (!/nth-of-type/.test(sel)) return null;            // no positional step at all
  // is the positional step ABOVE the target rather than inside it? a positional path anywhere is the risk
  return t('finder.positional');
}

function automationsView(rerender) {
  const wrap = el('div');

  wrap.append(el('div', { class: 'row' },
    el('button', {
      class: 'primary grow', text: t('nav.newAutomation'),
      onclick: async () => {
        const a = {
          id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          name: 'New automation',
          steps: [makeStep('click', { finder: { strategy: 'css', selector: '' } })],
          schedule: { kind: 'manual' },
          options: { stepDelayMs: 0, stepRetries: 2, maxRunMs: 30 * 60_000 },
          enabled: true,
          createdAt: Date.now(),
        };
        /**
         * OPENING AN AUTOMATION FOR EDITING TAKES A COPY, always - that is what the editor is: a working copy.
         *
         * `state.editorKeepDraft` is the editor's half of the same rule the simple form already had: a re-render caused
         * by the editor itself (a pick landing, a selector being corrected) must not throw the copy away and rebuild it
         * from storage, because the storage version does not have the pick that is in flight.
         */
        if (!state.editorKeepDraft || state.editing?.id !== a.id) state.editing = JSON.parse(JSON.stringify(a));
        state.editorKeepDraft = false;
        await send({ type: 'save-automation', automation: a });
        await refresh();
      },
    }),
    el('button', {
      class: 'grow', text: t('nav.pickAndRecord'),
      title: t('hint.pickTitleLong'),
      onclick: async () => {
        // no automation is named here: this button is "pick something and see what it is", so there is nothing to record
        // the page AGAINST. The per-step Pick button is the one that teaches an automation where its page is.
        const res = await send({ type: 'pick-element' });
        if (!res.ok) alert(res.error ?? 'could not start the picker');
      },
    }),
  ));

  if (state.activeRun) {
    wrap.append(el('div', { class: 'active-run' },
      el('span', { class: 'pulse' }),
      el('div', { class: 'grow' },
        el('div', { text: `Running: ${state.activeRun.name}` }),
        el('div', { class: 'hint', text: `${state.activeRun.steps ?? 0} steps · started ${relTime(state.activeRun.startedAt)}` }),
      ),
      el('button', {
        class: 'danger', text: t('action.stop'),
        onclick: async () => { await send({ type: 'stop-run' }); await refresh(); },
      }),
    ));
  }

  if (state.automations.length === 0) {
    wrap.append(el('div', { class: 'empty' },
      el('p', { text: t('empty.automations') }),
      el('p', { class: 'hint', text: t('empty.automationsHint') }),
    ));
    return wrap;
  }

  for (const a of state.automations) {
    let nextLabel = '';
    try {
      if (a.schedule && a.schedule.kind !== 'manual' && a.enabled !== false) {
        const n = nextRun(a.schedule, Date.now());
        nextLabel = n ? `next ${relTime(n)}` : 'will not fire again';
      } else {
        nextLabel = a.enabled === false ? 'disabled' : 'manual';
      }
    } catch (e) {
      nextLabel = `schedule error: ${e.message}`;
    }

    wrap.append(el('div', { class: `card ${state.editing?.id === a.id ? 'editing' : ''}` },
      el('div', { class: 'card-head' },
        el('input', {
          type: 'checkbox', checked: a.enabled !== false,
          title: t('action.enableOrDisable'),
          onchange: async (e) => {
            await send({ type: 'save-automation', automation: { ...a, enabled: e.target.checked } });
            await send({ type: 'reschedule' });
            await refresh();
          },
        }),
        el('span', { class: 'name', text: a.name }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'badge', text: `${countSteps(a.steps ?? [])} steps` }),
      ),
      el('div', { class: 'card-meta' },
        el('span', { class: 'sched-label', text: a.schedule ? scheduleLabel(a.schedule) : 'manual' }),
        el('span', { class: 'hint', text: nextLabel }),
      ),
      el('div', { class: 'card-actions' },
        el('button', {
          class: 'primary', text: t('ui.runNow'),
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            const res = await send({ type: 'start-run', automationId: a.id });
            if (!res.ok) alert(res.error ?? 'could not start');
            await refresh();
          },
        }),
        el('button', {
          class: state.editing?.id === a.id ? 'active' : '', text: t('ui.edit'),
          onclick: async () => {
            state.editing = state.editing?.id === a.id ? null : JSON.parse(JSON.stringify(a));
            rerender();
          },
        }),
        el('button', {
          text: t('ui.duplicateGlyph'), title: t('action.duplicate'),
          onclick: async () => { await send({ type: 'duplicate-automation', id: a.id }); await refresh(); },
        }),
        el('button', {
          class: 'danger', text: t('ui.deleteGlyph'), title: t('action.delete'),
          onclick: async () => {
            if (!confirm(`Delete "${a.name}"?`)) return;
            await send({ type: 'delete-automation', id: a.id });
            // THE EDITOR OF A DELETED AUTOMATION IS CLOSED, or it keeps editing something that no longer exists -
            // and saving it would bring it back (the editor's own copy is what is saved, not the stored record).
            if (state.editing?.id === a.id) state.editing = null;
            await refresh();
          },
        }),
      ),
    ));

    if (state.editing?.id === a.id) {
      const ed = state.editing;
      wrap.append(el('div', { class: 'editor' },
        el('div', { class: 'row' },
          el('label', { text: t('field.name') }),
          el('input', {
            class: 'grow', value: ed.name,
            onchange: (e) => { ed.name = e.target.value; },
          }),
        ),
        el('div', { class: 'row' },
          el('label', { text: t('field.sites') }),
          el('input', {
            class: 'grow mono', value: (ed.urls ?? []).join(', '),
            placeholder: t('ph.siteScope'),
            onchange: (e) => { ed.urls = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); },
          }),
        ),
        /**
         * THE PAUSE BETWEEN STEPS.
         *
         * It was in the model and in the options page, but not here - so the one number that decides how fast an
         * automation runs could not be changed for a single automation. Zero means no artificial pause at all.
         */
        el('div', { class: 'row' },
          el('label', { text: t('opt.stepDelay') }),
          el('input', {
            type: 'number', class: 'small', min: '0', max: '60000',
            value: String(ed.options?.stepDelayMs ?? 0),
            onchange: (e) => {
              ed.options = { ...(ed.options ?? {}), stepDelayMs: Math.max(0, Number(e.target.value) || 0) };
            },
          }),
          el('span', { class: 'hint', text: t('opt.stepDelayHint') }),
        ),
        scheduleEditor(rerender),
        el('div', { class: 'sub-label', text: t('field.steps') }),
        stepsEditor(ed.steps, rerender, null),
        el('div', { class: 'row' },
          el('button', {
            class: 'primary grow', text: t('action.save'),
            onclick: async () => {
              const res = await send({ type: 'save-automation', automation: ed });
              if (!res.ok) { alert(res.error ?? 'could not save'); return; }
              await send({ type: 'schedule-one', automationId: ed.id });
              state.editing = null;
              await refresh();
            },
          }),
          el('button', { text: t('action.cancel'), onclick: () => { state.editing = null; rerender(); } }),
        ),
      ));
    }
  }
  return wrap;
}

function dataView(rerender) {
  const wrap = el('div');

  /**
   * BACKUP AND RESTORE, first thing in this tab.
   *
   * Not a convenience: REMOVING AN UNPACKED EXTENSION DELETES ITS STORAGE. The instructions to "remove the old version
   * and install the new one" therefore destroy every automation and schedule, and a schedule saved before a reinstall
   * is gone before it can fire. That is what happened on the machine this was reported from - an export showed no
   * automations, no alarms and no events at all - and no amount of accuracy elsewhere recovers from it.
   */
  wrap.append(el('h3', { text: t('backup.title') }));
  wrap.append(el('div', { class: 'hint', text: t('backup.why') }));

  const backupRow = el('div', { class: 'row' });
  backupRow.append(el('button', {
    class: 'primary grow', text: t('backup.export'),
    onclick: async () => {
      const res = await send({ type: 'export-all' });
      if (!res?.ok) { alert(String(res?.error ?? 'export failed')); return; }
      const n = (res.document?.automations ?? []).length;
      downloadText(JSON.stringify(res.document, null, 2),
        `autoflow-backup-${new Date().toISOString().slice(0, 10)}.json`);
      state.backupNote = t('backup.exported').replace('{n}', String(n));
      rerender();
    },
  }));
  backupRow.append(el('label', {
    class: 'grow', text: t('backup.import'), style: 'text-align:center;cursor:pointer',
  }, el('input', {
    type: 'file', accept: '.json,.txt', style: 'display:none',
    onchange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const doc = JSON.parse(await file.text());
        const count = (doc?.automations ?? []).length;
        /**
         * CONFIRM, because `replace` clears what is there. The count is stated so the user knows what the file holds
         * before it overwrites anything - and a backup is offered first, which is the only way back.
         */
        if (!confirm(t('backup.confirm').replace('{n}', String(count)))) return;
        const res = await send({ type: 'import-all', document: doc, replace: true, allowScripts: false });
        if (!res?.ok) { alert(String(res?.error ?? 'import failed')); return; }
        state.backupNote = t('backup.imported')
          .replace('{n}', String(res.imported ?? count))
          .replace('{armed}', String(res.rearmed ?? '?'));
        await refresh();
        rerender();
      } catch (err) {
        alert(`${t('backup.badFile')}: ${err.message}`);
      }
    },
  })));
  wrap.append(backupRow);
  if (state.backupNote) wrap.append(el('div', { class: 'hint', text: state.backupNote }));
  wrap.append(el('div', { class: 'hint', text: t('backup.warning') }));
  wrap.append(el('hr'));

  wrap.append(el('div', { class: 'row' },
    el('label', { text: t('data.csvFile') }),
    el('input', {
      type: 'file', accept: '.csv,.tsv,.txt',
      onchange: async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const text = await file.text();
        try {
          const parsed = readCsv(text);
          state.csv = parsed;
          const key = `csv-${Date.now()}`;
          state.dataKey = key;
          await send({ type: 'store-data-rows', key, rows: parsed.rows });
          rerender();
        } catch (err) {
          alert(`Could not read that file: ${err.message}`);
        }
      },
    }),
  ));

  if (state.csv) {
    wrap.append(el('div', { class: 'hint', text: `${state.csv.rows.length} rows · ${state.csv.columns.length} columns` }));
    const table = el('table', { class: 'preview-table' });
    table.append(el('tr', {}, ...state.csv.columns.map((c) => el('th', { text: c }))));
    for (const r of state.csv.rows.slice(0, 8)) {
      table.append(el('tr', {}, ...state.csv.columns.map((c) => el('td', { text: String(r[c] ?? '') }))));
    }
    wrap.append(table);
    if (state.csv.rows.length > 8) {
      wrap.append(el('div', { class: 'hint', text: `…and ${state.csv.rows.length - 8} more` }));
    }
    wrap.append(el('div', { class: 'hint', text: t('data.usage') }));
  } else {
    wrap.append(el('div', { class: 'empty' }, el('p', { class: 'hint', text: t('data.explainer') })));
  }
  return wrap;
}

function scheduledView() {
  const wrap = el('div');
  const items = state.automations
    .filter((a) => a.schedule && a.schedule.kind !== 'manual')
    .map((a) => {
      let next = null;
      let error = null;
      try {
        next = a.enabled === false ? null : nextRun(a.schedule, Date.now());
      } catch (e) {
        error = e.message;
      }
      return { a, next, error };
    })
    .sort((x, y) => (x.next ?? Infinity) - (y.next ?? Infinity));

  if (items.length === 0) {
    wrap.append(el('div', { class: 'empty' }, el('p', { class: 'hint', text: t('schedule.empty') })));
    return wrap;
  }

  for (const { a, next, error } of items) {
    wrap.append(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('span', { class: 'name', text: a.name }),
        el('span', { class: 'spacer' }),
        el('span', { class: `badge ${error ? 'bad' : a.enabled === false ? 'off' : 'ok'}`,
          text: error ? 'error' : a.enabled === false ? 'off' : next ? 'armed' : 'idle' }),
      ),
      el('div', { class: 'card-meta' }, el('span', { class: 'sched-label', text: scheduleLabel(a.schedule) })),
      error
        ? el('div', { class: 'hint warn', text: error })
        : el('div', { class: 'hint', text: next ? `${fmtTime(next)} · ${relTime(next)}` : 'no future occurrence' }),
    ));
  }
  return wrap;
}

/**
 * The log tab: what the extension decided, and a way to hand it over.
 *
 * It exists because a click that did not happen left no evidence. An alarm that never fired, one that fired but
 * found the slot busy, and one whose step failed all looked the same from the run list - and the first of those
 * recorded nothing at all. This shows the decisions in order and exports everything as one text file.
 */
function logView(rerender) {
  const wrap = el('div', { class: 'view log-view' });
  const out = state.diagText ?? null;

  wrap.append(el('p', { class: 'hint', text: t('log.intro') }));

  wrap.append(el('div', { class: 'row' },
    el('button', {
      class: 'primary', text: t('log.export'),
      onclick: async () => {
        // ask the open page for its own click log first, so the file has both sides of the story
        const pageLogs = await collectPageLogs();
        const res = await send({ type: 'export-diagnostics', pageLogs });
        if (!res?.ok) { state.diagText = `export failed: ${res?.error ?? 'unknown'}`; render(); return; }
        state.diagText = res.text;
        downloadText(res.text, `autoflow-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
        render();
      },
    }),
    el('button', {
      text: t('log.copy'),
      onclick: async () => {
        const pageLogs = await collectPageLogs();
        const res = await send({ type: 'export-diagnostics', pageLogs });
        if (res?.ok) { await copyText(res.text); state.diagText = res.text; render(); }
      },
    }),
    el('button', {
      text: t('log.clear'),
      onclick: async () => {
        await send({ type: 'clear-diagnostics' });
        state.diagText = null;
        render();
      },
    }),
  ));

  if (out) {
    // the text is shown as text: it is evidence, and it must not be rendered as markup
    wrap.append(el('pre', { class: 'diag-out', text: out.slice(0, 20_000) }));
  } else {
    wrap.append(el('p', { class: 'empty', text: t('log.empty') }));
  }
  return wrap;
}

/**
 * Ask every open tab that has the content script for its click log.
 *
 * Silently tolerates tabs that cannot answer: a tab without the content script, or a closed one, must not make the
 * export fail.
 */
async function collectPageLogs() {
  try {
    const tabs = await send({ type: 'list-runnable-tabs' });
    const logs = [];
    for (const tab of tabs?.tabs ?? []) {
      try {
        const res = await send({ type: 'page-log', tabId: tab.id });
        if (res?.ok && (res.clicks ?? []).length) logs.push({ url: tab.url, clicks: res.clicks });
      } catch { /* this tab cannot answer; the export must not fail because of it */ }
    }
    return logs;
  } catch {
    return [];
  }
}

/** Save text as a download. Uses a blob URL, which the browser revokes when the object goes out of scope. */
function downloadText(text, filename) {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch { /* if the download is blocked the text is still on screen to copy */ }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch { /* clipboard may be denied; the text is on screen */ }
}

function historyView() {
  const wrap = el('div');
  if (!state.runs.length) {
    wrap.append(el('div', { class: 'empty' }, el('p', { class: 'hint', text: t('empty.runs') })));
    return wrap;
  }
  wrap.append(el('div', { class: 'row' },
    el('span', { class: 'grow hint', text: `${state.runs.length} recent runs` }),
    el('button', { text: t('action.clear'), onclick: async () => { await send({ type: 'clear-runs' }); await refresh(); } }),
  ));
  for (const r of state.runs.slice(0, 40)) {
    const bad = r.reason !== 'finished';
    wrap.append(el('div', { class: `card run ${bad ? 'bad' : ''}` },
      el('div', { class: 'card-head' },
        el('span', { class: 'name', text: r.name ?? '(unknown)' }),
        el('span', { class: 'spacer' }),
        el('span', {
          class: `badge ${bad ? 'bad' : 'ok'}`,
          // REASON_LABEL now holds keys, so the lookup goes through the translator; a reason with no entry
          // falls back to the raw reason rather than to a blank badge
          text: REASON_LABEL[r.reason] ? t(REASON_LABEL[r.reason]) : r.reason,
        }),
      ),
      el('div', { class: 'card-meta' },
        el('span', { class: 'hint', text: `${fmtTime(r.finishedAt)} · ${r.steps ?? 0} steps · ${Math.round((r.elapsedMs ?? 0) / 1000)}s · ${r.trigger ?? 'manual'}` }),
      ),
      r.error ? el('div', { class: 'hint warn', text: `step ${r.error.stepId ?? '?'}: ${r.error.message}` }) : null,
      r.trace?.length
        ? el('details', {},
            el('summary', { text: `${r.trace.length} trace entries` }),
            el('pre', { class: 'trace', text: r.trace.map((entry) =>
              `+${String(entry.at).padStart(6)}ms  ${entry.type}${entry.kind ? ` ${entry.kind}` : ''}${entry.message ? ` — ${entry.message}` : ''}`).join('\n') }),
          )
        : null,
    ));
  }
  return wrap;
}

// ---------------------------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------------------------

/**
 * RENDER IS NOT RE-ENTRANT, and it has to be told so.
 *
 * MEASURED FAILURE, from a real session:
 *
 *     NotFoundError: Failed to execute 'replaceChildren' on 'Element': The node to be removed is no longer a child of
 *     this node. Perhaps it was moved in a 'blur' event handler?
 *
 * `replaceChildren()` removes the current children one by one, and removing a FOCUSED element fires `blur`. The blur
 * handler commits the value and asks for a re-render, which runs `replaceChildren()` again on the same parent - so the
 * outer removal loop then tries to detach nodes the inner render already moved, and throws. The panel was left in a
 * half-built state.
 *
 * The fix is the standard one: a render in progress cannot be re-entered. A nested request is remembered and honoured
 * ONCE after the current tree is complete, which is what the caller actually wants - the state it changed is picked up
 * either way, and the DOM is never mutated by two builds at the same time.
 */
let renderInProgress = false;
let renderRequested = false;

/**
 * WHICH CONTROL THE USER WAS IN, AND WHERE IN IT.
 *
 * MEASURED (`probe-time-typing`): typing a time and then touching anything else in the form left the field with
 * `focused: false` and the caret gone, because `renderTree()` starts with `root.replaceChildren()` - every node is
 * thrown away and rebuilt, so the element the user was typing into no longer exists. The report:
 *
 *     «وقتی دارم ساعت تنظیم میکنم بخاطر اوتسیو هی منو از تنظیم ساعت میندازه بیرون و باید به سختی و سریع ساعت رو تنظیم کنم»
 *
 * A re-render is unavoidable here (the form has to show the point that was added), so what the form owes the user is its
 * PLACE: after the rebuild, the same field is focused again and the caret is where it was. The field is identified by a
 * stable key rather than by position, because adding or removing a row changes positions.
 */
let focusMemory = null;

/**
 * THE FIELD THE USER WAS LAST IN, remembered across the blur the browser performs.
 *
 * MEASURED (`probe-focus-key`): clicking "+ Add a point" while the caret sat in the time field left
 * `document.activeElement === BODY`, and a capture taken inside the click handler therefore had NOTHING to restore. The
 * browser moves focus on `mousedown`, before any handler runs - so by the time the form re-renders, the field is already
 * forgotten by the DOM. Remembering it on `focusin` is what makes a restore possible at all.
 */
let lastFocusedField = null;

/**
 * IS THE POINTER DOWN RIGHT NOW?
 *
 * MEASURED (`probe-add-point`): with the focus restore in place, clicking "+ Add a point" stopped adding a point - the
 * button was under the pointer at the moment of the click and gone by the time the click was delivered. The sequence:
 *
 *   mousedown on the button -> blur on the time field -> the form re-renders (blur commits, as designed)
 *   -> restoreFocus puts focus BACK in the time field -> that focus change triggers another build
 *   -> the button is replaced before `mouseup`, so the click lands on nothing
 *
 * A person pressing a control is not asking to be returned to the field they were in: they are moving on. So while the
 * pointer is down the restore stands aside, and the control under the finger survives long enough to be pressed.
 */
let pointerIsDown = false;
document.addEventListener('pointerdown', () => { pointerIsDown = true; }, true);
document.addEventListener('pointerup', () => {
  // cleared on the next frame, because the click event is delivered after pointerup and handlers run before it settles
  setTimeout(() => { pointerIsDown = false; }, 0);
}, true);
document.addEventListener('pointercancel', () => { pointerIsDown = false; }, true);

function fieldSignature(el) {
  if (!el) return null;
  const key = el.dataset?.focusKey;
  if (!key) return null;
  let caret = null;
  let selectionEnd = null;
  try {
    caret = el.selectionStart;
    selectionEnd = el.selectionEnd;
  } catch { /* not a text field */ }
  return { key, caret, selectionEnd };
}

document.addEventListener('focusin', (e) => {
  const sig = fieldSignature(e.target);
  if (sig) lastFocusedField = sig;
}, true);

/**
 * AND THE CARET IS UPDATED AS IT MOVES, not only when the field is first entered.
 *
 * MEASURED (`time-typing-test`): the remembered field held `caret: 0` - the position it had at `focusin` - while the user
 * had typed nine digits and was sitting at the end. Restoring that memory put the caret back at the START of the value, so
 * continuing to type would have inserted at the beginning of the time. `selectionchange` and `input` both fire as the caret
 * travels, and recording both is what makes the memory current rather than merely initial.
 */
const rememberCaret = (e) => {
  const sig = fieldSignature(e.target ?? document.activeElement);
  if (sig) lastFocusedField = sig;
};
document.addEventListener('selectionchange', () => rememberCaret({ target: document.activeElement }));
document.addEventListener('input', rememberCaret, true);

/**
 * WHERE THE USER WAS, as of the moment a render is asked for.
 *
 * The live element wins when it is still focused; otherwise the remembered field is used, but ONLY when focus is sitting
 * on `body` - which is what our own button click leaves behind. If the user has focused something else (a different
 * field, an input elsewhere in the panel) that choice is left alone.
 */
function captureFocus() {
  const live = fieldSignature(document.activeElement);
  if (live) return live;
  /**
   * A BUTTON TAKING FOCUS IS NOT THE USER LEAVING THE FIELD.
   *
   * MEASURED (`probe-focus-key`, instrumented): the click on "+ Add a point" focuses the BUTTON, so `activeElement` was
   * neither the time field nor `body` - and a rule that only trusted the remembered field on `body` returned null while
   * `lastFocusedField` sat there holding `basic-time:basic` with its caret. The restore then had nothing to restore.
   *
   * What actually means "the user moved on" is arriving at a DIFFERENT editable field. Anything else - a button, a
   * checkbox, the page body - leaves the remembered field as the place the user was typing.
   */
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) return lastFocusedField;
  const tag = active.tagName;
  const editable = (tag === 'INPUT' && !/^(button|submit|checkbox|radio|file|range|color)$/i.test(active.type ?? ''))
    || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable === true;
  if (!editable) return lastFocusedField;
  // a different editable field is the user's choice, and it is not ours to override
  return null;
}

function restoreFocus(memory) {
  if (!memory) return;
  // a pointer that is down means the user is pressing something; see `pointerIsDown`
  if (pointerIsDown) return;
  const target = document.querySelector(`[data-focus-key="${String(memory.key).replace(/"/g, '\\"')}"]`);
  if (!target) return;
  try { target.focus({ preventScroll: true }); } catch { return; }
  /**
   * THE CARET IS SET ON THE NEXT FRAME, AND VERIFIED.
   *
   * MEASURED (`time-typing-test`): the field was focused and held the right value, but `selectionStart` was 0 - so the
   * next keystroke landed at the START of "10:32:33.250" instead of after it. `setSelectionRange` clamps to 0 when it runs
   * on an element the layout has not placed yet, and the node had just been created in the same tick.
   *
   * One frame later the element is in the layout, so the range takes. It is then read back: if it still did not take, the
   * caret is put at the END rather than left at zero, because the field is a left-to-right digit mask where continuing to
   * type at the end is what the user means.
   */
  const applyCaret = () => {
    if (memory.caret === null) return;
    const want = memory.caret;
    try { target.setSelectionRange(want, memory.selectionEnd ?? want); } catch { /* not selectable */ }
    let got = null;
    try { got = target.selectionStart; } catch { got = null; }
    if (got !== want) {
      const end = String(target.value ?? '').length;
      try { target.setSelectionRange(end, end); } catch { /* not selectable */ }
    }
  };
  applyCaret();
  if (typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => {
    applyCaret();
    /**
     * AND IT IS RE-ASSERTED ON THE NEXT FRAME, because the browser can take focus away AFTER the rebuild.
     *
     * MEASURED (`time-typing-test`, roughly one run in three): the field was focused, and a moment later focus was back on
     * `body`. The button that was clicked is REMOVED by the re-render, and when the browser finishes processing that click
     * it moves focus off a node that no longer exists - after the synchronous restore has already run. A single restore
     * therefore loses a race it cannot see.
     *
     * It is re-asserted only while nothing has changed: the remembered field is still the one we captured, and the user has
     * not arrived at a different editable field. If they have, their choice stands and this does nothing.
     */
    const active = document.activeElement;
    const away = !active || active === document.body || active === document.documentElement;
    if (!away) return;
    if (lastFocusedField?.key !== memory.key) return;    // the user moved on; leave them there
    try { target.focus({ preventScroll: true }); } catch { return; }
    applyCaret();
  });
}

function render() {
  if (renderInProgress) {
    // do NOT re-enter: the current build is halfway through removing the previous nodes
    renderRequested = true;
    return;
  }
  bodyKeptDraftForFollowUp = false;   // reset per sequence, or one kept draft would pin every later render
  focusMemory = captureFocus();
  renderInProgress = true;
  try {
    renderTree();
  } finally {
    renderInProgress = false;
  }
  restoreFocus(focusMemory);
  /**
   * Honour a nested request, but not unboundedly.
   *
   * One follow-up is enough for the blur case, and the cap exists so a pathological focus/blur cycle cannot spin - an
   * unbounded re-render loop would be worse than the crash it replaced.
   */
  /**
   * THE FORM'S WORKING COPY MUST SURVIVE THE FOLLOW-UP BUILDS.
   *
   * `state.basicKeepDraft` is consumed at the START of a render, so a second build in the same sequence reads it as
   * false and rebuilds the draft from storage - which discarded a point that had just been added, measured as
   * "+ adds a point" failing with the count still at 1.
   *
   * MEASURED ORDERING MISTAKE, worth stating because the first version of this fix got it wrong: the flag was restored
   * AFTER the loop, so the follow-up builds ran while it was false and destroyed the draft, and the restore then had
   * nothing left to protect. The intent of the flag is "the form changed itself, keep what it produced", and that holds
   * for every build triggered by that change, so it is put back BEFORE each one.
   */
  for (let i = 0; i < 3 && renderRequested; i++) {
    renderRequested = false;
    if (bodyKeptDraftForFollowUp) state.basicKeepDraft = true;
    // the memory is kept for the follow-up builds too: the first build's own re-render is a new tree without the focused
    // node, so restoring only after the first build would leave the user out of the field again
    if (!focusMemory) focusMemory = captureFocus();
    renderInProgress = true;
    try {
      renderTree();
    } finally {
      renderInProgress = false;
    }
    restoreFocus(focusMemory);
  }
  renderRequested = false;
}

/**
 * Set when a render's own view asked for the draft to be preserved.
 *
 * `basicView` consumes `state.basicKeepDraft` and then clears it; this records that it WAS set, so a follow-up build in
 * the same sequence can restore it rather than throwing the form's changes away.
 */
let bodyKeptDraftForFollowUp = false;

function renderTree() {
  const root = document.getElementById('root');
  const rerender = () => render();
  root.replaceChildren();

  root.append(el('header', { class: 'app-head' },
    el('span', { class: 'logo', text: t('ui.panelGlyph') }),
    el('span', { class: 'title', text: t('app.name') }),
    el('span', { class: 'spacer' }),
    el('button', {
      class: 'icon', title: t('nav.options'),
      text: t('ui.gearGlyph'),
      onclick: () => api.runtime.openOptionsPage(),
    }),
  ));

  const nav = el('nav', { class: 'tabs' });
  // 'basic' sits beside 'automations' and is the same data with the fields a timed click actually needs, so a
  // simple job never has to meet the full step editor
  for (const [id, key] of TAB_LIST) {
    nav.append(el('button', {
      class: state.tab === id ? 'active' : '',
      text: t(key),
      onclick: () => {
        /**
         * Moving to another tab discards the form's working copy, so coming back shows what is actually saved.
         *
         * `basicEvents` IS A SECOND WORKING COPY and has to be invalidated with the first. MEASURED (1.30 dev,
         * `ui-basic-test`): the test adds a point to force a re-render, leaves the Basic tab and returns expecting a
         * clean form - and got two points, because the events survived the trip. That is the same
         * "duplicate points that cannot be removed" fault this form already had once, in its other working copy.
         */
        if (id !== 'basic') {
          state.basicStale = true;
          state.basicEventsStale = true;
          state.basicOpen = null;
        }
        /**
         * A REMOVED TAB MUST NOT BE ENTERABLE. The nav only offers the tabs in TAB_LIST, but a stale `state.tab`
         * survives in the panel's own memory and a saved reference could still name one - and in lite that would
         * render an empty body with no explanation. Refusing the switch is the honest outcome.
         */
        if (__LITE__ && id !== 'basic') return;
        state.tab = id;
        render();
      },
    }));
  }
  root.append(nav);

  /**
   * A NOTICE THAT BELONGS TO NO TAB.
   *
   * MEASURED: a pick from the header's "Inspect element" button found no point waiting, and the explanation went into
   * `state.basicError` - which is only rendered inside the Basic tab. Pressed from any other tab, the pick vanished with
   * no word at all, which is the complaint this whole thread is about. A refusal has to be visible where the user is.
   */
  if (state.panelNotice) {
    const notice = el('div', { class: 'preview warn', text: state.panelNotice });
    notice.append(el('button', {
      class: 'icon', text: t('ui.close'), title: t('action.dismiss'),
      onclick: () => { state.panelNotice = null; render(); },
    }));
    root.append(notice);
  }

  const body = el('main');
  if (state.tab === 'basic') body.append(basicView(rerender));
  /**
   * THE FULL-TREE BRANCH IS UNREACHABLE IN A LITE BUILD, which is what makes the removal real rather than
   * cosmetic: esbuild folds `!__LITE__` to `false` and then has no reference to these five functions from
   * anywhere, so it drops them and their private helpers.
   *
   * `body.empty()`-style fallbacks are deliberately NOT used: a lite build cannot have a second tab to fall
   * back to, and adding one would keep a reference alive and defeat the elimination.
   */
  else if (!__LITE__) {
    if (state.tab === 'automations') body.append(automationsView(rerender));
    else if (state.tab === 'scheduled') body.append(scheduledView());
    else if (state.tab === 'data') body.append(dataView(rerender));
    else if (state.tab === 'log') body.append(logView(rerender));
    else body.append(historyView());
  }
  root.append(body);

  // A pick that lands anywhere gets applied to the step waiting for it.
  if (state.pickTarget) {
    root.append(el('div', { class: 'picking-banner' },
      el('span', { text: t('hint.picking') }),
      el('button', {
        text: t('action.cancel'),
        onclick: async () => { state.pickTarget = null; await send({ type: 'cancel-picking' }); render(); },
      }),
    ));
  }
}

// ---------------------------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------------------------

/**
 * A tiny ring of what the pick listener saw, readable from the page for a test and for a bug report.
 *
 * The fault it exists for: a pick arrives for a step id that no longer exists, the listener finds nothing, and the user
 * sees "nothing happened". Nothing else in the extension can observe that moment.
 */
globalThis.__pickDebug = [];
function recordPickDebug(entry) {
  try {
    globalThis.__pickDebug.push({ at: Date.now(), ...entry });
    if (globalThis.__pickDebug.length > 20) globalThis.__pickDebug.shift();
  } catch { /* diagnostics must never break a pick */ }
}

api.runtime.onMessage.addListener((msg) => {
  /**
   * A PICK MUST NEVER BE DISCARDED IN SILENCE.
   *
   * MEASURED (user's export, 1.21.0): `automations stored: 0`, `events: 0`, while `lastPickPages` held the page - so a pick
   * had landed and been recorded, and no automation was ever saved because the steps still had no selector. The panel's
   * Save refuses before sending anything when no step has a selector, which is why the export showed no save ATTEMPT.
   *
   * The cause is this listener: it read `element-picked` only when `state.pickTarget` was set. That is null in two
   * perfectly ordinary situations - the header's "Pick & record" button never sets it, and any render after a pick clears
   * it - so the pick's selector was thrown away and nothing said so.
   */
  if (msg?.type === 'element-picked') {
    /**
     * THE SAME PICK MAY ARRIVE MORE THAN ONCE, AND THE SECOND COPY IS NOT NEWS.
     *
     * MEASURED (user report, 1.23.0): one click, two deliveries - the content script's broadcast and the worker's forward
     * of it. The first copy found the step and consumed `state.pickTarget`; the second found nothing and printed "but no
     * point was waiting for it". The selector had landed, which is why it "still worked" - the message was noise.
     *
     * Fixing the sender removes the duplicate; this keeps the panel honest if any other path ever produces one, because
     * a false complaint is worse than no complaint: it teaches the user to ignore the message that matters.
     */
    const alreadySettled = state.pickSavedFor && state.pickSavedAt
      && Date.now() - state.pickSavedAt < 1500;
    if (alreadySettled && state.pickTarget === null) {
      recordPickDebug({ event: 'ignored-duplicate', tab: state.tab });
      return;
    }
    const find = (list) => {
      for (const s of list) {
        if (s.id === state.pickTarget) return s;
        for (const key of ['steps', 'then', 'else']) {
          if (Array.isArray(s[key])) {
            const hit = find(s[key]);
            if (hit) return hit;
          }
        }
      }
      return null;
    };
    // the pick may belong to the full editor or to the simple view; whichever holds that step gets it
    const inEditing = state.editing ? find(state.editing.steps) : null;
    /**
     * THE BASIC FORM'S POINTS LIVE IN THE EVENTS NOW, not in `state.basic.steps`.
     *
     * MEASURED (1.30 dev): with several times, each event holds its own step list, so the old lookup searched a list
     * that is no longer where the panel keeps its points. A pick arrived, `find(...)` returned null, and the selector
     * input stayed empty while the time survived - caught by `time-survives-pick-test` as
     * "the selector arrived as well, so the fix did not trade one for the other".
     *
     * Both shapes are searched: `state.basic.steps` is still correct for a draft built by the old path, and the events
     * are where the points are once the form has rendered.
     */
    const findBasic = () => {
      /**
       * THE EVENTS COME FIRST, and the order is the whole fix.
       *
       * MEASURED (1.30 dev): with the events rendered, `state.basic.steps` still exists and still holds a step with the
       * SAME id - `basic-point-1` - because the draft was built from the saved record before the events took over. So
       * searching it first returned an object that is no longer rendered, the finder was written to that orphan, and the
       * selector input stayed empty while `__pickDebug` reported `found: true`. The pick was applied; it was applied to
       * the wrong copy.
       *
       * `state.basic.steps` remains the fallback, for a draft built by the old single-time path before any render has
       * produced events.
       */
      for (const ev of state.basicEvents ?? []) {
        const hit = (ev.steps ?? []).find((s) => s.id === state.pickTarget);
        if (hit) return hit;
      }
      return (state.basic?.steps ?? []).find((s) => s.id === state.pickTarget) ?? null;
    };
    const inBasic = state.basic ? findBasic() : null;
    /**
     * LEFT IN PLACE ON PURPOSE: this is the diagnostic that found the lost id.
     *
     * A pick arriving for a step that no longer exists is a silent failure the user experiences as "nothing happened", and
     * the only way to see it is to record what the listener actually received. It costs one line per pick.
     */
    recordPickDebug({
      pickTarget: state.pickTarget,
      tab: state.tab,
      hasEditing: Boolean(state.editing),
      basicSteps: [
        ...(state.basic?.steps ?? []).map((s) => s.id),
        ...(state.basicEvents ?? []).flatMap((e) => (e.steps ?? []).map((s) => `${e.id}/${s.id}`)),
      ],
      editingSteps: (state.editing?.steps ?? []).map((s) => s.id),
      found: Boolean(inEditing ?? inBasic),
    });
    const step = inEditing ?? inBasic ?? null;
    if (step) {
      step.finder = msg.finder;
      /**
       * OUTSIDE THE DRAFT AS WELL. The draft is rebuilt from storage on renders that do not keep it, and then the finder
       * is gone while the button still claims "✓ Picked" - measured, with the selector input empty underneath.
       */
      rememberFinder(step.id, msg.finder);
      /**
       * REMEMBER WHICH PAGE THIS CAME FROM.
       *
       * A Basic automation's form never asks for a URL, so a scheduled run had no page to go to and refused to run
       * ("no URL pattern, so a scheduled run has no safe tab" - the user's export, 1.19.0). The page is known right
       * here: the user is looking at it, and the pick came from it. The worker stores it per automation and uses it only
       * when nothing better is known.
       *
       * `msg.url` is supplied by the content script; when it is absent the panel asks the worker for the tab it picked
       * in, so an older content script cannot silently drop the record.
       */
      /**
       * THE PAGE IS REMEMBERED FOR THE TIME THE POINT BELONGS TO, NOT FOR THE FIRST ONE.
       *
       * MEASURED (your log, 1.34.0): "سه تا زمان هرکدوم سه تا pick فقط زمان اولیه pickهاش فعال شد". One time ran; the other
       * two refused with
       *
       *     "this automation has never had an element picked in it, so a scheduled run has no page"
       *
       * and `lastPickPages` held a single entry, `basic`. The cause was here: the page was attached to
       * `inBasic ? state.basic : state.editing`, and `state.basic.id` is ALWAYS `basic` - so every pick, whichever time
       * it was made in, filed the page under the first record. Times two and three were stored with their points but with
       * no page of their own, so a scheduled run had nowhere to go.
       *
       * `eventsToStore` turns each time into its own automation, so each needs its own remembered page. The owner is the
       * event whose step list contains the step that was picked.
       */
      let target = null;
      if (inBasic) {
        const owner = (state.basicEvents ?? []).find((ev) => (ev.steps ?? []).some((s) => s === step || s.id === step.id));
        target = { id: owner?.id ?? state.basic?.id ?? BASIC_ID };
      } else {
        target = state.editing;
      }
      if (target?.id) {
        const pageUrl = msg.url ?? state.pickPageUrl ?? null;
        if (typeof pageUrl === 'string') {
          send({ type: 'remember-pick-page', automationId: target.id, url: pageUrl }).catch(() => {});
        }
      }
      state.pickTarget = null;
      /**
       * The confirmation, and its expiry, both start HERE.
       *
       * `pickSavedAt` drives a green ticks for 2.5s. The countdown belongs to the moment the pick landed - not to a
       * render - because a timer owned by a button that a later render discards simply does not run, and the button
       * stayed green indefinitely as a result. Measured: still "✓ Picked" after six seconds.
       */
      /**
       * NO TIMER. The confirmation is a STATE, cleared by the next action.
       *
       * Four attempts to expire it on a timer failed in four different ways, because the timer belongs to a button that
       * the next render throws away. `pickSavedAt` is now cleared by the next thing the user does - pressing Pick again,
       * editing the selector, or saving - which is deterministic and needs no cooperation from the render cycle.
       *
       * It also reads better: "✓ Picked" means "this point's selector came from a pick", which stays true until it is
       * no longer true. A green flash that vanishes while the user is still looking at it says less.
       */
      state.pickSavedAt = Date.now();
      // WHICH point this confirmation belongs to. Without it the confirmation is global and every Pick button claims it.
      state.pickSavedFor = step.id;
      // a pick landing in the simple view is form work: keep the draft so the point it was picked for survives
      if (state.tab === 'basic') state.basicKeepDraft = true;
      /**
       * A PICK IS AN EDIT, SO IT ARMS THE AUTO-SAVE TOO.
       *
       * MEASURED (`second-pick-test`): two points picked, the form correct, and `diagnosticEvents` EMPTY - no save was
       * ever requested, because this path sets `basicKeepDraft` and calls `render()` directly instead of going through
       * `keepDraftThen`, which is where the auto-save was armed. So a form built entirely out of picks was never saved,
       * and the next render rebuilt it from a storage that held nothing: "the second pick disappears".
       *
       * `basicAutoSave` is stashed on `state` by the view, because this listener lives outside `basicView`'s closure.
       */
      if (state.tab === 'basic' && typeof state.basicAutoSave === 'function') state.basicAutoSave();
      render();
    } else {
      /**
       * NO STEP CLAIMED IT - SO CLAIM IT FOR THE OBVIOUS ONE.
       *
       * MEASURED (user report, 1.22.0): every pick produced "That pick found ... but no point was waiting for it".
       * The message was accurate and useless: the selector was known, the form on screen had exactly one point, and
       * refusing to fill it is not caution - it makes the feature not work.
       *
       * The order of preference, each step defensible on its own:
       *   1. the point whose Pick button was pressed last (`pickTarget`), whenever it still exists;
       *   2. otherwise the ONLY point in the visible form - with one point there is nothing to be ambiguous about;
       *   3. otherwise, and only then, say the pick has nowhere to go.
       *
       * Steps 1 and 2 keep the report's own words ("press Pick next to the point you want it on") true: they fill the
       * point the user indicated, and never guess between two.
       */
      const steps = state.tab === 'basic' ? (state.basic?.steps ?? []) : (state.editing?.steps ?? []);
      const single = steps.length === 1 ? steps[0] : null;
      if (single) {
        single.finder = msg.finder;
        rememberFinder(single.id, msg.finder);
        /**
         * THE PAGE IS REMEMBERED, EVEN FOR AN ADOPTED PICK.
         *
         * A Basic automation's form never asks for a URL, so a scheduled run had no page to go to and refused to run
         * ("no URL pattern, so a scheduled run has no safe tab"). The page is known here - the pick came from it - so
         * it is recorded against the automation that owns the step, exactly as it is for a pick that found its own
         * step (bug C8).
         */
        /**
         * SAME RULE AS ABOVE: the page belongs to the TIME the adopted point sits in.
         *
         * This path had the same fault - `state.basic.id` for every time - so an adopted pick in time two or three also
         * filed its page under the first record. `single` is the point, and the event that holds it is the owner.
         */
        let ownerId = state.editing?.id;
        if (state.tab === 'basic') {
          const owner = (state.basicEvents ?? []).find((ev) => (ev.steps ?? []).some((s) => s === single || s.id === single.id));
          ownerId = owner?.id ?? state.basic?.id ?? BASIC_ID;
        }
        if (ownerId && typeof msg.url === 'string') {
          send({ type: 'remember-pick-page', automationId: ownerId, url: msg.url }).catch(() => {});
        }
        state.pickSavedAt = Date.now();
        state.pickSavedFor = single.id;
        state.pickTarget = null;
        if (state.tab === 'basic') state.basicKeepDraft = true;
        else state.editorKeepDraft = true;
        recordPickDebug({ event: 'adopted', stepId: single.id, tab: state.tab });
        render();
        return;
      }
      const where = msg.finder?.selector ?? msg.finder?.xpath ?? msg.finder?.id ?? '(a picked element)';
      const message = String(where).startsWith('(a')
        ? t('pick.needsStep')
        : t('pick.needsStepWith').replace('{sel}', String(where).slice(0, 60));
      // BOTH placements: `basicError` when the form is what the user is looking at, and a panel-level notice otherwise.
      // The second one is the fix - the first was invisible from every other tab, measured.
      if (state.tab === 'basic') state.basicError = message;
      state.panelNotice = message;
      render();
    }
    return;
  }
  /**
   * The PAGE can cancel a pick as well - Escape while the pointer is over the page. Without this the panel kept showing
   * "Picking" with a live target after the page had already stopped, which is a state the user cannot get out of.
   */
  if (msg?.type === 'element-pick-cancelled') {
    state.pickTarget = null;
    state.pickCancelled = Date.now();
    render();
    return;
  }
  if (msg?.type === 'trace' || msg?.type === 'run-finished') {
    send({ type: 'get-active-run' }).then((r) => {
      if (r?.ok) state.activeRun = r.run;
      if (state.tab === 'automations') render();
    });
    /**
     * A FINISHED RUN IS A NEW ENTRY IN THE HISTORY.
     *
     * The history was only re-read when the panel was opened, so a run that finished while the panel was open never
     * appeared - and the History tab looked like it was lying about what had run. The runs are fetched again when a
     * run finishes, and both tabs that show them are re-rendered.
     */
    if (msg?.type === 'run-finished') {
      send({ type: 'list-runs' }).then((r) => {
        if (r?.ok) state.runs = r.runs;
        if (state.tab === 'history' || state.tab === 'automations') render();
      }).catch(() => {});
    }
  }
});

async function boot() {
  const [a, s, runs] = await Promise.all([
    send({ type: 'list-automations' }),
    send({ type: 'get-settings' }),
    send({ type: 'list-runs' }),
  ]);
  if (a?.ok) state.automations = a.automations;
  if (s?.ok) state.settings = s.settings;
  if (runs?.ok) state.runs = runs.runs;

  // BEFORE the first render: `dir` and the font have to be on <html> before content is painted, or the panel
  // paints left-to-right for a frame and then jumps.
  const { resolveLanguage } = await import('../../core/i18n/i18n.js');
  const language = resolveLanguage(state.settings?.language, globalThis.navigator?.language);
  t = translator(language);
  applyToDocument(document, language);
  state.language = language;

  const active = await send({ type: 'get-active-run' });
  if (active?.ok) state.activeRun = active.run;
  render();
}

boot();
