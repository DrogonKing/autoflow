/**
 * Anchoring a picked element to something that identifies it.
 *
 * These tests encode the desk behaviour that prompted the feature. A floating order window is dragged away and a
 * new order opened where it used to be; the picker had recorded `div:nth-of-type(1) > ... > button`, which follows
 * the POSITION and therefore clicks the new window. Anchoring to `data-symbol` (or an id, or any unique
 * identifying attribute) makes the selector follow the THING.
 *
 * The negative cases matter as much as the positive ones: an anchor must be refused when it identifies nothing,
 * because a selector that merely LOOKS anchored is worse than one that admits it is positional.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { anchoredSelector, anchorChoice, findAnchor, pathFromAnchor } from '../src/core/dom/anchor.js';

let doc;

function load(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  doc = dom.window.document;
  return doc;
}

/** Two floating order windows, as the terminal draws them. */
const TWO_WINDOWS = `
  <div class="order-win" data-symbol="فزر">
    <div class="title">فزر — خرید</div>
    <div class="body"><button class="buy">خرید</button><button class="sell">فروش</button></div>
  </div>
  <div class="order-win" data-symbol="شستا">
    <div class="title">شستا — خرید</div>
    <div class="body"><button class="buy">خرید</button><button class="sell">فروش</button></div>
  </div>`;

describe('finding an anchor', () => {
  it('anchors to the symbol attribute on the window', () => {
    load(TWO_WINDOWS);
    const buy = doc.querySelectorAll('.buy')[0];
    const anchor = findAnchor(buy, doc);
    expect(anchor).not.toBeNull();
    expect(anchor.selector).toBe('[data-symbol="فزر"]');
    expect(anchor.attr).toBe('data-symbol');
  });

  it('the two windows give DIFFERENT anchors, which is the whole point', () => {
    load(TWO_WINDOWS);
    const [a, b] = [...doc.querySelectorAll('.buy')];
    expect(findAnchor(a, doc).selector).toBe('[data-symbol="فزر"]');
    expect(findAnchor(b, doc).selector).toBe('[data-symbol="شستا"]');
  });

  it('prefers a unique id over a data attribute', () => {
    load('<div id="order-7" data-symbol="فزر"><button class="buy">خرید</button></div>');
    const anchor = findAnchor(doc.querySelector('.buy'), doc);
    expect(anchor.selector).toBe('#order-7');
    expect(anchor.attr).toBe('id');
  });

  it('refuses an id that is not unique', () => {
    // duplicated ids are common in generated pages; a selector on one would match several elements
    load('<div id="win"><button class="buy">a</button></div><div id="win"><button class="buy">b</button></div>');
    const anchor = findAnchor(doc.querySelector('.buy'), doc);
    expect(anchor?.attr).not.toBe('id');
  });

  it('refuses a generated React id', () => {
    load('<div data-reactid=".0.1" id=":r1:"><button class="buy">خرید</button></div>');
    const anchor = findAnchor(doc.querySelector('.buy'), doc);
    expect(anchor).toBeNull();
  });

  it('refuses a numeric data-id that identifies nothing stable', () => {
    // a bare number in data-id is very often an index, which changes with the list
    load('<div data-id="3"><button class="buy">خرید</button></div>');
    const anchor = findAnchor(doc.querySelector('.buy'), doc);
    expect(anchor).toBeNull();
  });

  it('accepts a numeric data-code, because codes are stable identifiers', () => {
    load('<div data-code="12345"><button class="buy">خرید</button></div>');
    const anchor = findAnchor(doc.querySelector('.buy'), doc);
    expect(anchor.selector).toBe('[data-code="12345"]');
  });

  it('NEVER anchors to the document or the body', () => {
    // this is the silent-failure case: an anchor on <html> produces a selector that is positional all the way down
    // while reporting itself as anchored, which is worse than admitting it is positional
    load('<div class="win"><button class="buy">خرید</button><button class="buy">فروش</button></div>');
    doc.documentElement.setAttribute('data-autoflow-content', '1.6.0');
    doc.body.setAttribute('data-something', 'x');
    const anchor = findAnchor(doc.querySelector('.buy'), doc);
    expect(anchor).toBeNull();
  });

  it('ignores the extension\'s own document marker', () => {
    load('<div class="win"><button class="buy">خرید</button></div>');
    doc.documentElement.setAttribute('data-autoflow-content', '1.6.0');
    expect(findAnchor(doc.querySelector('.buy'), doc)).toBeNull();
  });

  it('walks up to a distant ancestor when the nearer ones carry nothing', () => {
    load('<section data-instrument="IRO1FZRZ0001"><div><div><span><button class="buy">خرید</button></span></div></div></section>');
    const anchor = findAnchor(doc.querySelector('.buy'), doc);
    expect(anchor.selector).toBe('[data-instrument="IRO1FZRZ0001"]');
  });

  it('returns null when there is genuinely nothing to anchor to', () => {
    load('<div class="win"><div class="body"><button class="buy">خرید</button></div></div>');
    expect(findAnchor(doc.querySelector('.buy'), doc)).toBeNull();
  });

  it('handles a missing element without throwing', () => {
    load('<div></div>');
    expect(findAnchor(null, doc)).toBeNull();
    expect(findAnchor(undefined, doc)).toBeNull();
  });
});

describe('the path from an anchor down to the target', () => {
  it('uses the tag alone when it is the only one of its kind', () => {
    load('<div data-symbol="فزر"><div class="body"><button class="buy">خرید</button></div></div>');
    const anchorEl = doc.querySelector('[data-symbol]');
    const buy = doc.querySelector('.buy');
    expect(pathFromAnchor(anchorEl, buy)).toBe('div > button');
  });

  it('uses nth-of-type when siblings share the tag', () => {
    load('<div data-symbol="فزر"><div class="body"><button class="buy">خرید</button><button class="sell">فروش</button></div></div>');
    const anchorEl = doc.querySelector('[data-symbol]');
    expect(pathFromAnchor(anchorEl, doc.querySelector('.sell'))).toBe('div > button:nth-of-type(2)');
  });

  it('is null when the target is not inside the anchor', () => {
    load('<div data-symbol="a"><button class="buy">x</button></div><div data-symbol="b"><button class="buy">y</button></div>');
    const anchors = [...doc.querySelectorAll('[data-symbol]')];
    expect(pathFromAnchor(anchors[0], doc.querySelectorAll('.buy')[1])).toBeNull();
  });

  it('is null for a missing target', () => {
    load('<div data-symbol="a"><button>x</button></div>');
    expect(pathFromAnchor(doc.querySelector('[data-symbol]'), null)).toBeNull();
  });
});

describe('the anchored selector as the caller sees it', () => {
  it('reports itself as anchored, with the attribute that did it', () => {
    load(TWO_WINDOWS);
    const buy = doc.querySelectorAll('.buy')[0];
    const chosen = anchoredSelector(buy, 'body > div:nth-of-type(1)', doc);
    expect(chosen.anchored).toBe(true);
    expect(chosen.anchor).toEqual({ attr: 'data-symbol', value: 'فزر' });
    expect(chosen.selector).toContain('[data-symbol="فزر"]');
  });

  it('the result matches exactly one element', () => {
    load(TWO_WINDOWS);
    const buy = doc.querySelectorAll('.buy')[0];
    const chosen = anchoredSelector(buy, '', doc);
    expect(doc.querySelectorAll(chosen.selector)).toHaveLength(1);
    expect(doc.querySelector(chosen.selector)).toBe(buy);
  });

  it('THE SWAP: the anchored selector still matches the original button after a new window takes its place', () => {
    load(TWO_WINDOWS);
    const first = doc.querySelectorAll('.order-win')[0];
    const buy = first.querySelector('.buy');
    const chosen = anchoredSelector(buy, '', doc);

    // the user drags the first window away and opens a new order where it was
    first.style.left = '900px';
    const replacement = doc.createElement('div');
    replacement.className = 'order-win';
    replacement.setAttribute('data-symbol', 'خودرو');
    replacement.innerHTML = '<div class="title">خودرو</div><div class="body"><button class="buy">خرید</button></div>';
    doc.body.prepend(replacement);

    expect(doc.querySelector(chosen.selector)).toBe(buy);          // still the فزر button
    expect(doc.querySelector(chosen.selector)).not.toBe(replacement.querySelector('.buy'));
  });

  it('falls back to the positional path when there is nothing to anchor to, and SAYS so', () => {
    load('<div class="win"><div class="body"><button class="buy">خرید</button></div></div>');
    const chosen = anchoredSelector(doc.querySelector('.buy'), 'body > div > div > button', doc);
    expect(chosen.anchored).toBe(false);
    expect(chosen.anchor).toBeNull();
    expect(chosen.selector).toBe('body > div > div > button');
  });

  it('when the element IS the anchor, the selector is just the anchor', () => {
    load('<button class="buy" data-symbol="فزر">خرید</button>');
    const chosen = anchoredSelector(doc.querySelector('.buy'), 'body > button', doc);
    expect(chosen.anchored).toBe(true);
    expect(chosen.selector).toBe('[data-symbol="فزر"]');
  });

  it('an attribute value with a quote in it does not break the selector', () => {
    load('<div data-symbol=\'a"b\'><button class="buy">خرید</button></div>');
    const chosen = anchoredSelector(doc.querySelector('.buy'), '', doc);
    expect(() => doc.querySelectorAll(chosen.selector)).not.toThrow();
    expect(doc.querySelector(chosen.selector)).toBe(doc.querySelector('.buy'));
  });
});

describe('the byte-identical windows where no selector can help', () => {
  beforeEach(() => {
    load('<div class="order-win"><div class="t"></div><div class="b"><button>خرید</button></div></div>'
      + '<div class="order-win"><div class="t"></div><div class="b"><button>خرید</button></div></div>');
  });

  it('cannot be anchored, because there is nothing to anchor to', () => {
    for (const btn of doc.querySelectorAll('button')) {
      expect(findAnchor(btn, doc)).toBeNull();
    }
  });

  it('so each is positional, and each is unique only by position', () => {
    const [a, b] = [...doc.querySelectorAll('button')];
    const first = anchoredSelector(a, 'body > div:nth-of-type(1) > div:nth-of-type(2) > button', doc);
    const second = anchoredSelector(b, 'body > div:nth-of-type(2) > div:nth-of-type(2) > button', doc);
    expect(first.anchored).toBe(false);
    expect(second.anchored).toBe(false);
    expect(first.selector).not.toBe(second.selector);
  });
});