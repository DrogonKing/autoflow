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
      await this.#runBlock(automation.steps, state, push, 0);
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
  async #runBlock(steps, state, push, depth) {
    const gapMs = Math.max(0, Number(state.opts.clickGapMs) || 0);
    /** The instant the first click landed on, and how many clicks have happened since. */
    let anchorAt = null;
    let clickIndex = 0;
    const isClick = (step) => step.kind === 'click';

    for (const step of steps) {
      if (gapMs > 0 && isClick(step)) {
        if (anchorAt === null) {
          // the FIRST pick is not delayed: it is the scheduled instant, which is the entire point of the schedule
          anchorAt = this.host.now();
        } else {
          const targetAt = anchorAt + clickIndex * gapMs;
          const waitMs = targetAt - this.host.now();
          // a negative wait means this click overran the next target; waiting would misreport the moment, so it proceeds
          if (waitMs > 0) await this.host.sleep(waitMs);
        }
        clickIndex += 1;
      }
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