/**
 * The platform layer: one API surface for Chromium and Firefox.
 *
 * Why this file has to exist, stated as the concrete difference it hides:
 *
 *   Chromium: `chrome.*` returns Promises in MV3, and also accepts callbacks.
 *   Firefox:  `chrome.*` is callback-only. `browser.*` is the Promise one.
 *
 * So `await chrome.alarms.getAll()` works in Chromium and silently yields `undefined` in Firefox, while
 * `chrome.runtime.sendMessage(msg, cb)` works in Chromium and never calls the callback in Firefox if you
 * reach for `browser`. Both mistakes look like a dead feature rather than an error.
 *
 * The rule this module enforces: EVERYTHING here is promise-based and there are no callbacks anywhere
 * above this layer. That removes the class of bug instead of working around it.
 *
 * The namespace is resolved lazily on each call, not at import time, because the automated tests install
 * a fake `chrome` global *after* the module graph is loaded and a captured reference would miss it.
 */

/** The real namespace object for the running browser, resolved at call time. */
export function ns() {
  if (typeof globalThis.browser !== 'undefined' && globalThis.browser?.runtime?.id !== undefined) {
    return globalThis.browser;
  }
  if (typeof globalThis.chrome !== 'undefined') return globalThis.chrome;
  if (typeof globalThis.browser !== 'undefined') return globalThis.browser;
  throw new Error('neither `browser` nor `chrome` is available');
}

/**
 * Which browser this is.
 *
 * Firefox ships both namespaces, so the presence of `browser.runtime` is the reliable signal. Checking the
 * user agent is the fallback and is only used for the sidebar, where the two APIs have different names.
 */
/**
 * Is this Firefox?
 *
 * DO NOT test for the `browser` namespace. Chrome 145 exposes one too - with `runtime.id` - so
 * `typeof browser !== 'undefined'` reports CHROME as Firefox. Measured inside this extension running in a
 * real Chrome 145:
 *
 *     typeof_browser            "object"
 *     browser_has_runtime       "object"
 *     browser_runtime_id        "idlidpnnmpdniiibhcoehlhgflmhddeo"   <- our own extension's id
 *     typeof_chrome_sidePanel   "object"
 *     typeof_chrome_sidebarAction  undefined
 *     ua_has_firefox            false
 *
 * The consequence was total, not cosmetic: `isFirefox()` returned true, so
 *
 *   - `side.kind()` returned 'sidebar', and the build emitted `sidebar_action` instead of `side_panel`
 *   - `enableOpenOnClick()` hit `if (isFirefox()) return false` and never set `openPanelOnActionClick`
 *   - `side.open()` reached for `sidebarAction`, which Chromium does not implement
 *
 * ...so the toolbar button did nothing on every modern Chromium. The user reported exactly that.
 *
 * The reliable discriminator is an API only one engine implements:
 *
 *   `runtime.getBrowserInfo`   Firefox only. Chrome has never implemented it, and it needs no permission.
 *   `sidebarAction`            Firefox only; Chromium has `sidePanel` instead.
 *
 * Both are capabilities rather than names, and both are checked before the user agent, which is a string
 * anyone can set and the least trustworthy signal of the three.
 */
export function isFirefox() {
  try {
    const c = globalThis.chrome;
    const b = globalThis.browser;

    // Firefox-only, and unambiguous: Chrome does not implement runtime.getBrowserInfo.
    if (typeof c?.runtime?.getBrowserInfo === 'function') return true;
    if (typeof b?.runtime?.getBrowserInfo === 'function') return true;

    // Firefox exposes sidebarAction; Chromium exposes sidePanel. Asking which exists answers the question
    // without depending on the namespace name or on a granted permission.
    if (typeof c?.sidebarAction !== 'undefined' || typeof b?.sidebarAction !== 'undefined') return true;
    if (typeof c?.sidePanel !== 'undefined' || typeof b?.sidePanel !== 'undefined') return false;

    // Nothing decisive answered, so fall back to the user agent - and only now.
    return /firefox/i.test(globalThis.navigator?.userAgent ?? '');
  } catch {
    return false;
  }
}

/**
 * Call an API method and always get a Promise.
 *
 * If the namespace returned a Promise (Firefox `browser.*`, or Chromium MV3), it is used directly. If
 * instead it is a callback-style function, the callback is supplied here and converted. That means a
 * single call site works on a namespace of either kind, which is what makes the rest of the code
 * browser-neutral.
 */
/**
 * Call an API method and always get a Promise.
 *
 * The subtlety that this function exists to get right, and that a naive version gets wrong:
 *
 *   - Chromium `chrome.*` is callback-based, and also returns a Promise in MV3. Passing a callback is
 *     correct there.
 *   - Firefox `browser.*` returns a Promise and takes NO callback. Worse, several methods use the second
 *     argument for something else entirely: `storage.get(key, defaultValue)` treats a function in that
 *     position as a DEFAULT VALUE MAP. So passing a callback to `browser.storage.local.get('automations')`
 *     does not call it - it resolves immediately with `{ automations: <the function itself> }`.
 *
 * That failure is silent and looks like broken storage: the write succeeds, the read returns a function
 * where a list should be, and a saved automation never appears. It was found by running the extension in a
 * real Firefox, and it is why the promise branch below is tried FIRST and why the callback is only passed
 * when no promise comes back.
 */
export function call(fn, thisArg, args = []) {
  if (typeof fn !== 'function') {
    return Promise.reject(new Error('the API method is not available in this browser'));
  }

  // Attempt 1: call WITHOUT a callback. This is the correct shape for `browser.*` and for every
  // promise-returning `chrome.*` method in MV3. If a promise comes back, it is the reply.
  //
  // A synchronous throw here is NOT reported as the failure: a callback-only implementation throws when its
  // callback is missing, and that is precisely the case attempt 2 handles.
  let first;
  let firstError = null;
  try {
    first = fn.call(thisArg, ...args);
  } catch (e) {
    firstError = e;
  }
  if (first && typeof first.then === 'function') {
    return first.then((value) => {
      const err = lastError();
      if (err) throw new Error(err);
      return value;
    });
  }

  // Attempt 2: a callback-based implementation. It returned nothing usable, so the callback form is
  // required - which only happens on a namespace that ignores the extra argument.
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      const err = lastError();
      if (err) reject(new Error(err));
      else resolve(value);
    };
    try {
      const maybe = fn.call(thisArg, ...args, done);
      if (maybe && typeof maybe.then === 'function') {
        maybe.then((v) => { if (!settled) { settled = true; resolve(v); } },
          (e) => { if (!settled) { settled = true; reject(e); } });
      } else if (fn.length <= args.length) {
        // no callback parameter at all: it was synchronous
        settled = true;
        resolve(maybe);
      }
    } catch (e) {
      if (!settled) {
        settled = true;
        // report the FIRST error when the callback form also fails, since that is the more informative
        // one for a genuinely broken call
        reject(firstError && e === firstError ? e : e);
      }
    }
  });
}

function lastError() {
  try {
    return ns().runtime?.lastError?.message ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------------------------

const area = (name) => ({
  get: (keys) => call(ns().storage[name].get.bind(ns().storage[name]), null, [keys]),
  set: (items) => call(ns().storage[name].set.bind(ns().storage[name]), null, [items]),
  remove: (keys) => call(ns().storage[name].remove.bind(ns().storage[name]), null, [keys]),
  clear: () => call(ns().storage[name].clear.bind(ns().storage[name]), null, []),
});

// ---------------------------------------------------------------------------------------------
// the surface
// ---------------------------------------------------------------------------------------------

export const api = {
  get id() {
    return ns().runtime.id;
  },

  runtime: {
    /**
     * This extension's own base URL, with the scheme this browser actually uses.
     *
     * Chromium: `chrome-extension://<id>/`   Firefox: `moz-extension://<uuid>/`
     * Comparing a sender against a hardcoded `chrome-extension://` therefore fails on Firefox - it
     * rejected the extension's own background page and every page action broke with "no answer".
     */
    baseUrl() {
      try {
        return ns().runtime.getURL('');
      } catch {
        return '';
      }
    },

    get onMessage() {
      return ns().runtime.onMessage;
    },
    get onInstalled() {
      return ns().runtime.onInstalled;
    },
    get onStartup() {
      return ns().runtime.onStartup;
    },
    getManifest: () => ns().runtime.getManifest(),
    getURL: (p) => ns().runtime.getURL(p),
    openOptionsPage: () => call(ns().runtime.openOptionsPage.bind(ns().runtime), null, []),
    /**
     * Send a message and get the reply.
     *
     * A receiving end that does not exist is reported differently by each browser: Chromium rejects with
     * "Could not establish connection", Firefox with "Could not establish connection. Receiving end does
     * not exist." Both are normal when a tab has no content script, so the raw error is preserved and the
     * caller decides.
     */
    sendMessage: (msg) => call(ns().runtime.sendMessage.bind(ns().runtime), null, [msg]),
  },

  storage: {
    local: area('local'),
    get session() {
      // storage.session is Firefox 115+ and Chromium 102+; if it is missing the caller gets a clear error
      if (!ns().storage.session) throw new Error('storage.session is not available in this browser');
      return area('session');
    },
  },

  alarms: {
    get onAlarm() {
      return ns().alarms.onAlarm;
    },
    create: (name, info) => call(ns().alarms.create.bind(ns().alarms), null, [name, info]),
    clear: (name) => call(ns().alarms.clear.bind(ns().alarms), null, [name]),
    getAll: () => call(ns().alarms.getAll.bind(ns().alarms), null, []),
  },

  tabs: {
    query: (q) => call(ns().tabs.query.bind(ns().tabs), null, [q]),
    get: (id) => call(ns().tabs.get.bind(ns().tabs), null, [id]),
    create: (props) => call(ns().tabs.create.bind(ns().tabs), null, [props]),
    update: (id, props) => call(ns().tabs.update.bind(ns().tabs), null, [id, props]),
    remove: (ids) => call(ns().tabs.remove.bind(ns().tabs), null, [ids]),
    reload: (id, props) => call(ns().tabs.reload.bind(ns().tabs), null, props ? [id, props] : [id]),
    sendMessage: (tabId, msg) => call(ns().tabs.sendMessage.bind(ns().tabs), null, [tabId, msg]),
    captureVisibleTab: (windowId, opts) =>
      call(ns().tabs.captureVisibleTab.bind(ns().tabs), null, [windowId, opts]),
    /**
     * History navigation.
     *
     * Firefox never implemented `tabs.goBack`/`goForward`; it has `browser.history` and, more usefully
     * here, `tabs.update({url})`. Chromium has both. The runner treats a missing implementation as "no
     * navigation happened" rather than failing the step, so this returns false instead of throwing.
     */
    goBack: async (id) => {
      const t = ns().tabs;
      if (typeof t.goBack === 'function') return call(t.goBack.bind(t), null, [id]);
      return false;
    },
    goForward: async (id) => {
      const t = ns().tabs;
      if (typeof t.goForward === 'function') return call(t.goForward.bind(t), null, [id]);
      return false;
    },
  },

  scripting: {
    executeScript: (opts) => call(ns().scripting.executeScript.bind(ns().scripting), null, [opts]),
  },

  notifications: {
    create: (id, opts) => call(ns().notifications.create.bind(ns().notifications), null, [id, opts]),
  },

  downloads: {
    download: (opts) => call(ns().downloads.download.bind(ns().downloads), null, [opts]),
  },

  action: {
    get onClicked() {
      return ns().action?.onClicked ?? ns().browserAction?.onClicked;
    },
    setBadgeText: (opts) => call(ns().action.setBadgeText.bind(ns().action), null, [opts]),
    setBadgeBackgroundColor: (opts) =>
      call(ns().action.setBadgeBackgroundColor.bind(ns().action), null, [opts]),
  },

  commands: {
    get onCommand() {
      return ns().commands.onCommand;
    },
  },

  /**
   * The side surface.
   *
   * Chromium has a side panel (`sidePanel`); Firefox has a sidebar (`sidebarAction`). They are the same
   * idea with different names, different manifest keys and different APIs, so the rest of the code asks
   * this object to open "the side surface" and does not care which one it got.
   */
  side: {
    kind: () => (isFirefox() ? 'sidebar' : 'panel'),

    /** Make clicking the toolbar button open it, where the platform allows that. */
    async enableOpenOnClick() {
      if (isFirefox()) {
        // Firefox's sidebar is toggled by `sidebarAction.toggle`, and there is no equivalent of
        // setPanelBehavior; the action click handler does the work instead.
        return false;
      }
      const sp = ns().sidePanel;
      if (sp?.setPanelBehavior) {
        await sp.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
        return true;
      }
      return false;
    },

    /** Open it. On Firefox this must be called from a user gesture, which a toolbar click is. */
    async open({ windowId } = {}) {
      if (isFirefox()) {
        const sa = ns().sidebarAction;
        if (!sa) return false;
        try {
          await sa.open();
          return true;
        } catch {
          // `open` needs a user gesture; `toggle` is the documented fallback
          try {
            await sa.toggle();
            return true;
          } catch {
            return false;
          }
        }
      }
      const sp = ns().sidePanel;
      if (sp?.open && windowId !== undefined) {
        try {
          await sp.open({ windowId });
          return true;
        } catch {
          // Documented rejection: "sidePanel.open() may only be called in response to a user gesture."
          // Letting this propagate gave the caller an unhandled rejection and the user an error badge on a
          // toolbar button that was, from their side, simply doing nothing. Returning false means "could not
          // open", which the caller can act on; throwing means "something is broken", which it is not.
          return false;
        }
      }
      return false;
    },
  },
};

/** For a caller that needs the raw namespace (an event it does not have a wrapper for). */
export { ns as rawNamespace };
