#!/usr/bin/env bash
set -euo pipefail
STAGING_ROOT="$1"
STAGING_RELEASE="$2"
STAGING_IP="$3"
STAGING_PORT="$4"
cd "$STAGING_ROOT/releases/$STAGING_RELEASE"
npm ci --omit=dev
# Nginx cannot traverse ubuntu's private home directory. Publish only these
# non-secret static assets outside it; application/config files stay private.
sudo -n install -d -m 755 /var/lib/terminal-monitor-staging/public/vendor
sudo -n install -m 644 public/vendor/* /var/lib/terminal-monitor-staging/public/vendor/
sudo -n install -m 644 public/staging.json /var/lib/terminal-monitor-staging/public/staging.json
ln -sfn "$STAGING_ROOT/releases/$STAGING_RELEASE" "$STAGING_ROOT/current.next"
mv -Tf "$STAGING_ROOT/current.next" "$STAGING_ROOT/current"
cat > "$STAGING_ROOT/runtime/server.service" <<UNIT
[Unit]
Description=Terminal Monitor staging broker
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$STAGING_ROOT/current
ExecStart=/usr/bin/node $STAGING_ROOT/current/server.js --config=$STAGING_ROOT/runtime/server.json
Restart=always
RestartSec=3
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
cat > "$STAGING_ROOT/runtime/nginx.conf" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $STAGING_IP;
    client_max_body_size 210m;
    location /.well-known/acme-challenge/ {
        proxy_pass http://127.0.0.1:8888;
        proxy_set_header Host \$host;
    }
    location /vendor/ {
        alias /var/lib/terminal-monitor-staging/public/vendor/;
    }
    location = /staging.json {
        alias /var/lib/terminal-monitor-staging/public/staging.json;
        default_type application/json;
        add_header Cache-Control "no-store";
    }
    location / {
        proxy_pass http://127.0.0.1:$STAGING_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 3600;
        proxy_buffering off;
    }
}
NGINX
sudo -n install -m 644 "$STAGING_ROOT/runtime/server.service" /etc/systemd/system/terminal-monitor-staging.service
if [ -f /etc/nginx/sites-available/terminal-monitor-staging ]; then
  sudo -n cp /etc/nginx/sites-available/terminal-monitor-staging "$STAGING_ROOT/runtime/nginx.previous"
fi
sudo -n install -m 644 "$STAGING_ROOT/runtime/nginx.conf" /etc/nginx/sites-available/terminal-monitor-staging
sudo -n ln -sfn /etc/nginx/sites-available/terminal-monitor-staging /etc/nginx/sites-enabled/terminal-monitor-staging
if ! sudo -n nginx -t; then
  if [ -f "$STAGING_ROOT/runtime/nginx.previous" ]; then
    sudo -n cp "$STAGING_ROOT/runtime/nginx.previous" /etc/nginx/sites-available/terminal-monitor-staging
  else
    sudo -n rm -f /etc/nginx/sites-enabled/terminal-monitor-staging /etc/nginx/sites-available/terminal-monitor-staging
  fi
  exit 1
fi
sudo -n systemctl daemon-reload
sudo -n systemctl enable terminal-monitor-staging.service
sudo -n systemctl restart terminal-monitor-staging.service
sudo -n systemctl reload nginx
