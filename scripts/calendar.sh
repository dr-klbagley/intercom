#!/bin/bash
# Intercom's calendar fetch: same "Hermes Calendar Helper.app" that Jarvis's kevin_calendar.sh uses (so
# macOS attributes Calendar access to the app), without `open -W`. When the helper finishes quickly,
# `open -W` fails with "Unable to block on applications (kevent ... No such process)". Instead this waits
# for the helper process to exit, then checks the output is JSON. Read-only; prints the JSON on stdout.
#   calendar.sh [YYYY-MM-DD]
set -uo pipefail
APP="$HOME/Applications/Hermes Calendar Helper.app"
OUT="$(mktemp -t intercom-calendar)"
trap 'rm -f "$OUT"' EXIT
: > "$OUT"
/usr/bin/open -n -g "$APP" --args "$OUT" "${1:-}" || { echo "couldn't start the calendar helper" >&2; exit 4; }

# Wait (up to 30 s) until a helper process with our output path has come and gone, and the file has content.
seen=0
for _ in $(seq 1 150); do
  if pgrep -f "calendar-helper $OUT" >/dev/null 2>&1; then seen=1
  elif [ -s "$OUT" ] || [ $seen = 1 ]; then break
  fi
  sleep 0.2
done
sleep 0.2
if [ ! -s "$OUT" ]; then echo "Calendar helper produced no output" >&2; exit 3; fi
if head -c 6 "$OUT" | grep -q '^ERROR:'; then cat "$OUT" >&2; exit 2; fi
/usr/bin/python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$OUT" 2>/dev/null || { echo "Calendar helper output isn't valid JSON" >&2; exit 5; }
cat "$OUT"
