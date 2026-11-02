import { describe, it, expect } from 'vitest';
import { verifyLabel } from '../src/core/dom/actions.js';

/**
 * A RECORDED LABEL IS VERIFIED BEFORE A CLICK.
 *
 * MEASURED by `scripts/security-click-integrity-test.mjs`: a page that replaced its own button with a different element
 * carrying the same `id` received the click (`buy=0 evil=1`), and so did a swap that happened after the run had resolved
 * the element. The finder is an anchor - an attribute and its value - and re-resolving it finds whatever now holds that
 * anchor, so the label the picker already recorded was the one piece of evidence available and it was never compared.
 *
 * On a trading page, "click buy" landing on a control the user did not choose is the exact failure the recorded text exists
 * to catch. The check is deliberately narrow: it does nothing when no label was recorded, so nothing that works today
 * starts failing.
 */

/** A minimal element stand-in: `accessibleName` reads textContent, aria-label, value and placeholder. */
const el = (props = {}) => ({
  nodeType: 1,
  tagName: props.tagName ?? 'BUTTON',
  textContent: props.textContent ?? '',
  value: props.value,
  getAttribute: (name) => props.attrs?.[name] ?? null,
  hasAttribute: (name) => Boolean(props.attrs?.[name]),
  labels: props.labels ?? [],
  classList: [],
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }),
});

describe('verifyLabel — refusing to click an element that changed', () => {
  it('passes when the label is unchanged', () => {
    const button = el({ textContent: 'BUY 100 shares' });
    expect(verifyLabel(button, { label: 'BUY 100 shares' }).ok).toBe(true);
  });

  it('refuses when the text was swapped for a different promise', () => {
    const button = el({ textContent: 'SELL 100 shares' });
    const result = verifyLabel(button, { label: 'BUY 100 shares' });
    expect(result.ok).toBe(false);
    expect(result.expected).toBe('BUY 100 shares');
    expect(result.found).toBe('SELL 100 shares');
  });

  it('does nothing when no label was recorded', () => {
    // the essential property: every point recorded before this feature, and every point on an unlabelled element, behaves
    // exactly as it did — a check that starts refusing valid clicks would be worse than the risk it addresses
    const button = el({ textContent: 'anything at all' });
    expect(verifyLabel(button, {}).ok).toBe(true);
    expect(verifyLabel(button, { label: '' }).ok).toBe(true);
    expect(verifyLabel(button, { label: '   ' }).ok).toBe(true);
    expect(verifyLabel(button, null).ok).toBe(true);
    expect(verifyLabel(button, undefined).ok).toBe(true);
  });

  it('is not fooled by a re-render that only changes whitespace', () => {
    const button = el({ textContent: 'BUY   100\n shares ' });
    expect(verifyLabel(button, { label: 'BUY 100 shares' }).ok).toBe(true);
  });

  it('reads the accessible name, so an aria-label is honoured', () => {
    const button = el({ attrs: { 'aria-label': 'Place buy order' }, textContent: '' });
    expect(verifyLabel(button, { label: 'Place buy order' }).ok).toBe(true);
    expect(verifyLabel(button, { label: 'Place sell order' }).ok).toBe(false);
  });

  it('an element with NO accessible name is never refused', () => {
    /**
     * MEASURED: `accessibleName` returns '' for an INPUT that has a value but no label, aria-label, title or text - the
     * usual case for a quantity or price field. Treating that as a mismatch would refuse every legitimate click on such an
     * element, and for a trading clicker a false refusal is a missed order. So an empty name means "nothing to compare",
     * not "the element changed". This test locks that in, because it is the difference between a safeguard and a hazard.
     */
    const field = el({ tagName: 'INPUT', value: '100', attrs: { placeholder: 'quantity' } });
    expect(verifyLabel(field, { label: '100' }).ok).toBe(true);
    expect(verifyLabel(field, { label: '250' }).ok).toBe(true);
    // and a field that DOES have a name is still checked
    const labelled = el({ tagName: 'INPUT', value: '100', attrs: { 'aria-label': 'quantity' } });
    expect(verifyLabel(labelled, { label: 'quantity' }).ok).toBe(true);
    expect(verifyLabel(labelled, { label: 'price' }).ok).toBe(false);
  });
});