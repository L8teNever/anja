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
printf '{"version":"%s"}\n' "$V" > "$ROOT/version.json"
echo "Anja Version $V"
