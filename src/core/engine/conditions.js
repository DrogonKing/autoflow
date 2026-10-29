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
    const n = Number(observed);
    const m = Number(exp);
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
    const n = Number(observed);
    const m = Number(exp);
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
      return re.test(observed === null || observed === undefined ? '' : String(observed));
    }
    default:
      throw new ConditionError(`unknown comparator ${JSON.stringify(comparator)}`);
  }
}

/**
 * Evaluate a whole condition tree against an observation.
 *
 * @param {Object} condition
 * @param {{read: (condition: Object) => {value: *, found: boolean}, vars?: Object}} ctx
 *   `read` is supplied by the caller and knows how to look at the page. Keeping it a callback is what
 *   lets this file be tested with plain objects and run unchanged in a content script.
 * @returns {boolean}
 */
export function evaluateCondition(condition, ctx) {
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
    const observed = ctx.read(condition);
    result = compare(condition.comparator, observed.value, resolveExpected(condition, ctx), { caseSensitive });
  } else {
    const obs = ctx.read(condition);
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
    const rest = condition.also.map((sub) => evaluateCondition(sub, ctx));
    if (combine === 'any') {
      // the primary condition participates: "this OR any of those"
      return result || rest.some(Boolean);
    }
    return result && rest.every(Boolean);
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