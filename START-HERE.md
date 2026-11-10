# RadioHost Studio — Start Here

A complete internet radio station: automated playout, scheduled shows, a browser
Live Studio for DJs, show recording with a public Listen Again page, ad campaigns,
listener requests, analytics, widgets, and one-click backups.

## Fresh VPS Install (one script)

1. Put this folder on a **fresh Ubuntu or Debian VPS**, e.g. `/opt/radiohost-studio`
   (clone from git or upload with `rsync` — see `docs/VPS_SETUP.md`).
2. Point your domain's A record at the VPS IP and open ports `80` and `443`.
3. Run:

   ```bash
   sudo bash infra/install-vps.sh
   ```

   It installs Docker, asks for your domain + admin email, generates all secrets,
   builds and starts the whole station, and prints your login details. That's it.

## Local Development

See the README for the monorepo layout and dev commands.

## Docs

- `docs/VPS_SETUP.md` — full install guide, flags, updates, backups, troubleshooting
