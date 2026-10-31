#!/usr/bin/env bash
# Install MediaMTX: Harmony's patched build where one can be made, the published binary where it cannot.
#
# Called by install.sh, and so by `install.sh --update`. It is its own script so that it can be tried on its own:
#
#   MEDIAMTX_VERSION=1.21.0 MTX_ARCH=linux_amd64 sudo server/patches/install-mediamtx.sh
#
# What it does:
#
#   1. Works out what is wanted: the patched build (the default), or with MEDIAMTX_PATCHED=0 the published binary.
#   2. Leaves what is installed alone if it already is that. A patched build says which patches it has in its
#      version (`v1.21.0-harmony.<id>`), so an update that changes a patch builds again and one that does not
#      does not.
#   3. Builds the patched one. It needs no Go on the machine: an official toolchain is fetched, checked against
#      Go's published checksum, used and removed.
#   4. If that cannot be done for any reason -- no network to go.dev, too little memory to compile, a build
#      error -- says why and installs the published binary. An update must never fail, or leave the relay down,
#      because of an improvement. Running it again tries again.
#
# Environment:
#   MEDIAMTX_VERSION   required; the release the configuration is validated against
#   MTX_ARCH           required; linux_amd64 | linux_arm64 | linux_armv7 | linux_armv6
#   MEDIAMTX_PATCHED   0 for the published binary (default 1)
#   DEST               where it goes (default /usr/local/bin/mediamtx)
#   MIN_FREE_MB        memory a build needs available (default 1500; compiling MediaMTX takes about a gigabyte)
#   GO_BOOTSTRAP_VERSION  the toolchain fetched when the machine has no Go that is new enough (default 1.26.0)
#   INSTALL_MEDIAMTX_DRY_RUN=1   say what would be done and stop; INSTALLED_VERSION_OVERRIDE stands in for
#                                `mediamtx --version` (for the tests)

set -euo pipefail

VERSION="${MEDIAMTX_VERSION:?MEDIAMTX_VERSION is required}"
ARCH="${MTX_ARCH:?MTX_ARCH is required}"
WANT_PATCHED="${MEDIAMTX_PATCHED:-1}"
DEST="${DEST:-/usr/local/bin/mediamtx}"
MIN_FREE_MB="${MIN_FREE_MB:-1500}"
GO_BOOTSTRAP="${GO_BOOTSTRAP_VERSION:-1.26.0}"
DRY="${INSTALL_MEDIAMTX_DRY_RUN:-0}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PATCH_ID="$(sh "$HERE/build-mediamtx.sh" --patch-id)"
if [[ -n ${INSTALLED_VERSION_OVERRIDE+x} ]]; then
  INSTALLED="$INSTALLED_VERSION_OVERRIDE"
else
  INSTALLED="$("$DEST" --version 2>&1 | head -n1 || true)"
fi

TMP="$(mktemp -d)"
# Go makes its module cache read-only, which `rm -rf` will not remove until it is made writable again.
cleanup() { chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

# --- what is wanted, and whether it is already here ---------------------------------------------
if [[ "$WANT_PATCHED" == "0" ]]; then
  if [[ "$INSTALLED" == *"v${VERSION}"* && "$INSTALLED" != *-harmony* ]]; then ACTION=keep-release; else ACTION=install-release; fi
else
  if [[ "$INSTALLED" == *"v${VERSION}-harmony.${PATCH_ID}"* ]]; then ACTION=keep-patched; else ACTION=build-patched; fi
fi

if [[ "$DRY" == "1" ]]; then
  echo "$ACTION"
  exit 0
fi

install_release() {
  echo "==> Installing MediaMTX ${VERSION}"
  local tarball="mediamtx_v${VERSION}_${ARCH}.tar.gz"
  curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/v${VERSION}/${tarball}" -o "$TMP/$tarball"
  tar -xzf "$TMP/$tarball" -C "$TMP" mediamtx
  install -m 0755 "$TMP/mediamtx" "$DEST"
  echo "    $("$DEST" --version 2>&1 | head -n1)"
}

# The version of Go on the PATH, as 1.26.0, or nothing.
system_go() {
  command -v go >/dev/null 2>&1 || return 1
  go version 2>/dev/null | sed -n 's/^go version go\([0-9][0-9.]*\).*/\1/p' | head -n1
}

# Is $1 at least $2, both as 1.26.0.
at_least() {
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

# Puts a Go that can build this on the PATH: the machine's own if it is new enough, else an official one.
# Returns 1 with a reason on stderr when there is none.
need_go() {
  local have go_arch sum_file
  have="$(system_go || true)"
  if [[ -n $have ]] && at_least "$have" "$GO_BOOTSTRAP"; then
    echo "    using Go ${have}"
    return 0
  fi
  case "$ARCH" in
    linux_amd64) go_arch=amd64 ;;
    linux_arm64) go_arch=arm64 ;;
    linux_armv7|linux_armv6) go_arch=armv6l ;;
    *) echo "no Go toolchain is published for ${ARCH}" >&2; return 1 ;;
  esac
  echo "    fetching Go ${GO_BOOTSTRAP} (${go_arch}); it is removed afterwards"
  local file="go${GO_BOOTSTRAP}.linux-${go_arch}.tar.gz"
  curl -fsSL "https://dl.google.com/go/${file}" -o "$TMP/$file" || { echo "could not download Go" >&2; return 1; }
  sum_file="$(curl -fsSL "https://dl.google.com/go/${file}.sha256")" || { echo "could not download Go's checksum" >&2; return 1; }
  if command -v sha256sum >/dev/null 2>&1; then
    [[ "$(sha256sum "$TMP/$file" | cut -d' ' -f1)" == "$sum_file" ]] || { echo "Go's checksum does not match" >&2; return 1; }
  elif command -v shasum >/dev/null 2>&1; then
    [[ "$(shasum -a 256 "$TMP/$file" | cut -d' ' -f1)" == "$sum_file" ]] || { echo "Go's checksum does not match" >&2; return 1; }
  else
    echo "nothing here to check Go's checksum with" >&2
    return 1
  fi
  tar -xzf "$TMP/$file" -C "$TMP" || { echo "could not unpack Go" >&2; return 1; }
  export PATH="$TMP/go/bin:$PATH"
}

# The patched build. Every step is checked by hand: this runs in an `if`, where `set -e` does nothing.
try_patched() {
  local tool
  for tool in curl tar patch cksum; do
    command -v "$tool" >/dev/null 2>&1 || { echo "$tool is not installed" >&2; return 1; }
  done

  if [[ -r /proc/meminfo ]]; then
    local free_mb
    free_mb="$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)"
    if [[ -n $free_mb ]] && (( free_mb < MIN_FREE_MB )); then
      echo "only ${free_mb} MB of memory is free and compiling MediaMTX wants ${MIN_FREE_MB}" >&2
      return 1
    fi
  fi

  echo "==> Building MediaMTX ${VERSION} with Harmony's patches"
  need_go || return 1

  # Its own caches inside the temporary directory, so nothing is left on the machine, and two jobs at a time so
  # a small one is not starved while the relay is still running.
  GOCACHE="$TMP/gocache" GOPATH="$TMP/gopath" GOFLAGS="-p=2" GOTOOLCHAIN=local \
    nice -n 10 sh "$HERE/build-mediamtx.sh" "$VERSION" "$TMP/mediamtx-patched" || { echo "the build failed" >&2; return 1; }

  # What was built has to say it is this one, and has to start: it is run once to ask.
  local said
  said="$("$TMP/mediamtx-patched" --version 2>&1 | head -n1)" || true
  [[ "$said" == *"v${VERSION}-harmony.${PATCH_ID}"* ]] || { echo "the build does not report the version it should (${said:-nothing})" >&2; return 1; }

  install -m 0755 "$TMP/mediamtx-patched" "$DEST" || { echo "could not install it" >&2; return 1; }
  echo "    ${said}"
}

case "$ACTION" in
  keep-patched) echo "==> MediaMTX ${VERSION} with Harmony's patches already installed" ;;
  keep-release) echo "==> MediaMTX ${VERSION} already installed" ;;
  install-release) install_release ;;
  build-patched)
    if ! try_patched; then
      echo "!!  Could not build MediaMTX with Harmony's patches (reason above)." >&2
      echo "!!  Installing the published MediaMTX ${VERSION} instead; it works, a lost packet just costs the" >&2
      echo "!!  viewer more. Running the installer again tries the build again." >&2
      install_release
    fi
    ;;
esac
