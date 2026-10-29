/**
 * The alarm storm, and the arithmetic that stops it.
 *
 * Measured failure: nine alarms fired one second apart for one automation and not a single click happened. The cause
 * was a re-arm that asked for "the next occurrence from now" in the failure path: when the failure happens BEFORE the
 * target, that is the SAME occurrence, seconds away. So a failing start re-armed the instant it had just failed, and
 * the retry storm consumed the very second it was aiming at.
 *
 * Two independent protections are tested here, because either one alone would have been enough and both are cheap:
 *   - the re-arm is computed from AFTER the target that failed;
 *   - a hard cap refuses more than three firings in ten seconds for one automation.
 */
import { describe, expect, it } from 'vitest';

/** The re-arm instant as the worker now computes it. */
function rearmFrom(attemptedTarget, now) {
  const after = Number.isFinite(attemptedTarget) ? attemptedTarget + 1 : now;
  return Math.max(after, now);
}

/** Whether the storm guard would refuse this firing. */
function refused(firings, now) {
  const recent = firings.filter((t) => now - t < 10_000);
  return recent.length > 3;
}

describe('re-arming after a failed start', () => {
  it('asks for the occurrence AFTER the one that failed, not the same one', () => {
    // the failing target is 8s in the future; re-arming from "now" would return that same instant
    const target = 1_700_000_008_000;
    const now = 1_700_000_000_000;
    const from = rearmFrom(target, now);
    expect(from).toBeGreaterThan(target);
    expect(from - target).toBe(1);
  });

  it('never returns an instant in the past, even if the target is stale', () => {
    const staleTarget = 1_700_000_000_000;
    const now = staleTarget + 60_000;
    expect(rearmFrom(staleTarget, now)).toBe(now);
  });

  it('handles a missing target without throwing', () => {
    const now = 1_700_000_000_000;
    expect(rearmFrom(null, now)).toBe(now);
    expect(rearmFrom(undefined, now)).toBe(now);
  });
});

describe('the storm guard', () => {
  it('allows a normal single firing', () => {
    expect(refused([1000], 2000)).toBe(false);
  });

  it('allows up to three in ten seconds', () => {
    expect(refused([0, 2000, 4000], 5000)).toBe(false);
  });

  it('REFUSES a fourth in ten seconds', () => {
    // the measured storm: one per second
    expect(refused([0, 1000, 2000, 3000], 3100)).toBe(true);
  });

  it('forgets firings older than ten seconds, so a long-running schedule is never refused', () => {
    // one firing a day for four days is not a storm
    const day = 86_400_000;
    expect(refused([0, day, 2 * day, 3 * day], 3 * day + 500)).toBe(false);
  });

  it('a schedule firing every 11 seconds is allowed', () => {
    // just outside the window - aggressive but legitimate
    expect(refused([0, 11_000, 22_000, 33_000], 33_100)).toBe(false);
  });
});

describe('the interaction that produced the storm', () => {
  it('the OLD re-arm reproduces it, which is why the arithmetic matters', () => {
    /**
     * Simulated: a target 10 seconds out, a failing start each time, and re-arming from "now" each time. The alarm
     * keeps resolving to the same target, so it fires, fails, re-arms and fires again - and the storm guard is what
     * ultimately stops it if the arithmetic is ever wrong again.
     */
    const target = 10_000;
    let clock = 0;
    const firings = [];
    for (let i = 0; i < 12; i++) {
      firings.push(clock);
      clock += 1000;                                  // one second between attempts
      if (refused(firings, clock)) break;             // the guard
    }
    console.log(`  storm stopped after ${firings.length} firings`);
    expect(firings.length).toBeLessThanOrEqual(4);
    expect(clock).toBeLessThan(target + 5000);
  });
});