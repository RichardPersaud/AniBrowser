#!/usr/bin/env bash
# Host sanity test for the Android node bundle.
set -u
export PATH="$HOME/.local/bin:$PATH"
TMPHOME=$(mktemp -d)
trap 'kill $NP 2>/dev/null; rm -rf "$TMPHOME"' EXIT
cd "$(dirname "$0")/app/src/main/assets/nodejs-project"

HOME="$TMPHOME" node index.js > "$TMPHOME/log.txt" 2>&1 &
NP=$!
sleep 3

PORT=$(grep -o '"port":[0-9]*' "$TMPHOME/anibrowser-port.json" | cut -d: -f2)
echo "port: $PORT"
echo -n "/api/version: "; curl -s "http://127.0.0.1:$PORT/api/version"; echo
echo -n "/api/update: ";   curl -s "http://127.0.0.1:$PORT/api/update"; echo
echo -n "GET /: ";         curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/"; echo
echo -n "/api/search: ";   curl -s "http://127.0.0.1:$PORT/api/search?q=dandadan" | head -c 150; echo
echo "data dir: $(ls "$TMPHOME/AniBrowser" 2>/dev/null || echo MISSING)"
echo "log: $(head -2 "$TMPHOME/log.txt")"