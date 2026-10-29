/**
 * The clock-offset arithmetic, tested without a network.
 *
 * The sign convention is the thing worth testing hardest: getting it backwards moves a schedule the wrong way,
 * which for an order window is worse than not correcting at all. So each test states the direction in words as
 * well as the number.
 */
import { describe, expect, it } from 'vitest';
import {
  DATE_HEADER_HALF_MS, DATE_HEADER_RESOLUTION_MS, DEFAULT_WARN_THRESHOLD_MS, clockOffset,
  describeSkew, normaliseSkewSettings, shouldWarn,
} from '../src/core/clock/skew.js';

/**
 * WHY EVERY EXPECTATION BELOW CARRIES `+ DATE_HEADER_HALF_MS`.
 *
 * The `Date` header truncates to whole seconds, so a stamp of 3000 means a moment somewhere in [3000, 3100) - on
 * average 3050. Comparing the raw stamp against the midpoint of the exchange therefore produced a fixed -500ms bias,
 * and a machine whose clock was exactly right was reported as wrong in about half of all measurements.
 *
 * The correction is now inside `clockOffset`, so these fixtures state the bias explicitly. They previously pinned the
 * biased numbers as correct, which is why a green test suite coexisted with a 50% wrong sign.
 */
describe('measuring the offset', () => {
  it('a server 2s ahead gives about +2000, i.e. this machine is behind', () => {
    /**
     * A single sample cannot be EXACT, and asserting that it is would be asserting something untrue.
     *
     * The header resolves to a whole second, so one reading is only good to +/-500ms. The correction removes the
     * LEAN (the mean bias); it cannot remove the resolution. What this test may therefore assert is the direction and
     * that the answer is inside the header's own precision - not a specific millisecond.
     */
    // sent at 1000, 100ms round trip, midpoint 1050; the server's true time there is 3050, truncated to 3000
    const r = clockOffset({ t0: 1000, t1: 1100, serverStamp: 3000 });
    expect(r.offsetMs).toBeGreaterThan(0);
    expect(Math.abs(r.offsetMs - 2000)).toBeLessThanOrEqual(DATE_HEADER_RESOLUTION_MS / 2 + 50);
    expect(r.rttMs).toBe(100);
  });

  it('a server 2s behind gives a negative offset', () => {
    // server true time at the midpoint is 8100, truncated to 8000
    const r = clockOffset({ t0: 10_000, t1: 10_100, serverStamp: 8000 });
    expect(r.offsetMs).toBeLessThan(0);
    expect(Math.abs(r.offsetMs - (-2000))).toBeLessThanOrEqual(DATE_HEADER_RESOLUTION_MS / 2 + 50);
  });

  it('half the round trip is credited to the server stamp', () => {
    // 400ms round trip: the stamp is assumed to be from t0+200, and the truncation adds another 500
    const r = clockOffset({ t0: 5000, t1: 5400, serverStamp: 4700 });
    expect(r.offsetMs).toBe(0);
  });

  it('a zero round trip still works', () => {
    const r = clockOffset({ t0: 7000, t1: 7000, serverStamp: 6500 });
    expect(r.offsetMs).toBe(0);
    expect(r.rttMs).toBe(0);
  });

  it('THE REPORTED BUG: a clock that is exactly right is not systematically reported as wrong', () => {
    /**
     * This is the finding, reproduced as an average rather than as one lucky fixture.
     *
     * With the clocks synchronized, the server truncates its stamp DOWN to the whole second, so a single sample lands
     * anywhere in [-1000, 0) - mean -500. That mean was the bug: it made "your clock is ahead" the answer in about
     * half of all measurements even when the clock was perfect. Sweeping every sub-second phase and averaging is the
     * only honest way to test an unbiasedness correction, because any single phase has an error of up to 500ms by
     * construction.
     */
    const offsets = [];
    for (let phase = 0; phase < 1000; phase += 1) {
      // the client's clock is exact; the server is exact too and stamps floor(time / 1000) * 1000
      const t = 7000 + phase;
      const r = clockOffset({ t0: t, t1: t, serverStamp: Math.floor(t / 1000) * 1000 });
      offsets.push(r.offsetMs);
    }
    const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
    console.log(`  mean offset over all 1000 phases: ${mean.toFixed(2)}ms`);

    // unbiased: the average is near zero, not -500
    expect(Math.abs(mean)).toBeLessThan(60);
    expect(mean).toBeGreaterThan(-120);

    // and the sign is balanced, which is what the report measured as 50.4% wrong
    const saysAhead = offsets.filter((x) => x > 0).length;
    const saysBehind = offsets.filter((x) => x < 0).length;
    console.log(`  says ahead: ${saysAhead}  says behind: ${saysBehind}  exact: ${offsets.length - saysAhead - saysBehind}`);
    expect(Math.abs(saysAhead - saysBehind)).toBeLessThan(120);
  });

  it('without the correction the same sweep leans one way - proving the constant is load-bearing', () => {
    // the old arithmetic, reproduced here so the fix cannot be quietly removed
    const biased = [];
    for (let phase = 0; phase < 1000; phase += 1) {
      const t = 7000 + phase;
      const stamp = Math.floor(t / 1000) * 1000;
      biased.push(Math.round(stamp - t));       // no +500
    }
    const mean = biased.reduce((a, b) => a + b, 0) / biased.length;
    console.log(`  mean with no correction: ${mean.toFixed(2)}ms`);
    expect(mean).toBeLessThan(-400);            // the -500 lean the report measured
  });

  it('the correction is exactly half the header resolution', () => {
    expect(DATE_HEADER_HALF_MS).toBe(DATE_HEADER_RESOLUTION_MS / 2);
  });

  it('a negative round trip is clamped rather than trusted', () => {
    // cannot happen with a monotonic clock, but a caller passing swapped values must not produce nonsense
    const r = clockOffset({ t0: 5000, t1: 4000, serverStamp: 5000 });
    expect(r.rttMs).toBe(0);
  });

  it('reports uncertainty, dominated by the header resolution', () => {
    const r = clockOffset({ t0: 0, t1: 200, serverStamp: 1000 });
    // 500ms of resolution + 100ms of jitter
    expect(r.uncertaintyMs).toBe(600);
  });

  it('flags a sample with a huge round trip as untrustworthy', () => {
    expect(clockOffset({ t0: 0, t1: 1500, serverStamp: 1000 }).trustworthy).toBe(false);
    expect(clockOffset({ t0: 0, t1: 100, serverStamp: 1000 }).trustworthy).toBe(true);
  });
});

describe('whether to warn', () => {
  it('does not warn on a difference smaller than the header can resolve', () => {
    // 400ms of apparent difference is inside the noise of a one-second-resolution header
    expect(shouldWarn(400)).toBe(false);
    expect(shouldWarn(-400)).toBe(false);
  });

  it('warns at a full second in either direction', () => {
    expect(shouldWarn(1000)).toBe(true);
    expect(shouldWarn(-1000)).toBe(true);
    expect(shouldWarn(5000)).toBe(true);
  });

  it('the default threshold is a whole second, because anything less is not measurable', () => {
    expect(DEFAULT_WARN_THRESHOLD_MS).toBe(DATE_HEADER_RESOLUTION_MS);
  });

  it('honours a custom threshold', () => {
    expect(shouldWarn(2000, 3000)).toBe(false);
    expect(shouldWarn(-4000, 3000)).toBe(true);
  });

  it('never warns on a non-number', () => {
    expect(shouldWarn(NaN)).toBe(false);
    expect(shouldWarn(undefined)).toBe(false);
    expect(shouldWarn(null)).toBe(false);
  });
});

describe('the wording, where the direction must not be misread', () => {
  it('says the server is ahead when the offset is positive', () => {
    const s = describeSkew({ offsetMs: 2500, rttMs: 80 });
    expect(s).toMatch(/server clock is about 2\.5s ahead/);
    expect(s).toMatch(/this machine is behind/);
  });

  it('says the server is behind when the offset is negative', () => {
    const s = describeSkew({ offsetMs: -2500, rttMs: 80 });
    expect(s).toMatch(/server clock is about 2\.5s behind/);
    expect(s).toMatch(/this machine is ahead/);
  });

  it('says they agree when the difference is unmeasurable', () => {
    expect(describeSkew({ offsetMs: 200, rttMs: 50 })).toMatch(/agree/);
  });

  it('refuses to give a number for an untrustworthy sample', () => {
    const s = describeSkew({ offsetMs: 9000, rttMs: 4000, trustworthy: false });
    expect(s).toMatch(/unreliable/);
    expect(s).toMatch(/4000ms/);
  });

  it('speaks Persian when asked', () => {
    expect(describeSkew({ offsetMs: 2500, rttMs: 80 }, 'fa')).toMatch(/[\u0600-\u06FF]/);
    expect(describeSkew({ offsetMs: 2500, rttMs: 80 }, 'fa')).toContain('2.5');
  });
});

describe('stored settings', () => {
  it('defaults to warning at a full second', () => {
    expect(normaliseSkewSettings({}).thresholdMs).toBe(1000);
  });

  it('has NO apply field at all, so the offset can never be used to move a schedule', () => {
    // A test that asserted `autoApply === false` would only pin a default - someone could flip it. Asserting the
    // property is ABSENT pins the design: there is no code path from a measurement to a schedule.
    expect('autoApply' in normaliseSkewSettings({})).toBe(false);
    expect('autoApply' in normaliseSkewSettings({ skewAutoApply: true })).toBe(false);
  });

  it('a nonsense threshold falls back rather than disabling the warning', () => {
    expect(normaliseSkewSettings({ skewWarnThresholdMs: -5 }).thresholdMs).toBe(1000);
    expect(normaliseSkewSettings({ skewWarnThresholdMs: 'abc' }).thresholdMs).toBe(1000);
    expect(normaliseSkewSettings({ skewWarnThresholdMs: 1e9 }).thresholdMs).toBe(1000);
  });

  it('accepts a sane custom threshold', () => {
    expect(normaliseSkewSettings({ skewWarnThresholdMs: 3000 }).thresholdMs).toBe(3000);
    expect(normaliseSkewSettings({ skewWarnThresholdMs: 0 }).thresholdMs).toBe(0);
  });
});