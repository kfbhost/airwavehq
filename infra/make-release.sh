#!/usr/bin/env bash
# Create a self-contained release folder: the full application source plus the
# one-shot installer — nothing you don't need (no node_modules, no data, no .git).
#
#   bash infra/make-release.sh              → ../airshift-release/
#   bash infra/make-release.sh /tmp/rel     → custom location
#
# Move the folder to a fresh Ubuntu/Debian VPS, then run:
#   cd airshift-release && sudo bash infra/install-vps.sh
#
# Everything excluded is safe: the Docker build installs dependencies itself
# (npm ci), and the station's media lives in Docker volumes on the server.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$ROOT/../airshift-release}"

rm -rf "$DEST"
mkdir -p "$DEST"

rsync -a --delete \
  --exclude=node_modules \
  --exclude=data \
  --exclude=.data \
  --exclude=dist \
  --exclude=.git \
  --exclude=.env \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude=coverage \
  --exclude=.dbg \
  --exclude=.freebuff \
  --exclude=superpowers \
  --exclude=backups \
  --exclude='preview-*.html' \
  --exclude='preview-*.mjs' \
  --exclude=debug-late-show-start.md \
  "$ROOT"/ "$DEST"/

chmod +x "$DEST/infra/install-vps.sh" "$DEST/infra/pack-release.sh" "$DEST/infra/backup.sh" "$DEST/infra/make-release.sh"

# Use the release-focused README (features + one-script install) as the main
# README in the bundle, instead of the developer monorepo readme.
if [ -f "$ROOT/docs/RELEASE_README.md" ]; then
  cp "$ROOT/docs/RELEASE_README.md" "$DEST/README.md"
fi

printf '\nRelease folder ready:\n  %s  (%s)\n' "$DEST" "$(du -sh "$DEST" | awk '{print $1}')"
printf '\nMove it to a fresh Ubuntu/Debian VPS, then run:\n  cd airshift-release && sudo bash infra/install-vps.sh\n'

# Pack the tarball too, so a single command always produces both the folder and
# the uploadable bundle — nothing to remember after a source change.
if command -v tar >/dev/null 2>&1; then
  TARBALL="${DEST%/}.tar.gz"
  ( cd "$DEST" && tar czf "$TARBALL" \
      --exclude=node_modules \
      --exclude=data \
      --exclude=.data \
      --exclude=dist \
      --exclude=.git \
      --exclude=.env \
      --exclude='*.log' \
      --exclude=.DS_Store \
      --exclude=coverage \
      --exclude=.dbg \
      --exclude=.freebuff \
      --exclude=superpowers \
      --exclude=backups \
      --exclude='preview-*.html' \
      --exclude='preview-*.mjs' \
      --exclude=debug-late-show-start.md \
      . )
  printf '\nRelease bundle (for upload):\n  %s  (%s)\n' "$TARBALL" "$(du -sh "$TARBALL" | awk '{print $1}')"
fi
