#!/usr/bin/env bash
# Rebuilds assets/namefonts/*.ttf from the Electron client's woff2 files: unwrapped to TTF, cut to the Latin
# range the woff2 files already cover (less the bits a name never uses), hinting and DSIG dropped.
# Needs fonttools and brotli:  python3 -m venv v && v/bin/pip install fonttools brotli && PATH=v/bin:$PATH dev/export-namefonts.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/../client/src/renderer/fonts"
OUT="$ROOT/assets/namefonts"
TMP="$(mktemp -d)"
mkdir -p "$OUT"
for f in "$SRC"/*.woff2; do
  id="$(basename "$f" .woff2)"
  python3 -c "from fontTools.ttLib import TTFont; f = TTFont('$f'); f.flavor = None; f.save('$TMP/$id.ttf')"
  pyftsubset "$TMP/$id.ttf" --unicodes="U+0020-007E,U+00A0-00FF,U+0100-017F,U+2010-2027,U+20AC,U+2122" \
    --layout-features='kern,liga' --no-hinting --desubroutinize --drop-tables+=DSIG,GPOS --output-file="$OUT/$id.ttf"
done
rm -rf "$TMP"
