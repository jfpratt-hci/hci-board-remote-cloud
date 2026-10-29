#!/usr/bin/env bash
# Adds cAdvisor (github.com/google/cadvisor) to an existing HCI backend on a Linux Docker host, so Board
# Remote can show its containers in HCI ONE Cloud. Same steps as add-cadvisor.ps1:
#   sudo ./add-cadvisor.sh [--dir /opt/hci-mediacare] [--port 8098] --allow <Board Remote PC address>[,<address>] [--bind 0.0.0.0] [--version 0.60.6] [--force]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; OVERRIDE="$HERE/docker-compose.cadvisor.yml"
DIR=""; PORT=8098; BIND=0.0.0.0; ALLOW=""; OPEN=0; VERSION=0.60.6; FORCE=0
while [ $# -gt 0 ]; do case "$1" in
  --dir) DIR="$2"; shift 2;; --port) PORT="$2"; shift 2;; --bind) BIND="$2"; shift 2;; --allow) ALLOW="$2"; shift 2;; --open) OPEN=1; shift;; --version) VERSION="$2"; shift 2;; --force) FORCE=1; shift;;
  *) echo "Unknown option $1"; exit 1;; esac; done
say() { echo "  $*"; }; fail() { echo "  $*" >&2; exit 1; }
. "$HERE/lock-port.sh"; check_allow

echo; echo "HCI ONE: add cAdvisor to this Docker host"; echo
command -v docker >/dev/null || fail "Docker is not installed."
docker info >/dev/null 2>&1 || fail "Docker is not running, or this user cannot use it (try sudo)."
[ -f "$OVERRIDE" ] || fail "docker-compose.cadvisor.yml is missing. Keep it next to this script."

wait_up() { for _ in $(seq 1 30); do curl -fsS -m 3 "http://localhost:$1/healthz" 2>/dev/null | grep -q ok && return 0; sleep 2; done; return 1; }
show() {
  lock_port "$1"
  echo; echo "  In Board Remote on a PC at this hospital: Remote, Backend containers, add"
  n=0; for ip in $(hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null); do case "$ip" in 127.*|169.254.*|172.1[6-9].*|172.2?.*|172.3[01].*|*:*) ;; *) echo "    http://$ip:$1"; n=1;; esac; done
  [ "$n" = 1 ] || echo "    http://<this server's address>:$1"
  echo "  cAdvisor has no sign in. Allow port $1 only from the Board Remote PCs."; echo
}

# 1. already here?
existing="$(docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' | awk -F'|' '$2 ~ /cadvisor/')"
if [ -n "$existing" ] && [ "$FORCE" = 0 ]; then
  echo "$existing" | while IFS='|' read -r n i s p; do say "cAdvisor is already here: $n ($i), $s. $p"; done
  p="$(echo "$existing" | grep -oE ':[0-9]+->(8080|8098)' | head -1 | sed -E 's/:([0-9]+)->.*/\1/')"; p="${p:-$PORT}"
  wait_up "$p" && { say "It answers on port $p."; show "$p"; exit 0; }
  fail "It does not answer on port $p. Run again with --force to recreate it from this kit."
fi

# 2. the deployment's compose project
PROJECT=""; FILES=""
if [ -n "$DIR" ]; then
  for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do [ -f "$DIR/$f" ] && { FILES="$DIR/$f"; break; }; done
  [ -n "$FILES" ] || fail "No docker-compose.yml in $DIR."
  PROJECT="$(docker ps --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}' | awk -F'|' -v d="$DIR" '$2 == d {print $1; exit}')"
  PROJECT="${PROJECT:-$(basename "$DIR" | tr 'A-Z' 'a-z')}"
else
  top="$(docker ps --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.project.config_files"}}' | grep -v '^|' | sort | uniq -c | sort -rn | head -1 | sed 's/^ *[0-9]* //')"
  if [ -n "$top" ]; then
    IFS='|' read -r PROJECT DIR cfg <<< "$top"
    for f in ${cfg//,/ }; do [ -f "$f" ] && FILES="$FILES $f"; done
  fi
fi

export CADVISOR_PORT="$PORT" CADVISOR_BIND="$BIND" CADVISOR_VERSION="$VERSION"
[ "$FORCE" = 1 ] && docker rm -f hci-cadvisor >/dev/null 2>&1 || true

# the host port must be free (the port inside cAdvisor's own container never clashes with the host)
in_use() { docker ps --format '{{.Ports}}' | grep -q ":$1->" && return 0; if command -v ss >/dev/null; then ss -ltn "sport = :$1" | grep -q LISTEN; else lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; fi; }
if in_use "$PORT"; then
  free=""; for p in $(seq 8098 8199); do in_use "$p" || { free="$p"; break; }; done
  fail "Port $PORT is already in use here. Run again with --port ${free:-<a free port>}."
fi

if [ -n "$PROJECT" ] && [ -n "${FILES// /}" ]; then
  say "Deployment: $PROJECT in $DIR"
  dest="$DIR/docker-compose.cadvisor.yml"
  if [ -f "$dest" ] && ! cmp -s "$dest" "$OVERRIDE"; then bak="$dest.$(date +%Y%m%d-%H%M%S).bak"; cp "$dest" "$bak"; say "Kept the old override as $bak"; fi
  cp "$OVERRIDE" "$dest"
  args=(compose -p "$PROJECT" --project-directory "$DIR"); for f in $FILES; do args+=(-f "$f"); done
  # the other kit's override too, so compose knows its container is part of the deployment
  [ -f "$DIR/docker-compose.prometheus.yml" ] && args+=(-f "$DIR/docker-compose.prometheus.yml")
  args+=(-f "$dest" up -d --no-deps cadvisor)
  say "docker ${args[*]}"
  docker "${args[@]}" || fail "docker compose could not start cAdvisor (see above)."
  say "From now on, start the deployment with -f docker-compose.cadvisor.yml as well, or cAdvisor keeps running on its own (restart: unless-stopped)."
else
  say "No compose project found; starting cAdvisor with docker run."
  docker run -d --name hci-cadvisor --restart unless-stopped --privileged --device /dev/kmsg:/dev/kmsg -p "$BIND:$PORT:8098" \
    -v /:/rootfs:ro -v /var/run/docker.sock:/var/run/docker.sock:ro -v /sys:/sys:ro -v /var/lib/docker/:/var/lib/docker:ro -v /dev/disk/:/dev/disk:ro \
    --label com.hci.one.role=cadvisor "ghcr.io/google/cadvisor:$VERSION" \
    --port=8098 --docker_only=true --housekeeping_interval=10s --store_container_labels=false \
    --disable_metrics=advtcp,cpu_topology,cpuset,hugetlb,memory_numa,percpu,perf_event,process,referenced_memory,resctrl,sched,tcp,udp \
    || fail "docker run could not start cAdvisor (see above)."
fi

wait_up "$PORT" || fail "cAdvisor started but does not answer on port $PORT. See: docker logs hci-cadvisor"
say "cAdvisor $VERSION answers on port $PORT."
show "$PORT"
