#!/usr/bin/env node
/**
 * WHAT DOES THE STRING RULE COST AND WHAT DOES IT HIDE?
 *
 * `declaredIn()` adds every word found inside a string literal to the "already declared" set, to avoid reporting UI
 * text. The side effect is that a genuine missing import becomes invisible whenever the same identifier also appears in
 * any string in the same file - and `orderByNextRun` was exactly that: the net stayed green with its import removed,
 * which is the one failure a net cannot have.
 *
 * So: measure both directions. How many false positives does dropping the rule introduce, and does it then catch the
 * faults that shipped?
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

function declaredIn(code, { strings }) {
  const names = new Set();
  for (const m of code.matchAll(/import\s*\{([\s\S]*?)\}\s*from/g)) {
    for (const part of m[1].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').split(',')) {
      const t = part.trim();
      if (t) names.add(t.split(/\s+as\s+/).pop().trim());
    }
  }
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1]);
  for (const m of code.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(':').pop().trim().split(/[=.]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  for (const m of code.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
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
  for (const m of code.matchAll(/(?:for|catch)\s*\(?\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/(?:^|[{,,\s])([A-Za-z_$][\w$]*)\s*:/g)) names.add(m[1]);
  for (const m of code.matchAll(/\.\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  if (strings) for (const m of code.matchAll(/'([^']*)'|"([^"]*)"/g)) {
    for (const w of (m[1] ?? m[2] ?? '').split(/\W+/)) if (w) names.add(w);
  }
  return names;
}

const EXPORTED = new Set();
for (const f of FILES) {
  const c = readFileSync(f, 'utf8');
  for (const m of c.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) EXPORTED.add(m[1]);
  for (const m of c.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) EXPORTED.add(t);
    }
  }
}

const AMBIENT = new Set(['console', 'process', 'require', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'fetch', 'URL', 'Date', 'JSON', 'Math', 'Number', 'String', 'Boolean', 'Array', 'Object',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'RegExp', 'Symbol', 'Infinity', 'NaN', 'parseInt',
  'parseFloat', 'isNaN', 'isFinite', 'structuredClone', 'queueMicrotask', 'requestAnimationFrame',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'getComputedStyle', 'matchMedia', 'alert',
  'btoa', 'atob', 'encodeURIComponent', 'decodeURIComponent', 'CustomEvent', 'Event', 'Blob', 'File',
  'FormData', 'AbortController', 'TextEncoder', 'TextDecoder', 'performance', 'localStorage', 'indexedDB']);

function offenders(useStrings) {
  const out = [];
  for (const file of FILES) {
    const raw = readFileSync(file, 'utf8');
    const known = declaredIn(raw, { strings: useStrings });
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
      .replace(/'(?:\\[\s\S]|[^\\'])*'/g, "''")
      .replace(/"(?:\\[\s\S]|[^\\"])*"/g, '""');
    const called = new Set();
    for (const m of stripped.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);
    for (const m of stripped.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\.\s*[A-Za-z_$]/g)) called.add(m[1]);
    for (const name of called) {
      if (AMBIENT.has(name)) continue;
      if (known.has(name)) continue;
      if (name.length <= 2) continue;
      if (/^(constructor|prototype|call|apply|bind)$/.test(name)) continue;
      if (!EXPORTED.has(name)) continue;
      if (name === 'noop') continue;
      out.push(`${file.slice(ROOT.length + 1)}: ${name}`);
    }
  }
  return out;
}

const withStrings = offenders(true);
const withoutStrings = offenders(false);

console.log(`offenders WITH the string rule    : ${withStrings.length}`);
console.log(`offenders WITHOUT the string rule : ${withoutStrings.length}`);
console.log();
console.log('--- what the string rule was hiding ---');
const hidden = withoutStrings.filter((o) => !withStrings.includes(o));
for (const h of hidden) console.log('  ', h);
console.log();
console.log('--- and the full list without it, to judge the false-positive cost ---');
for (const o of withoutStrings) console.log('  ', o);
