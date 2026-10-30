/**
 * Performing the action on the page.
 *
 * The counterpart to finder.js: given a step and an element, do the thing and report what happened.
 *
 * Two decisions worth naming.
 *
 * First, a real click rather than `el.click()`. `el.click()` skips hit-testing, so it "works" on an
 * element that a user could never click, and it misses every framework that listens for pointer events
 * rather than the click. The dispatcher here sends the pointer sequence and then the element's own
 * click, falling back only when the element has no layout box.
 *
 * Second, form fields are set the way a user would set them: the value is assigned through the native
 * setter and then `input` and `change` are dispatched. Assigning `el.value` directly leaves React's
 * controlled input unchanged, which is the single most common "the field stayed empty" report.
 */

import { findElement, FinderError, isVisible, describeElement } from './finder.js';

export class ActionError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ActionError';
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Construct a UI event, tolerating an environment that refuses the `view` member.
 *
 * A UIEvent's `view` must be a genuine Window object belonging to the document the event is dispatched
 * on. That holds in a real browser, but not everywhere - a test harness or an isolated world can expose
 * a window-like global that fails the check and makes the constructor throw:
 *
 *   Failed to construct 'MouseEvent': member view is not of type Window
 *
 * `view` is optional and almost nothing reads it, so the fallback is to construct without it rather than
 * lose the whole interaction. The decision is cached, because paying for a thrown exception on every
 * keystroke of a long run would be its own problem.
 */
let viewIsUsable = null;
function makeUiEvent(Ctor, type, opts) {
  if (viewIsUsable === false) {
    const { view, ...rest } = opts;
    return new Ctor(type, rest);
  }
  try {
    const e = new Ctor(type, opts);
    viewIsUsable = true;
    return e;
  } catch (err) {
    if (!/view/i.test(String(err?.message))) throw err;
    viewIsUsable = false;
    const { view, ...rest } = opts;
    return new Ctor(type, rest);
  }
}

function doc() {
  return document;
}

/**
 * The Window an element belongs to.
 *
 * UIEvent's `view` member must be a real Window object for the element's own document; passing anything
 * else (a different document's window, or a WindowProxy that the implementation does not recognise)
 * makes the constructor throw. In an extension there can be several documents in play, so this is
 * resolved from the element rather than using the ambient global.
 */
function windowOf(el) {
  const doc = el?.ownerDocument ?? (el?.nodeType === 9 ? el : null);
  const view = doc?.defaultView;
  if (view && typeof view.getComputedStyle === 'function') return view;
  return globalThis.window ?? globalThis;
}

/** Scroll into view, so the click lands where a user's would. */
function bringIntoView(el, block = 'center') {
  try {
    el.scrollIntoView({ block, inline: 'nearest', behavior: 'instant' });
  } catch {
    try {
      el.scrollIntoView();
    } catch { /* some detached nodes throw; not fatal */ }
  }
}

/**
 * Dispatch a full pointer + mouse + click sequence.
 *
 * The coordinates come from the element's own box so a listener reading `clientX` gets a sensible value.
 */
export function realClick(el, { button = 'left', clickCount = 1, force = false } = {}) {
  if (!el) throw new ActionError('cannot click: no element');
  const w = windowOf(el);
  let rect = el.getBoundingClientRect();
  const offscreen = rect.top < 0 || rect.left < 0 ||
    rect.bottom > (w?.innerHeight || Infinity) || rect.right > (w?.innerWidth || Infinity);
  if ((rect.width === 0 && rect.height === 0) || offscreen) {
    bringIntoView(el);
    rect = el.getBoundingClientRect();
  }
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const buttonCode = { left: 0, middle: 1, right: 2 }[button] ?? 0;
  const buttons = { left: 1, middle: 4, right: 2 }[button] ?? 1;

  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: w,
    clientX: cx,
    clientY: cy,
    screenX: cx,
    screenY: cy,
    button: buttonCode,
  };

  // A zero-size box means there is no point to hit. The sequence still runs (a page listening for
  // `click` must hear it), and a direct click is added only when the sequence may not produce one -
  // a detached node, or an environment with no layout at all.
  const noBox = rect.width === 0 && rect.height === 0;

  const ME = w?.MouseEvent ?? globalThis.MouseEvent;
  const PE = w?.PointerEvent ?? globalThis.PointerEvent ?? null;
  if (!ME) throw new ActionError('this environment has no MouseEvent constructor');
  const emitPointer = (type, extra) => {
    if (!PE) return;
    el.dispatchEvent(makeUiEvent(PE, type, { ...base, pointerId: 1, pointerType: 'mouse', ...extra }));
  };
  const emitMouse = (type, extra = {}) => {
    el.dispatchEvent(makeUiEvent(ME, type, { ...base, ...extra }));
  };

  emitPointer('pointerover', { buttons: 0 });
  emitPointer('pointerenter', { buttons: 0 });
  emitPointer('pointerdown', { isPrimary: true, buttons });
  emitMouse('mouseover', { buttons: 0 });
  emitMouse('mouseenter', { buttons: 0 });
  emitMouse('mousemove', { buttons: 0 });
  emitMouse('mousedown', { buttons, detail: 1 });

  emitPointer('pointerup', { isPrimary: true, buttons: 0 });
  emitMouse('mouseup', { buttons: 0, detail: 1 });

  // Exactly one click, from one source. A link needs the element's own click because a synthetic click
  // does not cause navigation; anything else gets the synthetic one, which carries the real button and
  // detail. Doing both is the bug this replaced: a form submitted twice.
  const isLink = el.tagName === 'A' && !!(el.href || el.getAttribute?.('href'));
  if (isLink && clickCount === 1 && button === 'left') {
    try { el.click(); } catch { /* ignore */ }
  } else {
    for (let i = 0; i < clickCount; i++) {
      emitMouse('click', { buttons: 0, detail: i + 1 });
    }
    if (clickCount === 2) emitMouse('dblclick', { buttons: 0, detail: 2 });
  }
  emitMouse('mouseout', { buttons: 0 });
  emitPointer('pointerout', { buttons: 0 });
  emitPointer('pointerleave', { buttons: 0 });

  // Some widgets act on the element's own click handler and not on the dispatched event. Calling it as
  // well makes both styles work, but it must NOT happen for a link: `el.click()` on an <a> navigates,
  // and a duplicate navigation is worse than a missed one.
  return {
    method: isLink ? 'element-click (link)' : 'pointer-sequence',
    x: cx,
    y: cy,
    button,
    clickCount,
    hadLayoutBox: !noBox,
  };
}

/**
 * Set a field's value through the prototype's own setter.
 *
 * This is the documented way to make a framework see the change. React (and others) install an
 * instance-level `value` accessor that ignores direct assignment, so `el.value = x` updates the DOM
 * property while the framework's state stays stale and the next render wipes it. Calling the setter from
 * the prototype chain writes to the storage the framework reads.
 */
export function setNativeValue(el, value) {
  let proto = Object.getPrototypeOf(el);
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) {
      descriptor.set.call(el, value);
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  // No accessor anywhere in the chain (a plain node): a direct assignment is all there is.
  el.value = value;
  return false;
}

export function fireInput(el, value) {
  const opts = { bubbles: true, cancelable: false, composed: true };
  const IE = globalThis.InputEvent ?? null;
  if (typeof IE === 'function') {
    try {
      el.dispatchEvent(new IE('input', { ...opts, data: value ?? null, inputType: 'insertText' }));
    } catch {
      el.dispatchEvent(new Event('input', opts));
    }
  } else {
    el.dispatchEvent(new Event('input', opts));
  }
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

/**
 * Fill a field: input, textarea, contenteditable, select, checkbox or radio.
 *
 * Dispatches focus, the value, input, change in the order a real interaction would, because a page that
 * validates on blur or on input will reject a value that arrives without those events.
 */
export function fillElement(el, value, { clearFirst = true } = {}) {
  const tag = el.tagName;
  const type = (el.getAttribute?.('type') ?? '').toLowerCase();
  bringIntoView(el);
  el.focus?.({ preventScroll: true });

  if (tag === 'SELECT') {
    return selectOption(el, value);
  }

  if (type === 'checkbox' || type === 'radio') {
    const want = toBool(value);
    if (el.checked === want) {
      return { method: 'check (already in that state)', checked: el.checked };
    }
    // A real click is the only thing a page's own listener will see, so prefer it. When the element has
    // no layout box the click cannot land, so fall back to setting the property - and in both cases send
    // the events a page uses to notice, because a framework tracks the event rather than the property.
    const rect = el.getBoundingClientRect?.() ?? { width: 0, height: 0 };
    const canClick = rect.width > 0 || rect.height > 0;
    let method = 'click';
    if (canClick) {
      realClick(el);
    }
    if (el.checked !== want) {
      el.checked = want;
      method = canClick ? 'click+property' : 'property';
    }
    const IE = globalThis.InputEvent ?? null;
    if (typeof IE === 'function') {
      try {
        el.dispatchEvent(new IE('input', { bubbles: true, composed: true }));
      } catch { /* ignore */ }
    }
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { method, checked: el.checked };
  }

  if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') {
    el.textContent = clearFirst ? value : (el.textContent ?? '') + value;
    fireInput(el, value);
    return { method: 'contenteditable', value };
  }

  if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
    throw new ActionError(`cannot fill a <${tag.toLowerCase()}> - it is not a form field`);
  }

  // React and Vue track the previous value; going through the native setter is what makes them update.
  const next = clearFirst ? String(value ?? '') : `${el.value ?? ''}${value ?? ''}`;
  // select() before assigning makes the change observable to a page watching selection
  try { el.select?.(); } catch { /* not selectable */ }
  if (clearFirst && next !== '') {
    setNativeValue(el, '');
    fireInput(el, '');
  }
  setNativeValue(el, next);
  fireInput(el, next);
  el.dispatchEvent(new Event('blur', { bubbles: false }));
  el.focus?.({ preventScroll: true });
  return { method: 'native-setter', value: next };
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  return !['', 'false', '0', 'no', 'off', 'unchecked'].includes(s);
}

/** Choose options in a <select>, by value or by visible label. */
export function selectOption(el, value) {
  const wanted = Array.isArray(value) ? value.map(String) : [String(value ?? '')];
  const options = [...el.options];
  const chosen = [];
  for (const want of wanted) {
    const byValue = options.find((o) => o.value === want);
    const byText = options.find((o) => (o.textContent ?? '').trim() === want.trim());
    const opt = byValue ?? byText;
    if (!opt) {
      throw new ActionError(
        `no option matching ${JSON.stringify(want)} in the select (have: ${
          options.map((o) => o.value || o.textContent?.trim()).slice(0, 12).join(', ')})`,
      );
    }
    chosen.push(opt);
  }
  if (el.multiple) {
    for (const o of options) o.selected = chosen.includes(o);
  } else {
    chosen[0].selected = true;
    el.value = chosen[0].value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  return { method: 'select', values: chosen.map((o) => o.value) };
}

export function scrollAction({ target = 'window', mode = 'by', x = 0, y = 0, el }) {
  if (target === 'element' && el) {
    if (mode === 'to') el.scrollTo?.({ left: x, top: y, behavior: 'instant' });
    else el.scrollBy?.({ left: x, top: y, behavior: 'instant' });
    return { method: 'element-scroll', left: el.scrollLeft, top: el.scrollTop };
  }
  const w = window;
  if (mode === 'to') w.scrollTo({ left: x, top: y, behavior: 'instant' });
  else w.scrollBy({ left: x, top: y, behavior: 'instant' });
  return { method: 'window-scroll', x: w.scrollX, y: w.scrollY };
}

/**
 * Press a key, or a chord.
 *
 * Order matters: modifiers go down first and come up last, which is what makes ctrl+shift+t behave like
 * a shortcut rather than three unrelated key presses. `gapMs` separates the events so a page that
 * debounces keystrokes sees them individually.
 */
export async function pressKeys(el, keys, { gapMs = 0, holdMs = 0 } = {}) {
  const list = Array.isArray(keys)
    ? keys
    : String(keys).trim() === '+'
      ? ['+']
      : String(keys).split('+').map((s) => s.trim()).filter(Boolean);
  const target = el ?? doc().activeElement ?? doc().body;
  const w = windowOf(target);
  const MODS = { ctrl: 'Control', control: 'Control', alt: 'Alt', shift: 'Shift', meta: 'Meta', cmd: 'Meta', win: 'Meta' };
  const modsDown = [];
  const activeMods = new Set();
  const sequence = [];

  for (const raw of list) {
    const k = String(raw);
    const lower = k.toLowerCase();
    if (MODS[lower]) {
      if (!modsDown.includes(MODS[lower])) modsDown.push(MODS[lower]);
    } else {
      sequence.push(k);
    }
  }

  const KE = w?.KeyboardEvent ?? globalThis.KeyboardEvent;
  const keyEvent = (type, key) => {
    const isMod = Object.values(MODS).includes(key);
    return makeUiEvent(KE, type, {
      key: isMod ? key : normalizeKeyName(key),
      code: isMod ? `${key}Left` : keyCodeName(key),
      bubbles: true, cancelable: true, composed: true,
      view: w,
      ctrlKey: activeMods.has('Control'), altKey: activeMods.has('Alt'),
      shiftKey: activeMods.has('Shift'), metaKey: activeMods.has('Meta'),
    });
  };
  const down = (key) => target.dispatchEvent(keyEvent('keydown', key));
  const up = (key) => target.dispatchEvent(keyEvent('keyup', key));

  for (const m of modsDown) {
    activeMods.add(m);
    down(m);
    if (gapMs) await sleep(gapMs);
  }
  for (const k of sequence) {
    down(k);
    if (holdMs) await sleep(holdMs);
    up(k);
    if (gapMs) await sleep(gapMs);
  }
  // modifiers come up in reverse, so the shortcut reads as one gesture
  for (const m of [...modsDown].reverse()) {
    activeMods.delete(m);
    up(m);
    if (gapMs) await sleep(gapMs);
  }
  // typing into a field is expected to change its value, which dispatchEvent alone does not do
  if (sequence.length && modsDown.length === 0) {
    for (const k of sequence) {
      if (k.length === 1) insertCharAtCursor(target, k);
    }
  }
  return { method: 'key-sequence', keys: list, mods: modsDown };
}

function insertCharAtCursor(el, ch) {
  if (!el || typeof el.value !== 'string') return;
  if (el.tagName === 'INPUT' && ['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'color', 'range'].includes((el.type || '').toLowerCase())) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const next = `${el.value.slice(0, start)}${ch}${el.value.slice(end)}`;
  setNativeValue(el, next);
  try { el.setSelectionRange(start + ch.length, start + ch.length); } catch { /* not a text field */ }
  fireInput(el, ch);
}

function normalizeKeyName(key) {
  const k = String(key).toLowerCase();
  const named = {
    enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape',
    space: ' ', spacebar: ' ', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
    home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  };
  if (named[k]) return named[k];
  if (/^f\d{1,2}$/.test(k)) return k.toUpperCase();
  return String(key);
}

function keyCodeName(key) {
  const k = String(key).toLowerCase();
  const codes = {
    enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape',
    space: 'Space', spacebar: 'Space', backspace: 'Backspace', delete: 'Delete',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  };
  if (codes[k]) return codes[k];
  if (/^f\d{1,2}$/.test(k)) return `F${k.slice(1)}`;
  if (k.length === 1 && /[a-z]/i.test(k)) return `Key${k.toUpperCase()}`;
  if (k.length === 1 && /\d/.test(k)) return `Digit${k}`;
  return String(key);
}

export { findElement, FinderError, isVisible, describeElement, sleep };
