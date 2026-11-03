/**
 * FIXTURES — the per-time click gap.
 *
 * The feature: a small settings affordance on each time, holding a millisecond interval applied BETWEEN the picks of that
 * one time. Default 0, which is today's behaviour (all picks fire together). It belongs to the time, so setting 20 ms on
 * the 10:10:50.250 time must not touch any other time.
 *
 * The measurement that matters is the INTERVAL BETWEEN THE CLICKS, not the spacing of the scheduled instants, so the run's
 * own trace is what the tests assert on: each step records when it started relative to the run, and the gaps between those
 * numbers are the real answer.
 */

/** Build a run trace with the given step intervals, for the assertions about arithmetic. */
export const traceWithGaps = (gaps) => {
  let at = 0;
  const out = [{ type: 'run-start', name: 'x', at }];
  gaps.forEach((gap, i) => {
    at += gap;
    out.push({ type: 'step-ok', stepId: `p${i + 1}`, at });
  });
  return out;
};
