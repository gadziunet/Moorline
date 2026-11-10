#!/usr/bin/env bash
# Stackmoor installer / updater.
#
#   curl -fsSL https://raw.githubusercontent.com/gadziunet/stackmoor/main/install.sh | sudo bash
#
# Installs Docker (if missing), then runs Stackmoor as a container.
# Running it again updates Stackmoor to the latest image. Your stacks and settings are kept.
#
# Optional environment variables (e.g. `curl ... | sudo PORT=8080 bash`):
#   PORT             panel port                         (default: 5001)
#   STACKS_DIR       where stacks are stored            (default: /opt/stacks)
#   INSTALL_DIR      where the panel's files live       (default: /opt/stackmoor)
#   STACKMOOR_IMAGE image to run                       (default: ghcr.io/gadziunet/stackmoor:latest)
#   AUTO_PATCHES     yes/no – automatic security updates of the system (Debian/Ubuntu)
#   AUTO_REBOOT      HH:MM to restart when a patch needs it, or "no"  (default: 04:00)

set -euo pipefail

GITHUB_REPO="gadziunet/stackmoor"
DEFAULT_IMAGE="ghcr.io/${GITHUB_REPO}:latest"

INSTALL_DIR="${INSTALL_DIR:-/opt/stackmoor}"
ENV_FILE="${INSTALL_DIR}/.env"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

# ---------- checks ----------

[ "$(id -u)" -eq 0 ] || die "Run as root, e.g.: curl -fsSL .../install.sh | sudo bash"
[ "$(uname -s)" = "Linux" ] || die "Stackmoor installer supports Linux only."

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "Unsupported CPU architecture: $(uname -m) (supported: x86_64, arm64)." ;;
esac

OS_NAME="Linux"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_NAME="${PRETTY_NAME:-$ID}"
fi

bold "Stackmoor installer"
info "System: ${OS_NAME} (${ARCH})"

# Values given on the command line win; otherwise an update keeps the saved ones.
ARG_PORT="${PORT:-}"
ARG_STACKS_DIR="${STACKS_DIR:-}"
ARG_IMAGE="${STACKMOOR_IMAGE:-}"
UPDATE=0
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  UPDATE=1
fi

PORT="${ARG_PORT:-${PORT:-5001}}"
STACKS_DIR="${ARG_STACKS_DIR:-${STACKS_DIR:-/opt/stacks}}"
STACKMOOR_IMAGE="${ARG_IMAGE:-${STACKMOOR_IMAGE:-$DEFAULT_IMAGE}}"

case "$STACKS_DIR" in
  /*) ;;
  *) die "STACKS_DIR must be an absolute path." ;;
esac
[[ "$PORT" =~ ^[0-9]+$ ]] || die "PORT must be a number."

# ---------- Docker ----------

step "Docker"
if command -v docker >/dev/null 2>&1; then
  info "Docker already installed: $(docker --version | sed 's/Docker version //')"
else
  command -v curl >/dev/null 2>&1 || die "curl is required to install Docker."
  info "Installing Docker (official script from get.docker.com)…"
  curl -fsSL https://get.docker.com | sh
fi

# Docker (and containerd, which it needs) must start with the system – otherwise the panel,
# Caddy and your stacks stay down after a reboot even with restart: unless-stopped.
BOOT_OK=1
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  for unit in containerd docker; do
    systemctl list-unit-files "${unit}.service" >/dev/null 2>&1 || continue
    systemctl enable --now "${unit}.service" >/dev/null 2>&1 || true
    if [ "$(systemctl is-enabled "${unit}.service" 2>/dev/null)" = enabled ]; then
      info "${unit} starts with the system"
    else
      BOOT_OK=0
      warn "${unit} is not set to start with the system. Run: systemctl enable ${unit}"
    fi
  done
else
  BOOT_OK=0
  warn "No systemd here – make sure Docker starts when the system boots."
fi

if ! docker compose version >/dev/null 2>&1; then
  info "Installing the Docker Compose plugin…"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq docker-compose-plugin
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q docker-compose-plugin
  else
    die "Docker Compose plugin is missing. Install it and run this script again."
  fi
fi
info "$(docker compose version)"

docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start it (systemctl start docker) and try again."

# ---------- system patches (Debian/Ubuntu) ----------

# Answers come from the terminal even when the script is piped into bash (curl … | sudo bash).
ask() {
  local prompt="$1" default="$2" reply=""
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '  %s ' "$prompt" > /dev/tty
    read -r reply < /dev/tty || reply=""
  fi
  printf '%s' "${reply:-$default}"
}

UU_CONF=/etc/apt/apt.conf.d/20auto-upgrades
REBOOT_CONF=/etc/apt/apt.conf.d/52stackmoor-reboot
if command -v apt-get >/dev/null 2>&1; then
  step "System patches"
  if grep -qs 'Unattended-Upgrade "1"' "$UU_CONF" && dpkg-query -W -f='${Status}' unattended-upgrades 2>/dev/null | grep -q "install ok installed"; then
    info "Automatic security updates are on"
    [ -f "$REBOOT_CONF" ] && info "Restart after patches: $(sed -n 's/.*Automatic-Reboot-Time "\(.*\)".*/\1/p' "$REBOOT_CONF") (change it in the panel: Settings → Server)"
  else
    PATCHES="${AUTO_PATCHES:-}"
    if [ -z "$PATCHES" ]; then
      if [ -r /dev/tty ]; then
        PATCHES="$(ask 'Install security updates of the system automatically every day? [Y/n]' y)"
      else
        PATCHES=no
        warn "Automatic security updates are off. Turn them on in the panel: Settings → Server."
      fi
    fi
    case "$PATCHES" in
      [Yy]*)
        info "Installing unattended-upgrades…"
        DEBIAN_FRONTEND=noninteractive apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null
        printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > "$UU_CONF"
        info "Automatic security updates are on"
        REBOOT="${AUTO_REBOOT:-}"
        if [ -z "$REBOOT" ]; then
          REBOOT="$(ask 'Restart the server by itself when a patch needs it? Time (HH:MM) or "n" [04:00]:' 04:00)"
        fi
        case "$REBOOT" in
          [Nn]*) info "No automatic restart – the panel shows when the system needs one" ;;
          *)
            [[ "$REBOOT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { warn "\"$REBOOT\" is not a time – using 04:00"; REBOOT=04:00; }
            printf '// Written by Stackmoor – restart the server when a patch needs it.\nUnattended-Upgrade::Automatic-Reboot "true";\nUnattended-Upgrade::Automatic-Reboot-Time "%s";\n' "$REBOOT" > "$REBOOT_CONF"
            info "The server restarts at $REBOOT when a patch needs it; your stacks start again by themselves"
            ;;
        esac
        ;;
      *) info "Skipped – you can turn it on later in the panel: Settings → Server" ;;
    esac
  fi
fi

# ---------- files ----------

step "Files"
mkdir -p "$INSTALL_DIR/data" "$STACKS_DIR"
info "Panel:  $INSTALL_DIR"
info "Stacks: $STACKS_DIR"

if [ "$UPDATE" -eq 0 ] && command -v ss >/dev/null 2>&1 && ss -ltn "( sport = :$PORT )" | grep -q LISTEN; then
  die "Port $PORT is already in use. Choose another one, e.g.: curl ... | sudo PORT=5002 bash"
fi

cat > "$ENV_FILE" <<EOF
# Stackmoor settings – used by install.sh and compose.yaml
PORT=${PORT}
STACKS_DIR=${STACKS_DIR}
STACKMOOR_IMAGE=${STACKMOOR_IMAGE}
EOF
chmod 600 "$ENV_FILE"

# The stacks folder is mounted at the SAME path inside the container,
# because the panel passes paths to the Docker daemon running on the host.
cat > "$INSTALL_DIR/compose.yaml" <<'EOF'
# Generated by install.sh – re-running the installer overwrites this file.
# Change settings in .env instead.
services:
  stackmoor:
    image: ${STACKMOOR_IMAGE}
    container_name: stackmoor
    restart: unless-stopped
    ports:
      - "${PORT}:5001"
    environment:
      - STACKS_DIR=${STACKS_DIR}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${STACKS_DIR}:${STACKS_DIR}
      - ./data:/app/data
EOF
info "Configuration written"

# ---------- start ----------

step "Starting Stackmoor"
cd "$INSTALL_DIR"
docker compose pull --quiet
docker compose up -d --remove-orphans
docker image prune -f --filter "label=org.opencontainers.image.title=stackmoor" >/dev/null 2>&1 || true

printf 'Waiting for the panel'
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/state" >/dev/null 2>&1; then
    READY=1
    break
  fi
  printf '.'
  sleep 1
done
echo

[ "${READY:-0}" = 1 ] || die "Stackmoor did not start. Check: docker logs stackmoor"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
IP="${IP:-<server-ip>}"

echo
if [ "$UPDATE" -eq 1 ]; then
  bold "Stackmoor updated."
else
  bold "Stackmoor is running."
fi
echo
echo "  Open:   http://${IP}:${PORT}"
# First run only: the code the panel asks for before the account can be created.
if SETUP_CODE="$(docker exec stackmoor node src/cli.js setup-code 2>/dev/null)" && [ -n "$SETUP_CODE" ]; then
  echo "  Code:   ${SETUP_CODE}   (asked when you create the account; also in: docker logs stackmoor)"
fi
echo "  Logs:   docker logs -f stackmoor"
echo "  Update: run this installer again"
[ "${BOOT_OK:-1}" = 1 ] && echo "  Boot:   Docker, the panel and your stacks start with the system"
echo
echo "  Stackmoor controls Docker on this machine – keep it on your local network or behind a VPN."
echo
