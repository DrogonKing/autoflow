# The time field is a mask: digits in, separators derived

Two reports, one mistake behind both.

    "':' نباید پاک بشه درحالی که وقتی اعداد ساعت‌ها رو پاک میکنم اونم پاک میشه"
    "اعداد ساعت رو باید دوتا دوتا بگیره مثلا وقتی عدد ۱۳۵۱۲۱ رو میدم خودش تبدیلش کنه به ۱۳:۵۱:۲۱،
     برای هم فارسی هم انگلیسی"

The field treated `:` as something the **user types**. It is structure. So it is now derived from a digit buffer, which
answers both at once: a colon cannot be deleted because it is never stored, and grouping happens by itself.

## What it does now

```
۱۳۵۱۲۱   -> 13:51:21      Persian
135121    -> 13:51:21      Western
١٣٥١٢١    -> 13:51:21      Arabic-Indic
13:51:21  -> 13:51:21      pasted with colons - stripped and regenerated in the same places
13:5      -> 13:5          a half-group is displayed as-is
1351211   -> 13:51:21      the seventh digit is not a digit of a time
```

Grouping is by position, not by what the user typed, so all four rows above reach the same six digits.

## Backspace had to be handled in DIGIT space

This is the part that cannot be left to the browser. With the colon derived, a caret sitting just after a separator
would make plain backspace delete **nothing visible** and the field would look stuck. So backspace removes the digit
before the caret and re-formats:

```
"13:51"  backspace  ->  "13:5"
"13:5"   backspace  ->  "13"
"13"     backspace  ->  "1"
"1"      backspace  ->  ""
```

and the caret position is carried across as a **digit index**, so it stays in the group being edited. Every
intermediate value is the digits plus their own separators — there is no state holding a stray colon or a missing one,
which is what the first report was actually about.

One deliberate asymmetry: a caret at a group boundary steps **past** the inserted colon, because the next keystroke
belongs to the next group. Leaving it before the colon would put the second group's digit into the hour.

## Partial groups are padded on the LEFT

Measured, and the first version got it backwards: with right-padding, `'13:5'` read as **13:50** and a lone `'1'` read as
hour **10**. A partial group is the *start* of a group, so it is the leading digit — `'13:5'` is thirteen-oh-five and
`'1'` is one o'clock. It is also the only rule that keeps a complete and a partial group consistent, so `'13'` and
`'13:5'` cannot disagree about the hour.

## One thing that got simpler

`'13'` used to be rejected as "incomplete". It is now **13:00** — because that is what the field displays, and a value
the field shows must be a value the model accepts. Every keystroke therefore reaches the model, and there is no
intermediate state where the user has typed something the extension refuses to believe.

## What is still refused, always with a reason

```
''         -> "Enter a time."
'۲۵'       -> "The hour must be 00–23."
'۱۳۹۹'     -> "The minute must be 00–59."
'۱۳۵۱۹۹'   -> "The second must be 00–59."
```

Silence is what hid the original bug: the field showed the user's text, the model did not change, and nothing anywhere
said the time was unusable — so a schedule that had already passed stayed in force and the user waited for a run that
could not happen.

## Verification

`time-field-test` 28/28, three consecutive runs. The end-to-end check is the reported complaint:

```
typed ۱۳۵۱۲۱  ->  field "13:51:21"  ->  stored {"hour":13,"minute":51,"second":21}
```

and the deletion behaviour is asserted as a property rather than a sequence — every intermediate value must equal its own
digits plus their derived separators, so no backspace can ever leave a lone colon behind.
