#!/usr/bin/env bash
# One-command server setup, run on the LAPTOP (it asks for your subdomain):
#     bash tools/deploy-server.sh you@192.168.1.20 [port]
#     bash tools/deploy-server.sh hetzner            (a Host alias from ~/.ssh/config works too)
# Public server? Set the address devices should use, e.g. a Tailscale IP or an HTTPS domain:
#     QB_PUBLIC_URL=http://100.101.102.103:8787 bash tools/deploy-server.sh hetzner
# Copies server/ to ~/questboard-server on the server, creates a token, starts Docker,
# checks it answers, configures the GNOME extension, and writes phone-setup-link.txt.
set -euo pipefail
TARGET=${1:?"usage: bash tools/deploy-server.sh user@server-ip [port]"}
PORT=${2:-8787}
# real hostname, also for ~/.ssh/config aliases like "hetzner"
HOST=$(ssh -G "$TARGET" 2>/dev/null | awk '/^hostname /{print $2; exit}')
HOST=${HOST:-${TARGET#*@}}
cd "$(dirname "$0")/.."
REPO=$PWD

# Interactive: ask for a domain and detect how Caddy runs, unless set via env.
if [ -z "${QB_PUBLIC_URL:-}" ] && [ -t 0 ]; then
  read -r -p "Subdomain for Questboard behind your Caddy (e.g. questboard.example.com), Enter = none: " D
  if [ -n "$D" ]; then
    D=${D#https://}; D=${D%/}
    QB_PUBLIC_URL="https://$D"
    CADDY_CT=$(ssh "$TARGET" "docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | awk 'tolower(\$0) ~ /caddy/ {print \$1; exit}'" || true)
    if [ -n "$CADDY_CT" ] && [ -z "${QB_DOCKER_NETWORK:-}" ]; then
      QB_DOCKER_NETWORK=$(ssh "$TARGET" "docker inspect $CADDY_CT --format '{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}} {{end}}'" | awk '{print $1}')
      echo "==> Caddy runs in Docker (container '$CADDY_CT', network '$QB_DOCKER_NETWORK')"
    else
      echo "==> Caddy runs directly on the server"
    fi
  fi
fi

# Behind a reverse proxy (https URL) → listen on localhost only; Caddy/nginx is the way in.
# Tailscale address (100.64.0.0/10) → listen only there. Otherwise: public plain HTTP (warn).
BIND=0.0.0.0
COMPOSE_FILES="-f docker-compose.yml"
if [ -n "${QB_DOCKER_NETWORK:-}" ]; then
  COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.network.yml"
  BIND=127.0.0.1
  echo "==> Joining Docker network '$QB_DOCKER_NETWORK' (Caddyfile: reverse_proxy questboard:8787)"
elif [[ "${QB_PUBLIC_URL:-}" == https://* ]]; then
  BIND=127.0.0.1
  echo "==> HTTPS proxy mode: the server listens on 127.0.0.1:$PORT only (Caddyfile: reverse_proxy 127.0.0.1:$PORT)"
elif [[ "${QB_PUBLIC_URL:-}" =~ ^https?://(100\.[0-9]+\.[0-9]+\.[0-9]+) ]]; then
  BIND=${BASH_REMATCH[1]}
  echo "==> Tailscale address detected: the server will listen only on $BIND (not public)"
elif [ -z "${QB_PUBLIC_URL:-}" ]; then
  echo "!! No QB_PUBLIC_URL: port $PORT will be reachable from the internet over plain HTTP."
  echo "   Fine for a quick test; for daily use set up Tailscale (see README, 'Server')."
fi

echo "==> 1/5 Copying server files to $TARGET:~/questboard-server"
ssh "$TARGET" 'mkdir -p ~/questboard-server/data'
scp -q server/qb_server.py server/notion_sync.py server/notion.json server/Dockerfile server/docker-compose.yml \
    server/docker-compose.network.yml "$TARGET":questboard-server/

echo "==> 2/5 Preparing .env (token is kept if one exists)"
NEWTOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')
ssh "$TARGET" "bash -s" <<REMOTE
set -e
cd ~/questboard-server
touch .env && chmod 600 .env
grep -q '^QB_TOKEN=' .env || echo "QB_TOKEN=$NEWTOKEN" >> .env
sed -i '/^QB_UID=/d;/^QB_GID=/d;/^QB_PORT_HOST=/d;/^QB_BIND=/d' .env
echo "QB_UID=\$(id -u)" >> .env; echo "QB_GID=\$(id -g)" >> .env; echo "QB_PORT_HOST=$PORT" >> .env
echo "QB_BIND=$BIND" >> .env
sed -i '/^QB_DOCKER_NETWORK=/d' .env
[ -n "${QB_DOCKER_NETWORK:-}" ] && echo "QB_DOCKER_NETWORK=${QB_DOCKER_NETWORK:-}" >> .env || true
REMOTE
TOKEN=$(ssh "$TARGET" "grep '^QB_TOKEN=' ~/questboard-server/.env | cut -d= -f2-")

echo "==> 3/5 Starting the container (docker compose up -d --build)"
if ! ssh "$TARGET" "cd ~/questboard-server && (docker compose version >/dev/null 2>&1 && docker compose $COMPOSE_FILES up -d --build || docker-compose $COMPOSE_FILES up -d --build)"; then
  echo
  echo "!! Docker needs sudo on the server. Run this once ON THE SERVER, then re-run this script:"
  echo "     cd ~/questboard-server && sudo docker compose $COMPOSE_FILES up -d --build"
  exit 1
fi

URL=${QB_PUBLIC_URL:-"http://$HOST:$PORT"}
URL=${URL%/}
echo "==> 4/5 Waiting for $URL"
for i in $(seq 40); do
  if curl -sf "$URL/api/health" >/dev/null; then OK=1; break; fi
  sleep 1
done
if [ -z "${OK:-}" ] && [ "$BIND" = "127.0.0.1" ]; then
  if ssh "$TARGET" "curl -sf http://127.0.0.1:$PORT/api/health >/dev/null || docker exec questboard wget -qO- http://127.0.0.1:8787/api/health >/dev/null"; then
    echo "!! Questboard runs on the server, but $URL doesn't reach it yet."
    echo "   Add this to your Caddyfile and reload Caddy, then re-run this script:"
    echo
    echo "   ${URL#https://} {"
    if [ -n "${QB_DOCKER_NETWORK:-}" ]; then echo "       reverse_proxy questboard:8787"; else echo "       reverse_proxy 127.0.0.1:$PORT"; fi
    echo "   }"
    exit 1
  fi
fi
if [ -z "${OK:-}" ]; then
  echo "!! The server doesn't answer from this laptop. On the server check:"
  echo "     docker logs questboard        (did it start?)"
  echo "     sudo ufw allow $PORT/tcp        (firewall)"
  exit 1
fi
echo "    server is up"

echo "==> 5/5 Configuring this desktop + phone link"
SCHEMAS="$HOME/.local/share/gnome-shell/extensions/questboard@marci.local/schemas"
if [ -d "$SCHEMAS" ]; then
  G="gsettings --schemadir $SCHEMAS"
  $G set org.gnome.shell.extensions.questboard server-url "$URL"
  $G set org.gnome.shell.extensions.questboard server-token "$TOKEN"
  $G set org.gnome.shell.extensions.questboard sync-enabled true
  echo "    desktop extension configured (it syncs within 2 minutes, or open the popup)"
else
  echo "    extension not installed yet — run: python3 tools/qb install"
fi
ENC_TOKEN=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$TOKEN")
ENC_URL=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$URL")
LINK="questboard://setup?url=$ENC_URL&token=$ENC_TOKEN"
printf '%s\n' "$LINK" > "$REPO/phone-setup-link.txt"
echo "    phone: send yourself the link in phone-setup-link.txt (e.g. via a messenger) and tap it"
echo "           after installing the app. Or type in the app: URL $URL  token $TOKEN"
echo
read -r -p "Let Claude read device logs & publish updates (writes .qb.env with URL+token into this folder)? [y/N] " A
if [[ "$A" =~ ^[Yy] ]]; then
  printf 'QB_URL=%s\nQB_TOKEN=%s\n' "$URL" "$TOKEN" > "$REPO/.qb.env"
  echo "    wrote .qb.env"
else
  echo "    skipped (you can still use tools/qb yourself with QB_URL/QB_TOKEN set)"
fi
echo
echo "Done. Live log console: $URL/   (paste the token there)"
