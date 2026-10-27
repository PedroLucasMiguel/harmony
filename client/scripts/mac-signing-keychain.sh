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

# Prove the identity signs now, not twenty minutes into a build. A self-signed
# certificate is untrusted, and whether codesign will use an untrusted identity
# depends on the machine: a developer's Mac does, a CI runner may not
# ("no identity found"). On CI -- a machine thrown away after the job -- the
# remedies are free: put the keychain in the search list and trust the
# certificate for code signing. Anywhere else, the user's own trust settings are
# not touched and the failure is reported.
probe="$dir/harmony-sign-probe"
try_sign() {
  cp /usr/bin/true "$probe"
  codesign --force --sign "$hash" --keychain "$keychain" "$probe" 2>"$dir/harmony-sign-probe.log"
}
if ! try_sign; then
  if [ -n "${CI:-}${GITHUB_ACTIONS:-}" ]; then
    echo "codesign cannot use the identity as it is; trusting it for code signing (CI only)" >&2
    # shellcheck disable=SC2046
    security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
    security find-certificate -a -p "$keychain" > "$dir/harmony-signing-cert.pem"
    sudo -n security add-trusted-cert -d -r trustRoot -p codeSign \
        -k /Library/Keychains/System.keychain "$dir/harmony-signing-cert.pem" >&2 \
      || security add-trusted-cert -r trustRoot -p codeSign -k "$keychain" "$dir/harmony-signing-cert.pem" >&2 \
      || true
  fi
  if ! try_sign; then
    {
      echo "codesign cannot sign with the identity $hash:"
      cat "$dir/harmony-sign-probe.log"
      echo "--- identities"; security find-identity -p codesigning "$keychain" || true
      echo "--- keychains";  security list-keychains -d user || true
      echo "--- macOS";      sw_vers || true
    } >&2
    exit 1
  fi
fi
rm -f "$probe" "$dir/harmony-sign-probe.log"

echo "HARMONY_MAC_SIGN_HASH=$hash"
echo "HARMONY_MAC_KEYCHAIN=$keychain"
