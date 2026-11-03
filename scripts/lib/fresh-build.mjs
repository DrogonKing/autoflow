/**
 * A GUARD AGAINST TESTING A STALE BUILD.
 *
 * MEASURED, three times in this project: a browser harness loaded `dist/` that predated the source change under test, so the
 * test measured the OLD code. Twice it produced a false failure (a fix "not working"), once it hid a real bug. Each time the
 * cost was a round of debugging a fault that did not exist.
 *
 * A browser harness cannot check a source change without checking that the bundle was rebuilt from it, so this compares the
 * newest source mtime with the newest bundle mtime and refuses to run when the bundle is older.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const newest = (dir, filter) => {
  let best = 0;
  let bestFile = '';
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (filter(e.name)) {
        const m = statSync(p).mtimeMs;
        if (m > best) { best = m; bestFile = p; }
      }
    }
  };
  walk(dir);
  return { ms: best, file: bestFile };
};

/**
 * Throws when `dist/` is older than any source file, so a harness cannot silently test yesterday's code.
 * @param {string} root repo root
 * @param {{rebuild?: string}} [opts] a hint printed in the error message
 */
export function assertFreshBuild(root, opts = {}) {
  const src = newest(path.join(root, 'src'), (n) => /\.(js|css|html|json)$/.test(n));
  const dist = newest(path.join(root, 'dist'), (n) => /\.(js|css|html|json)$/.test(n));
  if (!dist.ms) {
    throw new Error(`dist/ is empty - build first: ${opts.rebuild ?? 'node scripts/build.mjs'}`);
  }
  if (dist.ms < src.ms) {
    const lag = Math.round((src.ms - dist.ms) / 1000);
    throw new Error(
      `dist/ is ${lag}s OLDER than src/${path.relative(path.join(root, 'src'), src.file)}\n`
      + `  a browser test would measure the old code - build first: ${opts.rebuild ?? 'node scripts/build.mjs'}`,
    );
  }
  return { srcMs: src.ms, distMs: dist.ms };
}
