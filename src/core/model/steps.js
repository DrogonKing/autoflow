/**
 * The step model: what a saved automation is made of.
 *
 * Every step is plain data that survives `JSON.parse(JSON.stringify(x))` unchanged. That constraint is
 * load-bearing: automations are stored in chrome.storage and exported to files, so a step that holds a
 * function or a DOM node would break the moment it was saved. It also means every step can be validated
 * and tested without a browser.
 */

export const STEP_KINDS = [
  'click',        // click / double / right / middle on an element or a point
  'fill',         // set the value of an input, textarea, select, or contenteditable
  'clear',        // empty a field
  'check',        // set a checkbox / radio to a state
  'select',       // choose option(s) in a <select>
  'hover',        // move the pointer over an element
  'focus',        // focus an element
  'blur',         // remove focus
  'submit',       // submit the containing form
  'scroll',       // scroll window or element, to a position or by an amount
  'key',          // press a key or a chord on the focused element
  'wait',         // sleep for a duration
  'waitFor',      // wait until a condition about an element becomes true
  'goto',         // navigate the tab to a URL
  'reload',       // reload the tab
  'back',         // history back
  'forward',      // history forward
  'newTab',       // open a URL in a new tab and optionally switch to it
  'switchTab',    // switch to a tab by index, id, or URL match
  'closeTab',     // close the current or a matching tab
  'loop',         // repeat the enclosed block
  'if',           // run the enclosed block only when a condition holds
  'setVariable',  // assign a value to a variable (supports templates)
  'extract',      // read text/attribute/value from an element into a variable
  'runScript',    // run user JavaScript in the page
  'notify',       // raise a browser notification
  'sound',        // play a short tone
  'download',     // save a value or URL to a file
  'upload',       // set files on a file input (needs a data URL or a path from the user)
  'screenshot',   // capture the visible tab
  'stop',         // end the run, optionally with a reason
  'break',        // leave the innermost loop
  'continue',     // next iteration of the innermost loop
];

export const STEP_LABELS = {
  click: 'Click', fill: 'Fill field', clear: 'Clear field', check: 'Check / uncheck',
  select: 'Select option', hover: 'Hover', focus: 'Focus', blur: 'Blur', submit: 'Submit form',
  scroll: 'Scroll', key: 'Press key', wait: 'Wait', waitFor: 'Wait for condition',
  goto: 'Go to URL', reload: 'Reload', back: 'Back', forward: 'Forward',
  newTab: 'Open new tab', switchTab: 'Switch tab', closeTab: 'Close tab',
  loop: 'Loop', if: 'If condition', setVariable: 'Set variable', extract: 'Extract value',
  runScript: 'Run script', notify: 'Notify', sound: 'Play sound', download: 'Download',
  upload: 'Upload file', screenshot: 'Screenshot', stop: 'Stop',
  break: 'Break loop', continue: 'Continue loop',
};

/** Kinds that hold a nested block of steps. */
export const BLOCK_KINDS = new Set(['loop', 'if']);

/** Kinds that need an element on the page. */
export const ELEMENT_KINDS = new Set([
  'click', 'fill', 'clear', 'check', 'select', 'hover', 'focus', 'blur',
  'submit', 'waitFor', 'extract',
]);

export class StepError extends Error {
  /**
   * @param {string} message
   * @param {string} [stepId] which step, so the UI can point at it
   */
  constructor(message, stepId) {
    super(message);
    this.name = 'StepError';
    this.stepId = stepId;
  }
}

// ---------------------------------------------------------------------------------------------
// element finder
//
// How a step identifies its target. Several strategies, tried in the order the user ranked them, because
// a single strategy never survives contact with real pages: an id may be missing, a CSS path may break
// after a deploy, and text may be the only stable thing.
// ---------------------------------------------------------------------------------------------

export const FINDER_STRATEGIES = [
  'css',      // a CSS selector
  'xpath',    // an XPath expression
  'text',     // visible text, exact or partial
  'id',       // element id
  'name',     // form field name
  'label',    // the text of the associated <label>
  'placeholder',
  'aria',     // aria-label
  'role',     // role + accessible name
  'point',    // an x/y position on the page
  'recorded', // a recorded path: recorded selector + text + attributes as a fallback chain
];

/**
 * @typedef {Object} ElementFinder
 * @property {string} strategy
 * @property {string} [selector]  css
 * @property {string} [xpath]
 * @property {string} [text]
 * @property {boolean} [textExact]
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [label]
 * @property {string} [placeholder]
 * @property {string} [aria]
 * @property {string} [role]
 * @property {string} [roleName]
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [index]        which match to use when several match (0-based)
 * @property {boolean} [visible]     only consider visible matches
 * @property {string[]} [chain]      additional selectors tried in order if the primary fails
 * @property {string} [frameSelector] enter an iframe before searching
 */

export function validateFinder(f, stepId) {
  if (!f || typeof f !== 'object') throw new StepError('an element finder is required', stepId);
  if (!FINDER_STRATEGIES.includes(f.strategy)) {
    throw new StepError(`unknown finder strategy ${JSON.stringify(f.strategy)}`, stepId);
  }
  const need = {
    css: 'selector', xpath: 'xpath', text: 'text', id: 'id', name: 'name',
    label: 'label', placeholder: 'placeholder', aria: 'aria', role: 'role',
  }[f.strategy];
  if (need && (typeof f[need] !== 'string' || !f[need].trim())) {
    throw new StepError(`finder strategy "${f.strategy}" needs a non-empty "${need}"`, stepId);
  }
  if (f.strategy === 'point') {
    if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) {
      throw new StepError('a point finder needs numeric x and y', stepId);
    }
  }
  if (f.index !== undefined && (!Number.isInteger(f.index) || f.index < 0)) {
    throw new StepError('finder index must be a non-negative whole number', stepId);
  }
  return f;
}

// ---------------------------------------------------------------------------------------------
// conditions
// ---------------------------------------------------------------------------------------------

export const COMPARATORS = [
  'exists', 'notExists', 'visible', 'hidden',
  'eq', 'neq', 'contains', 'notContains', 'startsWith', 'endsWith', 'matches',
  'gt', 'gte', 'lt', 'lte',
  'checked', 'unchecked', 'enabled', 'disabled', 'empty', 'notEmpty',
  'countEq', 'countGt', 'countLt',
];

/** Comparators that read a value from the page and compare it to `value`. */
export const VALUE_COMPARATORS = new Set([
  'eq', 'neq', 'contains', 'notContains', 'startsWith', 'endsWith', 'matches',
  'gt', 'gte', 'lt', 'lte',
]);
export const NUMERIC_COMPARATORS = new Set(['gt', 'gte', 'lt', 'lte']);

/**
 * @typedef {Object} Condition
 * @property {ElementFinder} [finder]     what to look at; omit for url/title/variable conditions
 * @property {'text'|'value'|'attribute'|'count'|'url'|'title'|'variable'|'js'} source
 * @property {string} [attribute]         when source is 'attribute'
 * @property {string} [variable]          when source is 'variable'
 * @property {string} [js]                when source is 'js'
 * @property {string} comparator
 * @property {string} [value]
 * @property {boolean} [caseSensitive]
 * @property {'all'|'any'} [combine]      how to combine `also`
 * @property {Condition[]} [also]         additional conditions
 */

export function validateCondition(c, stepId) {
  if (!c || typeof c !== 'object') throw new StepError('a condition is required', stepId);
  if (!COMPARATORS.includes(c.comparator)) {
    throw new StepError(`unknown comparator ${JSON.stringify(c.comparator)}`, stepId);
  }
  const sources = ['text', 'value', 'attribute', 'count', 'url', 'title', 'variable', 'js'];
  if (!sources.includes(c.source)) {
    throw new StepError(`unknown condition source ${JSON.stringify(c.source)}`, stepId);
  }
  if (c.source === 'attribute' && !c.attribute) {
    throw new StepError('an attribute condition needs the attribute name', stepId);
  }
  if (c.source === 'variable' && !c.variable) {
    throw new StepError('a variable condition needs the variable name', stepId);
  }
  if (c.source === 'js' && !c.js) {
    throw new StepError('a js condition needs the expression', stepId);
  }
  if (VALUE_COMPARATORS.has(c.comparator) && c.value === undefined) {
    throw new StepError(`comparator "${c.comparator}" needs a value to compare against`, stepId);
  }
  if (NUMERIC_COMPARATORS.has(c.comparator)) {
    if (!Number.isFinite(Number(c.value))) {
      throw new StepError(
        `comparator "${c.comparator}" compares numbers, but ${JSON.stringify(c.value)} is not one`,
        stepId,
      );
    }
  }
  if (!['url', 'title', 'variable', 'js'].includes(c.source)) {
    validateFinder(c.finder, stepId);
  }
  if (c.also) {
    if (!Array.isArray(c.also)) throw new StepError('condition.also must be an array', stepId);
    for (const sub of c.also) validateCondition(sub, stepId);
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------------------------

let counter = 0;

/** A fresh id. Not a uuid: these only need to be unique within one automation. */
export function newStepId() {
  counter += 1;
  return `s${Date.now().toString(36)}${counter.toString(36)}`;
}

export const MAX_DELAY_MS = 24 * 3600_000;
export const MAX_LOOP_COUNT = 100_000;
export const MAX_STEPS = 1000;

export function makeStep(kind, props = {}) {
  return { id: newStepId(), kind, ...props };
}

export function validateStep(step, depth = 0) {
  if (!step || typeof step !== 'object') throw new StepError('a step must be an object');
  const id = step.id;
  if (!step.kind) throw new StepError('a step needs a kind', id);
  if (!STEP_KINDS.includes(step.kind)) {
    throw new StepError(`unknown step kind ${JSON.stringify(step.kind)}`, id);
  }
  if (depth > 5) throw new StepError('blocks are nested too deeply (max 5 levels)', id);

  // a per-step pause before it runs, useful for pages that settle slowly
  if (step.delayMs !== undefined) {
    if (!Number.isFinite(step.delayMs) || step.delayMs < 0 || step.delayMs > MAX_DELAY_MS) {
      throw new StepError(`delayMs must be 0..${MAX_DELAY_MS}`, id);
    }
  }
  // how many times to retry a failing step
  if (step.retries !== undefined && (!Number.isInteger(step.retries) || step.retries < 0 || step.retries > 50)) {
    throw new StepError('retries must be 0..50', id);
  }
  if (step.onError !== undefined && !['stop', 'continue', 'skip'].includes(step.onError)) {
    throw new StepError('onError must be "stop", "continue" or "skip"', id);
  }

  if (ELEMENT_KINDS.has(step.kind)) {
    validateFinder(step.finder, id);
  }

  switch (step.kind) {
    case 'click':
      if (step.button !== undefined && !['left', 'right', 'middle'].includes(step.button)) {
        throw new StepError('click button must be left, right or middle', id);
      }
      if (step.clickCount !== undefined && ![1, 2, 3].includes(step.clickCount)) {
        throw new StepError('clickCount must be 1, 2 or 3', id);
      }
      // `clickAll` turns a click into "click every match". Validated here because an imported file could
      // otherwise carry an order or a gap the loop cannot honour, or a limit so large it fires forever.
      if (step.clickAll !== undefined) {
        if (step.clickAll === null) break;             // explicitly off
        if (typeof step.clickAll !== 'object') {
          throw new StepError('clickAll must be an object or null', id);
        }
        if (step.clickAll.order !== undefined
            && !['reverse', 'forward', 'as-is'].includes(step.clickAll.order)) {
          throw new StepError('clickAll.order must be reverse, forward or as-is', id);
        }
        const lim = step.clickAll.limit;
        if (lim !== undefined && (!Number.isInteger(lim) || lim < 0 || lim > 5000)) {
          throw new StepError('clickAll.limit must be an integer from 0 to 5000 (0 = every match)', id);
        }
        const gap = step.clickAll.gapMs;
        if (gap !== undefined && (!Number.isFinite(gap) || gap < 50 || gap > 60_000)) {
          throw new StepError('clickAll.gapMs must be between 50 and 60000', id);
        }
      }
      break;

    case 'fill':
      if (step.value !== undefined && typeof step.value !== 'string') {
        throw new StepError('fill value must be a string (use a template for variables)', id);
      }
      if (step.value === undefined && !step.useVariable) {
        throw new StepError('fill needs a value or a variable', id);
      }
      break;

    case 'check':
      if (typeof step.checked !== 'boolean') {
        throw new StepError('check needs checked: true or false', id);
      }
      break;

    case 'select':
      if (!Array.isArray(step.values) && step.value === undefined) {
        throw new StepError('select needs a value or a list of values', id);
      }
      break;

    case 'scroll':
      if (!['window', 'element'].includes(step.target ?? 'window')) {
        throw new StepError('scroll target must be "window" or "element"', id);
      }
      if (!['to', 'by'].includes(step.mode ?? 'by')) {
        throw new StepError('scroll mode must be "to" or "by"', id);
      }
      if (step.mode === 'element' && step.target === 'element') {
        throw new StepError('scroll mode "element" needs a finder; use the scrollIntoView kind', id);
      }
      break;

    case 'key':
      if (!step.keys || (typeof step.keys !== 'string' && !Array.isArray(step.keys))) {
        throw new StepError('key needs a key name or a list of keys', id);
      }
      break;

    case 'wait': {
      const ms = step.ms;
      if (!Number.isFinite(ms) || ms < 0 || ms > MAX_DELAY_MS) {
        throw new StepError(`wait needs ms between 0 and ${MAX_DELAY_MS}`, id);
      }
      break;
    }

    case 'waitFor': {
      validateCondition({ ...step.condition, finder: step.finder }, id);
      if (step.timeoutMs !== undefined &&
          (!Number.isFinite(step.timeoutMs) || step.timeoutMs < 0 || step.timeoutMs > MAX_DELAY_MS)) {
        throw new StepError(`timeoutMs must be 0..${MAX_DELAY_MS}`, id);
      }
      if (step.pollMs !== undefined && (!Number.isFinite(step.pollMs) || step.pollMs < 50)) {
        throw new StepError('pollMs must be at least 50', id);
      }
      break;
    }

    case 'goto':
      if (typeof step.url !== 'string' || !step.url.trim()) {
        throw new StepError('goto needs a url', id);
      }
      break;

    case 'newTab':
      if (typeof step.url !== 'string') throw new StepError('newTab needs a url', id);
      break;

    case 'loop': {
      if (!['count', 'while', 'forEach'].includes(step.loopType ?? 'count')) {
        throw new StepError('loopType must be count, while or forEach', id);
      }
      if ((step.loopType ?? 'count') === 'count') {
        if (!Number.isInteger(step.count) || step.count < 1 || step.count > MAX_LOOP_COUNT) {
          throw new StepError(`loop count must be 1..${MAX_LOOP_COUNT}`, id);
        }
      }
      if (step.loopType === 'while') {
        validateCondition(step.condition, id);
        if (!Number.isFinite(step.maxIterations) || step.maxIterations < 1) {
          // a while loop with no ceiling is an infinite loop in the user's browser
          throw new StepError('a while loop needs maxIterations so it cannot run forever', id);
        }
      }
      validateBlock(step.steps, id, depth);
      break;
    }

    case 'if':
      validateCondition(step.condition, id);
      validateBlock(step.then, id, depth);
      if (step.else) validateBlock(step.else, id, depth);
      break;

    case 'setVariable':
      if (!step.name || typeof step.name !== 'string') throw new StepError('setVariable needs a name', id);
      if (step.value === undefined) throw new StepError('setVariable needs a value', id);
      break;

    case 'extract':
      if (!step.name || typeof step.name !== 'string') throw new StepError('extract needs a name', id);
      if (!['text', 'value', 'attribute', 'html', 'count'].includes(step.source ?? 'text')) {
        throw new StepError('extract source must be text, value, attribute, html or count', id);
      }
      if (step.source === 'attribute' && !step.attribute) {
        throw new StepError('an attribute extract needs the attribute name', id);
      }
      break;

    case 'runScript':
      if (typeof step.code !== 'string' || !step.code.trim()) {
        throw new StepError('runScript needs code', id);
      }
      break;

    case 'notify':
      if (typeof step.message !== 'string' || !step.message.trim()) {
        throw new StepError('notify needs a message', id);
      }
      break;

    case 'download':
      if (!step.content && !step.url) {
        throw new StepError('download needs content or a url', id);
      }
      break;

    case 'stop':
    case 'break':
    case 'continue':
    case 'reload':
    case 'back':
    case 'forward':
    case 'switchTab':
    case 'closeTab':
    case 'hover':
    case 'focus':
    case 'blur':
    case 'submit':
    case 'clear':
    case 'sound':
    case 'screenshot':
    case 'upload':
      break;

    default:
      break;
  }

  return step;
}

function validateBlock(steps, stepId, depth) {
  if (!Array.isArray(steps)) throw new StepError('a block needs an array of steps', stepId);
  if (steps.length > MAX_STEPS) throw new StepError(`at most ${MAX_STEPS} steps per block`, stepId);
  for (const s of steps) validateStep(s, depth + 1);
}

// ---------------------------------------------------------------------------------------------
// automation (a saved, runnable thing)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} Automation
 * @property {string} id
 * @property {string} name
 * @property {string[]} [urls]         URL patterns this runs on
 * @property {Step[]} steps
 * @property {Schedule} schedule
 * @property {Object} [options]        run-level defaults
 * @property {boolean} [enabled]
 */

export const DEFAULT_OPTIONS = {
  /** Pause between steps, so the page can settle. */
  stepDelayMs: 120,
  /** How long a single step may take before it is abandoned. */
  stepTimeoutMs: 15_000,
  /** How many times to retry a failing step before applying onError. */
  stepRetries: 2,
  /** Delay after navigating before touching the page. */
  navigationSettleMs: 800,
  /** Stop the whole run when one step fails. */
  stopOnError: true,
  /** Bring the tab to the front as the automation runs. */
  focusTab: true,
  /** Keep going when the target is in a background tab. */
  runInBackground: true,
  /** Bound the whole run, so a broken loop cannot run all night. */
  maxRunMs: 30 * 60_000,
  /** Values available to templates, and the cursor into loop iterations. */
  variables: {},
};

export function validateAutomation(a) {
  if (!a || typeof a !== 'object') throw new StepError('an automation must be an object');
  if (!a.name || typeof a.name !== 'string' || !a.name.trim()) {
    throw new StepError('an automation needs a name');
  }
  if (!Array.isArray(a.steps)) throw new StepError('an automation needs a steps array');
  if (a.steps.length === 0) throw new StepError('an automation needs at least one step');
  if (a.steps.length > MAX_STEPS) throw new StepError(`at most ${MAX_STEPS} steps`);
  for (const s of a.steps) validateStep(s);

  if (a.urls !== undefined) {
    if (!Array.isArray(a.urls)) throw new StepError('urls must be an array');
    for (const u of a.urls) {
      if (typeof u !== 'string' || !u.trim()) throw new StepError('each url pattern must be a string');
    }
  }
  if (a.schedule) {
    // imported lazily to keep this module free of the schedule module's own import graph
    if (!a.schedule.kind) throw new StepError('schedule needs a kind');
  }
  return a;
}

/** Count the steps including nested blocks, for the UI's summary line. */
export function countSteps(steps) {
  let n = 0;
  for (const s of steps) {
    n += 1;
    if (BLOCK_KINDS.has(s.kind)) {
      if (Array.isArray(s.steps)) n += countSteps(s.steps);
      if (Array.isArray(s.then)) n += countSteps(s.then);
      if (Array.isArray(s.else)) n += countSteps(s.else);
    }
  }
  return n;
}