/**
 * Anchoring a picked element to the nearest ancestor that identifies it.
 *
 * THE PROBLEM THIS SOLVES, in the user's words: pick the buy button in a floating order window, drag the window
 * elsewhere, open a second order at the old position - and a selector built from sibling order clicks the wrong
 * window. Measured before this module existed:
 *
 *   window A: html > body > div:nth-of-type(1) > div:nth-of-type(2) > button:nth-of-type(1)
 *   window B: html > body > div:nth-of-type(2) > div:nth-of-type(2) > button:nth-of-type(1)
 *
 * The two differ only in a position, which is the least stable thing about a draggable window. But such windows
 * nearly always DO identify themselves - `data-symbol="فزر"`, `<div class="order-win" data-symbol="شستا">` - and
 * that attribute does not change when the window moves. Anchoring to it turns a positional selector into an
 * identifying one.
 *
 * THE RULE, and the reason it is a separate module: this walks UP from the element looking for a unique,
 * value-carrying attribute, and then builds the rest of the path from that anchor downwards. It is pure DOM
 * arithmetic with no browser APIs, so the behaviour is provable without a page.
 */

/**
 * Attributes that identify a thing rather than describe its appearance.
 *
 * Deliberately excludes `class` (a design token, often shared by every instance - `order-win` on all ten windows)
 * and excludes generated React/DOM ids, which change between renders and would make a saved selector rot.
 */
const IDENTIFYING = [
  'data-symbol', 'data-code', 'data-id', 'data-key', 'data-instrument', 'data-instrument-id',
  'data-order-id', 'data-testid', 'data-name', 'data-title', 'data-row-key', 'name', 'aria-label', 'for',
];

/** Values that identify nothing even though the attribute looks right: shared, empty, or generated per render. */
function isUsefulValue(attr, value) {
  if (!value) return false;
  if (value.length > 80) return false;
  // React's internal ids and anything that looks like a build hash / counter
  if (/^(react-|:r[0-9a-z]+:|ember\d+|ext-gen\d+)/i.test(value)) return false;
  if (/^[0-9a-f]{8,}$/i.test(value) && attr !== 'data-code') return false;
  /**
   * A bare number is only an identifier for the attributes whose whole purpose is one.
   *
   * `data-id` was accepted before this, because its name contains "id" - but a bare number in a generated page is
   * very often an index, and an index changes whenever the list it indexes changes. `data-code` and `data-symbol`
   * are instrument codes and are stable, so they keep numbers.
   */
  if (/^\d+$/.test(value) && !/symbol|code|instrument/i.test(attr)) return false;
  return true;
}

/** How many elements in the document match this selector. Used to accept an anchor only if it is unique. */
function countOf(doc, selector) {
  try {
    return doc.querySelectorAll(selector).length;
  } catch {
    return -1; // an invalid selector is not a candidate
  }
}

function cssEscapeValue(v) {
  // enough for attribute values: quotes and backslashes are what break an attribute selector
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Find the nearest ancestor (or the element itself) that carries a unique identifying attribute.
 *
 * @returns {{element: Element, selector: string, attr: string, value: string} | null}
 */
export function findAnchor(el, doc = el?.ownerDocument) {
  if (!el || el.nodeType !== 1) return null;
  let cur = el;
  let depth = 0;

  while (cur && cur.nodeType === 1 && depth < 12) {
    // an anchor on the document element or the body names the PAGE, not the thing inside it: a selector built from
    // it is positional all the way down while claiming to be anchored. Stop instead, so the caller falls back to a
    // positional path and says so honestly.
    if (cur === doc.documentElement || cur === doc.body) break;
    // an id is the best anchor there is, when it is unique and not generated
    const id = cur.getAttribute?.('id');
    if (id && /^[A-Za-z][\w-]*$/.test(id) && isUsefulValue('id', id) && countOf(doc, `#${id}`) === 1) {
      return { element: cur, selector: `#${id}`, attr: 'id', value: id };
    }

    // then any identifying data attribute with a unique, non-generated value
    for (const attr of IDENTIFYING) {
      const value = cur.getAttribute?.(attr);
      if (!value || !isUsefulValue(attr, value)) continue;
      const selector = `[${attr}="${cssEscapeValue(value)}"]`;
      if (countOf(doc, selector) === 1) {
        return { element: cur, selector, attr, value };
      }
    }

    // then any other data-* with a unique value, since many apps invent their own names
    for (const a of cur.attributes ?? []) {
      if (!a.name.startsWith('data-')) continue;
      /**
       * Vendor-generated attributes are skipped, but ANCHORED to the start of the name.
       *
       * The pattern used to be `/v-|ng-/` unanchored, so it matched those two characters ANYWHERE in the name and
       * silently discarded useful attributes: measured with the old pattern, `data-nav-id`, `data-dev-id`,
       * `data-pricing-plan`, `data-loading-key` and `data-setting-id` were all skipped, and a page using any of them
       * as its identifier simply could not be anchored.
       */
      if (/^(reactid|react-root|data-reactid|v-|ng-|aria-owns)/i.test(a.name)) continue;
      // the extension marks the document itself; anchoring to a marker on <html> produces a selector that is
      // positional all the way down while LOOKING anchored, which is worse than no anchor at all
      if (a.name.startsWith('data-autoflow-')) continue;
      if (!isUsefulValue(a.name, a.value)) continue;
      const selector = `[${a.name}="${cssEscapeValue(a.value)}"]`;
      if (countOf(doc, selector) === 1) {
        return { element: cur, selector, attr: a.name, value: a.value };
      }
    }

    cur = cur.parentElement;
    depth += 1;
  }
  return null;
}

/**
 * Walk from an anchor down to a target, building one selector per step.
 *
 * Each step uses the SHORTEST unambiguous form: the tag alone if it is the only one of that tag among its
 * siblings, otherwise `:nth-of-type`. The anchor is what makes the result position-independent across windows;
 * within one anchored subtree the order is stable because it is that window's own contents.
 *
 * @returns {string|null} `anchor > step > step`, or null if the target is not inside the anchor
 */
export function pathFromAnchor(anchorEl, targetEl) {
  if (!anchorEl || !targetEl) return null;
  const steps = [];
  let cur = targetEl;

  while (cur && cur !== anchorEl) {
    const parent = cur.parentElement;
    if (!parent) return null;
    const tag = cur.tagName.toLowerCase();
    const sameTag = [...parent.children].filter((c) => c.tagName === cur.tagName);
    steps.unshift(sameTag.length === 1 ? tag : `${tag}:nth-of-type(${sameTag.indexOf(cur) + 1})`);
    cur = parent;
    if (steps.length > 10) return null; // too deep to be worth trusting
  }

  if (cur !== anchorEl) return null; // the target is not a descendant of the anchor
  return steps.length ? steps.join(' > ') : null;
}

/**
 * The anchored selector for an element, or null when no anchor exists.
 *
 * Returned WITHOUT the anchor's own selector so the caller can decide how to combine them; `anchoredSelector`
 * composes the two.
 */
export function anchorChoice(targetEl, doc = targetEl?.ownerDocument) {
  const anchor = findAnchor(targetEl, doc);
  if (!anchor) return null;

  // the element IS the anchor: the selector is just the anchor
  if (anchor.element === targetEl) {
    return { selector: anchor.selector, anchor: { attr: anchor.attr, value: anchor.value }, depth: 0 };
  }

  const rest = pathFromAnchor(anchor.element, targetEl);
  if (!rest) return null;
  return {
    selector: `${anchor.selector} > ${rest}`,
    anchor: { attr: anchor.attr, value: anchor.value },
    depth: 0,
  };
}

/**
 * Build the best selector for a target, preferring an anchored one over a positional one.
 *
 * @returns {{selector: string, anchored: boolean, anchor: object|null, positional: string}}
 */
export function anchoredSelector(targetEl, positionalPath, doc = targetEl?.ownerDocument) {
  const choice = anchorChoice(targetEl, doc);
  if (choice) {
    const unique = countOf(doc, choice.selector) === 1;
    if (unique) {
      return { selector: choice.selector, anchored: true, anchor: choice.anchor, positional: positionalPath ?? '' };
    }
  }
  return { selector: positionalPath ?? '', anchored: false, anchor: null, positional: positionalPath ?? '' };
}