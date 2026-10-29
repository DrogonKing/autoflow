import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom for the DOM-facing modules; the pure core modules do not care either way.
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    // A real browser is used by the browser test, which spawns Chromium itself.
    testTimeout: 30_000,
  },
});
