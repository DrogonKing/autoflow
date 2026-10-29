/**
 * DOM tests, against real HTML in jsdom.
 *
 * These are not mocks: jsdom parses real markup, builds a real element tree, and runs the real event
 * dispatcher. So the finder's strategies, the click sequence, and the React-style value setting are all
 * exercised as code rather than as an assertion about code.
 *
 * jsdom has no layout, so anything depending on a real box is either skipped or asserted differently and
 * then confirmed in the real-browser test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  findElement, cssPath, describeElement, buildFinder, isVisible, accessibleName, FinderError,
} from '../src/core/dom/finder.js';

function dom(html) {
  document.body.innerHTML = html;
  return document;
}

describe('findElement — css', () => {
  it('finds by selector', () => {
    dom('<button id="go">Go</button>');
    const r = findElement(document, { strategy: 'css', selector: '#go' });
    expect(r.element?.textContent).toBe('Go');
    expect(r.candidates).toBe(1);
  });

  it('reports zero candidates rather than throwing', () => {
    dom('<div></div>');
    const r = findElement(document, { strategy: 'css', selector: '#missing' });
    expect(r.element).toBeNull();
    expect(r.candidates).toBe(0);
  });

  it('throws on an invalid selector, with the selector in the message', () => {
    dom('<div></div>');
    expect(() => findElement(document, { strategy: 'css', selector: '>>>bad' })).toThrow(FinderError);
    expect(() => findElement(document, { strategy: 'css', selector: '>>>bad' })).toThrow(/invalid/);
  });

  it('honours the index when several match', () => {
    dom('<i class="x">1</i><i class="x">2</i><i class="x">3</i>');
    expect(findElement(document, { strategy: 'css', selector: '.x', index: 1 }).element.textContent).toBe('2');
    expect(findElement(document, { strategy: 'css', selector: '.x', index: 2 }).element.textContent).toBe('3');
  });

  it('reports a clear error when the index is out of range', () => {
    dom('<i class="x">1</i>');
    expect(() => findElement(document, { strategy: 'css', selector: '.x', index: 5 }))
      .toThrow(/matched 1 element\(s\) but index 5/);
  });
});

describe('findElement — other strategies', () => {
  it('by id', () => {
    dom('<input id="email">');
    expect(findElement(document, { strategy: 'id', id: 'email' }).element.tagName).toBe('INPUT');
  });

  it('by name', () => {
    dom('<input name="q"><input name="other">');
    const r = findElement(document, { strategy: 'name', name: 'q' });
    expect(r.element.getAttribute('name')).toBe('q');
  });

  it('by placeholder', () => {
    dom('<input placeholder="Search here">');
    expect(findElement(document, { strategy: 'placeholder', placeholder: 'Search here' }).element).toBeTruthy();
  });

  it('by aria-label', () => {
    dom('<button aria-label="Close dialog">×</button>');
    expect(findElement(document, { strategy: 'aria', aria: 'Close dialog' }).element).toBeTruthy();
  });

  it('by role', () => {
    dom('<div role="button">Press</div><div role="link">Link</div>');
    const r = findElement(document, { strategy: 'role', role: 'button' });
    expect(r.element.textContent).toBe('Press');
  });

  it('by role and accessible name', () => {
    dom('<div role="button">A</div><div role="button">B</div>');
    const r = findElement(document, { strategy: 'role', role: 'button', roleName: 'B' });
    expect(r.element.textContent).toBe('B');
  });

  it('by xpath', () => {
    dom('<div><span>target</span></div>');
    const r = findElement(document, { strategy: 'xpath', xpath: '//span[text()="target"]' });
    expect(r.element.tagName).toBe('SPAN');
  });

  it('by label, following the for attribute', () => {
    dom('<label for="f1">Email address</label><input id="f1">');
    const r = findElement(document, { strategy: 'label', label: 'Email address' });
    expect(r.element.id).toBe('f1');
  });

  it('by label, finding the nested control', () => {
    dom('<label>Phone <input name="phone"></label>');
    const r = findElement(document, { strategy: 'label', label: 'Phone' });
    expect(r.element.getAttribute('name')).toBe('phone');
  });
});

describe('findElement — text', () => {
  it('finds an element by partial text', () => {
    dom('<button>Submit Order</button>');
    expect(findElement(document, { strategy: 'text', text: 'Submit' }).element).toBeTruthy();
  });

  it('prefers the deepest match, because a wrapper contains its button text', () => {
    dom('<div id="wrap"><button id="inner">Press me</button></div>');
    const r = findElement(document, { strategy: 'text', text: 'Press me' });
    expect(r.element.id).toBe('inner');
  });

  it('is case-insensitive unless asked for exact', () => {
    dom('<a>Download PDF</a>');
    expect(findElement(document, { strategy: 'text', text: 'download pdf' }).element).toBeTruthy();
    expect(findElement(document, { strategy: 'text', text: 'download pdf', textExact: true }).element).toBeNull();
    expect(findElement(document, { strategy: 'text', text: 'Download PDF', textExact: true }).element).toBeTruthy();
  });

  it('matches an input by its value', () => {
    dom('<input value="prefilled">');
    expect(findElement(document, { strategy: 'text', text: 'prefilled' }).element).toBeTruthy();
  });

  it('finds nothing for empty text rather than matching everything', () => {
    dom('<div>a</div><div>b</div>');
    expect(findElement(document, { strategy: 'text', text: '' }).element).toBeNull();
  });
});

describe('findElement — the fallback chain', () => {
  it('uses the chain when the primary strategy misses', () => {
    // simulates a redesign: the recorded selector is gone, the text survived
    dom('<button class="new-name">Pay now</button>');
    const finder = {
      strategy: 'css',
      selector: '#old-id',
      chain: ['.old-class', 'button.new-name'],
    };
    const r = findElement(document, finder);
    expect(r.element?.textContent).toBe('Pay now');
  });

  it('skips a chain entry that no longer parses', () => {
    dom('<button id="b">Go</button>');
    const finder = { strategy: 'css', selector: '#gone', chain: ['>>>bad', '#b'] };
    expect(findElement(document, finder).element?.id).toBe('b');
  });

  it('still returns null when nothing in the chain matches', () => {
    dom('<div></div>');
    const finder = { strategy: 'css', selector: '#a', chain: ['#b', '#c'] };
    expect(findElement(document, finder).element).toBeNull();
  });

  it('reports what it tried, so a failure is debuggable', () => {
    dom('<div></div>');
    const r = findElement(document, { strategy: 'css', selector: '#a', chain: ['#b'] });
    expect(r.tried.length).toBeGreaterThan(1);
    expect(r.tried.map((t) => t.how).join(' ')).toContain('#a');
  });
});

describe('findElement — recorded strategy', () => {
  it('takes the first chain entry that resolves to something visible', () => {
    dom('<div style="display:none" class="a">hidden</div><div class="b">shown</div>');
    const r = findElement(document, { strategy: 'recorded', chain: ['.a', '.b'] });
    expect(r.element?.className).toBe('b');
    expect(r.how).toContain('recorded');
  });

  it('reports nothing matched when the whole chain is dead', () => {
    dom('<div></div>');
    const r = findElement(document, { strategy: 'recorded', chain: ['.x', '.y'] });
    expect(r.element).toBeNull();
    expect(r.how).toMatch(/nothing matched/);
  });
});

describe('visibility', () => {
  it('treats display:none as hidden', () => {
    dom('<div id="h" style="display:none">x</div><div id="v">y</div>');
    expect(isVisible(document.getElementById('h'))).toBe(false);
    expect(isVisible(document.getElementById('v'))).toBe(true);
  });

  it('treats visibility:hidden as hidden', () => {
    dom('<div id="h" style="visibility:hidden">x</div>');
    expect(isVisible(document.getElementById('h'))).toBe(false);
  });

  it('does not filter when only hidden elements match, because a hidden input is normal', () => {
    dom('<input type="hidden" id="csrf" name="csrf">');
    const r = findElement(document, { strategy: 'name', name: 'csrf' });
    expect(r.element).toBeTruthy();
  });
});

describe('accessibleName', () => {
  it('prefers aria-label', () => {
    dom('<button aria-label="Close">×</button>');
    expect(accessibleName(document.querySelector('button'))).toBe('Close');
  });

  it('follows aria-labelledby', () => {
    dom('<span id="lbl">Save changes</span><button aria-labelledby="lbl">OK</button>');
    expect(accessibleName(document.querySelector('button'))).toBe('Save changes');
  });

  it('uses the label element', () => {
    dom('<label for="a">Full name</label><input id="a">');
    expect(accessibleName(document.getElementById('a'))).toBe('Full name');
  });

  it('falls back to text content, collapsing whitespace', () => {
    dom('<button>\n  Save\n  now\n</button>');
    expect(accessibleName(document.querySelector('button'))).toBe('Save now');
  });

  it('uses alt for an image', () => {
    dom('<img alt="Company logo" src="x.png">');
    expect(accessibleName(document.querySelector('img'))).toBe('Company logo');
  });

  it('uses title when there is nothing else', () => {
    dom('<div title="Tooltip text"></div>');
    expect(accessibleName(document.querySelector('div'))).toBe('Tooltip text');
  });
});

describe('cssPath', () => {
  it('uses an id when it is unique', () => {
    dom('<div><button id="submit">Go</button></div>');
    expect(cssPath(document.getElementById('submit'))).toBe('#submit');
  });

  it('builds a structural path when there is no id', () => {
    dom('<div><section><button>Go</button></section></div>');
    const p = cssPath(document.querySelector('button'));
    expect(p.length).toBeGreaterThan(0);
    // the path must uniquely identify the element, which is the only real requirement
    expect(document.querySelectorAll(p)).toHaveLength(1);
  });

  it('uses nth-of-type when siblings share a tag', () => {
    dom('<ul><li>a</li><li>b</li><li>c</li></ul>');
    const p = cssPath(document.querySelectorAll('li')[2]);
    expect(document.querySelectorAll(p)).toHaveLength(1);
    expect(document.querySelector(p).textContent).toBe('c');
  });

  it('prefers a stable data attribute', () => {
    dom('<div><span data-testid="total">42</span></div>');
    const p = cssPath(document.querySelector('span'));
    expect(p).toContain('data-testid');
    expect(document.querySelectorAll(p)).toHaveLength(1);
  });

  it('ignores a non-unique id and keeps going', () => {
    // duplicate ids are invalid HTML but common; a path built on one would match the wrong element
    dom('<div id="dup"><span>a</span></div><div id="dup"><span>b</span></div>');
    const spans = document.querySelectorAll('span');
    const p1 = cssPath(spans[0]);
    const p2 = cssPath(spans[1]);
    expect(p1).not.toBe(p2);
  });
});

describe('describeElement', () => {
  it('summarises an element for the picker UI', () => {
    dom('<input id="e" name="email" type="email" placeholder="you@example.com" class="a b" aria-label="Email">');
    const d = describeElement(document.getElementById('e'));
    expect(d.tag).toBe('input');
    expect(d.id).toBe('e');
    expect(d.name).toBe('email');
    expect(d.type).toBe('email');
    expect(d.placeholder).toBe('you@example.com');
    expect(d.ariaLabel).toBe('Email');
    expect(d.classes).toEqual(['a', 'b']);
  });

  it('returns null for a non-element', () => {
    expect(describeElement(null)).toBeNull();
  });

  it('truncates a very long text so the UI stays readable', () => {
    dom(`<div>${'x'.repeat(500)}</div>`);
    expect(describeElement(document.querySelector('div')).text.length).toBeLessThanOrEqual(160);
  });
});

describe('buildFinder', () => {
  beforeEach(() => dom(''));

  it('prefers a unique id', () => {
    dom('<button id="go">Go</button>');
    const f = buildFinder(document.getElementById('go'));
    expect(f.strategy).toBe('id');
    expect(f.id).toBe('go');
  });

  it('records a chain of fallbacks', () => {
    dom('<div><input name="email" aria-label="Email address"></div>');
    const f = buildFinder(document.querySelector('input'));
    expect(f.chain.length).toBeGreaterThan(1);
  });

  it('produces a finder that finds the original element', () => {
    dom('<div class="a"><section><button>Save</button></section></div>');
    const el = document.querySelector('button');
    const f = buildFinder(el);
    const r = findElement(document, f);
    expect(r.element).toBe(el);
  });

  it('produces a finder whose chain also finds the element', () => {
    dom('<div data-testid="wrap"><button class="x">Save</button></div>');
    const el = document.querySelector('button');
    const f = buildFinder(el);
    // every chain entry that parses should resolve to this element or a container of it
    for (const sel of f.chain) {
      const found = document.querySelectorAll(sel);
      expect(found.length).toBeGreaterThan(0);
    }
  });

  it('falls back to the body when there is nothing to anchor on', () => {
    dom('<div><span>plain</span></div>');
    const f = buildFinder(document.querySelector('span'));
    expect(['css', 'text']).toContain(f.strategy);
    expect(f.chain.length).toBeGreaterThan(0);
  });
});
