# Findings from the outside review of 1.7.0, checked one by one

The report was written without npm, without vitest and without loading the extension, and it labels each item
`[اجرا شد]` (proven by a test) or `[خواندن کد]` (read from the code). Every claim was re-checked here against the
actual behaviour, and each fix has a test that fails against the old code.

## Confirmed and fixed

### Conditions from the page were always false — the most serious finding

`host.readCondition` is `async`, so `ctx.read(condition)` returns a Promise. `evaluateCondition` read
`.value`/`.found`/`.flags` off that Promise — all `undefined` — so every page-sourced condition was false, and
`if`/`while`/`waitFor` on page state always took the false branch. Comparing a Promise also *threw* for value
comparators, which a run recorded as a step error.

Reproduced first: `tests/conditions-async.test.js` failed against the old code with
`comparator "eq" needs a value to compare against`.

Fix: `evaluateCondition` is `async` and awaits its two `read` sites, and the `also` tree is awaited one branch at a
time rather than with `Promise.all` — a nested tree reads the page, so firing every branch at once would send one
message per sub-condition when the answer is already decided. A synchronous `read` still works, because `await` on a
non-Promise is the value.

### Retry re-ran whole loops

Retries wrap `#dispatch`, and for `loop`/`if` a dispatch executes the **entire body**. One transient error inside a
five-iteration loop re-ran the iterations that had already succeeded — the report measured 8 clicks from a 5-iteration
loop. Block steps are now never retried; their body's own steps still retry individually, which is where a transient
failure actually lives.

### The clock offset leaned 500ms one way

The `Date` header truncates to whole seconds, so a stamp of `…000` means a moment somewhere in that second — on
average 500ms *before* the instant it was treated as. A machine whose clock was exactly right was reported as ahead in
about half of all measurements.

Measured over a sweep of all 1000 sub-second phases, with the clocks synchronized:

```
with no correction : mean -499.50ms   (the lean the report measured)
with +500ms        : mean    +0.50ms  (says ahead 500, says behind 499, exact 1)
```

The samples are also spread out now (a pause between them) so the median removes something instead of only looking
stable, and each request has an 8s timeout — a hanging server used to leave the panel waiting forever.

### The anchor exception list was unanchored

`/v-|ng-/` matched those characters anywhere, so `data-nav-id`, `data-dev-id`, `data-pricing-plan`,
`data-loading-key` and `data-setting-id` were all silently discarded as anchor candidates. Measured with the old
pattern: all five rejected. The pattern is now anchored to the start of the attribute name.

### Upload never worked

The content script sends `read-file-for-upload`, and it was not in `CONTENT_SCRIPT_MESSAGES`, so every upload step was
refused. Added — and it is safe: the name is looked up in the extension's own stored uploads, so a page cannot use it
to read anything the user did not already put there.

### Download threw in Chrome

`URL.createObjectURL` does not exist in a Manifest V3 service worker. Replaced with a data URL, built by a helper that
reads the blob through `FileReader` rather than `String.fromCharCode(...bytes)`, which blows the argument limit at a
few tens of kilobytes.

### URL patterns with `*` matched the wrong tabs

The old code removed the stars and used `includes`, so `https://x.test/order/*` searched for
`https://x.test/order/` — a different URL space — and a pattern of a single `*` became the empty string, which matched
**every** tab. Patterns are compiled to regexes now, with a no-wildcard pattern treated as a prefix.

### A failed start cancelled the schedule

The next occurrence was armed only on the success path, so one failed start silently ended the schedule. It is now
re-armed in the failure path too — a schedule is a standing instruction and one missed attempt does not cancel it.

### `file://` pages were classified as internal

`classifySender` fell through to `internal` — the most privileged class — for `file://`, `ftp://`, `data:` and
`blob:`. A page opened from disk could send anything the panel can. The user's own test field is a `file://` page,
so this was live, not theoretical.

### The retry sent the unsanitised message

`sendToTab`'s retry re-sent `message` instead of `safeMessage`, so a value that needed sanitising for the wire could
fail the retry for a reason unrelated to the missing content script it exists for.

### Click-all's ceiling was lower than the validation allowed, and silent

`CEILING = 200` in the content script while the panel validated up to 5000, so a limit of 3000 announced "all 200
clicked" with `stoppedEarly: false`. The result now carries `hitCeiling` and says so in `how`.

## Not changed, and why

- **`order: 'as-is'` behaves like `forward`.** True, and deliberate: "as-is" means "in the order the page shows
  them", which is forward. The label is what is misleading, not the behaviour.
- **`onError: 'skip'` behaves like `continue`.** Also true and also deliberate at the step level; the difference is
  intended to be about *what is reported*, and it is not currently different. Worth tightening, not a defect.
- **The alarm's 30-second floor for packed extensions.** Not reproducible here without a real packed build. Recorded
  as unverified rather than guessed at.
- **`element-pick-cancelled` is unhandled.** The panel already clears its pick target on `element-picked`; a cancel
  leaves the banner up until the user dismisses it. Minor.
- **Import with `replace` can clear everything.** It is the documented meaning of `replace`, and the import path
  audits before writing. Left as designed, but noted.
