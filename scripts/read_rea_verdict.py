#!/usr/bin/env python3
"""REA's verdict on our extension: the summary and its stated limitations."""
import json

d = json.load(open("/tmp/af-audit-evidence.json"))
rec = d["records"][0]
nr = rec["normalized_result"]

print("=== REA normalized_result.summary ===")
s = nr.get("summary") or {}
for k, v in s.items():
    if isinstance(v, dict):
        print(f"  {k}:")
        for k2, v2 in v.items():
            print(f"      {k2:38} {v2}")
    else:
        print(f"  {k:40} {v}")

print("\n=== statistics ===")
for k, v in (nr.get("statistics") or {}).items():
    print(f"  {k:40} {v}")

print("\n=== subject ===")
for k, v in (rec.get("subject") or {}).items():
    print(f"  {k:20} {str(v)[:120]}")

print("\n=== provider ===")
for k, v in (rec.get("provider") or {}).items():
    print(f"  {k:20} {str(v)[:160]}")

print(f"\n=== limitations ({len(rec.get('limitations') or [])}) ===")
for lim in rec.get("limitations") or []:
    print(f"  - {str(lim)[:240]}")

print("\n=== locations / files analysed ===")
for loc in rec.get("locations") or []:
    print(f"  {json.dumps(loc)[:400]}")

print("\n=== all normalized_result keys ===")
for k, v in nr.items():
    n = len(v) if isinstance(v, (list, dict)) else v
    print(f"  {k:30} {type(v).__name__:6} {str(n)[:70]}")

# the findings list, if any
for key in ("findings", "concerns", "observations", "signals", "warnings"):
    v = nr.get(key)
    if v:
        print(f"\n=== normalized_result[{key!r}]: {len(v)} ===")
        for it in (v if isinstance(v, list) else [v])[:20]:
            print(f"  {json.dumps(it)[:400]}")