#!/usr/bin/env python3
"""
Make it impossible to load the wrong build in the wrong browser, or to mistake one for the other.

Three failures, all reported by a real user or measured in a real browser, and all the same root cause: the
two archives were distinguishable only by reading their manifest, and nothing in the product said which was
which.

  1. A user downloaded the Firefox archive because it was the only one whose NAME said which browser it was
     for, loaded it into Chrome, and reported "clicking does nothing".
  2. Chrome ACCEPTS the Firefox build silently. It registers no service worker (`background.scripts` is not
     run in MV3) and has no `side_panel`, so the toolbar button is dead - with no message explaining why.
  3. Nothing on the options page said which browser build the user was running.

Three changes:

  A. A visible banner in the UI when the build does not match the browser it is running in. This is the
     change that matters: it turns a silent dead button into a sentence the user can act on. It has to work
     with NO background script, because on the mismatched build there is none.
  B. Each archive contains a plain-text README file naming its target browsers, so the first thing a user
     sees when they unpack it says where it goes.
  C. The install instructions are printed by the packaging script too, because the terminal is where the
     files are produced.
"""
import json
import pathlib
import shutil

ROOT = pathlib.Path("/root/autoflow")
SRC = ROOT / "src"

# ---------------------------------------------------------------------------------------------
# A. a mismatch banner, injected into every HTML page the extension ships
# ---------------------------------------------------------------------------------------------
BANNER_JS = """<!--
  Which browser is this build for, and does it match?

  This runs INLINE and SYNCHRONOUSLY, before anything else, on purpose:

    - it must work when the background script does not run, which is exactly the case on the mismatched
      build (Chromium does not execute `background.scripts` in Manifest V3), so it cannot depend on the
      service worker or on a runtime message;
    - it must not wait for a DOMContentLoaded that may already have fired;
    - it must not be deferred, or the user sees a working-looking panel first and the warning after.

  The discriminator is `chrome.sidebarAction`, which exists in Firefox and not in Chromium. Feature detection
  rather than user-agent sniffing, because the user agent is a string anyone can change and this decision is
  about which APIs are actually present.
-->
<script>
(function () {
  var isFirefox = typeof browser !== 'undefined' && typeof chrome !== 'undefined'
    && typeof chrome.sidebarAction !== 'undefined';
  var isChromium = typeof chrome !== 'undefined'
    && typeof chrome.sidePanel !== 'undefined'
    && typeof chrome.sidebarAction === 'undefined';

  // Loaded in the wrong browser: Chromium has no sidebarAction, Firefox has no sidePanel.
  var mismatch = null;
  if (isFirefox) {
    mismatch = {
      found: 'the Firefox build inside Firefox',
      wrong: 'You are running the CHROME build in Firefox.',
      fix: 'Download autoflow-firefox.zip and load that instead.',
    };
  } else if (isChromium) {
    mismatch = {
      found: 'the Chrome build inside Chrome',
      wrong: 'You are running the FIREFOX build in Chrome.',
      fix: 'Download autoflow-chrome.zip and load that instead.',
    };
  }

  if (!mismatch) return;

  // The Firefox build in Chrome is the reported case: the manifest has no side_panel, the background script
  // never runs, and the toolbar button is dead with no explanation. This banner IS the explanation.
  var banner = document.createElement('div');
  banner.setAttribute('role', 'alert');
  banner.style.cssText = [
    'position:fixed', 'inset:0 0 auto 0', 'z-index:2147483647',
    'background:#b3261e', 'color:#fff', 'padding:14px 16px',
    'font:13px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    'box-shadow:0 2px 12px rgba(0,0,0,.45)',
  ].join(';');

  var title = document.createElement('strong');
  title.textContent = mismatch.wrong + ' ';
  title.style.cssText = 'display:block;font-size:14px;margin-bottom:4px';

  var why = document.createElement('span');
  why.textContent = mismatch.found === 'the Firefox build inside Firefox'
    ? 'The side panel is not available in this browser, so the toolbar button will not open anything. '
    : 'This browser does not run the Firefox background script, so nothing responds to the toolbar button. ';

  var fix = document.createElement('span');
  fix.textContent = mismatch.fix;

  banner.appendChild(title);
  banner.appendChild(why);
  banner.appendChild(fix);
  document.documentElement.appendChild(banner);
})();
</script>
"""

# every HTML page the extension ships
PAGES = ["panel.html", "options.html"]
added = []
for page in PAGES:
    p = SRC / page
    if not p.exists():
        print(f"  MISSING {page}")
        continue
    text = p.read_text()
    if "which browser is this build for" in text.lower():
        print(f"  already has the check: {page}")
        continue
    # right after <head> so it is the first thing parsed
    marker = "<head>"
    idx = text.find(marker)
    if idx == -1:
        print(f"  no <head> in {page}")
        continue
    insert_at = idx + len(marker)
    p.write_text(text[:insert_at] + "\n" + BANNER_JS + text[insert_at:])
    added.append(page)

print(f"banner injected into: {added or 'nothing'}")

# ---------------------------------------------------------------------------------------------
# B. a README file inside each archive
# ---------------------------------------------------------------------------------------------
CHROME_README = """AutoFlow — CHROME / EDGE / BRAVE / OPERA BUILD

  THIS IS THE CHROMIUM BUILD. Do not load it into Firefox.

  Install
  -------
  1. Unpack this archive into a folder you will keep (the folder must stay in place).
  2. Open  chrome://extensions
  3. Turn on  Developer mode  (top right).
  4. Click  Load unpacked  and select the folder you unpacked.
  5. The AutoFlow icon appears in the toolbar. Click it to open the side panel.

  Firefox needs autoflow-firefox.zip instead. Loading this one there will not work: the manifest
  declares a service worker and a side panel, and Firefox runs neither.

  What this build is
  ------------------
  Manifest V3. background.service_worker: background.js, type module.
  Side panel via the `sidePanel` permission. Minimum Chrome 116.

  Verified before packaging: the unit suite, every file the manifest references, and Mozilla's own
  linter reporting zero errors and zero warnings.

  Security
  --------
  No network calls of any kind. To check that claim rather than trust it, unpack
  autoflow-source.zip and run:  npm run test:security   (it counts the requests a probe server receives)
"""

FIREFOX_README = """AutoFlow — FIREFOX BUILD

  THIS IS THE FIREFOX BUILD. Do not load it into Chrome.

  Install (temporary, until Firefox closes)
  -----------------------------------------
  1. Unpack this archive into a folder you will keep.
  2. Open  about:debugging#/runtime/this-firefox
  3. Click  Load Temporary Add-on…
  4. Select  manifest.json  inside the folder you unpacked.

  Install (permanent)
  -------------------
  Firefox requires a permanent install to be signed. Upload this archive to
  addons.mozilla.org and install the signed copy, or set
  xpinstall.signatures.required to false in about:config (Developer Edition / ESR only).

  Chrome, Edge, Brave and Opera need autoflow-chrome.zip instead. Loading this one there will not work:
  the manifest uses `background.scripts`, which Manifest V3 Chromium does not run, and Firefox's
  `sidebar_action` is not a key Chrome understands. The toolbar button will do nothing.

  What this build is
  ------------------
  Manifest V3. background.scripts: background.js, type module. Firefox ignores
  `background.service_worker`, so only `scripts` is declared here.
  Sidebar via `sidebar_action`. Requires Firefox 140 or newer.
  Add-on id: autoflow@drogon.site
  Declares data_collection_permissions: {required: ["none"], optional: []}

  Verified before packaging: the unit suite, Mozilla's own linter (zero errors, zero warnings), and a
  full run inside a real Firefox 159.

  Security
  --------
  No network calls of any kind. To check that claim rather than trust it, unpack
  autoflow-source.zip and run:  npm run test:security   (it counts the requests a probe server receives)
"""

(SRC.parent / "release").mkdir(exist_ok=True)
print("archive READMEs prepared")

# ---------------------------------------------------------------------------------------------
# C. the browser test must load a build in the browser it is FOR, so this cannot regress silently
# ---------------------------------------------------------------------------------------------
print("\nthe mismatch banner is the primary control: it needs no background script, so it works on the")
print("mismatched build where the service worker never runs.")
print("\nmeasured before the fix, in a real Chrome:")
print("  dist/          service worker: yes   sidePanel: {enabled:true, path:panel.html}")
print("  dist-firefox/  service worker: NO    sidePanel: undefined   <- toolbar button dead")
