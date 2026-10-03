# pg-stamp.sh: the Postgres side of the integration scopes. Sourced, never run.
#
# One definition for bootstrap-n8n.sh and run-conformance.sh, so a baseline and the legs
# compared to it stamp the same things the same way.
#
# The provider is Docker, and n8n's own testcontainers code runs unmodified: each integration
# file starts its own container through `new PostgreSqlContainer(<image>)`, and testcontainers
# reaps it (ryuk). Nothing here starts a database for the tests. What this file adds:
#
#   pg_preflight          die unless `docker info` answers, so a run never reports a
#                         container start failure as a test result.
#   pg_images DIR         the images DIR's *.integration.test.ts files hand to
#                         `new PostgreSqlContainer(...)`: a string literal as written, or
#                         `postgresVersions.<key>` resolved through the package's own
#                         `n8n-containers/postgres-versions.json`. An argument of another shape
#                         prints as `unresolved:<arg>`, and pg_stamp fails on it.
#   pg_watch_begin FILE   streams the daemon's container `start` events into FILE in the
#   pg_watch_end          background until pg_watch_end. Streamed, not queried afterwards:
#                         `docker events --since` replays a bounded buffer that testcontainers'
#                         exec probes overflow, so a query after the run undercounts.
#   pg_stamp DIR EV OUT   writes OUT: the Docker server and its memory, every image from
#                         pg_images with its local image id, repo digest and `postgres -V`, and
#                         the containers started while the watch ran (EV, from pg_watch_*),
#                         i.e. which images the run actually used and how many times.
#
# A floating tag (`postgres:18-alpine`) can move between a baseline and a leg if it is pulled
# in between. The stamp records the image id so the two can be compared; it does not pin.
#
# The caller defines log() and die().

pg_preflight() {
  command -v docker >/dev/null 2>&1 || die "no docker on PATH; the integration scopes need Docker (testcontainers)"
  docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 \
    || die "the Docker daemon does not answer (docker info); start it before an integration scope"
}

pg_images() {
  local dir
  dir=$(cd "$1" && pwd) || return 1
  node - "$dir" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const dir = process.argv[2];
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.integration.test.ts')) files.push(p);
  }
};
walk(path.join(dir, 'src'));
const req = createRequire(path.join(dir, 'noop.js'));
let versions;
const out = new Set();
for (const f of files.sort()) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/new PostgreSqlContainer\(\s*([^)]*?)\s*\)/g)) {
    const arg = m[1];
    const lit = arg.match(/^['"`]([^'"`]+)['"`]$/);
    const key = arg.match(/^postgresVersions\.(\w+)$/);
    if (lit) out.add(lit[1]);
    else if (key) {
      versions ??= JSON.parse(fs.readFileSync(req.resolve('n8n-containers/postgres-versions.json'), 'utf8'));
      const v = versions[key[1]];
      out.add(typeof v === 'string' ? v : `unresolved:${arg}`);
    } else out.add(`unresolved:${arg}`);
  }
}
for (const i of out) console.log(i);
NODE
}

PG_WATCH_PID=
pg_watch_begin() {
  : > "$1"
  docker events --filter type=container --filter event=start --format '{{.From}}' > "$1" 2>/dev/null &
  PG_WATCH_PID=$!
  sleep 1   # let the stream subscribe before the first container starts
}
pg_watch_end() {
  [ -n "$PG_WATCH_PID" ] || return 0
  sleep 1   # let the stream flush the last start event
  # Docker Desktop's `docker` is a shim that runs com.docker.cli as its child and does not pass
  # SIGTERM on, and a background job of a non-interactive shell ignores SIGINT: signal the
  # child first, then the shim.
  pkill -TERM -P "$PG_WATCH_PID" 2>/dev/null || true
  kill -TERM "$PG_WATCH_PID" 2>/dev/null || true
  wait "$PG_WATCH_PID" 2>/dev/null || true
  PG_WATCH_PID=
}

pg_stamp() {
  local dir events=$2 out=$3 img id digest ver bad=0 started images
  dir=$(cd "$1" && pwd) || die "pg_stamp: no directory $1"
  images=$(pg_images "$dir") || die "pg_stamp: could not list the images in $dir"
  [ -n "$images" ] || die "pg_stamp: no PostgreSqlContainer image found under $dir/src"
  started=$(sort "$events" | uniq -c | sed 's/^ *//')
  {
    echo "date              $(date -u +%FT%TZ)"
    echo "docker server     $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
    echo "docker memory     $(docker info --format '{{.MemTotal}}' 2>/dev/null) bytes, $(docker info --format '{{.NCPU}}' 2>/dev/null) cpus"
    echo "testcontainers    $(node -p 'require(process.argv[1]).version' "$dir/node_modules/@testcontainers/postgresql/package.json" 2>/dev/null || echo none)"
    echo
    echo "# images the scope's integration tests start (image ref, local image id, repo digest, server binary)"
    while IFS= read -r img; do
      [ -n "$img" ] || continue
      case "$img" in unresolved:*) echo "$img"; bad=1; continue ;; esac
      id=$(docker image inspect --format '{{.Id}}' "$img" 2>/dev/null || echo absent)
      digest=$(docker image inspect --format '{{join .RepoDigests " "}}' "$img" 2>/dev/null || echo -)
      ver=$(docker run --rm --entrypoint postgres "$img" -V 2>/dev/null || echo unknown)
      echo "$img  $id  $digest  $ver"
    done <<< "$images"
    echo
    echo "# containers started during the run (count, image)"
    printf '%s\n' "${started:-none}"
  } > "$out"
  [ $bad -eq 0 ] || die "pg_stamp: an image argument could not be resolved; see $out"
}
