# AirwaveHQ

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js 20+](https://img.shields.io/badge/node-%E2%89%A520-339933)
![Status: early development](https://img.shields.io/badge/status-early%20development-orange)

A self-hosted internet radio station that runs on your own Linux VPS — no SaaS
fees, no per-listener pricing. Your music, your listeners, your data, all yours.

It combines an always-on automated playout engine, a browser-based Live Studio
for DJs, a weekly schedule that runs the whole station, and polished public
pages for your listeners — everything installed with one script.

> ### 🚧 Early development — not a finished product
>
> AirwaveHQ is a personal project that is **far from finished**. It genuinely
> runs a station (every screenshot below is the real app), but expect rough
> edges, missing features and breaking changes between versions.
>
> **Please test it on a spare VPS, not a live station.** If something breaks, or
> you have an idea for how it ought to work, [open an issue](https://github.com/kfbhost/airwavehq/issues)
> — that is the most useful thing anyone can do for this project right now.
> There's a fuller list of [what's tested and what isn't](#status--how-to-help)
> below.

## Screenshots

![AirwaveHQ dashboard: what's on air, automation health and next up](docs/screenshots/dashboard.png)

| Media Library | Live Studio |
| --- | --- |
| ![Media library with cover art, folders, kinds and formats](docs/screenshots/media-library.png) | ![Live Studio: two decks with waveforms, eight jingle carts, mic and master levels](docs/screenshots/live-studio.png) |

| Show Builder | Clockwheels |
| --- | --- |
| ![Show Builder: a rundown of music tracks, voice links and jingles with Quick build](docs/screenshots/show-builder.png) | ![Clockwheel editor: station ID, music rotation, jingle and ad break slots](docs/screenshots/clockwheels.png) |

| Weekly schedule | Listen Again |
| --- | --- |
| ![Weekly schedule grid with breakfast, dance and Sunday shows](docs/screenshots/schedule.png) | ![Listen Again episode cards with show colours and playback](docs/screenshots/listen-again.png) |

| Public player | Analytics |
| --- | --- |
| ![Public player with now playing artwork and listen live](docs/screenshots/player.png) | ![Analytics: listeners over time and top tracks](docs/screenshots/analytics.png) |

### Embeddable widgets

Every widget is previewed live next to the one-line snippet you paste into your
own site.

![Widgets page: standalone player, player widget, compact bar and now-playing ticker with embed code](docs/screenshots/widgets.png)

## What it does

**Automated playout engine**
- 24/7 automation that never stops: music, jingles, sweepers, station IDs and
  ad breaks all fire exactly to the clock
- Hour-to-hour discipline — tracks crossing the top of the hour fade out and an
  optional top-of-hour jingle plays at exactly `:00`
- Ad breaks anchored at `:15` / `:45` past the hour
- Station-wide audio processing presets (**Gentle / Radio / Punch**) for a
  professional broadcast sound
- Gapless crossfades and per-track loudness normalisation on upload

**Live Studio (in the browser)**
- Two decks with waveforms, crossfader, per-deck EQ and mic ducking
- Jingle carts and a microphone channel with master level control
- DJs can only go live inside their admin-allocated recurring slots
  (server-enforced); go-live custom show name shown on the public player
- Real DJ takeover — automation ducks out, then resumes seamlessly on disconnect

**Programming & schedule**
- Media library with cover art, format/bitrate display, jingles & sweepers
- Playlists, clockwheels (timed position-based rotation), rotation rules
- **Shuffle each pass** — a long playlist (a 24-hour default, for example) can
  restart in a brand-new running order every time it loops, so the same tunes
  never play in the same sequence twice. Jingles and sweepers stay exactly where
  you placed them; the Auto build dialog offers it for new playlists
- Weekly schedule (Monday-first) to plan **Shows, Playlist blocks, Rotation
  blocks and Clockwheel blocks** from one popup
- Show Builder with in-browser voice-link recording and one-click **Quick build**
  (1 / 2 / 3 hr auto-fill from a genre folder)
- Admin-allocated DJ show slots; DJs can only create/edit **their own** shows
- Recordings manager: browse, play, rename, publish/hide and delete automatic
  show recordings

**Listeners & public facing**
- Polished public player, Listen Again page, podcast RSS feed
- Embeddable widgets (player, now-playing ticker, request box)
- Geo-restrictions to block or allow listeners by country

**Monetization & analytics**
- Ad campaigns with flight dates, capping and placement rules, plus a planner
  and airing reports
- Listener analytics: concurrent listeners, top tracks, countries, CSV export

**Operations**
- Light & dark themes, top-bar live-stream play button, full-screen "desktop app" mode
- One-click **Backup & Restore** (database, data, config) with upload
- Webhooks and API keys

## Install on a fresh Linux VPS (one script)

**Requirements:** Ubuntu 22.04+ or Debian 12+, a domain whose **A record** points
at the server, and ports **80** and **443** open. Docker is installed for you if
it isn't there already.

1. Get the code onto the server:

   ```bash
   git clone https://github.com/kfbhost/airwavehq.git
   cd airwavehq
   ```

   (No git on the box? `rsync` the folder over instead — see
   `docs/VPS_SETUP.md`.)

2. Run the installer:

   ```bash
   sudo bash infra/install-vps.sh
   ```

The installer asks for your domain and admin email, generates every secret,
builds and starts the whole station, waits until the API is healthy, and prints
your login details. That's all there is to it.

Unattended / scripting:

```bash
sudo bash infra/install-vps.sh \
  --domain radio.example.com \
  --email boss@example.com \
  --password "a-strong-password" \
  --station "My Radio Station" \
  --timezone Europe/London \
  --yes
```

Re-running the script later just rebuilds and restarts the stack, keeping your
settings.

### After install

1. Log in with the admin email/password shown at the end.
2. **Library** → upload your music (mp3/flac/wav/ogg/m4a).
3. **Playlists** → create a song playlist and add tracks.
4. **Settings** → set your default playlist so AutoDJ can play.
5. The station is broadcasting on the air.

The dashboard lives at `/` and the **Live Studio** at `/studio`. Listeners get
the Icecast stream at `/live`, which is why the studio has its own route.

## Local development

Requires Node 20+, `ffmpeg`/`ffprobe` on your `PATH`, and PostgreSQL.

```bash
npm install
npm run db:push     # create the database schema
npm run dev:api     # API on :8080
npm run dev:engine  # playout engine on :9002 (separate terminal)
npm run dev:web     # dashboard on :5173
```

Open http://localhost:5173 — on a fresh database the first-run screen creates
your admin account. Configuration is read from `process.env` (nothing is loaded
from `.env` automatically); `.env.example` lists every variable, and the Docker
path supplies them through Compose.

Checks:

```bash
npm run typecheck   # all packages
npm test            # unit tests (vitest)
npm run build       # production builds for api, engine, web and widgets
```

### Backups & moving to a new server

Use **Settings → Backups** in the dashboard to create a backup (database, data
and config), download all three files, then **Restore** on the new install. The
code is identical everywhere — only your music and data need moving.

## Status & how to help

**Where it is:** functional enough to run a real station, but early — features
are still moving and things will break. Treat it as a project to test and shape,
not a finished platform to depend on yet.

**Tested so far**

- Fresh install on **Ubuntu 22.04 (x86_64)**: builds, issues a Let's Encrypt
  certificate, plays audio — about 8 minutes end to end
- Upgrading an existing install by rebuilding the images and `up -d`, with the
  database and media left intact

**Not tested yet — these are the most valuable things to try**

- Debian 12 and **arm64 / Raspberry Pi**
- Re-running the installer on an existing install
- Backup → restore onto a clean server
- Anything beyond a handful of concurrent listeners, or running for weeks
- Live Studio across browsers/OSes (microphone capture and Web Audio vary)

**Known rough edges**

- The engine logs a burst of `fetch failed` while the API is starting, and does
  a rapid catch-up fetch after a long idle period (harmless, needs backoff)
- The engine's audio unit tests are excluded from CI until they are verified on Linux (they fail on Windows)
- The dev Widgets page needs `apps/widgets/dist` built before its previews load

**Planned / wanted**

- Scheduled backups and dead-air alerting
- "Recently played" for listeners, and an installable phone-friendly player
- Per-track cue points (intro/outro) and a second low-bitrate stream
- Accessibility and translation pass

**Ways to help**

1. **Test an install** on a spare VPS and [report what broke](https://github.com/kfbhost/airwavehq/issues/new?template=bug_report.yml) —
   include the version from the bottom of the sidebar and the container logs.
2. **Share ideas** via the [feature template](https://github.com/kfbhost/airwavehq/issues/new?template=feature_request.yml) —
   how you run a station, what's missing, what feels wrong.
3. **Send code or docs** — see [CONTRIBUTING.md](CONTRIBUTING.md). Small fixes
   are genuinely welcome; there's no formal process beyond "keep it tidy".

## Where things live

```
infra/
  install-vps.sh       ← run this to install on a fresh VPS
  docker-compose.yml   Full production stack (postgres, icecast, api, engine, web, caddy)
  Caddyfile            Automatic HTTPS + routing
  backup.sh            DB + media backup script
  pack-release.sh      Re-pack this release folder / bundle
apps/
  api/      Fastify REST API, scheduler, auth, analytics
  engine/   Playout engine (playout, Icecast sink, live-DJ WebSocket)
  web/      React dashboard, Live Studio, public player & Listen Again
  widgets/  Embeddable player / now-playing / request widget bundles
packages/
  shared/   Shared types, validation, time utilities
```

## Docs

- `START-HERE.md` — quick start summary
- `docs/VPS_SETUP.md` — full install guide, flags, updates, backups, troubleshooting
- `CONTRIBUTING.md` — how to report problems, suggest ideas or send a change
- `SECURITY.md` — reporting a security issue (and what "early" means here)

## License

MIT — see [LICENSE](LICENSE).