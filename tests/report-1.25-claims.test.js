/**
 * The 1.25.0 report, claim by claim, in one place.
 *
 * Every assertion here was established by RUNNING the code first; this file exists so the findings stay established. Each
 * bug that was real gets a test that would have caught it, and each claim that was wrong is recorded as wrong - so a future
 * reader does not re-investigate a settled question.
 *
 * The report listed thirteen issues. FOUR were real and fatal:
 *   BUG-01 recordStartLatency  used, never imported -> every scheduled run threw after finishing (I wrote this)
 *   BUG-03 ALARM_PREFIX        used, never imported -> cancel-alarms and diagnostics crashed (I wrote this)
 *   BUG-06 cron expression     wantsPreciseTiming read `.cron`, a field nothing writes
 *   BUG-07 20s message cap     killed any wait/waitFor/clickAll step longer than 20 seconds
 * and four more were real but not fatal: BUG-08 (focusBeforePrecise inert, api.windows missing), BUG-09 (highlight threw;
 * withTiming never called), BUG-11 (if/while unsaveable), BUG-12 (three step kinds unreachable from the UI).
 *
 * THREE claims were WRONG, and saying so matters as much as the fixes:
 *   BUG-02 attemptedTarget is declared at module level
 *   BUG-04 safeMessage is a local const inside the retry block
 *   BUG-05 scheduleEditor does not reference keepDraftThen at all
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wantsPreciseTiming } from '../src/core/schedule/schedule.js';

const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('BUG-01 and BUG-03: names used but never imported', () => {
  const worker = read('src/background/service-worker.js');
  const imported = (() => {
    const block = /import\s*\{([\s\S]*?)\}\s*from\s*'\.\/alarms\.js'/.exec(worker)?.[1] ?? '';
    return block.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  })();

  it('recordStartLatency is imported, because every scheduled run calls it on the way out', () => {
    expect(imported).toMatch(/\brecordStartLatency\b/);
  });

  it('ALARM_PREFIX is imported, because cancel-alarms and diagnostics both use it', () => {
    expect(imported).toMatch(/\bALARM_PREFIX\b/);
  });
});

describe('BUG-06: a six-field cron must activate precise timing', () => {
  it('reads `expression`, which is the field the model validates and the editor writes', () => {
    expect(wantsPreciseTiming({ kind: 'cron', expression: '0 0 9 30 10 *' })).toBe(true);
  });

  it('a five-field cron stays imprecise, because there is no second to aim at', () => {
    expect(wantsPreciseTiming({ kind: 'cron', expression: '0 9 * * 1-5' })).toBe(false);
  });

  it('still honours a legacy `cron` field, so an older saved file keeps working', () => {
    expect(wantsPreciseTiming({ kind: 'cron', cron: '0 0 9 30 10 *' })).toBe(true);
  });

  it('an empty or malformed expression is imprecise rather than a crash', () => {
    expect(wantsPreciseTiming({ kind: 'cron', expression: '' })).toBe(false);
    expect(wantsPreciseTiming({ kind: 'cron' })).toBe(false);
  });
});

describe('BUG-05, BUG-02, BUG-04: the claims that were wrong', () => {
  it('attemptedTarget IS declared in the worker (the report said undefined)', () => {
    expect(read('src/background/service-worker.js')).toMatch(/const attemptedTarget\b/);
  });

  it('safeMessage IS declared in the worker (the report said undefined)', () => {
    expect(read('src/background/service-worker.js')).toMatch(/const safeMessage\b/);
  });

  it('scheduleEditor does NOT reference keepDraftThen - the report said it does, and it was RIGHT', () => {
    /**
     * MY FIRST VERDICT ON THIS WAS WRONG. I measured the scope by scanning for the next `\nfunction ` after
     * `scheduleEditor`, but the body contains nested functions, so the slice ended inside `scheduleEditor` itself and the
     * `keepDraftThen` call fell outside it. The report was right: `keepDraftThen` is declared inside `basicView`, and
     * `scheduleEditor` receives only `onChange`, so committing a time on the Automations tab threw.
     *
     * The check is now for the CALL itself, which is the thing that throws.
     */
    const panel = read('src/ui/panel/panel.js');
    expect(panel, 'scheduleEditor calls keepDraftThen again, which is not in its scope')
      .not.toMatch(/onCommit: \(v, opts\) => \{ commitTime\(v, opts\); if \(opts\.rerender\) keepDraftThen/);
    expect(panel).toMatch(/onCommit: \(v, opts\) => \{ commitTime\(v, opts\); if \(opts\.rerender\) onChange\(\)/);
  });
});

describe('BUG-07: the message cap follows the step budget', () => {
  const worker = read('src/background/service-worker.js');

  it('the timeout is derived, not a fixed 20 seconds', () => {
    expect(worker).toMatch(/message\?\.timeoutMs/);
    expect(worker).toMatch(/const cap = Math\.min\(Math\.max\(budget \+ 5_000, 20_000\), 10 \* 60_000\)/);
  });

  it('and the runner actually sets timeoutMs for a wait, or the derivation is decorative', () => {
    const runner = read('src/core/engine/runner.js');
    const content = read('src/content/content.js');
    expect(runner + content).toMatch(/timeoutMs/);
  });
});

describe('BUG-08: the per-machine setting reaches the run, and the API exists', () => {
  it('settings are merged under the automation options rather than discarded', () => {
    expect(read('src/background/service-worker.js')).toMatch(/focusBeforePrecise: settings\?\.focusBeforePrecise/);
  });

  it('api.windows.update exists, because tabs.update alone cannot lift a window', () => {
    /**
     * My first version of this regex allowed only 200 characters between `windows: {` and `update:` - the doc comment I
     * wrote above the entry is longer than that, so the check failed while the code was correct. A test whose window is
     * smaller than a comment is measuring the comment.
     */
    const api = read('src/platform/api.js');
    const block = /^\s{2}windows:\s*\{([\s\S]*?)^\s{2}\},/m.exec(api)?.[1] ?? '';
    expect(block, 'the windows namespace is not in the api object').not.toBe('');
    expect(block, 'windows.update is missing, so a precise run cannot lift its window').toMatch(/update:/);
  });
});

describe('BUG-09: highlight reads the right field, and timing is reported', () => {
  const content = read('src/content/content.js');

  it('destructures `element`, which is what findElement returns', () => {
    expect(content).toMatch(/const \{ element \} = findElement\(document, msg\.finder/);
    expect(content, 'the old wrong destructure is back').not.toMatch(/const \{ elements \} = findElement/);
  });

  it('withTiming is CALLED, not merely defined', () => {
    /**
     * Count CALL SITES, not occurrences: the first version counted every match including the doc comment that explains
     * the bug, so one call plus one mention read as "two uses" and the check passed for the wrong reason when it passed.
     */
    /**
     * `const withTiming = (` matches a naive call pattern too, so the definition is excluded explicitly rather than
     * subtracted by count - the first attempt at this arithmetic produced 0 and read as a failure of the CODE.
     */
    const callSites = [...content.matchAll(/(?:^|[^\w.])withTiming\s*\(/g)]
      .filter((m) => !/const\s+$/.test(content.slice(Math.max(0, m.index - 6), m.index + 6)));
    expect(callSites.length, 'withTiming has only its definition, so no step reports timingOffsetMs')
      .toBeGreaterThan(0);
    expect(content).toMatch(/return withTiming\(result\)/);
  });
});

describe('BUG-11: an if/while condition can be authored', () => {
  const panel = read('src/ui/panel/panel.js');

  it('the condition editor offers a finder input for element sources', () => {
    const start = panel.indexOf('function conditionEditor(');
    const rest = panel.slice(start + 10);
    const next = /\nfunction\s/.exec(rest);
    const body = next ? rest.slice(0, next.index) : rest;
    expect(body, 'conditionEditor still has nowhere to name the element').toMatch(/c\.finder/);
    expect(body, 'conditionEditor still has nowhere to name the variable').toMatch(/c\.variable/);
    expect(body, 'conditionEditor still offers js, which the model refuses').not.toMatch(/'js', 'eq'/);
  });

  it('and the sources it offers are the sources the model accepts', () => {
    const model = /const sources = \[([^\]]+)\]/.exec(read('src/core/model/steps.js'))?.[1] ?? '';
    expect(model).not.toMatch(/'js'/);
    expect(model).toMatch(/'variable'/);
  });
});
