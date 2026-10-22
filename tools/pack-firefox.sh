#!/usr/bin/env bash
# Local XPI packer for Firefox (Linux/macOS).
# Stages extension files with manifest.firefox.json -> manifest.json and builds a
# BYTE-REPRODUCIBLE .xpi: entries sorted by path, fixed 1980-01-01 timestamps, fixed
# unix attributes, no extra fields/comments and no directory entries. Same HEAD + same
# python3/zlib therefore produces an identical sha256 regardless of when the tree was
# checked out or extracted (web-ext/zip embed the file mtime and are not reproducible).
# Usage:
#   ./tools/pack-firefox.sh [out-dir]

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$ROOT_DIR/dist-out}"
STAGE_DIR="$ROOT_DIR/dist-firefox"

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/src" "$STAGE_DIR/assets" "$STAGE_DIR/locales" "$OUT_DIR"

cp "$ROOT_DIR/manifest.firefox.json" "$STAGE_DIR/manifest.json"

# Package manifest. Every entry below is loaded at runtime; nothing else is shipped:
# - assets/logo.svg is README-only branding (grep: no manifest/src reference).
# - locales/template.json is the contributor template; bridge.js VALID_LOCALES and the
#   popup loader only request en, vi, ja, ru, zh-cn, zh-tw.
# - LICENSE/README/update/ are repo docs; the Chrome update_url points at GitHub and the
#   Firefox build has no update_url, so none of them is loaded from the package.
FILES=(
  "src/background.js"
  "src/bridge.js"
  "src/inject.js"
  "src/popup.html"
  "src/popup.js"
  "src/harvester.html"
  "src/harvester.js"
  "src/ytm_harvester_cs.js"
  "assets/icon16.png"
  "assets/icon48.png"
  "assets/icon128.png"
)

for f in "${FILES[@]}"; do
  cp "$ROOT_DIR/$f" "$STAGE_DIR/$f"
done

for f in "$ROOT_DIR"/locales/*.json; do
  [ "$(basename "$f")" = "template.json" ] && continue
  cp "$f" "$STAGE_DIR/locales/"
done

VERSION="$(node -p "require('$STAGE_DIR/manifest.json').version")"
XPI_NAME="ytspoofingstream-vorapis-${VERSION}.xpi"
DEST_XPI="$OUT_DIR/$XPI_NAME"

command -v python3 >/dev/null 2>&1 || {
  echo "ERROR: python3 is required for a byte-reproducible XPI (zip/web-ext embed mtimes)" >&2
  exit 1
}

rm -f "$DEST_XPI"
python3 - "$STAGE_DIR" "$DEST_XPI" <<'PY'
import os, sys, zipfile

stage_dir, dest_xpi = sys.argv[1], sys.argv[2]
entries = []
for root, dirs, files in os.walk(stage_dir):
    dirs.sort()
    for name in sorted(files):
        full = os.path.join(root, name)
        rel = os.path.relpath(full, stage_dir).replace(os.sep, '/')
        entries.append((rel, full))
entries.sort(key=lambda e: e[0])

with zipfile.ZipFile(dest_xpi, 'w') as zf:
    for rel, full in entries:
        info = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3          # unix, independent of the build host
        info.external_attr = 0o100644 << 16
        info.extra = b''
        info.comment = b''
        with open(full, 'rb') as fh:
            zf.writestr(info, fh.read(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
PY

echo "Packed Firefox XPI: $DEST_XPI"
sha256sum "$DEST_XPI"
