#!/usr/bin/env bash
# Run on your Mac to copy the project (including .env) to the server and run setup.
# Usage: bash deploy/upload.sh root@YOUR_SERVER_IP
set -euo pipefail
TARGET=${1:?Usage: bash deploy/upload.sh user@server-ip}
cd "$(dirname "$0")/.."
# Minimal server images don't ship rsync.
ssh "$TARGET" "command -v rsync >/dev/null || (sudo apt-get -o DPkg::Lock::Timeout=600 update -y && sudo apt-get -o DPkg::Lock::Timeout=600 install -y rsync)"
rsync -az --exclude node_modules --exclude .baileys_auth --exclude .content_index ./ "$TARGET:~/courseworks-bot-src/"
ssh -t "$TARGET" "cd ~/courseworks-bot-src && sudo bash deploy/setup.sh"
