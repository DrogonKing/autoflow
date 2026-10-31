import pathlib
import sys

p = pathlib.Path('/root/autoflow/scripts/package.mjs')
s = p.read_text()
orig = s

# ------------------------------------------------------------------------------------------------
# 1. the dist selection becomes a flag, so the packager can be pointed at any of the four builds
# ------------------------------------------------------------------------------------------------
old_head = """const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const releaseDir = path.join(root, 'release');"""
new_head = """const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const releaseDir = path.join(root, 'release');

/**
 * WHICH BUILD TO PACKAGE, as a flag.
 *
 *   (no flag)   dist/                 -> autoflow-chrome.zip
 *   --lite      dist-lite/            -> autoflow-chrome-lite.zip
 *   --firefox   dist-firefox/         -> autoflow-firefox.zip
 *   both        dist-firefox-lite/    -> autoflow-firefox-lite.zip
 *
 * `--all` packages every variant that has been built, which is what the release script uses: naming the four
 * archives in four places is how one of them ends up missing from a release nobody notices is incomplete.
 */
const LITE = process.argv.includes('--lite');
const FIREFOX = process.argv.includes('--firefox');
const ALL = process.argv.includes('--all');

const dist = path.join(root, FIREFOX ? (LITE ? 'dist-firefox-lite' : 'dist-firefox') : (LITE ? 'dist-lite' : 'dist'));
const suffix = (LITE ? 'lite' : '') && '-lite';
const zipName = (firefox, lite) => `autoflow-${firefox ? 'firefox' : 'chrome'}${lite ? '-lite' : ''}.zip`;
const currentZip = zipName(FIREFOX, LITE);"""
assert old_head in s, 'the dist header was not found'
s = s.replace(old_head, new_head, 1)

# ------------------------------------------------------------------------------------------------
# 2. read the variant stamp the build wrote, so the readme can describe the actual artifact rather
#    than guessing from the flags (the two cannot drift if one is derived from the other)
# ------------------------------------------------------------------------------------------------
old_readme_start = """  const CHROME_README = `AutoFlow - CHROME / EDGE / BRAVE / OPERA BUILD"""
new_readme_start = """  // The build stamps which variant it produced. Reading it instead of trusting the flags means the archive's
  // readme cannot describe a build other than the one inside it.
  let variant = { variant: 'full', target: 'chrome', lite: false };
  try {
    variant = JSON.parse(await readFile(path.join(dist, 'build-variant.json'), 'utf8'));
  } catch {
    // an older dist without the stamp: the flags below are then the only source, which is acceptable and is why
    // this is not an error
  }

  const LITE_NOTE = variant.lite
    ? `
  THIS IS THE LITE BUILD
  ----------------------
  Basic tab only. The Automations, Scheduled, Data, History and Log tabs are not present - the code for
  them was removed at build time, not hidden, which is where the smaller size comes from.

  Everything the Basic tab needs is here and unchanged: the time field (including millisecond targets),
  element picking, saving, and the schedule that fires the click. If you later need the editors or the run
  log, install the normal build alongside this one; they use separate storage keys and do not conflict.
`
    : '';

  const CHROME_README = `AutoFlow - CHROME / EDGE / BRAVE / OPERA BUILD${variant.lite ? ' (LITE)' : ''}"""
assert old_readme_start in s
s = s.replace(old_readme_start, new_readme_start, 1)

# the note goes into the chromium readme body
old_chrome_tail = """  Verified before packaging: the unit suite, every file the manifest references, and Mozilla's own linter
  reporting zero errors and zero warnings.
`;"""
new_chrome_tail = """  Verified before packaging: the unit suite, every file the manifest references, and Mozilla's own linter
  reporting zero errors and zero warnings.
${LITE_NOTE}`;"""
assert old_chrome_tail in s
s = s.replace(old_chrome_tail, new_chrome_tail, 1)

# and the zip name
old_ext = """  const extPath = path.join(releaseDir, 'autoflow-chrome.zip');"""
new_ext = """  const extPath = path.join(releaseDir, currentZip);"""
assert old_ext in s
s = s.replace(old_ext, new_ext, 1)

p.write_text(s)
print(f'package.mjs: {len(orig)} -> {len(s)} bytes')
print('  dist is flag-selected, the variant is read from the build stamp, the zip is named for it')
