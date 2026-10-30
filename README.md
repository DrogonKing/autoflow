# AutoFlow

Auto-click, fill, record and **schedule** browser automations.
**Chrome, Edge and Firefox** (Manifest V3), from one source.

Verified in a real browser on both engines: 372 unit tests, 20 Chromium load checks, 26 Chromium
end-to-end checks, **31 Firefox checks**, and Mozilla's own linter reporting 0 errors and 0 warnings.

Built after studying what a paid autoclicker extension actually does — including its scheduling, its
loops and conditions, and its failure modes — with two differences: no telemetry, and nothing locked
behind a subscription.

---

## What it does

**Steps** — 32 of them, composable:

| Group | Steps |
|---|---|
| Act | click (left/right/middle, 1–3 clicks), fill, clear, check/uncheck, select, hover, focus, blur, submit, scroll, press keys (with a per-key gap) |
| Wait | wait (fixed), wait for a condition (polls until it holds or times out) |
| Navigate | go to URL, reload, back, forward, open tab, switch tab, close tab |
| Control | loop (count / while / for each), if/else, break, continue, stop |
| Data | set variable, extract from the page, run a script, download, upload, screenshot |
| Tell | notify, sound |

**Finding elements** — ten strategies, because one never survives a real site: CSS, XPath, text, id,
name, label, placeholder, aria-label, role, and a point on the page. Each step also carries a **fallback
chain** recorded when you pick the element, so a redesign does not break an automation that used to work.

**Scheduling** — the part worth having:

- **Once** at a date and time
- **Every N** seconds / minutes / hours, with an optional stop time
- **Daily** at a clock time
- **Weekly** on chosen weekdays
- **Monthly** on a day (1–28, so every month has it)
- **Cron** — five fields, local time

Every schedule shows a live preview: the sentence, plus the next three fire times.

**Data** — load a CSV and drive the run from it. `${row.email}` or just `${email}`. Loop over the rows.

**Templates** — `${var}`, `${row.column}`, `${now.date}`, `${now+1d.date}`, `${random.email()}`,
`${random.int(1,10)}`, `${value|default:fallback}`.

**Recording** — click "Pick" on a step, then click the element on the page. The finder is built for you
with a fallback chain.

---

## Install (unpacked)

1. `npm install && npm run build`
2. Open `chrome://extensions`, turn on **Developer mode**
3. **Load unpacked** → select the `dist/` folder
4. Click the toolbar icon to open the side panel

For Edge: `edge://extensions`, same steps.

> Store packaging needs a signed `.zip` from a developer account. Loading unpacked is what the tests do
> and what you can do right now.

---

## Tests

```
314 unit tests           npm test
26  real-browser checks  npm run test:e2e       (loads the extension in Chromium)
20  load/UI checks       npm run test:browser   (manifest, worker, panel, options)
```

The browser tests are the ones that matter, because an extension can pass every unit test and still fail
to load. They run against the real Chromium already on this machine, with a local HTTP server, and assert
observable effects on a real page: the counter moved by exactly six, the page's own event listeners fired,
the extracted values came back, and a scheduled alarm fired **by itself** within twelve seconds.

Notable bugs those tests caught, all of which unit tests missed:

- **A step's failure was recorded as success.** Page-side steps answer with an envelope `{ok, error}`; the
  host passed it through without unwrapping, so a missing element, a rejected fill and a timed-out
  `waitFor` all looked like `step-ok` and the run reported "finished".
- **Every extracted value was `[object Object]`** — same cause: `extract` read the envelope, not the value.
- **`observe()` read `elements` from a result that returns `element`**, so every condition said "not found"
  and a count condition threw.
- **The scheduler could not report a broken schedule.** `describeSchedule` validates, and it sat outside
  the `try`, so one invalid schedule made the whole status call throw.
- **One corrupt stored record hid every automation** — the list mapped over all of them.

---

## Scheduling correctness

The scheduler is pure and separately tested (58 tests), because scheduling bugs are arithmetic bugs and
arithmetic is testable:

- **DST.** A daily 09:00 stays at 09:00 across a transition. The tests drive a real zone
  (`America/New_York`) with a spring-forward and a fall-back, and assert no day fires twice, no fire is in
  the past, and a 30-minute schedule stays on its boundaries through both.
- **Missed slots are skipped, not replayed.** If the browser was closed for an hour, an every-minute
  schedule fires once, not sixty times.
- **Impossible schedules return `null` instead of looping.** `0 0 31 2 *` is 31 February; the minute-walk
  has a bounded horizon and reports that nothing will fire.
- **A weekly schedule with no days, or a monthly day of 31, is refused** rather than silently skipped.
- **A `while` loop requires a maximum iteration count**, so it cannot run forever in your browser.

---

## Permissions, and why

| Permission | Why it is needed |
|---|---|
| `<all_urls>` | the whole point: act on whatever page you point it at |
| `tabs`, `scripting` | navigate, and inject into a page that was open before install |
| `alarms` | the scheduler. MV3 has no other way to fire when the service worker is asleep |
| `storage`, `unlimitedStorage` | automations, settings, history; CSV rows live in `session` so they do not persist |
| `sidePanel` | the UI |
| `notifications` | the notify step |
| `downloads` | the download and screenshot steps |
| `webNavigation` | detect a page change so a step does not run against the old page |

**No analytics, no remote calls, no account.** The reference extension sends Google Analytics events,
talks to Firebase and an OpenTelemetry endpoint, and gates features behind a subscription. This one does
none of that: there is no network code in it at all.

---

## Limits, stated plainly

- **Chromium only.** Firefox is possible with two substitutions (`sidePanel` → `sidebar_action`,
  `userScripts` → `scripting`), but it is not done and not tested here.
- **Safari needs macOS.** It requires a converter run with Xcode and an Apple developer account. Not
  attempted.
- **`runScript` runs in the page's world**, not the extension's, so it can read page globals but cannot
  reach extension APIs.
- **A background tab may be throttled by Chrome**, which can make a long `wait` overshoot. The runner
  recomputes its deadline from elapsed time, so a run does not drift, but individual steps can be late.
- **The picker records a chain, not a guarantee.** A site that rebuilds its DOM every render can still
  defeat it; the chain gives four or five chances rather than one.

---

## Layout

```
src/
  core/            pure, no chrome APIs, fully unit-tested
    schedule/      when to run — the DST and cron logic
    model/         steps, templates
    engine/        the runner and the condition evaluator
    io/            CSV
    dom/           finding elements, performing actions
  background/      the service worker: runner host, alarms, storage
  content/         the page side: performs steps, the element picker
  ui/              side panel and options page
  manifest.json
tests/             314 unit tests
scripts/           build, icons, browser tests, packaging
```
---

## Building from GitHub

CI runs on every push and produces both zips. A tag produces a release with them attached.

```
git clone <repo>                              # or download the source zip
cd autoflow
npm ci                                        # from package-lock.json, the step CI uses
npm run build:all                             # dist/ (Chrome/Edge) + dist-firefox/ (Firefox)

npm run package                               # release/autoflow-chrome.zip + -firefox.zip + -source.zip
```

| Job step | What it proves |
|---|---|
| `npx vitest run` | 381 unit tests |
| `npm run build:all` | both targets build from the checkout alone |
| manifest check | `manifest_version: 3` on both, and every file each manifest references exists |
| `web-ext lint` | Mozilla's own linter: 0 errors, 0 warnings |
| the three audits | static security scans, deterministic, one exits non-zero on a critical or high |
| the packet + exhibit checks | the review packet is complete and every line number in it matches the source |
| `npm run package` | the three zips, with `manifest.json` at the root of each |

### Verifying the build without trusting it

The zips are ordinary zip files with `manifest.json` at the root, so a reviewer can read any file in them:

```
unzip -l release/autoflow-chrome.zip
unzip -p release/autoflow-chrome.zip manifest.json    # the actual manifest that ships
unzip -p release/autoflow-firefox.zip manifest.json   # the Firefox one, for comparison
```

And the no-network claim is a test, not a promise. `scripts/firefox-security-test.mjs` starts an HTTP server,
runs a full automation against a page on it, and counts every request the server receives:

```
the run produced ZERO requests to the probe origin      0 during the run
the probe server saw 2 requests in total:
   GET /             <- the test page load itself
   GET /favicon.ico  <- the browser asking for a favicon
```

### What CI does NOT run, and why

The browser tests are a **local** gate: `npm run test:browser`, `test:e2e`, `test:firefox`, and
`test:security` need a real Chromium or Firefox plus geckodriver. They are doable on a GitHub runner but make
the job minutes long and flaky, and a flaky gate gets ignored. What CI proves is that the code builds, the
logic is correct, both manifests are well formed, and Mozilla's linter accepts the Firefox build. The
browser-level behaviour was verified on this machine: 20 load checks and 27 end-to-end checks in Chromium,
31 functional and 10 security checks in Firefox 159.

### Bumping the version

The version lives in four files that different consumers read, so a partial bump ships a manifest, a package
and a filename that disagree. Use the script:

```
scripts/bump-version.sh 1.18.0     # package.json, src/manifest.json, options page, README
git tag v1.18.0 && git push --tags # the release workflow attaches the zips
```

---

## Releases

Every `v*` tag produces a release with the three archives attached, built by CI from that commit:

```
https://github.com/DrogonKing/autoflow/releases/latest
```

Direct downloads (once the repo is public, or with access to it):

```
.../releases/download/v1.18.0/autoflow-chrome.zip     Chrome, Edge, Brave, Opera
.../releases/download/v1.18.0/autoflow-firefox.zip    Firefox
.../releases/download/v1.18.0/autoflow-source.zip     full source, tests included
```

### Which file do I download?

| Your browser | File | How to install |
|---|---|---|
| **Chrome, Edge, Brave, Opera** | `autoflow-chrome.zip` | unpack it, then `chrome://extensions` → Developer mode → **Load unpacked** → select the unpacked folder |
| **Firefox** | `autoflow-firefox.zip` | unpack it, then `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → select `manifest.json` inside the unpacked folder |
| either, to read the code | `autoflow-source.zip` | the whole tree, tests and security scripts included |

To confirm which build a zip is, read the manifest inside it rather than trusting the name:

```
unzip -p autoflow-chrome.zip manifest.json   # "service_worker" and "side_panel"  -> Chromium
unzip -p autoflow-firefox.zip manifest.json  # "scripts" and "sidebar_action"    -> Firefox
```

### Two things CI caught that a local run could not

Recorded because both are the kind of failure that looks like something else.

**1. Node 20 fails while reporting success.** jsdom 30 calls `zlib.createZstdDecompress`, added in Node 22.19.
On Node 20 that is `undefined`, so jsdom throws 11 unhandled errors, **all 381 tests still report as passed**,
and `vitest run` exits 1. The workflow was on Node 20 and the local tree on Node 24, where the failure never
appears. Measured after the fact:

| Node | Result |
|---|---|
| 20.19.0 | **fails** — 11 unhandled jsdom errors, exit 1, every test reported passed |
| 22.22.0 | 381/381 passed |
| 24.22.2 | 381/381 passed |

Fixed by moving the workflow to Node 22 and adding `scripts/preflight.mjs`, which checks for the missing
`zlib` function and prints one clear sentence. It runs as `pretest`, so the confusing failure cannot recur.

`engines` is **advisory, not enforced**: `engine-strict` was tried and reverted, because jsdom and its
css-color dependency both declare `^22.22.2 || ^24.15.0 || >=26` — so enforcing would refuse Node 22.22.0,
a version measured working. A declared range stricter than the behaviour is common; enforcing it invents a
restriction the project does not have.

**2. The release step 403s after fourteen green steps.** A workflow with no `permissions:` block inherits the
repository's default `GITHUB_TOKEN` scopes, which is read-only for a repository created through the API. Every
step passed and only `attach the zips to the release` failed. Fixed with an explicit
`permissions: contents: write`, plus `fail_on_unmatched_files: true` so a missing asset is an error rather
than a release carrying two of its three files.

### Scripts

| Script | Purpose |
|---|---|
| `scripts/preflight.mjs` | one clear sentence instead of a confusing jsdom failure |
| `scripts/secret_scan.py` | refuses to publish a live credential; run before any push |
| `scripts/ci_status.py` | the recent runs, and every step of the newest completed one |
| `scripts/ci_why.py` | the failing step of a run, and its log |
| `scripts/bump-version.sh` | the four files that carry the version, updated together |
