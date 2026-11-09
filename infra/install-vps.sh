#!/usr/bin/env bash
# RadioHost Studio — one-shot installer for a fresh Linux VPS (Ubuntu / Debian).
#
#   sudo bash infra/install-vps.sh
#
# It detects and installs Docker, asks for your domain + admin details, generates
# all secrets for you, builds and starts the whole station, waits until it is
# healthy, and prints your login details.
#
# Options (non-interactive / scripting):
#   --domain radio.example.com   Required for a first install (or DOMAIN= env)
#   --email admin@example.com    Admin login email (or ADMIN_EMAIL= env)
#   --password "..."             Admin password (auto-generated if omitted)
#   --station "My Radio Station" Station display name
#   --timezone Europe/London     Station timezone
#   --yes                        Don't prompt — use defaults / auto-generate
#   --dry-run                    Print the .env that would be created, then exit
#   --verbose                    Show the raw build/install output (default: a clean log)
#
# Re-running with an existing .env simply rebuilds and restarts the stack.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="$PROJECT_DIR/infra/docker-compose.yml"
LOG_FILE="${RADIOHOST_INSTALL_LOG:-$PROJECT_DIR/.install.log}"
VERBOSE=0

# ------------------------------------------------------------- presentation ----

if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; RST=""
fi

TOTAL_STEPS=6
_step=0
START_TS=$(date +%s)

banner() {
  printf '%s' "$CYAN"
  cat <<'EOF'
   ____      _         _   _           _       _   _
  |  _ \ ___| |__ ___ | | | | ___  ___| |_ ___| |_(_) ___  _ __
  | |_) / _ \ '_ \/ __| |_| |/ _ \/ __| __/ __| __| |/ _ \| '_ \
  |  __/  __/ |_) \__ \  _  | (_) \__ \ |_\__ \ |_| | (_) | | | |
  |_|   \___|_.__/|___/_| |_|\___/|___/\__|___/\__|_|\___/|_| |_|
EOF
  printf '%s' "$RST"
  printf '  %sSelf-hosted internet radio — installed with one script%s\n' "$DIM" "$RST"
  printf '  %sDocker · PostgreSQL · Icecast · React · Node%s\n\n' "$DIM" "$RST"
}

step() { _step=$((_step + 1)); printf '\n%s[%d/%d]%s %s%s%s\n' "$CYAN" "$_step" "$TOTAL_STEPS" "$RST" "$BOLD" "$1" "$RST"; }
ok()   { printf '   %s✔%s %s\n' "$GREEN" "$RST" "$1"; }
info() { printf '   %s›%s %s\n' "$DIM" "$RST" "$1"; }
warn() { printf '   %s!%s %s\n' "$YELLOW" "$RST" "$1"; }
die()  {
  printf '\n   %s✘ %s%s\n' "$RED" "$1" "$RST"
  printf '   %sDetails: %s%s\n\n' "$DIM" "$LOG_FILE" "$RST"
  exit 1
}

# Run a command quietly (output to the log), showing a single clean status line.
# Usage: task "Description" cmd args...
task() {
  local desc="$1"; shift
  if [ "$VERBOSE" = "1" ]; then
    printf '   %s› %s%s\n' "$DIM" "$desc" "$RST"
    "$@" || die "$desc"
    ok "$desc"
    return 0
  fi
  printf '   %s' "$desc"
  if "$@" >>"$LOG_FILE" 2>&1; then
    printf '   %s✔%s\n' "$GREEN" "$RST"
  else
    printf '   %s✘%s\n' "$RED" "$RST"
    die "$desc"
  fi
}

# ------------------------------------------------------------- helpers --------

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

is_tty() { [ -t 0 ] && [ -t 1 ]; }

# prompt <label> <default> <varname> — asks unless already set via flag/env.
prompt() {
  local label="$1" default="$2" var="$3" val=""
  if [ -n "${!var:-}" ]; then return; fi
  if is_tty; then
    if [ -n "$default" ]; then
      printf '   %s%s%s [%s]: ' "$BOLD" "$label" "$RST" "$default"
    else
      printf '   %s%s%s: ' "$BOLD" "$label" "$RST"
    fi
    read -r val
    val="${val:-$default}"
  else
    val="$default"
  fi
  printf -v "$var" '%s' "$val"
}

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# Point Docker at a Hub mirror (some servers can't reach registry-1.docker.io directly).
configure_registry_mirror() {
  mkdir -p /etc/docker
  if [ -f /etc/docker/daemon.json ] && grep -q "registry-mirrors" /etc/docker/daemon.json; then
    info "A registry mirror is already configured"
    return 0
  fi
  printf '{\n  "registry-mirrors": ["https://mirror.gcr.io"]\n}\n' > /etc/docker/daemon.json
  systemctl restart docker
  sleep 3
  ok "Enabled a Docker Hub mirror (this server couldn't reach Docker Hub directly)"
}

# Build + start, and if it fails due to Docker Hub being unreachable, enable a
# mirror and retry once before giving up.
build_and_start() {
  printf '   %s' "Building and starting the station"
  if compose up -d --build >>"$LOG_FILE" 2>&1; then
    printf '   %s✔%s\n' "$GREEN" "$RST"
    return 0
  fi
  printf '   %s✘%s\n' "$RED" "$RST"
  if grep -qiE "registry-1\.docker\.io|i/o timeout|failed to resolve source metadata|dial tcp|TLS handshake timeout|net/http: request canceled|toomanyrequests|no such host" "$LOG_FILE"; then
    warn "Docker Hub looks unreachable from this server — enabling a mirror and retrying…"
    configure_registry_mirror
    printf '   %s' "Rebuilding with the mirror"
    if compose up -d --build >>"$LOG_FILE" 2>&1; then
      printf '   %s✔%s\n' "$GREEN" "$RST"
      return 0
    fi
    printf '   %s✘%s\n' "$RED" "$RST"
  fi
  die "Build/start failed — see $LOG_FILE (or re-run with --verbose to watch it)"
}

install_docker_if_needed() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    ok "Docker and the Compose plugin are already installed"
    return
  fi
  # Pick a Docker repo codename that actually exists (fall back for brand-new OS releases).
  DOCKER_CODENAME="$OS_CODENAME"
  if ! curl -fsSL -o /dev/null "https://download.docker.com/linux/${OS_ID}/dists/${OS_CODENAME}/Release" 2>/dev/null; then
    case "$OS_ID" in
      debian) DOCKER_CODENAME="bookworm" ;;
      ubuntu) DOCKER_CODENAME="jammy" ;;
    esac
    warn "Docker has no '${OS_CODENAME}' repo yet — using '${DOCKER_CODENAME}' packages instead."
  fi
  task "Installing Docker (this can take a minute or two)" bash -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/'"${OS_ID}"'/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/'"${OS_ID}"' '"${DOCKER_CODENAME}"' stable" > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable docker
    systemctl start docker
  '
  ok "Docker installed"
}

check_preflight() {
  local domain="$1"
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE ':(80|443)\s'; then
    warn "Something is already listening on port 80/443 — the site may not be reachable."
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw status 2>/dev/null | grep -qE '^80/tcp'  || warn "ufw is active and port 80 is not allowed. Run: ufw allow 80/tcp && ufw allow 443/tcp"
    ufw status 2>/dev/null | grep -qE '^443/tcp' || warn "ufw is active and port 443 is not allowed. Run: ufw allow 443/tcp"
  fi
  if command -v free >/dev/null 2>&1; then
    local ram_mb; ram_mb="$(free -m | awk '/^Mem:/{print $2}')"
    if [ -n "$ram_mb" ] && [ "$ram_mb" -lt 1500 ]; then
      warn "Only ${ram_mb} MB RAM — the first build may be slow. Consider adding 2G of swap."
    fi
  fi
  if command -v df >/dev/null 2>&1; then
    local free_kb; free_kb="$(df -k "$PROJECT_DIR" | awk 'NR==2{print $4}')"
    if [ -n "$free_kb" ] && [ "$free_kb" -lt 10485760 ]; then
      warn "Less than 10 GB free disk — the media library and backups need room."
    fi
  fi
  local ip pub=""
  ip="$(getent hosts "$domain" | awk '{print $1}' | head -1 || true)"
  if [ -z "$ip" ]; then
    info "$domain does not resolve yet — HTTPS appears automatically once it does (Caddy retries)."
  else
    pub="$(curl -4 -s --max-time 5 ifconfig.me 2>/dev/null || curl -4 -s --max-time 5 icanhazip.com 2>/dev/null || true)"
    if [ -n "$pub" ] && [ "$ip" != "$pub" ]; then
      warn "$domain resolves to $ip but this server looks like $pub — check the A record."
    fi
  fi
  ok "Preflight complete"
}

wait_for_health() {
  printf '   Waiting for the API to become healthy '
  local tries=0 api="" state=""
  while [ "$tries" -lt 120 ]; do
    tries=$((tries + 1))
    printf '.'
    api="$(compose ps -q api 2>/dev/null || true)"
    if [ -n "$api" ]; then
      state="$(docker inspect -f '{{.State.Status}}' "$api" 2>/dev/null || true)"
      if [ -n "$state" ] && [ "$state" != "running" ]; then
        printf '\n'
        die "The API container is $state — run with --verbose or see $LOG_FILE"
      fi
      if docker exec "$api" wget -qO- http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
        printf '\n'
        ok "API is healthy"
        return 0
      fi
    fi
    sleep 3
  done
  printf '\n'
  warn "The API did not report healthy in time — check: docker compose -f infra/docker-compose.yml --env-file .env logs api"
}

env_value() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }

show_summary() {
  local domain email elapsed
  domain="$(env_value DOMAIN)"
  email="$(env_value ADMIN_EMAIL)"
  elapsed=$(( $(date +%s) - START_TS ))
  printf '\n%s  Done — your station is live in %ss.%s\n' "$BOLD" "$elapsed" "$RST"
  printf '\n'
  printf '  %s┌────────────────────────────────────────────────────────────┐%s\n' "$CYAN" "$RST"
  printf '  %s│%s  Dashboard      %shttps://%s%s\n' "$CYAN" "$RST" "$BOLD" "$domain" "$RST"
  printf '  %s│%s  Public player  %shttps://%s/listen%s\n' "$CYAN" "$RST" "$BOLD" "$domain" "$RST"
  printf '  %s│%s  Live stream    %shttps://%s/live%s\n' "$CYAN" "$RST" "$BOLD" "$domain" "$RST"
  printf '  %s│%s  Podcast feed   https://%s/api/public/podcasts.rss\n' "$CYAN" "$RST" "$domain"
  printf '  %s└────────────────────────────────────────────────────────────┘%s\n' "$CYAN" "$RST"
  printf '\n  Admin login:    %s%s%s\n' "$BOLD" "$email" "$RST"
  if [ "${GENERATED_PASSWORD:-0}" = "1" ]; then
    printf '  Admin password: %s%s%s   %s← save this somewhere safe%s\n' "$BOLD" "$(env_value ADMIN_PASSWORD)" "$RST" "$DIM" "$RST"
  else
    printf '  Admin password: %s(the one you chose)%s\n' "$DIM" "$RST"
  fi
  printf '\n  %sNext:%s log in, upload music to the Media Library, then set a default\n' "$BOLD" "$RST"
  printf '  playlist in Settings so AutoDJ can play.\n'
  if [ -z "$(getent hosts "$domain" | awk '{print $1}' | head -1 || true)" ]; then
    printf '\n  %sNote:%s point an A record for %s at this server — HTTPS appears automatically.\n' "$DIM" "$RST" "$domain"
  fi
  printf '\n'
}

# ------------------------------------------------------------ arg parsing ----

DRY_RUN=0
GENERATED_PASSWORD=0
DOMAIN="${DOMAIN:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
STATION_NAME="${STATION_NAME:-}"
STATION_TIMEZONE="${STATION_TIMEZONE:-Europe/London}"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)   DOMAIN="${2:-}"; shift 2 ;;
    --email)    ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --password) ADMIN_PASSWORD="${2:-}"; shift 2 ;;
    --station)  STATION_NAME="${2:-}"; shift 2 ;;
    --timezone) STATION_TIMEZONE="${2:-}"; shift 2 ;;
    --yes)      shift ;;
    --verbose)  VERBOSE=1; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  sed -n '2,22p' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (see the header of this script for usage)" ;;
  esac
done

# ------------------------------------------------------------------- main ----

main() {
  : > "$LOG_FILE" 2>/dev/null || LOG_FILE="/tmp/radiohost-install.log"
  banner

  # Preflight (root / OS) — dry-run only needs a shell.
  if [ "$DRY_RUN" -ne 1 ] && [ "${EUID:-$(id -u)}" -ne 0 ]; then
    die "Run this script as root: sudo bash infra/install-vps.sh"
  fi
  if [ "$DRY_RUN" -ne 1 ]; then
    [ -f /etc/os-release ] || die "Could not detect the operating system."
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-}"
    OS_CODENAME="${VERSION_CODENAME:-}"
    if [ "$OS_ID" != "ubuntu" ] && [ "$OS_ID" != "debian" ]; then
      die "This installer supports Ubuntu and Debian. Detected: ${PRETTY_NAME:-unknown}."
    fi
  fi
  [ -f "$COMPOSE_FILE" ] || die "Could not find infra/docker-compose.yml — run this from inside the project folder."

  # Already configured? Skip prompts, just (re)start the stack.
  if [ -f "$ENV_FILE" ] && [ -n "$(env_value DOMAIN)" ] && ! grep -qE "change-me" "$ENV_FILE"; then
    step "Preflight"
    check_preflight "$(env_value DOMAIN)"
    step "Docker"
    install_docker_if_needed
    step "Configuration"
    info "Found an existing .env — keeping your settings."
    step "Build & start"
    build_and_start
    step "Health check"
    wait_for_health
    step "Ready"
    show_summary
    return 0
  fi

  # ---------------------------------------------------- first-time setup ----
  step "Preflight"
  info "Creating a fresh configuration. All secrets are generated automatically."

  DOMAIN="$(printf '%s' "$DOMAIN" | sed -E 's#^https?://##' | sed -E 's#/$##' | tr '[:upper:]' '[:lower:]')"
  prompt "Your domain (e.g. radio.example.com)" "" DOMAIN
  [ -n "$DOMAIN" ] || die "A domain is required for the free HTTPS certificate (pass --domain radio.example.com)."
  case "$DOMAIN" in
    *[!a-zA-Z0-9.-]*|*..*|.*|..*) die "That doesn't look like a valid domain: $DOMAIN" ;;
  esac

  prompt "Station name" "My Radio Station" STATION_NAME
  if is_tty && [ -z "$ADMIN_EMAIL" ]; then
    prompt "Admin email (login)" "" ADMIN_EMAIL
  fi
  [ -n "$ADMIN_EMAIL" ] || die "An admin email is required for the first login (pass --email you@example.com)."
  case "$ADMIN_EMAIL" in
    *@*.*) : ;;
    *) die "That doesn't look like a valid email: $ADMIN_EMAIL" ;;
  esac

  if [ -z "$ADMIN_PASSWORD" ] && is_tty; then
    printf '   %sAdmin password%s (blank = auto-generate): ' "$BOLD" "$RST"
    read -r -s entered; printf '\n'
    ADMIN_PASSWORD="$entered"
  fi
  if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD="$(gen_secret)"
    GENERATED_PASSWORD=1
  fi
  [ "${#ADMIN_PASSWORD}" -ge 8 ] || die "The admin password must be at least 8 characters."

  {
    echo "# RadioHost Studio — generated by infra/install-vps.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "DOMAIN=$DOMAIN"
    echo "JWT_SECRET=$(gen_secret)"
    echo "ENGINE_SECRET=$(gen_secret)"
    echo ""
    echo "# ---- Station ----"
    echo "STATION_NAME=$STATION_NAME"
    echo "STATION_TIMEZONE=$STATION_TIMEZONE"
    echo "PUBLIC_BASE_URL=https://$DOMAIN"
    echo "PUBLIC_STREAM_URL=https://$DOMAIN/live"
    echo ""
    echo "# ---- First-run admin bootstrap ----"
    echo "ADMIN_EMAIL=$ADMIN_EMAIL"
    echo "ADMIN_PASSWORD=$ADMIN_PASSWORD"
    echo "ADMIN_NAME=Station Owner"
    echo ""
    echo "# ---- Streaming ----"
    echo "ICECAST_SOURCE_PASSWORD=$(gen_secret)"
    echo "ICECAST_ADMIN_PASSWORD=$(gen_secret)"
    echo "ICECAST_RELAY_PASSWORD=$(gen_secret)"
    echo "ICECAST_HOSTNAME=$DOMAIN"
    echo "ICECAST_MOUNT=/live"
    echo "ICE_BITRATE=128"
    echo "ICE_PUBLIC=0"
    echo "ICE_CODEC=mp3"
    echo "CROSSFADE_MS=2000"
    echo "AUDIO_PROCESSING=1"
    echo ""
    echo "# ---- Postgres (container only) ----"
    echo "POSTGRES_USER=radiohost"
    echo "POSTGRES_PASSWORD=$(gen_secret)"
    echo "POSTGRES_DB=radiohost"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\n%sDRY RUN — the .env below is what would be written (nothing changed):%s\n' "$YELLOW" "$RST"
    cat "$ENV_FILE"
    rm -f "$ENV_FILE"
    return 0
  fi

  ok "Domain $DOMAIN · station “$STATION_NAME”"
  info "Environment written to .env (600 permissions, secrets kept private)"

  step "Docker"
  install_docker_if_needed

  step "Configuration"
  check_preflight "$DOMAIN"

  step "Build & start"
  build_and_start

  step "Health check"
  wait_for_health

  step "Ready"
  show_summary
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
