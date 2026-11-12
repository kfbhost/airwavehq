#!/usr/bin/env bash
# Pack a minimal release tarball for a fresh VPS install.
#
#   bash infra/pack-release.sh                → ../airwavehq-release.tar.gz
#   bash infra/pack-release.sh /tmp/r.tar.gz  → custom location
#
# What's excluded (and why it's safe):
#   - node_modules  — every Dockerfile runs `npm ci` inside the build, so
#                     dependencies are installed fresh on the server
#   - data / .data  — the station's media library lives in Docker volumes on
#                     the server, never in this folder
#   - dist / .git / .env / logs — rebuilt or not needed on the server
#
# The resulting tarball is only a few MB.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/../airwavehq-release.tar.gz}"

cd "$ROOT"

tar czf "$OUT" \
  --exclude=node_modules \
  --exclude=*/node_modules \
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
  --exclude='preview-*.html' \
  --exclude='preview-*.mjs' \
  --exclude=backups \
  --exclude=debug-late-show-start.md \
  .

printf '\nRelease bundle ready:\n'
printf '  %s  (%s)\n' "$OUT" "$(du -sh "$OUT" | awk '{print $1}')"
printf '\nUpload it to a fresh Ubuntu/Debian VPS and run:\n'
printf '  sudo bash infra/install-vps.sh\n'
