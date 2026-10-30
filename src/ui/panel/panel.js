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

import { describeSchedule, nextRun, SCHEDULE_KINDS, validateSchedule } from '../../core/schedule/schedule.js';
import { STEP_KINDS, STEP_LABELS, BLOCK_KINDS, makeStep, countSteps } from '../../core/model/steps.js';
import { describeCondition } from '../../core/engine/conditions.js';
import { readCsv } from '../../core/io/csv.js';
import { api } from '../../platform/api.js';
import { applyToDocument, translator } from '../../core/i18n/i18n.js';
import { ALL_DEFAULTS, normaliseAll } from '../../core/dom/clickAll.js';
import { describeSkew, shouldWarn } from '../../core/clock/skew.js';

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

const state = {
  automations: [],
  settings: {},
  runs: [],
  activeRun: null,
  editing: null,          // the automation currently open in the editor
  schedulePreview: null,
  csv: null,              // { columns, rows }
  dataKey: null,
  tab: 'automations',
  pickTarget: null,       // the step id awaiting an element pick
  clockSkew: null,        // { offsetMs, rttMs, trustworthy, warn, applied } - measured, never applied silently
  clockSkewError: null,   // why the measurement could not be taken, shown next to the button that tried
  backupNote: null,       // the result of the last backup or restore, so it is not a silent operation
  basicSavedAt: null,     // when Save last succeeded, so the button can confirm for a moment and then stop
  pickSavedAt: null,      // when a pick last landed, so the Pick button can confirm the same way
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

async function refresh() {
  const res = await send({ type: 'list-automations' }).catch(() => null);
  if (res?.ok) state.automations = res.automations;
  const active = await send({ type: 'get-active-run' });
  if (active?.ok) state.activeRun = active.run;
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
        state.editing.schedule = next;
      }
      // refreshed EITHER WAY: a rejection has to be visible next to the field, not only absent from the model
      refreshTimeHint(parsed.ok && parsed.precise);
      if (rerender) onChange();
    };

    refreshTimeHint(typeof s.second === 'number');
    wrap.append(el('div', { class: 'row' },
      el('label', { text: t('field.time') }),
      timeField({
        value: `${String(s.hour ?? 9).padStart(2, '0')}:${String(s.minute ?? 0).padStart(2, '0')}`
          + (typeof s.second === 'number' ? `:${String(s.second).padStart(2, '0')}` : ''),
        onCommit: (v, opts) => { commitTime(v, opts); if (opts.rerender) keepDraftThen(() => {}); },
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
          state.editing.schedule = { kind: 'cron', expression: e.target.value };
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
    validateSchedule(state.editing.schedule);
    const label = describeSchedule(state.editing.schedule);
    const upcoming = [];
    let cursor = Date.now();
    if (state.editing.schedule.kind !== 'manual') {
      for (let i = 0; i < 3; i++) {
        const n = nextRun(state.editing.schedule, cursor);
        if (n === null) break;
        upcoming.push(n);
        cursor = n;
      }
    }
    wrap.append(el('div', { class: 'preview' },
      el('div', { class: 'preview-label', text: label }),
      ...upcoming.map((t) => el('div', { class: 'preview-next', text: `next: ${fmtTime(t)}  (${relTime(t)})` })),
      upcoming.length === 0 && state.editing.schedule.kind !== 'manual'
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
  const justPicked = state.pickSavedAt && state.pickTarget === null && Date.now() - state.pickSavedAt < 2500;

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
    onclick: async () => {
      if (picking) { cancelPick(redraw); return; }
      state.pickTarget = step.id;
      state.pickSavedAt = null;      // the new pick supersedes the previous confirmation
      const res = await send({ type: 'pick-element' }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (!res?.ok) {
        state.pickTarget = null;
        state.pickError = String(res?.error ?? 'could not start the picker');
        redraw();
        return;
      }
      redraw();
    },
  });
  // no expiry timer: see the note where `pickSavedAt` is set. The class stays until the next action.

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
        step.clickAll = { ...ALL_DEFAULTS, ...all, ...patchObj };
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
    body.append(el('div', { class: 'row' },
      el('label', { text: t('field.button') }),
      el('select', { onchange: (e) => { step.button = e.target.value; rerender(); } },
        ...['left', 'right', 'middle'].map((b) => el('option', { value: b, text: b, selected: (step.button ?? 'left') === b }))),
      el('label', { text: t('field.clicks') }),
      el('select', { onchange: (e) => { step.clickCount = Number(e.target.value); rerender(); } },
        ...[1, 2, 3].map((n) => el('option', { value: String(n), text: String(n), selected: (step.clickCount ?? 1) === n }))),
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
        ...[['count', 'a number of times'], ['while', 'while a condition holds'], ['forEach', 'for each item in a list']]
          .map(([v, t]) => el('option', { value: v, text: t, selected: (step.loopType ?? 'count') === v }))),
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
  const c = host[key] ?? { source: 'text', comparator: 'exists' };
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
      ['count', 'countGt', 'count is more than'],
      ['count', 'countLt', 'count is less than'],
      ['url', 'contains', 'the URL contains'],
      ['title', 'contains', 'the page title contains'],
      ['variable', 'eq', 'a variable equals'],
      ['js', 'eq', 'a script returns'],
      ['text', 'checked', 'is checked'],
      ['text', 'enabled', 'is enabled'],
    ].map(([s, cmp, label]) => el('option', {
      value: `${s}|${cmp}`, text: label, selected: c.source === s && c.comparator === cmp,
    }))),
  ));
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

function basicDraft() {
  const existing = state.automations.find((a) => a.id === BASIC_ID);
  if (existing) {
    // an editor over a real record: take the stored steps, but never its schedule kind, because this form is
    // always a daily time
    return {
      ...existing,
      schedule: { kind: 'daily', ...(existing.schedule ?? {}) },
      steps: (existing.steps ?? []).map((s) => ({ ...s })),
    };
  }
  // a fresh draft: 09:00:00 and one empty click, so the form is usable the moment it is opened
  return {
    id: BASIC_ID,
    name: t(BASIC_NAME_KEY),
    enabled: true,
    urls: [],
    schedule: { kind: 'daily', hour: 9, minute: 0, second: 0 },
    steps: [makeStep('click', { finder: { strategy: 'css', selector: '' } })],
    options: { stepDelayMs: 60, stepRetries: 2, maxRunMs: 30 * 60_000 },
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
  if (!state.basicKeepDraft || !state.basic) {
    state.basic = basicDraft();
  } else {
    // the form changed itself and the result must survive any follow-up build in this render sequence
    bodyKeptDraftForFollowUp = true;
  }
  state.basicKeepDraft = false;
  const draft = state.basic;

  /** Mutate the draft and re-render without discarding it. */
  const keepDraftThen = (fn) => {
    fn();
    state.basicKeepDraft = true;
    rerender();
  };
  const sched = draft.schedule ?? { kind: 'daily', hour: 9, minute: 0, second: 0 };

  wrap.append(el('p', { class: 'hint', text: t('basic.intro') }));

  // ---- the time, typed rather than scrolled. Same lesson as the full editor: no re-render while it has focus.
  // `time-hint` is a stable hook: the intro paragraph is also a `.hint`, so a class is the only reliable way to address
  // the element that carries the REASON a time was refused.
  const hint = el('span', { class: 'hint time-hint', text: '' });
  const commit = (value) => {
    /**
     * The same parse as the full editor, and the same visible reason - these two views edit ONE record, so a value
     * accepted by one and rejected by the other would be a bug waiting to be reported.
     *
     * Written to the MODEL on every keystroke and never followed by a re-render here: rebuilding the view while the
     * field has focus is what made this control untypeable, and a rebuild reads the schedule back from storage, which
     * would discard the half-typed value.
     */
    const parsed = parseTypedTime(value);
    state.timeError = parsed.ok ? null : parsed.error;
    hint.textContent = parsed.ok ? '' : t(`time.error.${parsed.error}`);
    hint.className = parsed.ok ? 'hint time-hint' : 'hint time-hint warn time-error';
    if (!parsed.ok) return;
    draft.schedule = { kind: 'daily', hour: parsed.hour, minute: parsed.minute, second: parsed.second };
    state.basic = draft;
  };
  wrap.append(el('div', { class: 'row' },
    el('label', { text: t('basic.time') }),
    timeField({
      value: `${String(sched.hour ?? 9).padStart(2, '0')}:${String(sched.minute ?? 0).padStart(2, '0')}:${String(sched.second ?? 0).padStart(2, '0')}`,
      // every keystroke updates the model; leaving the field re-renders once, and the draft is kept so the typed
      // value survives that re-render
      onCommit: (v, opts) => { commit(v); if (opts.rerender) keepDraftThen(() => {}); },
    }),
    hint,
  ));

  // ---- the points, each one a picked element and a click
  wrap.append(el('div', { class: 'row' },
    el('label', { text: t('basic.points') }),
    el('span', { class: 'hint', text: `${draft.steps.length}` }),
  ));

  draft.steps.forEach((step, i) => {
    const finder = step.finder ?? { strategy: 'css', selector: '' };
    const picked = pickerSummary(finder);

    wrap.append(el('div', { class: 'step' },
      el('div', { class: 'step-head' },
        el('span', { class: 'step-kind', text: `#${i + 1}` }),
        el('span', { class: 'step-summary', text: picked.label }),
        el('span', { class: 'spacer' }),
        // move up / down, so the order of the clicks is visible and adjustable
        el('button', { class: 'icon', title: t('action.moveUp'), text: t('ui.moveUp'), onclick: () => {
          if (i === 0) return;
          [draft.steps[i - 1], draft.steps[i]] = [draft.steps[i], draft.steps[i - 1]];
          keepDraftThen(() => {});
        } }),
        el('button', { class: 'icon', title: t('action.moveDown'), text: t('ui.moveDown'), onclick: () => {
          if (i >= draft.steps.length - 1) return;
          [draft.steps[i + 1], draft.steps[i]] = [draft.steps[i], draft.steps[i + 1]];
          keepDraftThen(() => {});
        } }),
        // delete, which is half of what was missing: a picked point could not be removed
        el('button', { class: 'icon danger', title: t('action.delete'), text: t('ui.close'), onclick: () => {
          keepDraftThen(() => draft.steps.splice(i, 1));
        } }),
      ),
      el('div', { class: 'step-body' },
        el('div', { class: 'row' },
          /**
           * A ZERO-ARGUMENT redraw that keeps the draft.
           *
           * `keepDraftThen(fn)` takes a callback and calls it, so passing it directly meant `redraw()` invoked
           * `undefined()` and threw inside the click handler: the pick target was set and the view never rebuilt, so
           * the button stayed as it was and the click looked like it had done nothing. The message still reached the
           * worker, which is why only the button's own state was wrong.
           */
          pickControl({ step, redraw: () => keepDraftThen(() => {}) }),
          // the other half: an editable selector, shown for every point rather than only as a fallback count
          el('input', {
            class: 'grow mono', value: finder.selector ?? finder.text ?? finder.id ?? '',
            placeholder: t('field.selector'),
            onchange: (e) => {
              const key = { css: 'selector', xpath: 'xpath', text: 'text', id: 'id', name: 'name',
                label: 'label', placeholder: 'placeholder', aria: 'aria', role: 'role' }[finder.strategy] ?? 'selector';
              // editing drops the fallback chain: it pointed at the ORIGINALLY picked element and would outvote
              // a corrected selector when the new one missed
              const { chain, ...rest } = finder;
              keepDraftThen(() => { step.finder = { ...rest, strategy: finder.strategy ?? 'css', [key]: e.target.value }; });
            },
          }),
          finder.chain?.length
            ? el('span', { class: 'hint', title: finder.chain.join('\n'), text: `+${finder.chain.length}` })
            : null,
          // a positional selector is the silent case: warn, in the row where the pick was made
          positionalWarning(finder)
            ? el('span', { class: 'hint warn', title: t('finder.positionalTitle'), text: '⚠' })
            : null,
          // and remove whatever was picked, keeping the strategy so the row stays usable
          (finder.chain?.length || Object.keys(finder).some((k) => k !== 'strategy'))
            ? el('button', {
              class: 'icon', text: '✕', title: t('finder.clear'),
              onclick: () => keepDraftThen(() => { step.finder = { strategy: finder.strategy ?? 'css' }; }),
            })
            : null,
        ),
      ),
    ));
  });

  // ---- add another point
  wrap.append(el('div', { class: 'row' },
    el('button', {
      class: 'grow', text: t('basic.addPoint'),
      onclick: () => {
        keepDraftThen(() => draft.steps.push(makeStep('click', { finder: { strategy: 'css', selector: '' } })));
      },
    }),
  ));

  // ---- save, and run now
  const save = async () => {
    const clean = {
      ...draft,
      name: draft.name || t(BASIC_NAME_KEY),
      // only steps that actually point at something are saved: an empty row would fail at run time and look like
      // a bug in the clicker rather than an unfinished form
      steps: draft.steps.filter((x) => Object.keys(x.finder ?? {}).some((k) => k !== 'strategy' && x.finder[k])),
    };
    if (clean.steps.length === 0) {
      state.basicError = t('basic.needPoint');
      rerender();
      return;
    }
    state.basicError = null;
    state.basicNotice = null;
    const res = await send({ type: 'save-automation', automation: clean });
    if (!res?.ok) { state.basicError = res?.error ?? 'save failed'; rerender(); return; }
    await refresh();
    state.basic = { ...clean };
    state.basicStale = false;
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
      const when = Number.isFinite(sched.at) ? new Date(sched.at) : null;
      const time = when ? `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}:${String(when.getSeconds()).padStart(2, '0')}` : '';
      const sameDay = when ? when.getDate() === new Date().getDate() : true;
      state.basicNotice = t('basic.armedFor')
        .replace('{time}', time)
        .replace('{day}', sameDay ? '' : new Date(sched.at).toLocaleDateString());
    } else if (sched.reason === 'manual') {
      state.basicNotice = t('basic.notScheduled');
    } else if (Number.isFinite(sched.justMissedMs)) {
      state.basicNotice = t('basic.justMissed').replace('{sec}', String(Math.round(sched.justMissedMs / 1000)));
    } else {
      state.basicNotice = t('basic.armFailed').replace('{reason}', String(sched.reason ?? 'unknown'));
    }

    rerender();
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
        await save();
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
  try {
    const label = describeSchedule(draft.schedule);
    const upcoming = [];
    let cursor = Date.now();
    for (let i = 0; i < 2; i++) {
      const n = nextRun(draft.schedule, cursor);
      if (n === null) break;
      upcoming.push(n);
      cursor = n;
    }
    wrap.append(el('div', { class: 'preview' },
      el('div', { class: 'preview-label', text: label }),
      ...upcoming.map((t2) => el('div', { class: 'preview-next', text: `next: ${fmtTime(t2)}  (${relTime(t2)})` })),
    ));
  } catch (e) {
    wrap.append(el('div', { class: 'preview warn', text: `${e.message}` }));
  }

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
const TIME_SEPARATORS = /[\u066B\u066C\u061B\uFF1A\uFE55\u05C3\u2236\u002E\u06D4]/g;

export function normaliseTimeText(text) {
  return normaliseDigits(text)
    .replace(TIME_SEPARATORS, ':')
    .replace(/[^0-9:]/g, '')
    .replace(/:{2,}/g, ':')
    .slice(0, 8);
}

/** How many colon-separated parts a typed text has - two means minutes, three means a precise schedule. */
export function countTimeParts(text) {
  return normaliseTimeText(text).split(':').length;
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
export function parseTypedTime(text) {
  const normalised = normaliseTimeText(text);
  if (normalised === '') return { ok: false, error: 'empty' };

  /**
   * TOO LONG TO BE A TIME, checked BEFORE the field's own 8-character limit can truncate it.
   *
   * `normaliseTimeText` slices to 8 because that is the longest time there is, but slicing first meant
   * `14:30:55:99` became `14:30:55` and was ACCEPTED - a silent repair, which is the exact failure mode this parser
   * exists to stop. The unsliced form is examined here, so a fourth part is refused.
   */
  const unbounded = normaliseDigits(text).replace(TIME_SEPARATORS, ':').replace(/[^0-9:]/g, '');
  if (unbounded.length > 8) return { ok: false, error: 'tooManyDigits' };

  const rawParts = normalised.split(':');
  if (rawParts.some((p) => p === '')) return { ok: false, error: 'incomplete' };
  if (rawParts.length > 3) return { ok: false, error: 'tooManyParts' };
  if (rawParts.length < 2) return { ok: false, error: 'incomplete' };
  if (rawParts.some((p) => p.length > 2)) return { ok: false, error: 'tooManyDigits' };

  const [h, m, s] = rawParts.map(Number);
  if (h > 23) return { ok: false, error: 'hourRange' };
  if (m > 59) return { ok: false, error: 'minuteRange' };
  if (rawParts.length > 2 && s > 59) return { ok: false, error: 'secondRange' };

  return { ok: true, hour: h, minute: m, second: rawParts.length > 2 ? s : 0, precise: rawParts.length > 2 };
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
  document.addEventListener('mouseup', run, true);
  setTimeout(run, 250);   // a blur with no click behind it must still refresh, and promptly
}

/**
 * Map a caret position in the raw text onto the normalised text.
 *
 * Normalising is not length-preserving in general: a Persian digit becomes one ASCII digit and a separator becomes `:`,
 * both the same length, but a rejected letter is DELETED, which shifts everything after it. Counting the output produced
 * by the input before the caret is the only way to keep the insertion point on the character being edited rather than at
 * whichever end a boolean test happened to choose.
 */
export function caretsAfterNormalising(raw, caret, normalised) {
  const text = String(raw ?? '');
  const upTo = text.slice(0, Math.max(0, Math.min(caret ?? 0, text.length)));
  return Math.max(0, Math.min(normaliseTimeText(upTo).length, String(normalised ?? '').length));
}

function timeField({ value, placeholder, onCommit, onHint, rerender }) {
  const input = el('input', {
    type: 'text',
    inputmode: 'numeric',
    dir: 'ltr',
    class: 'grow mono time-input',
    value,
    placeholder: placeholder ?? 'HH:MM:SS',
    autocomplete: 'off',
    spellcheck: 'false',
    oninput: (e) => {
      const raw = e.target.value;
      const normalised = normaliseTimeText(raw);
      if (normalised !== raw) {
        /**
         * THE CARET IS MAPPED, not guessed.
         *
         * Reported: "when I type with the Persian keyboard it starts from the right instead of like English". The old
         * code placed the caret by asking a boolean - was it at the end? - which is wrong the moment normalisation
         * changes a character in place near the caret: replacing `۱۲` with `12` at the START of the value has the same
         * length but the insertion point must stay where the typing is. The position is mapped across the translation.
         */
        const mapped = caretsAfterNormalising(raw, e.target.selectionStart, normalised);
        e.target.value = normalised;
        try { e.target.setSelectionRange(mapped, mapped); } catch { /* not focusable */ }
      }
      onCommit(normalised, { rerender: false });
      if (onHint) onHint(countTimeParts(normalised) > 2);
    },
    onblur: (e) => {
      const normalised = normaliseTimeText(e.target.value);
      onCommit(normalised, { rerender: false });
      if (onHint) onHint(countTimeParts(normalised) > 2);
      /**
       * The re-render waits for the click that caused this blur to finish.
       *
       * MEASURED: running it inline replaced the element under the pointer before `mouseup`, so the click was delivered
       * to nothing - "I type a time, click Add a point, and nothing happens". Nothing is lost by waiting, because the
       * model was already written above.
       */
      afterCurrentInteraction(() => onCommit(normalised, { rerender: true }));
    },
    onchange: (e) => onCommit(normaliseTimeText(e.target.value), { rerender: false }),
    // Enter is what a person presses when done typing, and here it should behave like leaving the field
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
  });
  void rerender;
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
          options: { stepDelayMs: 120, stepRetries: 2, maxRunMs: 30 * 60_000 },
          enabled: true,
          createdAt: Date.now(),
        };
        state.editing = a;
        await send({ type: 'save-automation', automation: a });
        await refresh();
      },
    }),
    el('button', {
      class: 'grow', text: t('nav.pickAndRecord'),
      title: t('hint.pickTitleLong'),
      onclick: async () => {
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
        el('span', { class: 'badge', text: `${countSteps(a.steps)} steps` }),
      ),
      el('div', { class: 'card-meta' },
        el('span', { class: 'sched-label', text: a.schedule ? describeSchedule(a.schedule) : 'manual' }),
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
      el('div', { class: 'card-meta' }, el('span', { class: 'sched-label', text: describeSchedule(a.schedule) })),
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
            el('pre', { class: 'trace', text: r.trace.map((t) =>
              `+${String(t.at).padStart(6)}ms  ${t.type}${t.kind ? ` ${t.kind}` : ''}${t.message ? ` — ${t.message}` : ''}`).join('\n') }),
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

function render() {
  if (renderInProgress) {
    // do NOT re-enter: the current build is halfway through removing the previous nodes
    renderRequested = true;
    return;
  }
  bodyKeptDraftForFollowUp = false;   // reset per sequence, or one kept draft would pin every later render
  renderInProgress = true;
  try {
    renderTree();
  } finally {
    renderInProgress = false;
  }
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
    renderInProgress = true;
    try {
      renderTree();
    } finally {
      renderInProgress = false;
    }
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
  for (const [id, key] of [['basic', 'tab.basic'], ['automations', 'tab.automations'], ['scheduled', 'tab.scheduled'], ['data', 'tab.data'], ['history', 'tab.history'], ['log', 'tab.log']]) {
    nav.append(el('button', {
      class: state.tab === id ? 'active' : '',
      text: t(key),
      onclick: () => {
        // moving to another tab discards the form's working copy, so coming back shows what is actually saved
        if (id !== 'basic') state.basicStale = true;
        state.tab = id;
        render();
      },
    }));
  }
  root.append(nav);

  const body = el('main');
  if (state.tab === 'basic') body.append(basicView(rerender));
  else if (state.tab === 'automations') body.append(automationsView(rerender));
  else if (state.tab === 'scheduled') body.append(scheduledView());
  else if (state.tab === 'data') body.append(dataView(rerender));
  else if (state.tab === 'log') body.append(logView(rerender));
  else body.append(historyView());
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

api.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'element-picked' && state.pickTarget) {
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
    const inBasic = state.basic ? (state.basic.steps ?? []).find((s) => s.id === state.pickTarget) : null;
    const step = inEditing ?? inBasic ?? null;
    if (step) {
      step.finder = msg.finder;
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
      // a pick landing in the simple view is form work: keep the draft so the point it was picked for survives
      if (state.tab === 'basic') state.basicKeepDraft = true;
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
