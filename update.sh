#!/bin/sh
# Holt das neueste Image und startet den Container nur neu, wenn es sich geaendert hat.
# Gedacht fuer einen Cronjob, z. B.:  */5 * * * * /pfad/zu/update.sh >> /pfad/zu/update.log 2>&1
set -e
cd "$(dirname "$0")"
OLD=$(docker compose images -q anja 2>/dev/null || true)
docker compose pull -q anja
docker compose up -d anja
NEW=$(docker compose images -q anja 2>/dev/null || true)
[ "$OLD" != "$NEW" ] && echo "$(date '+%F %T') aktualisiert auf $NEW" || true
