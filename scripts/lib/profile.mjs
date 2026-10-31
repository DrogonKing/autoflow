/**
 * A temporary browser profile that actually goes away.
 *
 * WHY THIS EXISTS. Every suite here launches Chromium against a fresh `--user-data-dir`, because a shared profile keeps
 * state between runs and makes the results unreproducible. Creating one is `mkdtempSync`; DELETING one is the part that
 * was forgotten, and it was forgotten in 27 of 30 scripts.
 *
 * The cost of forgetting is not theoretical. Measured on this host on 2026-10-31: 918 abandoned profile directories in
 * /tmp, 3,111 MB, the largest single consumer on the disk, accumulated over two days of running these suites. Each
 * profile is ~3.8 MB of Chromium's own caches (`GrShaderCache`, `GraphiteDawnCache`, `component_crx_cache`).
 *
 * The fix is deliberately shaped so the NEXT script cannot repeat the mistake: you cannot get a profile without also
 * getting the cleanup, and the cleanup runs on the error path as well as the success path.
 *
 *   const profile = makeProfile('af-anchor');
 *   try {
 *     ... launch against profile.dir ...
 *   } finally {
 *     await profile.dispose();
 *   }
 *
 * `dispose()` is idempotent and never throws: a cleanup that can fail on the error path is a cleanup that will.
 *
 * A profile left behind by a CRASH (SIGKILL, a timeout that kills the process) cannot be caught by any `finally`, so
 * `sweepStaleProfiles()` exists for the next run to call at startup. It only removes directories older than `ageMs` and
 * only ones matching the known prefixes, so a concurrently running suite is never disturbed.
 */
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Every suite's prefix. An unknown prefix is never swept, so a new script must add itself here to be covered. */
export const PROFILE_PREFIXES = [
  'af-',
  'autoflow-profile-',
  'ac-',
];

/** Directories registered by autoCleanup(), removed by the exit hook below. */
const onExit = [];

process.on('exit', () => {
  for (const fn of onExit) fn();
});

export function makeProfile(label, opts = {}) {
  const parent = opts.parent || tmpdir();
  const dir = mkdtempSync(path.join(parent, label.endsWith('-') ? label : `${label}-`));
  let disposed = false;
  return {
    dir,
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // A profile that will not delete is a leak, not a failure: reporting it here would turn a passing suite into a
        // failing one for a reason that has nothing to do with what it tested. sweepStaleProfiles() gets it next run.
      }
    },
  };
}

/**
 * Remove profile directories left by a previous run that died before its `finally`.
 *
 * @param {object} opts
 * @param {number} opts.ageMs   only remove directories whose mtime is older than this (default 2 hours)
 * @param {string} opts.parent  where to look (default the system temp dir)
 * @param {string[]} opts.prefixes  override the prefix list
 * @returns {{removed: number, freedBytes: number, kept: number}}
 */
export function sweepStaleProfiles(opts = {}) {
  const ageMs = opts.ageMs ?? 2 * 60 * 60 * 1000;
  const parent = opts.parent || tmpdir();
  const prefixes = opts.prefixes || PROFILE_PREFIXES;
  const now = Date.now();
  let removed = 0;
  let kept = 0;
  let freedBytes = 0;

  let entries;
  try {
    entries = readdirSync(parent);
  } catch {
    return { removed, freedBytes, kept };
  }

  for (const name of entries) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    const full = path.join(parent, name);
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs < ageMs) {
        kept += 1;
        continue;
      }
      freedBytes += dirSize(full);
      rmSync(full, { recursive: true, force: true, maxRetries: 2 });
      removed += 1;
    } catch {
      // permission change, or it vanished between readdir and stat - either way, not our problem
    }
  }
  return { removed, freedBytes, kept };
}

function dirSize(dir, depth = 0) {
  if (depth > 6) return 0;
  let total = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      try {
        total += e.isDirectory() ? dirSize(full, depth + 1) : statSync(full).size;
      } catch {
        /* raced with something */
      }
    }
  } catch {
    /* unreadable */
  }
  return total;
}

/**
 * Register a directory for removal when the process exits, by ANY route.
 *
 * This is what makes the fix stick in the existing suites. They end with `process.exit(...)`, which runs `exit` handlers
 * but skips nothing else - so an `exit` hook removes the profile where a `finally` cannot reach. Combined with
 * `makeProfile().dispose()`, a script is covered on the success path, the error path, and the exit path.
 *
 * `SIGKILL` still cannot be caught; `sweepStaleProfiles()` covers that next run.
 */
export function autoCleanup(dirOrProfile) {
  const dir = typeof dirOrProfile === 'string' ? dirOrProfile : dirOrProfile?.dir;
  if (!dir) return dir;
  onExit.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      /* nothing useful to do while exiting */
    }
  });
  return dir;
}

/**
 * Wire the sweep into a script in one line, so a suite that dies still leaves nothing behind for long.
 *
 * Call once, at the top of a suite. It is cheap (one readdir) and never throws.
 */
export function installProfileSweep(opts = {}) {
  const result = sweepStaleProfiles(opts);
  if (result.removed) {
    console.log(
      `[cleanup] removed ${result.removed} stale browser profile(s), freed ${(result.freedBytes / 1024 / 1024).toFixed(0)} MB`,
    );
  }
  return result;
}
