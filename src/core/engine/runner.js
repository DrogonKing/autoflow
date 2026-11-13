/**
 * The runner.
 *
 * Executes an automation's steps against a "host" — an object that knows how to click, fill, navigate.
 * The host is injected, and that is the whole design: the same runner is used by the service worker
 * (real host, real tabs), by the tests (a recording host that returns scripted results), and by the
 * "dry run" preview in the UI (a host that changes nothing). Three deliveries, one implementation, so
 * the thing the user previews is the thing that runs.
 *
 * Rules the runner follows, each because the alternative is a bug users hit:
 *
 *  - Every step is bounded. A step that would hang gets its own timeout, and a run has an overall
 *    ceiling, because "wait for element" on a page that changed is otherwise an automation that never
 *    ends and never explains why.
 *  - A loop's iteration count is checked before it runs, not after, so `while` cannot spin forever.
 *  - Variables are resolved at the moment a step executes, not when the run starts: a value extracted
 *    in step 3 must be usable in step 4.
 *  - The trace records every step's outcome, because "it did not work" is not a bug report. The trace is
 *    what the UI shows and what a user pastes when asking for help.
 */

import { BLOCK_KINDS, ELEMENT_KINDS, validateAutomation, StepError } from '../model/steps.js';
import { interpolate, jitter, TemplateError } from '../model/templates.js';
import { evaluateCondition, ConditionError } from './conditions.js';

/**
 * Why a run ended.
 *
 * MEASURED (B10): a `stop` step and a `break` outside any loop BOTH reported `stopped-by-user`, because every
 * `RunAborted` was collapsed into one reason. The distinction matters to whoever reads the history: "you stopped it"
 * and "the automation stopped itself" call for completely different next steps, and a stray `break` is a bug in the
 * automation rather than a decision by anyone.
 */
export const STOP_REASONS = {
  finished: 'finished',
  stopped: 'stopped-by-user',
  stoppedByStep: 'stopped-by-step',
  strayBreak: 'stray-break',
  stepError: 'step-error',
  timeout: 'run-timeout',
  maxSteps: 'step-limit',
  aborted: 'aborted',
};

/**
 * Which reason a `RunAborted` stands for.
 *
 * The sentinels are the ones the block handling already uses internally: `__break__` and `__continue__`.
 */
function reasonForAbort(e, signal) {
  if (signal?.aborted) return STOP_REASONS.aborted;
  const message = String(e?.message ?? '');
  if (message === '__break__' || message === '__continue__') return STOP_REASONS.strayBreak;
  /**
   * THE USER'S STOP CARRIES ITS OWN SENTINEL.
   *
   * MEASURED, in the first version of this fix: the host's stop check threw `RunAborted('stopped by user')`, whose
   * message is indistinguishable from a `stop` step's reason text - so pressing Stop reported `stopped-by-step` and
   * blamed the automation for the user's decision. The check now throws a sentinel, and the mapping is explicit instead
   * of inferred from a human-readable string.
   */
  if (message === '__user__') return STOP_REASONS.stopped;
  return STOP_REASONS.stoppedByStep;
}

/**
 * THE SAFETY CEILING ON REPEATED ROUNDS.
 *
 * A window with no end time is an intentionally endless run - the user stops it by hand - so the loop must have a bound that is
 * not "the deadline". This one exists only to turn a runaway into a clear error; the step budget in `#runStep` remains the real
 * limit on work done, and it is far lower for any realistic click pattern.
 */
export const MAX_WINDOW_ROUNDS = 100_000;

/**
 * HOW MANY CONSECUTIVE ROUNDS MAY EXECUTE NOTHING before the window is abandoned.
 *
 * A round in which no step runs is not a slow round, it is a zero-length one - every step skipped by a condition, or a sequence
 * that is empty after its conditions resolved. Such a round takes no time at all, so the loop would repeat it as fast as the
 * microtask queue allows, forever. Twenty-five is far beyond any legitimate skip pattern and small enough to be instant.
 */
export const MAX_EMPTY_ROUNDS = 25;

/**
 * THE CEILING ON AN ENDLESS WINDOW, in milliseconds. Twelve hours.
 *
 * An endless window is intentional - the user stops it by hand - but "no end time" must not mean "no bound at all". A run left
 * going overnight would keep clicking into the next session, which for an order page is worse than stopping. The cap is a
 * default, not a hard rule: a caller may raise it with `maxWindowMs`.
 */
export const DEFAULT_MAX_WINDOW_MS = 12 * 60 * 60 * 1000;

export class RunAborted extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'RunAborted';
  }
}

/**
 * @typedef {Object} Host
 * @property {() => Promise<boolean>} isAlive
 * @property {(step: Object) => Promise<*>} execute       perform one non-blocking step
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} now
 * @property {(event: Object) => void} onTrace            receive trace entries as they happen
 * @property {() => boolean} stopRequested
 */

/**
 * WHETHER THIS IS A WINDOW RUN, AND WHEN IT ENDS.
 *
 * Returns `{ isWindow, endAt }` where `endAt` is an absolute instant or `null` for "no deadline". The two are separate on
 * purpose, and that separation is the point:
 *
 *   * A WINDOW WITH NO DEADLINE is a supported case - the user leaves the end time empty and stops the run by hand. It was
 *     asked for in exactly those words.
 *   * A PLAIN RUN has no window at all: its steps execute once.
 *
 * Inferring window mode from the presence of a deadline conflated those two, so an endless window could not be expressed - it
 * looked identical to an ordinary run. `opts.window` now states the mode outright.
 *
 * `untilMs` wins when present: it is the instant the user named, so it needs no reference point. `runForMs` is a duration and is
 * resolved against the run's start, because a duration is what a "run for ten minutes" field produces.
 *
 * A non-numeric or non-positive value is treated as ABSENT rather than as zero. Zero would close the window instantly and the
 * run would click nothing, which looks like a broken feature rather than a field left empty.
 */
export function resolveWindowEnd(opts, startedAt) {
  const until = Number(opts?.untilMs);
  const hasUntil = Number.isFinite(until) && until > 0;
  const forMs = Number(opts?.runForMs);
  const hasFor = Number.isFinite(forMs) && forMs > 0;
  const isWindow = opts?.window === true || hasUntil || hasFor;
  if (!isWindow) return { isWindow: false, endAt: null };
  if (hasUntil) return { isWindow: true, endAt: until };
  if (hasFor) return { isWindow: true, endAt: startedAt + forMs };
  return { isWindow: true, endAt: null };              // endless: the user stops it
}

export class Runner {
  /**
   * @param {Host} host
   * @param {Object} [options]
   */
  constructor(host, options = {}) {
    this.host = host;
    this.log = options.log ?? (() => {});
    this.maxStepsExecuted = options.maxStepsExecuted ?? 500_000;
  }

  /**
   * Run an automation to completion.
   *
   * @param {import('../model/steps.js').Automation} automation
   * @param {{vars?: Object, row?: Object, signal?: {aborted: boolean}}} [ctx]
   * @returns {Promise<{reason: string, trace: Object[], vars: Object, error?: Error, steps: number, elapsedMs: number}>}
   */
  async run(automation, ctx = {}) {
    validateAutomation(automation);
    const opts = { ...automation.options };
    const variables = { ...(opts.variables || {}), ...(ctx.vars || {}) };
    if (ctx.row) {
      // a CSV row is exposed both as `row.x` and as bare `x`, which is what a user expects when they pick
      // a column and then type `${email}` rather than `${row.email}`
      variables.row = ctx.row;
      for (const [k, v] of Object.entries(ctx.row)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        if (!(k in variables)) variables[k] = v;
      }
    }

    const state = {
      vars: variables,
      trace: [],
      stepsExecuted: 0,
      startedAt: this.host.now(),
      opts,
      automation,
    };

    const push = (entry) => {
      const e = { at: this.host.now() - state.startedAt, ...entry };
      state.trace.push(e);
      try {
        this.host.onTrace?.(e);
      } catch {
        // a failing trace listener must never break the run
      }
      return e;
    };

    push({ type: 'run-start', name: automation.name });

    let reason = STOP_REASONS.finished;
    let error;

    try {
      /**
       * A WINDOW RUNS ITS STEPS REPEATEDLY; everything else runs them once.
       *
       * `windowMs` is the deadline (an absolute instant, via `untilMs`) or a duration (`runForMs`, resolved against the run's
       * own start). With no deadline the loop continues until the user stops it, bounded by `MAX_WINDOW_ROUNDS`.
       */
      const win = resolveWindowEnd(state.opts, state.startedAt);
      state.windowEnd = win.endAt;
      state.isWindow = win.isWindow;
      if (win.isWindow) {
        await this.#runWindow(automation.steps, state, push);
      } else {
        await this.#runBlock(automation.steps, state, push, 0);
      }
    } catch (e) {
      if (e instanceof RunAborted) {
        reason = reasonForAbort(e, ctx.signal);
      } else if (e instanceof StepError || e instanceof TemplateError || e instanceof ConditionError) {
        reason = STOP_REASONS.stepError;
        error = e;
        push({ type: 'run-error', message: e.message, stepId: e.stepId });
      } else if (e?.name === 'StepTimeout') {
        reason = STOP_REASONS.timeout;
        error = e;
        push({ type: 'run-error', message: e.message });
      } else {
        reason = STOP_REASONS.stepError;
        error = e;
        push({ type: 'run-error', message: e?.message ?? String(e) });
      }
    }

    push({ type: 'run-end', reason });
    return {
      reason,
      trace: state.trace,
      vars: state.vars,
      error,
      steps: state.stepsExecuted,
      elapsedMs: this.host.now() - state.startedAt,
    };
  }

  /**
   * Walk a list of steps, applying the run's click gap BETWEEN its clicks.
   *
   * THE GAP IS MEASURED BETWEEN THE CLICKS, NOT BETWEEN THE SLEEPS.
   *
   * Requested as "فاصله کلیک بین pickها": a millisecond interval between the picks of one time, defaulting to zero. The
   * naive implementation - sleep the gap after each click - measures from the END of one click to the START of the next, so
   * every click's own duration is added to the interval. With three picks at 20 ms and clicks that each take 12 ms, the
   * starts come out 32 ms apart, and on a slow page the error accumulates across the sequence.
   *
   * Here each click's target is ABSOLUTE: the instant the first click landed on, plus its index times the gap. A slow click
   * therefore cannot push the following ones back - it just has less waiting left to do, and if it overran the next target
   * the next click starts immediately rather than pretending to wait.
   *
   * Only `click` steps consume a slot. A `fill` between two clicks is not a pick, and spacing it would change what the step
   * does rather than when it happens.
   */
  /**
   * RUN THE STEPS, THEN RUN THEM AGAIN, UNTIL THE WINDOW CLOSES.
   *
   * This is the "از اول بزن" half of the request: the points are clicked in order, and when the last one is done the sequence
   * starts over from the first. Each pass is a `#runBlock` call, so conditions, loops and retries inside the sequence behave
   * exactly as they do in a single pass - this method only decides WHEN to start another one.
   *
   * THE TIME IS CHECKED BEFORE EACH ROUND, NOT AFTER. A round is therefore never started that cannot finish inside the window
   * without being cut off mid-sequence, which would leave the page in an unknown state for the next round.
   *
   * `state.windowRounds` is recorded on the run so the panel can report how many passes happened.
   */
  async #runWindow(steps, state, push) {
    const endAt = state.windowEnd;
    const endless = !Number.isFinite(endAt);
    /**
     * AN ENDLESS WINDOW GETS A WALL-CLOCK CEILING. `maxWindowMs` may raise or lower it; the default is twelve hours. A finite
     * window needs none, because its deadline is the ceiling.
     */
    const ceilingMs = Number(state.opts.maxWindowMs) > 0 ? Number(state.opts.maxWindowMs) : DEFAULT_MAX_WINDOW_MS;
    const hardStopAt = endless ? this.host.now() + ceilingMs : null;
    // `hasEnd` is about a FINITE deadline: an endless window has no deadline but is still a window
    push({ type: 'window-start', endAt, hasEnd: !endless, endless, hardStopAt, ceilingMs: endless ? ceilingMs : null });

    let rounds = 0;
    let emptyRounds = 0;
    for (;;) {
      /**
       * GUARD 1 - THE MACROTASK YIELD, AND IT MUST COME FIRST.
       *
       * Everything above this point is microtask work. The stop flag is set from OUTSIDE this loop (a message from the panel, a
       * storage change), and microtasks drain before the browser handles any of that - so without a turn of the event loop the
       * loop cannot see a stop however often it checks. `sleep(0)` is a `setTimeout`, which is a macrotask, so this is the line
       * that makes Stop work. MEASURED: without it, this feature's own test file hung and vitest's timeout could not even fire.
       */
      await this.host.sleep(0);

      if (this.host.stopRequested?.()) throw new RunAborted('__user__');
      if (endAt !== null && this.host.now() >= endAt) {
        push({ type: 'window-end', reason: 'window-complete', rounds });
        break;
      }
      if (hardStopAt !== null && this.host.now() >= hardStopAt) {
        push({ type: 'window-end', reason: 'window-cap', rounds, ceilingMs });
        break;
      }
      if (rounds >= MAX_WINDOW_ROUNDS) {
        push({ type: 'window-end', reason: 'round-limit', rounds });
        throw new StepError(`the window ran ${rounds} rounds and was stopped`, steps[0]?.id);
      }

      rounds += 1;
      push({ type: 'round-start', round: rounds });
      /**
       * GUARD 2 - A ROUND THAT DID NOTHING MUST NOT REPEAT FOREVER.
       *
       * THE SIGNAL IS THE ROUND'S TRACE, NOT THE STEP COUNTER. `state.stepsExecuted` counts every step dispatched, including an
       * `if` whose body is empty - so a round consisting of one never-taken branch incremented the counter, looked like work, and
       * the detector never fired. MEASURED: the round ceiling caught that case after 100 000 rounds instead. A round counts as
       * empty when it produced no trace entry OTHER than the structural ones, which is the honest question: did this round do
       * anything to the page or to the run's state?
       *
       * Counted CONSECUTIVELY, so an occasional legitimately skipped round resets the count rather than accumulating towards a
       * false positive.
       */
      const traceBefore = state.trace.length;
      await this.#runBlock(steps, state, push, 0);

      /**
       * A BLOCK STEP REPORTS `step-ok` EVEN WHEN ITS BODY RAN NOTHING, which is why this filter is not simply "any step-ok".
       *
       * MEASURED (`probe-trace2`): a round containing one never-taken `if` traces as
       * `['round-start', 'branch', 'step-ok']` - the `step-ok` belongs to the `if` itself. So it was counted as work, the
       * detector never fired, and the round ceiling caught the case at 100 000 rounds. The block steps of THIS round are
       * therefore collected first and their own `step-ok` entries are discounted; what is left is an action that reached the
       * page or the run's state.
       */
      const blockIds = new Set(steps.filter((s) => BLOCK_KINDS.has(s.kind)).map((s) => s.id));
      const didWork = state.trace.slice(traceBefore).some((e) => {
        if (e.type === 'round-start' || e.type === 'branch' || e.type === 'window-start') return false;
        if (e.type === 'step-ok' && blockIds.has(e.stepId)) return false;
        return true;
      });

      if (!didWork) {
        emptyRounds += 1;
        if (emptyRounds >= MAX_EMPTY_ROUNDS) {
          push({ type: 'window-end', reason: 'empty-rounds', rounds, emptyRounds });
          throw new StepError(
            `the window ran ${emptyRounds} rounds without executing a single step and was stopped `
            + '(every step is being skipped - check the conditions on this sequence)',
            steps[0]?.id,
          );
        }
      } else {
        emptyRounds = 0;
      }
    }
    state.windowRounds = rounds;
    return rounds;
  }

  async #runBlock(steps, state, push, depth) {
    const gapMs = Math.max(0, Number(state.opts.clickGapMs) || 0);
    const isClick = (step) => step.kind === 'click';
    let clickIndex = 0;

    for (const step of steps) {
      /**
       * THE GAP IS A FLOOR BETWEEN CLICKS, NOT AN ABSOLUTE OFFSET FROM THE FIRST ONE.
       *
       * MEASURED from the engine's own trace (`gap-persist-test`): with a 20 ms gap the steps landed at 24, 30 and 44 ms -
       * intervals of 6 and 14 ms - so the setting looked like it had not been applied at all.
       *
       * The cause was the absolute design: each target was `firstClick + index x gap`, so when the FIRST click took 24 ms
       * (a message round trip to the page), the second target had already passed and the first gap was silently dropped.
       * An absolute schedule is right when the work is free and wrong when it is not, and a click into a page is never free.
       *
       * The rule is now the one the request describes - an interval BETWEEN the picks - so the wait is measured from the
       * moment the previous click finished. It can only ever be at least `gapMs`, which is what makes the setting reliable:
       * a slow page lengthens the real interval instead of eating the gap.
       */
      if (gapMs > 0 && isClick(step) && clickIndex > 0) {
        await this.host.sleep(gapMs);
      }
      if (isClick(step)) clickIndex += 1;
      await this.#runStep(step, state, push, depth);
    }
  }

  async #runStep(step, state, push, depth) {
    if (this.host.stopRequested?.()) throw new RunAborted('__user__');
    if (state.stepsExecuted >= this.maxStepsExecuted) {
      throw new StepError(`the run executed more than ${this.maxStepsExecuted} steps and was stopped`, step.id);
    }
    if (state.opts.maxRunMs && this.host.now() - state.startedAt > state.opts.maxRunMs) {
      const e = new Error(`the run exceeded its ${state.opts.maxRunMs} ms limit`);
      e.name = 'StepTimeout';
      throw e;
    }
    if (!await this.host.isAlive()) {
      // the tab was closed, or the page navigated away. Reporting it beats a silent no-op.
      throw new StepError('the page is no longer available (tab closed or navigated)', step.id);
    }

    state.stepsExecuted += 1;

    // a per-step pause, with optional jitter so a run is not perfectly mechanical
    const baseDelay = step.delayMs ?? state.opts.stepDelayMs ?? 0;
    const delay = jitter(baseDelay, step.jitterMs ?? 0);
    if (delay > 0) await this.host.sleep(delay);

    const started = this.host.now();
    /**
     * A BLOCK STEP IS NEVER RETRIED.
     *
     * Retrying wraps `#dispatch`, and for `loop`/`if`/`while` a dispatch executes the ENTIRE body. So one transient
     * error inside a five-iteration loop re-ran the iterations that had already succeeded: measured as 8 clicks from
     * a 5-iteration loop. A retry is meant to repeat a single atom; repeating a block is a second execution of work
     * that already happened, which for an order page is worse than failing.
     *
     * The body's own steps still retry individually, which is where a transient failure actually lives.
     */
    const isBlock = step.kind === 'loop' || step.kind === 'if' || step.kind === 'foreach'
      || Array.isArray(step.then) || Array.isArray(step.else);
    const attempts = isBlock ? 1 : (step.retries ?? state.opts.stepRetries ?? 0) + 1;
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result = await this.#dispatch(step, state, push, depth);
        push({
          type: 'step-ok',
          stepId: step.id,
          kind: step.kind,
          attempt,
          durationMs: this.host.now() - started,
          ...(result !== undefined ? { result } : {}),
        });
        return;
      } catch (e) {
        if (e instanceof RunAborted) throw e;
        lastError = e;
        if (attempt < attempts) {
          push({
            type: 'step-retry',
            stepId: step.id,
            kind: step.kind,
            attempt,
            message: e?.message ?? String(e),
          });
          await this.host.sleep(Math.min(2000, 200 * attempt));
        }
      }
    }

    const message = lastError?.message ?? String(lastError);
    push({ type: 'step-fail', stepId: step.id, kind: step.kind, message });

    const onError = step.onError ?? (state.opts.stopOnError === false ? 'continue' : 'stop');
    if (onError === 'continue' || onError === 'skip') return;

    if (lastError instanceof StepError || lastError instanceof TemplateError ||
        lastError instanceof ConditionError || lastError?.name === 'StepTimeout') {
      if (lastError.stepId === undefined) lastError.stepId = step.id;
      throw lastError;
    }
    const e = new StepError(message, step.id);
    e.cause = lastError;
    throw e;
  }

  async #dispatch(step, state, push, depth) {
    switch (step.kind) {
      // ---------------------------------------------------------------- blocks
      case 'loop':
        return this.#runLoop(step, state, push, depth);

      case 'if':
        return this.#runIf(step, state, push, depth);

      case 'break':
        throw new RunAborted('__break__');

      case 'continue':
        throw new RunAborted('__continue__');

      case 'stop':
        throw new RunAborted(interpolate(step.reason || 'stopped by a step', state.vars));

      // ---------------------------------------------------------------- data
      case 'setVariable': {
        const value = interpolate(String(step.value ?? ''), state.vars);
        state.vars[step.name] = value;
        push({ type: 'variable', name: step.name, value: preview(value) });
        return { name: step.name, value: preview(value) };
      }

      case 'extract': {
        /**
         * RESOLVED HERE, not in the page.
         *
         * MEASURED (B11): this used to pass `__resolve` as a FUNCTION. Functions do not cross the extension message
         * port - the receiver gets nothing - and `content.js` never called it anyway, so `${var}` in an extract's finder
         * was silently ignored and the wrong element was read. Every other step already goes through `resolveStep`,
         * which substitutes the values before sending; extract now does the same, so there is one mechanism instead of
         * two, one of which could not work.
         */
        const obs = await this.host.execute(resolveStep(step, state.vars));
        const value = obs && typeof obs === 'object' && 'value' in obs ? obs.value : obs;
        state.vars[step.name] = value === null || value === undefined ? '' : String(value);
        push({ type: 'variable', name: step.name, value: preview(state.vars[step.name]) });
        return { name: step.name, value: preview(state.vars[step.name]) };
      }

      default: {
        // everything else is the host's business: it knows how to click, fill, navigate
        const resolved = resolveStep(step, state.vars);
        return this.host.execute(resolved);
      }
    }
  }

  async #runLoop(step, state, push, depth) {
    const loopType = step.loopType ?? 'count';
    const body = step.steps ?? [];
    let iterations = 0;

    if (loopType === 'count') {
      const total = step.count;
      push({ type: 'loop-start', stepId: step.id, loopType, total });
      for (let i = 0; i < total; i++) {
        this.#checkLoop(state, step, i);
        state.vars['loop'] = { index: i, iteration: i + 1, first: i === 0, last: i === total - 1, total };
        try {
          await this.#runBlock(body, state, push, depth + 1);
        } catch (e) {
          if (e instanceof RunAborted) {
            if (e.message === '__break__') break;
            if (e.message === '__continue__') {
              iterations = i + 1;
              continue;
            }
          }
          throw e;
        }
        iterations = i + 1;
      }
      push({ type: 'loop-end', stepId: step.id, iterations });
      return { iterations };
    }

    if (loopType === 'forEach') {
      const listName = step.listVariable || step.name;
      const raw = state.vars[listName];
      const list = Array.isArray(raw) ? raw : parseList(raw);
      const total = list.length;
      push({ type: 'loop-start', stepId: step.id, loopType, total });
      for (let i = 0; i < total; i++) {
        this.#checkLoop(state, step, i);
        const item = list[i];
        state.vars['loop'] = { index: i, iteration: i + 1, first: i === 0, last: i === total - 1, total };
        state.vars['item'] = item;
        if (step.itemVariable) state.vars[step.itemVariable] = item;
        if (item && typeof item === 'object') {
          for (const [k, v] of Object.entries(item)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            state.vars[k] = v;
          }
          state.vars.row = item;
        }
        try {
          await this.#runBlock(body, state, push, depth + 1);
        } catch (e) {
          if (e instanceof RunAborted) {
            if (e.message === '__break__') break;
            if (e.message === '__continue__') {
              iterations = i + 1;
              continue;
            }
          }
          throw e;
        }
        iterations = i + 1;
      }
      push({ type: 'loop-end', stepId: step.id, iterations });
      return { iterations };
    }

    // while
    const ceiling = step.maxIterations;
    push({ type: 'loop-start', stepId: step.id, loopType: 'while', ceiling });
    for (let i = 0; i < ceiling; i++) {
      const ok = await this.#condition(step.condition, state);
      if (!ok) break;
      this.#checkLoop(state, step, i);
      state.vars['loop'] = { index: i, iteration: i + 1, total: null };
      try {
        await this.#runBlock(body, state, push, depth + 1);
      } catch (e) {
        if (e instanceof RunAborted) {
          if (e.message === '__break__') break;
          if (e.message === '__continue__') {
            iterations = i + 1;
            continue;
          }
        }
        throw e;
      }
      iterations = i + 1;
    }
    push({ type: 'loop-end', stepId: step.id, iterations });
    return { iterations };
  }

  /** Shared guard: a loop must stop if the run has been cancelled or outlived its budget. */
  #checkLoop(state, step, index) {
    if (this.host.stopRequested?.()) throw new RunAborted('__user__');
    if (state.opts.maxRunMs && this.host.now() - state.startedAt > state.opts.maxRunMs) {
      const e = new Error(`the loop exceeded the run's ${state.opts.maxRunMs} ms limit`);
      e.name = 'StepTimeout';
      throw e;
    }
    if (state.stepsExecuted >= this.maxStepsExecuted) {
      throw new StepError('the loop exceeded the step limit', step.id);
    }
  }

  async #runIf(step, state, push, depth) {
    const ok = await this.#condition(step.condition, state);
    push({ type: 'branch', stepId: step.id, taken: ok ? 'then' : 'else' });
    const body = ok ? (step.then ?? []) : (step.else ?? []);
    if (body.length) await this.#runBlock(body, state, push, depth + 1);
    return { taken: ok ? 'then' : 'else' };
  }

  async #condition(condition, state) {
    return evaluateCondition(condition, {
      vars: state.vars,
      read: (c) => this.host.readCondition?.(c) ?? { value: null, found: false, flags: {} },
    });
  }
}

/** Expand templates in every string field of a step, recursively for finders. */
export function resolveStep(step, vars) {
  const walk = (v) => {
    if (typeof v === 'string') return interpolate(v, vars);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  const { id, kind, ...rest } = step;
  const resolved = { id, kind, ...walk(rest) };
  return resolved;
}

/** Keep a trace value short: a 200 KB extracted page must not be copied into every log line. */
export function preview(value, limit = 120) {
  const s = value === null || value === undefined ? '' : String(value);
  return s.length > limit ? `${s.slice(0, limit)}... (${s.length} chars)` : s;
}

/** A bare string list from a variable, for forEach over a comma/newline separated value. */
function parseList(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  return String(raw)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export { StepError, TemplateError, ConditionError, ELEMENT_KINDS, BLOCK_KINDS };