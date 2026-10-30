# Why the export was empty: reinstalling deletes everything

The export showed **no automations, no alarms, no events** - every section blank.

## The cause was the instructions, not the code

Removing an unpacked extension from `chrome://extensions` **deletes its storage**. The instructions for every previous
version were "remove the old one and install the new one", so each reinstall destroyed every automation and schedule.
A schedule saved before a reinstall was gone before it could fire.

So: "I set the time, saved it, and it did not activate" had a second, upstream cause that no amount of scheduling
accuracy could fix. The arming fixes in 1.9-1.11 were real and necessary, and on their own they would still have failed
while the data was being deleted between installs.

## What now exists

**A backup section at the top of the Data tab** - Save a backup file, Restore from a backup - with the warning stated
in the panel rather than left implicit:

> Removing this extension from the browser DELETES everything it has saved. Take a backup first, then restore it after
> installing the new version.

A restore confirms first (stating how many automations the file holds, because `replace` clears what is there), and
reports what it did: `Restored 2 automation(s); 2 scheduled again.` The re-arm count matters - a restore that writes
records but arms no alarms looks complete and is not.

## Verified by deleting a profile

```
profile A: two automations saved -> export taken -> profile DELETED
profile B: starts empty (0 automations - the loss is reproduced)
           import the backup -> 2 restored -> 2 alarms re-armed
```

`scripts/backup-restore-test.mjs` 8/8, twice.

## The related reporting failures, also fixed

An empty list printed **nothing at all** in the export - no line, no marker - so an empty profile and a lost one looked
identical. Now:

- `(none saved - the extension has no automations in this profile)`
- a `-- storage summary --` section with counts (automations, alarms, runs, events, settings keys), counts only so it
  stays safe to paste, and an explicit note that nothing can fire when nothing is saved
- `SAVED` lines for **every** save attempt, with the schedule kind and step count, so "I pressed it and nothing
  happened" is distinguishable from "I never pressed it"
- `NOT ARMED` when a save succeeded but armed nothing

And the panel now says what Save did: `Saved and scheduled for 08:45:52` / `Saved. This schedule is manual, so there is
nothing to arm` / `Saved, but the schedule was NOT armed: <reason>` / `Saved. The target second had just passed by 3s, so
it will run immediately.`
