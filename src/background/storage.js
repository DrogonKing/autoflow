/**
 * Storage: automations, settings, run history and the data rows for CSV-driven runs.
 *
 * A thin layer over chrome.storage.local, with two responsibilities that are easy to get wrong:
 *
 *  1. A single write path per record, so two UI surfaces editing the same automation cannot clobber each
 *     other. Every mutation reads, merges by id, and writes — and the read is inside the write's
 *     critical section as far as the extension's single-threaded event loop allows.
 *  2. Migration. Records saved by an older version are upgraded on read, not rejected: a user who
 *     installed an earlier build must not lose their automations when this one lands.
 */

import { api } from '../platform/api.js';
import { pushEvent } from '../core/diag/events.js';

export const KEYS = {
  automations: 'automations',
  settings: 'settings',
  runs: 'runs',
  dataRows: 'dataRows',
  schemaVersion: 'schemaVersion',
  // its own key, so a settings write cannot drop diagnostic events (see recordEvent)
  diagnosticEvents: 'diagnosticEvents',
};

export const CURRENT_SCHEMA = 1;

export const DEFAULT_SETTINGS = {
  theme: 'dark',
  /** Ask before an automation touches a page it has never run on. */
  confirmNewOrigin: true,
  /** Keep the last N run records. */
  runHistoryLimit: 50,
  /** Panel keyboard shortcuts. */
  shortcutsEnabled: true,
  /** Stop everything if the tab loses focus unexpectedly. */
  stopOnTabBlur: false,
  // NOTE: diagnostic events are NOT here. They live under their own storage key - see recordEvent - because
  // sharing the settings object meant a settings write could silently drop them.

  /** Show the on-page status badge while a run is active. */
  showStatusBadge: true,
  /**
   * Bring the tab to the front just before a second-precise click.
   *
   * Default true, because a schedule with a second exists for the express purpose of hitting that second, and
   * a throttled background tab cannot: measured, five runs landed 479-756ms EARLY for that reason alone. A
   * user who would rather keep focus elsewhere can turn it off and accept the imprecision.
   */
  focusBeforePrecise: true,
  /**
   * Warn when this machine's clock differs from the server by at least this much.
   *
   * A whole second, not a few hundred ms: an HTTP Date header has one-second resolution, so a smaller apparent
   * difference is indistinguishable from noise. A warning that fires on noise teaches the user to ignore it.
   */
  skewWarnThresholdMs: 1000,
  /**
   * The last measured offset, kept so the panel can show it without re-measuring on every open.
   *
   * Reported only. Nothing applies it: see src/core/clock/skew.js.
   */
  lastClockOffsetMs: null,
  /**
   * UI language: 'system' follows the browser, otherwise a catalogue code.
   *
   * Stored as a preference rather than resolved here, because the resolution rule (a region subtag like
   * `fa-IR` mapping to `fa`, and an unsupported language falling back to English) is shared with the UI and
   * belongs in one tested place. This stores what the user chose, not what it resolved to.
   */
  language: 'system',
};

/**
 * Storage access, through the platform layer.
 *
 * The callback style that used to live here is exactly what breaks on Firefox: `chrome.storage` there
 * never calls a callback the way Chromium does, and `browser.storage` returns promises instead. The
 * platform layer resolves that, so this file is only about which area and which key.
 */
const local = () => api.storage.local;

export function get(keys) {
  return local().get(keys).then((result) => result ?? {});
}

export function set(items) {
  return local().set(items);
}

export function remove(keys) {
  return local().remove(keys);
}

// ---------------------------------------------------------------------------------------------
// migration
// ---------------------------------------------------------------------------------------------

/**
 * Bring a stored record up to the current schema.
 *
 * Deliberately forgiving: an unknown field is preserved rather than dropped, because a record written by
 * a newer build (a user who downgraded) must not lose data either.
 */
export function migrateAutomation(a) {
  if (!a || typeof a !== 'object') return a;
  const out = { ...a };
  if (!out.options) out.options = {};
  // v0 stored a single `delay` and no per-step delay support; normalise it
  if (out.delay !== undefined && out.options.stepDelayMs === undefined) {
    out.options.stepDelayMs = Number(out.delay) || 0;
    delete out.delay;
  }
  if (out.enabled === undefined) out.enabled = true;
  if (!out.schedule) out.schedule = { kind: 'manual' };
  if (!Array.isArray(out.urls)) out.urls = [];
  if (!out.id) out.id = `migrated-${Math.random().toString(36).slice(2, 10)}`;
  return out;
}

// ---------------------------------------------------------------------------------------------
// automations
// ---------------------------------------------------------------------------------------------

/**
 * Every stored automation, migrated and sorted.
 *
 * A malformed entry is skipped rather than allowed to fail the whole call. Storage can be damaged by a
 * interrupted write, a hand-edited file, or a build that wrote a different shape; in all three cases
 * throwing here would hide every automation the user owns because of one bad record.
 */
export async function listAutomations() {
  const { [KEYS.automations]: list } = await get(KEYS.automations);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    try {
      const a = migrateAutomation(raw);
      if (!a || typeof a !== 'object') continue;
      if (!a.name || !Array.isArray(a.steps)) continue;
      out.push(a);
    } catch {
      // one unreadable record must not cost the user the rest
    }
  }
  return out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export async function getAutomation(id) {
  const list = await listAutomations();
  return list.find((a) => a.id === id) ?? null;
}

/**
 * Create or replace one automation.
 *
 * Merge by id rather than replace the whole array: two surfaces (panel and options page) can be open at
 * once, and "write the array I loaded minutes ago" would silently drop the other surface's changes.
 */
export async function saveAutomation(automation) {
  if (!automation?.id) throw new Error('an automation needs an id');
  const list = await listAutomations();
  const idx = list.findIndex((a) => a.id === automation.id);
  const record = {
    ...automation,
    updatedAt: Date.now(),
    createdAt: automation.createdAt ?? (idx >= 0 ? list[idx].createdAt : Date.now()),
  };
  if (idx >= 0) list[idx] = record;
  else list.push(record);
  await set({ [KEYS.automations]: list, [KEYS.schemaVersion]: CURRENT_SCHEMA });
  return record;
}

export async function deleteAutomation(id) {
  const list = await listAutomations();
  const next = list.filter((a) => a.id !== id);
  await set({ [KEYS.automations]: next });
  return next.length !== list.length;
}

export async function duplicateAutomation(id) {
  const a = await getAutomation(id);
  if (!a) throw new Error(`no automation with id ${id}`);
  const copy = {
    ...JSON.parse(JSON.stringify(a)),
    id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: `${a.name} (copy)`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return saveAutomation(copy);
}

// ---------------------------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------------------------

/**
 * Serialises the diagnostic log's read-modify-write.
 *
 * WHY: `recordEvent` appends to one array with a read, a merge and a write. Two calls made in the same tick both
 * read the same array and the second write clobbers the first, so events are LOST - and the events most likely to
 * coincide are the ones at the same instant, which is precisely the case this log exists to explain. Measured: two
 * accepted starts and two finished runs produced only one `start-accepted` record.
 *
 * A promise chain is the queue: each append waits for the previous one to finish, so every event is written on top
 * of the last. It cannot deadlock because a failing append still resolves the chain.
 */
let eventWriteChain = Promise.resolve();

/**
 * The events are kept in memory as the source of truth for the queue, and storage is written from that.
 *
 * Reasoning: the storage layer does not serialise concurrent writes, so a read-modify-write built on it loses
 * events (measured: five appends in one tick, one survived). Keeping the list in memory means the read cannot go
 * stale, and storage becomes a single write of the whole list. The in-memory copy is rehydrated from storage on
 * first use, so events survive a service-worker restart.
 */
let eventCache = null;

/**
 * Append one diagnostic event.
 *
 * Deliberately NOT awaited by its callers: a diagnostic must never be able to slow down or fail a click. The
 * write is queued and forgotten, so a storage failure costs a log line rather than a run.
 */
export function recordEvent(event) {
  // stamped HERE, at the moment the event happened. Stamping inside the queued write put a start-accepted 4
  // seconds after the run it started, which destroys the ordering that makes the trail readable.
  const stamped = { ...event, at: event.at ?? Date.now() };
  /**
   * Written to its OWN storage key, not through `saveSettings`.
   *
   * `saveSettings` reads the whole settings object, merges, and writes it back. Two writers to different fields in
   * the same tick therefore clobber each other, and the events were the field that lost - measured as two of five
   * events disappearing. A separate key removes the sharing entirely, which is cheaper than a lock over every
   * settings write in the extension.
   */
  const write = eventWriteChain.then(async () => {
    // the read is from memory, inside the critical section: storage cannot supply a reliable "read the current
    // list" here because concurrent writes to one key are not serialised
    if (eventCache === null) {
      const { [KEYS.diagnosticEvents]: stored } = await get(KEYS.diagnosticEvents);
      eventCache = Array.isArray(stored) ? stored : [];
    }
    eventCache = pushEvent(eventCache, stamped);
    await set({ [KEYS.diagnosticEvents]: eventCache });
  });
  // the chain must survive a failure, or one storage error would stop all further logging
  eventWriteChain = write.catch(() => {});
  return write;
}

/** Wait for every queued append to land. Used by the export, so a file is never missing the newest events. */
export async function flushEvents() {
  await eventWriteChain.catch(() => {});
}

/** The stored events, oldest first. */
export async function readEvents() {
  await flushEvents();
  if (eventCache !== null) return eventCache.slice();
  const { [KEYS.diagnosticEvents]: list } = await get(KEYS.diagnosticEvents);
  return Array.isArray(list) ? list : [];
}

/** Clear them, after an export or when starting a clean test. */
export async function clearEvents() {
  await flushEvents();
  eventCache = [];
  await set({ [KEYS.diagnosticEvents]: [] });
}

export async function getSettings() {
  const { [KEYS.settings]: s } = await get(KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await set({ [KEYS.settings]: next });
  return next;
}

// ---------------------------------------------------------------------------------------------
// run history
// ---------------------------------------------------------------------------------------------

export async function recordRun(entry) {
  const settings = await getSettings();
  const { [KEYS.runs]: runs } = await get(KEYS.runs);
  const list = Array.isArray(runs) ? runs : [];
  const record = { ...entry, finishedAt: entry.finishedAt ?? Date.now() };
  list.unshift(record);
  const limited = list.slice(0, Math.max(1, settings.runHistoryLimit));
  await set({ [KEYS.runs]: limited });
  return record;
}

export async function listRuns() {
  const { [KEYS.runs]: runs } = await get(KEYS.runs);
  return Array.isArray(runs) ? runs : [];
}

export async function clearRuns() {
  await remove(KEYS.runs);
}

// ---------------------------------------------------------------------------------------------
// data rows (CSV)
// ---------------------------------------------------------------------------------------------

/**
 * Data rows are kept in `session` storage, not `local`.
 *
 * A 50,000-row CSV would otherwise be copied to disk forever, and the rows are only needed while the
 * automation that consumes them is running. Losing them on a browser restart is the correct behaviour.
 */
export async function setDataRows(key, data) {
  return api.storage.session.set({ [`${KEYS.dataRows}:${key}`]: data });
}

export async function getDataRows(key) {
  const result = await api.storage.session.get(`${KEYS.dataRows}:${key}`);
  return result?.[`${KEYS.dataRows}:${key}`] ?? null;
}

/**
 * Upload files, kept in session storage.
 *
 * A file attached to an upload step is the user's own document. It is held only for the lifetime of the
 * browser session, alongside the CSV rows, so a document the user attached once is not left on disk
 * indefinitely.
 */
export async function setUploadFile(name, record) {
  return api.storage.session.set({ [`upload:${name}`]: record });
}

export async function getUploadFile(name) {
  const result = await api.storage.session.get(`upload:${name}`);
  return result?.[`upload:${name}`] ?? null;
}

export async function listUploadFiles() {
  const all = await api.storage.session.get(null);
  return Object.entries(all ?? {})
    .filter(([k]) => k.startsWith('upload:'))
    .map(([k, v]) => ({ name: k.slice('upload:'.length), mime: v.mime, size: v.size }));
}

export async function clearDataRows(key) {
  return api.storage.session.remove(`${KEYS.dataRows}:${key}`);
}

// ---------------------------------------------------------------------------------------------
// import / export
// ---------------------------------------------------------------------------------------------

export async function exportAll() {
  const [automations, settings] = await Promise.all([listAutomations(), getSettings()]);
  // Say in the document itself whether it carries script steps, so whoever receives the file can decide
  // before importing rather than discovering it afterwards.
  const concerns = automations.flatMap((a) => auditImportedAutomation(a).map((c) => ({ ...c, automation: a.name })));
  return {
    format: 'autoflow-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    containsScripts: concerns.some((c) => c.severity === 'high'),
    concerns,
    automations,
    settings,
  };
}

/**
 * Import a document produced by exportAll, or a bare array of automations.
 *
 * Returns a report rather than throwing on the first bad record: importing 49 of 50 automations and
 * saying which one failed is more useful than importing none.
 */
/**
 * Step kinds an imported file is allowed to contain without a warning.
 *
 * `runScript` is deliberately excluded. An automation file is something a user downloads from a forum or
 * receives from a colleague, and a `runScript` step is arbitrary JavaScript executed in whatever page the
 * automation later runs on - with access to that page's session, forms and data. A file that carries one
 * must not be imported silently, so it is flagged and the caller decides.
 *
 * The same reasoning applies to a `goto` step pointing at a remote host, which is how a run could be
 * pointed at an endpoint that receives a template value.
 */
const STEP_KINDS_WITHOUT_WARNING = new Set([
  'click', 'fill', 'clear', 'check', 'select', 'hover', 'focus', 'blur', 'submit', 'scroll',
  'key', 'wait', 'waitFor', 'goto', 'reload', 'back', 'forward', 'newTab', 'switchTab', 'closeTab',
  'loop', 'if', 'setVariable', 'extract', 'notify', 'sound', 'download', 'screenshot',
  'stop', 'break', 'continue',
]);

/** Every step in an automation, including nested ones inside loops and branches. */
function allSteps(steps, out = []) {
  for (const s of steps ?? []) {
    if (!s || typeof s !== 'object') continue;
    out.push(s);
    for (const key of ['steps', 'then', 'else']) {
      if (Array.isArray(s[key])) allSteps(s[key], out);
    }
  }
  return out;
}

/**
 * Inspect an automation for anything that should not be imported without the user knowing.
 *
 * Returns a list of concrete concerns, each naming the step. This is a report, not a gate: it exists so
 * the UI can ask, rather than so an import can be silently refused - a user importing their own backup
 * must not be blocked by their own legitimate script step.
 */
export function auditImportedAutomation(automation) {
  const concerns = [];
  const steps = allSteps(automation?.steps);

  for (const step of steps) {
    if (!STEP_KINDS_WITHOUT_WARNING.has(step.kind)) {
      concerns.push({
        stepId: step.id,
        kind: step.kind,
        severity: step.kind === 'runScript' ? 'high' : 'medium',
        detail: step.kind === 'runScript'
          ? 'runs arbitrary JavaScript in whatever page this automation later operates on'
          : `unrecognised step kind "${step.kind}" - it will fail or do nothing`,
      });
    }
    if (step.kind === 'runScript' && typeof step.code === 'string' && step.code.length > 2000) {
      concerns.push({
        stepId: step.id,
        kind: step.kind,
        severity: 'medium',
        detail: `the script is ${step.code.length} characters, which is unusually large for a step`,
      });
    }
    if (step.kind === 'goto' && typeof step.url === 'string' && /\$\{/.test(step.url)) {
      concerns.push({
        stepId: step.id,
        kind: step.kind,
        severity: 'medium',
        detail: 'navigates to a URL built from a template, which can send data to another host',
      });
    }
    // a finder that can reach a different origin is not itself dangerous, but a very long selector is a
    // sign of a hand-crafted payload rather than a recorded one
    if (step.finder?.selector && step.finder.selector.length > 800) {
      concerns.push({
        stepId: step.id,
        kind: step.kind,
        severity: 'low',
        detail: `the selector is ${step.finder.selector.length} characters long`,
      });
    }

    // Conditions carry executable-adjacent data of their own, so they are audited with the steps rather
    // than assumed harmless. Two things are flagged, and neither is exploitable today:
    //   - a `source: 'js'` condition is advertised by the model yet nothing evaluates it, so it can only
    //     mislead. Flagging it means that the day someone implements evaluation, imported files are already
    //     being inspected for it.
    //   - a regular expression in a condition is author-supplied and can be catastrophic; a very long one is
    //     worth showing the user before they run it on a page.
    for (const condition of allConditions(step)) {
      if (condition?.source === 'js') {
        concerns.push({
          stepId: step.id,
          kind: step.kind,
          severity: 'medium',
          detail: 'a condition uses the "js" source, which this build does not evaluate - it will never match',
        });
      }
      if (condition?.comparator === 'matches' && typeof condition.value === 'string') {
        if (condition.value.length > 200) {
          concerns.push({
            stepId: step.id,
            kind: step.kind,
            severity: 'low',
            detail: `a regular expression in a condition is ${condition.value.length} characters long`,
          });
        } else {
          try {
            new RegExp(condition.value);
          } catch {
            concerns.push({
              stepId: step.id,
              kind: step.kind,
              severity: 'medium',
              detail: `a regular expression in a condition is invalid: ${condition.value.slice(0, 60)}`,
            });
          }
        }
      }
      // a condition tree can be deep, and a self-referential one would loop forever
      const depth = conditionDepth(condition, 0);
      if (depth > 12) {
        concerns.push({
          stepId: step.id,
          kind: step.kind,
          severity: 'medium',
          detail: `a condition tree is nested ${depth} levels deep`,
        });
      }
    }
  }

  return concerns;
}

/**
 * Every condition in a step, flattened.
 *
 * Conditions appear in more than one shape: `step.condition` for a waitFor or a branch, `step.condition` and
 * `step.elseCondition` for an if/else, and inside a loop's `whileCondition`. Gathering them all here means a
 * new shape cannot silently escape the audit - which is exactly the failure mode this function exists to
 * prevent.
 */
function allConditions(step) {
  const out = [];
  const push = (c) => {
    if (!c || typeof c !== 'object') return;
    out.push(c);
    // a condition tree: `when`/`all`/`any`/`not` hold children
    for (const key of ['when', 'all', 'any', 'not', 'condition', 'elseCondition']) {
      if (key in c) {
        if (Array.isArray(c[key])) for (const child of c[key]) push(child);
        else push(c[key]);
      }
    }
  };
  for (const key of ['condition', 'elseCondition', 'whileCondition']) push(step?.[key]);
  return out;
}

/** How deep a condition tree goes, with a cap so a cycle cannot hang the audit. */
function conditionDepth(condition, depth, seen = new Set()) {
  if (!condition || typeof condition !== 'object' || depth > 24) return depth;
  if (seen.has(condition)) return depth; // a cycle: report the depth reached and stop
  seen.add(condition);
  let max = depth;
  for (const key of ['when', 'all', 'any', 'not', 'condition', 'elseCondition']) {
    const child = condition[key];
    if (Array.isArray(child)) {
      for (const c of child) max = Math.max(max, conditionDepth(c, depth + 1, seen));
    } else if (child) {
      max = Math.max(max, conditionDepth(child, depth + 1, seen));
    }
  }
  return max;
}

export async function importAll(doc, { replace = false, allowScripts = false } = {}) {
  const incoming = Array.isArray(doc) ? doc : doc?.automations;
  if (!Array.isArray(incoming)) throw new Error('the file does not contain a list of automations');

  /**
   * THE EXISTING AUTOMATIONS ARE ALWAYS LOADED, and `replace` no longer means "start from nothing".
   *
   * MEASURED: with `replace` emptying this list, a file holding one usable automation and two broken ones took the user
   * from 2 automations to 1 - their own work deleted by a restore, reported as a successful import of one item.
   *
   * `replace` now means what a person means by it: for an id that appears in BOTH the file and here, the file's version
   * wins. It does not mean "delete everything the file does not mention" - removing an automation is the Delete button,
   * not a side effect of restoring a backup.
   */
  const existing = await listAutomations();
  const byId = new Map(existing.map((a) => [a.id, a]));
  const imported = [];
  const skipped = [];
  const flagged = [];

  incoming.forEach((raw, i) => {
    try {
      if (!raw || typeof raw !== 'object') throw new Error('not an object');
      const a = migrateAutomation(raw);
      if (!a.name || !Array.isArray(a.steps) || a.steps.length === 0) {
        throw new Error('missing a name or steps');
      }
      // a step list can be arbitrarily nested; a bound stops a crafted file from exhausting the stack
      const steps = allSteps(a.steps);
      if (steps.length > 20_000) {
        throw new Error(`contains ${steps.length} steps, which is beyond any real automation`);
      }
      for (const s of steps) {
        if (typeof s.kind !== 'string') throw new Error('a step has no kind');
      }

      const concerns = auditImportedAutomation(a);
      const hasScript = concerns.some((c) => c.severity === 'high');
      flagged.push(...concerns.map((c) => ({ ...c, automationName: a.name })));

      // A script-carrying automation is held back unless the caller explicitly allows it. Importing
      // everything and warning afterwards would be theatre: by then the step is saved and could run.
      if (hasScript && !allowScripts) {
        skipped.push({
          index: i,
          name: a.name,
          reason: 'contains a script step; re-import with scripts allowed to accept it',
        });
        return;
      }

      // a re-import must not overwrite a local automation with the same id unless replacing
      if (byId.has(a.id) && !replace) {
        a.id = `${a.id}-imported-${i}`;
      }
      /**
       * AN IMPORTED AUTOMATION ARRIVES SWITCHED OFF.
       *
       * MEASURED (B7): imported records keep their own `enabled: true`, and the caller then reschedules everything - so a
       * restore armed and STARTED automations the user had never looked at. A file is data from outside this machine;
       * nothing in it should be able to schedule an order before a person has read it. Turning it on is one click, and
       * the click is the review.
       */
      a.enabled = false;
      byId.set(a.id, a);
      imported.push(a);
    } catch (e) {
      skipped.push({ index: i, name: raw?.name ?? '(unnamed)', reason: e.message });
    }
  });

  /**
   * A REPLACE THAT ACCEPTED NOTHING MUST NOT ERASE ANYTHING.
   *
   * MEASURED (B7): `replace: true` starts from an empty list, so a backup file whose every item was refused - corrupt,
   * from another version, or holding a script step that is held back - saved the EMPTY list. The user's own backup
   * button erased every automation they had, and the result read as a successful restore of nothing.
   *
   * Refusing to touch anything is the only honest outcome: nothing was imported, so there is nothing to replace.
   */
  if (replace && imported.length === 0) {
    return {
      imported: 0,
      skipped,
      concerns: flagged,
      refused: true,
      reason: skipped.length
        ? `nothing in the file could be imported (${skipped.length} item(s) refused), so the automations already here were left alone`
        : 'the file contained no automations, so the automations already here were left alone',
    };
  }

  /**
   * A REPLACE ALSO USUALLY MEANS THE FILE IS INCOMPLETE, so what it does not mention is KEPT.
   *
   * CASE 1, MEASURED: a file with one usable automation and two broken ones replaced two working automations with one -
   * 2 -> 1, the user's own work deleted by a restore. Anything the file does not mention is left where it is; removing
   * an automation is the panel's Delete button, not a side effect of restoring.
   */
  // `byId` already holds the existing automations (or a copy of them, under replace) plus what was imported, so the
  // merge is the same either way. `replace` decides which of two records wins for the same id, nothing else.
  const merged = [...byId.values()];

  await set({ [KEYS.automations]: merged, [KEYS.schemaVersion]: CURRENT_SCHEMA });
  return { imported: imported.length, skipped, concerns: flagged };
}