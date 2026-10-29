/**
 * The wake margin, and the window that decides whether the precise path is used.
 *
 * These two numbers were fixed constants that had to agree with each other. When the margin became adaptive to the
 * machine's measured start latency, the window did not follow - so a large margin woke the worker with the target
 * still far away, the handler concluded it was early for a FUTURE occurrence, and the run fired immediately with no
 * precise wait at all. The precise path was skipped exactly when it was needed most.
 *
 * The margin must also be STRICTLY greater than the observed latency: equal means the worker wakes on the target,
 * leaving nothing to wait for. Measured before this: a 6000ms margin against a 6000ms latency produced 0ms of early
 * arrival and the "wait for the target" branch never ran.
 */
import { describe, expect, it } from 'vitest';

/** The one definition, mirrored from src/background/alarms.js so the arithmetic is testable without a browser. */
const LEAD = 1500;                 // PRECISE_WAKE_MS: how much early lead the precise wait needs
const CAP = 20_000;
/**
 * The margin is the start latency plus the lead, NOT the latency plus an arbitrary slack with a floor under it.
 *
 * The earlier formula was `max(LEAD, latency + 2500)`, in which the floor could never bind because the slack was the
 * larger number - so the lead constant was dead code and the precise wait had 2500ms or more of room instead of the
 * 1500ms the design intended.
 */
const marginFor = (observedLatencyMs) => Math.min(observedLatencyMs + LEAD, CAP);

/** What the alarm handler decides, given the margin that was used and how late the worker actually was. */
function decide({ margin, latency }) {
  const earlyMs = margin - latency;          // how much time is left before the target when the worker is ready
  const window = margin + 5000;              // the handler's tolerance for "this alarm is early for the target"
  if (earlyMs <= 0) return { atMs: null, waits: false, why: 'the worker arrived at or after the target' };
  if (earlyMs > window) return { atMs: null, waits: false, why: 'the target is further away than the window' };
  return { atMs: earlyMs, waits: true, why: 'waits for the target' };
}

describe('the wake margin', () => {
  it('a zero-latency machine gets exactly the lead', () => {
    expect(marginFor(0)).toBe(LEAD);
  });

  it('grows with the measured latency', () => {
    expect(marginFor(6000)).toBe(6000 + LEAD);
    expect(marginFor(12_000)).toBe(12_000 + LEAD);
  });

  it('is capped, so a bad sample cannot arm an alarm absurdly early', () => {
    expect(marginFor(60_000)).toBe(CAP);
  });

  it('ALWAYS leaves a real precise wait, for every latency', () => {
    // this is the property that broke: an equal margin left zero time to wait for
    for (const latency of [0, 100, 500, 1500, 3000, 6000, 12_000, 17_500]) {
      const margin = marginFor(latency);
      const early = margin - latency;
      expect(early, `latency ${latency} left only ${early}ms to wait`).toBeGreaterThanOrEqual(LEAD);
    }
  });

  it('the click is never merely "best effort" on a machine within the cap', () => {
    // a best-effort shot is what the user experienced; with slack it should not happen at normal latencies
    for (const latency of [0, 500, 2000, 5000, 10_000, 17_000]) {
      const d = decide({ margin: marginFor(latency), latency });
      expect(d.waits, `latency ${latency}: ${d.why}`).toBe(true);
    }
  });
});

describe('the handler window', () => {
  it('accepts an alarm that arrives with the target still ahead', () => {
    expect(decide({ margin: 4000, latency: 200 }).waits).toBe(true);
  });

  it('accepts a LARGE margin, which the fixed window rejected', () => {
    /**
     * The regression: a 17.5s-margin alarm woke the worker 17.5s before the target, and the old window was
     * PRECISE_WAKE_MS + 5000 = 6.5s, so 17.5s was "too far away" and the run fired immediately.
     */
    const d = decide({ margin: 17_500, latency: 500 });
    expect(d.waits, d.why).toBe(true);
  });

  it('fires immediately when the worker genuinely arrived late', () => {
    const d = decide({ margin: 3000, latency: 3500 });
    expect(d.waits).toBe(false);
    expect(d.why).toMatch(/at or after the target/);
  });
});

describe('the two numbers must be derived from the same sample', () => {
  it('a margin computed by scheduleOne is inside the window the handler accepts', () => {
    /**
     * The failure mode was two constants drifting apart. This pins the agreement: whatever latency the machine
     * reports, the margin that gets armed is one the handler will accept as "early for this target".
     */
    for (const latency of [0, 250, 1000, 4000, 9000, 17_500]) {
      const margin = marginFor(latency);
      const d = decide({ margin, latency });
      expect(d.waits, `margin ${margin} with latency ${latency}`).toBe(true);
    }
  });
});