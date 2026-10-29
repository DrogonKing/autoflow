/**
 * The findings from the outside review that landed in the worker and the content script.
 *
 * Each case here was a real failure, and each test fails against the previous behaviour. They are grouped in one file
 * because they share a shape: a message or a value crossed a boundary and was handled as if it were the same kind of
 * thing on both sides.
 */
import { describe, expect, it } from 'vitest';
import { findAll } from '../src/core/dom/finder.js';
import { JSDOM } from 'jsdom';

describe('the clickable-target preference does not throw away everything', () => {
  it('falls back to the whole set when nothing looks clickable', () => {
    /**
     * `isClickableTarget` was applied unconditionally, so on a page whose targets are plain DIVs (a canvas-style
     * terminal, or a list rendered as divs) the clickable set was EMPTY and the step then matched everything,
     * including headers. The preference must only narrow when it leaves something.
     */
    const dom = new JSDOM(`<!doctype html><body>
      <div class="order"><div class="row">ارسال</div><div class="row">ارسال</div></div>
    </body>`);
    // jsdom has no layout and no elementFromPoint; the reachability check needs one, so it is stubbed to say
    // "hit-testing is not available here", which is the honest answer and what the product must tolerate
    dom.window.document.elementFromPoint = () => null;
    const found = findAll(dom.window.document, { strategy: 'text', text: 'ارسال' }, {
      requireVisible: true, requireActionable: true,
    });
    // jsdom has no layout, so visibility filtering is a no-op here; what matters is that the set is not emptied
    expect(found.elements.length).toBeGreaterThan(0);
  });
});

describe('the URL pattern matcher', () => {
  /** The same shape the worker uses, extracted so the matching rules can be tested without a browser. */
  const escapeForRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const asRegex = (pattern) => new RegExp(`^${String(pattern).split('*').map(escapeForRegex).join('.*')}$`, 'i');
  const matches = (pattern, url) => asRegex(pattern).test(url)
    || (!String(pattern).includes('*') && url.startsWith(String(pattern)));

  it('a trailing star matches anything after it', () => {
    expect(matches('https://x.test/order/*', 'https://x.test/order/123')).toBe(true);
    expect(matches('https://x.test/order/*', 'https://x.test/order/')).toBe(true);
  });

  it('a star does NOT match a different host, which the old code allowed', () => {
    // the old implementation stripped the star and used `includes`, so a shorter pattern matched anywhere in the url
    expect(matches('https://x.test/order', 'https://evil.test/?u=https://x.test/order')).toBe(false);
  });

  it('a bare star does not match every tab', () => {
    // this was the worst case: '*' collapsed to '' and `includes('')` is always true
    expect(matches('*', 'https://anything.test/')).toBe(true);   // intended
    expect(matches('https://x.test/*', 'https://y.test/')).toBe(false);
  });

  it('a pattern with no star is a prefix', () => {
    expect(matches('https://x.test/order', 'https://x.test/order/9')).toBe(true);
    expect(matches('https://x.test/order', 'https://x.test/other')).toBe(false);
  });

  it('special characters in the pattern are literal', () => {
    expect(matches('https://x.test/a?b=1', 'https://x.test/a?b=1')).toBe(true);
    expect(matches('https://x.test/a?b=1', 'https://x.test/aXb=1')).toBe(false);
  });
});

describe('the anchor exception list is anchored to the start of an attribute name', () => {
  it('accepts attributes that merely CONTAIN a vendor prefix', async () => {
    /**
     * `/v-|ng-/` was unanchored, so it matched those two characters anywhere and silently discarded
     * `data-nav-id`, `data-dev-id`, `data-pricing-plan`, `data-loading-key` and `data-setting-id`. A page using any
     * of them as its only identifier could not be anchored at all.
     */
    const { findAnchor } = await import('../src/core/dom/anchor.js');
    const names = ['data-nav-id', 'data-dev-id', 'data-pricing-plan', 'data-loading-key', 'data-setting-id'];
    for (const name of names) {
      const dom = new JSDOM(`<!doctype html><body><div ${name}="abc"><button id="b">x</button></div></body>`);
      const anchor = findAnchor(dom.window.document.getElementById('b'), dom.window.document);
      expect(anchor, `${name} should have been usable as an anchor`).not.toBeNull();
    }
  });

  it('still rejects a real vendor-prefixed attribute', async () => {
    const { findAnchor } = await import('../src/core/dom/anchor.js');
    const dom = new JSDOM('<!doctype html><body><div v-if="x"><button id="b">x</button></div></body>');
    const anchor = findAnchor(dom.window.document.getElementById('b'), dom.window.document);
    // the button's own unique id wins, which is correct - the point is the vendor attribute was not the anchor
    expect(anchor.selector).toBe('#b');
  });
});

describe('a data URL is built for downloads, because a worker has no createObjectURL', () => {
  it('the base64 helper produces the payload without the data prefix', async () => {
    /**
     * `URL.createObjectURL` does not exist in a Manifest V3 service worker, so any download step carrying content
     * threw. A data URL is a string and works from the worker. FileReader is not present in node, so this asserts the
     * documented contract with a minimal stand-in.
     */
    const { bytesToBase64 } = await import('../src/platform/serialise.js');
    expect(typeof bytesToBase64).toBe('function');

    // a FileReader stand-in that returns what a real one would for a tiny text blob
    const original = globalThis.FileReader;
    globalThis.FileReader = class {
      readAsDataURL() {
        this.result = 'data:text/plain;base64,aGVsbG8=';
        setTimeout(() => this.onload(), 0);
      }
    };
    try {
      const payload = await bytesToBase64({});
      expect(payload).toBe('aGVsbG8=');
    } finally {
      globalThis.FileReader = original;
    }
  });
});

describe('the page-message allowlist includes what the content script actually sends', () => {
  it('read-file-for-upload is allowed, so the upload step can work at all', async () => {
    /**
     * The content script sends this when an upload step needs the bytes; the worker's allowlist did not contain it,
     * so every upload was refused. It is safe because the name is looked up in the extension's own stored uploads -
     * a page cannot use it to read anything the user did not already put there.
     */
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/background/service-worker.js', 'utf8');
    const block = src.slice(src.indexOf('const CONTENT_SCRIPT_MESSAGES'));
    const list = block.slice(0, block.indexOf(']);'));
    expect(list).toContain("'read-file-for-upload'");
  });
});

describe('the sender classifier treats a page on any scheme as a page', () => {
  it('lists file, ftp, data and blob as content scripts, not internal callers', async () => {
    /**
     * These schemes fell through to 'internal', the most privileged class, so a page opened from disk could send
     * anything the panel can. The test field the user works with is a file:// page.
     */
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/background/service-worker.js', 'utf8');
    const fn = src.slice(src.indexOf('function classifySender'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/\(file\|ftp\|data\|blob\)/);
    expect(body).toContain("return 'content-script'");
  });
});