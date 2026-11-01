#!/usr/bin/env python3
"""
Rewrite the Basic form's event section so the page LOOKS the way it did before.

The first attempt rendered every event at once as stacked cards, which changed the page the user was used to. What was
actually asked for is narrower and simpler:

  - the form shows ONE time and its points, exactly as before
  - under the points there is a "+ New time" button, in the same spirit as "+ Add a point"
  - the times that have been added are shown as ROWS with a count of their points, and selecting one swaps the form to
    it - so the detail is edited one time at a time and the page stays the shape it was

That also removes the scale problem the stacked version had: twenty events would have been twenty expanded cards.
"""
import pathlib
import sys

P = pathlib.Path('/root/autoflow/src/ui/panel/panel.js')
src = P.read_text()

START = "  // ---- THE EVENTS: one time each, with the points that belong to it."
END_MARK = "  // ---- save, and run now"
i = src.find(START)
j = src.find(END_MARK)
if i < 0 or j < 0:
    print(f'anchors not found: {i} {j}')
    sys.exit(1)

NEW = r'''  // ---- THE TIMES. One is open at a time, shown exactly as the single-time form was: a time and its points.
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
      picker.append(el('button', {
        class: e.id === openId ? 'event-chip active' : 'event-chip',
        title: `${describeEvent(e.schedule)}`,
        text: `${describeEvent(e.schedule)} · ${filledPoints(e)}`,
        onclick: () => {
          state.basicOpen = e.id;
          // the draft is kept so a time typed but not saved is not thrown away by switching rows
          state.basicKeepDraft = true;
          rerender();
        },
      }));
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
  };
  wrap.append(el('div', { class: 'row' },
    el('label', { text: t('basic.time') }),
    timeField({
      value: timeFieldValue(ev.schedule),
      onCommit: (v, opts) => { commit(v); if (opts.rerender) keepDraftThen(() => {}); },
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

'''

src = src[:i] + NEW + src[j:]
P.write_text(src)
print(f'panel.js now {len(src)} characters')
