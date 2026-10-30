/**
 * A real Chrome match-pattern matcher.
 *
 * MEASURED, with the previous implementation (`pattern.split('*').map(escape).join('.*')`):
 *
 *     https://www.example.com/page      -> match      correct
 *     https://example.com/              -> NO MATCH   wrong: Chrome's `*.` includes the bare domain
 *     https://example.com/dashboard     -> NO MATCH   wrong
 *     https://evil.com/x.example.com/y  -> MATCH      wrong, and dangerous
 *
 * That last row is the one that matters. The pattern `*://*.example.com/*` is the user saying "this site and its
 * subdomains"; the old regex turned it into `.*://.*\.example\.com/.*`, and the host part of a URL may not contain a
 * slash - so a URL whose PATH happens to contain the domain matched, on a completely unrelated host. In this extension
 * that means clicks and form fills could be delivered to a site the user never named.
 *
 * Chrome's own rules, implemented here:
 *   scheme  `*` means http or https; otherwise it must equal the URL's scheme
 *   host    `*` any host; `*.` the domain itself AND any subdomain; a leading `*` without a dot is also allowed
 *           (`*example.com`); the host part must not contain a slash
 *   path    `*` any characters; empty means "the site root and everything under it"
 *   <all_urls>  any URL the extension can act on
 *
 * Written as a parser rather than a regex substitution because the substitution is what went wrong: it never
 * distinguished the host from the path, and that distinction IS the rule.
 */

const ALL_URLS = '<all_urls>';

/** Schemes an extension can act on. `<all_urls>` covers exactly these. */
const ACTIONABLE_SCHEMES = new Set(['http', 'https', 'file', 'ftp']);

/**
 * Parse a match pattern into its parts, or return null when it is not one.
 *
 * A pattern whose host contains a slash is not a valid pattern, and is rejected rather than repaired - repairing is how
 * `*://*.example.com/*` came to match a URL on evil.com.
 */
export function parseMatchPattern(pattern) {
  const text = String(pattern ?? '').trim();
  if (!text) return null;
  if (text === ALL_URLS) return { allUrls: true };

  const schemeEnd = text.indexOf('://');
  if (schemeEnd <= 0) return null;

  const scheme = text.slice(0, schemeEnd).toLowerCase();
  const rest = text.slice(schemeEnd + 3);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;

  const host = rest.slice(0, slash);
  const path = rest.slice(slash);
  /**
   * A `file:` URL HAS NO HOST. `file:///root/x.html` is scheme + `//` + EMPTY authority + `/root/x.html`, so requiring a
   * non-empty host rejected every pattern that named a local file - and the pattern then matched nothing, which sent the
   * worker looking for another tab and clicking in a fresh copy of the page.
   *
   * An empty host is allowed only for a scheme that genuinely has none.
   */
  const hostless = host === '' && (scheme === 'file' || scheme === '*');
  if (!host && !hostless) return null;
  // a host cannot contain a slash, and a pattern that tries is not one
  if (host.includes('/')) return null;
  /**
   * A HOST MAY CARRY A PORT, so `:` and `[]` (IPv6 literals) are allowed here.
   *
   * MEASURED: this rejected every pattern containing a port - including a full URL used as its own pattern - and
   * returned null, so the pattern matched nothing at all. A specific page is the most natural pattern there is.
   */
  if (host && !/^[a-z0-9.*_:[\]-]+$/i.test(host)) return null;

  return { scheme, host: host.toLowerCase(), path };
}

/**
 * Does a URL match a pattern?
 *
 * The host is compared against the URL's hostname, so a domain in the PATH cannot satisfy it. This is the specific fault
 * the old implementation had.
 */
export function matchesPattern(url, pattern) {
  const parsed = parseMatchPattern(pattern);
  if (!parsed) return false;
  if (parsed.allUrls) {
    try { return ACTIONABLE_SCHEMES.has(new URL(url).protocol.replace(':', '')); } catch { return false; }
  }

  let u;
  try { u = new URL(url); } catch { return false; }

  const urlScheme = u.protocol.replace(':', '').toLowerCase();
  if (parsed.scheme === '*') {
    // Chrome's `*` is http or https only - not ftp, not file
    if (urlScheme !== 'http' && urlScheme !== 'https') return false;
  } else if (parsed.scheme !== urlScheme) return false;

  /**
   * COMPARE AGAINST THE HOST **AND PORT**, because a pattern may name one.
   *
   * MEASURED: a full URL used as its own pattern - `http://127.0.0.1:37883/` - did not match itself, because the pattern's
   * host part was compared against `u.hostname`, which has no port. A specific page is the most natural pattern there is,
   * so this made the field appear to accept a URL and then never match it.
   *
   * The rule: when the pattern's host names a port, the port must match; when it does not, any port is accepted (Chrome's
   * behaviour - a host pattern is about the host).
   */
  const urlHost = u.host.toLowerCase();
  const urlHostname = u.hostname.toLowerCase();
  const patternHasPort = /:\d+$/.test(parsed.host);
  const hostCandidate = patternHasPort ? urlHost : urlHostname;
  // a pattern that carries a port is matched against host:port; otherwise the bare hostname decides
  const patternHost = patternHasPort ? parsed.host : parsed.host.replace(/:\d+$/, '');
  if (!hostMatches(hostCandidate, patternHost)) return false;

  // trailing `*` is the common form (`/*`), and a bare `/` means the whole site
  if (parsed.path === '/*' || parsed.path === '/') return true;
  return pathMatches(u.pathname + u.search, parsed.path);
}

/**
 * The host rule, which is the whole reason this is a parser.
 *
 *   `*`             any host at all
 *   `*.example.com` the bare domain AND every subdomain - Chrome's rule, and the row the old code failed
 *   `*example.com`  any host ending in example.com without a dot requirement (Chrome allows it; rarely used)
 *   `example.com`   exactly that host
 */
function hostMatches(host, patternHost) {
  if (patternHost === '*') return true;

  if (patternHost.startsWith('*.')) {
    const bare = patternHost.slice(2);
    // `*.example.com` matches example.com and any depth of subdomain, but NOT notexample.com
    return host === bare || host.endsWith('.' + bare);
  }

  if (patternHost.startsWith('*')) {
    return host.endsWith(patternHost.slice(1));
  }

  return host === patternHost;
}

/** Path matching: `*` within the path is "any characters", anchored at both ends. */
function pathMatches(urlPath, patternPath) {
  if (!patternPath.includes('*')) return urlPath === patternPath || urlPath.startsWith(patternPath.endsWith('/') ? patternPath : patternPath + '/');
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = patternPath.split('*').map((part) => escape(part)).join('.*');
  try { return new RegExp(`^${body}$`).test(urlPath); } catch { return false; }
}

/** Any of the patterns matches. An empty list matches nothing - never "everything". */
export function matchesAny(url, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  return patterns.some((p) => matchesPattern(url, p));
}