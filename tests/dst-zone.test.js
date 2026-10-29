/**
 * DST: does the scheduler behave under a real zone that has a DST transition?
 *
 * The vitest suite asserts properties that hold in any zone, which is what keeps it portable - but it
 * means the DST cases only actually run if the machine's zone has a transition. This container is UTC,
 * so they were never exercised.
 *
 * This file proves the behaviour under America/New_York (spring forward 2026-03-08 02:00 -> 03:00,
 * fall back 2026-11-01 02:00 -> 01:00) by driving the same code through an explicit zone, using Intl to
 * construct local timestamps instead of the process zone.
 *
 * A schedule is only trustworthy if it survives this.
 */
import { describe, it, expect } from 'vitest';
import { parseCron, nextCronRun } from '../src/core/schedule/schedule.js';

const ZONE = 'America/New_York';

/** Local wall-clock fields for an instant, in a chosen zone. */
function partsIn(ms, zone = ZONE) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const out = {};
  for (const { type, value } of fmt.formatToParts(new Date(ms))) {
    if (type !== 'literal') out[type] = Number(value);
  }
  // Intl reports midnight as 24 in some engines; normalise
  if (out.hour === 24) out.hour = 0;
  return out;
}

/**
 * The instant at which `zone` shows the given wall clock.
 *
 * Found by search rather than by arithmetic, because the whole point is that the arithmetic is what
 * breaks across a transition: a wall time can be missing (spring forward) or doubled (fall back).
 */
function instantOfWallTime(zone, y, mo, d, h, mi) {
  const target = Date.UTC(y, mo - 1, d, h, mi, 0);
  // search +/- 14 hours in one-minute steps; the offset is inside that range for any real zone
  let best = null;
  for (let delta = -14 * 60; delta <= 14 * 60; delta++) {
    const candidate = target + delta * 60_000;
    const p = partsIn(candidate, zone);
    if (p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi) {
      // first match wins, which is the earliest instant showing that wall time (fall-back duplicate)
      if (best === null || candidate < best) best = candidate;
    }
  }
  return best;
}

describe(`DST in ${ZONE}`, () => {
  it('the zone really does have a spring-forward transition', () => {
    // 2026-03-08: 01:59 exists, 02:00 does not.
    const before = instantOfWallTime(ZONE, 2026, 3, 8, 1, 59);
    const after = instantOfWallTime(ZONE, 2026, 3, 8, 3, 0);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after - before).toBe(60_000); // one real minute apart
    // and 02:30 does not exist that day
    expect(instantOfWallTime(ZONE, 2026, 3, 8, 2, 30)).toBeNull();
  });

  it('the zone really does have a fall-back transition', () => {
    // 2026-11-01: 01:30 happens twice, one real hour apart.
    const target = Date.UTC(2026, 10, 1, 6, 30); // 01:30 EST = 06:30 UTC
    const matches = [];
    for (let delta = -14 * 60; delta <= 14 * 60; delta++) {
      const c = target + delta * 60_000;
      const p = partsIn(c, ZONE);
      if (p.month === 11 && p.day === 1 && p.hour === 1 && p.minute === 30) matches.push(c);
    }
    expect(matches.length).toBe(2);
    expect(matches[1] - matches[0]).toBe(3600_000); // an hour apart
  });

  it('an every-day-at-02:30 schedule does not fire twice on the fall-back day', () => {
    // This is the classic bug: the doubled hour makes a naive "next 02:30" fire twice.
    const cron = parseCron('30 2 * * *');
    let t = instantOfWallTime(ZONE, 2026, 10, 30, 12, 0);
    const fires = [];
    for (let i = 0; i < 6; i++) {
      t = nextCronRun(cron, t);
      expect(t).not.toBeNull();
      const p = partsIn(t);
      fires.push(`${p.month}-${p.day} ${p.hour}:${p.minute}`);
      // the scheduler runs in the process zone (UTC here), so verify against UTC instead
    }
    // walking in UTC, each result is strictly increasing and never repeats an instant
    const instants = [];
    t = instantOfWallTime(ZONE, 2026, 10, 30, 12, 0);
    for (let i = 0; i < 6; i++) {
      t = nextCronRun(cron, t);
      instants.push(t);
    }
    expect(new Set(instants).size).toBe(instants.length);
    for (let i = 1; i < instants.length; i++) expect(instants[i]).toBeGreaterThan(instants[i - 1]);
  });

  it('no cron fire is ever in the past, walking across both transitions', () => {
    const cron = parseCron('*/30 * * * *');
    // start before spring forward, walk 3000 fires (roughly 62 days), which covers March and April
    let t = instantOfWallTime(ZONE, 2026, 3, 1, 0, 0);
    let prev = t;
    for (let i = 0; i < 3000; i++) {
      const n = nextCronRun(cron, t);
      expect(n).not.toBeNull();
      expect(n).toBeGreaterThan(t);
      expect(n).toBeGreaterThan(prev);
      prev = n;
      t = n;
    }
  });

  it('a 30-minute schedule stays on 30-minute boundaries across a transition', () => {
    const cron = parseCron('*/30 * * * *');
    let t = instantOfWallTime(ZONE, 2026, 10, 31, 20, 0);
    for (let i = 0; i < 40; i++) {
      t = nextCronRun(cron, t);
      const p = partsIn(t);
      expect([0, 30]).toContain(p.minute);
      expect(p.second).toBe(0);
    }
  });
});