# Changelog

All notable changes to AirwaveHQ are recorded here. The format is loosely based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[SemVer](https://semver.org/).

This is early software: expect behaviour to change between versions. Entries
also note what is *not* tested, because that matters as much as what is.

## [Unreleased]

### Added

- **About this server** page (Settings → About, admin only, `/api/about`): the
  version and build, Node/OS/architecture, uptime and memory, the PostgreSQL and
  ffmpeg versions, and the station configuration, with a **Copy diagnostics**
  button for bug reports.
- `CHANGELOG.md` and this repository's first CI workflow (typecheck, tests and
  builds on every push and pull request).

### Changed

- Renamed the product from Airshift to AirwaveHQ (package scope `@airwavehq/*`,
  repository `kfbhost/airwavehq`, UI, docs and installer defaults).
- The Live Studio now lives at `/studio`; `/live` belongs to the Icecast stream.

### Fixed

- Validation errors return `400` with field details instead of `500`.
- Bootstrap refuses an `ADMIN_EMAIL` that sign-in would reject.
- Media URLs are built from the file name, so artwork and previews work with
  Windows-style paths.

## [2.0.0] — 2026-11-12

### Added

- First public release: automated playout, Live Studio, scheduling, Show Builder,
  Listen Again with podcast RSS, widgets, analytics, ad campaigns, backups.
- One-script VPS install (`infra/install-vps.sh`) verified on Ubuntu 22.04
  (x86_64); upgrading by rebuilding the images is also verified.

### Not tested yet

- Debian 12, arm64/Raspberry Pi, the installer's own re-run, and backup restore.
