#!/usr/bin/env python3
"""Show every step of a specific run, and the log tail of the failing step."""
import json
import sys
import urllib.request

TOKEN = open("/root/.gh-token").read().strip()
REPO = "DrogonKing/autoflow"


def api(path, accept="application/vnd.github+json"):
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}{path}",
        headers={"Authorization": f"token {TOKEN}", "User-Agent": "autoflow-ci", "Accept": accept},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


run_id = sys.argv[1] if len(sys.argv) > 1 else None
if not run_id:
    runs = api("/actions/runs?per_page=8").get("workflow_runs") or []
    tags = [r for r in runs if r["event"] == "push" and str(r["head_branch"]).startswith("v")]
    run_id = (tags[0] if tags else runs[0])["id"]
    print(f"using run {run_id}")

run = api(f"/actions/runs/{run_id}")
print(f"\nrun: {run['event']} on {run['head_branch']}  ->  {run['conclusion'] or run['status']}")
print(f"sha: {run['head_sha'][:10]}   {run['html_url']}")

jobs = api(f"/actions/runs/{run_id}/jobs").get("jobs") or []
for j in jobs:
    print(f"\njob {j['name']}: {j['conclusion']}")
    for s in j.get("steps") or []:
        mark = {"success": "ok  ", "failure": "FAIL", "skipped": "--  "}.get(s["conclusion"], "..  ")
        print(f"  {mark} {s['name']}")
    for s in j.get("steps") or []:
        if s["conclusion"] == "failure":
            print(f"\n  --- log of the failing step: {s['name']} ---")
            try:
                raw = urllib.request.urlopen(
                    urllib.request.Request(
                        f"https://api.github.com/repos/{REPO}/actions/jobs/{j['id']}/logs",
                        headers={"Authorization": f"token {TOKEN}", "User-Agent": "autoflow-ci"},
                    ),
                    timeout=40,
                ).read().decode("utf-8", "replace")
                # keep the lines around the failure
                keep = [l for l in raw.split("\n")
                        if any(k in l for k in ("error", "Error", "ERROR", "not accessible", "denied",
                                                "403", "401", "fatal", "##[error]"))]
                for l in keep[-25:]:
                    print("   ", l.split(" ", 1)[-1][:180])
            except Exception as e:
                print(f"    could not fetch the log: {e}")
