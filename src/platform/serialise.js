/**
 * Make a value safe to send over a message port.
 *
 * A runtime message is structured-cloned, and a function cannot be cloned. That is easy to hit without
 * meaning to, because a value read out of a page is not under our control:
 *
 *   - a plain <div> has `value === undefined`, but a page can define `value` as a function
 *   - an object read from the page can carry methods
 *   - a mistake in a branch can return the function itself (`getAttribute`, not its result)
 *
 * Chromium drops such a property quietly, so the bug surfaces as a missing field. Firefox throws
 * "Function object could not be cloned" and the whole step fails. Neither is acceptable, and neither
 * explains itself, so this function converts the value into something cloneable and reports what it
 * changed.
 *
 * It is deliberately shallow-ish but complete: nested objects and arrays are walked, a function becomes a
 * short marker string, a symbol and a bigint become strings, and a cycle is cut rather than throwing.
 */

const FUNCTION_MARKER = '[function]';

export function makeCloneable(value, { maxDepth = 12 } = {}) {
  const removed = [];
  const seen = new WeakSet();

  const walk = (node, depth, path) => {
    if (depth > maxDepth) return '[too deep]';
    if (node === null || node === undefined) return node;

    const t = typeof node;
    if (t === 'function') {
      removed.push(path || '(root)');
      return FUNCTION_MARKER;
    }
    if (t === 'symbol') return String(node);
    if (t === 'bigint') return node.toString();
    if (t !== 'object') return node;

    // DOM nodes are not cloneable either; describe rather than fail
    if (typeof Node !== 'undefined' && node instanceof Node) {
      removed.push(`${path || '(root)'} (a DOM node)`);
      return `[${node.nodeName?.toLowerCase?.() ?? 'node'}]`;
    }
    if (seen.has(node)) return '[circular]';
    seen.add(node);

    if (Array.isArray(node)) {
      return node.map((item, i) => walk(item, depth + 1, `${path}[${i}]`));
    }

    // a Map or Set is cloneable, but its contents may not be
    if (node instanceof Map) {
      return Object.fromEntries([...node.entries()].map(([k, v], i) => [String(k), walk(v, depth + 1, `${path}.<${i}>`)]));
    }
    if (node instanceof Set) {
      return [...node.values()].map((v, i) => walk(v, depth + 1, `${path}.<${i}>`));
    }

    const out = {};
    for (const key of Object.keys(node)) {
      out[key] = walk(node[key], depth + 1, path ? `${path}.${key}` : key);
    }
    return out;
  };

  const result = walk(value, 0, '');
  return { value: result, removed };
}

/**
 * Send over a port, sanitising first if the direct attempt fails.
 *
 * The fast path is the direct send, because it is the common case and copying every payload would be
 * wasteful. On failure the payload is rebuilt and the send is retried, and the replacement reports itself
 * through a `note` so the reason is not lost.
 */
export function safeSend(send, payload, label = 'the reply') {
  try {
    send(payload);
    return { sent: true, sanitised: [] };
  } catch (firstError) {
    const { value, removed } = makeCloneable(payload);
    const withNote = (value && typeof value === 'object' && !Array.isArray(value))
      ? { ...value, note: `${label} contained ${removed.length} value(s) that cannot cross a message port`
        + ` (${removed.slice(0, 4).join(', ')})` }
      : value;
    try {
      send(withNote);
      return { sent: true, sanitised: removed, firstError: String(firstError?.message ?? firstError) };
    } catch (secondError) {
      return { sent: false, sanitised: removed, firstError: String(firstError?.message ?? firstError),
        secondError: String(secondError?.message ?? secondError) };
    }
  }
}

/**
 * Keep something cloneable even if the other end is strict about it.
 *
 * Used for the direction service worker -> content script, where the payload is a step the runner built
 * and could in principle have been given a value from a page or from user input.
 */
export function cloneableOrString(value) {
  try {
    if (typeof structuredClone === 'function') {
      structuredClone(value);
      return value;
    }
  } catch {
    // fall through to the sanitised version
  }
  return makeCloneable(value).value;
}
