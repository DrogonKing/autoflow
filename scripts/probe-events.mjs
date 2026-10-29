#!/usr/bin/env node
/**
 * Why are events missing? Ask the extension directly, one step at a time.
 *
 * Three hypotheses were tested by reading code and all three were wrong. This records a known number of events and
 * reports exactly how many came back, so the answer comes from the extension rather than from reasoning.
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const DIST = '/root/autoflow/dist';
const CHROME = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(os.tmpdir(), 'af-probe-')), {
  headless: true, executablePath: CHROME,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-sandbox',
    '--disable-dev-shm-usage', '--disable-features=DisableLoadExtensionCommandLineSwitch'],
});

let w = null;
for (let i = 0; i < 60 && !w; i++) {
  for (const x of ctx.serviceWorkers()) {
    try { if (/autoflow/i.test(await x.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { w = x; break; } } catch {}
  }
  if (!w) await new Promise((r) => setTimeout(r, 300));
}
if (!w) { console.error('no worker'); await ctx.close(); process.exit(1); }
w.on('console', (m) => { const t = m.text(); if (/error|Error|warn/i.test(t)) console.log(`  [worker] ${t.slice(0, 200)}`); });

const b = await ctx.newPage();
await b.goto(`chrome-extension://${new URL(w.url()).host}/options.html`);

const out = await b.evaluate(async () => {
  const send = (m) => chrome.runtime.sendMessage(m);
  const report = [];

  // 0. is the probe handler even reachable?
  const probeAck = await send({ type: 'record-test-event', n: 99 });
  report.push({ step: 'probe ack', got: probeAck });

  // 1. one event, then export
  await send({ type: 'clear-diagnostics' });
  await send({ type: 'record-test-event', n: 1 });
  let d = await send({ type: 'export-diagnostics', pageLogs: [] });
  report.push({ step: 'one event', count: d?.doc?.events?.length ?? -1, kinds: (d?.doc?.events ?? []).map((e) => e.kind) });

  // 2. five in one tick
  await send({ type: 'clear-diagnostics' });
  await Promise.all([1, 2, 3, 4, 5].map((n) => send({ type: 'record-test-event', n })));
  d = await send({ type: 'export-diagnostics', pageLogs: [] });
  report.push({ step: 'five in a tick', count: d?.doc?.events?.length ?? -1, ns: (d?.doc?.events ?? []).map((e) => e.n) });

  // 3. two starts in one tick, then look at the raw array in order
  await send({ type: 'clear-diagnostics' });
  await send({ type: 'save-automation', automation: {
    id: 'p1', name: 'p1', enabled: false, urls: [],
    steps: [{ id: 'w', kind: 'wait', ms: 1200 }],
    schedule: { kind: 'manual' }, options: { stepDelayMs: 0 },
  } });
  await Promise.all([
    send({ type: 'start-run', automationId: 'p1', tabId: null }).catch(() => ({ ok: false })),
    send({ type: 'start-run', automationId: 'p1', tabId: null }).catch(() => ({ ok: false })),
  ]);
  d = await send({ type: 'export-diagnostics', pageLogs: [] });
  report.push({
    step: 'two starts, same tick',
    count: d?.doc?.events?.length ?? -1,
    raw: (d?.doc?.events ?? []).map((e) => `${e.at} ${e.kind}${e.n ? ':' + e.n : ''}`),
  });
  return report;
});

for (const r of out) {
  console.log(`\n${r.step}`);
  if (r.count !== undefined) console.log(`  count: ${r.count}`);
  if (r.kinds) console.log(`  kinds: ${JSON.stringify(r.kinds)}`);
  if (r.ns) console.log(`  ns   : ${JSON.stringify(r.ns)}`);
  if (r.raw) for (const l of r.raw) console.log(`    ${l}`);
  if (r.got !== undefined) console.log(`  ack  : ${JSON.stringify(r.got)}`);
}

await ctx.close();