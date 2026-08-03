#!/usr/bin/env bash
# Lifecycle supervisor for all five Plastiq Python services.
#
# Commands:
#   dev-services.sh start              foreground supervisor (default)
#   dev-services.sh with <app command> run an app only while all services are supervised
#   dev-services.sh status             health of every service
#   dev-services.sh stop --owner NAME  stop one owned supervisor set
#   dev-services.sh stop --all         stop every Plastiq-owned supervisor set
#
# A healthy process already listening on a service port is adopted but never
# killed. Processes launched here record their actual uvicorn PID in an
# owner-scoped state file; shutdown only signals those recorded children. This
# keeps app lifecycle management from terminating unrelated user processes.

set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
REPO_ROOT="${PLASTIQ_SERVICE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE_DIR="${PLASTIQ_SERVICE_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/plastiq/services}"
HEALTH_ATTEMPTS="${PLASTIQ_SERVICE_HEALTH_ATTEMPTS:-120}"
HEALTH_INTERVAL="${PLASTIQ_SERVICE_HEALTH_INTERVAL:-1}"
MONITOR_INTERVAL="${PLASTIQ_SERVICE_MONITOR_INTERVAL:-5}"
MAX_RESTARTS="${PLASTIQ_SERVICE_MAX_RESTARTS:-3}"

# name:env:dir:port — keep in sync with service READMEs and browser defaults.
SERVICES=(
  "reconstruct:plastiq-reconstruct:services/reconstruct:8000"
  "capture:plastiq-capture:services/capture:8001"
  "nerf:plastiq-nerf:services/nerf:8002"
  "nurbs:plastiq-nurbs:services/nurbs:8003"
  "photogrammetry:plastiq-photogrammetry:services/photogrammetry:8004"
)

service_health() {
  local port="$1"
  curl -sf --max-time 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1
}

port_listeners() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:$port" 2>/dev/null || true
  fi
}

valid_pid() {
  [[ "${1:-}" =~ ^[0-9]+$ ]] && [ "$1" -gt 1 ] && kill -0 "$1" 2>/dev/null
}

recorded_process_is_current() {
  local pid="${1:-}" token_file="${2:-}"
  valid_pid "$pid" && [ -f "$token_file" ] && command -v lsof >/dev/null 2>&1 &&
    [ "$(lsof -t -a -p "$pid" "$token_file" 2>/dev/null || true)" = "$pid" ]
}

terminate_pid() {
  local pid="${1:-}" i
  [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || return 0
  kill -TERM "$pid" 2>/dev/null || return 0
  for i in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
}

stop_state_file() {
  local state_file="$1" name service_pid launcher_pid port token_file
  [ -f "$state_file" ] || return 0
  while IFS=$'\t' read -r name service_pid launcher_pid port token_file; do
    [ -n "${name:-}" ] || continue
    if recorded_process_is_current "$service_pid" "$token_file"; then
      echo "[$name] stopping owned service pid $service_pid on :${port:-?}"
      terminate_pid "$service_pid"
    else
      echo "[$name] skipping stale service pid ${service_pid:-?} on :${port:-?}" >&2
    fi
    rm -f "$token_file"
  done < "$state_file"
  rm -f "$state_file"
}

stop_command() {
  shift
  mkdir -p "$STATE_DIR"
  if [ "${1:-}" = "--owner" ]; then
    [ -n "${2:-}" ] || { echo "error: stop --owner requires a name" >&2; return 2; }
    local owner
    owner="$(printf '%s' "$2" | tr -c 'A-Za-z0-9_.-' '_')"
    stop_state_file "$STATE_DIR/$owner.pids"
    return 0
  fi
  if [ "${1:---all}" != "--all" ]; then
    echo "error: stop accepts --owner NAME or --all" >&2
    return 2
  fi
  local state_file
  for state_file in "$STATE_DIR"/*.pids; do
    [ -e "$state_file" ] || continue
    stop_state_file "$state_file"
  done
}

status_command() {
  local failed=0 spec name env_name dir port
  for spec in "${SERVICES[@]}"; do
    IFS=: read -r name env_name dir port <<< "$spec"
    if service_health "$port"; then
      echo "[$name] healthy http://127.0.0.1:$port/health"
    else
      echo "[$name] unavailable http://127.0.0.1:$port/health"
      failed=1
    fi
  done
  return "$failed"
}

# Runs inside the selected conda environment. Writing $$ before exec records the
# real uvicorn PID rather than the outer conda/mamba launcher PID.
internal_run() {
  local name="$2" dir="$3" port="$4" pid_file="$5" token_file="$6"
  mkdir -p "$(dirname "$pid_file")"
  # Keep the owner token open across exec. Shutdown verifies PID + open token,
  # so stale state cannot target another process that later reuses the PID.
  exec 9< "$token_file"
  printf '%s\n' "$$" > "$pid_file"
  cd "$REPO_ROOT/$dir"
  if [ "$name" = "reconstruct" ]; then
    export RECONSTRUCT_NURBS_URL="${RECONSTRUCT_NURBS_URL:-http://127.0.0.1:8003}"
  fi
  exec uvicorn app.main:app --host 127.0.0.1 --port "$port"
}

if [ "${1:-start}" = "_run" ]; then
  internal_run "$@"
fi

if [ "${1:-start}" = "status" ]; then
  status_command
  exit $?
fi

if [ "${1:-start}" = "stop" ]; then
  stop_command "$@"
  exit $?
fi

if [ "${1:-start}" = "with" ]; then
  shift
  [ "$#" -gt 0 ] || { echo "error: with requires an app command" >&2; exit 2; }
  owner="with-$$"
  PLASTIQ_SERVICE_OWNER="$owner" "$SCRIPT_PATH" start &
  supervisor_pid=$!
  "$@" &
  app_pid=$!
  with_shutdown() {
    trap - EXIT INT TERM
    terminate_pid "$app_pid"
    terminate_pid "$supervisor_pid"
    PLASTIQ_SERVICE_OWNER="$owner" "$SCRIPT_PATH" stop --owner "$owner" || true
  }
  trap with_shutdown EXIT INT TERM
  while valid_pid "$app_pid" && valid_pid "$supervisor_pid"; do sleep 1; done
  if ! valid_pid "$supervisor_pid" && valid_pid "$app_pid"; then
    echo "service supervisor exited; stopping the app" >&2
    terminate_pid "$app_pid"
    wait "$supervisor_pid" 2>/dev/null || true
    exit 1
  fi
  wait "$app_pid"
  exit $?
fi

if [ "${1:-start}" != "start" ]; then
  echo "error: unknown command '$1'" >&2
  exit 2
fi

find_launcher() {
  local candidate
  for candidate in micromamba mamba conda; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  # Desktop applications launched outside a terminal inherit a deliberately
  # small PATH. Probe the standard user and package-manager install locations
  # so the packaged app can find the same environment manager as a shell.
  for candidate in \
    "$HOME/.local/bin/micromamba" \
    "$HOME/bin/micromamba" \
    "/opt/homebrew/bin/micromamba" \
    "/usr/local/bin/micromamba" \
    "$HOME/miniforge3/bin/mamba" \
    "$HOME/mambaforge/bin/mamba" \
    "/opt/homebrew/bin/mamba" \
    "$HOME/miniforge3/bin/conda" \
    "$HOME/miniconda3/bin/conda" \
    "$HOME/anaconda3/bin/conda" \
    "/opt/homebrew/bin/conda"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "error: no micromamba/mamba/conda installation found — install micromamba" >&2
  return 1
}

resolve_prefix() {
  local env_name="$1" line
  [ -f "$HOME/.conda/environments.txt" ] || return 1
  while IFS= read -r line; do
    if [ "$(basename "$line")" = "$env_name" ] && [ -d "$line" ]; then
      printf '%s\n' "$line"
      return 0
    fi
  done < "$HOME/.conda/environments.txt"
  return 1
}

create_env() {
  local env_name="$1" dir="$2"
  echo "[$env_name] environment missing; creating from $dir/environment.yml"
  case "$(basename "$LAUNCHER")" in
    micromamba) "$LAUNCHER" create -y -f "$REPO_ROOT/$dir/environment.yml" ;;
    *) "$LAUNCHER" env create -y -f "$REPO_ROOT/$dir/environment.yml" ;;
  esac
}

LAUNCHER="$(find_launcher)"
OWNER="${PLASTIQ_SERVICE_OWNER:-services-$$}"
OWNER="$(printf '%s' "$OWNER" | tr -c 'A-Za-z0-9_.-' '_')"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/$OWNER.pids"

NAMES=()
ENV_NAMES=()
DIRS=()
PORTS=()
PREFIXES=()
OWNED=()
SERVICE_PIDS=()
LAUNCHER_PIDS=()
TOKEN_FILES=()
RESTARTS=()
FAILURES=()

for spec in "${SERVICES[@]}"; do
  IFS=: read -r name env_name dir port <<< "$spec"
  NAMES+=("$name")
  ENV_NAMES+=("$env_name")
  DIRS+=("$dir")
  PORTS+=("$port")
  PREFIXES+=("")
  OWNED+=(0)
  SERVICE_PIDS+=(0)
  LAUNCHER_PIDS+=(0)
  TOKEN_FILES+=("")
  RESTARTS+=(0)
  FAILURES+=(0)
done

write_state() {
  : > "$STATE_FILE"
  local i
  for i in "${!NAMES[@]}"; do
    if [ "${OWNED[$i]}" -eq 1 ]; then
      printf '%s\t%s\t%s\t%s\t%s\n' \
        "${NAMES[$i]}" "${SERVICE_PIDS[$i]}" "${LAUNCHER_PIDS[$i]}" "${PORTS[$i]}" \
        "${TOKEN_FILES[$i]}" \
        >> "$STATE_FILE"
    fi
  done
}

launch_service() {
  local i="$1" name="${NAMES[$1]}" env_name="${ENV_NAMES[$1]}"
  local dir="${DIRS[$1]}" port="${PORTS[$1]}" prefix pid_file token_file log_file
  local launcher_pid service_pid listeners

  if service_health "$port"; then
    echo "[$name] adopting healthy existing service on :$port"
    OWNED[$i]=0
    SERVICE_PIDS[$i]=0
    LAUNCHER_PIDS[$i]=0
    TOKEN_FILES[$i]=""
    return 0
  fi
  listeners="$(port_listeners "$port")"
  if [ -n "$listeners" ]; then
    echo "error: [$name] port $port is occupied by unhealthy unowned pid(s): $listeners" >&2
    return 1
  fi

  prefix="${PREFIXES[$i]}"
  if [ -z "$prefix" ]; then
    if ! prefix="$(resolve_prefix "$env_name")"; then
      create_env "$env_name" "$dir"
      prefix="$(resolve_prefix "$env_name")" || {
        echo "error: [$name] created $env_name but cannot resolve its prefix" >&2
        return 1
      }
    fi
    PREFIXES[$i]="$prefix"
  fi

  pid_file="$STATE_DIR/$OWNER.$name.pid"
  token_file="$STATE_DIR/$OWNER.$name.token"
  log_file="$STATE_DIR/$OWNER.$name.log"
  rm -f "$pid_file" "$token_file"
  printf '%s:%s\n' "$OWNER" "$name" > "$token_file"
  echo "[$name] starting http://127.0.0.1:$port (env: $prefix; log: $log_file)"
  "$LAUNCHER" run -p "$prefix" bash "$SCRIPT_PATH" _run "$name" "$dir" "$port" "$pid_file" "$token_file" \
    > "$log_file" 2>&1 &
  launcher_pid=$!
  # Publish the launcher immediately so an INT/TERM received during startup can
  # still tear it down even before the inner uvicorn PID file appears.
  LAUNCHER_PIDS[$i]="$launcher_pid"
  for _ in $(seq 1 100); do
    [ -s "$pid_file" ] && break
    valid_pid "$launcher_pid" || break
    sleep 0.1
  done
  if [ ! -s "$pid_file" ]; then
    terminate_pid "$launcher_pid"
    echo "error: [$name] launcher exited before uvicorn started" >&2
    return 1
  fi
  service_pid="$(head -n 1 "$pid_file")"
  [[ "$service_pid" =~ ^[0-9]+$ ]] || {
    terminate_pid "$launcher_pid"
    echo "error: [$name] wrote an invalid service pid" >&2
    return 1
  }
  OWNED[$i]=1
  SERVICE_PIDS[$i]="$service_pid"
  TOKEN_FILES[$i]="$token_file"
  if ! recorded_process_is_current "$service_pid" "$token_file"; then
    terminate_pid "$service_pid"
    terminate_pid "$launcher_pid"
    rm -f "$token_file"
    echo "error: [$name] could not verify its owned process token" >&2
    return 1
  fi
  write_state
}

shutdown() {
  trap - EXIT INT TERM
  stop_state_file "$STATE_FILE"
  local i
  for i in "${!LAUNCHER_PIDS[@]}"; do terminate_pid "${LAUNCHER_PIDS[$i]}"; done
}
trap shutdown EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

write_state
for i in "${!NAMES[@]}"; do launch_service "$i"; done

for i in "${!NAMES[@]}"; do
  healthy=0
  for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
    if service_health "${PORTS[$i]}"; then healthy=1; break; fi
    if [ "${OWNED[$i]}" -eq 1 ] && ! valid_pid "${SERVICE_PIDS[$i]}"; then break; fi
    sleep "$HEALTH_INTERVAL"
  done
  if [ "$healthy" -ne 1 ]; then
    echo "error: [${NAMES[$i]}] failed its /health readiness gate" >&2
    exit 1
  fi
  echo "[${NAMES[$i]}] healthy: http://127.0.0.1:${PORTS[$i]}/health"
done

echo "all five services healthy and supervised (owner: $OWNER)"

# Three consecutive failed health probes trigger a bounded restart for owned or
# disappeared adopted services. An unhealthy process on an unowned occupied port
# is never killed; the supervisor fails so the app cannot pretend it is healthy.
while :; do
  sleep "$MONITOR_INTERVAL"
  for i in "${!NAMES[@]}"; do
    if service_health "${PORTS[$i]}"; then
      FAILURES[$i]=0
      continue
    fi
    FAILURES[$i]=$((FAILURES[$i] + 1))
    [ "${FAILURES[$i]}" -ge 3 ] || continue
    echo "[${NAMES[$i]}] lost health; attempting supervised restart" >&2
    if [ "${OWNED[$i]}" -eq 1 ]; then
      terminate_pid "${SERVICE_PIDS[$i]}"
      terminate_pid "${LAUNCHER_PIDS[$i]}"
      OWNED[$i]=0
      write_state
    elif [ -n "$(port_listeners "${PORTS[$i]}")" ]; then
      echo "error: [${NAMES[$i]}] unhealthy unowned listener cannot be replaced" >&2
      exit 1
    fi
    RESTARTS[$i]=$((RESTARTS[$i] + 1))
    if [ "${RESTARTS[$i]}" -gt "$MAX_RESTARTS" ]; then
      echo "error: [${NAMES[$i]}] exceeded $MAX_RESTARTS restart attempts" >&2
      exit 1
    fi
    launch_service "$i"
    FAILURES[$i]=0
  done
done
