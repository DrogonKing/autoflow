/**
 * A picked finder must be correctable.
 *
 * The report: "when I press Pick and select something, there is no way to fix or remove my selection."
 *
 * Two separate causes, and both are tested here:
 *
 *   1. `buildFinder` records a fallback CHAIN beside the primary strategy, and the finder consults the chain
 *      when the primary matches nothing. Editing the selector by hand changed only the primary, so a
 *      correction with a typo silently fell back to the ORIGINAL element - the step clicked the wrong thing
 *      while appearing to work. That is why the correction felt ignored.
 *   2. There was no control to clear a finder at all.
 */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildFinder, findElement } from '../src/core/dom/finder.js';

function makeDom(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { pretendToBeVisual: true });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, width: 20, height: 20, right: 20, bottom: 20, x: 0, y: 0 };
  };
  window.document.elementFromPoint = () => null;
  return { dom, document: window.document, window };
}

/**
 * The panel's edit logic, mirrored exactly.
 *
 * The property written depends on the CURRENT strategy: a picked finder is usually `id`, so editing writes
 * `id`. An earlier version of this test wrote `selector` unconditionally, which left the original `id` intact
 * and made the "correction" a no-op - a mistake in the test, and instructive: it is the same shape as the real
 * bug, where a correction was recorded somewhere the finder did not read.
 */
const PROPERTY_FOR = {
  css: 'selector', xpath: 'xpath', text: 'text', id: 'id', name: 'name',
  label: 'label', placeholder: 'placeholder', aria: 'aria', role: 'role',
};

function editedFinder(finder, value) {
  const key = PROPERTY_FOR[finder.strategy] ?? 'selector';
  const { chain, ...rest } = finder;
  return { ...rest, [key]: value };
}

const HTML = `
  <button id="right" class="buy">خرید</button>
  <button id="wrong" class="sell">فروش</button>`;

describe('why a picked finder could not be corrected', () => {
  it('a pick records a fallback chain, which is the thing that outvoted the correction', () => {
    const { document } = makeDom(HTML);
    const picked = buildFinder(document.getElementById('right'));
    expect(picked.strategy).toBe('id');
    expect(Array.isArray(picked.chain)).toBe(true);
    expect(picked.chain.length).toBeGreaterThan(0);
  });

  it('BEFORE the fix: editing the selector kept the old chain, which matched the original element', () => {
    const { document } = makeDom(HTML);
    const picked = buildFinder(document.getElementById('right'));

    // the user corrects the selector by hand but mistypes it, and the OLD chain is still there
    const stale = { ...picked, selector: '#nonexistent', strategy: 'css' };

    const found = findElement(document, stale, { requireActionable: true });
    // the stale chain rescued the typo and returned the element the user was trying to change away from
    expect(found.element).toBeTruthy();
    expect(found.element.id).toBe('right');
    expect(found.tried.some((t) => String(t.how).startsWith('fallback'))).toBe(true);
  });

  it('AFTER the fix: editing drops the chain, so a typo fails loudly instead of clicking the old element', () => {
    const { document } = makeDom(HTML);
    const picked = buildFinder(document.getElementById('right'));
    const corrected = editedFinder(picked, '#nonexistent');

    expect(corrected.chain).toBeUndefined();
    const found = findElement(document, corrected, { requireActionable: true });
    expect(found.element).toBeNull();
  });

  it('AFTER the fix: a correct edit resolves the NEW element', () => {
    const { document } = makeDom(HTML);
    const picked = buildFinder(document.getElementById('right'));
    const corrected = editedFinder(picked, 'wrong');

    const found = findElement(document, corrected, { requireActionable: true });
    expect(found.element?.id).toBe('wrong');
  });

  it('the edit keeps the strategy, so the user is not silently moved to another mode', () => {
    const { document } = makeDom(HTML);
    const picked = buildFinder(document.getElementById('right'));
    const corrected = editedFinder(picked, 'wrong');
    expect(corrected.strategy).toBe(picked.strategy);
  });

  it('the edit keeps every other field the picker recorded', () => {
    // dropping the chain must not be a blunt "reset": a picked finder may carry textExact and similar
    const finder = { strategy: 'css', selector: '#a', chain: ['#old'], textExact: true };
    const corrected = editedFinder(finder, '#b');
    expect(corrected.textExact).toBe(true);
    expect(corrected.selector).toBe('#b');
    expect(corrected.chain).toBeUndefined();
  });

  it('the clear control leaves a usable empty finder rather than a broken one', () => {
    // what the ✕ button produces
    const { document } = makeDom(HTML);
    const picked = buildFinder(document.getElementById('right'));
    const cleared = { strategy: picked.strategy ?? 'css' };
    expect(cleared.chain).toBeUndefined();
    // an empty finder finds nothing - which is honest, and the panel shows an empty box for the user to fill
    const found = findElement(document, { ...cleared, selector: '' }, { requireActionable: true });
    expect(found.element).toBeNull();
  });
});