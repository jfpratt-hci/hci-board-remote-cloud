#!/bin/bash
# HCI ONE Remote relay: install on an Ubuntu server (22.04 or 24.04) as root.
#   bash install.sh remote.hci-tv.com
# Puts Node and Caddy on the server, runs the relay as a service on 127.0.0.1:8780, and has Caddy serve it
# on https://<address> with a free certificate it renews by itself. Only ports 80 and 443 need to be open.
set -euo pipefail
DOMAIN="${1:-remote.hci-tv.com}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/hci-remote
export DEBIAN_FRONTEND=noninteractive
say() { echo "== $*"; }

say "Node"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  VER=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r["lts"] and r["version"].startswith("v22")))')
  curl -fsSL "https://nodejs.org/dist/$VER/node-$VER-linux-x64.tar.xz" | tar -xJ -C /opt
  ln -sf "/opt/node-$VER-linux-x64/bin/node" /usr/local/bin/node
fi
node -v

say "Caddy (from its official repository)"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update -q
  apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

say "Relay files"
id hciremote >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin hciremote
mkdir -p "$APP"
cp "$SRC/relay.js" "$SRC/viewer.html" "$SRC/ws.js" "$APP/"
chown -R hciremote:hciremote "$APP"
chmod 750 "$APP"

say "Relay service"
cat > /etc/systemd/system/hci-remote.service <<UNIT
[Unit]
Description=HCI ONE Remote relay
After=network-online.target
Wants=network-online.target

[Service]
User=hciremote
WorkingDirectory=$APP
Environment=RELAY_HOST=127.0.0.1
Environment=RELAY_PORT=8780
ExecStart=/usr/local/bin/node relay.js
Restart=always
RestartSec=3
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$APP

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now hci-remote
systemctl restart hci-remote

say "HTTPS for $DOMAIN"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:8780
}
CADDY
systemctl enable caddy
systemctl restart caddy

sleep 3
say "Done"
curl -fsS http://127.0.0.1:8780/api/ping && echo
echo "First sign in is in $APP/FIRST_SIGN_IN.txt"
echo "Caddy gets the certificate as soon as $DOMAIN points at this server."
