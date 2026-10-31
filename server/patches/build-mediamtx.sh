#!/bin/sh
# Build MediaMTX from source with the patches in this directory applied.
#
#   build-mediamtx.sh <version> <output-binary>        build
#   build-mediamtx.sh --prepare-only <version> <dir>   fetch and patch, but do not build
#   build-mediamtx.sh --patch-id                       print which set of patches this is, and stop
#
# Used by the Dockerfile and, through install-mediamtx.sh, by install.sh. See README.md here for what each patch
# is for.
#
# The release tarball is not used because it is a binary. The source for a tag is, and a tag's source
# does not contain two files the project generates, so they are made here:
#
#   internal/core/VERSION          what `mediamtx --version` prints: the version, `-harmony.` and the patch id, so
#                                  a re-run of the installer can tell a build with these patches from any other
#   internal/servers/hls/hls.min.js  the HLS player's script. Harmony turns HLS off (mediamtx.yml), so an
#                                    empty file is enough to satisfy the embed.
#
# Environment:
#   GOOS, GOARCH, GOARM   cross-compile (the Dockerfile sets them from the target platform)
#   NACK_INTERVAL_MS      replaces the interval in mediamtx-nack-interval.patch (default: the patch's, 5)
#
# Needs: curl, tar, patch, and Go as new as the version's go.mod asks (1.26 for MediaMTX 1.21).

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"

# Which patches, and which interval: any change to either is a different build. A checksum of the patch files and
# of NACK_INTERVAL_MS, which cksum gives the same on every system this runs on.
patch_id() {
  { cat "$HERE"/*.patch; printf '%s' "${NACK_INTERVAL_MS:-}"; } | cksum | cut -d' ' -f1
}
if [ "${1:-}" = "--patch-id" ]; then
  patch_id
  exit 0
fi

PREPARE_ONLY=no
if [ "${1:-}" = "--prepare-only" ]; then
  PREPARE_ONLY=yes
  shift
fi

VERSION="${1:?usage: build-mediamtx.sh <version> <output-binary | dir>}"
OUT="${2:?usage: build-mediamtx.sh <version> <output-binary | dir>}"
WORK="$(mktemp -d)"
# The scratch space always goes; with --prepare-only the source is in the output directory, not in it.
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

if [ "$PREPARE_ONLY" = yes ]; then
  mkdir -p "$OUT"
  SRC="$(cd "$OUT" && pwd)"
else
  SRC="$WORK/src"
  mkdir -p "$SRC"
fi

echo "==> Fetching MediaMTX v${VERSION} source"
curl -fsSL "https://github.com/bluenviron/mediamtx/archive/refs/tags/v${VERSION}.tar.gz" \
  | tar -xz -C "$SRC" --strip-components=1

for patch in "$HERE"/*.patch; do
  [ -f "$patch" ] || continue
  echo "==> Applying $(basename "$patch")"
  # -N: a patch that was already applied is an error here rather than a silent half-state
  patch -p1 -N -d "$SRC" < "$patch"
done

# An interval other than the patch's own, for trying one. Only the constant is edited.
if [ -n "${NACK_INTERVAL_MS:-}" ]; then
  case "$NACK_INTERVAL_MS" in
    ''|*[!0-9]*) echo "NACK_INTERVAL_MS must be a whole number of milliseconds" >&2; exit 2 ;;
  esac
  echo "==> NACK interval ${NACK_INTERVAL_MS} ms"
  sed "s/const nackInterval = [0-9]* \* time.Millisecond/const nackInterval = ${NACK_INTERVAL_MS} * time.Millisecond/" \
    "$SRC/internal/protocols/webrtc/peer_connection.go" > "$WORK/peer_connection.go"
  grep -q "const nackInterval = ${NACK_INTERVAL_MS} \* time.Millisecond" "$WORK/peer_connection.go" \
    || { echo "could not set the NACK interval: the patch is not the one this expects" >&2; exit 1; }
  cp "$WORK/peer_connection.go" "$SRC/internal/protocols/webrtc/peer_connection.go"
fi

# The two files a tag's source lacks (see above).
printf 'v%s-harmony.%s' "$VERSION" "$(patch_id)" > "$SRC/internal/core/VERSION"
: > "$SRC/internal/servers/hls/hls.min.js"

if [ "$PREPARE_ONLY" = yes ]; then
  echo "==> Prepared in $SRC (not built)"
  exit 0
fi

echo "==> Building"
(cd "$SRC" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$OUT" .)
echo "==> Built $OUT"
