#!/bin/bash
# Installs Intercom on the Mac mini (spec §13). Run as jarvis from the repo root:
#
#   scripts/install.sh            # everything below, stopping at the first failure
#   scripts/install.sh --app-only # rebuild and restart Intercom only (after a git pull)
#
# What it changes outside this folder (each step says so as it runs):
#   - Hermes: creates the `intercom` profile (a clone of Jarvis with NO tools on the API server),
#     turns on the Hermes API server, and restarts the gateway (Jarvis is offline for a few seconds).
#   - ~/Library/LaunchAgents: com.jarvis.intercom and com.jarvis.intercom-sidecar.
#   - tailscale serve: adds /intercom -> 127.0.0.1:4177 (tailnet only, never Funnel).
# Backups of every Hermes file it edits go next to the original with a .bak-pre-intercom suffix.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERMES_HOME="$HOME/.hermes"
HERMES="${HERMES:-$(command -v hermes || echo "$HOME/.local/bin/hermes")}"
UV="${UV:-$(command -v uv || echo "$HERMES_HOME/bin/uv")}"
NODE="${NODE:-$(command -v node)}"
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
AGENTS="$HOME/Library/LaunchAgents"
PROFILE=intercom
PROFILE_HOME="$HERMES_HOME/profiles/$PROFILE"
API_PORT=8642
APP_ONLY=0; [ "${1:-}" = "--app-only" ] && APP_ONLY=1

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
set_env() { # set_env FILE KEY VALUE  (adds or replaces KEY=VALUE, keeps everything else)
  local f="$1" k="$2" v="$3"
  touch "$f"; chmod 600 "$f"
  if grep -q "^$k=" "$f"; then
    python3 - "$f" "$k" "$v" <<'PY'
import sys; f, k, v = sys.argv[1:]
lines = open(f).read().splitlines()
open(f, "w").write("\n".join(f"{k}={v}" if l.startswith(k + "=") else l for l in lines) + "\n")
PY
  else printf '%s=%s\n' "$k" "$v" >> "$f"; fi
}
get_env() { grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

mkdir -p "$ROOT/logs" "$ROOT/models"

# ------------------------------------------------------------------ 1. Node app
step "Building the Intercom server"
[ -n "$NODE" ] || die "node not found"
(cd "$ROOT" && npm ci --silent && npm run build --silent && npx vitest run --silent >/dev/null) || die "build or tests failed"

if [ $APP_ONLY = 0 ]; then
  # ---------------------------------------------------------------- 2. speech sidecar
  step "Setting up the speech sidecar (Python 3.12, mlx-whisper, Kokoro)"
  [ -x "$UV" ] || die "uv not found (expected at $HERMES_HOME/bin/uv)"
  (cd "$ROOT/sidecar" && "$UV" venv --quiet --python 3.12 .venv && "$UV" pip install --quiet --python .venv/bin/python -r pyproject.toml)
  KOKORO_URL=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
  for f in kokoro-v1.0.onnx voices-v1.0.bin; do
    if [ ! -s "$ROOT/models/$f" ]; then
      echo "  downloading $f (Kokoro voice model)…"
      curl -fL --progress-bar -o "$ROOT/models/$f.part" "$KOKORO_URL/$f" && mv "$ROOT/models/$f.part" "$ROOT/models/$f"
    fi
  done

  # ---------------------------------------------------------------- 3. Hermes profile + API server
  step "Hermes: creating the read-only '$PROFILE' profile"
  if [ ! -d "$PROFILE_HOME" ]; then
    "$HERMES" profile create "$PROFILE" --clone --description "Intercom voice answers: no tools, answers only from context Intercom gathers."
  fi
  CFG="$PROFILE_HOME/config.yaml"
  [ -f "$CFG.bak-pre-intercom" ] || cp "$CFG" "$CFG.bak-pre-intercom"
  # No tools on the API server for this profile (spec §8). Rewrites only the api_server line.
  python3 - "$CFG" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
if re.search(r"^platform_toolsets:", s, re.M):
    if re.search(r"^  api_server:.*$", s, re.M):
        s = re.sub(r"^  api_server:.*$", "  api_server: []", s, flags=re.M)
    else:
        s = re.sub(r"^platform_toolsets:\s*$", "platform_toolsets:\n  api_server: []", s, count=1, flags=re.M)
else:
    s = s.rstrip("\n") + "\nplatform_toolsets:\n  api_server: []\n"
open(p, "w").write(s)
PY

  step "Hermes: turning on the API server (127.0.0.1:$API_PORT)"
  ROOT_ENV="$HERMES_HOME/.env"; PROF_ENV="$PROFILE_HOME/.env"
  [ -f "$ROOT_ENV.bak-pre-intercom" ] || cp "$ROOT_ENV" "$ROOT_ENV.bak-pre-intercom" 2>/dev/null || true
  [ "$(get_env "$ROOT_ENV" API_SERVER_ENABLED)" = "true" ] || set_env "$ROOT_ENV" API_SERVER_ENABLED true
  [ -n "$(get_env "$ROOT_ENV" API_SERVER_KEY)" ] || set_env "$ROOT_ENV" API_SERVER_KEY "$(openssl rand -hex 32)"
  KEY="$(get_env "$PROF_ENV" API_SERVER_KEY)"
  if [ -z "$KEY" ]; then KEY="$(openssl rand -hex 32)"; set_env "$PROF_ENV" API_SERVER_KEY "$KEY"; fi

  step "Hermes: restarting the gateway (Jarvis is offline for a few seconds)"
  launchctl kickstart -k "gui/$(id -u)/ai.hermes.gateway"
  for _ in $(seq 1 60); do
    curl -fsS -H "Authorization: Bearer $KEY" "http://127.0.0.1:$API_PORT/p/$PROFILE/v1/models" >/dev/null 2>&1 && break
    sleep 2
  done
  curl -fsS -H "Authorization: Bearer $KEY" "http://127.0.0.1:$API_PORT/p/$PROFILE/v1/models" >/dev/null || die "Hermes API isn't answering for profile $PROFILE"

  step "Hermes: confirming the '$PROFILE' profile has no tools"
  TOOLS="$(curl -fsS -H "Authorization: Bearer $KEY" "http://127.0.0.1:$API_PORT/p/$PROFILE/v1/toolsets")"
  COUNT="$(printf '%s' "$TOOLS" | python3 -c 'import json,sys
d=json.load(sys.stdin); ts=d.get("toolsets", d.get("data", d)) if isinstance(d, dict) else d
print(sum(len(t.get("tools", [])) for t in ts) if isinstance(ts, list) else -1)')"
  [ "$COUNT" = "0" ] || die "profile $PROFILE still has tools ($COUNT); not installing. Response: $(printf '%s' "$TOOLS" | head -c 400)"
else
  KEY="$(get_env "$PROFILE_HOME/.env" API_SERVER_KEY)"
  [ -n "$KEY" ] || die "no API key for profile $PROFILE; run the full install first"
fi

# ------------------------------------------------------------------ 4. launchd
step "Installing the background services"
LOGIN="$("$TS" status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["User"][str(d["Self"]["UserID"])]["LoginName"])')"
[ -n "$LOGIN" ] || die "couldn't read the Tailscale login"
fill() { sed -e "s#REPLACE_ROOT#$ROOT#g" -e "s#REPLACE_NODE#$NODE#g" -e "s#REPLACE_ALLOWED_LOGIN#$LOGIN#g" -e "s#REPLACE_HERMES_KEY#$KEY#g" "$1"; }
for label in com.jarvis.intercom-sidecar com.jarvis.intercom; do
  [ $APP_ONLY = 1 ] && [ $label = com.jarvis.intercom-sidecar ] && continue
  dest="$AGENTS/$label.plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  if [ $label = com.jarvis.intercom ]; then port=4177; else port=4178; fi
  port_free $port || die "port $port is in use"
  ( umask 077; fill "$ROOT/deploy/$label.plist" > "$dest" )
  plutil -lint "$dest" >/dev/null
  launchctl bootstrap "gui/$(id -u)" "$dest"
done

# ------------------------------------------------------------------ 5. tailscale serve
if [ $APP_ONLY = 0 ]; then
  step "Tailscale: serving /intercom on the tailnet"
  "$TS" serve status 2>/dev/null | grep -q '/intercom ' || "$TS" serve --bg --set-path /intercom http://127.0.0.1:4177
fi

# ------------------------------------------------------------------ 6. smoke test
step "Smoke test"
for _ in $(seq 1 90); do curl -fsS http://127.0.0.1:4177/healthz >/dev/null 2>&1 && break; sleep 2; done
curl -sS http://127.0.0.1:4177/healthz; echo
if [ $APP_ONLY = 0 ]; then
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  say -o "$TMP/q.aiff" "What does my calendar look like tomorrow?" && ffmpeg -loglevel error -i "$TMP/q.aiff" -ar 16000 -ac 1 "$TMP/q.wav"
  echo "  speech-to-text (first run downloads the Whisper model, ~1.6 GB):"
  curl -fsS --max-time 600 -H 'Content-Type: audio/wav' --data-binary @"$TMP/q.wav" "http://127.0.0.1:4178/stt" || die "speech-to-text failed"; echo
  echo "  text-to-speech:"
  curl -fsS -o "$TMP/a.wav" -H 'Content-Type: application/json' -d '{"text":"Intercom is ready.","voice":"bm_george"}' http://127.0.0.1:4178/tts && afinfo "$TMP/a.wav" | grep -E "duration" || die "text-to-speech failed"
fi

printf '\n\033[32m✓ Intercom is installed: https://%s/intercom/\033[0m\n' "$("$TS" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
echo "If mail questions say mail is unavailable, give Full Disk Access to $NODE in System Settings → Privacy & Security."
