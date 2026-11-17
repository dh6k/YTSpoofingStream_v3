#!/usr/bin/env bash
# Test-only XPI: same as pack-firefox.sh but additionally ships Vorapis2.user.js
# as a MAIN-world document_start content script, mimicking Tampermonkey.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$ROOT_DIR/dist-firefox-test"
OUT="$ROOT_DIR/dist-out"
VORAPIS="$ROOT_DIR/Vorapis2.user.js"

rm -rf "$STAGE"
mkdir -p "$STAGE/src" "$STAGE/assets" "$STAGE/locales"
cp "$ROOT_DIR/manifest.firefox.json" "$STAGE/manifest.json"
for f in src/background.js src/bridge.js src/inject.js src/popup.html src/popup.js \
         src/harvester.html src/harvester.js src/ytm_harvester_cs.js \
         assets/icon16.png assets/icon48.png assets/icon128.png assets/logo.svg; do
  cp "$ROOT_DIR/$f" "$STAGE/$f"
done
cp "$ROOT_DIR"/locales/*.json "$STAGE/locales/"
cp "$VORAPIS" "$STAGE/src/vorapis_test.js"

node - "$STAGE/manifest.json" <<'JS'
const fs = require('fs');
const p = process.argv[2];
const m = JSON.parse(fs.readFileSync(p, 'utf8'));
m.version = '0.2.7.7'; // distinct so it can coexist with the real addon
m.name = m.name + ' [test]';
m.content_scripts.unshift({
  matches: ['*://*.youtube.com/*'],
  exclude_matches: ['*://music.youtube.com/*'],
  js: ['src/vorapis_test.js'],
  run_at: 'document_start',
  world: 'MAIN'
});
m.web_accessible_resources[0].resources.push('src/vorapis_test.js');
fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
JS

npx --yes web-ext build --source-dir "$STAGE" --artifacts-dir "$OUT" \
  --filename ytspoofingstream-vorapis-0.2.7.7-test.xpi --overwrite-dest >/dev/null
rm -rf "$STAGE"
echo "Packed test XPI: $OUT/ytspoofingstream-vorapis-0.2.7.7-test.xpi"
