#!/usr/bin/env python3
"""
Scan the repository for anything that must not be published.

Run BEFORE the first push, because a push is not fully reversible: a public repo is indexed within minutes,
and even a private one keeps the blob in its history. This is the cheapest possible moment to catch a secret.

Two kinds of hit are reported differently:

  BLOCKER - a live credential. The push must not happen.
  NOTE    - something that looks like a placeholder or an example. Worth seeing, not worth stopping for.

Patterns are for the credential shapes this project could plausibly have touched: GitHub tokens, Cloudflare
tokens, private keys, JWTs, and the generic `key = "long random string"` shape.
"""
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent

# (label, regex, severity)
PATTERNS = [
    ("GitHub classic PAT", re.compile(r"ghp_[A-Za-z0-9]{36}"), "BLOCKER"),
    ("GitHub fine-grained PAT", re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), "BLOCKER"),
    ("GitHub OAuth/app token", re.compile(r"gh[ousr]_[A-Za-z0-9]{36,}"), "BLOCKER"),
    ("Cloudflare API token", re.compile(r"[A-Za-z0-9_-]{40}"), "NOTE"),  # too generic alone; see context below
    ("AWS access key", re.compile(r"AKIA[0-9A-Z]{16}"), "BLOCKER"),
    ("private key block", re.compile(r"-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----"), "BLOCKER"),
    ("Slack token", re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"), "BLOCKER"),
    ("Google API key", re.compile(r"AIza[0-9A-Za-z_-]{35}"), "BLOCKER"),
    ("JWT", re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"), "NOTE"),
    ("bearer assignment", re.compile(r"(?i)(token|secret|password|passwd|api[_-]?key)\s*[:=]\s*['\"][^'\"]{16,}['\"]"), "BLOCKER"),
    ("CF/CF_ variable with a value", re.compile(r"(?i)CF_(?:API_)?(?:TOKEN|KEY|ACCOUNT_ID)\s*=\s*['\"]?[A-Za-z0-9_-]{20,}"), "BLOCKER"),
]

# values that are obviously not real credentials
ALLOWLIST = re.compile(
    r"(?i)(example|placeholder|redacted|your[_-]?token|xxx+|<token>|changeme|dummy|sample|test[_-]?token|"
    r"autoflow@|drogon\.site|localhost|127\.0\.0\.1|0\.0\.0\.0)"
)

# only files git would actually publish
tracked = subprocess.run(
    ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True,
).stdout.split()

print("=" * 78)
print("SECRET SCAN — the files git would publish")
print("=" * 78)
print(f"tracked files: {len(tracked)}\n")

blockers = []
notes = []

for rel in tracked:
    p = ROOT / rel
    if not p.is_file():
        continue
    try:
        text = p.read_text(errors="replace")
    except Exception:
        continue
    for label, pattern, severity in PATTERNS:
        for m in pattern.finditer(text):
            line = text[:m.start()].count("\n") + 1
            snippet = text.split("\n")[line - 1].strip()
            if ALLOWLIST.search(snippet):
                continue
            # a 40-char base64-ish run alone is too weak a signal; require a cloudflare-ish context
            if label == "Cloudflare API token" and not re.search(r"(?i)cloudflare|cf_|zone|dns", snippet):
                continue
            entry = (rel, line, label, severity, snippet[:100])
            (blockers if severity == "BLOCKER" else notes).append(entry)

if blockers:
    print("BLOCKERS (a push must not happen):")
    for rel, line, label, _, snippet in blockers:
        print(f"  {rel}:{line}  {label}")
        print(f"    {snippet}")
else:
    print("no blockers.")

if notes:
    print(f"\nnotes ({len(notes)}) — reviewed, not fatal:")
    for rel, line, label, _, snippet in notes[:10]:
        print(f"  {rel}:{line}  {label}")
        print(f"    {snippet}")

# the environment files are the usual place for a real credential; confirm none is published
print("\nfiles git would publish that look like env/config:")
suspicious = [f for f in tracked if re.search(r"(?i)(^|/)(\.env|\.env\.|secrets?|credentials?|\.npmrc|\.netrc|id_rsa)", f)]
print(f"  {suspicious or 'none'}")

# and the token this run used must NOT be in the tree
token_file = pathlib.Path("/root/.gh-token")
if token_file.exists():
    token = token_file.read_text().strip()
    hits = [f for f in tracked if token and token in (ROOT / f).read_text(errors="replace")]
    print(f"\nthe token used for this push appears in: {hits or 'no tracked file (good)'}")

print("\n" + "=" * 78)
print("VERDICT:", "DO NOT PUSH" if blockers else "safe to push")
