#!/usr/bin/env bash
# Hermetic lifecycle test for dev-services.sh. It substitutes only the process
# launcher and HTTP probe; the supervisor's ownership, PID, readiness, and
# shutdown behavior run unchanged.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
cleanup() {
  if [ -n "${SUPERVISOR_PID:-}" ]; then kill -TERM "$SUPERVISOR_PID" 2>/dev/null || true; fi
  if [ -n "${UNRELATED_PID:-}" ]; then kill -TERM "$UNRELATED_PID" 2>/dev/null || true; fi
  if [ "${PLASTIQ_KEEP_SERVICE_TEST_STATE:-0}" = "1" ]; then
    echo "kept service test state at $TMP" >&2
    return
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

mkdir -p "$TMP/bin" "$TMP/home/.conda" "$TMP/repo/services" "$TMP/state" "$TMP/health"
for name in reconstruct capture nerf nurbs photogrammetry; do
  mkdir -p "$TMP/envs/plastiq-$name" "$TMP/repo/services/$name"
  printf '%s\n' "$TMP/envs/plastiq-$name" >> "$TMP/home/.conda/environments.txt"
done

cat > "$TMP/bin/micromamba" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "$1" = "run" ]
shift 3
exec "$@"
SH

cat > "$TMP/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
url="${!#}"
port="${url#*127.0.0.1:}"
port="${port%%/*}"
[ -f "$FAKE_SERVICE_HEALTH/$port" ]
SH

cat > "$TMP/bin/lsof" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
pid=""
path=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) pid="$2"; shift 2 ;;
    -*) shift ;;
    *) path="$1"; shift ;;
  esac
done
if [ -n "$pid" ] && [ -f "$path" ] && kill -0 "$pid" 2>/dev/null; then
  printf '%s\n' "$pid"
fi
SH

cat > "$TMP/bin/uvicorn" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
port=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--port" ]; then port="$2"; shift 2; else shift; fi
done
[ -n "$port" ]
marker="$FAKE_SERVICE_HEALTH/$port"
touch "$marker"
trap 'rm -f "$marker"; exit 0' TERM INT EXIT
while :; do sleep 1; done
SH
chmod +x "$TMP/bin/micromamba" "$TMP/bin/curl" "$TMP/bin/lsof" "$TMP/bin/uvicorn"

export PATH="$TMP/bin:$PATH"
export HOME="$TMP/home"
export FAKE_SERVICE_HEALTH="$TMP/health"
export PLASTIQ_SERVICE_REPO_ROOT="$TMP/repo"
export PLASTIQ_SERVICE_STATE_DIR="$TMP/state"
export PLASTIQ_SERVICE_OWNER="test-owner"
export PLASTIQ_SERVICE_HEALTH_ATTEMPTS=50
export PLASTIQ_SERVICE_HEALTH_INTERVAL=0.1
export PLASTIQ_SERVICE_MONITOR_INTERVAL=0.1

bash -n "$ROOT/scripts/dev-services.sh"
"$ROOT/scripts/dev-services.sh" start > "$TMP/supervisor.log" 2>&1 &
SUPERVISOR_PID=$!

for _ in $(seq 1 100); do
  grep -q "all five services healthy and supervised" "$TMP/supervisor.log" && break
  kill -0 "$SUPERVISOR_PID" 2>/dev/null || {
    cat "$TMP/supervisor.log" >&2
    exit 1
  }
  sleep 0.1
done
grep -q "all five services healthy and supervised" "$TMP/supervisor.log"
[ "$(wc -l < "$TMP/state/test-owner.pids" | tr -d ' ')" = "5" ]
"$ROOT/scripts/dev-services.sh" status >/dev/null

# Health loss restarts the owned service and restores readiness.
old_nerf_pid="$(awk -F '\t' '$1 == "nerf" { print $2 }' "$TMP/state/test-owner.pids")"
rm -f "$TMP/health/8002"
for _ in $(seq 1 100); do
  new_nerf_pid="$(awk -F '\t' '$1 == "nerf" { print $2 }' "$TMP/state/test-owner.pids")"
  [ -e "$TMP/health/8002" ] && [ -n "$new_nerf_pid" ] && \
    [ "$new_nerf_pid" != "$old_nerf_pid" ] && break
  sleep 0.1
done
[ -e "$TMP/health/8002" ]
[ "$new_nerf_pid" != "$old_nerf_pid" ]

kill -TERM "$SUPERVISOR_PID"
wait "$SUPERVISOR_PID" 2>/dev/null || true
SUPERVISOR_PID=""

[ ! -e "$TMP/state/test-owner.pids" ]
for port in 8000 8001 8002 8003 8004; do [ ! -e "$TMP/health/$port" ]; done

# Healthy pre-existing listeners are adopted and remain alive after shutdown.
for port in 8000 8001 8002 8003 8004; do touch "$TMP/health/$port"; done
export PLASTIQ_SERVICE_OWNER="adopt-owner"
"$ROOT/scripts/dev-services.sh" start > "$TMP/adopt.log" 2>&1 &
SUPERVISOR_PID=$!
for _ in $(seq 1 100); do
  grep -q "all five services healthy and supervised" "$TMP/adopt.log" && break
  sleep 0.1
done
grep -q "all five services healthy and supervised" "$TMP/adopt.log"
[ ! -s "$TMP/state/adopt-owner.pids" ]
kill -TERM "$SUPERVISOR_PID"
wait "$SUPERVISOR_PID" 2>/dev/null || true
SUPERVISOR_PID=""
for port in 8000 8001 8002 8003 8004; do [ -e "$TMP/health/$port" ]; done
rm -f "$TMP/health/"*

# A stale record cannot signal a different process that reused the PID.
sleep 30 &
UNRELATED_PID=$!
printf 'stale\t%s\t%s\t9999\t%s\n' \
  "$UNRELATED_PID" "$UNRELATED_PID" "$TMP/state/missing.token" > "$TMP/state/stale-owner.pids"
"$ROOT/scripts/dev-services.sh" stop --owner stale-owner >/dev/null 2>&1
kill -0 "$UNRELATED_PID"
kill -TERM "$UNRELATED_PID"
wait "$UNRELATED_PID" 2>/dev/null || true
UNRELATED_PID=""

# The app wrapper owns and tears down the full service set when its app exits.
export PLASTIQ_SERVICE_OWNER="ignored-by-with"
"$ROOT/scripts/dev-services.sh" with bash -c \
  'for _ in $(seq 1 100); do [ "$(find "$FAKE_SERVICE_HEALTH" -type f | wc -l | tr -d " ")" = 5 ] && exit 0; sleep 0.1; done; exit 1' \
  > "$TMP/with.log" 2>&1
for port in 8000 8001 8002 8003 8004; do [ ! -e "$TMP/health/$port" ]; done

echo "dev-services lifecycle test passed"
