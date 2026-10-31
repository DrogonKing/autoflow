#!/usr/bin/env python3
"""
Wire the profile cleanup into every suite that creates a temporary browser profile.

The leak: 918 abandoned profile directories, 3,111 MB, over two days. Every suite does
`mkdtempSync(path.join(tmpdir(), 'af-...'))` and 27 of 30 never removed it.

The fix is applied mechanically rather than by hand, because a hand edit across 30 files is how one gets missed - and a
single missed suite leaks exactly as much as all of them did.

For each script:
  1. add the import, if the file does not already have it
  2. register every profile it creates with autoCleanup(), by rewriting the mkdtemp call site
  3. install the sweep at the top, so profiles from a crashed run are collected too

It is idempotent: running it twice does not double-import or double-wrap.
"""
import pathlib
import re
import sys

SCRIPTS = pathlib.Path('/root/autoflow/scripts')
IMPORT_LINE = "import { autoCleanup, installProfileSweep } from './lib/profile.mjs';"
SWEEP_LINE = "installProfileSweep();"

# mkdtempSync(path.join(tmpdir(), 'af-xxx-'))  ->  autoCleanup(mkdtempSync(path.join(tmpdir(), 'af-xxx-')))
MKDTEMP = re.compile(
    r'(?<!autoCleanup\()mkdtempSync\(([^;]*?)\)(?=\s*;)',
    re.S,
)


def main(apply_changes=True):
    files = sorted(SCRIPTS.glob('*.mjs'))
    touched = []
    skipped = []

    for f in files:
        src = f.read_text()

        # only suites that actually create a temp profile
        if 'mkdtempSync' not in src and 'mkdtemp(' not in src:
            continue
        # skip the helper itself and anything that already imports it
        if f.name == 'profile.mjs':
            continue
        if 'lib/profile.mjs' in src:
            skipped.append((f.name, 'already wired'))
            continue

        original = src

        # --- imports: insert after the last existing import line
        imports = list(re.finditer(r'^import .*?;$', src, re.M))
        if not imports:
            skipped.append((f.name, 'no import block found'))
            continue
        last = imports[-1]
        insert_at = last.end()
        src = src[:insert_at] + '\n' + IMPORT_LINE + src[insert_at:]

        # --- wrap the mkdtemp calls
        n_wrapped = 0

        def wrap(m):
            nonlocal n_wrapped
            n_wrapped += 1
            return 'autoCleanup(' + m.group(1).join(['mkdtempSync(', ')'])

        def repl(m):
            nonlocal n_wrapped
            n_wrapped += 1
            inner = m.group(1)
            return f'autoCleanup(mkdtempSync({inner}))'

        src = MKDTEMP.sub(repl, src)

        # --- install the sweep right after the imports, so every run also collects a crashed run's leftovers
        after_lines = src.split('\n')
        last_import_idx = max(
            (i for i, l in enumerate(after_lines) if l.startswith('import ')),
            default=-1,
        )
        if last_import_idx >= 0 and SWEEP_LINE not in src:
            after_lines.insert(last_import_idx + 1, '')
            after_lines.insert(last_import_idx + 2, SWEEP_LINE)
            src = '\n'.join(after_lines)

        if src != original and n_wrapped:
            if apply_changes:
                f.write_text(src)
            touched.append((f.name, n_wrapped))

    print(f'{"wired" if apply_changes else "WOULD wire"}: {len(touched)} scripts')
    for name, n in touched:
        print(f'  {name:38} {n} profile(s)')
    if skipped:
        print(f'\nskipped {len(skipped)}:')
        for name, why in skipped:
            print(f'  {name:38} {why}')
    return 0


if __name__ == '__main__':
    sys.exit(main(apply_changes='--dry-run' not in sys.argv))
