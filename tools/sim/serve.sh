#!/usr/bin/env bash
#
# Serve the test field over http, on 127.0.0.1.
#
# WHY NOT JUST OPEN THE FILE. The content script is injected by the extension, and `file://` support depends on
# a per-extension toggle ("Allow access to file URLs") that is off by default. Opening the page as a file would
# therefore look like a broken extension when it is a permission the user never granted. http://127.0.0.1 is a
# normal origin, so injection works with no extra step.
#
# WHY 127.0.0.1 AND NOT localhost. `localhost` resolves to ::1 on some systems, where the listener below (IPv4)
# is not reachable. The literal address removes the ambiguity.
#
# Port 8099 is chosen because the other test services in this repo use 8081 and 24541.
set -euo pipefail

PORT="${1:-8099}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to serve the page" >&2
  exit 1
fi

if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "port ${PORT} is already in use - pass another, e.g. $0 8100" >&2
  exit 1
fi

echo "میدان تست روی این نشانی بالا آمد:"
echo
echo "    http://127.0.0.1:${PORT}/"
echo
echo "این را در همان مرورگری باز کن که افزونه در آن نصب است."
echo "برای بستن: Ctrl+C"
echo

cd "$DIR"
exec python3 -m http.server --bind 127.0.0.1 "$PORT"
