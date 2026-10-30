/**
 * Verification tests for bug fixes and auto-click speed optimizations.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { realClick, fillElement, pressKeys } from '../src/core/dom/actions.js';
import { findElement, findAll, describeElement } from '../src/core/dom/finder.js';
import { findAnchor } from '../src/core/dom/anchor.js';
import { compare, evaluateCondition } from '../src/core/engine/conditions.js';
import { Runner } from '../src/core/engine/runner.js';
import { DEFAULT_OPTIONS, makeStep, validateStep, countSteps } from '../src/core/model/steps.js';
import { wantsPreciseTiming } from '../src/core/schedule/schedule.js';
import { rescheduleAll, listScheduled, ALARM_PREFIX } from '../src/background/alarms.js';
import { makeCloneable, bytesToBase64 } from '../src/platform/serialise.js';
import { pushEvent, decisionTrail } from '../src/core/diag/events.js';
import { buildDecisionLines, exportAsText } from '../src/core/diag/report.js';
import { readCsv } from '../src/core/io/csv.js';
import { resolveLanguage, translate, translator } from '../src/core/i18n/i18n.js';
import { en, fa } from '../src/core/i18n/catalogue.js';

function setDom(html) {
  document.body.innerHTML = html;
  return document;
}

describe('auto-click speed & in-page burst optimizations', () => {
  it('defaults stepDelayMs to 0 so clicks are not throttled by 120ms out of the box', () => {
    expect(DEFAULT_OPTIONS.stepDelayMs).toBe(0);
  });

  it('validates click repeat and repeatGapMs for high-speed in-page burst clicking', () => {
    expect(() => validateStep(makeStep('click', {
      finder: { strategy: 'css', selector: '#buy' },
      repeat: 50,
      repeatGapMs: 0,
    }))).not.toThrow();

    expect(() => validateStep(makeStep('click', {
      finder: { strategy: 'css', selector: '#buy' },
      repeat: 0,
    }))).toThrow(/repeat must be an integer/);

    expect(() => validateStep(makeStep('click', {
      finder: { strategy: 'css', selector: '#buy' },
      repeat: 10,
      repeatGapMs: -5,
    }))).toThrow(/repeatGapMs must be between 0 and 60000/);
  });

  it('skips scrollIntoView when the target element is already inside the viewport', () => {
    setDom('<button id="fast">Buy</button>');
    const btn = document.getElementById('fast');
    btn.getBoundingClientRect = () => ({
      top: 20, left: 20, bottom: 60, right: 120, width: 100, height: 40, x: 20, y: 20,
    });
    btn.scrollIntoView = vi.fn();
    realClick(btn);
    expect(btn.scrollIntoView).not.toHaveBeenCalled();
  });

  it('executes an in-page repeat click burst in content.js without worker round-trips', async () => {
    vi.resetModules();
    setDom('<button id="burst">Order</button>');
    let clicks = 0;
    document.getElementById('burst').addEventListener('click', () => { clicks += 1; });

    const listeners = [];
    globalThis.chrome = {
      runtime: {
        id: 'test-ext',
        getManifest: () => ({ version: '1.25.0' }),
        getURL: (p) => `chrome-extension://test-ext/${p}`,
        sendMessage: async () => ({ ok: true }),
        onMessage: { addListener: (fn) => listeners.push(fn) },
      },
    };

    await import('../src/content/content.js');
    expect(listeners).toHaveLength(1);

    const response = await new Promise((resolve) => {
      listeners[0](
        {
          type: 'perform-step',
          step: {
            id: 's1',
            kind: 'click',
            finder: { strategy: 'css', selector: '#burst' },
            repeat: 25,
            repeatGapMs: 0,
          },
        },
        { id: 'test-ext', url: 'chrome-extension://test-ext/background.js' },
        resolve,
      );
    });

    expect(response?.ok).toBe(true);
    expect(response?.result?.repeated).toBe(25);
    expect(clicks).toBe(25);
  });
});

describe('DOM, finder, actions, conditions & runner bug fixes', () => {
  it('handles an empty CSS selector in findElement and findAll without throwing FinderError', () => {
    setDom('<button>One</button>');
    const single = findElement(document, { strategy: 'css', selector: '' });
    expect(single.element).toBeNull();
    expect(single.candidates).toBe(0);

    const all = findAll(document, { strategy: 'css', selector: '' });
    expect(all.elements).toEqual([]);
    expect(all.total).toBe(0);
  });

  it('dispatches right-click and middle-click on links with the requested button code', () => {
    setDom('<a id="lnk" href="https://example.com">Link</a>');
    const a = document.getElementById('lnk');
    const seen = [];
    a.addEventListener('click', (e) => {
      e.preventDefault();
      seen.push(e.button);
    });
    realClick(a, { button: 'right', clickCount: 1 });
    realClick(a, { button: 'middle', clickCount: 1 });
    expect(seen).toEqual([2, 1]);
  });

  it('fillElement with clearFirst: false does not blank the input first', () => {
    setDom('<input id="inp" value="abc">');
    const inp = document.getElementById('inp');
    const valuesOnInput = [];
    inp.addEventListener('input', () => valuesOnInput.push(inp.value));
    fillElement(inp, '123', { clearFirst: false });
    expect(inp.value).toBe('abc123');
    expect(valuesOnInput).toEqual(['abc123']);
  });

  it('pressKeys handles "+", releases modifiers on keyup, and does not insert "Enter" as text', async () => {
    setDom('<input id="k"><input type="checkbox" id="cb" value="on">');
    const inp = document.getElementById('k');
    await pressKeys(inp, ['a', 'Enter']);
    expect(inp.value).toBe('a');

    await pressKeys(inp, '+');
    expect(inp.value).toBe('a+');

    const cb = document.getElementById('cb');
    await pressKeys(cb, 'x');
    expect(cb.value).toBe('on');

    const upEvents = [];
    inp.addEventListener('keyup', (e) => upEvents.push({ key: e.key, ctrlKey: e.ctrlKey }));
    await pressKeys(inp, 'ctrl+k');
    const ctrlUp = upEvents.find((e) => e.key === 'Control');
    expect(ctrlUp?.ctrlKey).toBe(false);
  });

  it('anchor skips data-v-* and data-ng-* vendor attributes', () => {
    setDom('<div data-v-123="scoped"><button id="b">Buy</button></div>');
    const anchor = findAnchor(document.getElementById('b'), document);
    expect(anchor.selector).toBe('#b');
  });

  it('numeric and count comparators support Persian digits/commas and reject null or empty strings', () => {
    expect(compare('gt', '۱,۲۵۰', '1000')).toBe(true);
    expect(compare('countEq', '۳', '3')).toBe(true);
    expect(() => compare('lt', null, '1')).toThrow(/can only compare numbers/);
    expect(() => compare('gt', '', '0')).toThrow(/can only compare numbers/);
  });

  it('evaluateCondition short-circuits sub-conditions when the primary condition already decides', async () => {
    let calls = 0;
    const read = () => {
      calls += 1;
      return { value: 'no', found: true, flags: {} };
    };
    const cond = {
      finder: { strategy: 'css', selector: '#a' },
      source: 'text',
      comparator: 'eq',
      value: 'yes',
      combine: 'all',
      also: [{ finder: { strategy: 'css', selector: '#b' }, source: 'text', comparator: 'eq', value: 'yes' }],
    };
    const res = await evaluateCondition(cond, { read });
    expect(res).toBe(false);
    expect(calls).toBe(1);
  });

  it('runner counts loop iterations accurately when continue is used', async () => {
    const trace = [];
    const host = {
      isAlive: async () => true,
      now: () => 1000,
      sleep: async () => {},
      stopRequested: () => false,
      onTrace: (e) => trace.push(e),
      execute: async () => ({ ok: true }),
    };
    const r = await new Runner(host).run({
      id: 'loop-continue',
      name: 'loop continue',
      schedule: { kind: 'manual' },
      options: { stepDelayMs: 0 },
      steps: [
        makeStep('loop', {
          loopType: 'count',
          count: 3,
          steps: [makeStep('continue')],
        }),
      ],
    });
    expect(r.reason).toBe('finished');
    const loopEnd = trace.find((t) => t.type === 'loop-end');
    expect(loopEnd?.iterations).toBe(3);
  });

  it('content.js waitFor works for url, count, and initially-missing elements, and extract handles missing elements', async () => {
    vi.resetModules();
    setDom('<div class="item">1</div><div class="item">2</div>');
    const listeners = [];
    globalThis.chrome = {
      runtime: {
        id: 'test-ext',
        getManifest: () => ({ version: '1.25.0' }),
        getURL: (p) => `chrome-extension://test-ext/${p}`,
        sendMessage: async () => ({ ok: true }),
        onMessage: { addListener: (fn) => listeners.push(fn) },
      },
    };
    await import('../src/content/content.js');
    const callStep = (step) => new Promise((resolve) => {
      listeners[0](
        { type: 'perform-step', step },
        { id: 'test-ext', url: 'chrome-extension://test-ext/background.js' },
        resolve,
      );
    });

    // extract on missing element returns '' without throwing
    const extRes = await callStep({
      id: 'e1',
      kind: 'extract',
      name: 'missingVar',
      source: 'text',
      finder: { strategy: 'css', selector: '#not-here' },
    });
    expect(extRes?.ok).toBe(true);
    expect(extRes?.result?.value).toBe('');
    expect(extRes?.result?.found).toBe(false);

    // waitFor countEq
    const countRes = await callStep({
      id: 'w1',
      kind: 'waitFor',
      finder: { strategy: 'css', selector: '.item' },
      condition: { source: 'count', comparator: 'countEq', value: '2' },
      timeoutMs: 500,
      pollMs: 50,
    });
    expect(countRes?.ok).toBe(true);

    // waitFor url contains
    const urlRes = await callStep({
      id: 'w2',
      kind: 'waitFor',
      condition: { source: 'url', comparator: 'contains', value: location.protocol },
      timeoutMs: 500,
      pollMs: 50,
    });
    expect(urlRes?.ok).toBe(true);
  });
});

describe('scheduler, alarms, diagnostics, serialise & i18n bug fixes', () => {
  it('recognizes 6-field cron expressions as wanting precise timing', () => {
    expect(wantsPreciseTiming({ kind: 'cron', expression: '0 0 9 * * 1-5' })).toBe(true);
    expect(wantsPreciseTiming({ kind: 'cron', expression: '0 9 * * 1-5' })).toBe(false);
  });

  it('clears obsolete alarms in rescheduleAll when a schedule has no future occurrence', async () => {
    const alarms = new Map([[`${ALARM_PREFIX}old-once`, { name: `${ALARM_PREFIX}old-once`, scheduledTime: 1000 }]]);
    globalThis.chrome = {
      runtime: { id: 'test' },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      alarms: {
        create: async (name, info) => alarms.set(name, { name, scheduledTime: info.when }),
        getAll: async () => [...alarms.values()],
        clear: async (name) => alarms.delete(name),
      },
    };
    const now = 1_700_000_000_000;
    const res = await rescheduleAll([
      {
        id: 'old-once',
        name: 'Past one-shot',
        enabled: true,
        schedule: { kind: 'once', at: now - 500_000 },
        steps: [makeStep('click', { finder: { strategy: 'css', selector: '#a' } })],
      },
    ], { now });
    expect(res[0].ok).toBe(false);
    expect(alarms.has(`${ALARM_PREFIX}old-once`)).toBe(false);
  });

  it('makeCloneable preserves shared references while replacing true cycles', () => {
    const shared = { a: 1 };
    const dag = { first: shared, second: shared };
    const clonedDag = makeCloneable(dag).value;
    expect(clonedDag.first).toEqual({ a: 1 });
    expect(clonedDag.second).toEqual({ a: 1 });

    const cyclic = { name: 'loop' };
    cyclic.self = cyclic;
    const clonedCycle = makeCloneable(cyclic).value;
    expect(clonedCycle.self).toBe('[circular]');
  });

  it('bytesToBase64 works without FileReader (MV3 service worker environment)', async () => {
    const orig = globalThis.FileReader;
    globalThis.FileReader = undefined;
    try {
      const blob = new Blob(['hello world'], { type: 'text/plain' });
      const b64 = await bytesToBase64(blob);
      expect(b64).toBe(btoa('hello world'));
    } finally {
      globalThis.FileReader = orig;
    }
  });

  it('pushEvent does not overwrite timestamp when event.at is undefined, and decisionTrail includes tab events', () => {
    const list = pushEvent([], { kind: 'start-accepted', automationId: 'a1', at: undefined });
    expect(Number.isFinite(list[0].at)).toBe(true);

    const trail = decisionTrail([
      { kind: 'tab-from-memory', automationId: 'a1', url: 'https://example.com', at: 1000 },
      { kind: 'start-accepted', automationId: 'a1', trigger: 'schedule', at: 1005 },
    ]);
    expect(trail).toHaveLength(2);
    const lines = buildDecisionLines(trail);
    expect(lines[1]).not.toContain('undefined');
  });

  it('exportAsText formats cron expression and interval schedules cleanly', () => {
    const text = exportAsText({
      header: { autoflowVersion: '1.25.0' },
      automations: [
        { id: 'c1', name: 'CronJob', enabled: true, schedule: { kind: 'cron', expression: '0 0 9 * * *' }, steps: [] },
        { id: 'i1', name: 'IntJob', enabled: true, schedule: { kind: 'interval', everyMs: 5000 }, steps: [] },
      ],
    });
    expect(text).toContain('0 0 9 * * *');
    expect(text).toContain('every 5000ms');
    expect(text).not.toContain('--:00');
  });

  it('readCsv reports the actual detected delimiter instead of "auto"', () => {
    const parsed = readCsv('name;price\nfoo;100\nbar;200');
    expect(parsed.delimiter).toBe(';');
  });

  it('i18n rejects Object.prototype keys and every static UI t() key exists in both catalogues', () => {
    expect(resolveLanguage('constructor', 'en')).toBe('en');
    expect(translate('en', 'toString')).toBe('toString');
    expect(translator('en').has('constructor')).toBe(false);

    const uiFiles = ['src/ui/panel/panel.js', 'src/ui/options/options.js'];
    const missing = [];
    for (const file of uiFiles) {
      const raw = readFileSync(file, 'utf8');
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
        const key = m[1];
        if (!Object.hasOwn(en, key) || !Object.hasOwn(fa, key)) {
          missing.push(`${file}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('countSteps safely handles undefined or non-array inputs', () => {
    expect(countSteps(undefined)).toBe(0);
    expect(countSteps(null)).toBe(0);
  });
});
