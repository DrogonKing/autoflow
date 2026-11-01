> ## ⚠️ BETA — a time can now be deleted
>
> The delete control you asked for, and the four bugs behind its absence. Verified in a controlled browser, **not against
> a real trading site yet**.

## Your report

> «چرا دکمه حذف زمان وجود نداره؟ مثلا من یه زمان سومی اضافه کردم بعد پشیمون شدم و میخوام حذفش کنم ولی دکمش نیست»

`removeEvent()` existed in the code from the day the feature shipped and **was never called from the panel**. Nothing
failed, because every test asked the questions I had thought to ask — that a time can be *added*, that its points survive,
that the times come back after a reopen. Nobody asked whether one can be taken away.

**Now:** a small ✕ sits on each time chip, next to the time. The last remaining time has no ✕ at all, rather than one
that refuses — a form with no time has nothing to show and no way back.

## Why a delete turned out to be four bugs, not one control

Adding the button exposed faults that would have bitten you later, in this order:

**۱. Deleting a time left its record and its alarm behind.**
The removal set was computed from a list the panel refreshes lazily. A deleted time kept firing on its own. The save now
asks the worker what is actually stored before deciding what to remove.

**۲. Deleting the FIRST time renumbered the others.**
Ids were derived from position in the list (`-t2`, `-t1`), so removing the first time renamed the second one — and an
alarm is registered against an id (`autoflow:run:<id>`), so a pending alarm silently began pointing at a **different**
time. Ids now belong to the time itself. Measured: the survivors kept `basic-new1` instead of being relabelled.

**۳. Then the *wrong* time was deleted.**
Because position decided the id, `merge()` forced the base id onto whichever time happened to be first. So deleting the
09:00 time sent `delete-automation:basic-new1` — it deleted the time you KEPT, and left the one you removed. The trace
showed it plainly:

```
you removed  basic       (09:00)
panel sent   delete basic-new1   ← the one you kept
storage kept basic@9:00          ← the one you removed
```

**۴. A deleted time came back after a reload.**
The deletion waited on the 1.2-second auto-save, so reloading sooner restored it. A deletion is one deliberate act with
nothing to collapse, so it saves immediately; and it cancels any save that was already queued, because that queued save
still carried the old list.

## Verified

```
remove-time-test     15/15   the report: a third time added, then removed.
                             The right time goes, the others stay, the record is gone from
                             storage, the removal survives a reload, and the last time has
                             no delete control
776 unit tests, 39 files
34 browser suites green, 0 red
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