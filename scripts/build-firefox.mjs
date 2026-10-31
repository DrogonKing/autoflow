#!/usr/bin/env node
/**
 * The Firefox build.
 *
 * It used to be a full second copy of the build logic, differing only in the manifest. That is the shape that
 * drifts: a fix lands in `build.mjs` and not here, the Firefox artifact silently falls behind, and the tests
 * still pass because they run against the Chromium one.
 *
 * So this is now a thin entry point over the shared builder. `--lite` passes through.
 *
 *   node scripts/build-firefox.mjs          dist-firefox/
 *   node scripts/build-firefox.mjs --lite   dist-firefox-lite/
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = [path.join(here, 'build.mjs'), '--firefox', ...process.argv.slice(2)];
const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);