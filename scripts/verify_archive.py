#!/usr/bin/env python3
"""Verify the packaged archive has the layout Chrome requires."""
import json
import pathlib
import zipfile

z = zipfile.ZipFile("/root/autoflow/release/autoflow.zip")
names = z.namelist()

print("=== archive layout ===")
print("manifest.json at the root :", "manifest.json" in names)
print("entries nested under dist :", len([n for n in names if n.startswith("dist/")]), "(must be 0)")
print("total entries             :", len(names))
print()
for n in sorted(names):
    print("  ", n)

print()
d = json.loads(z.read("manifest.json").decode())
print("=== manifest ===")
print("name        :", d["name"])
print("version     :", d["version"])
print("mv          :", d["manifest_version"])
print("permissions :", len(d["permissions"]))
print("host perms  :", d["host_permissions"])

print()
print("=== unpacked build ===")
dist = pathlib.Path("/root/autoflow/dist")
total = sum(f.stat().st_size for f in dist.rglob("*") if f.is_file())
print(f"files: {len([f for f in dist.rglob('*') if f.is_file()])}, size: {total/1024:.0f} KB")
for p in sorted(dist.iterdir()):
    print("  ", p.name)
