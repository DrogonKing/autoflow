# Pick, cancel, and Persian digits

Three reports, and each turned out to have a cause that was not where it appeared to be.

## 1. Pick had no confirmation

The button gave no sign that a pick had landed. It now shows `✓ Picked` on a green face, exactly as Save does.

**And it stays until the next action, rather than flashing.** Four attempts to expire it on a timer failed in four
different ways, because the timer belonged to a button that the next render discarded:

- a `setTimeout` scheduled during render fires from an element that is about to be thrown away
- the simplified view re-renders through `keepDraftThen`, which re-runs the whole view
- re-evaluating the condition on each render re-armed the timer, so the green never went away
- and a fixed wait in the test measured from the click, while the window starts when the pick *lands*

So it is a **state** now, cleared by the next real action - pressing Pick again, editing the selector, or saving. That is
deterministic, needs no cooperation from the render cycle, and reads better: `✓ Picked` means "this selector came from a
pick", which is true until it is no longer true. A flash that vanishes while the user is still looking says less.

## 2. A pick could not be cancelled

There was genuinely no way out. Escape worked **inside the page**, but a pick is started **from the panel**, and the
panel did not listen for it - so once Pick was pressed the only exit was clicking an element, and that element was then
recorded as the target. A misclick was unrecoverable.

Now, while a pick is live:

- the button reads `◉ Picking…` on an amber face, with a slow pulse
- **the same button cancels it** - the same place, the same gesture
- an explicit **✕** sits beside it, because a button that has changed meaning needs its escape hatch visible
- **Escape in the page cancels too**, and the panel hears it - previously the page stopped while the panel still showed
  a live pick, which was a state with no way out at all

The test asserts the property that matters rather than that a function ran: after cancelling, **clicking an element on
the page records nothing**, and the selector is unchanged.

## 3. Persian digits in the time field

Reported: "when I type with the Persian keyboard the numbers do not change, it has to be English."

**The cause was the native control, and it was measured rather than guessed:**

```
input.value = '08:45:52'   ->  '08:45:52'
input.value = '۰۸:۴۵:۵۲'   ->  ''          <- discarded
input.value = '٠٩:٣٠:٠٥'   ->  ''          <- discarded
```

`<input type="time">` sets its own value to the empty string when given Persian or Arabic-Indic digits. So the `input`
event carried **nothing**, the model was never updated, and nothing downstream could repair a value thrown away before
any handler ran. The field is now our own text field, with the digits normalised as they are typed:

```
typed ۰۸:۴۵:۵۲  ->  shown 08:45:52  ->  model 08:45:52  ->  preview "Every day at 08:45:52"
typed ٠٩:٣٠:٠٥  ->  shown 09:30:05  ->  model 09:30:05
```

Three deliberate properties of that field:

- **`dir="ltr"`, even in the Persian interface.** A time is digits and colons, not Persian prose, and under RTL
  `09:00:00` renders as `00:00:90` - not cosmetic on a control whose whole job is to be read correctly.
- **Digits are translated but structure is not repaired.** `۹۹:۹۹` is still rejected, exactly as `99:99` is. Normalising
  must not turn a typo into a valid time that silently schedules something.
- **Seconds are part of the value, no longer a `step` attribute.** The assertion in the test was rewritten to match,
  because `step: 1` no longer exists to assert.

## Four defects found while verifying the above

**1. Pick searched for a page in the wrong tab.** `tabs.query({ active: true, currentWindow: true })` returns **the panel
itself** when the panel is opened as a tab, or when it is the only tab in its window. `start-picking` then went to the
panel, which has no picker, and the panel sat showing "Picking…" while nothing anywhere responded.

The condition is now the **positive** one - an `http(s)` or `file` URL, which is exactly the set where a content script
can run. "Not our own tab" was too loose: `about:blank`, `chrome://`, `devtools://` and `view-source:` are all not ours
and none of them can host a picker, so the worker used to fail with *"Cannot access contents of url ... Extension
manifest must request permission to access this host"* - measured, and it is what a newly-opened tab looks like. When
there is genuinely no page it now says so: `no page to pick from - open the site you want to pick in`. Reporting that is
better than starting a pick that cannot work.

**2. `timeField` was never defined.** The first edit that introduced it failed partway and the definition was never
written, so the panel threw `ReferenceError: timeField is not defined` and **nothing rendered** - a blank tab. Found by
capturing the panel's own `pageerror`, not by reading the code.

**3. The redraw callback was invoked incorrectly.** `keepDraftThen(fn)` takes a callback and calls it, and it was passed
directly as the redraw - so `redraw()` invoked `undefined()` and threw *inside the click handler*. The pick target was
set, the message reached the worker and returned `ok: true`, and the view never rebuilt, so the button looked like it had
done nothing. Silent, because an exception inside an event handler is swallowed by the dispatch.

**4. The test itself was not clicking the button.** `element.click()` inside `page.evaluate` runs the handler but bypasses
the browser's hit-testing and layout entirely, so it reported a **working** button as broken across several attempts.
It now uses `page.mouse.click` at the element's own coordinates, which is what a person does. The related diagnostic that
settled it: stamping a marker on the view container before the click and checking whether it survived, which separates
"the DOM was not rebuilt" from "the DOM was rebuilt with the wrong state".

## Verification

```
pick-digits-test       20/20  (three consecutive runs)
ui-basic-test          23/23  (three consecutive runs)
save-button-test       12/12
587 unit tests  ·  every browser suite green
```

`ui-basic-test` gained three assertions that encode the *reasons* the control is what it is, so it cannot be
"simplified" back to a native time input: it must be a text field, it must normalise the digits, and it must be
left-to-right. It also lost one assertion that required two `oninput` handlers - one per editor - which was correct when
the two editors each carried their own copy of the field, and which is exactly the duplication that let them drift apart
and made the Persian-digit fix need applying twice. There is one shared field now, so one handler is the correct count,
and requiring two would be asserting the bug.
