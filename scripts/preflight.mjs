#!/usr/bin/env node
/**
 * Fail early, and clearly, on a Node version this project cannot run.
 *
 * Why not `engines` + `engine-strict`: npm would refuse based on what dependencies DECLARE, and those
 * declarations are stricter than the behaviour. Measured:
 *
 *   Node 20.19.0   jsdom throws 11 unhandled "Cannot read properties of undefined (reading 'bind')" errors,
 *                  every one of the 381 tests reports as passed, and `vitest run` exits 1. A confusing
 *                  failure: the summary says success and the exit code says failure.
 *   Node 22.22.0   passes 381/381.
 *   Node 24.22.2   passes 381/381.
 *
 * jsdom declares `^22.22.2 || ^24.15.0 || >=26` and so does its css-color dependency, so `engine-strict`
 * would refuse 22.22.0 - a version that works. Declaring a requirement stricter than the behaviour is
 * common; enforcing it would be this project inventing a restriction it does not have.
 *
 * So the check is on the CAUSE rather than on the version number: `zlib.createZstdDecompress` landed in
 * Node 22.19, jsdom calls it unconditionally, and if it is missing nothing downstream can work.
 */
import zlib from 'node:zlib';

const MIN = '22.19.0';
const hasZstd = typeof zlib.createZstdDecompress === 'function';

if (hasZstd) {
  process.exit(0);
}

const v = process.versions.node;
console.error('');
console.error('  This project cannot run on Node ' + v + '.');
console.error('');
console.error('  Reason : jsdom (used by the test suite) calls zlib.createZstdDecompress, which does not');
console.error('           exist before Node ' + MIN + '. Without it jsdom throws unhandled errors, every test');
console.error('           still reports as PASSED, and the process exits 1 - so the failure looks like a');
console.error('           test failure when it is a runtime version problem.');
console.error('');
console.error('  Fix    : use Node ' + MIN + ' or newer. Verified working: 22.22.0 and 24.22.2.');
console.error('');
process.exit(1);
