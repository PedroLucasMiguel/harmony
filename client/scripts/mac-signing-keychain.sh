#!/usr/bin/env bash
# Puts the release signing identity in a throwaway keychain and says where.
#
#   scripts/mac-signing-keychain.sh <identity.p12> <password>
#
# Prints two lines for `source` or $GITHUB_ENV:
#   HARMONY_MAC_SIGN_HASH=<SHA-1 of the certificate>
#   HARMONY_MAC_KEYCHAIN=<path to the keychain>
# which scripts/after-sign.js reads (it passes the keychain to codesign, so the
# user's own keychain search list is left alone). The keychain lives in $RUNNER_TEMP (or the
# system temp dir) and is only ever as long-lived as the build machine.

set -euo pipefail

p12="$1"
password="$2"
dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
keychain="$dir/harmony-signing.keychain-db"
kcpass="$(openssl rand -base64 18)"

security delete-keychain "$keychain" 2>/dev/null || true
security create-keychain -p "$kcpass" "$keychain"
# Never lock: a build that outlives the default five-minute timeout would
# otherwise fail halfway through signing.
security set-keychain-settings "$keychain"
security unlock-keychain -p "$kcpass" "$keychain"
security import "$p12" -k "$keychain" -P "$password" -T /usr/bin/codesign >/dev/null
# Lets codesign use the key without a dialog nobody is there to click.
security set-key-partition-list -S apple-tool:,apple: -s -k "$kcpass" "$keychain" >/dev/null

hash="$(security find-identity -p codesigning "$keychain" | awk '/^ +1\)/ {print $2}')"
[ -n "$hash" ] || { echo "No signing identity in $p12" >&2; exit 1; }

echo "HARMONY_MAC_SIGN_HASH=$hash"
echo "HARMONY_MAC_KEYCHAIN=$keychain"
