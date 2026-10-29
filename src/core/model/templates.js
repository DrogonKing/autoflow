/**
 * Templates, variables and random values.
 *
 * A step can contain `${var}`, `${row.email}`, `${now}`, `${random.int(1,10)}`. This is the layer that
 * makes an automation useful with data rather than only as a macro.
 *
 * Pure: `now` and `random` are injected, so a test can pin them and assert exact output. A templating
 * engine that reads the clock internally cannot be tested, and its bugs show up as "sometimes the wrong
 * value is submitted".
 */

export class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateError';
  }
}

const TOKEN = /\$\{([^{}]*)\}/g;

/**
 * Prepare variables for lookup.
 *
 * Scalars become strings, but objects and arrays are kept as they are: `row` has to stay an object for
 * `${row.email}` to work, and stringifying it would turn that into `[object Object]`.
 */
export function normaliseVars(vars) {
  const out = {};
  for (const [k, v] of Object.entries(vars || {})) {
    if (v === null || v === undefined) out[k] = '';
    else if (typeof v === 'object') out[k] = v;
    else out[k] = String(v);
  }
  return out;
}

/**
 * Decide whether a resolved name is a known variable.
 *
 * Unknown names are an error rather than empty text by default: silently submitting an empty field
 * because of a typo (`${emial}`) is the kind of bug that wastes an afternoon.
 */
export function resolveName(name, vars) {
  if (Object.prototype.hasOwnProperty.call(vars, name)) return { found: true, value: vars[name] };
  if (name.includes('.')) {
    // allow nesting one level: row.email where row is an object
    const [head, ...rest] = name.split('.');
    if (Object.prototype.hasOwnProperty.call(vars, head)) {
      let cur = vars[head];
      for (const part of rest) {
        if (cur && typeof cur === 'object' && part in cur) cur = cur[part];
        else return { found: false, value: '' };
      }
      return { found: true, value: cur === null || cur === undefined ? '' : String(cur) };
    }
  }
  return { found: false, value: '' };
}

// ---------------------------------------------------------------------------------------------
// dynamic values: ${now}, ${random.*}, ${row.*}, ${loop.index}
// ---------------------------------------------------------------------------------------------

const RANDOM_FUNCS = {
  int(min, max) {
    const lo = Math.ceil(Number(min));
    const hi = Math.floor(Number(max));
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new TemplateError('random.int needs two numbers');
    if (hi < lo) throw new TemplateError(`random.int range is inverted: ${lo}..${hi}`);
    return String(Math.floor(Math.random() * (hi - lo + 1)) + lo);
  },
  float(min, max, decimals) {
    const lo = Number(min);
    const hi = Number(max);
    const d = decimals === undefined ? 2 : Number(decimals);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new TemplateError('random.float needs two numbers');
    if (hi < lo) throw new TemplateError(`random.float range is inverted: ${lo}..${hi}`);
    return (Math.random() * (hi - lo) + lo).toFixed(Math.max(0, Math.min(10, d)));
  },
  string(length) {
    const n = Math.max(1, Math.min(256, Number(length) || 8));
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < n; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  },
  pick(...choices) {
    const flat = choices.length === 1 && Array.isArray(choices[0]) ? choices[0] : choices;
    if (flat.length === 0) throw new TemplateError('random.pick needs at least one choice');
    return String(flat[Math.floor(Math.random() * flat.length)]);
  },
  uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16);
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  },
  email() {
    return `${RANDOM_FUNCS.string(8)}@example.com`;
  },
  number(length) {
    const n = Math.max(1, Math.min(20, Number(length) || 6));
    let out = String(Math.floor(Math.random() * 9) + 1);
    for (let i = 1; i < n; i++) out += Math.floor(Math.random() * 10);
    return out;
  },
};

const DATE_FORMATS = {
  iso: (d) => d.toISOString(),
  date: (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  time: (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  datetime: (d) => `${DATE_FORMATS.date(d)} ${DATE_FORMATS.time(d)}`,
  timestamp: (d) => String(d.getTime()),
  epoch: (d) => String(Math.floor(d.getTime() / 1000)),
  year: (d) => String(d.getFullYear()),
  month: (d) => pad(d.getMonth() + 1),
  day: (d) => pad(d.getDate()),
  weekday: (d) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()],
};

const pad = (n) => String(n).padStart(2, '0');

/**
 * Evaluate one `${...}` body.
 *
 * Grammar, deliberately small and predictable:
 *   name
 *   name|default:fallback        pipe with a default
 *   now[.format]                 now, iso, date, time, datetime, timestamp, epoch, year, month, day, weekday
 *   now+5m / now-2h / now+30s    arithmetic on now
 *   random.int(1,10)             the functions above
 */
export function evaluateExpression(expr, vars, { now = () => new Date() } = {}) {
  const body = expr.trim();
  if (!body) return '';

  // pipe: value | default:fallback | upper | lower | trim
  if (body.includes('|')) {
    const [head, ...pipes] = body.split('|');
    let value = evaluateExpression(head, vars, { now });
    for (const raw of pipes) {
      const p = raw.trim();
      if (p.startsWith('default:')) {
        // A LITERAL fallback, not an expression. Evaluating it would make `${x|default:N/A}` throw
        // "unknown variable N/A", which is the opposite of what a default is for.
        if (value === '') value = p.slice('default:'.length);
      } else if (p === 'upper') value = value.toUpperCase();
      else if (p === 'lower') value = value.toLowerCase();
      else if (p === 'trim') value = value.trim();
      else throw new TemplateError(`unknown modifier "${p}" in \${${body}}`);
    }
    return value;
  }

  // random.*
  if (body.startsWith('random.')) {
    const m = /^random\.([a-zA-Z]+)\((.*)\)$/s.exec(body);
    if (!m) throw new TemplateError(`malformed random call: \${${body}}`);
    const fn = RANDOM_FUNCS[m[1]];
    if (!fn) throw new TemplateError(`unknown random function "${m[1]}"`);
    const args = m[2].trim() === ''
      ? []
      : m[2].split(',').map((a) => a.trim().replace(/^["']|["']$/g, ''));
    return fn(...args);
  }

  // now, optionally with arithmetic and a format
  if (body === 'now' || body.startsWith('now.') || body.startsWith('now+') || body.startsWith('now-')) {
    let rest = body.slice(3);
    let date = now();
    // arithmetic: +5m -2h +30s +1d
    const shift = /^([+-])(\d+)([smhd])/.exec(rest);
    if (shift) {
      const amount = Number(shift[2]);
      const unitMs = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[shift[3]];
      date = new Date(date.getTime() + (shift[1] === '-' ? -amount : amount) * unitMs);
      rest = rest.slice(shift[0].length);
    }
    if (rest === '') return DATE_FORMATS.datetime(date);
    if (rest.startsWith('.')) {
      const fmt = rest.slice(1).trim();
      const fn = DATE_FORMATS[fmt];
      if (!fn) {
        throw new TemplateError(`unknown date format "${fmt}" (have: ${Object.keys(DATE_FORMATS).join(', ')})`);
      }
      return fn(date);
    }
    throw new TemplateError(`cannot parse "\${${body}}"`);
  }

  // a variable
  const { found, value } = resolveName(body, vars);
  if (found) return value;
  throw new TemplateError(`unknown variable "\${${body}}" - is it set before this step?`);
}

/**
 * Expand every `${...}` in a string.
 *
 * @param {string} text
 * @param {Object} vars
 * @param {{now?: () => Date, strict?: boolean}} [opts]
 */
export function interpolate(text, vars = {}, opts = {}) {
  if (text === null || text === undefined) return '';
  const s = String(text);
  if (!s.includes('${')) return s;
  const v = normaliseVars(vars);
  const strict = opts.strict !== false;
  return s.replace(TOKEN, (whole, expr) => {
    try {
      return evaluateExpression(expr, v, opts);
    } catch (e) {
      if (strict) throw e;
      return whole;
    }
  });
}

/** Does this text contain any template at all? Used by the UI to show a "dynamic" badge. */
export function hasTemplate(text) {
  return typeof text === 'string' && /\$\{[^{}]+\}/.test(text);
}

/** The variable names a text depends on, so the UI can warn about ones never set. */
export function templateNames(text) {
  const out = new Set();
  if (typeof text !== 'string') return out;
  for (const m of text.matchAll(TOKEN)) {
    const body = m[1].trim();
    if (body.startsWith('random.') || body === 'now' || body.startsWith('now.') ||
        body.startsWith('now+') || body.startsWith('now-')) continue;
    const head = body.split('|')[0].trim();
    if (head) out.add(head);
  }
  return out;
}

/** Randomise a delay, so a run does not look mechanically identical every time. */
export function jitter(baseMs, jitterMs, random = Math.random) {
  if (!jitterMs) return baseMs;
  const delta = Math.floor((random() * 2 - 1) * jitterMs);
  return Math.max(0, baseMs + delta);
}

export const RANDOM_FUNCTION_NAMES = Object.keys(RANDOM_FUNCS);
export const DATE_FORMAT_NAMES = Object.keys(DATE_FORMATS);
