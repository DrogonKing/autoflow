> ## 1.39.3 — security review, with one real finding fixed
>
> Assessed against a hostile page in a real browser, not by reading source.

A full security pass was run with three adversarial harnesses. **No privilege escalation, no code execution, no path from
a page to the extension's APIs or storage.** One behavioural finding was real and is fixed here; one correctness issue is
documented with a workaround.

The full write-up is `docs/SECURITY-REVIEW-1.39.2.md` in the source archive.

## Fixed — a swapped element was clicked

The extension re-resolved a recorded point by its **anchor** (an attribute and its value) and clicked whatever now held it,
without comparing the label the picker had recorded. Measured on a hostile page:

```
the page replaced its "BUY 100 shares" button with a different element carrying the same id
before:  buy=0  evil=1     ← the replacement received the click
after:   buy=0  evil=0     ← refused, with the reason named
         error: "refusing to click: the element no longer reads "BUY 100 shares" (it now reads "SELL 100 shares")"
```

On a trading page, "click buy" landing on a control the user did not choose is exactly the failure the recorded text
exists to catch — and the text was stored but never compared.

**The check is deliberately narrow.** It runs only when a label was recorded, so nothing that works today starts failing.
And an element with **no** accessible name is never refused: a quantity or price field usually has none, and a false refusal
on a trading clicker is a missed order. `tests/verify-label.test.js` locks both properties in — 6 tests.

## Confirmed safe

| Attack | Result |
|---|---|
| read `chrome.storage` / `chrome.runtime` from a page | no access |
| `fetch('chrome-extension://<id>/…')` from a page | refused |
| `postMessage` forgery to the extension | no listener accepts it |
| poison `localStorage`/`sessionStorage` | separate stores, no effect |
| overwrite extension globals from a page | no effect |
| `<img onerror>` / `<svg onload>` / `"><script>` picked through the real picker | stored as **text**, never parsed |
| crafted backup file imported through the real backup control | no markup produced |
| a full-screen overlay absorbing the click | impossible — the click is dispatched on the resolved element, not by coordinate |

`externally_connectable` is not declared, which is the single most important line in the manifest: no web page can message
the extension at all. `cookies`, `debugger`, `webRequest` and `clipboard` are all absent.

## Documented, not fixed — the Basic form records no page

Every automation created in the Basic form is stored with `urls: []`, so at run time the worker falls back to the **active
tab** — whatever the user has in front. This is the same fact reported earlier as *"has never had an element picked in it,
so a scheduled run has no page"*.

The consequence for a timed clicker is worth stating plainly: a run can act on a tab the user did not intend. **Workaround
today:** set the URL pattern on the Automation tab, or keep the trading page the active tab at the firing moment.

## Four traps in my own harness, recorded because each produced a false green

1. **A message from the service worker to itself never reaches its own listener.** `sendMessage` called *from* the worker
   returned `res: null`, nothing was clicked, and all four click attacks "passed" against a run that never happened.
2. **The panel opens on `Automations`**, so the backup file input does not exist in the document until the `data` tab is
   opened — the import check reported "no file input" and then passed.
3. **`recordUrls: []` means no page to act on**, and the fallback is the active tab, which in a harness is the panel itself.
4. **`typeof x` returns a string**, so a truthiness test on it is always true — the permission check reported
   cookies/debugger/webRequest/clipboard as present while printing `"cookies":"undefined"` beside it.

A security test that passes without exercising the thing it names is worse than no test, so each of these now asserts its
own precondition.

## Verified

```
801 unit tests · 43 files (up from 795)
security-adversarial-test   7 ok · 0 medium · 0 HIGH
security-xss-test           3 ok · 0 medium · 0 HIGH
security-click-integrity    3 ok · 0 medium · 0 HIGH
import guard clean
```