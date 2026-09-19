#!/usr/bin/env bash
# Restart MediaMTX when the public IP behind its advertised hostname changes.
#
# MediaMTX resolves webrtcAdditionalHosts when it builds ICE candidates and does
# not re-resolve on its own. On a dynamic residential connection the address
# eventually moves; ddclient updates DNS, but MediaMTX would keep handing
# clients the old address and every external connection would fail silently.
#
# A restart is not disruptive in the way it looks: when the public IP changes,
# every in-flight WebRTC session is already dead.

set -euo pipefail

HOST="${1:-}"
STATE_FILE=/var/lib/harmony/advertised-ip

if [[ -z "$HOST" ]]; then
  # Default to whatever MediaMTX is configured to advertise.
  HOST="$(grep -oP '^MTX_WEBRTCADDITIONALHOSTS=\K[^,# ]+' /etc/harmony/harmony.env 2>/dev/null || true)"
fi
[[ -n "$HOST" ]] || exit 0

current="$(getent ahostsv4 "$HOST" | awk 'NR==1 {print $1}')"
# A failed lookup must never trigger a restart loop.
[[ -n "$current" ]] || exit 0

mkdir -p "$(dirname "$STATE_FILE")"
previous="$(cat "$STATE_FILE" 2>/dev/null || true)"

if [[ "$current" != "$previous" ]]; then
  echo "advertised address for $HOST changed: ${previous:-<unset>} -> $current"
  printf '%s' "$current" > "$STATE_FILE"
  # Only restart once we have a previous value, so first run just records it.
  if [[ -n "$previous" ]]; then
    systemctl restart mediamtx
    echo "restarted mediamtx"
  fi
fi
