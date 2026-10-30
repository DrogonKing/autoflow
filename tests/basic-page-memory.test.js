/**
 * A Basic automation has NO URL PATTERN, and a scheduled run must still know where to go.
 *
 * THE USER'S EXPORT, 1.19.0:
 *
 *     -- runs --
 *     -  basic  step-error  steps=0  0ms  ERROR: this automation has no URL pattern, so a scheduled run has no safe
 *        tab - add one, or run it by hand
 *
 * The Basic form never asks for a URL, so every automation built there had `urls: []`. Removing the active-tab fallback
 * was correct - measured, it delivered clicks to whatever page the user happened to have in front (B5) - but it left
 * these automations unable to run on a schedule AT ALL, which is worse than the bug it fixed.
 *
 * The page is not unknown: it is the page the user was looking at when they picked the element. So it is recorded at
 * pick time and used as the last resort, after the patterns have been tried.
 */
import { beforeEach, describe, expect, it } from 'vitest';

/** A fake chrome that can open tabs and remembers storage, so the alarm path can be driven for real. */
function installFakeChrome(tabs = []) {
  const store = {};
  const created = [];
  let nextTabId = 900;
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      id: 'test', getURL: (p) => p,
      onMessage: { addListener: (f) => listeners.push(f) },
      sendMessage: async () => {},
      getManifest: () => ({ version: '1.9.9' }),
    },
    tabs: {
      query: async () => tabs.map((t) => ({ ...t })),
      create: async ({ url }) => { const t = { id: nextTabId++, url }; created.push(t); tabs.push(t); return t; },
      sendMessage: async () => ({ ok: true }),
      reload: async () => {},
      update: async () => {},
    },
    alarms: {
      create: async () => {}, clear: async () => {}, getAll: async () => [], get: async () => undefined,
    },
    storage: {
      local: {
        get: async (k) => (k === null ? { ...store } : { [k]: store[k] }),
        set: async (o) => Object.assign(store, o),
        remove: async (k) => { delete store[k]; },
      },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    scripting: { executeScript: async () => [{ result: null }] },
  };
  return { store, created, tabs, listeners };
}

describe('a scheduled run with no URL pattern uses the page its pick came from', () => {
  beforeEach(() => { installFakeChrome([{ id: 1, url: 'file:///C:/Users/x/autoflow-test-field.html' }]); });

  it('remembers the page a pick came from, per automation', async () => {
    const { store } = installFakeChrome([{ id: 1, url: 'file:///a.html' }]);
    const { getSettings, saveSettings } = await import('../src/background/storage.js');

    // the shape the worker writes
    await saveSettings({ lastPickPages: { basic: 'file:///a.html' } });
    const s = await getSettings();
    expect(s.lastPickPages.basic).toBe('file:///a.html');

    // and it really is in storage, not in memory
    expect(Object.keys(store).some((k) => k.includes('settings'))).toBe(true);
  });

  it('two automations remember different pages', async () => {
    installFakeChrome([{ id: 1, url: 'file:///a.html' }]);
    const { getSettings, saveSettings } = await import('../src/background/storage.js');
    await saveSettings({ lastPickPages: { basic: 'file:///a.html', other: 'https://x.test/' } });
    const s = await getSettings();
    expect(s.lastPickPages).toEqual({ basic: 'file:///a.html', other: 'https://x.test/' });
  });

  it('the alarm path consults the remembered page before refusing', async () => {
    /**
     * Read the handler's source rather than booting the worker: what matters is that the remembered page is tried, and
     * that the refusal only follows it. A behavioural test of the whole alarm path needs a live browser, which
     * `multi-schedule-test` covers.
     */
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/background/service-worker.js'), 'utf8');

    const memory = src.indexOf('lastPickPages?.[id]');
    expect(memory, 'the alarm path never consults the remembered page').toBeGreaterThan(0);

    const refusal = src.indexOf('has never had an element picked in it');
    expect(refusal, 'the refusal message was not updated').toBeGreaterThan(0);
    expect(memory, 'the remembered page is consulted after the refusal, so it can never run')
      .toBeLessThan(refusal);
  });

  it('the content script sends its own url with a pick, so the record is not a guess', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/content/content.js'), 'utf8');
    expect(src).toMatch(/type: 'element-picked'[\s\S]{0,120}url: location\.href/);
  });

  it('but a PAGE cannot change where an automation points', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/background/service-worker.js'), 'utf8');
    const list = /const CONTENT_SCRIPT_MESSAGES = new Set\(\[([\s\S]*?)\]\);/.exec(src)?.[1] ?? '';
    expect(list, 'a page must not be able to redirect an automation').not.toMatch(/remember-pick-page/);
  });
});