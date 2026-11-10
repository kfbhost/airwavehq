# RadioHost VPS Setup Guide

A **fresh Ubuntu or Debian VPS** can be running the whole station with **one script**.
The installer installs Docker, generates all secrets, builds the stack, waits until
it's healthy, and prints your login details â€” no manual `.env` editing required.

## What You Need

- Ubuntu 22.04/24.04 or Debian 12 VPS (any architecture Docker supports)
- A domain pointed at the VPS IP (A record) â€” needed for the free HTTPS certificate
- Ports `80` and `443` open
- About `2 GB RAM` and `20 GB disk`
- Your project files, either cloned from git or uploaded with `rsync` (below)

## 1. Put the App on the Server

### Option A: clone from git

```bash
mkdir -p /opt && cd /opt
git clone https://github.com/kfbhost/radiohost-studio.git radiohost-studio
cd /opt/radiohost-studio
```

### Option B: upload from your computer

```bash
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .DS_Store \
  --exclude .env --exclude dist --exclude build --exclude .turbo \
  /path/to/radiohost-studio/ root@YOUR_SERVER_IP:/opt/radiohost-studio/
```

## 2. Run the Installer (that's it)

```bash
sudo bash infra/install-vps.sh
```

The script asks you three things the first time â€” **domain**, **station name** and
**admin email** â€” and auto-generates a strong admin password (shown once at the end,
also saved in `.env`). Everything else (JWT secrets, database password, Icecast
passwords) is generated automatically. It then:

1. installs Docker + the Compose plugin if missing
2. runs preflight checks (ports, firewall, RAM, DNS) and warns about anything
3. builds and starts all six services
4. waits until the API is healthy (first boot can take a few minutes)
5. prints the URLs and admin login

For a fully unattended install you can pass everything as flags:

```bash
sudo bash infra/install-vps.sh \
  --domain radio.example.com \
  --email boss@example.com \
  --password "a-strong-password" \
  --station "My Radio Station" \
  --yes
```

Preview what would be created without touching anything:

```bash
bash infra/install-vps.sh --dry-run --domain radio.example.com --email boss@example.com --yes
```

## 3. After It Finishes

- Open `https://your-domain.com` and log in with the admin email/password shown
- Go to **Media Library** and upload music
- Create at least one playlist in **Playlists**
- Set that playlist as the default in **Settings**

A fresh install is fully healthy but **idle** until music is uploaded and a default
playlist is set.

## URLs

- Dashboard: `https://your-domain.com`
- Public player: `https://your-domain.com/listen`
- Live stream: `https://your-domain.com/live`
- Podcast feed: `https://your-domain.com/api/public/podcasts.rss`

## Updating / Re-running

Rerunning the installer with an existing `.env` simply rebuilds and restarts the
stack (it never overwrites your settings):

```bash
sudo bash infra/install-vps.sh
```

Or use compose directly:

```bash
cd /opt/radiohost-studio
docker compose -f infra/docker-compose.yml --env-file .env up -d --build
docker compose -f infra/docker-compose.yml --env-file .env ps
docker compose -f infra/docker-compose.yml --env-file .env logs -f
```

## Backups

- The dashboard has a **ðŸ’¾ Backups** page â€” one-click full snapshots (database +
  library + recordings + config), with download and restore.
- `infra/backup.sh` is the host-side script for scheduled cron backups; it bundles
  the code too and keeps the last 14 days. Example cron:
  `0 3 * * * cd /opt/radiohost-studio && BACKUP_DIR=/var/backups/radiohost ./infra/backup.sh`

## Troubleshooting

- **HTTPS not appearing** â€” Caddy issues certificates automatically once the A
  record resolves and ports 80/443 are open; it keeps retrying, so just wait.
- **Stream silent** â€” upload music and set a default playlist in Settings.
- **First build seems slow** â€” normal on a small VPS; add swap if the box has
  under 2 GB RAM (the installer warns you and shows the exact commands).
- **Everything running but the dashboard errors** â€” check the API:
  `docker compose -f infra/docker-compose.yml --env-file .env logs api`
