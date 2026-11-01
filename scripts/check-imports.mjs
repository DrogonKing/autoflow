#!/usr/bin/env node
/**
 * A NAME THAT IS USED MUST BE IMPORTED OR DECLARED.
 *
 * WHY THIS IS A SCRIPT AND NOT A VITEST TEST ANY MORE. The vitest version of this check found real faults and then let
 * them through, twice:
 *
 *   1. it asserted only on three historical names (`recordStartLatency|ALARM_PREFIX|listScheduled`) and merely PRINTED
 *      everything else - so `orderByNextRun` and `describeEvent` were each detected, logged, and passed;
 *   2. its `declaredIn()` treated every word inside every string literal as declared, so a name that appeared in any UI
 *      text was invisible - which is what hid `orderByNextRun`.
 *
 * Both were fixed, and then it still missed `describeEvent`. Rather than keep guessing at a regex inside a test harness,
 * the check now lives here where its behaviour is direct: it runs against src/ and exits non-zero with a list.
 *
 * WHAT IT LOOKS FOR, precisely:
 *   - a name used in CALL position (`name(` or `name.member`), not preceded by `.` or `?.`
 *   - that is not an ambient global, not declared in the file (import, const, function, class, parameter, loop binding)
 *   - and that IS exported somewhere in src/ - which is the signature of "exists, but was not imported HERE" as opposed
 *     to a typo or a method name
 *
 * The third condition is what makes this a check and not a heuristic.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
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

/** Names that exist without an import. Kept explicit so the list is reviewable. */
const AMBIENT = new Set([
  'console', 'process', 'require', 'globalThis', 'window', 'document', 'navigator', 'location', 'chrome', 'browser',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'requestAnimationFrame',
  'cancelAnimationFrame', 'structuredClone', 'fetch', 'alert', 'confirm', 'prompt', 'atob', 'btoa',
  'URL', 'URLSearchParams', 'Date', 'JSON', 'Math', 'Number', 'String', 'Boolean', 'BigInt', 'Array', 'Object',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'RegExp', 'Symbol', 'Proxy', 'Reflect', 'Intl', 'Infinity', 'NaN', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'getComputedStyle', 'matchMedia', 'CustomEvent',
  'Event', 'Blob', 'File', 'FileReader', 'FormData', 'AbortController', 'TextEncoder', 'TextDecoder',
  'performance', 'localStorage', 'sessionStorage', 'indexedDB', 'crypto', 'Image', 'Audio', 'Worker',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'requestIdleCallback', 'reportError',
  'DOMParser', 'XMLSerializer', 'Headers', 'Request', 'Response', 'Notification', 'ClipboardItem',
]);

/**
 * Remove comments and string content, but KEEP `${...}` inside template literals.
 *
 * MEASURED, and this is the third gap found in this check: replacing a whole template literal with `` makes any name
 * called only inside an interpolation invisible. `describeEvent` is used exactly like that -
 *
 *     `${describeEvent(e.schedule)} \u00b7 ${filledPoints(e)}`
 *
 * - so the call scan never saw it, while `orderByNextRun`, called bare on its own line, was found. One caught, one not,
 * and the difference had nothing to do with the missing import.
 *
 * So the substitution is done in pieces: `\`${` opens an interpolation whose contents are kept until the matching `}`,
 * and only the literal text between interpolations is blanked.
 */
function stripLiterals(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  const startsInterpolation = (at) => {
    // depth 0 only: a `${` inside an interpolation is handled by the same loop
    let backslashes = 0;
    for (let k = at - 1; k >= 0 && code[k] === '\\'; k -= 1) backslashes += 1;
    return backslashes % 2 === 0;
  };
  const skipString = (at, quote) => {
    let k = at + 1;
    while (k < n) {
      if (code[k] === '\\') { k += 2; continue; }
      if (code[k] === quote) return k + 1;
      k += 1;
    }
    return n;
  };
  while (i < n) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === '\'' || c === '"') {
      i = skipString(i, c);
      out += "''";
      continue;
    }
    if (c === '`') {
      // walk the template, keeping interpolations and blanking the text
      let k = i + 1;
      let kept = '';
      while (k < n) {
        if (code[k] === '\\') { k += 2; continue; }
        if (code[k] === '`') { k += 1; break; }
        if (code[k] === '$' && code[k + 1] === '{' && startsInterpolation(k + 1)) {
          // find the matching brace, accounting for nesting and strings inside
          let depth = 1;
          let d = k + 2;
          const from = d;
          while (d < n && depth > 0) {
            const ch = code[d];
            if (ch === '\\') { d += 2; continue; }
            if (ch === '\'' || ch === '"') { d = skipString(d, ch); continue; }
            if (ch === '`') { d += 1; while (d < n && code[d] !== '`') { if (code[d] === '\\') d += 1; d += 1; } d += 1; continue; }
            if (ch === '{') depth += 1;
            else if (ch === '}') depth -= 1;
            d += 1;
          }
          kept += ' ' + code.slice(from, d - 1) + ' ';
          k = d;
          continue;
        }
        k += 1;
      }
      i = k;
      out += kept;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const FILE_BODIES = new Map();
for (const f of walk(SRC)) FILE_BODIES.set(f, readFileSync(f, 'utf8'));

/** Names the file brings into scope itself, or refers to through an import. */
function declaredIn(code) {
  const names = new Set();

  // import { a, b as c } / import d / import * as e
  for (const m of code.matchAll(/import\s*\{([\s\S]*?)\}\s*from/g)) {
    for (const part of m[1].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').split(',')) {
      const t = part.trim();
      if (t) names.add(t.split(/\s+as\s+/).pop().trim());
    }
  }
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) names.add(m[1]);
  for (const m of code.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);

  // declarations
  for (const m of code.matchAll(/(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w$.])(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(':').pop().trim().split(/[=.]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  for (const m of code.matchAll(/(?:^|[^\w$.])(?:const|let|var)\s*\[([^\]]*)\]/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/[=.]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  // function / class declarations, exported or not
  for (const m of code.matchAll(/(?:^|[^\w$.])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w$.])class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);

  // parameters of arrows and functions, coarsely
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().replace(/[{}[\]]/g, ' ').split(/[:=]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  for (const m of code.matchAll(/function\s*\*?\s*[A-Za-z_$]*\s*\(([^()]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().replace(/[{}[\]]/g, ' ').split(/[:=]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  // loop and catch bindings
  for (const m of code.matchAll(/(?:for|catch)\s*\(?\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  /**
   * Object keys, and the ONE thing this rule must not swallow.
   *
   * `{ foo(` looks like a shorthand method or a key, so those names are collected. But a template interpolation is
   * `$` followed by `{`, and inside it a call is written `${describeEvent(x)}` - which matches this rule exactly. That
   * is why `describeEvent` was invisible while `orderByNextRun`, called bare, was found.
   *
   * The lookbehind rejects a `{` whose preceding character is `$`.
   */
  for (const m of code.matchAll(/(?<!\$)(?:^|[{,,\n])\s*([A-Za-z_$][\w$]*)\s*[:(]/g)) names.add(m[1]);
  // a name re-exported by this module is in scope if it was imported; and `export { a as b }` brings `b` into the export
  // surface, not the scope - so only the source side counts here.
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const src2 = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(src2)) names.add(src2);
    }
  }
  // NOTE: no rule for words inside string literals. That rule existed to silence UI text, and it made a real missing
  // import invisible whenever the identifier also appeared in any string in the same file.

  return names;
}

// ---- every name exported anywhere in src/
const EXPORTED = new Set();
for (const code of FILE_BODIES.values()) {
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) EXPORTED.add(m[1]);
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) EXPORTED.add(m[1]);
  for (const m of code.matchAll(/export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g)) EXPORTED.add(m[1]);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) EXPORTED.add(t);
    }
  }
}

const offenders = [];
for (const [file, raw] of FILE_BODIES) {
  const known = declaredIn(raw);
  // strip comments and every literal form, so their contents cannot look like a call
  const stripped = stripLiterals(raw);
  const called = new Set();
  for (const m of stripped.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);
  for (const m of stripped.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\.\s*[A-Za-z_$]/g)) called.add(m[1]);

  for (const name of called) {
    if (AMBIENT.has(name)) continue;
    if (known.has(name)) continue;
    if (name.length <= 2) continue;
    if (/^(constructor|prototype|call|apply|bind|hasOwnProperty|toString|valueOf)$/.test(name)) continue;
    if (!EXPORTED.has(name)) continue;
    offenders.push(`${file.slice(ROOT.length + 1)}: ${name}`);
  }
}

if (offenders.length) {
  console.error(`unresolved name(s) - used here but neither imported nor declared:\n`);
  for (const o of offenders) console.error(`  ${o}`);
  console.error(`\n${offenders.length} finding(s)`);
  process.exit(1);
}
console.log(`import check: clean (${FILE_BODIES.size} files, ${EXPORTED.size} exported names)`);
process.exit(0);
