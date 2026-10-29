#!/usr/bin/env python3
"""The single REA record holds everything; pull out the security-relevant sections."""
import json

d = json.load(open("/tmp/af-audit-evidence.json"))
rec = d["records"][0]

print("=== record keys ===")
for k, v in rec.items():
    n = len(v) if isinstance(v, (list, dict)) else v
    print(f"  {k:28} {type(v).__name__:6} {str(n)[:60]}")

blob = json.dumps(rec)


def find_section(name):
    """Print a named JSON subtree if present."""
    for key in (name,):
        if key in rec:
            print(f"\n=== rec[{key!r}] ===")
            print(json.dumps(rec[key], indent=2)[:2500])


print("\n\n=== searching the record for security observations ===")
import collections

# walk for any key whose name suggests a security observation
hits = collections.defaultdict(list)


def walk(node, path=""):
    if isinstance(node, dict):
        for k, v in node.items():
            p = f"{path}.{k}" if path else k
            if any(w in k.lower() for w in ("ipc", "csp", "preload", "bridge", "sender",
                                            "permission", "eval", "dynamic", "network",
                                            "external", "accessible", "script", "inject")):
                if isinstance(v, (int, str, bool, float)):
                    hits[p].append(v)
                elif isinstance(v, (list, dict)):
                    hits[p].append(f"<{type(v).__name__} len={len(v)}>")
            walk(v, p)
    elif isinstance(node, list):
        for i, v in enumerate(node[:50]):
            walk(v, f"{path}[{i}]")


walk(rec)
for k in sorted(hits):
    vals = hits[k]
    shown = vals[:4]
    print(f"  {k}")
    for v in shown:
        print(f"      {json.dumps(v)[:220]}")

# the biggest interesting structures
print("\n\n=== the 'chip' structures (REA's observations) ===")
for key in ("value", "observations", "chips", "signals", "application"):
    if key in rec:
        v = rec[key]
        print(f"\n-- rec[{key!r}] type={type(v).__name__}")
        if isinstance(v, dict):
            for k2, v2 in list(v.items())[:30]:
                n = len(v2) if isinstance(v2, (list, dict)) else v2
                print(f"    {k2:34} {type(v2).__name__:6} {str(n)[:50]}")