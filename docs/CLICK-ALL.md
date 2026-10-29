# Clicking every match, not only the first

## The question that prompted this

> "if the buy button is named «ارسال پی در پی سفارش» and there are ten of them on the page, can the
> auto-clicker hit all ten, or does it stop after one?"

**It stopped after one.** Answered from the code, not from memory:

```js
// src/core/dom/finder.js
const index = finder.index ?? 0;
return { element: chosen[index], ... };   // one element, always
```

So one `click` step clicked `chosen[0]` - the first in **DOM order**, which is not necessarily the first on
screen - and the step was done. `finder.index` was not exposed in the panel either, so it was not adjustable.

## What was added

A per-step option on `click`: **Every match**. When off, the behaviour is unchanged. When on:

| Setting | Default | Why that default |
|---|---|---|
| Order | **last to first** | pressing one of these buttons usually makes the list shrink or re-render; consuming from the end means the indices still to come do not move. Taking from the top would re-click the first one. |
| At most | every match (`0`) | the honest default for a feature named "every match" |
| Gap | `250 ms` | a page needs a moment to process a click before the next one is safe |
| On error | stop | on an order page, continuing after a failure is worse than stopping |

## It re-resolves the list between clicks, and that is the whole design

The obvious implementation captures the matches once and clicks them in a loop. That is wrong here, in three
concrete ways:

1. A `NodeList` is **live** for some selectors and static for others, so iterating one while the page
   re-renders skips or double-clicks.
2. The element at index 3 **before** the first click is not the element at index 3 **after** it. On a list
   that collapses, index 3 stops meaning anything.
3. An exception on match 4 would abort the remaining six with no record of which ones were done.

So the loop re-queries before each click and always takes the same **position** from what is left. The order
and stopping rules live in `src/core/dom/clickAll.js`, which is pure, so the behaviour is provable without a
browser - and the loop itself is only the part that genuinely needs a DOM.

## Verified

`scripts/click-all-browser-test.mjs` runs three cases against a fixture page whose buttons **remove
themselves when pressed**, which is what a live order list does:

```
--- 1. every match ON: the same ten, each once ---
  presses: [10,9,8,7,6,5,4,3,2,1]
  remaining: 0
  ok   all ten were pressed
  ok   nothing was pressed twice
  ok   every button id 1..10 was pressed exactly once
  ok   the page is empty afterwards

--- 2. every match OFF: exactly one, which was the reported behaviour ---
  presses: [1]

--- 3. a limit of 3: exactly three ---
  presses: [10,9,8]
  remaining: 7
12/12 checks passed
```

Case 2 exists so the old behaviour is still covered: the fix must not have changed the ordinary single click.

And 24 unit tests cover the order, the limit, the gap floor, the stopping rule and the summary text - including
the case that proves why `forward` is not the default: given a collapsing list it clicks index 0 ten times.

## Where the feature is exposed

The panel shows it only on `click` steps, with the option stating what it will do rather than leaving the user
to infer it from a count. It carries an explicit warning, because pressing every match on a page with ten
identical buy buttons presses all ten:

> Careful: this presses every match. On a page with ten identical buy buttons it will press all ten. Test with
> the practice profile first.

## Honest limits

- **It presses each match once, in one step.** It is not a scheduler: if the page adds new buttons while it
  runs, those are seen and pressed too, because the list is re-read each time. `At most` bounds that.
- **A sanity ceiling of 200 clicks** exists regardless of settings, so a page that keeps producing new matches
  cannot spin forever. That ceiling is the thing standing between a bug and firing hundreds of orders.
- **The gap floor is 50 ms** and cannot be configured lower. A click that lands before the page processed the
  previous one is a wrong click, not a fast one.
- **It cannot tell whether an order was accepted.** "Pressed" is not "accepted" - a `wait for` step after this
  one is what proves it, and the panel's warning says so.
