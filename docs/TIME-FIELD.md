# The time field, taken seriously

One real session, three reports, and a run that never fired. The reports and the missed run had the same root cause.

## Why the schedule never ran

```
12:26:19.311  SAVED   basic  schedule=daily  steps=5
armed  for 09:00:00.000 (31 Oct)          <- but it was 12:26 on the 30th
```

**09:00:00 was the DEFAULT, not the time that had been typed.** So the value in the model had never been replaced, the
target was the next day, and nothing fired.

And the reason the typed time never reached the model was measurable in one line:

```
input.value = '۱۲' + U+003A (:)     ->  '12:30'   ok
input.value = '۱۲' + U+066B (٫)     ->  '1230'    the separator is DELETED
input.value = '۱۲' + U+066C (٬)     ->  '1230'
input.value = '۱۲' + U+061B (؛)     ->  '1230'
input.value = '۱۲' + U+FF1A (：)    ->  '1230'
input.value = '۱۲' + U+FE55         ->  '1230'
input.value = '۱۲' + U+05C3         ->  '1230'
input.value = '۱۲' + U+2236 (∶)     ->  '1230'
```

The digits were being translated and **the separator was thrown away**, so `۱۲:۳۰` became `1230` - not a time, rejected,
and the model kept its previous value. With a Persian keyboard every time entry failed silently. The characters that can
mean "separator" are now all read as one, and the earlier report of "the numbers do not change with a Persian keyboard"
turns out to have been this same bug seen from the outside.

## Three reports

**"همه چیزش رو میشه پاک کرد" - everything can be erased.** It could, and worse, an erased field was *accepted*:

```
'۹:۰۰'      -> model 9:0      seconds invented, so minute precision became PRECISE
'۱۲:'       -> model 12:0     a half-typed value silently completed
':'         -> model 0:0      a lone separator scheduled MIDNIGHT
'۰۹:۰۰:۰۰'  -> model 9:0:0    the typed seconds discarded
'۱۴:۳۰:۵۵:۹۹' -> accepted     the fourth part was sliced away by an 8-character limit
```

Each of those wrote a schedule nobody asked for, and looked fine. The parser now refuses all of them, and it refuses
`۱۴:۳۰:۵۵:۹۹` **before** the field's own length limit can truncate it into something valid - that check has to come
first, which the first version of the fix got wrong and a test caught.

**"اعداد بالاتر از استاندارد ... مثل مثلا دقیقه ۱۰۰" - values beyond the range.** `12:99` was silently ignored and
`12:100` failed for the *wrong* reason (too many digits, not an out-of-range minute). Now every part is range-checked and
each failure has its own name.

**"با کیبورد فارسی ... از راست شروع میکنه" - it starts from the right.** Two causes. `dir="ltr"` sets the alignment but
the editing direction of a bidirectional value can still be right-to-left, so `unicode-bidi: plaintext` is set on the
control. And the caret was placed by a boolean test - "was it at the end?" - which is wrong as soon as normalisation
changes a character in place; the position is now mapped across the translation.

## The rule that was hiding behind all of it: nothing said why

Every rejection was invisible. The field showed the user's text, the model did not change, and nothing anywhere said the
time was unusable - so a schedule that had already passed stayed in force and the user waited for a run that could not
happen.

**Every rejection now carries a reason and is shown next to the field**, in both languages:

- `Enter a time.`
- `That is not a complete time yet — a time looks like 09:30 or 09:30:00.`
- `Each part of a time has at most two digits, like 09:30.`
- `The minute must be 00–59.`
- `The hour must be 00–23.`

And one rule that was deliberately kept: **digits are translated but structure is never repaired.** `۹۹:۹۹` is rejected
exactly as `99:99` is, because repairing a typo into a valid time schedules something the user did not ask for. A stray
letter, though, is ignored rather than made fatal - a keyboard produces them, and refusing the whole value for one would
be worse, provided nothing is invented.

## Four defects found while verifying it

**1. The panel could not render twice at once.**

```
NotFoundError: Failed to execute 'replaceChildren' on 'Element': The node to be removed is no longer a child of this
node. Perhaps it was moved in a 'blur' event handler?
```

`replaceChildren()` removes children one by one, and removing a **focused** element fires `blur`. The blur handler
committed the value and asked for a re-render, which ran `replaceChildren()` again on the same parent - so the outer
removal loop then tried to detach nodes the inner render had already moved. The panel was left half-built. Render is now
non-re-entrant, and a nested request is honoured once after the tree is complete.

**2. The first follow-up render ate the form's working copy.** `state.basicKeepDraft` is consumed at the *start* of a
render, so the follow-up build read it as false and rebuilt the draft from storage - discarding a point that had just
been added, measured as "+ adds a point" leaving the count at 1. Restoring it **after** the loop was too late, and that
ordering mistake was itself caught by a test.

**3. A click could be swallowed.** `blur` fires on `mousedown`, *before* `mouseup`, so a re-render inside the blur
handler replaced the element the pointer was already down on and the click was delivered to nothing: **type a time, press
the next control, and nothing happens.** Deferring by one task is not enough because `mouseup` is its own task; the
re-render now waits for the interaction to finish.

**4. Three of the tests were measuring the wrong thing**, and each reported a working panel as broken:

- `/^\+\s/` matched the picker's fallback hint ("+3 fallbacks"), which is also a button - the test clicked the wrong
  element and then read a row count that had not changed.
- `element.click()` inside `evaluate` bypasses the browser's hit-testing and layout, so it is not a click. The suite now
  uses `page.mouse.click` at real coordinates.
- Filling the selector before leaving the time field put the value into a node the deferred re-render then replaced, so
  the row came back empty and the save was *correctly* refused - reported as "the save does nothing" when the test had
  overwritten its own fixture.

And one assertion asked a row for a **delete** control that lives at the step level, beside a **clear** control that
lives in the row. They are different controls at different levels, and each is now asserted where it is.

## Verification

```
time-field-test   21/21   (three consecutive runs)
ui-basic-test     25/25   (three consecutive runs)
pick-digits-test  20/20   ·  save-button-test 12/12
614 unit tests  ·  every browser suite green
```

The end-to-end check is the one that matters, because it is the reported complaint:

```
typed "09:11:36"  ->  stored {"hour":9,"minute":11,"second":36}    ids=["basic"]
```

Before the fix the same check returned `ids=[]` - no automation existed at all, because the typed time was never
stored, so the 09:00:00 default armed for tomorrow.
