/**
 * The profile helper must not itself be a leak, and its sweep must not delete a suite that is still running.
 *
 * Both are real failure modes. A `dispose()` that throws on the error path loses the cleanup exactly when it is needed;
 * a sweep that ignores mtime deletes the working directory of a concurrently running suite and turns a green run red
 * for reasons the failing test cannot explain.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installProfileSweep, makeProfile, PROFILE_PREFIXES, sweepStaleProfiles } from '../scripts/lib/profile.mjs';

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sweep-test-'));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Backdate a directory so the age filter treats it as abandoned. */
function age(dir, ms) {
  const t = (Date.now() - ms) / 1000;
  utimesSync(dir, t, t);
}

describe('makeProfile', () => {
  it('creates a directory with a name derived from the label', () => {
    const p = makeProfile('af-unit');
    try {
      expect(existsSync(p.dir)).toBe(true);
      expect(path.basename(p.dir).startsWith('af-unit-')).toBe(true);
    } finally {
      p.dispose();
    }
  });

  it('does NOT add a second dash when the label already ends in one', () => {
    const p = makeProfile('af-unit-');
    try {
      expect(path.basename(p.dir)).toMatch(/^af-unit-[^-]/);
    } finally {
      p.dispose();
    }
  });

  it('dispose removes the directory', () => {
    const p = makeProfile('af-unit');
    const dir = p.dir;
    expect(existsSync(dir)).toBe(true);
    p.dispose();
    expect(existsSync(dir)).toBe(false);
  });

  it('dispose is idempotent, because a test may call it from two paths', () => {
    const p = makeProfile('af-unit');
    p.dispose();
    expect(() => p.dispose()).not.toThrow();
    expect(() => p.dispose()).not.toThrow();
  });

  it('dispose never throws even when the directory is already gone', () => {
    const p = makeProfile('af-unit');
    rmSync(p.dir, { recursive: true, force: true });
    expect(() => p.dispose()).not.toThrow();
  });
});

describe('sweepStaleProfiles', () => {
  it('removes an old profile and reports the bytes', () => {
    const box = sandbox();
    try {
      const old = path.join(box.dir, 'af-old-run');
      mkdirSync(old);
      writeFileSync(path.join(old, 'blob.bin'), Buffer.alloc(64 * 1024));
      age(old, 3 * 60 * 60 * 1000); // 3 hours

      const r = sweepStaleProfiles({ parent: box.dir, ageMs: 60 * 60 * 1000 });
      expect(r.removed).toBe(1);
      expect(r.freedBytes).toBeGreaterThan(60 * 1024);
      expect(existsSync(old)).toBe(false);
    } finally {
      box.dispose();
    }
  });

  it('KEEPS a fresh profile, because a concurrent suite is using it', () => {
    const box = sandbox();
    try {
      const fresh = path.join(box.dir, 'af-running-now');
      mkdirSync(fresh);
      const r = sweepStaleProfiles({ parent: box.dir, ageMs: 60 * 60 * 1000 });
      expect(r.removed).toBe(0);
      expect(r.kept).toBe(1);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      box.dispose();
    }
  });

  it('ignores directories with an unknown prefix, so the sweep cannot delete someone else\'s data', () => {
    const box = sandbox();
    try {
      const other = path.join(box.dir, 'something-important');
      mkdirSync(other);
      age(other, 10 * 60 * 60 * 1000);
      const r = sweepStaleProfiles({ parent: box.dir, ageMs: 1000 });
      expect(r.removed).toBe(0);
      expect(existsSync(other)).toBe(true);
    } finally {
      box.dispose();
    }
  });

  it('ignores a FILE that matches a prefix, only directories are swept', () => {
    const box = sandbox();
    try {
      const f = path.join(box.dir, 'af-audit-evidence.json');
      writeFileSync(f, 'not a profile');
      age(path.dirname(f), 10 * 60 * 60 * 1000);
      const r = sweepStaleProfiles({ parent: box.dir, ageMs: 1000 });
      expect(r.removed).toBe(0);
      expect(existsSync(f)).toBe(true);
    } finally {
      box.dispose();
    }
  });

  it('does not throw when the parent does not exist', () => {
    expect(() => sweepStaleProfiles({ parent: '/tmp/definitely-not-here-9f8a7b' })).not.toThrow();
  });

  it('covers every prefix a suite actually uses', () => {
    // if a script invents a new prefix it must be added here, otherwise its profiles are never swept
    expect(PROFILE_PREFIXES).toContain('af-');
    expect(PROFILE_PREFIXES).toContain('autoflow-profile-');
  });
});

describe('installProfileSweep', () => {
  it('sweeps and returns a summary without throwing on a clean directory', () => {
    const box = sandbox();
    try {
      const r = installProfileSweep({ parent: box.dir, ageMs: 1000 });
      expect(r.removed).toBe(0);
    } finally {
      box.dispose();
    }
  });
});
