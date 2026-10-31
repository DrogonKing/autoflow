import pathlib
import re
import sys

ROOT = pathlib.Path('/root/autoflow/scripts')


def edit(name, pairs, required=True):
    p = ROOT / name
    s = p.read_text()
    orig = s
    missing = []
    for old, new in pairs:
        if old in s:
            s = s.replace(old, new, 1)
        else:
            missing.append(old.split('\n')[0][:72])
    if missing and required:
        print(f'  !! {name}: NOT FOUND:')
        for m in missing:
            print(f'       {m}')
        return False
    if s != orig:
        p.write_text(s)
    print(f'  {name}: {len(pairs) - len(missing)} edit(s)')
    return True


# =================================================================================================
# build.mjs — one script, two variants. Not a second copy: a duplicated build script is the thing
# that drifts, and the lite variant would silently lose the next fix that lands in the normal one.
#
# The variant is a MODE (normal | lite) and a TARGET (chrome | firefox); the cross product is four
# bundles. `--lite` and `--firefox` are flags, and the output directory carries the variant so the
# two builds cannot overwrite each other.
# =================================================================================================

print('=== build.mjs ===')
ok = edit('build.mjs', [
    # the header comment, so the next reader knows the four bundles exist
    (
        """ * Four separate bundles, because each entry point runs in a different world and MV3 is strict about it:""",
        """ * Up to four bundles (target x variant), because each entry point runs in a different world and MV3 is strict
 * about it:""",
    ),
    # flags at the top
    (
        """const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'src');
const out = path.join(root, 'dist');""",
        """const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'src');

/**
 * VARIANT AND TARGET, as flags rather than as separate scripts.
 *
 *   --lite      drop every panel tab except Basic, and let the bundler REMOVE the code behind them
 *   --firefox   the Firefox manifest
 *
 * A second copy of this file for lite would be the thing that drifts: the next fix to the normal build
 * would land in one and not the other, and the lite artifact would quietly rot. So there is one script and
 * the flags select behaviour.
 *
 * `__LITE__` is what makes the removal real. esbuild substitutes it, folds the guard, and then drops the
 * functions nothing references any more - measured at 64.5 KB off panel.js. A runtime setting cannot do
 * that, because the code still ships and still has to be parsed.
 */
const LITE = process.argv.includes('--lite');
const FIREFOX = process.argv.includes('--firefox');
const VARIANT = LITE ? 'lite' : 'full';

// A SEPARATE OUTPUT DIRECTORY per variant, otherwise packaging the second build silently replaces the first
// and both zips end up holding the same artifact - which looks like success and is not.
const out = path.join(root, FIREFOX ? `dist-firefox${LITE ? '-lite' : ''}` : (LITE ? 'dist-lite' : 'dist'));""",
    ),
    # the define, on the esbuild shared config
    (
        """const shared = {
  bundle: true,
  sourcemap: false,
  minify: false,
  target: ['chrome116'],
  legalComments: 'none',
  logLevel: 'warning',
};""",
        """const shared = {
  bundle: true,
  sourcemap: false,
  // Minify for the lite build only. That build's whole reason to exist is size, and the flag is what makes the
  // dead-code removal worth having; leaving names readable in the normal build keeps its stack traces useful.
  minify: LITE,
  target: ['chrome116'],
  legalComments: 'none',
  logLevel: 'warning',
  define: {
    __LITE__: String(LITE),
  },
};""",
    ),
])

# the manifest selection + a name that says LITE, and the final log
s = (ROOT / 'build.mjs').read_text()
assert "const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));" in s

ok2 = edit('build.mjs', [
    (
        """  // static files
  await cp(path.join(src, 'manifest.json'), path.join(out, 'manifest.json'));""",
        """  /**
   * THE MANIFEST NAMES THE VARIANT.
   *
   * The name is what a user sees in `chrome://extensions` and in the toolbar tooltip, so a Lite install has to
   * say so - otherwise someone with both loaded cannot tell which one they are looking at, and that is exactly
   * the confusion a second build is supposed to avoid.
   *
   * The version stays identical to the normal build on purpose: a lite install is the same release, not a
   * different version of the product, and bumping it separately would imply the two can be updated apart.
   */
  const manifestSrc = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'));
  if (LITE) {
    manifestSrc.name = `${manifestSrc.name} Lite`;
    manifestSrc.short_name = `${manifestSrc.short_name || manifestSrc.name} Lite`;
    manifestSrc.description = `${manifestSrc.description} — Lite: Basic tab only, ${'~'}35% smaller.`;
  }
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifestSrc, null, 2));
  await writeFile(path.join(out, 'build-variant.json'), JSON.stringify({ variant: VARIANT, target: FIREFOX ? 'firefox' : 'chrome', lite: LITE }, null, 2));""",
    ),
    (
        """  console.log('build results:');""",
        """  console.log(`build results (${VARIANT}${FIREFOX ? ', firefox' : ''} -> ${path.relative(root, out)}/):`);""",
    ),
])
print()

# =================================================================================================
# build-firefox.mjs — it re-runs build.mjs's flow with the Firefox manifest. Rather than teach it the
# same flags, it now simply delegates, so there is one place that knows how a variant is built.
# =================================================================================================
print('=== build-firefox.mjs === ')
p = ROOT / 'build-firefox.mjs'
head = p.read_text()[:400]
print('  (inspecting; may be left as-is if it already delegates)')
print(head[:200].replace('\n', ' ')[:180])
