#!/usr/bin/env bash
# Adds Prometheus to an existing HCI backend on a Linux Docker host, so Board Remote can run HCI's service
# alerts (service down, error rate, slow, Java memory, database pool, Kong) against it. Run after
# add-cadvisor.sh. Same steps as add-prometheus.ps1:
#   sudo ./add-prometheus.sh [--dir /opt/hci-mediacare] [--port 9090] [--bind 0.0.0.0] [--version v2.55.1] [--force] [--rescan]
# --rescan only looks for services again and rewrites prometheus.yml (after services are added or removed).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; OVERRIDE="$HERE/docker-compose.prometheus.yml"
DIR=""; PORT=9090; BIND=0.0.0.0; VERSION=v2.55.1; FORCE=0; RESCAN=0
while [ $# -gt 0 ]; do case "$1" in
  --dir) DIR="$2"; shift 2;; --port) PORT="$2"; shift 2;; --bind) BIND="$2"; shift 2;; --version) VERSION="$2"; shift 2;;
  --force) FORCE=1; shift;; --rescan) RESCAN=1; shift;; *) echo "Unknown option $1"; exit 1;; esac; done
say() { echo "  $*"; }; fail() { echo "  $*" >&2; exit 1; }
NAME=hci-prometheus
# ports that never serve HTTP metrics: databases, brokers, MQTT
SKIP=" 3306 5432 6379 27017 61616 5672 1883 11211 9300 "

echo; echo "HCI ONE: add Prometheus to this Docker host"; echo
command -v docker >/dev/null || fail "Docker is not installed."
docker info >/dev/null 2>&1 || fail "Docker is not running, or this user cannot use it (try sudo)."
[ -f "$OVERRIDE" ] || fail "docker-compose.prometheus.yml is missing. Keep it next to this script."
show() {
  echo; echo "  In Board Remote on a PC at this hospital: Remote, Backend containers, add the host again with Prometheus address"
  n=0; for ip in $(hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null); do case "$ip" in 127.*|169.254.*|172.1[6-9].*|172.2?.*|172.3[01].*|*:*) ;; *) echo "    http://$ip:$1"; n=1;; esac; done
  [ "$n" = 1 ] || echo "    http://<this server's address>:$1"
  echo "  Prometheus has no sign in. Allow port $1 only from the Board Remote PCs."; echo
}

# 1. already here?
existing="$(docker ps -a --format '{{.Names}}|{{.Image}}|{{.Label "com.hci.one.role"}}|{{.Ports}}' | awk -F'|' '$2 ~ /prometheus/')"
if [ -n "$existing" ] && [ "$FORCE" = 0 ] && [ "$RESCAN" = 0 ]; then
  echo "$existing" | while IFS='|' read -r n i r p; do say "Prometheus is already here: $n ($i). $p"; done
  echo "$existing" | grep -q "^$NAME|.*|prometheus|" && say "It is from this kit; run with --rescan to look for services again."
  p="$(echo "$existing" | grep -oE ':[0-9]+->9090' | head -1 | sed -E 's/:([0-9]+)->.*/\1/')"; show "${p:-$PORT}"; exit 0
fi
[ "$RESCAN" = 1 ] && ! docker inspect "$NAME" >/dev/null 2>&1 && fail "There is no $NAME to rescan. Run without --rescan first."

# 2. the deployment's compose project (the one with the most running containers, or --dir)
PROJECT=""; FILES=""
if [ -n "$DIR" ]; then
  for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do [ -f "$DIR/$f" ] && { FILES="$DIR/$f"; break; }; done
  [ -n "$FILES" ] || fail "No docker-compose.yml in $DIR."
  PROJECT="$(docker ps --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}' | awk -F'|' -v d="$DIR" '$2 == d {print $1; exit}')"
  PROJECT="${PROJECT:-$(basename "$DIR" | tr 'A-Z' 'a-z')}"
else
  top="$(docker ps --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.project.config_files"}}' | grep -v '^|' | sort | uniq -c | sort -rn | head -1 | sed 's/^ *[0-9]* //')"
  [ -n "$top" ] || fail "No docker compose project runs here. Run with --dir <the folder with docker-compose.yml>."
  IFS='|' read -r PROJECT DIR cfg <<< "$top"
  for f in ${cfg//,/ }; do [ -f "$f" ] && FILES="$FILES $f"; done
fi
[ -n "${FILES// /}" ] || fail "Cannot read the compose files of $PROJECT. Run with --dir."
say "Deployment: $PROJECT in $DIR"
CONF="$DIR/hci-monitoring/prometheus.yml"
mkdir -p "$DIR/hci-monitoring"

export PROMETHEUS_PORT="$PORT" PROMETHEUS_BIND="$BIND" PROMETHEUS_VERSION="$VERSION"
if [ "$RESCAN" = 0 ]; then
  [ "$FORCE" = 1 ] && docker rm -f "$NAME" >/dev/null 2>&1 || true
  # the host port must be free (Prometheus's own 9090 inside its container never clashes)
  in_use() { docker ps --format '{{.Ports}}' | grep -q ":$1->" && return 0; if command -v ss >/dev/null; then ss -ltn "sport = :$1" | grep -q LISTEN; else lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; fi; }
  if in_use "$PORT"; then
    free=""; for p in $(seq 9090 9190); do in_use "$p" || { free="$p"; break; }; done
    fail "Port $PORT is already in use here. Run again with --port ${free:-<a free port>}."
  fi
  # start with only itself to scrape; the services are added below, once they are known to answer
  [ -f "$CONF" ] || printf 'global:\n  scrape_interval: 15s\nscrape_configs:\n  - job_name: prometheus\n    static_configs:\n      - targets: [localhost:9090]\n' > "$CONF"
  dest="$DIR/docker-compose.prometheus.yml"
  if [ -f "$dest" ] && ! cmp -s "$dest" "$OVERRIDE"; then bak="$dest.$(date +%Y%m%d-%H%M%S).bak"; cp "$dest" "$bak"; say "Kept the old override as $bak"; fi
  cp "$OVERRIDE" "$dest"
  args=(compose -p "$PROJECT" --project-directory "$DIR"); for f in $FILES; do args+=(-f "$f"); done
  # the other kit's override too, so compose knows its container is part of the deployment
  [ -f "$DIR/docker-compose.cadvisor.yml" ] && args+=(-f "$DIR/docker-compose.cadvisor.yml")
  args+=(-f "$dest" up -d --no-deps prometheus)
  say "docker ${args[*]}"
  docker "${args[@]}" || fail "docker compose could not start Prometheus (see above)."
fi

# 3. reach every network the deployment uses, so services answer by their compose names
nets="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" | xargs -r docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | grep -vxE 'host|none' | grep -v '^$' | sort -u || true)"
have="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$NAME")"
for n in $nets; do case " $have " in *" $n "*) ;; *) docker network connect "$n" "$NAME" && say "Joined network $n";; esac; done

# 4. which services answer with metrics, asked from inside Prometheus's own container
say "Looking for services that publish metrics…"
found=""; none=""
for id in $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT"); do
  svc="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id")"
  [ -n "$svc" ] && [ "$svc" != prometheus ] || continue
  # exposed and published container ports; compose writes "8110" or "8110/tcp"
  ports="$(docker inspect -f '{{range $p, $_ := .Config.ExposedPorts}}{{$p}} {{end}}{{range $p, $_ := .HostConfig.PortBindings}}{{$p}} {{end}}' "$id" | tr ' ' '\n' | sed 's#/tcp$##' | grep -E '^[0-9]+$' | sort -un || true)"
  hit=""
  for port in $ports; do
    case "$SKIP" in *" $port "*) continue;; esac
    for path in /actuator/prometheus /metrics; do
      # read the start only; a big page cut short makes wget fail, which must not hide what was read
      out="$(docker exec "$NAME" wget -q -T 3 -O - "http://$svc:$port$path" 2>/dev/null | head -c 4000 || true)"
      if printf '%s\n' "$out" | grep -qE '^# (HELP|TYPE) '; then hit="$svc:$port$path"; break 2; fi
    done
  done
  if [ -n "$hit" ]; then found="$found $hit"; say "  metrics: $hit"; else none="$none $svc"; fi
done
[ -n "$found" ] || say "No service answered with metrics. Prometheus only watches itself until they do (Spring: management.endpoints.web.exposure.include=prometheus)."

# 5. write prometheus.yml from what answered, keep the old one, restart to load it
[ -f "$CONF" ] && cp "$CONF" "$CONF.$(date +%Y%m%d-%H%M%S).bak"
{
  echo "# Written by HCI ONE add-prometheus on $(date '+%Y-%m-%d %H:%M'). Run add-prometheus --rescan after services change."
  echo "# Jobs are the compose service names; HCI's alert rules group by them."
  echo "global:"; echo "  scrape_interval: 15s"; echo "  scrape_timeout: 10s"; echo "scrape_configs:"
  echo "  - job_name: prometheus"; echo "    static_configs:"; echo "      - targets: [localhost:9090]"
  for h in $found; do
    t="${h%%/*}"; path="/${h#*/}"
    echo "  - job_name: ${t%%:*}"; echo "    metrics_path: $path"; echo "    static_configs:"; echo "      - targets: [$t]"
  done
} > "$CONF"
docker restart "$NAME" >/dev/null
for _ in $(seq 1 30); do curl -fsS -m 3 "http://localhost:$PORT/-/ready" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS -m 3 "http://localhost:$PORT/-/ready" >/dev/null 2>&1 || fail "Prometheus does not answer on port $PORT. See: docker logs $NAME"
sleep 20
up="$(curl -fsS -m 5 "http://localhost:$PORT/api/v1/targets?state=active" | grep -o '"health":"up"' | wc -l | tr -d ' ')"
say "Prometheus $VERSION answers on port $PORT and scrapes $(echo $found | wc -w | tr -d ' ') service(s) plus itself; $up target(s) up."
[ -n "$none" ] && say "No metrics from:$none (fine for databases and services without Spring Boot actuator)."
show "$PORT"
