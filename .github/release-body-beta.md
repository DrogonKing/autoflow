> ## ⚠️ BETA — not fully tested
>
> This build carries a change that has **not been exercised against a real trading site yet**.
>
> The millisecond scheduler is verified in a controlled browser run — a target of `21:21:15.384` was clicked at
> `21:21:15.409`, so the fraction is demonstrably honoured rather than rounded away. What is **not** proven is the
> end-to-end path against a live exchange: the ping, the site's own latency, and a real order button.
>
> **Test with a target you do not mind missing.** Keep the previous version's backup, and set a throwaway time first.
>
> Two things worth knowing before you rely on it:
> - A **background tab is throttled** by the browser to roughly one timer per second, which no page can override. The
>   sub-30 ms accuracy only works while the tab is visible.
> - **MV3 clamps an alarm that is less than ~30 s away**, so a target only seconds ahead can fire late by design. Set
>   the time minutes ahead, not seconds.
>
> The manifest version is a plain number (`1.29.0`) because Chrome requires 1–4 integers and rejects a suffix like
> `-beta` with "Invalid version format". The tag and the prerelease flag carry the beta signal, not the version string.

## Install

**Chrome / Edge / Brave / Opera** — download `autoflow-chrome.zip`, unpack it, then
`chrome://extensions` → enable Developer mode → **Load unpacked** → pick the unpacked folder.

**Firefox** — download `autoflow-firefox.zip`. A permanent install requires Mozilla's signature,
which this archive does not have, so for now use
`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick `manifest.json`
inside the unpacked folder. Temporary add-ons are removed when Firefox closes.

**Source** — `autoflow-source.zip` is the full tree, including the tests and the security scripts.

Verified before this archive was produced: the unit suite, both manifests' referenced files, and
Mozilla's own linter reporting zero errors and zero warnings.
