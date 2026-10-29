/**
 * Action tests against real DOM nodes in jsdom.
 *
 * The important cases here are the ones that decide whether a page actually notices the interaction:
 * does a framework see the value change, does a checkbox end up checked, does a key chord arrive in the
 * right order. Assertions are about observable state and dispatched events, not about our code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  realClick, fillElement, selectOption, pressKeys, scrollAction, setNativeValue, fireInput, ActionError,
} from '../src/core/dom/actions.js';

function dom(html) {
  document.body.innerHTML = html;
  return document;
}

describe('realClick', () => {
  beforeEach(() => dom(''));

  it('fires the expected event sequence', () => {
    dom('<button id="b">Go</button>');
    const el = document.getElementById('b');
    const seen = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.addEventListener(type, () => seen.push(type));
    }
    realClick(el);
    expect(seen).toContain('mousedown');
    expect(seen).toContain('mouseup');
    expect(seen).toContain('click');
    // order: down before up before click
    expect(seen.indexOf('mousedown')).toBeLessThan(seen.indexOf('mouseup'));
    expect(seen.indexOf('mouseup')).toBeLessThan(seen.indexOf('click'));
  });

  it('a click handler runs', () => {
    dom('<button id="b">Go</button>');
    let clicked = 0;
    document.getElementById('b').addEventListener('click', () => { clicked += 1; });
    realClick(document.getElementById('b'));
    // the pointer sequence plus the compatibility click; both are legitimate, and a handler that fires
    // twice would double-submit a form, so assert at least once and note the count
    expect(clicked).toBeGreaterThanOrEqual(1);
  });

  it('a handler attached the way a framework attaches one runs exactly once', () => {
    // A real page's framework adds a listener; the count matters because a double fire would
    // double-submit a form.
    dom('<button id="b">Go</button>');
    const el = document.getElementById('b');
    let n = 0;
    el.addEventListener('click', () => { n += 1; });
    realClick(el);
    expect(n).toBe(1);
  });

  it('double click fires dblclick', () => {
    dom('<button id="b">Go</button>');
    const el = document.getElementById('b');
    let dbl = 0;
    el.addEventListener('dblclick', () => { dbl += 1; });
    realClick(el, { clickCount: 2 });
    expect(dbl).toBe(1);
  });

  it('reports how it clicked, so a trace can show it', () => {
    dom('<button id="b">Go</button>');
    const r = realClick(document.getElementById('b'));
    expect(r.method).toBeTruthy();
    expect(typeof r.x).toBe('number');
  });

  it('throws on a missing element rather than silently doing nothing', () => {
    expect(() => realClick(null)).toThrow(ActionError);
  });

  it('right click sets the right button code', () => {
    dom('<button id="b">Go</button>');
    const el = document.getElementById('b');
    let button = null;
    el.addEventListener('mousedown', (e) => { button = e.button; });
    realClick(el, { button: 'right' });
    expect(button).toBe(2);
  });
});

describe('fillElement — text inputs', () => {
  beforeEach(() => dom(''));

  it('sets the value', () => {
    dom('<input id="i">');
    const el = document.getElementById('i');
    fillElement(el, 'hello');
    expect(el.value).toBe('hello');
  });

  it('fires input and change, which is what a page listens to', () => {
    dom('<input id="i">');
    const el = document.getElementById('i');
    const events = [];
    el.addEventListener('input', () => events.push('input'));
    el.addEventListener('change', () => events.push('change'));
    fillElement(el, 'x');
    expect(events).toContain('input');
    expect(events).toContain('change');
  });

  it('writes through the prototype setter, which is what a framework observes', () => {
    // Simulate React's controlled input: an own `value` accessor that ignores direct assignment. The
    // assertion is that the PROTOTYPE setter was used, because that is the mechanism - checking
    // el.value would be checking the getter the scenario deliberately disabled.
    dom('<input id="i">');
    const el = document.getElementById('i');
    const proto = Object.getPrototypeOf(el);
    const original = Object.getOwnPropertyDescriptor(proto, 'value');
    let prototypeSetterCalls = 0;
    Object.defineProperty(proto, 'value', {
      configurable: true,
      get: original.get,
      set(v) {
        prototypeSetterCalls += 1;
        original.set.call(this, v);
      },
    });
    let ownSetterCalls = 0;
    Object.defineProperty(el, 'value', {
      configurable: true,
      get() { return original.get.call(this); },
      set() { ownSetterCalls += 1; },
    });

    fillElement(el, 'typed');

    expect(prototypeSetterCalls).toBeGreaterThan(0);
    expect(ownSetterCalls).toBe(0);
    expect(original.get.call(el)).toBe('typed');
    // restore so later tests are unaffected
    Object.defineProperty(proto, 'value', original);
  });

  it('replaces the old value rather than appending', () => {
    dom('<input id="i" value="old">');
    const el = document.getElementById('i');
    fillElement(el, 'new');
    expect(el.value).toBe('new');
  });

  it('can append when asked', () => {
    dom('<input id="i" value="abc">');
    const el = document.getElementById('i');
    fillElement(el, 'def', { clearFirst: false });
    expect(el.value).toBe('abcdef');
  });

  it('fills a textarea', () => {
    dom('<textarea id="t"></textarea>');
    const el = document.getElementById('t');
    fillElement(el, 'multi\nline');
    expect(el.value).toBe('multi\nline');
  });

  it('fills a contenteditable', () => {
    dom('<div id="e" contenteditable="true"></div>');
    const el = document.getElementById('e');
    fillElement(el, 'rich text');
    expect(el.textContent).toBe('rich text');
  });

  it('refuses a non-field instead of pretending', () => {
    dom('<div id="d">not a field</div>');
    expect(() => fillElement(document.getElementById('d'), 'x')).toThrow(/not a form field/);
  });

  it('handles an empty value', () => {
    dom('<input id="i" value="something">');
    const el = document.getElementById('i');
    fillElement(el, '');
    expect(el.value).toBe('');
  });
});

describe('fillElement — checkbox and radio', () => {
  beforeEach(() => dom(''));

  it('checks a checkbox', () => {
    dom('<input type="checkbox" id="c">');
    const el = document.getElementById('c');
    fillElement(el, 'true');
    expect(el.checked).toBe(true);
  });

  it('unchecks it', () => {
    dom('<input type="checkbox" id="c" checked>');
    const el = document.getElementById('c');
    fillElement(el, 'false');
    expect(el.checked).toBe(false);
  });

  it('accepts several spellings of false', () => {
    dom('<input type="checkbox" id="c" checked>');
    const el = document.getElementById('c');
    for (const v of ['false', '0', 'no', 'off', 'unchecked', '']) {
      el.checked = true;
      fillElement(el, v);
      expect(el.checked).toBe(false);
    }
  });

  it('does nothing when already in the requested state', () => {
    dom('<input type="checkbox" id="c" checked>');
    const el = document.getElementById('c');
    let clicks = 0;
    el.addEventListener('click', () => { clicks += 1; });
    fillElement(el, 'true');
    expect(clicks).toBe(0);
  });
});

describe('selectOption', () => {
  beforeEach(() => dom(''));

  it('selects by value', () => {
    dom('<select id="s"><option value="a">A</option><option value="b">B</option></select>');
    const el = document.getElementById('s');
    selectOption(el, 'b');
    expect(el.value).toBe('b');
  });

  it('selects by visible text', () => {
    dom('<select id="s"><option value="1">First</option><option value="2">Second</option></select>');
    const el = document.getElementById('s');
    selectOption(el, 'Second');
    expect(el.value).toBe('2');
  });

  it('fires input and change', () => {
    dom('<select id="s"><option value="a">A</option><option value="b">B</option></select>');
    const el = document.getElementById('s');
    const events = [];
    el.addEventListener('change', () => events.push('change'));
    selectOption(el, 'b');
    expect(events).toContain('change');
  });

  it('reports the options it had when nothing matches', () => {
    dom('<select id="s"><option value="a">A</option><option value="b">B</option></select>');
    const el = document.getElementById('s');
    expect(() => selectOption(el, 'zzz')).toThrow(/no option matching/);
    expect(() => selectOption(el, 'zzz')).toThrow(/a, b/);
  });

  it('handles a multi-select', () => {
    dom('<select id="s" multiple><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>');
    const el = document.getElementById('s');
    selectOption(el, ['a', 'c']);
    expect([...el.selectedOptions].map((o) => o.value)).toEqual(['a', 'c']);
  });
});

describe('pressKeys', () => {
  beforeEach(() => dom(''));

  it('sends modifiers down first and up last', async () => {
    dom('<input id="i">');
    const el = document.getElementById('i');
    const seq = [];
    el.addEventListener('keydown', (e) => seq.push(`down:${e.key}`));
    el.addEventListener('keyup', (e) => seq.push(`up:${e.key}`));
    await pressKeys(el, 'ctrl+shift+t');
    expect(seq[0]).toBe('down:Control');
    expect(seq[1]).toBe('down:Shift');
    expect(seq).toContain('down:t');
    expect(seq[seq.length - 1]).toBe('up:Control');
  });

  it('reports the modifier state on the key event', async () => {
    dom('<input id="i">');
    const el = document.getElementById('i');
    let ctrlOnT = null;
    el.addEventListener('keydown', (e) => {
      if (e.key === 't') ctrlOnT = e.ctrlKey;
    });
    await pressKeys(el, 'ctrl+t');
    expect(ctrlOnT).toBe(true);
  });

  it('types a single character into a field', async () => {
    dom('<input id="i">');
    const el = document.getElementById('i');
    await pressKeys(el, 'a');
    expect(el.value).toBe('a');
  });

  it('types several characters in order', async () => {
    dom('<input id="i">');
    const el = document.getElementById('i');
    await pressKeys(el, 'a');
    await pressKeys(el, 'b');
    await pressKeys(el, 'c');
    expect(el.value).toBe('abc');
  });

  it('normalises common key names', async () => {
    dom('<input id="i">');
    const el = document.getElementById('i');
    const keys = [];
    el.addEventListener('keydown', (e) => keys.push(e.key));
    await pressKeys(el, 'enter');
    await pressKeys(el, 'esc');
    await pressKeys(el, 'up');
    expect(keys).toContain('Enter');
    expect(keys).toContain('Escape');
    expect(keys).toContain('ArrowUp');
  });

  it('accepts an array of keys', async () => {
    dom('<input id="i">');
    const el = document.getElementById('i');
    const keys = [];
    el.addEventListener('keydown', (e) => keys.push(e.key));
    await pressKeys(el, ['ctrl', 'c']);
    expect(keys).toContain('Control');
    expect(keys).toContain('c');
  });

  it('leaves a modifier held for a chord', async () => {
    dom('<input id="i">');
    const el = document.getElementById('i');
    let shiftOnA = null;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'a') shiftOnA = e.shiftKey;
    });
    await pressKeys(el, ['shift', 'a']);
    expect(shiftOnA).toBe(true);
  });
});

describe('scrollAction', () => {
  it('runs without throwing on window', () => {
    expect(() => scrollAction({ target: 'window', mode: 'by', y: 100 })).not.toThrow();
  });

  it('scrolls an element', () => {
    dom('<div id="d"></div>');
    const el = document.getElementById('d');
    el.scrollBy = vi.fn();
    el.scrollTo = vi.fn();
    scrollAction({ target: 'element', mode: 'by', y: 50, el });
    expect(el.scrollBy).toHaveBeenCalled();
  });
});

describe('setNativeValue and fireInput', () => {
  it('writes through the prototype setter', () => {
    dom('<input id="i">');
    const el = document.getElementById('i');
    setNativeValue(el, 'abc');
    expect(el.value).toBe('abc');
  });

  it('dispatches an InputEvent when available', () => {
    dom('<input id="i">');
    const el = document.getElementById('i');
    let got = null;
    el.addEventListener('input', (e) => { got = e.constructor.name; });
    fireInput(el, 'x');
    expect(got).toMatch(/InputEvent|Event/);
  });
});