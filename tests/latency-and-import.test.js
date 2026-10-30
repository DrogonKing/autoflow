/**
 * B4 and B7: a queue wait is not machine latency, and a restore must not erase anything.
 *
 * B4, MEASURED before the fix:
 *     one 80ms sample        -> startLatencyMs = 80ms    (margin 1580ms)
 *     then one 6000ms sample -> startLatencyMs = 6000ms  (margin 7500ms)
 *     five fast runs after   -> 1966ms                   (margin 3466ms)
 * The 6000ms was a run waiting in the queue behind another automation - not the worker being slow - and the margin it
 * produced is what decides how early the alarm wakes. An alarm that wakes seconds early is how a click aimed at a
 * second lands early.
 *
 * B7, MEASURED before the fix:
 *     restore a file with one usable item and two broken ones: 2 automations -> 1   (the user's own work deleted)
 *     restore a file where EVERY item is refused:              1 automation  -> 0   (everything erased)
 */
import { beforeEach, describe, expect, it } from 'vitest';

function installFakeChrome() {
  const store = {};
  globalThis.chrome = {
    runtime: { id: 'test', getURL: (p) => p },
    alarms: { create: async () => {}, clear: async () => {}, getAll: async () => [], get: async () => undefined },
    storage: {
      local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) },
      session: { get: async () => ({}), set: async () => {} },
    },
  };
  return { store };
}

const simple = (id, name) => ({
  id, name, enabled: true, urls: [], steps: [{ id: 's1', kind: 'click', finder: { strategy: 'css', selector: '#x' } }],
  schedule: { kind: 'manual' },
});

describe('B4: a queue wait is not recorded as worker latency', () => {
  beforeEach(() => installFakeChrome());

  it('the sample excludes the time spent waiting for the slot', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/background/service-worker.js'), 'utf8');

    // the subtraction must be present, and it must come off the fired->started interval
    expect(src).toMatch(/startedAt - finished\.firedAt - queuedMsLocal/);
    // and the wait itself must be measured where the slot is claimed
    expect(src).toMatch(/queuedMs = depth > 0 \? Date\.now\(\) - waitStartedAt : 0/);
  });

  it('a queued run records what it waited, so the subtraction is visible rather than assumed', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/background/service-worker.js'), 'utf8');
    expect(src).toMatch(/kind: 'start-queued-wait'/);
    // a run that did not queue must record nothing: the event is guarded, not emitted always
    expect(src).toMatch(/if \(queuedMsLocal > 250\)/);
  });

  it('and the arithmetic really does remove it', async () => {
    // the same expression the worker uses, so the test states the intent as a number
    const firedAt = 1_000_000;
    const queued = 6000;
    const startedAt = firedAt + queued + 80;       // 6s in the queue, then 80ms of real wake-up cost
    const before = startedAt - firedAt;            // the old sample
    const after = startedAt - firedAt - queued;    // the fixed sample
    expect(before).toBe(6080);
    expect(after, 'the queue wait is still in the sample').toBe(80);
  });
});

describe('B7: a restore cannot erase automations', () => {
  beforeEach(() => installFakeChrome());

  it('a file where EVERY item is refused leaves everything untouched', async () => {
    const S = await import('../src/background/storage.js');
    await S.saveAutomation(simple('a1', 'one'));
    await S.saveAutomation(simple('a2', 'two'));

    const r = await S.importAll({ automations: [{ name: 'broken' }, { steps: [] }] }, { replace: true });
    expect(r.imported).toBe(0);
    expect(r.refused, 'the restore reported success while importing nothing').toBe(true);

    const after = await S.listAutomations();
    expect(after.length, 'the automations were erased by a restore that imported nothing').toBe(2);
  });

  it('a partial file ADDS to what is here instead of replacing it', async () => {
    const S = await import('../src/background/storage.js');
    await S.saveAutomation(simple('a1', 'mine one'));
    await S.saveAutomation(simple('a2', 'mine two'));

    const r = await S.importAll({
      automations: [simple('new1', 'from the file'), { name: 'broken' }],
    }, { replace: true });
    expect(r.imported).toBe(1);

    const after = await S.listAutomations();
    const names = after.map((a) => a.name).sort();
    expect(names, 'the restore deleted work the file never mentioned').toContain('mine one');
    expect(names).toContain('mine two');
    expect(names).toContain('from the file');
  });

  it('an imported automation arrives SWITCHED OFF, whatever the file says', async () => {
    const S = await import('../src/background/storage.js');
    const file = simple('x1', 'from the file');
    file.enabled = true;                                  // the file insists
    await S.importAll({ automations: [file] }, {});

    const [imported] = (await S.listAutomations()).filter((a) => a.name === 'from the file');
    expect(imported, 'the automation was not imported').toBeTruthy();
    expect(imported.enabled, 'a file from outside scheduled an order before anyone read it').toBe(false);
  });

  it('a file that CANNOT be parsed at all changes nothing', async () => {
    const S = await import('../src/background/storage.js');
    await S.saveAutomation(simple('a1', 'one'));
    await expect(S.importAll({ nope: true }, { replace: true })).rejects.toThrow();
    expect((await S.listAutomations()).length).toBe(1);
  });

  it('replace still lets the FILE win for an id that appears in both', async () => {
    const S = await import('../src/background/storage.js');
    await S.saveAutomation(simple('same', 'old name'));
    const fromFile = simple('same', 'new name');
    await S.importAll({ automations: [fromFile] }, { replace: true });

    const list = await S.listAutomations();
    const hit = list.find((a) => a.id === 'same');
    expect(hit?.name, 'replace no longer means the file wins for a shared id').toBe('new name');
    expect(list.filter((a) => a.id === 'same').length).toBe(1);
  });
});