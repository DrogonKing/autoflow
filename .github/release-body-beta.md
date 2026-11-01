> ## ⚠️ BETA — click anywhere to leave the time, and a ✓ to save it by hand
>
> Verified in a controlled browser, **not against a real trading site yet**.

## What you asked for

> «وقتی من عادت دارم وقتی ساعت رو مشخص کردم روی یه جای دیگه داخل صفحه کلیک کنم که از نوشتار ساعت بیام بیرون ولی تو این
> نسخه تو نوشتار میموند»
> «انتهای هر ساعت هم یه علامت تیک بذار برای سیو دستی ساعت»

Both are in this build.

**Clicking elsewhere now leaves the field, and saves the time.** The panel used to treat a press on a button, a label or
the background as "still in the time field" and put the caret back — so the only way out was Tab or Enter. A press
anywhere outside the field is now read for what it is: the edit is finished. The value is committed and saved once.

**Each time has a ✓ at its end.** It commits what is in the field, leaves it, and saves immediately rather than waiting
for the debounce — so it is a second, visible way out that also saves. It also works for anyone who would rather click a
button than the background.

## What was measured, and one thing that cannot be

```
click the panel background  → focus left the field ✅ · the new time was stored ✅ · one save ✅
press ✓                     → time stored ✅ · field left ✅ · saved at once, not on the debounce ✅
```

**A press on the trading page itself (rather than the panel)** is handled by the same code, through the panel's
`window` blur and `visibilitychange`. That path could not be driven end to end in this harness — Playwright's
`bringToFront` does not move real OS focus between pages, measured as `panel saw window blur: 0`. The handler's own
contract is asserted instead, and the test says so rather than claiming more than it checked. It is worth a look when
you next use it for real.

## One subtlety worth knowing

Leaving the field is now **sticky**: after you click away, a later re-render will not pull the caret back into the time
box. It is cleared only when you next click into a time field. That was the actual cause of being trapped — a press
commits the value, the save produces a re-render, and the restore put the caret straight back.

## Verified

```
leave-field-test  10/10   ✓ present and to the right of the field · clicking away leaves and saves ·
                          ✓ saves at once and leaves · the hidden-window handler leaves the field
new-time-test      8/8    a typed time replaces the old one, one save, no idle saves
time-typing        8/8    focus and caret survive a re-render
ui-basic          25/25   add, delete, reorder points
three-times       11/11   three times, each with its own point and alarm
776 unit tests · 39 files · import check clean
```