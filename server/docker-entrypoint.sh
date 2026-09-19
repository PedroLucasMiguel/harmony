#!/usr/bin/env bash
# Start the control server, then MediaMTX, and tie their lifetimes together.
#
# Order matters. MediaMTX asks the control server to authorise every publish and
# every read, so if it comes up first the requests that arrive in that window are
# refused rather than queued -- install.sh says the same thing about the systemd
# units. So: start the control server, wait until it actually answers, then bring
# up the media server.
#
# The container must also die when either process dies, not limp along serving
# half a service. A container that answers its health check while nobody can
# watch anything is worse than one that restarts.

set -euo pipefail

HARMONY_PORT="${HARMONY_PORT:-8080}"
MEDIAMTX_CONFIG="${MEDIAMTX_CONFIG:-/etc/harmony/mediamtx.yml}"
STARTUP_TIMEOUT="${HARMONY_STARTUP_TIMEOUT:-30}"

log() { printf '[entrypoint] %s\n' "$*"; }

if [ -z "${MTX_WEBRTCADDITIONALHOSTS:-}" ]; then
  log 'WARNING: MTX_WEBRTCADDITIONALHOSTS is not set.'
  log '         MediaMTX will only advertise addresses it finds on this'
  log "         container's interfaces, which are not reachable from outside."
  log '         Set it to the public hostname or IP clients will use.'
fi

node /opt/harmony/src/index.js &
control_pid=$!

# Wait for it to answer rather than sleeping a fixed amount: on a loaded
# Raspberry Pi the difference between "started" and "listening" is real.
deadline=$(( SECONDS + STARTUP_TIMEOUT ))
until wget -qO- "http://127.0.0.1:${HARMONY_PORT}/api/health" >/dev/null 2>&1; do
  if ! kill -0 "$control_pid" 2>/dev/null; then
    log 'control server exited during startup'
    wait "$control_pid"
    exit 1
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    log "control server did not answer within ${STARTUP_TIMEOUT}s"
    kill -TERM "$control_pid" 2>/dev/null || true
    exit 1
  fi
  sleep 0.5
done
log "control server is answering on :${HARMONY_PORT}"

mediamtx "$MEDIAMTX_CONFIG" &
mediamtx_pid=$!

shutdown() {
  trap - TERM INT
  log 'shutting down'
  kill -TERM "$mediamtx_pid" "$control_pid" 2>/dev/null || true
  wait "$mediamtx_pid" "$control_pid" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# Whichever exits first takes the container with it.
wait -n "$control_pid" "$mediamtx_pid"
status=$?

if kill -0 "$control_pid" 2>/dev/null; then
  log "mediamtx exited (status ${status}) -- stopping the control server"
else
  log "the control server exited (status ${status}) -- stopping mediamtx"
fi
kill -TERM "$mediamtx_pid" "$control_pid" 2>/dev/null || true
wait 2>/dev/null || true

# Never exit 0 here. Reaching this point means a process ended by itself rather
# than because the container was asked to stop -- and MediaMTX exits 0 on a
# clean shutdown, so passing its status through would report a crash-out as
# success and stop `restart: on-failure` from ever restarting it.
exit "$(( status == 0 ? 1 : status ))"
