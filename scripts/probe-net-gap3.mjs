#!/usr/bin/env node
/** Which gate lets `describeEvent` through? Print the answer instead of guessing a fourth time. */
import { readFileSync } from 'node:fs';

const raw = readFileSync('/root/autoflow/src/ui/panel/panel.js', 'utf8');
// simulate the fault
const code = raw.replace(', describeEvent, filledPoints', '');

const NAME = 'describeEvent';
console.log('the import line now:', code.split('\n').find((l) => l.includes('events-view.js'))?.trim());
console.log('is the name still in the file at all?', code.includes(NAME));
console.log();
console.log('occurrences:');
code.split('\n').forEach((l, i) => { if (l.includes(NAME)) console.log(`  ${i + 1}: ${l.trim().slice(0, 110)}`); });
console.log();

// does the template-literal stripper keep the interpolation?
const KEEP = /\$\{/;
const line = code.split('\n').find((l) => l.includes(NAME));
console.log('that line, as the stripper would see it:');
// run the actual stripper from the checker by importing its logic inline
console.log();

// manual replication of the stripper's template branch on this line
const startsInterpolation = (s, at) => {
  let b = 0;
  for (let k = at - 1; k >= 0 && s[k] === '\\'; k -= 1) b += 1;
  return b % 2 === 0;
};
function strip(codeAll) {
  let out = '', i = 0; const n = codeAll.length;
  const skipString = (at, q) => { let k = at + 1; while (k < n) { if (codeAll[k] === '\\') { k += 2; continue; } if (codeAll[k] === q) return k + 1; k += 1; } return n; };
  while (i < n) {
    const c = codeAll[i];
    if (c === '/' && codeAll[i + 1] === '*') { const e = codeAll.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; out += ' '; continue; }
    if (c === '/' && codeAll[i + 1] === '/') { const e = codeAll.indexOf('\n', i); i = e === -1 ? n : e; continue; }
    if (c === "'" || c === '"') { i = skipString(i, c); out += "''"; continue; }
    if (c === '`') {
      let k = i + 1, kept = '';
      while (k < n) {
        if (codeAll[k] === '\\') { k += 2; continue; }
        if (codeAll[k] === '`') { k += 1; break; }
        if (codeAll[k] === '$' && codeAll[k + 1] === '{' && startsInterpolation(codeAll, k + 1)) {
          let depth = 1, d = k + 2; const from = d;
          while (d < n && depth > 0) {
            const ch = codeAll[d];
            if (ch === '\\') { d += 2; continue; }
            if (ch === "'" || ch === '"') { d = skipString(d, ch); continue; }
            if (ch === '{') depth += 1; else if (ch === '}') depth -= 1;
            d += 1;
          }
          kept += ' ' + codeAll.slice(from, d - 1) + ' ';
          k = d; continue;
        }
        k += 1;
      }
      i = k; out += kept; continue;
    }
    out += c; i += 1;
  }
  return out;
}
const stripped = strip(code);
const calls = new Set();
for (const m of stripped.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(m[1]);
for (const m of stripped.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\.\s*[A-Za-z_$]/g)) calls.add(m[1]);
console.log(`is "${NAME}" seen as a call after stripping?`, calls.has(NAME));
console.log('nearby calls the stripper did see:', [...calls].filter((x) => /etter|oint|vent|schedule|Event/i.test(x)).slice(0, 12));
