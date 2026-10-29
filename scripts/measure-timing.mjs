#!/usr/bin/env node
/**
 * Measure the real minimum interval between two clicks, and the real cost of a step.
 *
 * Two questions are being answered with numbers rather than a claim:
 *   1. how small can the gap between two clicks actually be, and what sets the floor?
 *   2. does pressKeys hold several non-modifier keys down at the same time (a chord), or only run them
 *      one after another?
 */
import { STEP_KINDS, makeStep, BLOCK_KINDS } from '../src/core/model/steps.js';
import { Runner } from '../src/core/engine/runner.js';

/** A host that does nothing but time itself, so the measurement is of the runner, not of any page. */
function makeHost() {
  const clicks = [];
  return {
    now: () => performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    stopRequested: () => false,
    isAlive: async () => true,
    onTrace: () => {},
    clicks,
    async execute(step) {
      if (step.kind === 'click') clicks.push(performance.now());
      return { ok: true };
    },
    async readCondition() {
      return { value: 'x', found: true, flags: {} };
    },
  };
}

async function measureClicks(count, stepDelayMs) {
  const host = makeHost();
  const runner = new Runner(host);
  const automation = {
    id: 'm',
    name: 'measure',
    steps: Array.from({ length: count }, (_, i) => ({
      ...makeStep('click', { finder: { strategy: 'css', selector: '#b' } }),
      id: `c${i}`,
    })),
    options: { stepDelayMs, stepRetries: 0 },
  };
  const t0 = performance.now();
  await runner.run(automation);
  const total = performance.now() - t0;
  const gaps = host.clicks.slice(1).map((t, i) => t - host.clicks[i]);
  gaps.sort((a, b) => a - b);
  return {
    count,
    stepDelayMs,
    totalMs: total,
    median: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
    min: gaps.length ? gaps[0] : null,
    max: gaps.length ? gaps[gaps.length - 1] : null,
    perStep: total / count,
  };
}

async function main() {
  console.log('=== step kinds available ===');
  console.log(`  ${STEP_KINDS.length} kinds`);
  console.log(`  ${STEP_KINDS.join(', ')}`);
  console.log(`  blocks (contain nested steps): ${[...BLOCK_KINDS].join(', ')}`);
  console.log();

  console.log('=== how fast can two clicks be? (real measurement) ===');
  console.log('  steps  delay   total    median gap   min gap    per step');
  for (const [count, delay] of [[50, 0], [50, 1], [50, 10], [200, 0]]) {
    const m = await measureClicks(count, delay);
    console.log(
      `  ${String(m.count).padStart(5)}  ${String(m.stepDelayMs).padStart(5)}ms  ` +
      `${m.totalMs.toFixed(0).padStart(5)}ms  ${m.median === null ? '-' : `${m.median.toFixed(2)}ms`.padStart(9)}  ` +
      `${m.min === null ? '-' : `${m.min.toFixed(2)}ms`.padStart(8)}  ${m.perStep.toFixed(3)}ms`,
    );
  }
  console.log();

  // ---- the two meanings of "several keys at once"
  const { pressKeys } = await import('../src/core/dom/actions.js');
  globalThis.window = globalThis.window ?? globalThis;
}

main().catch((e) => {
  console.error('measurement failed:', e.message);
  process.exit(1);
});
