# Temporary browser profiles — why they must be removed, and by what

## The measurement that caused this document

On 2026-10-31 the host disk was at **88 %** (32 GB of 38 GB). The largest single consumer was not a repository, a
container image or a log:

```
/tmp/af-*      918 directories   3,111 MB   temporary Chromium profiles
/tmp/af-race-*  54 of those       200 MB
```

Each directory is a full `--user-data-dir` that a suite launched Chromium against. Chromium writes ~3.8 MB into each one
before the test does anything: `GrShaderCache`, `GraphiteDawnCache`, `component_crx_cache`, `Default/`.

918 of them accumulated over **two days**. Every run of every browser suite left one behind.

## Why a fresh profile is used at all

A shared profile keeps state between runs — extension storage, cached service workers, the last active tab — and that
makes a suite's result depend on what the previous run did. The failures this produces are the worst kind: they pass on
a clean machine and fail on a used one, or the reverse. So the profile has to be fresh, and `mkdtempSync` is the correct
way to get one.

The bug was never *creating* the profile. It was that **27 of 30 suites never deleted it**.

## The fix

`scripts/lib/profile.mjs` provides three things, and the shape matters more than the code:

| function | what it does |
|---|---|
| `makeProfile(label)` | returns `{dir, dispose()}` — you cannot obtain a profile without also holding its cleanup |
| `autoCleanup(dirOrProfile)` | registers removal on `process.exit`, which is the only hook the existing suites reach |
| `installProfileSweep()` | called at the top of a suite; removes profiles older than 2 h, so a **crashed** run is collected by the next one |

**`autoCleanup` is the one that made the fix stick.** Every suite here ends with `process.exit(...)`, which runs `exit`
handlers and nothing else — so a `finally` block would never execute, while an `exit` hook always does. That is also why
the test for it spawns a **real child process** instead of asserting the function exists: an exit hook is behaviour, and
a test that only checked for the function would pass even if the hook were never registered.

`SIGKILL` and a hard timeout cannot be caught. That case is exactly why `sweepStaleProfiles()` exists.

## The sweep is deliberately timid

It will not delete:

- a directory younger than `ageMs` (default **2 hours**) — a concurrently running suite is left alone, which matters
  because the regression script runs suites in sequence and a later one must not delete an earlier one's profile mid-run
- a directory whose name does not start with a known prefix (`af-`, `autoflow-profile-`, `ac-`) — so it cannot touch
  `/tmp/incoming`, an evidence dump, or anyone else's data
- a **file** that happens to match a prefix; only directories

Adding a new suite with a new prefix means adding that prefix to `PROFILE_PREFIXES`. A test asserts the list contains the
prefixes in use, because a forgotten prefix leaks silently forever.

## Applying it

`scripts/wire-profile-cleanup.py` does the edit mechanically across every suite:

```bash
python3 scripts/wire-profile-cleanup.py --dry-run   # show what would change
python3 scripts/wire-profile-cleanup.py             # apply
```

It is idempotent, and a hand edit across 30 files is precisely how one gets missed — and a single missed suite leaks
exactly as much as all of them did.

## Verified

| check | result |
|---|---|
| before | 83 profiles in `/tmp` |
| run a browser suite | 9/9 checks passed |
| after | **0 profiles** |
| the helper's own tests | 15 tests, including a real child process exiting with code 3 and still cleaning up |
| syntax of all 32 touched scripts | 0 errors |

## If the disk fills again

```bash
bash /root/cleanup-disk.sh      # measures, removes test leftovers, reports reclaimed MB
```

It never touches `/root/.cache/ms-playwright`, the HuggingFace caches, `/root/.gh-token`, or any repository.
