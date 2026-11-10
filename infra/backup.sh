#!/usr/bin/env bash
# Backup script for Airshift (self-hosted).
# Usage: BACKUP_DIR=/var/backups/airshift ./backup.sh   (run from the compose dir)
# Cron example: 0 3 * * * cd /opt/airshift && BACKUP_DIR=/var/backups/airshift ./infra/backup.sh
set -euo pipefail

DIR="${BACKUP_DIR:-/var/backups/airshift}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%F-%H%M)"
PG_USER="${POSTGRES_USER:-airshift}"
PG_DB="${POSTGRES_DB:-airshift}"

mkdir -p "$DIR"

cd "$PROJECT_DIR"

echo "[backup] dumping postgres → $DIR/db-$STAMP.sql.gz"
docker compose exec -T postgres pg_dump -U "$PG_USER" "$PG_DB" | gzip > "$DIR/db-$STAMP.sql.gz"

echo "[backup] taring data → $DIR/data-$STAMP.tar.gz"
docker run --rm \
  -v "${PROJECT_DIR##*/}_stationdata":/data:ro \
  -v "$DIR":/backup \
  alpine tar czf "/backup/data-$STAMP.tar.gz" --exclude=backups --exclude=output -C /data .

echo "[backup] taring code → $DIR/code-$STAMP.tar.gz"
docker run --rm \
  -v "$PROJECT_DIR":/code:ro \
  -v "$DIR":/backup \
  alpine tar czf "/backup/code-$STAMP.tar.gz" \
    --exclude=node_modules --exclude=dist --exclude=.git \
    --exclude=data --exclude=.env --exclude='*.log' -C /code .

echo "[backup] copying env → $DIR/env-$STAMP.env"
cp "$PROJECT_DIR/.env" "$DIR/env-$STAMP.env" 2>/dev/null || true

echo "[backup] pruning backups older than 14 days"
find "$DIR" \( -name '*.gz' -o -name '*.env' \) -mtime +14 -delete

echo "[backup] done"
