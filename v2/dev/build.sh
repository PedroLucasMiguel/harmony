#!/usr/bin/env bash
# Builds the client with its version number set, the way a release does: the number of the Electron client's package.json
# unless VERSION is given.   v2/dev/build.sh [out]      VERSION=5.3.0 v2/dev/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${VERSION:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' ../client/package.json | head -1)}"
GUI=""
if [ "$(go env GOOS)" = windows ]; then GUI="-H=windowsgui"; fi
go build -tags nocgo -ldflags "-s -w $GUI -X harmony/v2/internal/version.Number=$VERSION" -o "${1:-harmony2}" ./cmd/harmony2
echo "built ${1:-harmony2} $VERSION"
