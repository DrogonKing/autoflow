/**
 * Storage and alarm tests, against a fake chrome API.
 *
 * These cover the two places where a browser extension loses data or misses a run:
 *
 *  - Migration: a record written by an older build must survive a read, not be rejected. A user who
 *    installed an earlier version must not lose their automations.
 *  - Rescheduling: an alarm that is never armed means a schedule silently never fires, and a stale alarm
 *    means it fires for an automation that no longer exists. Both are tested.
 *
 * The chrome mock is deliberately small and strict: it only implements what the code uses, so a call to
 * something not in the mock fails loudly rather than passing by accident.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------------------------
// a minimal chrome API
// ---------------------------------------------------------------------------------------------

function makeChrome() {
  const local = {};
  const session = {};
  const alarms = new Map();
  const listeners = { message: [], alarm: [], installed: [], startup: [], command: [] };

  const area = (store) => ({
    get(keys, cb) {
      let out = {};
      if (keys === null || keys === undefined) out = { ...store };
      else if (typeof keys === 'string') {
        if (keys in store) out[keys] = store[keys];
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (k in store) out[k] = store[k];
      } else if (typeof keys === 'object') {
        for (const [k, def] of Object.entries(keys)) out[k] = k in store ? store[k] : def;
      }
      cb(out);
    },
    set(items, cb) {
      Object.assign(store, JSON.parse(JSON.stringify(items)));
      cb?.();
    },
    remove(keys, cb) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      cb?.();
    },
    clear(cb) {
      for (const k of Object.keys(store)) delete store[k];
      cb?.();
    },
  });

  return {
    _stores: { local, session },
    _alarms: alarms,
    _listeners: listeners,
    storage: { local: area(local), session: area(session) },
    runtime: {
      lastError: undefined,
      id: 'test-extension',
      getManifest: () => ({ version: '1.0.0', manifest_version: 3 }),
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: vi.fn(),
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    },
    alarms: {
      create(name, info) {
        if (typeof name === 'object') {
          info = name;
          name = '';
        }
        const when = info.when ?? Date.now() + (info.delayInMinutes ?? 0) * 60_000;
        alarms.set(name, { name, scheduledTime: when, ...info });
      },
      getAll: async () => [...alarms.values()],
      clear: async (name) => alarms.delete(name),
      clearAll: async () => alarms.clear(),
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: 1, url: 'https://example.com', status: 'complete' })),
      create: vi.fn(async () => ({ id: 2 })),
      update: vi.fn(async () => ({ id: 1 })),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    notifications: { create: vi.fn(async () => 'n1') },
    downloads: { download: vi.fn(async () => 1) },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
    },
    commands: { onCommand: { addListener: (fn) => listeners.command.push(fn) } },
    sidePanel: { setPanelBehavior: vi.fn(async () => {}), open: vi.fn(async () => {}) },
  };
}

/** Load a module fresh, with a given chrome global. */
async function withChrome(chromeMock, fn) {
  globalThis.chrome = chromeMock;
  return fn();
}

let chromeMock;

beforeEach(() => {
  chromeMock = makeChrome();
  globalThis.chrome = chromeMock;
  vi.resetModules();
});

// ---------------------------------------------------------------------------------------------

describe('storage — automations', () => {
  const load = () => import('../src/background/storage.js');

  const sample = (over = {}) => ({
    id: 'a1',
    name: 'Sample',
    steps: [{ id: 's1', kind: 'reload' }],
    schedule: { kind: 'manual' },
    enabled: true,
    ...over,
  });

  it('saves and reads back', async () => {
    const s = await load();
    await s.saveAutomation(sample());
    const list = await s.listAutomations();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Sample');
    expect(list[0].updatedAt).toBeGreaterThan(0);
  });

  it('replaces by id rather than appending a duplicate', async () => {
    const s = await load();
    await s.saveAutomation(sample());
    await s.saveAutomation(sample({ name: 'Renamed' }));
    const list = await s.listAutomations();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Renamed');
  });

  it('keeps createdAt across an update', async () => {
    const s = await load();
    const first = await s.saveAutomation(sample({ createdAt: 1000 }));
    const second = await s.saveAutomation({ ...first, name: 'x' });
    expect(second.createdAt).toBe(1000);
  });

  it('does not clobber an automation another surface added', async () => {
    // Two surfaces (panel and options) can be open together. Writing the whole array from a stale read
    // would silently drop the other's work.
    const s = await load();
    await s.saveAutomation(sample({ id: 'a1', name: 'one' }));
    await s.saveAutomation(sample({ id: 'a2', name: 'two' }));
    const list = await s.listAutomations();
    expect(list.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
  });

  it('deletes', async () => {
    const s = await load();
    await s.saveAutomation(sample());
    expect(await s.deleteAutomation('a1')).toBe(true);
    expect(await s.listAutomations()).toHaveLength(0);
    expect(await s.deleteAutomation('a1')).toBe(false);
  });

  it('duplicates with a new id and a distinct name', async () => {
    const s = await load();
    await s.saveAutomation(sample());
    const copy = await s.duplicateAutomation('a1');
    expect(copy.id).not.toBe('a1');
    expect(copy.name).toMatch(/copy/);
    expect(await s.listAutomations()).toHaveLength(2);
  });

  it('sorts by name', async () => {
    const s = await load();
    await s.saveAutomation(sample({ id: 'z', name: 'Zeta' }));
    await s.saveAutomation(sample({ id: 'a', name: 'Alpha' }));
    const list = await s.listAutomations();
    expect(list.map((a) => a.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('returns null for an unknown id', async () => {
    const s = await load();
    expect(await s.getAutomation('nope')).toBeNull();
  });
});

describe('storage — migration', () => {
  const load = () => import('../src/background/storage.js');

  it('normalises a record missing the newer fields', async () => {
    const s = await load();
    // a record as an older build would have written it: no options, no enabled, no schedule
    chromeMock._stores.local.automations = [
      { id: 'old', name: 'From v0', steps: [{ id: 'x', kind: 'reload' }], delay: 250 },
    ];
    const list = await s.listAutomations();
    expect(list[0].options.stepDelayMs).toBe(250);
    expect(list[0].delay).toBeUndefined();
    expect(list[0].enabled).toBe(true);
    expect(list[0].schedule).toEqual({ kind: 'manual' });
    expect(list[0].urls).toEqual([]);
  });

  it('gives an id to a record that has none', async () => {
    const s = await load();
    chromeMock._stores.local.automations = [{ name: 'No id', steps: [{ id: 'x', kind: 'reload' }] }];
    const list = await s.listAutomations();
    expect(list[0].id).toBeTruthy();
  });

  it('preserves an unknown field rather than dropping it', async () => {
    // a record written by a NEWER build must not lose data either, if the user downgraded
    const s = await load();
    chromeMock._stores.local.automations = [
      { id: 'n', name: 'Newer', steps: [{ id: 'x', kind: 'reload' }], somethingNew: { keep: true } },
    ];
    const list = await s.listAutomations();
    expect(list[0].somethingNew).toEqual({ keep: true });
  });

  it('survives a corrupt entry rather than throwing on the whole list', async () => {
    const s = await load();
    chromeMock._stores.local.automations = [null, 'nonsense', { id: 'ok', name: 'Fine', steps: [] }];
    const list = await s.listAutomations();
    expect(Array.isArray(list)).toBe(true);
  });
});

describe('storage — settings', () => {
  const load = () => import('../src/background/storage.js');

  it('returns the defaults when nothing is stored', async () => {
    const s = await load();
    const settings = await s.getSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.runHistoryLimit).toBe(50);
  });

  it('merges a patch over the current values', async () => {
    const s = await load();
    await s.saveSettings({ theme: 'light' });
    const settings = await s.saveSettings({ runHistoryLimit: 10 });
    expect(settings.theme).toBe('light');
    expect(settings.runHistoryLimit).toBe(10);
  });
});

describe('storage — run history', () => {
  const load = () => import('../src/background/storage.js');

  it('records runs newest first', async () => {
    const s = await load();
    await s.recordRun({ id: 'r1', name: 'one', reason: 'finished' });
    await s.recordRun({ id: 'r2', name: 'two', reason: 'finished' });
    const runs = await s.listRuns();
    expect(runs[0].id).toBe('r2');
  });

  it('honours the history limit', async () => {
    const s = await load();
    await s.saveSettings({ runHistoryLimit: 3 });
    for (let i = 0; i < 6; i++) {
      await s.recordRun({ id: `r${i}`, name: `run ${i}`, reason: 'finished' });
    }
    const runs = await s.listRuns();
    expect(runs).toHaveLength(3);
    expect(runs[0].id).toBe('r5');
  });

  it('clears', async () => {
    const s = await load();
    await s.recordRun({ id: 'r1', name: 'x', reason: 'finished' });
    await s.clearRuns();
    expect(await s.listRuns()).toHaveLength(0);
  });
});

describe('storage — export and import', () => {
  const load = () => import('../src/background/storage.js');

  const make = (id, name, over = {}) => ({
    id, name, steps: [{ id: `${id}s`, kind: 'reload' }], schedule: { kind: 'manual' }, enabled: true, ...over,
  });

  it('exports a versioned document', async () => {
    const s = await load();
    await s.saveAutomation(make('a1', 'One'));
    const doc = await s.exportAll();
    expect(doc.format).toBe('autoflow-export');
    expect(doc.version).toBe(1);
    expect(doc.automations).toHaveLength(1);
    expect(doc.exportedAt).toBeTruthy();
  });

  it('imports new automations', async () => {
    const s = await load();
    const report = await s.importAll({ automations: [make('x1', 'Imported')] });
    expect(report.imported).toBe(1);
    expect((await s.listAutomations()).some((a) => a.name === 'Imported')).toBe(true);
  });

  it('renames an id collision instead of overwriting', async () => {
    const s = await load();
    await s.saveAutomation(make('same', 'Local'));
    const report = await s.importAll({ automations: [make('same', 'From file')] });
    const list = await s.listAutomations();
    expect(list).toHaveLength(2);
    expect(list.some((a) => a.name === 'Local')).toBe(true);
    expect(list.some((a) => a.name === 'From file')).toBe(true);
    expect(report.imported).toBe(1);
  });

  it('replaces when asked', async () => {
    const s = await load();
    await s.saveAutomation(make('same', 'Local'));
    await s.importAll({ automations: [make('same', 'From file')] }, { replace: true });
    const list = await s.listAutomations();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('From file');
  });

  it('reports which entries it skipped instead of failing the lot', async () => {
    const s = await load();
    const report = await s.importAll({ automations: [
      make('good1', 'Good'),
      { id: 'bad', name: '', steps: [] },              // no name, no steps
      make('good2', 'Also good'),
    ] });
    expect(report.imported).toBe(2);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toMatch(/name or steps/);
  });

  it('accepts a bare array as well as a document', async () => {
    const s = await load();
    const report = await s.importAll([make('bare', 'Bare array')]);
    expect(report.imported).toBe(1);
  });

  it('rejects a document with no automations array', async () => {
    const s = await load();
    await expect(s.importAll({ nope: true })).rejects.toThrow(/list of automations/);
  });
});

describe('storage — data rows', () => {
  const load = () => import('../src/background/storage.js');

  it('stores rows in session storage, so they do not persist to disk', async () => {
    const s = await load();
    await s.setDataRows('k1', [{ a: 1 }, { a: 2 }]);
    const back = await s.getDataRows('k1');
    expect(back).toHaveLength(2);
    // the point of session storage: nothing landed in local
    expect(JSON.stringify(chromeMock._stores.local)).not.toContain('k1');
  });

  it('returns null for an unknown key', async () => {
    const s = await load();
    expect(await s.getDataRows('nothing')).toBeNull();
  });

  it('clears', async () => {
    const s = await load();
    await s.setDataRows('k', [1]);
    await s.clearDataRows('k');
    expect(await s.getDataRows('k')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe('alarms — scheduling bridge', () => {
  const load = () => import('../src/background/alarms.js');

  const automation = (over = {}) => ({
    id: 'a1',
    name: 'Test',
    enabled: true,
    schedule: { kind: 'interval', everyMs: 60_000 },
    steps: [{ id: 's', kind: 'reload' }],
    ...over,
  });

  it('creates an alarm for an enabled automation', async () => {
    const a = await load();
    const results = await a.rescheduleAll([automation()]);
    expect(results[0].ok).toBe(true);
    expect(chromeMock._alarms.size).toBe(1);
    expect(chromeMock._alarms.has('autoflow:run:a1')).toBe(true);
  });

  it('skips a manual schedule', async () => {
    const a = await load();
    await a.rescheduleAll([automation({ schedule: { kind: 'manual' } })]);
    expect(chromeMock._alarms.size).toBe(0);
  });

  it('skips a disabled automation', async () => {
    const a = await load();
    await a.rescheduleAll([automation({ enabled: false })]);
    expect(chromeMock._alarms.size).toBe(0);
  });

  it('clears an alarm whose automation was disabled', async () => {
    const a = await load();
    await a.rescheduleAll([automation()]);
    expect(chromeMock._alarms.size).toBe(1);
    await a.rescheduleAll([automation({ enabled: false })]);
    expect(chromeMock._alarms.size).toBe(0);
  });

  it('clears an alarm whose automation was deleted', async () => {
    const a = await load();
    await a.rescheduleAll([automation()]);
    await a.rescheduleAll([]);
    expect(chromeMock._alarms.size).toBe(0);
  });

  it('reports an invalid schedule instead of arming a broken alarm', async () => {
    const a = await load();
    const results = await a.rescheduleAll([automation({ schedule: { kind: 'daily', hour: 99, minute: 0 } })]);
    expect(results[0].ok).toBe(false);
    expect(results[0].reason).toMatch(/invalid schedule/);
    expect(chromeMock._alarms.size).toBe(0);
  });

  it('reports a schedule that will not fire again', async () => {
    const a = await load();
    const results = await a.rescheduleAll([automation({ schedule: { kind: 'once', at: Date.now() - 10_000 } })]);
    expect(results[0].ok).toBe(false);
    expect(results[0].reason).toMatch(/will not fire again/);
  });

  it('never arms an alarm in the immediate past', async () => {
    const a = await load();
    // a 'once' a few ms ahead must still be pushed at least a second out, or Chrome may drop it
    await a.rescheduleAll([automation({ schedule: { kind: 'once', at: Date.now() + 50 } })]);
    const alarm = [...chromeMock._alarms.values()][0];
    expect(alarm.scheduledTime).toBeGreaterThan(Date.now());
  });

  it('describes the schedule in words', async () => {
    const a = await load();
    const results = await a.rescheduleAll([automation()]);
    expect(results[0].description).toBe('Every 1 minute');
  });

  it('scheduleOne replaces a previous alarm rather than leaving two', async () => {
    const a = await load();
    await a.scheduleOne(automation());
    await a.scheduleOne(automation());
    expect(chromeMock._alarms.size).toBe(1);
  });

  it('cancelOne removes the alarm', async () => {
    const a = await load();
    await a.scheduleOne(automation());
    expect(await a.cancelOne('a1')).toBe(true);
    expect(chromeMock._alarms.size).toBe(0);
  });

  it('cancelAll removes only our alarms', async () => {
    const a = await load();
    await a.scheduleOne(automation());
    await chromeMock.alarms.create('someone-elses-alarm', { when: Date.now() + 60_000 });
    const cleared = await a.cancelAll();
    expect(cleared).toBe(1);
    expect(chromeMock._alarms.size).toBe(1);
    expect([...chromeMock._alarms.keys()][0]).toBe('someone-elses-alarm');
  });

  it('maps an alarm name back to an automation id', async () => {
    const a = await load();
    expect(a.automationIdFromAlarm('autoflow:run:xyz')).toBe('xyz');
    expect(a.automationIdFromAlarm('something-else')).toBeNull();
    expect(a.automationIdFromAlarm(null)).toBeNull();
  });

  it('listScheduled reports next time and words for each automation', async () => {
    const a = await load();
    const list = [automation(), automation({ id: 'a2', name: 'Manual', schedule: { kind: 'manual' } })];
    await a.rescheduleAll(list);
    const items = await a.listScheduled(list);
    const first = items.find((i) => i.id === 'a1');
    expect(first.armed).toBe(true);
    expect(first.nextAt).toBeGreaterThan(Date.now());
    expect(first.schedule).toBe('Every 1 minute');
    const second = items.find((i) => i.id === 'a2');
    expect(second.armed).toBe(false);
    // a manual schedule is described in words for the user, not as the raw kind
    expect(second.schedule).toMatch(/press Start/i);
  });

  it('listScheduled surfaces a schedule error rather than throwing', async () => {
    const a = await load();
    const items = await a.listScheduled([
      automation({ schedule: { kind: 'weekly', days: [], hour: 1, minute: 0 } }),
      automation({ id: 'fine', name: 'Fine', schedule: { kind: 'daily', hour: 9, minute: 0 } }),
    ]);
    const broken = items.find((i) => i.id === 'a1');
    expect(broken.error).toMatch(/at least one day/);
    // one broken schedule must not stop the others being reported
    const fine = items.find((i) => i.id === 'fine');
    expect(fine.error).toBeNull();
    expect(fine.nextAt).toBeGreaterThan(Date.now());
  });
});
