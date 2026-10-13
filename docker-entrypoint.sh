#!/bin/sh
# Setzt beim Start die App-Version in Service Worker, App und version.json.
# Dadurch ist sw.js bei jeder neuen Version byte-verschieden -> der Browser
# installiert den neuen Worker und raeumt die alten Caches weg.
set -e
SRC=/opt/anja/public
ROOT=/usr/share/nginx/html
V="${APP_VERSION:-dev}"
[ "$V" = "dev" ] && V="dev-$(cat /opt/anja/build-id)"

rm -rf "$ROOT"/*
cp -a "$SRC"/. "$ROOT"/
for f in sw.js app.js index.html; do
  sed -i "s/__APP_VERSION__/$V/g" "$ROOT/$f"
done
echo "Anja Version $V"

# Hochladen braucht einen beschreibbaren Video-Ordner (Volume ohne ":ro")
if touch /videos/.anja-write-test 2>/dev/null; then
  rm -f /videos/.anja-write-test
  chown nginx:nginx /videos 2>/dev/null || chmod 777 /videos
  mkdir -p /videos/.parts && chown nginx:nginx /videos/.parts 2>/dev/null || true
  # abgebrochene Uploads nach 7 Tagen wegraeumen
  find /videos/.parts -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
  echo "Anja: Hochladen aktiv"
  UPLOAD=true
else
  echo "Anja: /videos ist schreibgeschuetzt - Hochladen deaktiviert"
  UPLOAD=false
fi
printf '{"version":"%s","upload":%s}\n' "$V" "$UPLOAD" > "$ROOT/version.json"
