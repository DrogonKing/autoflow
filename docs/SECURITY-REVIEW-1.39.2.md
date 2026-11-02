# AutoFlow — security assessment, 1.39.2

**Scope:** the extension as built from `src/` at 1.39.2, all four bundles, in a real Chromium with the extension loaded.
**Method:** adversarial pages served locally, real mouse input, the extension's own UI driven as a user drives it.
**Not in scope:** the trading site's own security; a packed CRX installed from the Web Store; Firefox behaviour beyond the
existing `firefox-security-test`.

Every claim below is backed by a script in `scripts/` that can be re-run. Where a test could pass without exercising the
thing it claims to test, that trap is noted — three of them were found in my own harness during this work.

---

## Verdict

| Area | Result |
|---|---|
| Page ↔ extension isolation | **no path found** |
| Message forgery from a page | **no path found** |
| Privileged API exposure | **none beyond the declared permissions** |
| Stored XSS from page text or an imported file | **no path found** |
| Click redirection by a page | **confirmed — behavioural risk, documented** |
| Blast radius of the permissions themselves | **`<all_urls>` + scripting, as the feature requires** |

**No privilege-escalation or code-execution finding.** Two behavioural findings are real and are described in full below,
because a trading clicker that can be made to press a control the user did not choose is a risk worth stating plainly even
when it is the page redirecting only its own interface.

---

## 1. What was tested, and how

### `scripts/security-adversarial-test.mjs` — a hostile page

Served a page that attacks the extension through every door a web page has: reading `chrome.*` from the page context,
fetching extension resources by a guessed id, `postMessage` forgery, storage poisoning, overwriting extension globals,
covering the viewport, and injecting markup.

**Result: 7 ok · 0 medium · 0 HIGH.**

The measured facts:

- a page has **no** `chrome.storage` and **no** `chrome.runtime` — `chrome` exists in a page context only as far as the
  browser exposes it, and the extension's own objects are not reachable;
- `fetch('chrome-extension://<id>/…')` is refused from a page; only `icons/*` is declared web-accessible, and the id is not
  discoverable by probing;
- `localStorage`/`sessionStorage` writes by the page do not appear in `chrome.storage.local` — the two are separate stores;
- the worker holds **no** `cookies`, `debugger`, `webRequest` or `clipboard` API. It holds `scripting` and `downloads`, which
  the manifest declares.

**Two false positives in my own first version**, corrected before reporting:

1. an `<img onerror>` injected by the page fired, and I reported it as `HIGH`. The page executing its own script in its own
   document proves nothing about the extension — it was the page attacking itself. Reclassified as `INFO`.
2. the permission check compared `typeof chrome.cookies` (the **string** `'undefined'`) and treated a non-empty string as
   truthy, so it reported cookies/debugger/webRequest/clipboard as present while its own printed evidence said
   `"cookies":"undefined"`. The comparison is now against the string `'object'`.

### `scripts/security-xss-test.mjs` — a page whose text is a payload

Served a page whose visible text is an XSS payload, picked it through the **real picker with a real mouse**, and then read
the panel's DOM.

**Result: 3 ok · 0 medium · 0 HIGH.** Five payloads picked and stored:

```
<img src=x onerror=…>      <svg onload=…>      "><script>…      javascript:…      <iframe src="javascript:…">
```

- **zero** `img`/`svg`/`iframe` elements exist inside the panel after rendering — the payloads appear as **text**;
- no handler fired in the page and none in the panel: every flag stayed `0`;
- a crafted backup file imported through the real backup control did not produce markup either.

### `scripts/security-click-integrity-test.mjs` — can a page decide what gets clicked?

Four attacks against a recorded point, run through the real run path.

---

## 2. Findings

### F1 — a replaced element that inherits the recorded `id` is clicked. **Medium. Behaviourial.**

```
attack: the page replaces its "BUY 100 shares" button with a different element carrying id="buy"
result: buy=0  evil=1        ← the replacement received the click
```

The recorded finder is an **anchor** — attribute plus value, `id="buy"` — and it is re-resolved at run time. Whatever now
holds that anchor gets the click. Nothing verifies the element is the one that was picked.

**Why it is not higher:** the page is redirecting only its own interface, which it can already do. There is no privilege
boundary crossed and no data exposed. A page that can swap its own buy button has no need to attack the extension to do so.

**Why it still matters here:** this extension exists to press a specific control at a specific instant on a trading page.
"Click buy" landing on a control the user did not choose is precisely the failure the recorded element text was meant to
catch, and the text is stored but not compared before clicking.

**Mitigation available today, without a code change:** record a point that *reads* a value first and clicks second, so a
swap makes the sequence fail loudly instead of succeeding silently. The stored label is visible on the automation record.

### F2 — a swap after resolution is followed. **Medium. Same cause as F1.**

```
attack: the page replaces the button 800 ms after load, i.e. after the run resolved it
result: buy=0  evil=1
```

Same mechanism: resolution is by anchor, once, at the moment of the step.

### F3 — the Basic form records no page for its points. **Medium. Correctness, with a security consequence.**

```
recorded urls: []      (every automation created in the Basic form)
```

At run time the worker resolves a tab from `automation.urls`, and with none it falls back to the **active** tab — whatever
the user happens to have in front. This is the same fact the user's own log reported as
*"has never had an element picked in it, so a scheduled run has no page"*.

The security consequence is worth naming: a run that acts on "whatever tab is active" is a run that can click in a tab the
user did not intend, if something else is focused at the firing moment.

### F4 — not a finding: a covering overlay. **Correct behaviour.**

```
attack: a full-viewport overlay covers the page, then a point is picked at the buy button's position
result: buy=0  cover=1
```

`realClick` dispatches the sequence **on the element it resolved**; it does not hit-test a coordinate. So an overlay cannot
absorb a click in flight — the extension is immune to that class of attack by construction. `cover=1` simply means the
overlay *was* the element at that point, and recording it is correct.

The residual risk is at **pick time**: an overlay changes what the user is selecting without changing what they see.

---

## 3. What the extension can do at all

```
manifest_version       3
permissions            storage, alarms, tabs, scripting, notifications, sidePanel, downloads
host_permissions       <all_urls>
externally_connectable not declared            ← no page can message the extension by id
content_security_policy not declared            ← MV3 default applies
web_accessible_resources icons/* only
```

`<all_urls>` is what "click an element on the trading page" requires; it also means the extension is a high-value target and
the isolation results above are what make that acceptable. `externally_connectable` being absent is the single most important
line in the manifest: without it, no web page can send a message to the extension at all, whatever it knows about the id.

The single message listener validates its sender (`src/background/service-worker.js:1260`).

---

## 4. Traps in the harness, recorded so they are not repeated

Three of these made a security test report **green while exercising nothing** — the most dangerous outcome for a test of
this kind.

1. **A message from the service worker to itself never reaches its own listener.** `chrome.runtime.sendMessage({type:'run-now'})`
   called *from* the worker returned `res: null` and no click happened; all four click attacks "passed" against a run that
   never took place. The run is now started from the **panel's** context, as the real button does.
2. **The panel opens on `Automations`.** The backup file input does not exist in the document until the `data` tab is
   opened, so the import check reported *"no JSON file input"* and then passed. It now opens the tab and asserts the input
   exists.
3. **`recordUrls: []` means no page to act on**, and the fallback is the active tab — which in a harness is the panel. Every
   attack passed without a click until the record was given a URL pattern and the page was brought to the front.
4. **`typeof x` returns a string**, so a truthiness test on it is always true (F: the permission check).
5. **A page attacking itself is not a finding** (F: the `<img onerror>`).

---

## 5. Recommendations, in order

1. **Compare the recorded label before clicking** when a point has one, and fail the step loudly on a mismatch. This closes
   F1/F2 for the cost of one string comparison, and it is the defence the recorded text already exists for.
2. **Record the page URL in the Basic form**, or refuse to save a point without one. It closes F3 and removes the
   "acts on whatever tab is active" behaviour entirely.
3. **Show the recorded label next to each point in the panel**, so a swap is visible to the user before the run rather than
   after it.
4. Keep `externally_connectable` undeclared, and keep `cookies`/`debugger`/`webRequest` out of the manifest. Both are
   currently correct and both are what make the isolation results hold.