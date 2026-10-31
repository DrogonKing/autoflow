import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * autoCleanup must fire on the exit path, because the existing suites all end with `process.exit()`.
 *
 * This is tested by RUNNING a real child process rather than by inspecting the module: an exit hook is behaviour, and
 * asserting that a function exists would pass even if the hook were never registered.
 */
describe('autoCleanup', () => {
  it('removes the directory when the process exits via process.exit()', () => {
    const box = mkdtempSync(path.join(tmpdir(), 'autoclean-test-'));
    try {
      const script = path.join(box, 'child.mjs');
      const lib = path.resolve('scripts/lib/profile.mjs');
      const target = path.join(box, 'af-should-vanish');
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { mkdirSync } from 'node:fs';
        import { autoCleanup } from ${JSON.stringify('file://' + lib)};
        mkdirSync(${JSON.stringify(target)});
        autoCleanup(${JSON.stringify(target)});
        process.exit(0);
      `], { stdio: 'pipe' });

      expect(existsSync(target)).toBe(false);
      // and the script itself proved the directory existed before exit, by not throwing on mkdir
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });

  it('removes it on a non-zero exit too, because a failing suite leaks just as much', () => {
    const box = mkdtempSync(path.join(tmpdir(), 'autoclean-test-'));
    try {
      const lib = path.resolve('scripts/lib/profile.mjs');
      const target = path.join(box, 'af-should-vanish');
      let threw = false;
      try {
        execFileSync(process.execPath, ['--input-type=module', '-e', `
          import { mkdirSync } from 'node:fs';
          import { autoCleanup } from ${JSON.stringify('file://' + lib)};
          mkdirSync(${JSON.stringify(target)});
          autoCleanup(${JSON.stringify(target)});
          process.exit(3);
        `], { stdio: 'pipe' });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);           // exit 3
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });

  it('accepts a profile object as well as a string', () => {
    const box = mkdtempSync(path.join(tmpdir(), 'autoclean-test-'));
    try {
      const lib = path.resolve('scripts/lib/profile.mjs');
      const target = path.join(box, 'af-via-object');
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { mkdirSync } from 'node:fs';
        import { autoCleanup } from ${JSON.stringify('file://' + lib)};
        mkdirSync(${JSON.stringify(target)});
        autoCleanup({ dir: ${JSON.stringify(target)} });
        process.exit(0);
      `], { stdio: 'pipe' });
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });
});
