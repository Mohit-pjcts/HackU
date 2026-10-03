#!/usr/bin/env bash
# Creates "Backstage Local Signing": a self-signed code-signing certificate in your login keychain (it never leaves
# this Mac). The overlay signed with it keeps its macOS permissions across rebuilds. Run once per Mac.
set -euo pipefail
NAME="Backstage Local Signing"
if security find-identity -p codesigning 2>/dev/null | grep -q "\"$NAME\""; then echo "already there: $NAME"; exit 0; fi
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
/usr/bin/openssl req -x509 -newkey rsa:2048 -keyout "$D/key.pem" -out "$D/cert.pem" -days 3650 -nodes -subj "/CN=$NAME" \
  -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" -addext "basicConstraints=critical,CA:false" 2>/dev/null
/usr/bin/openssl pkcs12 -export -inkey "$D/key.pem" -in "$D/cert.pem" -out "$D/id.p12" -passout pass:backstage -name "$NAME"
security import "$D/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P backstage -T /usr/bin/codesign >/dev/null
echo "created: $NAME (now run: bash scripts/build-overlay.sh)"
