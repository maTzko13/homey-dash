#!/usr/bin/env bash
# Erzeugt docs/screenshots/<sprache>/ aus dem Demo-Modus: jedes Theme (Desktop) und jede Ansicht (Desktop + Handy).
# Braucht python3, curl und Chromium (oder CHROME=/pfad/zum/browser). Sprachen: SHOT_LANGS="en de".
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME=${CHROME:-$(command -v chromium || command -v chromium-browser || command -v google-chrome-stable)}
PORT=${PORT:-8097}
TMP=$(mktemp -d)
GW=
trap '[ -n "$GW" ] && kill "$GW" 2>/dev/null; rm -rf "$TMP"' EXIT

shot() {  # sprache name breite hoehe query
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TMP/profile-$1-$2" \
    --window-size="$3,$4" --force-device-scale-factor="${SCALE:-1}" --virtual-time-budget=26000 \
    --screenshot="docs/screenshots/$1/$2.png" "http://127.0.0.1:$PORT/?lang=$1&$5" >/dev/null 2>&1
  echo "docs/screenshots/$1/$2.png"
}

for lang in ${SHOT_LANGS:-en de}; do
  mkdir -p "docs/screenshots/$lang"
  rm -rf "$TMP/data"
  HOMEY_DASH_DEMO_LANG=$lang HOMEY_DASH_DATA="$TMP/data" LISTEN=127.0.0.1 PORT=$PORT \
    python3 gateway/gateway.py demo >"$TMP/gw.log" 2>&1 &
  GW=$!
  for _ in $(seq 50); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.1; done
  for theme in system omarchy aurora klar papier nacht bento; do
    shot "$lang" "theme-$theme" 1280 860 "theme=$theme&layout=standard"
  done
  for layout in standard uebersicht raeume grundriss; do
    shot "$lang" "view-$layout" 1280 860 "theme=aurora&layout=$layout"
    SCALE=2 shot "$lang" "mobile-$layout" 390 844 "theme=aurora&layout=$layout"
  done
  kill "$GW"; wait "$GW" 2>/dev/null || true; GW=
done
