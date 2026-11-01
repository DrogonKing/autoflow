/**
 * EVERY NAME USED FROM A MODULE MUST BE IMPORTED FROM IT.
 *
 * This class of bug has now happened FOUR times in this repo, and every instance reached a release:
 *
 *   `listScheduled`     - `list-scheduled` answered `{ok:false,error:"listScheduled is not defined"}`, so the panel
 *                         could not show which automations were armed. Shipped in 1.18.0 and later.
 *   `recordStartLatency`- called by every scheduled run as it finished. The run completed and THEN threw, which is why
 *                         the next-day re-arm could be missing.
 *   `ALARM_PREFIX`      - used by `cancel-alarms` and `diagnostics`: both handlers crashed.
 *   `${missing}` in a template - a different flavour of the same thing: a name that does not resolve.
 *
 * The common cause is structural: a name is added to a file, the import list is not touched, and no test calls the
 * message or path that would notice. Reading the diff does not catch it, because the diff is where the name was added -
 * the missing import is an ABSENCE.
 *
 * So this checks the imports themselves, across every module in the extension, by parsing each import statement and
 * then looking for uses of names that were never brought in. It is deliberately a static check: a ReferenceError is a
 * static fact, and a runtime check would only cover the paths a test happens to walk.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Names a browser/JS environment provides, plus every name a module is allowed to use without declaring it here.
 * Kept explicit rather than clever: an accidental wildcard would defeat the check.
 */
const AMBIENT = new Set([
  'chrome', 'browser', 'window', 'document', 'globalThis', 'self', 'console', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'requestAnimationFrame', 'structuredClone', 'fetch',
  'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'FormData', 'Headers', 'Request', 'Response',
  'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'MutationObserver',
  'IntersectionObserver', 'ResizeObserver', 'DOMParser', 'XMLSerializer', 'Image', 'Audio', 'Notification',
  'Promise', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol',
  'Proxy', 'Reflect', 'BigInt', 'Intl', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape', 'eval', 'Function', 'arguments',
  'undefined', 'NaN', 'Infinity', 'this', 'async', 'await', 'yield', 'typeof', 'instanceof', 'in', 'of',
  'new', 'delete', 'void', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'try', 'catch', 'finally', 'throw', 'class', 'extends', 'super', 'import', 'export', 'from', 'default',
  'const', 'let', 'var', 'function', 'get', 'set', 'static', 'true', 'false', 'null', 'as',
]);

/** Every identifier that appears anywhere in a string of code, with comments and strings removed. */
function identifiers(code) {
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^\\'])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^\\"])*"/g, '""');
  return new Set([...stripped.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
}

/** Everything a module declares or imports locally. */
function declaredIn(code) {
  const names = new Set();
  for (const m of code.matchAll(/import\s*\{([\s\S]*?)\}\s*from/g)) {
    for (const part of m[1].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').split(',')) {
      const t = part.trim();
      if (!t) continue;
      names.add(t.split(/\s+as\s+/).pop().trim());
    }
  }
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1]);
  for (const m of code.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // declarations of any kind, including destructuring targets and function parameters
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(':').pop().trim().split(/[=.]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  // `export` must be allowed: a name DECLARED and exported in its own module (alarms.js's `recordStartLatency`) was
  // reported as unresolved here, which is a false positive in the net rather than a finding
  for (const m of code.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // parameters, coarsely: any identifier inside a parameter list
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
  // loop and catch bindings
  for (const m of code.matchAll(/(?:for|catch)\s*\(?\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // object literal keys are not identifiers in scope, but they appear as such; collect them so they are not reported
  for (const m of code.matchAll(/(?:^|[{,,\s])([A-Za-z_$][\w$]*)\s*:/g)) names.add(m[1]);
  /**
   * THE STRING RULE USED TO LIVE HERE, AND IT HID THE BUG THIS NET EXISTS FOR.
   *
   * It added every word found inside a string literal to the "already declared" set, so that UI text like `'Add a
   * point'` would not be reported as a call. The side effect: `orderByNextRun` appeared in no string at all, and the
   * net still stayed GREEN with its import removed - because the rule made any identifier invisible the moment it
   * occurred in any string anywhere in the same file.
   *
   * MEASURED, with that fault deliberately reintroduced:
   *     with the rule      0 offenders   (silent)
   *     without the rule   1 offender    (src/ui/panel/panel.js: orderByNextRun)
   * and the cost of removing it is zero false positives across all 27 files.
   *
   * A net that misses the fault it was written for is worse than no net, because it is trusted.
   */
  // member accesses are not bare identifiers
  for (const m of code.matchAll(/\.\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

const FILES = walk(SRC);

/**
 * Every name EXPORTED anywhere in src/, and every name each file defines itself.
 *
 * Together these turn the check into: "a name that exists in this codebase, is called from this file, and is neither
 * imported nor defined here" - which is precisely a missing import, and cannot be satisfied by reformatting.
 */
const EXPORTED = new Set();
const DEFINED_HERE = new Map();
for (const file of FILES) {
  const code = readFileSync(file, 'utf8');
  const defined = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) {
    EXPORTED.add(m[1]); defined.add(m[1]);
  }
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    EXPORTED.add(m[1]); defined.add(m[1]);
  }
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/).pop().trim();
      if (t) { EXPORTED.add(t); defined.add(t); }
    }
  }
  for (const m of code.matchAll(/(?:^|\n)\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of code.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of code.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  DEFINED_HERE.set(file, defined);
}

describe('module imports resolve', () => {
  it('every module in src/ was found', () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  /**
   * The two names that actually shipped broken. Asserted by name so a regression to them is unmistakable even if the
   * generic check is ever loosened.
   */
  it('the worker imports the two names it uses from alarms.js', () => {
    const worker = readFileSync(join(SRC, 'background/service-worker.js'), 'utf8');
    const block = /import\s*\{([\s\S]*?)\}\s*from\s*'\.\/alarms\.js'/.exec(worker)?.[1] ?? '';
    const clean = block.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    expect(clean, 'recordStartLatency is called by every scheduled run').toMatch(/\brecordStartLatency\b/);
    expect(clean, 'ALARM_PREFIX is used by cancel-alarms and diagnostics').toMatch(/\bALARM_PREFIX\b/);
  });

  /**
   * The generic form: for each file, every module-scope name it uses must come from the file, an import, or a local
   * declaration. Reported as a list so a failure names the file and the identifier rather than a line number.
   */
  /**
   * THE GENERIC FORM DELEGATES TO scripts/check-imports.mjs.
   *
   * It used to be a second implementation, and the two DISAGREED: the copy here treated every word inside a string
   * literal as declared, replaced whole template literals (so a name called only inside `${...}` was invisible), and
   * asserted on three hard-coded names while merely printing anything else. Between those three rules, two real
   * ReferenceErrors - `orderByNextRun` and then `describeEvent` - were detected, logged, and allowed through, and each
   * blanked the panel in the browser.
   *
   * Two implementations of one check is the fault: whichever is weaker becomes the real gate. So this runs the script
   * and fails on its output, and the script's own behaviour is proven by four cases in
   * `scripts/check-imports.mjs` (clean, and each of the two names removed).
   */
  it('no module uses an identifier it never imported or declared', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-imports.mjs')], { encoding: 'utf8' });
    const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    expect(r.status, combined).toBe(0);
    expect(combined).toMatch(/import check: clean/);
  });
});