/**
 * The clock-offset arithmetic, tested without a network.
 *
 * The sign convention is the thing worth testing hardest: getting it backwards moves a schedule the wrong way,
 * which for an order window is worse than not correcting at all. So each test states the direction in words as
 * well as the number.
 */
import { describe, expect, it } from 'vitest';
import {
  DATE_HEADER_RESOLUTION_MS, DEFAULT_WARN_THRESHOLD_MS, clockOffset, correctedTarget,
  describeCorrection, describeSkew, normaliseSkewSettings, shouldWarn,
} from '../src/core/clock/skew.js';

describe('measuring the offset', () => {
  it('a server 2s ahead gives +2000, i.e. this machine is behind', () => {
    // sent at 1000, 100ms round trip, server stamped 3000 -> server is ahead by 2000 + half the rtt
    const r = clockOffset({ t0: 1000, t1: 1100, serverStamp: 3050 });
    expect(r.offsetMs).toBe(2000);
    expect(r.offsetMs).toBeGreaterThan(0);
    expect(r.rttMs).toBe(100);
  });

  it('a server 2s behind gives a negative offset', () => {
    const r = clockOffset({ t0: 10_000, t1: 10_100, serverStamp: 8050 });
    expect(r.offsetMs).toBe(-2000);
  });

  it('half the round trip is credited to the server stamp', () => {
    // 400ms round trip: the stamp is assumed to be from t0+200. A stamp matching that is offset 0.
    const r = clockOffset({ t0: 5000, t1: 5400, serverStamp: 5200 });
    expect(r.offsetMs).toBe(0);
  });

  it('a zero round trip still works', () => {
    const r = clockOffset({ t0: 7000, t1: 7000, serverStamp: 7000 });
    expect(r.offsetMs).toBe(0);
    expect(r.rttMs).toBe(0);
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

describe('applying the correction', () => {
  it('a server 2s ahead means firing 2s earlier on this clock', () => {
    // the wanted moment is 09:00:00 server time; this machine's clock is 2s behind, so its 08:59:58 is 09:00:00
    const target = 1_700_000_000_000;
    expect(correctedTarget(target, 2000)).toBe(target - 2000);
  });

  it('a server 2s behind means firing 2s later on this clock', () => {
    const target = 1_700_000_000_000;
    expect(correctedTarget(target, -2000)).toBe(target + 2000);
  });

  it('a zero offset leaves the target alone', () => {
    const target = 1_700_000_000_000;
    expect(correctedTarget(target, 0)).toBe(target);
  });

  it('a missing offset leaves the target alone rather than moving it to NaN', () => {
    expect(correctedTarget(1234, undefined)).toBe(1234);
    expect(correctedTarget(1234, NaN)).toBe(1234);
  });

  it('a missing target is null, not a number', () => {
    expect(correctedTarget(undefined, 1000)).toBeNull();
    expect(correctedTarget(NaN, 1000)).toBeNull();
  });

  it('correcting and then undoing returns the original', () => {
    // the property that matters: the correction is reversible, so a wrong reading can be taken back
    const target = 1_700_000_000_000;
    const moved = correctedTarget(target, 1500);
    expect(moved + 1500).toBe(target);
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

  it('describes the correction as a direction, not just a number', () => {
    expect(describeCorrection(1500)).toMatch(/behind the server.*moved earlier/);
    expect(describeCorrection(-1500)).toMatch(/ahead of the server.*moved later/);
    expect(describeCorrection(0)).toMatch(/none/);
  });

  it('speaks Persian when asked', () => {
    expect(describeSkew({ offsetMs: 2500, rttMs: 80 }, 'fa')).toMatch(/[\u0600-\u06FF]/);
    expect(describeSkew({ offsetMs: 2500, rttMs: 80 }, 'fa')).toContain('2.5');
    expect(describeCorrection(1500, 'fa')).toMatch(/[\u0600-\u06FF]/);
  });
});

describe('stored settings', () => {
  it('defaults to warning at a full second with no auto-apply', () => {
    const s = normaliseSkewSettings({});
    expect(s.thresholdMs).toBe(1000);
    expect(s.autoApply).toBe(false);
  });

  it('auto-apply is strictly opt-in, so a missing value never applies a correction', () => {
    expect(normaliseSkewSettings({}).autoApply).toBe(false);
    expect(normaliseSkewSettings({ skewAutoApply: 'yes' }).autoApply).toBe(false);
    expect(normaliseSkewSettings({ skewAutoApply: true }).autoApply).toBe(true);
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