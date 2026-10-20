#!/usr/bin/env bash
# Local XPI packer for Firefox (Linux/macOS).
# Stages extension files with manifest.firefox.json -> manifest.json and builds an .xpi package.
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
  "assets/logo.svg"
)

for f in "${FILES[@]}"; do
  cp "$ROOT_DIR/$f" "$STAGE_DIR/$f"
done

cp "$ROOT_DIR"/locales/*.json "$STAGE_DIR/locales/"

VERSION="$(node -p "require('$STAGE_DIR/manifest.json').version")"
XPI_NAME="ytspoofingstream-vorapis-${VERSION}.xpi"
DEST_XPI="$OUT_DIR/$XPI_NAME"

if command -v web-ext >/dev/null 2>&1; then
  web-ext build --source-dir "$STAGE_DIR" --artifacts-dir "$OUT_DIR" --filename "$XPI_NAME" --overwrite-dest >/dev/null
elif npx --no-install web-ext --version >/dev/null 2>&1; then
  npx --no-install web-ext build --source-dir "$STAGE_DIR" --artifacts-dir "$OUT_DIR" --filename "$XPI_NAME" --overwrite-dest >/dev/null
elif command -v zip >/dev/null 2>&1; then
  rm -f "$DEST_XPI"
  (cd "$STAGE_DIR" && zip -qr "$DEST_XPI" .)
else
  python3 - "$STAGE_DIR" "$DEST_XPI" <<'PY'
import os, sys, zipfile
stage_dir, dest_xpi = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dest_xpi, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, _, files in os.walk(stage_dir):
        for file in sorted(files):
            full_path = os.path.join(root, file)
            rel_path = os.path.relpath(full_path, stage_dir)
            zf.write(full_path, rel_path)
PY
fi

echo "Packed Firefox XPI: $DEST_XPI"
