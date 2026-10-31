import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom for the DOM-facing modules; the pure core modules do not care either way.
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    // A real browser is used by the browser test, which spawns Chromium itself.
    testTimeout: 30_000,
  },
  // `__LITE__` is a BUILD-TIME constant that esbuild substitutes (see scripts/build.mjs). The unit tests import the
  // source directly, so without this they would see a bare identifier and throw a ReferenceError. Defined here as
  // `false`, the tests exercise the FULL build - which is the right default, because a guard that accidentally hid
  // something in the normal tree is exactly the regression worth catching.
  define: {
    __LITE__: 'false',
  },
});
