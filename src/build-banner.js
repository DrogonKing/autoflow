/**
 * Warn when this build is running in the browser it was not built for.
 *
 * WHY THIS IS A SEPARATE FILE: Manifest V3 enforces `script-src 'self'`, so an inline <script> in an
 * extension page is BLOCKED. Measured in a real Chrome:
 *
 *   Executing inline script violates the following Content Security Policy directive 'script-src 'self''.
 *   The action has been blocked.
 *
 * The first version of this banner was inline and therefore never ran - the guard against a dead toolbar
 * button was itself dead, silently. A file loaded with <script src> is allowed by `'self'`.
 *
 * It is a plain classic script (no modules, no defer) for two reasons:
 *   - it must run even when the background script does not, which is the case on the mismatched build
 *     (Chromium does not execute `background.scripts` in MV3), so it cannot depend on the worker;
 *   - it must not be deferred, or the user sees a working-looking panel before the warning.
 *
 * WHY THE DETECTION LOOKS THE WAY IT DOES. Two wrong versions came before this one, both measured:
 *
 *   1. `typeof chrome.sidePanel !== 'undefined'` to mean "this is Chromium". WRONG: Chromium only exposes
 *      `sidePanel` to an extension that declares the `sidePanel` permission, so on the FIREFOX build loaded
 *      in Chrome the property is absent and the code concluded "also not Chromium" - so neither branch
 *      matched and the banner stayed silent on the exact case it exists for.
 *   2. `typeof browser !== 'undefined'` to mean "this is Firefox". WRONG: Chrome 145 exposes a `browser`
 *      namespace too, with `runtime.id`. That same mistake in src/platform/api.js made `isFirefox()` return
 *      true on every modern Chromium, which disabled the side panel outright - the bug this banner warns
 *      about was itself caused by it.
 *
 * So: the BUILD is identified from its own manifest, and the BROWSER from `runtime.getBrowserInfo`, which
 * Firefox implements and Chrome has never implemented. Both are facts, not names or granted permissions.
 */
(function () {
  var manifest = null;
  try {
    // `browser` and `chrome` are both valid; take whichever answers.
    var ns = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
    manifest = ns.runtime.getManifest();
  } catch (e) {
    return; // no manifest: nothing can be concluded, and a false warning is worse than none
  }

  // The build: Chromium declares `background.service_worker`, Firefox declares `background.scripts`.
  var buildIsChromium = !!(manifest.background && manifest.background.service_worker);

  // The browser: `runtime.getBrowserInfo` is Firefox-only and needs no permission. Checking it does not
  // depend on which namespace names exist, nor on permissions this build may not declare.
  var browserIsFirefox = false;
  try {
    var c = typeof chrome !== 'undefined' ? chrome : null;
    var b = typeof browser !== 'undefined' ? browser : null;
    browserIsFirefox = (typeof c?.runtime?.getBrowserInfo === 'function')
      || (typeof b?.runtime?.getBrowserInfo === 'function');
  } catch (e) {
    return; // cannot tell: stay quiet rather than guess
  }

  var mismatch = null;
  if (buildIsChromium && browserIsFirefox) {
    mismatch = {
      wrong: 'You are running the CHROME build in Firefox.',
      why: 'Firefox does not run a service worker background script, so the extension never starts, and '
         + 'this build declares no sidebar - the toolbar button does nothing.',
      fix: 'Download autoflow-firefox.zip and load that instead.',
    };
  } else if (!buildIsChromium && !browserIsFirefox) {
    mismatch = {
      wrong: 'You are running the FIREFOX build in Chrome.',
      why: 'This browser does not run a background script declared as `scripts`, so the extension never '
         + 'starts, and the manifest declares no side panel - the toolbar button does nothing.',
      fix: 'Download autoflow-chrome.zip and load that instead.',
    };
  }

  if (!mismatch) return;

  var banner = document.createElement('div');
  banner.setAttribute('role', 'alert');
  banner.setAttribute('data-autoflow-build-mismatch', '1');
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
  why.textContent = mismatch.why + ' ';

  var fix = document.createElement('span');
  fix.textContent = mismatch.fix;
  fix.style.fontWeight = '600';

  banner.appendChild(title);
  banner.appendChild(why);
  banner.appendChild(fix);
  document.documentElement.appendChild(banner);
})();
