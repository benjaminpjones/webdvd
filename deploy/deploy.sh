#!/usr/bin/env bash
# Build + ship webdvd to your VPS. Run from the repo root or anywhere:
#   deploy/deploy.sh user@host
# or set WEBDVD_HOST env var:
#   WEBDVD_HOST=user@host deploy/deploy.sh
#
# Flow:
#   1. Locally: build WASM (requires emcc on PATH)
#   2. Locally: copy WASM artifacts into player/public/wasm
#   3. Rsync source tree to VPS (excluding target/, node_modules/, etc.)
#   4. On VPS: cargo build --release && npm ci && npm run build
#   5. On VPS: install binary + static files, restart webdvd service

set -euo pipefail

HOST="${1:-${WEBDVD_HOST:-}}"
if [[ -z "$HOST" ]]; then
    echo "Usage: $0 user@host    (or set WEBDVD_HOST)" >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== [1/5] Building WASM locally (requires emcc) ==="
if ! command -v emcc >/dev/null 2>&1; then
    echo "Error: emcc not on PATH. Activate Emscripten before deploying:" >&2
    echo "  source ~/emsdk/emsdk_env.sh" >&2
    exit 1
fi
./wasm/build.sh

echo "=== [2/5] Staging WASM into player/public/wasm ==="
mkdir -p player/public/wasm
cp wasm/build/dvdnav.js wasm/build/dvdnav.wasm player/public/wasm/

echo "=== [3/5] Rsyncing source tree to $HOST ==="
rsync -az --delete \
    --exclude='target/' \
    --exclude='node_modules/' \
    --exclude='dist/' \
    --exclude='.git/' \
    --exclude='wasm/build/obj/' \
    --exclude='.DS_Store' \
    --exclude='*.swp' \
    --exclude='.cache/' \
    ./ "$HOST":/opt/webdvd/src/
# Make sure files are owned by webdvd so the remote build can write to target/
ssh "$HOST" "chown -R webdvd:webdvd /opt/webdvd/src"

echo "=== [4/5] Building on VPS (cargo + npm) ==="
ssh "$HOST" bash -se <<'REMOTE'
set -euo pipefail
cd /opt/webdvd/src

# Build the server (as webdvd user so target/ stays owned correctly)
sudo -u webdvd bash -c '
    set -euo pipefail
    export PATH=/opt/webdvd/.cargo/bin:$PATH
    cd /opt/webdvd/src/server
    cargo build --release --locked
'

# Build the player
sudo -u webdvd bash -c '
    set -euo pipefail
    cd /opt/webdvd/src/player
    npm ci --no-audit --no-fund
    npm run build
'
REMOTE

echo "=== [5/5] Installing binary + static files, restarting service ==="
ssh "$HOST" bash -se <<'REMOTE'
set -euo pipefail
install -o webdvd -g webdvd -m 0755 \
    /opt/webdvd/src/server/target/release/webdvd-server \
    /opt/webdvd/webdvd-server
rm -rf /opt/webdvd/static.new
cp -r /opt/webdvd/src/player/dist /opt/webdvd/static.new
chown -R webdvd:webdvd /opt/webdvd/static.new
rm -rf /opt/webdvd/static
mv /opt/webdvd/static.new /opt/webdvd/static
systemctl restart webdvd
sleep 1
systemctl status --no-pager webdvd | head -12
REMOTE

echo
echo "=== Deploy complete ==="
echo "Visit https://<your-domain>/ to verify."
