#!/usr/bin/env bash
# Mozilla's own linter, in JSON, then summarised by issue code so nothing is hidden by a truncated table.
set -u
export PATH=/opt/node24/bin:$PATH
cd /root/autoflow

echo "=== web-ext lint, JSON ==="
timeout 380 npx --yes web-ext lint --source-dir=dist --output=json > /tmp/ff-lint.json 2>/tmp/ff-lint.err
echo "exit=$?"
echo "bytes: $(wc -c < /tmp/ff-lint.json)"

python3 - <<'PY'
import json, collections
try:
    d = json.load(open("/tmp/ff-lint.json"))
except Exception as e:
    print("could not parse:", e)
    print(open("/tmp/ff-lint.json").read()[:2000])
    raise SystemExit

print()
print("=== summary ===")
for k in ("errors", "warnings", "notices"):
    print(f"  {k}: {len(d.get(k) or [])}")
print(f"  metadata: {json.dumps(d.get('metadata'))[:300]}")

codes = collections.Counter()
for kind in ("errors", "warnings", "notices"):
    for it in d.get(kind) or []:
        codes[(kind, it.get("code"))] += 1

print()
print("=== every issue code ===")
for (kind, code), n in sorted(codes.items()):
    print(f"  {kind:9} {code:42} {n}")

print()
print("=== detail per code (first instance of each) ===")
seen = set()
for kind in ("errors", "warnings", "notices"):
    for it in d.get(kind) or []:
        c = it.get("code")
        if (kind, c) in seen:
            continue
        seen.add((kind, c))
        print(f"\n[{kind}] {c}")
        print(f"  message    : {it.get('message')}")
        print(f"  description: {str(it.get('description'))[:300]}")
        print(f"  file       : {it.get('file')}")
        print(f"  line       : {it.get('line')}")
PY