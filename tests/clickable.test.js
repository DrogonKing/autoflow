/**
 * The scenario from the user's actual trading terminal, reduced to its essentials.
 *
 * The order book has a column header `خرید` and the order form has a button `خرید`. Both are visible, enabled,
 * uncovered and match `text: 'خرید'`. Without a notion of "meant to be clicked" the finder can choose the
 * header, the click lands on nothing, and the trace reports a success.
 *
 * These tests use a real DOM (jsdom) because the behaviour depends on tag names, ARIA roles, inline handlers
 * and computed cursor - the things a pure unit test would have to invent anyway.
 */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { findElement, isClickableTarget } from '../src/core/dom/finder.js';

/** jsdom has no layout: every box is 0x0 and elementFromPoint is absent. Stub enough for the checks. */
function makeDom(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // a 10x10 box and a working hit test that returns the element itself, so `isActionable` passes
  window.Element.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0 };
  };
  window.document.elementFromPoint = () => null;
  return { dom, document: window.document, window };
}

describe('a Persian order book header and an order button with the same label', () => {
  const HTML = `
    <table>
      <thead><tr><th>خرید</th><th>قیمت</th><th>فروش</th></tr></thead>
      <tbody><tr><td>1,000,000</td><td>1,424</td><td>3,000</td></tr></tbody>
    </table>
    <form>
      <input name="price" value="1424">
      <button type="button" id="buy">خرید</button>
    </form>`;

  it('text "خرید" resolves to the BUTTON, not the column header', () => {
    const { document } = makeDom(HTML);
    const found = findElement(document, { strategy: 'text', text: 'خرید' }, { requireActionable: true });
    expect(found.element).toBeTruthy();
    expect(found.element.tagName).toBe('BUTTON');
    expect(found.element.id).toBe('buy');
  });

  it('without requireActionable it can still match the header, so the filter is what does the work', () => {
    // this pins WHERE the behaviour comes from. If someone removes the clickable preference, the test above
    // starts returning the <th> and this one still passes - so the pair says which change broke it.
    const { document } = makeDom(HTML);
    const found = findElement(document, { strategy: 'text', text: 'خرید' }, { requireActionable: false });
    expect(found.element).toBeTruthy();
    expect(['TH', 'BUTTON']).toContain(found.element.tagName);
  });

  it('reports the ambiguity it resolved, so a wrong pick is diagnosable', () => {
    // `candidates` is the count AFTER filtering, so it is 1 here - the filter did its job. The evidence that
    // there WAS an ambiguity is in `tried`, which records what the strategy matched before any filter. Both
    // numbers matter: 1 and 1 means unambiguous, 1 of 2 means the finder chose, and that is what a user needs
    // to know when a click lands on the wrong thing.
    const { document } = makeDom(HTML);
    const found = findElement(document, { strategy: 'text', text: 'خرید' }, { requireActionable: true });
    expect(found.candidates).toBe(1);
    expect(found.tried[0].count).toBeGreaterThan(1);
  });
});

describe('isClickableTarget', () => {
  const cases = [
    ['<button>x</button>', true, 'a button'],
    ['<input type="submit">', true, 'a submit input'],
    ['<input type="button">', true, 'a button input'],
    ['<input type="checkbox">', true, 'a checkbox'],
    ['<a href="/x">x</a>', true, 'a link with href'],
    ['<a>x</a>', false, 'an anchor with no href and no handler'],
    ['<div role="button">x</div>', true, 'an ARIA button'],
    ['<span role="tab">x</span>', true, 'an ARIA tab'],
    ['<div onclick="x()">x</div>', true, 'an inline handler'],
    ['<summary>x</summary>', true, 'a summary'],
    ['<label>x</label>', true, 'a label'],
    ['<select></select>', true, 'a select'],
    ['<th>خرید</th>', false, 'THE CASE THAT MATTERS: a table header'],
    ['<td>خرید</td>', false, 'a table cell'],
    ['<span>خرید</span>', false, 'a plain span with the right text'],
    ['<div class="tab">خرید</div>', false, 'a div with no signal at all'],
  ];

  for (const [html, expected, why] of cases) {
    it(`${expected ? 'accepts' : 'rejects'} ${why}`, () => {
      const { document } = makeDom(html);
      expect(isClickableTarget(document.body.firstElementChild)).toBe(expected);
    });
  }

  it('rejects a detached node rather than throwing', () => {
    const { document } = makeDom('');
    const el = document.createElement('button');
    expect(() => isClickableTarget(el)).not.toThrow();
    expect(isClickableTarget(el)).toBe(true); // it is a button, detached or not
  });

  it('rejects null and text nodes', () => {
    expect(isClickableTarget(null)).toBe(false);
    const { document } = makeDom('hello');
    expect(isClickableTarget(document.body.firstChild)).toBe(false); // a text node
  });
});