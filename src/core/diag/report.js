/**
 * Build the export the user hands back, from data that is already there.
 *
 * The point of separating this from the collection is that a log is only useful if it can be read: the reason
 * three earlier attempts at this bug failed is that the evidence existed in three different places (the run
 * history, the service-worker console, and the alarm state) and none of them said which path was taken.
 *
 * Pure, so the shape of the export is testable without a browser.
 */
import { decisionTrail, summarise } from './events.js';

/**
 * Format a time as HH:MM:SS.mmm, WITH THE DATE, whenever it is not today.
 *
 * THE REASON THE DATE IS HERE: an export showed `armed ... at 09:57:00.500` for a schedule whose target was 09:57:02,
 * which reads as "armed 1.5 seconds early" and was in fact "armed for tomorrow" - the arming had jumped a whole day
 * and the time-of-day still looked right. A log that cannot show that difference is not a log, it is a plausible
 * story. Dates are shown only when they differ from the day the export was taken, so the common case stays readable.
 */
export function stamp(ms, referenceMs = Date.now()) {
  if (!Number.isFinite(ms)) return '-';
  const d = new Date(ms);
  const r = new Date(referenceMs);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  const sameDay = d.getFullYear() === r.getFullYear() && d.getMonth() === r.getMonth() && d.getDate() === r.getDate();
  if (sameDay) return time;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${time} (${d.getDate()} ${months[d.getMonth()]})`;
}

/**
 * The version and environment header. Included because a report is only actionable if you know which build
 * produced it: the first report of this bug arrived against a version that already contained a fix, and there was
 * no way to tell.
 */
export function buildHeader({ version, browser, platform, now = Date.now(), timezoneOffsetMin }) {
  return {
    exportedAt: stamp(now),
    exportedAtMs: now,
    autoflowVersion: version ?? 'unknown',
    browser: browser ?? 'unknown',
    platform: platform ?? 'unknown',
    timezoneOffsetMin: Number.isFinite(timezoneOffsetMin) ? timezoneOffsetMin : null,
    // the offset matters: a schedule is a local wall-clock time, so a report from a machine an hour off will look
    // like the automations fired at the wrong time
    note: 'All times are local to the machine that produced this file.',
  };
}

/**
 * A concise, ordered account of the start decisions, one line each.
 *
 * This is the part that answers "did the alarm fire, and was the run accepted".
 */
export function buildDecisionLines(events) {
  return (Array.isArray(events) ? events : []).map((e) => {
    const t = stamp(e.at);
    switch (e.kind) {
      // `at` is when the alarm was ARMED FOR, and the record's own instant is separate - printing the record's own
      // time here was the same mistake twice: it hid a whole-day jump behind a plausible clock reading.
      // an `armed` event from the panel carries the same fields under a shorter kind, and both must read the same:
      // `target` is what the alarm was armed FOR, and it is what has to carry the date
      case 'armed':
      case 'alarm-armed': return `${t}  armed       ${e.automationId}  for ${stamp(e.target ?? e.at)}`
        + `${e.precise ? '  (precise)' : ''}`
        + `${e.via ? `  via ${e.via}` : ''}`
        + `${Number.isFinite(e.justMissedMs) ? `  [the target second had just passed by ${e.justMissedMs}ms - running now]` : ''}`;
      case 'alarm-fired': return `${t}  FIRED       ${e.automationId}`
        + `${Number.isFinite(e.latenessMs) ? `  ${e.latenessMs >= 0 ? 'late by' : 'early by'} ${Math.abs(e.latenessMs)}ms` : ''}`;
      case 're-armed': return `${t}  RE-ARMED    ${e.automationId}  for ${stamp(e.target)}`;
      case 'arm-skipped': return `${t}  ARM SKIPPED ${e.automationId}  ${e.note}`;
      case 'storm-refused': return `${t}  STORM REFUSED ${e.automationId}  ${e.firingsIn10s} firings in 10s`;
      case 'fired-late': return `${t}  FIRED LATE  ${e.automationId}  by ${e.lateByMs}ms - the run starts now`;
      case 'fired-too-late': return `${t}  FIRED TOO LATE ${e.automationId}  by ${e.lateByMs}ms (tolerance ${e.toleranceMs}ms) - the window was missed`;
      case 'arm-failed': return `${t}  ARM FAILED  ${e.automationId}  ${e.error}`;
      case 'alarm-late': return `${t}  FIRED LATE  ${e.automationId}  by ${e.lateByMs}ms`;
      case 'start-request': return `${t}  requested   ${e.automationId}  trigger=${e.trigger}${e.lateByMs ? `  late=${e.lateByMs}ms` : ''}`;
      case 'start-queued': return `${t}  QUEUED      ${e.automationId}  behind ${e.behind ?? 'another run'}  (queue depth ${e.depth})`;
      case 'start-refused': return `${t}  REFUSED     ${e.automationId}  ${e.reason}`;
      case 'start-accepted': return `${t}  ACCEPTED    ${e.automationId}  steps=${e.steps}  tab=${e.tabId}`;
      case 'run-finished': return `${t}  finished    ${e.automationId}  ${e.reason}  steps=${e.steps}  ${e.error ? `error: ${e.error}` : ''}`;
      case 'run-abandoned': return `${t}  ABANDONED   ${e.automationId}  ${e.reason}`;
      case 'worker-boot': return `${t}  worker started (boot #${e.boot})`;
      default: return `${t}  ${e.kind}  ${JSON.stringify({ ...e, at: undefined, kind: undefined })}`;
    }
  });
}

/**
 * Assemble the whole export.
 *
 * Sections rather than one blob because the first question about a missing click is always the same: was it
 * scheduled, did it fire, was it accepted, and what did it do. Ordered so the answer is at the top.
 */
export function buildExport({
  header, events, runs, automations, alarms, settings, pageLogs = [], includedPaths = [],
}) {
  const trail = buildDecisionLines(decisionTrail(events));
  return {
    header,
    // the answer, first
    decisionTrail: trail,
    summary: summarise(events),
    // then the raw material
    events,
    runs,
    automations,
    alarms,
    settings,
    // the page's own click log, if the test field was open and the user pressed its export button
    pageLogs,
    includedPaths,
  };
}

/** The same export as a readable text file, because pasting JSON into a message is not a thing people do. */
export function exportAsText(doc) {
  const L = [];
  const h = doc.header ?? {};
  L.push('AutoFlow diagnostic export');
  L.push('==========================');
  L.push(`version      : ${h.autoflowVersion}`);
  L.push(`browser      : ${h.browser}`);
  L.push(`platform     : ${h.platform}`);
  L.push(`exported     : ${h.exportedAt}`);
  L.push(`timezone off : ${h.timezoneOffsetMin} min (${h.note ?? ''})`);
  L.push('');

  L.push('-- start decisions, in order ' + '-'.repeat(30));
  const trail = doc.decisionTrail ?? [];
  if (!trail.length) L.push('(none recorded)');
  for (const line of trail) L.push(line);
  L.push('');

  const s = doc.summary ?? {};
  L.push(`-- events: ${s.count ?? 0}, kinds ${JSON.stringify(s.byKind ?? {})}`);
  L.push('');

  L.push('-- runs ' + '-'.repeat(56));
  const runs = doc.runs ?? [];
  if (!runs.length) L.push('(none)');
  for (const r of runs) {
    L.push(`${stamp(r.startedAt ?? r.at)}  ${r.automationId ?? '-'}  ${r.reason ?? '-'}  steps=${r.steps ?? '-'}  ${r.elapsedMs ?? '-'}ms  ${r.error?.message ? `ERROR: ${r.error.message}` : ''}`);
    for (const t of (r.trace ?? []).slice(-40)) {
      L.push(`      ${t.kind ?? ''} ${t.how ?? ''} ${t.error ? `ERROR ${t.error}` : ''}`.trimEnd());
    }
  }
  L.push('');

  L.push('-- scheduled alarms ' + '-'.repeat(43));
  for (const a of (doc.alarms ?? [])) {
    L.push(`${a.name ?? '-'}  at ${stamp(a.scheduledTime)}  period=${a.periodInMinutes ?? '-'}`);
  }
  if (!(doc.alarms ?? []).length) L.push('(no alarms registered)');
  L.push('');

  L.push('-- automations ' + '-'.repeat(48));
  for (const a of (doc.automations ?? [])) {
    const sc = a.schedule ?? {};
    L.push(`${a.id}  "${a.name}"  enabled=${a.enabled !== false}  schedule=${sc.kind ?? '-'}`
      + (sc.kind === 'cron' ? ` ${sc.cron ?? ''}` : ` ${String(sc.hour ?? '-').padStart(2, '0')}:${String(sc.minute ?? 0).padStart(2, '0')}${Number.isFinite(sc.second) ? `:${String(sc.second).padStart(2, '0')}` : ''}`)
      + `  steps=${(a.steps ?? []).length}`);
  }
  L.push('');

  L.push('-- test-field click logs ' + '-'.repeat(38));
  for (const p of (doc.pageLogs ?? [])) {
    L.push(`from ${p.url ?? '(unknown page)'}`);
    for (const c of (p.clicks ?? [])) L.push(`    ${c.at}  ${c.target}  +${c.delta ?? 0}ms`);
  }
  if (!(doc.pageLogs ?? []).length) L.push('(none - the test field was not open, or its export was not used)');
  L.push('');

  L.push('-- settings ' + '-'.repeat(50));
  L.push(JSON.stringify(doc.settings ?? {}, null, 2));
  L.push('');
  L.push('-- raw events ' + '-'.repeat(46));
  for (const e of (doc.events ?? [])) L.push(`${stamp(e.at)}  ${e.kind}  ${JSON.stringify({ ...e, at: undefined, kind: undefined })}`);
  return L.join('\n');
}