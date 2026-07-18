# Deploying webdvd

End-to-end deploy to a Hetzner-style Ubuntu 24.04 VPS sitting behind Caddy
with auto-HTTPS. Builds happen on the VPS itself (avoids libdvdread
cross-compile headaches) — your laptop just rsyncs source and triggers
the remote build.

## Architecture

```
       Internet
          │
          ▼
   ┌─────────────┐       :443 (HTTPS, Let's Encrypt cert)
   │    Caddy    │
   └─────┬───────┘
         │ /api/*  →  reverse_proxy localhost:3000
         │ /*      →  static files from /opt/webdvd/static
         ▼
   ┌─────────────────────┐
   │  webdvd-server      │  systemd service, runs as `webdvd` user
   │  (Rust, port 3000)  │  reads /data/discs, writes /var/cache/webdvd
   └─────────────────────┘
```

## One-time setup (on the VPS)

1. SSH in as root:
   ```bash
   ssh root@<vps-ip>
   ```

2. Copy the `deploy/` directory from your laptop:
   ```bash
   # from your laptop:
   scp -r deploy root@<vps-ip>:/root/webdvd-deploy
   ```

3. On the VPS, run the setup script:
   ```bash
   cd /root/webdvd-deploy
   bash setup-vps.sh
   ```
   This installs ffmpeg, libdvdread, Caddy, Node.js 20, Rust (as the `webdvd`
   user), creates the `webdvd` user + service directories, and registers the
   systemd unit. Takes a few minutes.

4. Edit `/etc/webdvd.env` and set `PLAYER_PASSWORD`:
   ```bash
   vi /etc/webdvd.env
   ```

5. Edit `/etc/caddy/Caddyfile` and replace `dvd.paikjones.com` with your
   actual domain. Then:
   ```bash
   systemctl reload caddy
   ```

6. Point DNS at the VPS:
   - Add an `A` record for `dvd` (or whatever subdomain) → your VPS IPv4.
   - Wait for propagation (`dig dvd.example.com +short` should return the IP).

## First deploy (from your laptop)

```bash
deploy/deploy.sh root@<vps-ip>
```

The script:
1. Builds WASM locally (requires `emcc` on `$PATH`)
2. Copies WASM artifacts into `player/public/wasm/`
3. Rsyncs the source tree to `/opt/webdvd/src/` on the VPS
4. SSHes in, runs `cargo build --release` + `npm ci && npm run build`
5. Installs the new binary + static files, restarts the `webdvd` service

On a 2-vCPU box the first build takes ~5 minutes (Rust deps). Subsequent
builds are incremental (~20s).

## Uploading DVDs

```bash
# From your laptop, per disc:
rsync -av /path/to/discs/SHREK/ root@<vps-ip>:/data/discs/SHREK/
```

After upload, `chown -R webdvd:webdvd /data/discs/<DiscName>` on the VPS
so the service can read them.

To make a disc accessible without login, add a `meta.json` next to its
`VIDEO_TS/`:

```bash
# On the VPS:
echo '{"visibility":"public"}' > /data/discs/PUBLIC_DOMAIN_FILM/meta.json
chown webdvd:webdvd /data/discs/PUBLIC_DOMAIN_FILM/meta.json
```

The server scans the library at startup, so restart after adding/changing
discs:

```bash
systemctl restart webdvd
```

## Operational notes

- **Logs**: `journalctl -u webdvd -f` for the server, `tail -f /var/log/caddy/webdvd.log` for HTTP requests.
- **Status**: `systemctl status webdvd caddy` for both services.
- **Update a single setting**: edit `/etc/webdvd.env`, then `systemctl restart webdvd`.
- **Cache**: lives at `/var/cache/webdvd/v1/<disc>/*.mp4`. Safe to delete any time — files will regenerate on next request. Bump the `v1` schema (or `rm -rf` the whole dir) after codec changes.
- **Resource caps**: `MAX_CONCURRENT_TRANSCODES` in `/etc/webdvd.env` is the main knob for protecting CPU during traffic spikes. Cache hits bypass this cap entirely.
