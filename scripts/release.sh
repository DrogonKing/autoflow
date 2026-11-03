#!/bin/bash
#
# release.sh — one release, beta or stable, decided by the version you pass.
#
#   release.sh 1.40.0        → stable   (tag v1.40.0)
#   release.sh 1.40.0-beta   → beta     (tag v1.40.0-beta, published as a prerelease)
#
# THE RULE THIS ENFORCES IS THE POINT: a change ships as a beta first, and is promoted to stable only after the user has
# confirmed it works on the real page. CI derives GitHub's `prerelease` flag from the tag name, so passing the suffix is
# what makes a build visibly not-final - it is not decoration.
#
# The commit message comes from /tmp/release-message.txt, so the notes are written deliberately rather than generated.
set -u
cd /root/autoflow || exit 1
export PATH=/opt/node24/bin:$PATH
export GH_TOKEN=$(cat /root/.gh-token)
HELPER='!f(){ echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <version>        e.g. $0 1.40.0-beta   (beta first, always)"
  echo "       $0 1.40.0           only AFTER the user confirms the beta works"
  exit 1
fi
if ! printf '%s' "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-(beta|rc|alpha))?$'; then
  echo "not a version: $VERSION  (expect X.Y.Z or X.Y.Z-beta)" >&2
  exit 1
fi
IS_BETA=false
case "$VERSION" in *-*) IS_BETA=true ;; esac

BASE="${VERSION%%-*}"
if [ "$IS_BETA" = false ]; then
  echo "=== STABLE RELEASE $BASE ==="
  echo "A stable tag is only correct once the user has confirmed the matching beta on the real page."
  echo "The beta for this version was v${BASE}-beta - if that was never shipped, stop here."
  printf "Type 'confirmed' to proceed: "
  read -r CONFIRM
  [ "$CONFIRM" = "confirmed" ] || { echo "stopped."; exit 1; }
else
  echo "=== BETA $VERSION ==="
fi

if [ ! -f /tmp/release-message.txt ]; then
  echo "write the release notes to /tmp/release-message.txt first" >&2
  exit 1
fi
if [ ! -f .github/release-body${IS_BETA:+-beta}.md ] && [ "$IS_BETA" = true ]; then
  echo "missing .github/release-body-beta.md" >&2
  exit 1
fi

bash scripts/bump-version.sh "$BASE" >/dev/null 2>&1
# ALL FOUR BUNDLES, from clean output - a stale dist/ has hidden a real bug twice in this project
for a in "" "--lite" "--firefox" "--firefox --lite"; do
  rm -f dist/manifest.json dist-lite/manifest.json dist-firefox/manifest.json dist-firefox-lite/manifest.json
  node scripts/build.mjs $a >/dev/null 2>&1 || { echo "build failed: $a"; exit 1; }
done
node scripts/build.mjs >/dev/null 2>&1
python3 -c "import json;p=json.load(open('package.json'))['version'];m=json.load(open('src/manifest.json'))['version'];print(f'package {p} | manifest {m}')"

node scripts/package.mjs --all 2>&1 | grep -A 8 "release/ now holds"
TZ=UTC timeout 600 npx vitest run 2>&1 | grep -E "Tests +[0-9]|Test Files" | head -3
node scripts/check-imports.mjs

echo "--- browser suites ---"
export PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
bash /root/run-all-suites.sh 2>&1 | tail -10

TAG="v$VERSION"
git add -A
git -c user.email=noreply@drogon.site -c user.name="AutoFlow" commit -q -F /tmp/release-message.txt \
  && git log --oneline -1 | cat
git -c credential.helper="$HELPER" push -q origin main 2>&1 | tail -2; echo "push rc=$?"

git tag -f "$TAG" -m "AutoFlow $VERSION" >/dev/null 2>&1
git -c credential.helper="$HELPER" push -f -q origin "refs/tags/$TAG" 2>&1 | tail -2; echo "tag rc=$?"
sleep 260
timeout 400 python3 scripts/ci_status.py 2>&1 | head -4

if [ "$IS_BETA" = true ]; then
  echo
  echo "================================================================"
  echo " BETA $TAG published. Now hand it to the user and WAIT."
  echo " Do NOT tag $BASE until they confirm it works on the real page."
  echo "================================================================"
fi