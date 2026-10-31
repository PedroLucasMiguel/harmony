#!/bin/sh
# The same loss scenarios against several MediaMTX binaries, one table each.
#
#   client/test/share-bench/compare-relays.sh stock=$HOME/mediamtx/mediamtx nack10=/tmp/mediamtx-nack10 nack5=/tmp/mediamtx-nack5
#
# Each argument is label=path. Build the variants with server/patches/build-mediamtx.sh (NACK_INTERVAL_MS=5 ...).
# SCENARIOS, DURATION and REPEAT override what is run, for how long, and how many times (a median is printed);
# results are also kept in /tmp/relay-<label>.json. The loss is seeded, so every relay faces the same one.

set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SCENARIOS="${SCENARIOS:-loss03-publisher-leg loss1-publisher-leg loss3-publisher-leg}"
DURATION="${DURATION:-35}"
REPEAT="${REPEAT:-3}"

for pair in "$@"; do
  label="${pair%%=*}"
  bin="${pair#*=}"
  echo "##### $label  ($bin)"
  # shellcheck disable=SC2086
  MEDIAMTX_BIN="$bin" node "$HERE/../share-bench.mjs" $SCENARIOS --duration="$DURATION" --repeat="$REPEAT" --out="/tmp/relay-$label.json" 2>&1 \
    | grep -E "^(scenario|---|loss|base)|MEDIAN|p95 across|FAILED|Error|No MediaMTX" || true
done
