#!/usr/bin/env bash
# One-time server setup for Ubuntu 22.04/24.04 or Debian 12 (x86_64 or arm64).
# Run from the uploaded project folder:  sudo bash deploy/setup.sh
# Safe to rerun — that's also how code updates are deployed.
set -euo pipefail

APP_USER=cwbot
APP_DIR=/opt/courseworks-bot
NODE_MAJOR=24
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }

echo "==> System packages"
apt-get -o DPkg::Lock::Timeout=600 update -y
apt-get -o DPkg::Lock::Timeout=600 install -y curl ca-certificates rsync xz-utils

echo "==> Node.js ${NODE_MAJOR}"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  NODE_ARCH=$([ "$(uname -m)" = "aarch64" ] && echo arm64 || echo x64)
  VER=$(curl -fsSL https://nodejs.org/dist/index.json | grep -o "\"version\":\"v${NODE_MAJOR}[^\"]*\"" | head -1 | cut -d'"' -f4)
  curl -fsSL "https://nodejs.org/dist/${VER}/node-${VER}-linux-${NODE_ARCH}.tar.xz" | tar -xJ -C /opt
  ln -sfn "/opt/node-${VER}-linux-${NODE_ARCH}" /opt/node
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  ln -sf /opt/node/bin/npx /usr/local/bin/npx
fi
node -v

echo "==> Swap (headroom for npm install on 1 GB servers)"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

echo "==> App user and files"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
# Keep the WhatsApp session (.baileys_auth) across redeploys.
rsync -a --delete --exclude node_modules --exclude .baileys_auth "$SRC_DIR/" "$APP_DIR/"
[ -f "$APP_DIR/.env" ] || { echo "Missing .env — upload it with the project."; exit 1; }
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"

echo "==> npm install"
cd "$APP_DIR"
sudo -u "$APP_USER" -H npm ci --omit=dev

echo "==> systemd service"
cp "$APP_DIR/deploy/courseworks-bot.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable courseworks-bot
systemctl restart courseworks-bot

cat <<MSG

Done. The bot is running as a service and restarts on crash or reboot.
First time only — show the WhatsApp QR code and scan it:
    sudo journalctl -u courseworks-bot -f -o cat
(Ctrl+C to stop watching; the bot keeps running.)
MSG
