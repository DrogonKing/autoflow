#!/usr/bin/env node
/**
 * Why does the net report `set` in panel.js when the only occurrence is inside a COMMENT?
 *
 * The stripper removes block comments, so a match inside one means the stripper stopped stripping. The usual cause is a
 * `*/` that appears INSIDE a block comment - it closes the comment early and everything after it in that comment becomes
 * "code" to the scanner. This finds it by printing the stripped text around the offending match.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync('/root/autoflow/scripts/check-imports.mjs', 'utf8');
const start = src.indexOf('function stripLiterals');
const end = src.indexOf('function declaredIn');
/**
 * `new Function` was the wrong tool: the sliced text contains a template literal of its own, and interpolating it into
 * another template broke the parse. Writing the slice to a module and importing it keeps the text intact.
 */
import { writeFileSync } from 'node:fs';
writeFileSync('/tmp/_strip.mjs', `${src.slice(start, end)}\nexport { stripLiterals };`);
const { stripLiterals: fn } = await import('/tmp/_strip.mjs');

const raw = readFileSync('/root/autoflow/src/ui/panel/panel.js', 'utf8');
const out = fn(raw);

console.log('=== is the comment text still present after stripping? ===');
const probe = 'state.pickTarget` was set';
console.log('  raw contains it      :', raw.includes(probe));
console.log('  STRIPPED contains it :', out.includes(probe), out.includes(probe) ? '  <-- the stripper did not remove it' : '');

const at = out.indexOf('was set');
if (at >= 0) {
  console.log('\n=== stripped text around it ===');
  console.log(JSON.stringify(out.slice(Math.max(0, at - 260), at + 80)));
}

console.log('\n=== and the source of the early close: a `*/` inside a block comment ===');
const lines = raw.split('\n');
let inBlock = false;
lines.forEach((line, i) => {
  const opens = (line.match(/\/\*/g) ?? []).length;
  const closes = (line.match(/\*\//g) ?? []).length;
  if (!inBlock && opens > closes) {
    inBlock = true;
    // a line that opens a comment and ALSO contains a close is fine; the suspicious case is a `*/` far from the start
    if (/\*\/.+/.test(line.replace(/^\s*\/\*.*?\*\//, ''))) {
      console.log(`  line ${i + 1} opens a comment and has trailing text after a close: ${JSON.stringify(line.slice(0, 120))}`);
    }
  } else if (inBlock && closes > 0) {
    inBlock = false;
  }
});
const inner = lines.map((l, i) => ({ i: i + 1, l })).filter(({ l }) => /^\s*\*.*\*\/\s*\S/.test(l));
console.log('  lines with a `*/` inside a JSDoc comment:', inner.length);
for (const { i, l } of inner.slice(0, 6)) console.log(`    ${i}: ${JSON.stringify(l.slice(0, 130))}`);