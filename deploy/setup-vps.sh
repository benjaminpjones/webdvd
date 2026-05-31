#!/usr/bin/env bash
# One-time VPS provisioning. Run on a fresh Ubuntu 24.04 box AS ROOT:
#   curl -fsSL <raw url> | sudo bash
# or scp this file over and:
#   sudo bash setup-vps.sh
#
# After this finishes:
#   1. Put your DVDs in /data/discs/<DiscName>/VIDEO_TS/
#   2. Edit /etc/webdvd.env (set PLAYER_PASSWORD)
#   3. Edit /etc/caddy/Caddyfile (set your domain)
#   4. Run `deploy.sh` from your laptop to push code

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Must run as root (use sudo)" >&2
    exit 1
fi

echo "=== Updating apt ==="
apt-get update

echo "=== Installing system dependencies ==="
apt-get install -y --no-install-recommends \
    build-essential pkg-config curl ca-certificates git rsync \
    ffmpeg \
    libdvdread-dev libdvdnav-dev libdvdcss-dev \
    debian-keyring debian-archive-keyring apt-transport-https \
    gnupg

echo "=== Installing Caddy ==="
if ! command -v caddy >/dev/null 2>&1; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
    apt-get install -y caddy
fi

echo "=== Installing Node.js 20 LTS ==="
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

echo "=== Creating webdvd user and directories ==="
if ! id webdvd >/dev/null 2>&1; then
    useradd --system --shell /usr/sbin/nologin --home-dir /opt/webdvd webdvd
fi
mkdir -p /opt/webdvd/src /opt/webdvd/static /data/discs /var/cache/webdvd /var/log/caddy
chown -R webdvd:webdvd /opt/webdvd /data/discs /var/cache/webdvd

echo "=== Installing Rust (system-wide via rustup, runs as webdvd) ==="
if ! sudo -u webdvd test -x /opt/webdvd/.cargo/bin/cargo; then
    sudo -u webdvd bash -c 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal'
fi

echo "=== Installing systemd unit and env file ==="
if [[ ! -f /etc/webdvd.env ]]; then
    cp "$(dirname "$0")/webdvd.env.example" /etc/webdvd.env
    chmod 0640 /etc/webdvd.env
    chown root:webdvd /etc/webdvd.env
    echo "  Created /etc/webdvd.env from template — EDIT IT before starting the service"
fi
cp "$(dirname "$0")/webdvd.service" /etc/systemd/system/webdvd.service
systemctl daemon-reload
systemctl enable webdvd

echo "=== Installing Caddyfile ==="
if [[ ! -f /etc/caddy/Caddyfile.orig ]]; then
    cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig
fi
cp "$(dirname "$0")/Caddyfile" /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy

echo
echo "=== Setup complete ==="
echo
echo "Next steps:"
echo "  1. Edit /etc/webdvd.env and set PLAYER_PASSWORD"
echo "  2. Edit /etc/caddy/Caddyfile and replace dvd.paikjones.com with your domain"
echo "     then: systemctl reload caddy"
echo "  3. Point DNS for your domain at this server's public IP"
echo "  4. From your laptop, run deploy/deploy.sh to push the webdvd code"
echo "  5. Drop DVDs into /data/discs/<DiscName>/VIDEO_TS/"
echo "     Add /data/discs/<DiscName>/meta.json with {\"visibility\":\"public\"}"
echo "     for anything you want viewable without login."
