#!/usr/bin/env node
/**
 * Why is `describeEvent` still invisible to the net, when `orderByNextRun` is not?
 *
 * Guessing has been wrong twice here, so this walks the actual gates the test applies and prints the first one that
 * lets the name through.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/root/autoflow';
const SRC = join(ROOT, 'src');
function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
const FILES = walk(SRC);

// ---- the test's EXPORTED collector
const EXPORTED = new Set();
for (const f of FILES) {
  const c = readFileSync(f, 'utf8');
  for (const m of c.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) EXPORTED.add(m[1]);
  for (const m of c.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) EXPORTED.add(m[1]);
}
console.log('EXPORTED size:', EXPORTED.size);
for (const name of ['orderByNextRun', 'describeEvent', 'filledPoints']) {
  console.log(`  ${name.padEnd(16)} in EXPORTED: ${EXPORTED.has(name)}`);
}
console.log();
console.log('--- how are these declared in events-view.js? ---');
const ev = readFileSync(join(SRC, 'ui/panel/events-view.js'), 'utf8');
ev.split('\n').forEach((l, i) => {
  if (/export/.test(l)) console.log(`  ${i + 1}: ${l.trim().slice(0, 110)}`);
});
console.log();
console.log('--- the test only collects `export function` and `export const|let|var` ---');
console.log('    a bare `export { ... }` re-export is NOT collected, so such a name is never even a candidate.');