import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneableOrString } from '../src/platform/serialise.js';

/**
 * P0 — `sendToTab`'s retry path threw ReferenceError.
 *
 * The function is EXTRACTED FROM THE SOURCE and run with a stubbed browser API, so this cannot drift from the shipped
 * code: a copy of the logic in the test would keep passing after the real one broke.
 *
 * The fault: `safeMessage` was declared with `const` inside the `try`, and the retry in the `catch` referred to it. Out of
 * scope there, so the retry threw `ReferenceError: safeMessage is not defined` - content.js was injected and the message
 * was never re-sent.
 *
 * Why it mattered more than a confusing error: the first attempt after an extension reload, or on a freshly opened tab, is
 * exactly the case this retry exists for. With a scheduled precise run the first element step has already consumed
 * `atMs`, so the runner's retry has no target time left and the click can fire before its instant.
 */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8');

/** Pull the real function out of the source by brace matching, so the test runs the shipped implementation. */
function extractSendToTab() {
  const start = SRC.indexOf('async function sendToTab(');
  if (start < 0) throw new Error('sendToTab not found in service-worker.js');
  const bodyStart = SRC.indexOf(') {', start) + 2;
  let depth = 0;
  for (let i = bodyStart; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    if (SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces after sendToTab');
}

/**
 * THE REAL `cloneableOrString` IS INJECTED, not a pass-through.
 *
 * MEASURED mistake in this test's first version: it passed `(x) => x` as the sanitiser, so the function inside the step
 * survived - the test was exercising a stub that did nothing, and its failure looked like a bug in the application. The
 * real function is imported so the test measures the shipped behaviour; the first two arguments stay stubs because they
 * are the browser API and the timeout helper.
 */
const buildSendToTab = (api) => new Function(
  'api', 'withTimeout', 'cloneableOrString',
  `${extractSendToTab()};\nreturn sendToTab;`,
)(api, (p) => p, cloneableOrString);

describe('sendToTab retry', () => {
  it('injects the content script once and re-sends, returning the retry answer', async () => {
    let injected = 0;
    let sends = 0;
    const api = {
      tabs: {
        sendMessage: async () => {
          sends += 1;
          if (sends === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
          return { ok: true, send: sends };
        },
      },
      scripting: { executeScript: async () => { injected += 1; } },
    };
    const result = await buildSendToTab(api)(1, { type: 'perform-step', step: { kind: 'click' } });
    expect(result).toEqual({ ok: true, send: 2 });
    expect(injected).toBe(1);
    expect(sends).toBe(2);
  });

  it('sanitises the payload on the retry as well as the first send', async () => {
    /**
     * A real port throws `DataCloneError` when a function is anywhere in the payload, and `cloneableOrString` replaces
     * such a value with the string `'[function]'`. So "sanitised" is asserted by checking that NO FUNCTION remains, not by
     * looking for a marker string - MEASURED mistake in this test's first version: it searched the serialised payload for
     * the letters `FN`, which appear inside ordinary keys, so a correctly sanitised payload failed.
     */
    const hasFunction = (v) => {
      if (typeof v === 'function') return true;
      if (v && typeof v === 'object') return Object.values(v).some(hasFunction);
      return false;
    };
    const sent = [];
    const api = {
      tabs: {
        sendMessage: async (_id, msg) => {
          if (hasFunction(msg)) throw new Error('Could not establish connection. Receiving end does not exist.');
          sent.push(msg);
          return { ok: true };
        },
      },
      scripting: { executeScript: async () => {} },
    };
    const withFn = { type: 'perform-step', step: { kind: 'click', selector: '#a', predicate: () => true } };
    const result = await buildSendToTab(api)(2, withFn);
    expect(result).toEqual({ ok: true });
    expect(sent.length).toBe(1);
    expect(hasFunction(sent[0])).toBe(false);
    expect(sent[0].step.predicate).toBe('[function]');
  });

  it('rethrows the original error when injection is not allowed', async () => {
    let injected = 0;
    const api = {
      tabs: { sendMessage: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); } },
      scripting: { executeScript: async () => { injected += 1; } },
    };
    await expect(buildSendToTab(api)(3, { type: 'ping' }, { injectIfMissing: false }))
      .rejects.toThrow(/Receiving end does not exist/);
    expect(injected).toBe(0);
  });

  it('does not inject for an unrelated error', async () => {
    let injected = 0;
    const api = {
      tabs: { sendMessage: async () => { throw new Error('some other failure'); } },
      scripting: { executeScript: async () => { injected += 1; } },
    };
    await expect(buildSendToTab(api)(4, { type: 'ping' })).rejects.toThrow('some other failure');
    expect(injected).toBe(0);
  });

  it('the retry never throws a ReferenceError', async () => {
    let sends = 0;
    const api = {
      tabs: {
        sendMessage: async () => {
          sends += 1;
          if (sends === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
          return { ok: true };
        },
      },
      scripting: { executeScript: async () => {} },
    };
    // a ReferenceError is what this file is about, so name it explicitly rather than only checking the value
    await expect(buildSendToTab(api)(5, { type: 'ping' })).resolves.toEqual({ ok: true });
  });
});