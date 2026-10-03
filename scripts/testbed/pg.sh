#!/usr/bin/env bash
# pg.sh — the Postgres the engine v2 data plane needs in the testbed (`n8n-testbed.sh --v2`).
#
# Engine v2 keeps its executions and step rows in its own database, which must be Postgres
# (`N8N_ENGINE_DATABASE_URL`, read by `EngineV2Runtime.initDb`). n8n's main database stays the
# testbed's sqlite file: nothing in the engine-v2 module asks for a Postgres main database.
#
#   scripts/testbed/pg.sh start     # start (or reuse) the container, wait until it accepts queries
#   scripts/testbed/pg.sh url       # print the connection URL
#   scripts/testbed/pg.sh status    # running / stopped, and the image id and server version
#   scripts/testbed/pg.sh stop      # stop and remove the container and its anonymous volume
#   scripts/testbed/pg.sh stamp     # the provenance lines n8n-testbed.sh writes to .testbed/pg-stamp.txt
#
# Flags: --port=N (default 55432)  --image=REF (default postgres:18.4-alpine)
#
# Provider: Docker (the user's choice; `tasks/v2-seam-plan.md` blocker 1). The image defaults to
# `postgresVersions.primary` in n8n's `n8n-containers/postgres-versions.json`, the one the engine's
# own integration tests start, so the testbed and the `engine-int` legs run one server version.
# `LIBPETRI_PG_URL`, when set, is used as is and no container is managed: `start` only checks it
# answers, and `stop` does nothing.
#
# The container is named `n8n-libpetri-testbed-pg` and listens on 127.0.0.1 only. Its data is in
# an anonymous volume that `stop` removes, so every `start` after a `stop` is an empty database.
set -euo pipefail

NAME=n8n-libpetri-testbed-pg
PORT=55432
IMAGE=postgres:18.4-alpine
USER_=engine; PASS=engine; DB=engine

CMD="${1:-}"; [ $# -gt 0 ] && shift
for arg in "$@"; do
  case "$arg" in
    --port=*)  PORT="${arg#--port=}" ;;
    --image=*) IMAGE="${arg#--image=}" ;;
    *) echo "pg.sh: unknown flag: $arg" >&2; exit 2 ;;
  esac
done
case "$PORT" in ''|*[!0-9]*|0) echo "pg.sh: --port must be a positive integer" >&2; exit 2 ;; esac

log() { printf '[pg %s] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
die() { log "error: $*"; exit 1; }

url() {
  if [ -n "${LIBPETRI_PG_URL:-}" ]; then printf '%s\n' "$LIBPETRI_PG_URL"; return; fi
  printf 'postgres://%s:%s@127.0.0.1:%s/%s\n' "$USER_" "$PASS" "$PORT" "$DB"
}

# A Docker that does not answer would otherwise surface as n8n failing to connect, behind a
# REST API that never comes up. Same preflight as scripts/pg-stamp.sh's `pg_preflight`.
preflight() {
  docker info >/dev/null 2>&1 || die "docker does not answer; start Docker Desktop, or set LIBPETRI_PG_URL"
}

running() { [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || true)" = true ]; }

# The port the existing container publishes, so a reused container is never reported on a port
# it does not listen on.
published_port() { docker port "$NAME" 5432/tcp 2>/dev/null | sed -n 's/.*:\([0-9]*\)$/\1/p' | head -1; }

wait_ready() { # wait_ready <seconds>
  local deadline=$(( $(date +%s) + $1 ))
  # `pg_isready` alone answers during the image's init-time restart; a query through the TCP
  # socket the engine will use is the real gate.
  until docker exec "$NAME" psql -h 127.0.0.1 -U "$USER_" -d "$DB" -tAc 'select 1' >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || die "Postgres did not accept queries within $1 s; see: docker logs $NAME"
    running || die "the container exited; see: docker logs $NAME"
    sleep 0.5
  done
}

case "$CMD" in
  start)
    if [ -n "${LIBPETRI_PG_URL:-}" ]; then
      log "LIBPETRI_PG_URL is set; using it and managing no container"
      exit 0
    fi
    preflight
    if running; then
      have="$(published_port)"
      [ "$have" = "$PORT" ] || die "$NAME is already running on port ${have:-?}, not $PORT; run 'pg.sh stop' first"
      log "reusing $NAME on 127.0.0.1:$PORT"
    else
      docker rm -fv "$NAME" >/dev/null 2>&1 || true
      if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        die "port $PORT is already in use; pass --pg-port to n8n-testbed.sh"
      fi
      docker image inspect "$IMAGE" >/dev/null 2>&1 || { log "pulling $IMAGE"; docker pull "$IMAGE" >/dev/null; }
      log "starting $NAME ($IMAGE) on 127.0.0.1:$PORT"
      # The Docker VM this was built on has ~0.95 GB, so the server keeps Postgres's small defaults
      # and the container is capped; the engine's integration tests run on the same image uncapped.
      docker run -d --name "$NAME" \
        --label n8n-libpetri=testbed \
        --memory=384m \
        -e POSTGRES_USER="$USER_" -e POSTGRES_PASSWORD="$PASS" -e POSTGRES_DB="$DB" \
        -p "127.0.0.1:$PORT:5432" \
        "$IMAGE" >/dev/null
    fi
    wait_ready 60
    log "ready: $(url)"
    ;;
  stop)
    if [ -n "${LIBPETRI_PG_URL:-}" ]; then log "LIBPETRI_PG_URL is set; no container to stop"; exit 0; fi
    if docker inspect "$NAME" >/dev/null 2>&1; then
      docker rm -fv "$NAME" >/dev/null
      log "removed $NAME"
    else
      log "$NAME was not there"
    fi
    ;;
  url)
    url
    ;;
  status)
    if [ -n "${LIBPETRI_PG_URL:-}" ]; then echo "external: LIBPETRI_PG_URL"; exit 0; fi
    if running; then
      echo "running: $NAME on 127.0.0.1:$(published_port), image $(docker inspect -f '{{.Config.Image}} {{.Image}}' "$NAME")"
    else
      echo "stopped"
      exit 1
    fi
    ;;
  stamp)
    # What a later comparison has to match before it calls a difference an effect (step 9's
    # lesson: compat's floating tag moved its server version).
    if [ -n "${LIBPETRI_PG_URL:-}" ]; then
      echo "provider: LIBPETRI_PG_URL (external; no image recorded)"
      exit 0
    fi
    running || die "$NAME is not running"
    echo "provider: docker $(docker version -f '{{.Server.Version}}' 2>/dev/null), VM memory $(docker info -f '{{.MemTotal}}' 2>/dev/null) bytes"
    echo "container: $NAME"
    echo "image: $(docker inspect -f '{{.Config.Image}}' "$NAME")"
    echo "image id: $(docker inspect -f '{{.Image}}' "$NAME")"
    echo "repo digest: $(docker image inspect -f '{{join .RepoDigests ","}}' "$(docker inspect -f '{{.Image}}' "$NAME")")"
    echo "server: $(docker exec "$NAME" psql -h 127.0.0.1 -U "$USER_" -d "$DB" -tAc 'show server_version')"
    echo "memory limit: $(docker inspect -f '{{.HostConfig.Memory}}' "$NAME") bytes"
    ;;
  *)
    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
    [ -z "$CMD" ] || [ "$CMD" = -h ] || [ "$CMD" = --help ] || exit 2
    ;;
esac
