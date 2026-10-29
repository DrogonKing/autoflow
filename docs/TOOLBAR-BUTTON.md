# "Clicking the toolbar button does nothing"

Reported by the user, with a screenshot showing the extension icon carrying an orange `!` badge and no side
panel open. Six distinct causes were found. Five were real; the sixth was a regression introduced while fixing
the fifth. Every one was found by measuring in a real browser, and two of the fixes were themselves wrong
first and had to be measured again.

## The root cause

**`isFirefox()` returned `true` on every modern Chromium.**

```js
if (typeof globalThis.browser !== 'undefined' && globalThis.browser?.runtime) return true;
```

Chrome 145 exposes a `browser` namespace too, with `runtime.id`. Measured from inside this extension running
in a real Chrome 145:

```
typeof_browser               "object"
browser_has_runtime          "object"
browser_runtime_id           "idlidpnnmpdniiibhcoehlhgflmhddeo"   <- our own extension's id
typeof_chrome_sidePanel      "object"
typeof_chrome_sidebarAction  undefined
ua_has_firefox               false
```

The consequence was total, not cosmetic:

| call | wrong result | effect |
|---|---|---|
| `side.kind()` | `'sidebar'` | the build declared `sidebar_action` instead of `side_panel` |
| `enableOpenOnClick()` | `if (isFirefox()) return false` | `openPanelOnActionClick` was never set |
| `side.open()` | reached for `sidebarAction` | Chromium does not implement it |

So the toolbar button did nothing, and the `.catch(() => {})` around `setPanelBehavior` hid the reason.

**Fix:** identify the engine by a capability only one has, never by a namespace name.

```
runtime.getBrowserInfo   Firefox only; Chrome has never implemented it, needs no permission
sidebarAction            Firefox only; Chromium has sidePanel
sidePanel                Chromium only
userAgent                last resort, and the least trustworthy of the four
```

## The other five

**2. The warning banner never ran — MV3 blocks inline script.** The first version of the mismatch banner was an
inline `<script>`. Chrome refused it:

```
Executing inline script violates the following Content Security Policy directive 'script-src 'self''.
The action has been blocked.
```

The guard against a dead toolbar button was itself dead, silently. Moved to `build-banner.js` loaded with
`<script src>`, which `'self'` allows.

**3. The banner's detection was wrong twice, both measured.**

- `typeof chrome.sidePanel !== 'undefined'` to mean "this is Chromium": Chromium only exposes `sidePanel` to an
  extension that declares the `sidePanel` permission, so on the Firefox build in Chrome the property is absent —
  and the code concluded "also not Chromium", so neither branch matched and the banner stayed silent on the
  exact case it exists for.
- `typeof browser !== 'undefined'` to mean "this is Firefox": the same mistake as the root cause above.

**4. `onInstalled` threw silently.** `setPanelBehavior` was measured still `false` after a fresh install, while
calling it by hand returned `resolved` → the call was never reached. Every step is now independently wrapped,
and the whole thing also runs at module load so the state is self-healing rather than dependent on one event.

**5. The click handler returned too early — a regression I introduced.** The first fix made it
`if (api.side.kind() !== 'sidebar') return;`, on the reasoning that the browser opens the panel itself. That
assumes `openPanelOnActionClick` is already `true`, which is precisely what cause 4 disproves. If the flag
losesthe race, the early return leaves the button dead — the original bug, reintroduced by its own fix. The
handler now always attempts the open and treats a rejection as a non-event: with the flag on the browser has
already opened it and the call is rejected harmlessly; with the flag off the call is the only mechanism, and it
works because `onClicked` *is* a user gesture.

**6. The toolbar badge was an error badge nobody could read.** `sidePanel.open()` was rejected with
*"may only be called in response to a user gesture"* after the browser had consumed the gesture, and that
rejection was unhandled — surfacing as the orange `!` on the icon. The platform layer now catches it and
returns `false`, because "could not open" is a normal outcome and "something is broken" is not.

## Worse than the bug: loading the wrong archive is silent

Chrome **accepts** the Firefox build and gives no explanation:

```
FIREFOX archive in CHROME:
  declared background : {"scripts":["background.js"],"type":"module"}
  service worker      : NONE   (MV3 Chromium does not run background.scripts)
  declared side_panel : ABSENT
  toolbar button      : dead
```

Three guards now exist so this cannot be a silent failure:

| guard | why it is shaped that way |
|---|---|
| a red banner on every extension page | it must work when there is **no service worker**, because that is exactly the mismatched case — so it is a plain classic script that reads its own manifest, and it is not deferred |
| `HOW-TO-INSTALL.txt` inside each archive | the first thing a user sees on unpacking says which browser it is for |
| a table in the README, and `-chrome` in the filename | the archive that did not name its browser is the reason the wrong one was downloaded |

## Verification

`scripts/verify-build-guard.mjs` unpacks both archives, loads each in Chrome, and checks the real outcome:

```
ok   Chrome accepted the Firefox build
ok   a visible banner explains the mismatch
ok   the banner names the file to download instead
ok   the service worker runs
     badge text          : ""                              <- no error badge
     panel behavior      : {"openPanelOnActionClick":true}  <- actually set now
ok   the toolbar badge is EMPTY (no error shown)
ok   openPanelOnActionClick is on
ok   the correct build shows NO mismatch banner
7/7 checks passed
```

And the full suite, in both browsers, after the `isFirefox()` change touched every code path:

```
unit tests          381 passed
chromium load        20/20
chromium e2e         27/27
firefox functional   31/31
firefox security     10/10
build guard           7/7
web-ext lint          0 errors, 0 warnings
```

## The lesson worth keeping

`isFirefox()` was wrong in a way that **passed 381 unit tests, 20 load checks, 27 end-to-end checks, 31 Firefox
checks and 10 security checks.** They all ran in environments where the mistake was invisible, or they checked
that an API *existed* rather than that it *worked*.

The three checks that caught it were the ones that:
1. **clicked the real thing** — no test had ever clicked the icon
2. **ran in a fresh profile** — the bug needed a first install, not a warm state
3. **loaded the shipped archive** — not `dist/`, which is what the tests had been given

A test that verifies an API is present is not a test that the feature works.
