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
};

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : '-');

function relTime(ms) {
  if (!ms) return '-';
  const d = ms - Date.now();
  const abs = Math.abs(d);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const unit = days >= 1 ? `${days} day${days === 1 ? '' : 's'}`
    : hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'}`
    : mins >= 1 ? `${mins} min`
    : 'under a minute';
  return d >= 0 ? `in ${unit}` : `${unit} ago`;
}

const REASON_LABEL = {
  finished: 'Finished',
  'stopped-by-user': 'Stopped',
  'step-error': 'Failed',
  'run-timeout': 'Timed out',
  'step-limit': 'Step limit',
  aborted: 'Aborted',
};

async function refresh() {
  const res = await send({ type: 'list-automations' }).catch(() => null);
  if (res?.ok) state.automations = res.automations;
  const active = await send({ type: 'get-active-run' });
  if (active?.ok) state.activeRun = active.run;
  render();
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
    el('label', { text: 'When' }),
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
      el('label', { text: 'At' }),
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
      el('label', { text: 'Every' }),
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
      el('label', { text: 'Stop after' }),
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
      const row = el('div', { class: 'row wrap' }, el('label', { text: 'Days' }));
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
        el('label', { text: 'Day' }),
        number(s.day ?? 1, { min: '1', max: '28', class: 'small' }, (v) => {
          state.editing.schedule = { ...s, day: Math.min(28, Math.max(1, Number(v))) };
          onChange();
        }),
        el('span', { class: 'hint', text: '1–28, so every month has it' }),
      ));
    }
    wrap.append(el('div', { class: 'row' },
      el('label', { text: 'Time' }),
      el('input', {
        type: 'time', class: 'grow', value: `${String(s.hour ?? 9).padStart(2, '0')}:${String(s.minute ?? 0).padStart(2, '0')}`,
        onchange: (e) => {
          const [h, m] = e.target.value.split(':').map(Number);
          if (Number.isFinite(h) && Number.isFinite(m)) {
            state.editing.schedule = { ...s, hour: h, minute: m, second: 0 };
            onChange();
          }
        },
      }),
    ));
  }

  if (s.kind === 'cron') {
    wrap.append(el('div', { class: 'row' },
      el('label', { text: 'Expression' }),
      el('input', {
        class: 'grow', value: s.expression ?? '', placeholder: 'minute hour day month weekday',
        onchange: (e) => {
          state.editing.schedule = { kind: 'cron', expression: e.target.value };
          onChange();
        },
      }),
    ));
    wrap.append(el('div', { class: 'hint', text: 'Five fields, in your local time. e.g.  0 9 * * 1-5  = weekdays at 09:00' }));
    wrap.append(el('div', {
      class: 'hint',
      text: 'Six fields supported when you need an exact second:  ss mm hh day month weekday. '
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
      el('label', { for: 'same-day', text: 'Today only' }),
      el('span', {
        class: 'hint',
        text: 'do not roll over to the next day if today\'s time has already passed',
      }),
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
        ? el('div', { class: 'preview-warn', text: 'this schedule will not fire again' })
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

function stepRow(step, list, index, rerender) {
  const isBlock = BLOCK_KINDS.has(step.kind);
  const row = el('div', { class: 'step' });

  const header = el('div', { class: 'step-head' },
    el('span', { class: `step-kind k-${step.kind}`, text: STEP_LABELS[step.kind] ?? step.kind }),
    el('span', { class: 'step-summary', text: summariseStep(step) }),
    el('span', { class: 'spacer' }),
    el('button', { class: 'icon', title: 'Move up', text: '↑', onclick: () => {
      if (index === 0) return;
      [list[index - 1], list[index]] = [list[index], list[index - 1]];
      rerender();
    } }),
    el('button', { class: 'icon', title: 'Move down', text: '↓', onclick: () => {
      if (index >= list.length - 1) return;
      [list[index + 1], list[index]] = [list[index], list[index + 1]];
      rerender();
    } }),
    el('button', { class: 'icon danger', title: 'Delete', text: '✕', onclick: () => {
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
      el('label', { text: 'Find' }),
      el('select', {
        onchange: (e) => { step.finder = { ...finder, strategy: e.target.value }; rerender(); },
      }, ...['css', 'xpath', 'text', 'id', 'name', 'label', 'placeholder', 'aria', 'role', 'point']
        .map((s) => el('option', { value: s, text: s, selected: finder.strategy === s }))),
      el('input', {
        class: 'grow mono',
        value: finder.selector ?? finder.xpath ?? finder.text ?? finder.id ?? finder.name ??
               finder.label ?? finder.placeholder ?? finder.aria ?? finder.role ?? '',
        placeholder: 'selector, path or text',
        onchange: (e) => {
          const key = { css: 'selector', xpath: 'xpath', text: 'text', id: 'id', name: 'name',
            label: 'label', placeholder: 'placeholder', aria: 'aria', role: 'role' }[finder.strategy];
          if (key) step.finder = { ...finder, [key]: e.target.value };
          rerender();
        },
      }),
      el('button', {
        class: 'pick', text: '⌖ Pick',
        title: 'Click an element on the page',
        onclick: async () => {
          state.pickTarget = step.id;
          const res = await send({ type: 'pick-element' });
          if (!res.ok) alert(res.error ?? 'could not start the picker');
        },
      }),
      finder.chain?.length
        ? el('span', { class: 'hint', title: finder.chain.join('\n'), text: `+${finder.chain.length} fallbacks` })
        : null,
    ));
  }

  // ---- kind-specific fields
  if (step.kind === 'fill') {
    body.append(el('div', { class: 'row' },
      el('label', { text: 'Value' }),
      el('input', {
        class: 'grow', value: step.value ?? '',
        placeholder: 'text, or ${variable} or ${row.column}',
        onchange: (e) => { step.value = e.target.value; rerender(); },
      }),
    ));
  }
  if (step.kind === 'click') {
    body.append(el('div', { class: 'row' },
      el('label', { text: 'Button' }),
      el('select', { onchange: (e) => { step.button = e.target.value; rerender(); } },
        ...['left', 'right', 'middle'].map((b) => el('option', { value: b, text: b, selected: (step.button ?? 'left') === b }))),
      el('label', { text: 'Clicks' }),
      el('select', { onchange: (e) => { step.clickCount = Number(e.target.value); rerender(); } },
        ...[1, 2, 3].map((n) => el('option', { value: String(n), text: String(n), selected: (step.clickCount ?? 1) === n }))),
    ));
  }
  if (step.kind === 'check') {
    body.append(el('div', { class: 'row' },
      el('label', { text: 'State' }),
      el('select', { onchange: (e) => { step.checked = e.target.value === 'true'; rerender(); } },
        el('option', { value: 'true', text: 'Check', selected: step.checked === true }),
        el('option', { value: 'false', text: 'Uncheck', selected: step.checked !== true })),
    ));
  }
  if (step.kind === 'select') {
    body.append(el('div', { class: 'row' },
      el('label', { text: 'Option' }),
      el('input', {
        class: 'grow', value: step.value ?? '', placeholder: 'option value or visible text',
        onchange: (e) => { step.value = e.target.value; rerender(); },
      }),
    ));
  }
  if (step.kind === 'wait') {
    body.append(el('div', { class: 'row' },
      el('label', { text: 'Wait' }),
      el('input', {
        type: 'number', class: 'small', value: String(step.ms ?? 1000), min: '0',
        onchange: (e) => { step.ms = Math.max(0, Number(e.target.value)); rerender(); },
      }),
      el('span', { class: 'hint', text: 'ms' }),
    ));
  }
  if (step.kind === 'goto' || step.kind === 'newTab') {
    body.append(el('div', { class: 'row' },
      el('label', { text: 'URL' }),
      el('input', {
        class: 'grow mono', value: step.url ?? '', placeholder: 'https://… or ${row.url}',
        onchange: (e) => { step.url = e.target.value; rerender(); },
      }),
    ));
  }
  if (step.kind === 'key') {
    body.append(el('div', { class: 'row' },
      el('label', { text: 'Keys' }),
      el('input', {
        class: 'grow mono', value: Array.isArray(step.keys) ? step.keys.join('+') : (step.keys ?? ''),
        placeholder: 'e.g. ctrl+shift+t',
        onchange: (e) => { step.keys = e.target.value; rerender(); },
      }),
      el('label', { text: 'Gap' }),
      el('input', {
        type: 'number', class: 'small', value: String(step.gapMs ?? 0), min: '0',
        onchange: (e) => { step.gapMs = Number(e.target.value); rerender(); },
      }),
      el('span', { class: 'hint', text: 'ms between keys' }),
    ));
  }
  if (step.kind === 'scroll') {
    body.append(el('div', { class: 'row' },
      el('label', { text: 'By' }),
      el('input', {
        type: 'number', class: 'small', value: String(step.y ?? 0),
        onchange: (e) => { step.y = Number(e.target.value); rerender(); },
      }),
      el('span', { class: 'hint', text: 'px vertical (negative scrolls up)' }),
    ));
  }
  if (step.kind === 'setVariable') {
    body.append(el('div', { class: 'row' },
      el('label', { text: 'Name' }),
      el('input', { class: 'small mono', value: step.name ?? '', onchange: (e) => { step.name = e.target.value; rerender(); } }),
      el('input', {
        class: 'grow', value: step.value ?? '', placeholder: 'value or ${…}',
        onchange: (e) => { step.value = e.target.value; rerender(); },
      }),
    ));
  }
  if (step.kind === 'extract') {
    body.append(el('div', { class: 'row' },
      el('label', { text: 'Into' }),
      el('input', { class: 'small mono', value: step.name ?? '', onchange: (e) => { step.name = e.target.value; rerender(); } }),
      el('select', { onchange: (e) => { step.source = e.target.value; rerender(); } },
        ...['text', 'value', 'attribute', 'html', 'count'].map((s) =>
          el('option', { value: s, text: s, selected: (step.source ?? 'text') === s }))),
    ));
  }
  if (step.kind === 'notify') {
    body.append(el('div', { class: 'row' },
      el('label', { text: 'Message' }),
      el('input', {
        class: 'grow', value: step.message ?? '', placeholder: 'text or ${variable}',
        onchange: (e) => { step.message = e.target.value; rerender(); },
      }),
    ));
  }
  if (step.kind === 'runScript') {
    body.append(el('textarea', {
      class: 'code', rows: '3', value: step.code ?? '',
      placeholder: 'JavaScript run in the page. Return a value to store it.',
      onchange: (e) => { step.code = e.target.value; },
    }));
  }

  // ---- loops and branches
  if (step.kind === 'loop') {
    body.append(el('div', { class: 'row' },
      el('label', { text: 'Type' }),
      el('select', { onchange: (e) => { step.loopType = e.target.value; rerender(); } },
        ...[['count', 'a number of times'], ['while', 'while a condition holds'], ['forEach', 'for each item in a list']]
          .map(([v, t]) => el('option', { value: v, text: t, selected: (step.loopType ?? 'count') === v }))),
    ));
    if ((step.loopType ?? 'count') === 'count') {
      body.append(el('div', { class: 'row' },
        el('label', { text: 'Times' }),
        el('input', {
          type: 'number', class: 'small', value: String(step.count ?? 1), min: '1',
          onchange: (e) => { step.count = Math.max(1, Number(e.target.value)); rerender(); },
        }),
      ));
    }
    if (step.loopType === 'forEach') {
      body.append(el('div', { class: 'row' },
        el('label', { text: 'List' }),
        el('input', {
          class: 'grow mono', value: step.listVariable ?? '', placeholder: 'variable holding a list (or the CSV rows)',
          onchange: (e) => { step.listVariable = e.target.value; rerender(); },
        }),
      ));
    }
    if (step.loopType === 'while') {
      body.append(el('div', { class: 'row' },
        el('label', { text: 'Max' }),
        el('input', {
          type: 'number', class: 'small', value: String(step.maxIterations ?? 100), min: '1',
          onchange: (e) => { step.maxIterations = Math.max(1, Number(e.target.value)); rerender(); },
        }),
        el('span', { class: 'hint', text: 'iterations — required, so it cannot run forever' }),
      ));
      body.append(conditionEditor(step, 'condition', rerender));
    }
  }

  if (step.kind === 'if') {
    body.append(conditionEditor(step, 'condition', rerender));
    body.append(el('div', { class: 'row' },
      el('label', { text: 'Runs for' }),
      el('span', { class: 'hint', text: 'current: loop index, iteration, total, first, last' }),
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
      body.append(el('div', { class: 'sub-label', text: 'otherwise' }));
      body.append(stepsEditor(elseList, rerender, 'else'));
    }
  }

  // ---- shared options
  body.append(el('div', { class: 'row opts' },
    el('label', { text: 'Delay' }),
    el('input', {
      type: 'number', class: 'tiny', value: String(step.delayMs ?? ''), placeholder: '—', min: '0',
      onchange: (e) => { step.delayMs = e.target.value === '' ? undefined : Number(e.target.value); },
    }),
    el('span', { class: 'hint', text: 'ms before' }),
    el('label', { text: 'Retries' }),
    el('input', {
      type: 'number', class: 'tiny', value: String(step.retries ?? ''), placeholder: '—', min: '0', max: '50',
      onchange: (e) => { step.retries = e.target.value === '' ? undefined : Number(e.target.value); },
    }),
    el('label', { text: 'On error' }),
    el('select', { onchange: (e) => { step.onError = e.target.value || undefined; } },
      el('option', { value: '', text: 'stop the run', selected: !step.onError }),
      el('option', { value: 'continue', text: 'continue', selected: step.onError === 'continue' }),
      el('option', { value: 'skip', text: 'skip this step', selected: step.onError === 'skip' })),
  ));

  row.append(body);
  return row;
}

function conditionEditor(host, key, rerender) {
  const c = host[key] ?? { source: 'text', comparator: 'exists' };
  host[key] = c;
  const wrap = el('div', { class: 'cond' });
  wrap.append(el('div', { class: 'row' },
    el('label', { text: 'If' }),
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
      el('label', { text: 'Value' }),
      el('input', {
        class: 'grow', value: c.value ?? '', placeholder: 'compare against, or ${variable}',
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
      ...STEP_KINDS.map((k) => el('option', { value: k, text: STEP_LABELS[k] ?? k }))),
    el('button', {
      class: 'primary', text: '+ Add step',
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

function automationsView(rerender) {
  const wrap = el('div');

  wrap.append(el('div', { class: 'row' },
    el('button', {
      class: 'primary grow', text: '+ New automation',
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
      class: 'grow', text: '⌖ Pick & record',
      title: 'Pick elements on the page to build steps automatically',
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
        class: 'danger', text: 'Stop',
        onclick: async () => { await send({ type: 'stop-run' }); await refresh(); },
      }),
    ));
  }

  if (state.automations.length === 0) {
    wrap.append(el('div', { class: 'empty' },
      el('p', { text: 'No automations yet.' }),
      el('p', { class: 'hint', text: 'Create one, add steps, then pick elements on the page to fill them in.' }),
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
          title: 'Enable or disable',
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
          class: 'primary', text: '▶ Run now',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            const res = await send({ type: 'start-run', automationId: a.id });
            if (!res.ok) alert(res.error ?? 'could not start');
            await refresh();
          },
        }),
        el('button', {
          class: state.editing?.id === a.id ? 'active' : '', text: '✎ Edit',
          onclick: async () => {
            state.editing = state.editing?.id === a.id ? null : JSON.parse(JSON.stringify(a));
            rerender();
          },
        }),
        el('button', {
          text: '⧉', title: 'Duplicate',
          onclick: async () => { await send({ type: 'duplicate-automation', id: a.id }); await refresh(); },
        }),
        el('button', {
          class: 'danger', text: '🗑', title: 'Delete',
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
          el('label', { text: 'Name' }),
          el('input', {
            class: 'grow', value: ed.name,
            onchange: (e) => { ed.name = e.target.value; },
          }),
        ),
        el('div', { class: 'row' },
          el('label', { text: 'Sites' }),
          el('input', {
            class: 'grow mono', value: (ed.urls ?? []).join(', '),
            placeholder: 'leave empty to run anywhere; e.g. example.com/*',
            onchange: (e) => { ed.urls = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); },
          }),
        ),
        scheduleEditor(rerender),
        el('div', { class: 'sub-label', text: 'Steps' }),
        stepsEditor(ed.steps, rerender, null),
        el('div', { class: 'row' },
          el('button', {
            class: 'primary grow', text: 'Save',
            onclick: async () => {
              const res = await send({ type: 'save-automation', automation: ed });
              if (!res.ok) { alert(res.error ?? 'could not save'); return; }
              await send({ type: 'schedule-one', automationId: ed.id });
              state.editing = null;
              await refresh();
            },
          }),
          el('button', { text: 'Cancel', onclick: () => { state.editing = null; rerender(); } }),
        ),
      ));
    }
  }
  return wrap;
}

function dataView(rerender) {
  const wrap = el('div');
  wrap.append(el('div', { class: 'row' },
    el('label', { text: 'CSV file' }),
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
    wrap.append(el('div', { class: 'hint', text: 'Use ${row.column} or ${column} in any step. A loop of type "for each item in a list" over "rows" walks the file.' }));
  } else {
    wrap.append(el('div', { class: 'empty' }, el('p', { class: 'hint', text: 'Load a CSV to drive an automation with data. Rows are kept only while the browser is open.' })));
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
    wrap.append(el('div', { class: 'empty' }, el('p', { class: 'hint', text: 'Nothing is scheduled. Give an automation a schedule and it will appear here.' })));
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

function historyView() {
  const wrap = el('div');
  if (!state.runs.length) {
    wrap.append(el('div', { class: 'empty' }, el('p', { class: 'hint', text: 'No runs recorded yet.' })));
    return wrap;
  }
  wrap.append(el('div', { class: 'row' },
    el('span', { class: 'grow hint', text: `${state.runs.length} recent runs` }),
    el('button', { text: 'Clear', onclick: async () => { await send({ type: 'clear-runs' }); await refresh(); } }),
  ));
  for (const r of state.runs.slice(0, 40)) {
    const bad = r.reason !== 'finished';
    wrap.append(el('div', { class: `card run ${bad ? 'bad' : ''}` },
      el('div', { class: 'card-head' },
        el('span', { class: 'name', text: r.name ?? '(unknown)' }),
        el('span', { class: 'spacer' }),
        el('span', { class: `badge ${bad ? 'bad' : 'ok'}`, text: REASON_LABEL[r.reason] ?? r.reason }),
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

function render() {
  const root = document.getElementById('root');
  const rerender = () => render();
  root.replaceChildren();

  root.append(el('header', { class: 'app-head' },
    el('span', { class: 'logo', text: '◧' }),
    el('span', { class: 'title', text: 'AutoFlow' }),
    el('span', { class: 'spacer' }),
    el('button', {
      class: 'icon', title: 'Options',
      text: '⚙',
      onclick: () => api.runtime.openOptionsPage(),
    }),
  ));

  const nav = el('nav', { class: 'tabs' });
  for (const [id, label] of [['automations', 'Automations'], ['scheduled', 'Scheduled'], ['data', 'Data'], ['history', 'History']]) {
    nav.append(el('button', {
      class: state.tab === id ? 'active' : '',
      text: label,
      onclick: () => { state.tab = id; render(); },
    }));
  }
  root.append(nav);

  const body = el('main');
  if (state.tab === 'automations') body.append(automationsView(rerender));
  else if (state.tab === 'scheduled') body.append(scheduledView());
  else if (state.tab === 'data') body.append(dataView(rerender));
  else body.append(historyView());
  root.append(body);

  // A pick that lands anywhere gets applied to the step waiting for it.
  if (state.pickTarget) {
    root.append(el('div', { class: 'picking-banner' },
      el('span', { text: 'Click an element on the page…' }),
      el('button', {
        text: 'Cancel',
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
    const step = state.editing ? find(state.editing.steps) : null;
    if (step) {
      step.finder = msg.finder;
      state.pickTarget = null;
      render();
    }
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
  const active = await send({ type: 'get-active-run' });
  if (active?.ok) state.activeRun = active.run;
  render();
}

boot();
