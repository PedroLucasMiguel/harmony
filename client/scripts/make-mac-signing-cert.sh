#!/usr/bin/env bash
# Makes the certificate macOS releases are signed with. Run once, ever.
#
#   scripts/make-mac-signing-cert.sh [folder] [--set-secrets]
#
# --set-secrets stores both values as repository secrets with the GitHub CLI
# (`gh`, signed in, run from a checkout), from this one run. Do that rather than
# pasting: every run makes a NEW password, and a certificate paired with another
# run's password fails the build with "MAC verification failed ... wrong password".
#
# Why a certificate at all: an ad-hoc signature (what "-" in electron-builder.yml
# gives) has no identity. Its designated requirement is the hash of that one
# build, so to macOS every release is a different app -- Screen Recording,
# Camera and Microphone are granted again each time, and Squirrel.Mac refuses
# to swap one build for another. Signed with one certificate, every release
# carries the same requirement, permissions stay granted, and the app can
# update itself (src/main/updater.js).
#
# The certificate is self-signed, so it costs nothing and proves nothing:
# Gatekeeper still asks on the first open, exactly as it does today. Only
# updates the app downloads itself skip that, because nothing quarantines them.
#
# The private key IS the identity. Lose it and the next release is a new app
# to macOS (one more round of permissions, one more manual install); leak it
# and anyone can sign an "update" the installed apps will accept. Keep the .p12
# somewhere safe and put it in the repository secrets, nowhere else.

set -euo pipefail

out=""
set_secrets=0
for arg in "$@"; do
  case "$arg" in
    --set-secrets) set_secrets=1 ;;
    *) out="$arg" ;;
  esac
done
out="${out:-harmony-mac-signing}"
mkdir -p "$out"
password="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"

cat > "$out/openssl.cnf" <<CONF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = Harmony Release Signing
O = Harmony
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
CONF

openssl req -x509 -newkey rsa:2048 -nodes -days 10950 \
  -keyout "$out/key.pem" -out "$out/cert.pem" -config "$out/openssl.cnf" 2>/dev/null
# -legacy: macOS' `security import` cannot read the newer PKCS#12 encryption
# OpenSSL 3 defaults to. (Older OpenSSL / LibreSSL has no such flag.)
openssl pkcs12 -export -legacy -inkey "$out/key.pem" -in "$out/cert.pem" \
  -out "$out/harmony-mac-signing.p12" -passout "pass:$password" 2>/dev/null \
  || openssl pkcs12 -export -inkey "$out/key.pem" -in "$out/cert.pem" \
       -out "$out/harmony-mac-signing.p12" -passout "pass:$password"
rm -f "$out/key.pem" "$out/openssl.cnf"

# The pair has to open, or the release build will not be able to use it.
# (-legacy: OpenSSL 3+ will not read the old encryption macOS needs without it.)
{ openssl pkcs12 -legacy -in "$out/harmony-mac-signing.p12" -passin "pass:$password" -noout 2>/dev/null \
  || openssl pkcs12 -in "$out/harmony-mac-signing.p12" -passin "pass:$password" -noout 2>/dev/null; } \
  || { echo "The .p12 does not open with its own password -- not usable." >&2; exit 1; }

base64 < "$out/harmony-mac-signing.p12" | tr -d '\n' > "$out/harmony-mac-signing.p12.base64"

if [ "$set_secrets" = 1 ]; then
  gh secret set MAC_SIGNING_P12_BASE64 < "$out/harmony-mac-signing.p12.base64"
  gh secret set MAC_SIGNING_P12_PASSWORD --body "$password"
  echo "Repository secrets set from this run."
fi

cat <<MSG

Made in $out/ :
  harmony-mac-signing.p12          the identity (key + certificate). Keep it safe.
  harmony-mac-signing.p12.base64   the same, as one line, for a secret
  cert.pem                         the public half; harmless

$([ "$set_secrets" = 1 ] && echo "(The secrets are already set; the rest is for the record.)")

Add two repository secrets (Settings > Secrets and variables > Actions) -- BOTH from
this run, never one from here and one from an earlier run:

  MAC_SIGNING_P12_BASE64     the contents of harmony-mac-signing.p12.base64
  MAC_SIGNING_P12_PASSWORD   $password

or, with the GitHub CLI:

  gh secret set MAC_SIGNING_P12_BASE64 < $out/harmony-mac-signing.p12.base64
  gh secret set MAC_SIGNING_P12_PASSWORD --body '$password'

Then delete the .base64 file, and never commit this folder.
MSG
