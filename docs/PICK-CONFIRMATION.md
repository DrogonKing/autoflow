# The Pick confirmation belongs to one point

Reported, visual only:

    "گزینه pick وقتی سبز میشه برای همه ی pickهای از قبل ساخته شده هم سبز میشه در حالی که
     فقط اونی که انتخاب شده باید سبز بشه"

When it goes green, all the previously created picks go green too, when only the selected one should. The behaviour was
correct; the colour was not.

## One line

```js
const justPicked = state.pickSavedAt && state.pickTarget === null && Date.now() - state.pickSavedAt < 2500;
//                   ^ a TIMESTAMP with no record of which point it belonged to
```

`pickTarget` is null once a pick lands, so that condition was true for **every** Pick button on the panel and all of them
confirmed at once. `pickSavedFor` now carries the identity, exactly as `pickTarget` already did for the picking state.

**The test asserts the property, not the example:** the number of green buttons after a pick must be **exactly one**, and
it must be the point that was picked. It also reproduces the old rule and shows it greening all three points, so the fix
cannot silently regress if the identity is dropped again - and it needs **three** points to see the fault at all, which
is why the single-point checks could not have caught it.

## Two more faults found while verifying it

**1. The green never cleared.** The confirmation is computed when the view is built, and nothing rebuilt the view
afterwards, so the button stayed "✓ Picked" indefinitely. A timer was the obvious fix and the first version did not work:
it updated `btn` directly, and **the pick itself triggers a re-render**, so the node the timer held had been replaced and
the update landed on an element nobody could see. Measured - every sample from 300 ms to 3500 ms read "✓ Picked".

The fix is to address the button by the point it belongs to rather than by object identity:

```js
const live = document.querySelector(`main button.pick[data-step-id="${step.id}"]`);
```

which is independent of which render produced it. A re-render is the wrong instrument here: rebuilding the view 1.5
seconds after a pick would replace a time field the user may be typing in, which is a fault this panel has already had
once.

**2. The build was failing and nobody was looking.** `finder.positionalTitle` was defined twice in each language table -
the second entry silently wins in a JS object literal, so the English table was serving the Persian text. That was a real
bug, and the more serious one was process: the build reported it as a warning, my commands discarded stderr with
`2>/dev/null`, and the browser tests then ran against a **stale `dist/`** - which is how "the attribute is in the source
but not in the DOM" happened. The build's own exit status is now what the checks read, and a duplicate key is treated as
a failure rather than a note.

## Verification

`pick-confirm-test` 10/10, three consecutive runs:

```
3 points, no pick yet          0 green of 3
pick the second point          1 green of 3, and it is index 1
the green is really rendered   rgb(46, 160, 67), not only a class
the confirmation expires       after the window, 0 green
points 1 and 3 untouched       still idle
```
