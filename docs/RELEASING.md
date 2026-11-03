# Release flow

**Rule: every change ships as `-beta` first. A stable release happens only after the user confirms the beta works on the
real page.** Nothing is promoted to stable on the strength of the test suite alone — the suite proves the code behaves, not
that it behaves on the trading site.

## Why the tag name decides it

CI derives GitHub's `prerelease` flag from the tag name:

```
tag  v1.40.0-beta   →  prerelease: true    excluded from "latest release", badge on the page
tag  v1.40.0        →  prerelease: false   becomes "latest release"
```

The flag is the mechanism; the name is the convention that drives it. `.github/workflows/build.yml` also selects the
release body from the tag, so a beta always carries the beta warning.

The manifest version stays a plain `X.Y.Z`: Chrome rejects a semver suffix with *"Invalid version format"*. So the beta
signal lives in the tag and the flag, never in the version string.

## The two steps

**1. Beta**

```bash
# bump + build all four + package + tests + browser suites, then tag vX.Y.Z-beta
bash /root/release-X.Y.Z-beta.sh
```

Hand the user `release/autoflow-chrome.zip` and wait. What the beta is for is the one thing no harness here can prove: a
real run against the real page.

**2. Stable — only after the user says it works**

```bash
bash /root/release-X.Y.Z.sh
```

Same script shape, tag without the suffix. The release body for a stable build is `.github/release-body.md` and should
carry:

- what the beta measured, with the numbers;
- **the honest scope**: anything not proven, stated rather than omitted;
- known limits, including the ones that are the platform's rather than ours.

## What a beta must be accompanied by

From the faults found in this project, a beta is only worth shipping if:

- every claim in the notes is backed by a suite that **fails without the fix** — revert the fix and watch it go red;
- the suite result in the notes is the real one, never a filtered or interpreted one;
- a bug report from anyone (including a review from another model) is **reproduced before being accepted**, because several
  turned out to be the reporter's own harness error;
- the build is a **clean** build. A stale `dist/` hid a real bug twice.

## When the beta is rejected

The user reports what is wrong; it is reproduced first, then fixed, then a **new beta** is tagged. A stable tag is never
moved or re-pointed to hide a bad release — that is what the beta step is for.
