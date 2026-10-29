#!/usr/bin/env python3
"""Extract the security-relevant parts of REA's evidence for our own extension."""
import json
import collections

d = json.load(open("/tmp/af-audit-evidence.json"))

print("=== evidence top level ===")
for k, v in d.items():
    n = len(v) if isinstance(v, (list, dict)) else v
    print(f"  {k:24} {type(v).__name__:6} {n}")

records = d.get("records") or []
print(f"\n=== records: {len(records)} ===")
kinds = collections.Counter(r.get("kind") or r.get("type") for r in records)
for k, n in kinds.most_common(20):
    print(f"  {str(k):40} {n}")

# look for anything the analyser flagged
for key in ("unknowns", "findings", "warnings", "limitations"):
    items = d.get(key) or []
    if items:
        print(f"\n=== {key}: {len(items)} ===")
        for it in items[:12]:
            print(f"  {json.dumps(it)[:300]}")

# the extension-relevant observations
print("\n=== security-relevant record fields ===")
interesting = ("ipc", "csp", "preload", "context_bridge", "sender", "permission", "host",
               "script", "eval", "dynamic", "network", "fetch", "external", "web_accessible")
seen = collections.Counter()
for r in records:
    blob = json.dumps(r).lower()
    for word in interesting:
        if word in blob:
            seen[word] += 1
for w, n in seen.most_common():
    print(f"  {w:20} appears in {n} record(s)")

# what files were actually parsed
arts = d.get("artifacts") or []
print(f"\n=== artifacts: {len(arts)} ===")
for a in arts[:3]:
    print(f"  format={a.get('format')}")

envs = d.get("environments") or []
print(f"\n=== environments: {len(envs)} ===")
for e in envs[:2]:
    print(f"  {json.dumps(e)[:400]}")