#!/usr/bin/env bash
# The same thing as docker-compose.yml, as a single `docker run`.
#
#   ./docker-run.sh stream.example.com
#   HARMONY_PASSWORD=hunter2 ./docker-run.sh stream.example.com
#
# Reach for compose if you want this to survive a reboot; this script is for
# trying the image out.

set -euo pipefail

PUBLIC_HOST="${1:-${HARMONY_PUBLIC_HOST:-}}"
if [ -z "$PUBLIC_HOST" ]; then
  cat >&2 <<'USAGE'
usage: ./docker-run.sh <public-hostname-or-ip>

That address is what MediaMTX advertises to clients as somewhere to send media.
Without it nothing outside this machine can connect. For a LAN-only test, the
host's own LAN address (192.168.1.50) is fine.
USAGE
  exit 2
fi

IMAGE="${HARMONY_IMAGE:-pedrolucasmiguel/harmony-server:0.1.0}"
NAME="${HARMONY_NAME:-harmony}"
SIGNALING_URL="${HARMONY_SIGNALING_URL:-http://${PUBLIC_HOST}:8889}"

docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  \
  `# Control API and signaling: the host side can be remapped freely.` \
  -p 8080:8080 \
  -p 8889:8889 \
  \
  `# WebRTC media -- these two MUST stay 1:1. MediaMTX advertises the port it` \
  `# listens on inside the container, so publishing 9000:8189 tells clients to` \
  `# send media to a port with nothing behind it, and every stream fails after` \
  `# a handshake that looked fine. The TCP one is the no-UDP fallback.` \
  -p 8189:8189/udp \
  -p 8189:8189/tcp \
  \
  -e MTX_WEBRTCADDITIONALHOSTS="$PUBLIC_HOST" \
  -e HARMONY_SIGNALING_URL="$SIGNALING_URL" \
  -e HARMONY_PASSWORD="${HARMONY_PASSWORD:-}" \
  \
  `# Nothing is written to disk and it runs unprivileged.` \
  --read-only \
  --tmpfs /tmp \
  --security-opt no-new-privileges:true \
  \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  \
  "$IMAGE"

echo "started ${NAME} from ${IMAGE}"
echo
echo "  clients connect to:  ${SIGNALING_URL%/*}"
echo "  control API:         http://localhost:8080/api/health"
echo "  logs:                docker logs -f ${NAME}"
echo
echo "Forward these on your router to this machine:"
echo "  UDP 8189  (media -- without it nothing plays)"
echo "  TCP 8189  (media fallback for networks that block UDP)"
echo "  TCP 8889  (signaling, or whatever you put in front of it)"
