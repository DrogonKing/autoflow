> ## ⚠️ BETA — the time field no longer throws you out
>
> Verified in a controlled browser, **not against a real trading site yet**.

## Your report

> «وقتی دارم ساعت تنظیم میکنم بخاطر اوتسیو هی منو از تنظیم ساعت میندازه بیرون و باید به سختی و سریع ساعت رو تنظیم کنم»

You were right that the auto-save was involved — but not the way it looked. The save itself was innocent; what took you
out of the field was the **re-render** that any change to the form causes.

## What was happening

`render()` begins with `root.replaceChildren()` — it throws every node away and rebuilds the form. The element you were
typing into therefore no longer existed, and the browser moved focus to the page body. Measured:

```
typing, touching nothing          → focused: true,  value kept
after "+ Add a point"             → focused: false, activeElement = BODY
```

So the time you had just typed looked lost, and you had to re-enter the field and retype before the next change took it
away again. Exactly the "I have to do it quickly" you described.

## What it does now

The form remembers **which field you were in and where the caret was**, and puts you back after the rebuild:

```
after any change to the form  → focused: true, caret at the end, value untouched
a half-typed "10:32"          → still "10:32" after another change, caret where you left it
and you can carry on typing    → the rest of the digits land in the field
```

Three details made this more than a one-line change, all measured:

- **The browser moves focus on `mousedown`, before any handler runs.** So by the time the click handler ran, the field was
  already forgotten by the DOM. It is now remembered on `focusin`, `selectionchange` and `input`.
- **The caret has to be set one frame later**, because `setSelectionRange` clamps to `0` on an element the layout has not
  placed yet — which put the caret at the start of the value.
- **A re-render can happen after our restore**, because the clicked button is removed and the browser then moves focus off
  a node that no longer exists. So the restore is re-asserted on the next frame, but only while nothing has changed.

**Two deliberate exceptions**, both about not fighting the user: a pointer that is down means you are pressing something,
so the restore stands aside; and arriving at a *different* editable field is your choice and is left alone.

## The bug this uncovered

Restoring focus while a click was in flight made "+ Add a point" stop working — the button was under the pointer at
`mousedown`, the form re-rendered, and the click was delivered to a node that had been replaced. The deferral in
`afterCurrentInteraction` waited for `mouseup` — but **`click` is dispatched after `mouseup`**, so it was always one event
too early. It now defers by one task, which lets the click land first. That is a real fault the focus work exposed, and it
would have bitten you as "sometimes a button does nothing".

## A note on the test harness

While fixing this I found the import net — the check that catches a name used without being imported — had gone blind
again, in a **fifth** way: its "object key" rule treated *a call in any second argument* as a key, so a name like
`describeEvent` looked declared when it was not. Proven now in both directions: clean tree exits 0, and removing one
import makes it exit 1 naming that import.

## Verified

```
time-typing-test   8/8    caret stays, a half-typed time survives, typing continues
ui-basic-test     25/25   including the add-a-point and delete-a-point flows the fix had broken
three-times 11/11 · time-survives-pick 6/6 · ms-target 5/5 · events-ui 9/9
776 unit tests, 39 files
import check: clean, and proven to fail on a planted fault
```

## Install

**Chrome / Edge / Brave / Opera** — download `autoflow-chrome.zip`, unpack it, then
`chrome://extensions` → enable Developer mode → **Load unpacked** → pick the unpacked folder.

**Firefox** — download `autoflow-firefox.zip`, unpack it, then `about:debugging#/runtime/this-firefox` → **Load
Temporary Add-on** → pick `manifest.json` inside the folder.

**Lite builds** (`autoflow-chrome-lite.zip`, `autoflow-firefox-lite.zip`) — the same release with the Basic tab only.
They install BESIDE the full build and are named "… Lite" so the two are distinguishable.

## If you are upgrading

Take a backup first, on the Data tab. Automations restored from a backup arrive **disabled** on purpose.