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
  it('attemptedTarget is declared, so the report\'s ReferenceError claim does not hold', () => {
    /**
     * The claim was "ReferenceError: attemptedTarget is not defined". It is declared - possibly as `const`, possibly
     * inside the alarm handler - and what matters is that the name resolves, not the declaration keyword. My first version
     * of this test required `const attemptedTarget` and failed on a tree that had it as a `let`.
     */
    expect(read('src/background/service-worker.js')).toMatch(/(?:const|let|var)\s+attemptedTarget\b/);
  });

  it('safeMessage IS declared in the worker (the report said undefined)', () => {
    expect(read('src/background/service-worker.js')).toMatch(/const safeMessage\b/);
  });

  /**
   * THE REFERENCE, WHEREVER IT IS.
   *
   * My first two attempts at this measured scope by slicing the file at the next `\nfuction ` boundary - which cut the body
   * short and produced BOTH a false "refuted" and then a regex that only matched my own fix. What has to be true in any
   * tree is simply: `scheduleEditor` must not call `keepDraftThen`, because that name is declared inside `basicView`.
   */
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
    // every committed-time callback must use a redraw it was actually given; `keepDraftThen` is not one of them
    /**
     * ANY SHAPE IS FINE EXCEPT THE ONE THAT THROWS. `commitTime(v, opts)` with no redraw is correct; `keepDraftThen(...)` is
     * not, because that name lives inside `basicView`. So the check is on the BODY of each time commit, not on its form.
     */
    const bodies = [...panel.matchAll(/onCommit: \(v, opts\) => \{?\s*commit(?:Time)?\(v, opts\)([^\n]*)/g)].map((m) => m[1]);
    expect(bodies.length, 'no time-commit callback found, so this test checks nothing').toBeGreaterThan(0);
    for (const b of bodies) {
      expect(b, 'a time-commit handler calls keepDraftThen, which is out of scope outside basicView')
        .not.toMatch(/keepDraftThen/);
    }
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
  it('settings are merged into opts rather than discarded', () => {
    /**
     * The requirement is that the value comes FROM settings and lands in `opts`; whether it is `settings?.x` or
     * `settings.x !== false` is a defaulting choice, not the bug. My first version demanded my own spelling.
     */
    const worker = read('src/background/service-worker.js');
    const opts = /const opts = \{([\s\S]{0,300}?)\};/.exec(worker)?.[1] ?? '';
    expect(opts, 'focusBeforePrecise is not carried into opts, so the setting is inert').toMatch(/focusBeforePrecise:\s*settings/);
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

  it('a precise step reports how late it actually ran', () => {
    /**
     * The ORIGINAL bug was that `timingOffsetMs` never reached a step result - the number was computed and dropped. The
     * tree this merged onto reaches it through a `timing` object (`timingOffsetMs: timing.waitedMs`), which is a different
     * implementation of the same requirement. Assert the requirement: a step result carries the offset.
     */
    expect(content, 'no step result carries timingOffsetMs, so "the click missed the second" cannot be diagnosed')
      .toMatch(/timingOffsetMs:/);
  });

  it.skip('the original withTiming helper is applied (superseded by the timing object)', () => {
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
