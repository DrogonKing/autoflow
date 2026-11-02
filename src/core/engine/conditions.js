/**
 * Conditions: is this automation allowed to act?
 *
 * A condition is what turns a macro into a decision. The comparators are evaluated as a pure function of
 * (observed value, expected value, options), which means the whole truth table is testable without a
 * browser - and the truth table is where the bugs are: `gt` on a non-number, `matches` with an invalid
 * regex, `notContains` on an absent element.
 */

import {
  COMPARATORS,
  NUMERIC_COMPARATORS,
  VALUE_COMPARATORS,
  validateCondition,
  StepError,
} from '../model/steps.js';
import { interpolate } from '../model/templates.js';

export class ConditionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConditionError';
  }
}

/**
 * A number from an observed or expected value, or NaN when there is none.
 *
 * Persian and Arabic digits are converted, because a page formats numbers that way. null, undefined, booleans and blank
 * text are NaN rather than 0, so an absent value is never silently a number.
 *
 * A COMMA IS ONLY A THOUSANDS SEPARATOR WHEN IT GROUPS THREE DIGITS.
 *
 * MEASURED (`decimal-comma`): every comma was stripped, so `12,50` became `1250` - a hundredfold error, silently, on a
 * price. A condition on 12.5 against 1250 is simply the wrong question with the wrong answer. The Persian decimal
 * separator (U+066B) was not handled at all and produced NaN, so a Persian-formatted price could not be compared.
 *
 * The rule: a separator counts as thousands only when what follows it is exactly a group of three digits (and, if a
 * decimal part follows, that too is consistent). Otherwise it is the decimal separator, which is what a locale that writes
 * decimals with a comma means.
 */
function parseNum(v) {
  if (v === null || v === undefined || typeof v === 'boolean' || String(v).trim() === '') return NaN;
  if (typeof v === 'number') return v;
  let s = String(v)
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    // the Persian and Arabic decimal separators are decimal points, not thousands
    .replace(/[\u066B]/g, '.')
    .replace(/[\u066C\u2019\u00A0\u202F]/g, '');   // Arabic thousands, apostrophe, non-breaking and narrow spaces
  /**
   * THOUSANDS SEPARATORS ARE REMOVED ONLY WHERE THEY REALLY ARE THOUSANDS SEPARATORS.
   *
   * `1,234,567.5` and `1,234` are groups of three; `12,50` and `1,5` are not, and the comma there is the decimal point.
   * The pattern is applied repeatedly so multi-group values collapse fully.
   */
  /**
   * WHICH SEPARATOR IS THE DECIMAL ONE IS DECIDED BY POSITION, NOT BY GUESSING AT A LOCALE.
   *
   * Three shapes are all in real use and all reach this function:
   *   `1,234.56`  Anglo - comma groups, dot decimals
   *   `1.234,56`  European - dot groups, comma decimals
   *   `12,50`     a bare decimal comma
   *
   * If BOTH appear, the LAST one is the decimal separator and the other is grouping. If only one appears, it is the
   * decimal separator unless it groups exactly three digits (so `1,234` is 1234 but `12,50` is 12.5).
   */
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      // European: dots group, the comma is the decimal point
      s = `${s.slice(0, lastComma).replace(/[.,]/g, '')}.${s.slice(lastComma + 1).replace(/[.,]/g, '')}`;
    } else {
      // Anglo: commas group, the dot is the decimal point
      s = `${s.slice(0, lastDot).replace(/,/g, '')}.${s.slice(lastDot + 1).replace(/,/g, '')}`;
    }
  } else if (lastComma >= 0) {
    // only commas: thousands when each divides a group of three, otherwise the decimal separator
    s = s.replace(/(\d)[,](?=(\d{3})(\D|$))/g, '$1');
    const firstComma = s.indexOf(',');
    if (firstComma >= 0) s = `${s.slice(0, firstComma)}.${s.slice(firstComma + 1).replace(/,/g, '')}`;
  }
  return Number(s);
}

/**
 * Compare one observed value.
 *
 * @param {string} comparator
 * @param {*} observed   null/undefined means "the element was not found"
 * @param {string} [expected]
 * @param {{caseSensitive?: boolean}} [opts]
 * @returns {boolean}
 */
export function compare(comparator, observed, expected, opts = {}) {
  const caseSensitive = opts.caseSensitive === true;
  const norm = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return caseSensitive ? s : s.toLowerCase();
  };
  const exp = expected === null || expected === undefined ? '' : String(expected);

  // existence-style comparators do not read a value at all
  switch (comparator) {
    case 'exists':    return observed !== null && observed !== undefined;
    case 'notExists': return observed === null || observed === undefined;
    case 'empty':     return observed === null || observed === undefined || String(observed).trim() === '';
    case 'notEmpty':  return !(observed === null || observed === undefined || String(observed).trim() === '');
    default: break;
  }

  // these are reported by the caller as booleans, not values
  if (comparator === 'visible' || comparator === 'hidden' || comparator === 'checked' ||
      comparator === 'unchecked' || comparator === 'enabled' || comparator === 'disabled') {
    return observed === true;
  }

  // count comparators receive a number
  if (comparator === 'countEq' || comparator === 'countGt' || comparator === 'countLt') {
    const n = parseNum(observed);
    const m = parseNum(exp);
    if (!Number.isFinite(n) || !Number.isFinite(m)) {
      throw new ConditionError(
        `${comparator} compares counts, but got ${JSON.stringify(observed)} and ${JSON.stringify(expected)}`,
      );
    }
    if (comparator === 'countEq') return n === m;
    if (comparator === 'countGt') return n > m;
    return n < m;
  }

  if (NUMERIC_COMPARATORS.has(comparator)) {
    const n = parseNum(observed);
    const m = parseNum(exp);
    // Comparing text with > is a mistake worth reporting: "9" > "10" is true lexicographically, which
    // silently produces the wrong branch.
    if (!Number.isFinite(n) || !Number.isFinite(m)) {
      throw new ConditionError(
        `${comparator} can only compare numbers, but got ${JSON.stringify(observed)} and ${JSON.stringify(expected)}`,
      );
    }
    switch (comparator) {
      case 'gt':  return n > m;
      case 'gte': return n >= m;
      case 'lt':  return n < m;
      case 'lte': return n <= m;
      default: break;
    }
  }

  switch (comparator) {
    case 'eq':          return norm(observed) === norm(exp);
    case 'neq':         return norm(observed) !== norm(exp);
    case 'contains':    return norm(observed).includes(norm(exp));
    case 'notContains': return !norm(observed).includes(norm(exp));
    case 'startsWith':  return norm(observed).startsWith(norm(exp));
    case 'endsWith':    return norm(observed).endsWith(norm(exp));
    case 'matches': {
      if (expected === undefined || expected === null) {
        throw new ConditionError('matches needs a regular expression pattern');
      }
      /**
       * A regular expression supplied by the automation's author, run against a value from a page.
       *
       * Two guards, both because the inputs are not trusted to be reasonable:
       *  - the pattern is built in a try, so an invalid one is reported rather than thrown
       *  - the SUBJECT is capped, so a catastrophic pattern against a megabyte of page text cannot spend
       *    unbounded CPU. 100k characters is far more than any real condition needs, and the cap is
       *    applied before the regex engine sees it.
       */
      const subject = String(observed ?? '').slice(0, 100_000);
      try {
        return new RegExp(expected, caseSensitive ? '' : 'i').test(subject);
      } catch (e) {
        throw new ConditionError(`the regular expression ${JSON.stringify(exp)} is invalid: ${e.message}`);
      }
    }
    default:
      throw new ConditionError(`unknown comparator ${JSON.stringify(comparator)}`);
  }
}

/**
 * Evaluate a whole condition tree against an observation.
 *
 * @param {Object} condition
 * @param {{read: (condition: Object) => ({value: *, found: boolean} | Promise<{value: *, found: boolean}>),
 *          vars?: Object}} ctx
 *   `read` is supplied by the caller and knows how to look at the page. Keeping it a callback is what lets this
 *   file be tested with plain objects and run unchanged in a content script. It is AWAITED, because in the worker
 *   it reads through a message to the tab and therefore returns a Promise - reading `.value` off that Promise was
 *   the bug that made every page condition false.
 * @returns {Promise<boolean>}
 */
export async function evaluateCondition(condition, ctx) {
  validateCondition(condition);
  const caseSensitive = condition.caseSensitive === true;

  let result;

  if (condition.source === 'variable') {
    /**
     * A variable is read from the run's own `vars`, NOT from the page.
     *
     * This was a real bug: `variable` was grouped with the sources that must be read from the page, and the
     * page's `observe()` deliberately returns `{ value: null }` for it (it cannot know the run's variables).
     * So the observed value was always null and `variable status eq ready` could never match - the automation
     * took the else branch every time and looked like it was working.
     *
     * A missing variable is `null` rather than `undefined` so a `neq` against an empty string still has a
     * defined value to compare.
     */
    const raw = ctx.vars ? ctx.vars[condition.variable] : undefined;
    let observed = raw === undefined ? null : raw;
    if (observed !== null && typeof observed === 'object') {
      // an object interpolates to a string for comparison; a template can reach inside it with ${x.y}
      try {
        observed = JSON.stringify(observed);
      } catch {
        observed = String(observed);
      }
    }
    result = compare(condition.comparator, observed, resolveExpected(condition, ctx), { caseSensitive });
  } else if (condition.source === 'js' || condition.source === 'url' || condition.source === 'title') {
    /**
     * These are read from the page. `js` is deliberately inert: nothing evaluates it, and the page returns
     * null for it. It is kept in the model because a saved automation may carry one, and a test pins the
     * behaviour so that executing it would have to be a deliberate change rather than an accident.
     */
    // awaited: `read` reaches the page through the worker, so it returns a Promise there
    const observed = await ctx.read(condition);
    result = compare(condition.comparator, observed.value, resolveExpected(condition, ctx), { caseSensitive });
  } else {
    const obs = await ctx.read(condition);
    if (condition.comparator === 'countEq' || condition.comparator === 'countGt' || condition.comparator === 'countLt') {
      result = compare(condition.comparator, obs.count, resolveExpected(condition, ctx), { caseSensitive });
    } else if (['visible', 'hidden', 'checked', 'unchecked', 'enabled', 'disabled'].includes(condition.comparator)) {
      // `read` reports these as booleans on the observation
      const flags = obs.flags || {};
      const flagMap = {
        visible: 'visible', hidden: 'hidden', checked: 'checked',
        unchecked: 'unchecked', enabled: 'enabled', disabled: 'disabled',
      };
      result = flags[flagMap[condition.comparator]] === true;
    } else if (condition.comparator === 'exists' || condition.comparator === 'notExists') {
      result = compare(condition.comparator, obs.found ? (obs.value ?? '') : null, undefined, { caseSensitive });
    } else if (obs.found === false) {
      // A value comparison against a missing element is false, not an error: the page may legitimately
      // not have the element yet, and waitFor depends on that being a normal `false`.
      result = false;
    } else {
      result = compare(condition.comparator, obs.value, resolveExpected(condition, ctx), { caseSensitive });
    }
  }

  if (Array.isArray(condition.also) && condition.also.length) {
    const combine = condition.combine === 'any' ? 'any' : 'all';
    // awaited one at a time and short-circuited: a nested tree reads the page, and once the answer is decided
    // there is no reason to send another message for the remaining sub-conditions
    if (combine === 'any') {
      // the primary condition participates: "this OR any of those"
      if (result) return true;
      for (const sub of condition.also) {
        if (await evaluateCondition(sub, ctx)) return true;
      }
      return false;
    }
    if (!result) return false;
    for (const sub of condition.also) {
      if (!(await evaluateCondition(sub, ctx))) return false;
    }
    return true;
  }

  return result;
}

/** Expected values may themselves be templates, so a condition can compare against a variable. */
function resolveExpected(condition, ctx) {
  if (condition.value === undefined) return undefined;
  if (!ctx.vars) return String(condition.value);
  try {
    return interpolate(String(condition.value), ctx.vars, { strict: true });
  } catch {
    // A template that cannot resolve is left literal rather than throwing: the condition simply will not
    // match, which is a safer outcome than aborting a run halfway.
    return String(condition.value);
  }
}

/** A sentence for the UI, so the logic being built is readable at a glance. */
export function describeCondition(c) {
  if (!c) return 'always';
  const cmpWords = {
    exists: 'exists', notExists: 'does not exist', visible: 'is visible', hidden: 'is hidden',
    eq: 'equals', neq: 'does not equal', contains: 'contains', notContains: 'does not contain',
    startsWith: 'starts with', endsWith: 'ends with', matches: 'matches the pattern',
    gt: 'is greater than', gte: 'is at least', lt: 'is less than', lte: 'is at most',
    checked: 'is checked', unchecked: 'is not checked', enabled: 'is enabled', disabled: 'is disabled',
    empty: 'is empty', notEmpty: 'is not empty', countEq: 'counts exactly', countGt: 'counts more than',
    countLt: 'counts fewer than',
  };
  const target = () => {
    if (c.source === 'url') return 'the page URL';
    if (c.source === 'title') return 'the page title';
    if (c.source === 'variable') return `variable ${c.variable}`;
    if (c.source === 'js') return 'the script result';
    const f = c.finder || {};
    switch (f.strategy) {
      case 'css': return `element ${f.selector}`;
      case 'xpath': return `element at ${f.xpath}`;
      case 'text': return `element containing "${f.text}"`;
      case 'id': return `element #${f.id}`;
      case 'name': return `field named "${f.name}"`;
      case 'label': return `field labelled "${f.label}"`;
      case 'placeholder': return `field with placeholder "${f.placeholder}"`;
      case 'aria': return `element with aria-label "${f.aria}"`;
      case 'role': return `element with role ${f.role}`;
      case 'point': return `the element at (${f.x}, ${f.y})`;
      default: return 'the element';
    }
  };
  const what = c.source === 'attribute' ? `the ${c.attribute} of ${target()}`
    : c.source === 'value' ? `the value of ${target()}`
    : c.source === 'count' ? `how many match ${target()}`
    : c.source === 'text' ? `the text of ${target()}`
    : target();

  let out = `${what} ${cmpWords[c.comparator] ?? c.comparator}`;
  if (VALUE_COMPARATORS.has(c.comparator) || c.comparator.startsWith('count')) {
    out += ` "${c.value ?? ''}"`;
  }
  if (Array.isArray(c.also) && c.also.length) {
    out += ` ${c.combine === 'any' ? 'OR' : 'AND'} (${c.also.map(describeCondition).join(c.combine === 'any' ? ' OR ' : ' AND ')})`;
  }
  return out;
}

export { COMPARATORS, StepError };