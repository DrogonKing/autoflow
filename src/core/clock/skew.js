/**
 * Clock skew between this machine and a server, and what to do about it.
 *
 * WHY THIS EXISTS, and it is the last remaining source of multi-second error: the measured click offset is
 * +4..+8ms when the schedule fires precisely. Nothing in the extension can move that by seconds. But the
 * machine's clock can be seconds off, and then a schedule set to 09:00:00 acts at a different real moment
 * than the exchange's 09:00:00 - early (the window is not open) or late (the window has moved on). That is
 * the only thing worth correcting, and it is measurable rather than guessable.
 *
 * HOW IT IS MEASURED. A request is sent, the response's `Date` header is read, and the round trip is timed:
 *
 *     t0 ─────────── send ──────────▶  server
 *                                       │ stamp = Date header
 *     t1 ◀───────── receive ────────  server
 *
 * The server stamped the header at approximately the midpoint of the round trip, so
 *
 *     offset = serverStamp - (t0 + rtt / 2)
 *
 * Positive offset means the SERVER is ahead, i.e. this machine is behind. To act at server time `T`, this
 * machine's clock should read `T - offset`.
 *
 * THE HONEST LIMITATION, which is why this warns rather than decides. An HTTP `Date` header has ONE-SECOND
 * resolution - there is no sub-second part in the format. So the measurement cannot be better than about
 * +/- 500ms from that alone, plus half the round-trip jitter. Anything under a second is not distinguishable
 * from noise, which is why the default warning threshold is 1000ms and not 200ms: a warning that fires on
 * noise is worse than no warning, because it trains the user to ignore it.
 *
 * This module is pure. The request is made by the caller; everything here is arithmetic and wording, so the
 * behaviour is provable without a network.
 */

/** A `Date` header only has second resolution, so a smaller difference is not distinguishable from noise. */
export const DATE_HEADER_RESOLUTION_MS = 1000;

/** Warn only when the skew could actually move a schedule by whole seconds. */
export const DEFAULT_WARN_THRESHOLD_MS = 1000;

/**
 * How far this machine's clock is from the server's.
 *
 * @param t0          client clock before the request was sent
 * @param t1          client clock after the response arrived
 * @param serverStamp epoch ms parsed from the response's `Date` header
 * @returns {{ offsetMs: number, rttMs: number, uncertaintyMs: number, trustworthy: boolean }}
 *          `offsetMs` positive means the server is ahead of this machine.
 */
export function clockOffset({ t0, t1, serverStamp }) {
  const rttMs = Math.max(0, t1 - t0);
  // the server stamped at roughly the midpoint of the exchange
  const estimatedAtServerStamp = t0 + rttMs / 2;
  const offsetMs = Math.round(serverStamp - estimatedAtServerStamp);
  // the header's own resolution dominates the error; the round trip adds up to half of itself
  const uncertaintyMs = Math.round(DATE_HEADER_RESOLUTION_MS / 2 + rttMs / 2);
  return {
    offsetMs,
    rttMs,
    uncertaintyMs,
    // a sample whose jitter exceeds the value being measured says nothing. Half a second of round trip is
    // the practical ceiling for a useful reading.
    trustworthy: rttMs < 1000,
  };
}

/** Is this offset large enough to be worth telling the user about? */
export function shouldWarn(offsetMs, thresholdMs = DEFAULT_WARN_THRESHOLD_MS) {
  return Number.isFinite(offsetMs) && Math.abs(offsetMs) >= thresholdMs;
}

/**
 * Where to aim this machine's clock so that it acts at a given server time.
 *
 * `targetServerMs` is the moment wanted in SERVER time; the result is the moment to program into an alarm,
 * which reads this machine's clock. A positive offset (server ahead) means this machine must fire earlier in
 * its own terms, hence the subtraction.
 */
export function correctedTarget(targetServerMs, offsetMs) {
  if (!Number.isFinite(targetServerMs)) return null;
  if (!Number.isFinite(offsetMs)) return targetServerMs;
  return targetServerMs - offsetMs;
}

/** How the correction relocates the action, in words, for the trace. */
export function describeCorrection(offsetMs, language = 'en') {
  const fa = language === 'fa';
  const ms = Math.round(offsetMs);
  if (!Number.isFinite(ms) || ms === 0) {
    return fa ? 'اختلاف ساعت: صفر' : 'clock offset: none';
  }
  const ahead = ms > 0;         // the server is ahead, so this machine is behind
  const abs = Math.abs(ms);
  if (fa) {
    return ahead
      ? `ساعت این دستگاه ${abs}ms عقب است؛ اجرا به همان اندازه جلو کشیده شد`
      : `ساعت این دستگاه ${abs}ms جلو است؛ اجرا به همان اندازه عقب کشیده شد`;
  }
  return ahead
    ? `this machine is ${abs}ms behind the server; the run was moved earlier by that much`
    : `this machine is ${abs}ms ahead of the server; the run was moved later by that much`;
}

/**
 * The user-facing reading, worded so the direction cannot be misread.
 *
 * "server is 1.2s ahead" is unambiguous; "offset: +1200" is not, and getting the sign wrong here would move a
 * schedule the wrong way - which for an order window is worse than not correcting at all.
 */
export function describeSkew({ offsetMs, rttMs, trustworthy = true }, language = 'en') {
  const fa = language === 'fa';
  const abs = Math.abs(Math.round(offsetMs));
  const secs = (abs / 1000).toFixed(abs >= 1000 ? 1 : 2);

  if (!trustworthy) {
    return fa
      ? `اندازه‌گیری نامطمئن است (رفت‌وبرگشت ${Math.round(rttMs)}ms) — دوباره امتحان کن`
      : `the reading is unreliable (round trip ${Math.round(rttMs)}ms) - try again`;
  }
  if (abs < DATE_HEADER_RESOLUTION_MS / 2) {
    return fa
      ? 'ساعت این دستگاه و سرور هم‌خوان هستند (اختلاف قابل‌اندازه‌گیری نیست)'
      : 'this machine and the server agree (no measurable difference)';
  }
  if (offsetMs > 0) {
    return fa
      ? `ساعت سرور حدود ${secs} ثانیه جلوتر است — ساعت این دستگاه عقب است`
      : `the server clock is about ${secs}s ahead - this machine is behind`;
  }
  return fa
    ? `ساعت سرور حدود ${secs} ثانیه عقب‌تر است — ساعت این دستگاه جلو است`
    : `the server clock is about ${secs}s behind - this machine is ahead`;
}

/** Bounds for the stored threshold, so a bad value cannot disable or spam the warning. */
export function normaliseSkewSettings(settings = {}) {
  const raw = Number(settings.skewWarnThresholdMs);
  const thresholdMs = Number.isFinite(raw) && raw >= 0 && raw <= 60_000
    ? Math.floor(raw) : DEFAULT_WARN_THRESHOLD_MS;
  return { thresholdMs, autoApply: settings.skewAutoApply === true };
}
