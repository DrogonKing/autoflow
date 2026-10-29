#!/usr/bin/env python3
"""Watch the CI runs for this repo and report each step."""
import json
import os
import subprocess
import sys
import time
import urllib.request

TOKEN = open("/root/.gh-token").read().strip()
REPO = "DrogonKing/autoflow"


def api(path):
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}{path}",
        headers={"Authorization": f"token {TOKEN}", "User-Agent": "autoflow-ci",
                 "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main():
    wait = "--wait" in sys.argv
    deadline = time.time() + (900 if wait else 0)
    while True:
        runs = api("/actions/runs?per_page=6").get("workflow_runs") or []
        print(f"=== {len(runs)} recent run(s) ===")
        live = []
        for r in runs:
            state = r["conclusion"] or r["status"]
            print(f"  {r['event']:6} {str(r['head_branch']):8} {state:12} {r['html_url']}")
            if r["status"] != "completed":
                live.append(r)
        if not wait or not live or time.time() > deadline:
            if live and wait:
                print("  (still running; not waiting further)")
            break
        time.sleep(20)

    # detail for the newest completed run
    done = [r for r in api("/actions/runs?per_page=6").get("workflow_runs") or [] if r["status"] == "completed"]
    if not done:
        print("\nno completed run yet")
        return
    r = done[0]
    print(f"\n=== steps of the newest completed run ({r['event']} on {r['head_branch']}, {r['conclusion']}) ===")
    for j in api(f"/actions/runs/{r['id']}/jobs").get("jobs") or []:
        print(f"  job {j['name']}: {j['conclusion']}")
        for s in j.get("steps") or []:
            mark = {"success": "ok  ", "failure": "FAIL", "skipped": "--  "}.get(s["conclusion"], "..  ")
            print(f"    {mark} {s['name']}")

    # release assets, if the tag run produced any
    try:
        rel = api("/releases")
        if rel:
            for x in rel[:2]:
                print(f"\n=== release {x.get('tag_name')} ===")
                for a in x.get("assets") or []:
                    print(f"    {a['name']:32} {a['size'] / 1024:.0f} KB")
                if not x.get("assets"):
                    print("    (no assets)")
    except Exception as e:
        print(f"  releases: {e}")


main()
