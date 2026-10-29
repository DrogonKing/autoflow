/**
 * Finding an element on a real page.
 *
 * Runs inside the content script, so it has the DOM. Kept as one module with no dependencies beyond the
 * DOM so it can be unit-tested with jsdom and exercised in a real browser by the same code path.
 *
 * Why several strategies rather than one selector: a single strategy never survives contact with real
 * pages. An `id` may be absent on one page and duplicated on another, a CSS path breaks after a deploy,
 * and the visible text is often the only thing that stays the same. The finder tries the user's chosen
 * strategy first and then falls back through a recorded chain, and it always reports *how* it resolved,
 * because "it clicked the wrong thing" is only debuggable if you can see what it matched.
 */

export class FinderError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'FinderError';
    this.detail = detail;
  }
}

/** Is the element in the layout and not hidden? Mirrors what a user would consider "there". */
/**
 * A zero-size box is how a real browser reports `display:none` and a detached element. It is NOT a
 * useful signal without layout, though: jsdom (used by the tests) computes no layout, so every element
 * measures 0x0 there and treating that as invisible would hide the entire page.
 */
const HAS_LAYOUT = typeof window !== 'undefined' &&
  typeof window.getComputedStyle === 'function' &&
  // jsdom implements getComputedStyle but reports no layout; this detects "a browser that lays out"
  (() => {
    try {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;width:10px;height:10px';
      document.body?.appendChild?.(probe);
      const measured = probe.getBoundingClientRect().width === 10;
      probe.remove?.();
      return measured;
    } catch {
      return false;
    }
  })();

export function isVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const rect = el.getBoundingClientRect();
  if (HAS_LAYOUT && rect.width === 0 && rect.height === 0) return false;
  const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
  if (style) {
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (Number(style.opacity) === 0) return false;
  }
  return true;
}

/**
 * An element is "actionable" if a user could click it: visible, not disabled, and not covered by an
 * overlay. The last check is what stops an automation clicking into a cookie banner.
 */
/**
 * Is this the kind of element a person would click, or just an element with the right text?
 *
 * WHY THIS EXISTS. A Persian trading terminal shows a column header `خرید` above the order book and an action
 * button `خرید` under the form. A `text` strategy matching "خرید" satisfies every existing check - it is
 * visible, not disabled, not covered - so the header could be chosen and the click would do nothing while the
 * trace reported success. `isActionable` answers "could a click reach it"; this answers "was it meant to be
 * clicked".
 *
 * Deliberately permissive about HOW: a <button>, a submit input, a link with an href, an ARIA button role, an
 * inline handler, or a cursor:pointer style all count. Being strict here would break the many apps that use a
 * <div> with an onclick, which is common in exactly this kind of terminal.
 */
export function isClickableTarget(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'button') return true;
  if (tag === 'a') return !!(el.getAttribute('href') || el.hasAttribute('onclick'));
  if (tag === 'input') {
    const type = String(el.getAttribute('type') || 'text').toLowerCase();
    return ['button', 'submit', 'reset', 'image', 'checkbox', 'radio'].includes(type);
  }
  if (tag === 'select' || tag === 'textarea') return true;
  if (tag === 'summary' || tag === 'label') return true;
  const role = String(el.getAttribute('role') || '').toLowerCase();
  if (role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab' || role === 'option') {
    return true;
  }
  if (el.hasAttribute && (el.hasAttribute('onclick') || el.hasAttribute('onmousedown'))) return true;
  // JS frameworks often attach the handler instead of an attribute, so a pointer cursor is the remaining
  // honest signal that a human is meant to click this
  try {
    const w = el.ownerDocument?.defaultView;
    if (w && w.getComputedStyle(el).cursor === 'pointer') return true;
  } catch {
    // a detached or sandboxed element: no computed style, and no claim to make
  }
  return false;
}

export function isActionable(el) {
  if (!el) return false;
  if (el.disabled === true) return false;
  if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
  if (!isVisible(el)) return false;
  const rect = el.getBoundingClientRect();
  const doc = el.ownerDocument;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  if (cx < 0 || cy < 0 || cx > (doc.defaultView?.innerWidth ?? Infinity) ||
      cy > (doc.defaultView?.innerHeight ?? Infinity)) {
    // offscreen is still actionable for most actions (scrollIntoView first), so this is not a rejection
    return true;
  }
  const top = doc.elementFromPoint(cx, cy);
  if (!top) return true;
  if (top === el || el.contains(top) || top.contains(el)) return true;
  // A transparent overlay is a real cause of "the click did nothing"
  return false;
}

/** Accessible name, the way a screen reader would compute it (the useful subset). */
export function accessibleName(el) {
  if (!el) return '';
  const aria = el.getAttribute?.('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const labelledBy = el.getAttribute?.('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  if (el.labels && el.labels.length) {
    const text = [...el.labels].map((l) => l.textContent?.trim() ?? '').filter(Boolean).join(' ');
    if (text) return text;
  }
  const title = el.getAttribute?.('title');
  if (title && title.trim()) return title.trim();
  if (el.tagName === 'IMG') return el.getAttribute('alt')?.trim() ?? '';
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------------------------
// strategies
// ---------------------------------------------------------------------------------------------

function queryAll(root, selector) {
  try {
    return [...root.querySelectorAll(selector)];
  } catch (e) {
    throw new FinderError(`the CSS selector "${selector}" is invalid: ${e.message}`, { selector });
  }
}

/** The document a root belongs to. `root.ownerDocument` is null when root IS the document. */
function documentOf(root) {
  if (!root) return document;
  if (root.nodeType === 9) return root;            // a Document
  return root.ownerDocument ?? document;
}

function byXPath(root, expr) {
  const doc = documentOf(root);
  let result;
  try {
    result = doc.evaluate(expr, root, null, doc.defaultView.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  } catch (e) {
    throw new FinderError(`the XPath "${expr}" is invalid: ${e.message}`, { xpath: expr });
  }
  const out = [];
  for (let i = 0; i < result.snapshotLength; i++) out.push(result.snapshotItem(i));
  return out.filter((n) => n.nodeType === 1);
}

function textCandidates(root, text, exact) {
  const needle = (text ?? '').trim();
  if (!needle) return [];
  const wanted = exact ? needle : needle.toLowerCase();
  const all = [...root.querySelectorAll(
    'a,button,input,select,textarea,label,span,div,p,li,td,th,h1,h2,h3,h4,h5,h6,summary,[role],[onclick],[tabindex]',
  )];
  const matches = all.filter((el) => {
    const own = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!own) {
      // an input has no text; its value or placeholder is the visible label
      const v = el.value ?? el.getAttribute('placeholder') ?? '';
      return exact ? v.trim() === needle : v.toLowerCase().includes(wanted);
    }
    return exact ? own === needle : own.toLowerCase().includes(wanted);
  });
  // Prefer the deepest match: a wrapper div contains the text of its button, and clicking the wrapper is
  // usually the wrong element.
  return matches.sort((a, b) => {
    const da = depth(a);
    const db = depth(b);
    if (da !== db) return db - da;
    return (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0);
  });
}

function depth(el) {
  let n = 0;
  let cur = el;
  while (cur?.parentElement) {
    n += 1;
    cur = cur.parentElement;
  }
  return n;
}

/** The elements a form label can point at. */
function labelTargets(root, labelText, exact) {
  const wanted = exact ? labelText.trim() : (labelText ?? '').trim().toLowerCase();
  const out = [];
  for (const label of root.querySelectorAll('label')) {
    const own = (label.textContent ?? '').replace(/\s+/g, ' ').trim();
    const hit = exact ? own === labelText.trim() : own.toLowerCase().includes(wanted);
    if (!hit) continue;
    const forId = label.getAttribute('for');
    if (forId) {
    const target = documentOf(label).getElementById(forId);
      if (target) out.push(target);
      continue;
    }
    const nested = label.querySelector('input,select,textarea,button');
    if (nested) out.push(nested);
  }
  return out;
}

/**
 * Resolve one strategy to a list of candidate elements.
 *
 * @returns {{elements: Element[], how: string}}
 */
export function resolveStrategy(root, finder) {
  const s = finder.strategy;
  switch (s) {
    case 'css':
      return { elements: queryAll(root, finder.selector), how: `css ${finder.selector}` };

    case 'xpath':
      return { elements: byXPath(root, finder.xpath), how: `xpath ${finder.xpath}` };

    case 'id': {
      const el = documentOf(root).getElementById(finder.id);
      return { elements: el ? [el] : [], how: `id #${finder.id}` };
    }

    case 'name': {
      const els = queryAll(root, `[name="${cssEscape(finder.name)}"]`);
      return { elements: els, how: `name ${finder.name}` };
    }

    case 'text': {
      const els = textCandidates(root, finder.text, finder.textExact === true);
      return { elements: els, how: `text "${finder.text}"${finder.textExact ? ' (exact)' : ''}` };
    }

    case 'label': {
      const els = labelTargets(root, finder.label, finder.textExact === true);
      return { elements: els, how: `label "${finder.label}"` };
    }

    case 'placeholder': {
      const els = queryAll(root, `[placeholder="${cssEscape(finder.placeholder)}"]`);
      return { elements: els, how: `placeholder "${finder.placeholder}"` };
    }

    case 'aria': {
      const els = queryAll(root, `[aria-label="${cssEscape(finder.aria)}"]`);
      return { elements: els, how: `aria-label "${finder.aria}"` };
    }

    case 'role': {
      const els = queryAll(root, `[role="${cssEscape(finder.role)}"]`)
        .filter((el) => !finder.roleName || accessibleName(el) === finder.roleName);
      return { elements: els, how: `role ${finder.role}${finder.roleName ? ` named "${finder.roleName}"` : ''}` };
    }

    case 'point': {
      const doc = documentOf(root);
      const el = doc.elementFromPoint?.(finder.x, finder.y) ?? null;
      return { elements: el ? [el] : [], how: `point (${finder.x}, ${finder.y})` };
    }

    case 'recorded': {
      // A recorded chain: try each in order and take the first that resolves to something visible.
      const chain = finder.chain?.length ? finder.chain : [];
      for (const sel of chain) {
        try {
          const els = queryAll(root, sel).filter(isVisible);
          if (els.length) return { elements: els, how: `recorded ${sel}` };
        } catch {
          // a chain entry that no longer parses is skipped rather than fatal: that is the point of a chain
        }
      }
      return { elements: [], how: 'recorded chain (nothing matched)' };
    }

    default:
      throw new FinderError(`unknown finder strategy ${JSON.stringify(s)}`, { finder });
  }
}

/** Escape a value for use inside an attribute selector. */
function cssEscape(value) {
  return String(value).replace(/(["\\])/g, '\\$1');
}

/**
 * Find the element a step should act on.
 *
 * @param {Document|ShadowRoot|Element} root
 * @param {Object} finder
 * @param {{requireVisible?: boolean, requireActionable?: boolean}} [opts]
 * @returns {{element: Element|null, how: string, candidates: number}}
 */
export function findElement(root, finder, opts = {}) {
  const requireVisible = opts.requireVisible !== false;
  const requireActionable = opts.requireActionable === true;

  const tried = [];
  const { elements: primary, how } = resolveStrategy(root, finder);
  tried.push({ how, count: primary.length });

  let pool = primary;
  if (pool.length === 0 && Array.isArray(finder.chain) && finder.chain.length) {
    // the primary strategy missed: fall back through the chain
    for (const sel of finder.chain) {
      try {
        const els = queryAll(root, sel);
        tried.push({ how: `fallback ${sel}`, count: els.length });
        if (els.length) {
          pool = els;
          break;
        }
      } catch {
        tried.push({ how: `fallback ${sel}`, count: 0 });
      }
    }
  }

  let candidates = pool;
  if (requireVisible) {
    const visible = candidates.filter(isVisible);
    // Only apply the visibility filter when it leaves something: a hidden element may be exactly what
    // the step needs (a hidden input is the normal case for a form fill).
    if (visible.length) candidates = visible;
  }

  if (candidates.length === 0) {
    return { element: null, how, candidates: 0, tried };
  }

  let chosen = candidates;
  if (requireActionable) {
    const actionable = chosen.filter(isActionable);
    if (actionable.length) chosen = actionable;

    // Then prefer things that are meant to be clicked. Same defensive shape as the visibility filter above:
    // narrow only when narrowing leaves something, so a page that puts its handler on a bare <div> still
    // works - it just loses the preference, not the match.
    //
    // This is what stops `text: 'خرید'` from selecting the order book's column header instead of the buy
    // button. Without it the header is a valid candidate: visible, enabled, uncovered.
    const clickable = chosen.filter(isClickableTarget);
    if (clickable.length) chosen = clickable;
  }

  const index = finder.index ?? 0;
  if (index >= chosen.length) {
    throw new FinderError(
      `the finder matched ${chosen.length} element(s) but index ${index} was requested`,
      { how, count: chosen.length, index, tried },
    );
  }

  return { element: chosen[index], how, candidates: chosen.length, tried };
}

/**
 * A stable-ish CSS path to an element, recorded when the user picks or clicks one.
 *
 * The point is to build something that survives as long as possible: prefer an id, then a data attribute,
 * then a short structural path. Every candidate is checked for uniqueness before being accepted, because
 * a selector that matches three elements is worse than a longer one that matches exactly one.
 */
export function cssPath(el, doc = el.ownerDocument) {
  if (!el || el.nodeType !== 1) return '';
  const parts = [];
  let cur = el;
  const distinct = (sel) => {
    try {
      return doc.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };

  while (cur && cur.nodeType === 1 && parts.length < 8) {
    const id = cur.getAttribute?.('id');
    if (id && /^[A-Za-z][\w-]*$/.test(id) && distinct(`#${id}`)) {
      parts.unshift(`#${id}`);
      break;
    }
    // data attributes are usually stable and are the best signal on a component-built page
    const dataAttrs = [...(cur.attributes ?? [])].filter(
      (a) => a.name.startsWith('data-') && !a.name.startsWith('data-reactid') && a.value && a.value.length < 60,
    );
    const stable = dataAttrs.find((a) => distinct(`[${a.name}="${cssEscape(a.value)}"]`));
    if (stable) {
      parts.unshift(`${cur.tagName.toLowerCase()}[${stable.name}="${cssEscape(stable.value)}"]`);
      break;
    }

    const tag = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const sameTag = [...parent.children].filter((c) => c.tagName === cur.tagName);
    if (sameTag.length === 1) {
      parts.unshift(tag);
    } else {
      const nth = sameTag.indexOf(cur) + 1;
      parts.unshift(`${tag}:nth-of-type(${nth})`);
    }
    // an id on an ancestor makes the rest of the path anchored
    const parentId = parent.getAttribute?.('id');
    if (parentId && /^[A-Za-z][\w-]*$/.test(parentId) && distinct(`#${parentId}`)) {
      parts.unshift(`#${parentId}`);
      break;
    }
    cur = parent;
  }

  return parts.join(' > ');
}

/**
 * Describe an element the way the picker UI shows it: enough to recognise, not a dump.
 */
export function describeElement(el) {
  if (!el || el.nodeType !== 1) return null;
  const rect = el.getBoundingClientRect?.() ?? { x: 0, y: 0, width: 0, height: 0 };
  const attrs = {};
  for (const a of el.attributes ?? []) {
    if (['style', 'class'].includes(a.name)) continue;
    if (a.value.length > 120) continue;
    attrs[a.name] = a.value;
  }
  return {
    tag: el.tagName.toLowerCase(),
    id: el.getAttribute?.('id') ?? '',
    name: el.getAttribute?.('name') ?? '',
    type: el.getAttribute?.('type') ?? '',
    classes: [...(el.classList ?? [])].slice(0, 8),
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    value: typeof el.value === 'string' ? el.value.slice(0, 160) : '',
    placeholder: el.getAttribute?.('placeholder') ?? '',
    ariaLabel: el.getAttribute?.('aria-label') ?? '',
    role: el.getAttribute?.('role') ?? '',
    accessibleName: accessibleName(el).slice(0, 160),
    attributes: attrs,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    inIframe: el.ownerDocument !== el.ownerDocument.defaultView?.top?.document,
  };
}

/**
 * Build a finder for a picked element, with a fallback chain.
 *
 * The order encodes what tends to survive a redesign: id, then name, then a data attribute, then the
 * accessible label, then a structural path, then the visible text. The text is last because it is the
 * most fragile to a copy change but the most likely to be unique.
 */
export function buildFinder(el) {
  const doc = el.ownerDocument;
  const chain = [];
  const id = el.getAttribute?.('id');
  if (id && /^[A-Za-z][\w-]*$/.test(id)) {
    try {
      if (doc.querySelectorAll(`#${id}`).length === 1) chain.push(`#${id}`);
    } catch { /* ignore */ }
  }
  const name = el.getAttribute?.('name');
  if (name) chain.push(`${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`);
  const dataAttr = [...(el.attributes ?? [])].find(
    (a) => a.name.startsWith('data-') && !a.name.startsWith('data-reactid') && a.value && a.value.length < 60,
  );
  if (dataAttr) chain.push(`[${dataAttr.name}="${cssEscape(dataAttr.value)}"]`);
  if (el.getAttribute?.('aria-label')) chain.push(`[aria-label="${cssEscape(el.getAttribute('aria-label'))}"]`);
  const path = cssPath(el, doc);
  if (path) chain.push(path);
  const label = accessibleName(el);
  if (label && label.length < 80) chain.push(null); // text fallback is separate from CSS

  // The primary strategy: prefer a unique id, else the structural path, else the text.
  if (chain[0]?.startsWith('#')) {
    return { strategy: 'id', id: id, chain: chain.filter(Boolean) };
  }
  if (path) {
    return { strategy: 'css', selector: path, chain: chain.filter(Boolean) };
  }
  if (label) {
    return { strategy: 'text', text: label.slice(0, 120), textExact: false, chain: chain.filter(Boolean) };
  }
  return { strategy: 'css', selector: 'body', chain: chain.filter(Boolean) };
}
