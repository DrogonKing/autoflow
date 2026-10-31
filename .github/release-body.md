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
