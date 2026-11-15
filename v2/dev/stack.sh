#!/usr/bin/env bash
# A throw-away Harmony server + MediaMTX for trying the v2 client against, on fixed local ports.
#
#   v2/dev/stack.sh            starts them, registers alice and bob (password hunter22), prints how to reach them
#   MEDIAMTX_BIN=/path/to/mediamtx v2/dev/stack.sh
#
# Stops everything when this script is interrupted. Data lives in a fresh temp dir each run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MTX="${MEDIAMTX_BIN:-$HOME/mediamtx/mediamtx}"
PORT="${HARMONY_PORT:-18280}"
API=$((PORT - 8400)); WEB=$((PORT - 9510)); ICE=$((PORT - 10210))
DATA="$(mktemp -d)"; MTXDIR="$(mktemp -d)"
cp "$ROOT/server/mediamtx.yml" "$MTXDIR/mediamtx.yml"

cleanup() { kill "${PIDS[@]}" 2>/dev/null || true; }
PIDS=(); trap cleanup EXIT INT TERM

MTX_AUTHHTTPADDRESS="http://127.0.0.1:$PORT/mediamtx/auth" MTX_WEBRTCADDRESS=":$WEB" \
MTX_APIADDRESS="127.0.0.1:$API" MTX_WEBRTCLOCALUDPADDRESS=":$ICE" MTX_WEBRTCLOCALTCPADDRESS=":$ICE" \
  "$MTX" "$MTXDIR/mediamtx.yml" >"$MTXDIR/mtx.log" 2>&1 & PIDS+=($!)

HARMONY_PORT="$PORT" HARMONY_HOST=127.0.0.1 HARMONY_DATA_DIR="$DATA" \
HARMONY_MEDIAMTX_API="http://127.0.0.1:$API" HARMONY_SIGNALING_URL="http://127.0.0.1:$WEB" \
HARMONY_POLL_INTERVAL_MS=400 \
  node "$ROOT/server/src/index.js" >"$DATA/server.log" 2>&1 & PIDS+=($!)

for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
for who in alice bob; do
  curl -fs -X POST "http://127.0.0.1:$PORT/api/accounts/register" -H 'Content-Type: application/json' \
    -d "{\"nickname\":\"$who\",\"password\":\"hunter22\"}" >/dev/null || echo "could not register $who"
done
echo "server   http://127.0.0.1:$PORT   (alice / bob, password hunter22)"
echo "logs     $DATA/server.log   $MTXDIR/mtx.log"
wait
