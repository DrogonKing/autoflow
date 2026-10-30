#!/usr/bin/env python3
"""
Remove duplicate keys from the i18n catalogue, keeping the FIRST definition in each language table.

WHY THIS IS A SCRIPT AND NOT A ONE-OFF EDIT: this class of bug has already shipped twice - `finder.positionalTitle`
made the English table serve Persian text, and 21 keys were duplicated at the time of writing. A duplicate key in a JS
object literal is silent: the later entry wins, so the wrong-language text is served with no error anywhere. The build
only WARNS, and a warning is exactly what gets discarded.

Rules:
  - each language table is a flat object of 'key': 'value' pairs;
  - the first definition wins (it is the one the file's structure puts with its neighbours);
  - the script prints what it removed, and exits non-zero if anything was removed, so a build step can treat it as a
    finding rather than a note.
"""
import re
import sys
import pathlib

P = pathlib.Path('/root/autoflow/src/core/i18n/catalogue.js')
lines = P.read_text().split('\n')

# Find the language tables: `  en: {` / `  fa: {` ... up to the closing `  },`
table_starts = []
current = None
for i, line in enumerate(lines):
    m = re.match(r"^export const (en|fa) = \{", line)
    if m:
        current = (m.group(1), i)
        table_starts.append(current)
        continue
    if current and re.match(r"^\};\s*$", line):
        table_starts[-1] = (current[0], current[1], i)
        current = None

if not table_starts or len(table_starts[-1]) != 3:
    print('could not locate the language tables', file=sys.stderr)
    sys.exit(2)

KEY = re.compile(r"^\s*'([^']+)':")

removed_total = 0
# walk tables from last to first so earlier line numbers stay valid
for lang, start, end in reversed([t for t in table_starts if len(t) == 3]):
    seen = {}
    drop = []
    for i in range(start + 1, end):
        m = KEY.match(lines[i])
        if not m:
            continue
        key = m.group(1)
        if key in seen:
            drop.append((i, key, seen[key]))
        else:
            seen[key] = i
    if drop:
        print(f'{lang}: {len(drop)} duplicate key(s)')
        for i, key, first in drop:
            print(f'  line {i + 1:<5} {key:<28} (first defined at line {first + 1})')
        for i, _key, _first in reversed(drop):
            del lines[i]
        removed_total += len(drop)

if removed_total:
    P.write_text('\n'.join(lines))
    print(f'\nremoved {removed_total} duplicate definition(s); the FIRST of each pair was kept')
    sys.exit(1)

print('no duplicate keys')
sys.exit(0)