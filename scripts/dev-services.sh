#!/usr/bin/env bash
# One-command bring-up for the Plastiq Python services (just services / just services-stop):
#
#   reconstruct    :8000  (mesh → B-rep + STEP,  env plastiq-reconstruct)
#   capture        :8001  (point cloud → mesh,   env plastiq-capture, MLX/Apple Silicon)
#   nerf           :8002  (posed images → mesh,  env plastiq-nerf,    MLX/Apple Silicon)
#   nurbs          :8003  (mesh → NURBS surfaces → STEP, env plastiq-nurbs, MLX/Apple Silicon)
#   photogrammetry :8004  (photos → poses + point cloud, env plastiq-photogrammetry, MLX/Apple
#                          Silicon) — registered below but COMMENTED until its app/main.py lands
#                          (SPEC-13 P10.2); uncomment the SERVICES entry then.
#
# Each service runs `uvicorn app.main:app` inside its own conda env (created from the service's
# environment.yml if missing). Output is line-prefixed with the service name; Ctrl-C shuts them
# all down and frees the ports. `dev-services.sh stop` kills any stray listeners on the ports.
#
# Envs are resolved by name via ~/.conda/environments.txt (the registry conda/mamba/micromamba all
# append to), so envs created under older roots (e.g. ~/mamba/envs) still resolve.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# name:env:dir:port — keep ports in sync with the service READMEs + the browser clients' defaults.
SERVICES=(
  "reconstruct:plastiq-reconstruct:services/reconstruct:8000"
  "capture:plastiq-capture:services/capture:8001"
  "nerf:plastiq-nerf:services/nerf:8002"
  "nurbs:plastiq-nurbs:services/nurbs:8003"
  # photogrammetry :8004 — reserved (SPEC-13). Uncomment when services/photogrammetry/app/main.py
  # exists (P10.2); until then it has no uvicorn target, so it stays out of the bring-up loop.
  # "photogrammetry:plastiq-photogrammetry:services/photogrammetry:8004"
)

find_launcher() {
  local cand
  for cand in micromamba mamba conda; do
    if command -v "$cand" >/dev/null 2>&1; then
      command -v "$cand"
      return 0
    fi
  done
  echo "error: no micromamba/mamba/conda on PATH — install micromamba (brew install micromamba)" >&2
  return 1
}
LAUNCHER="$(find_launcher)"

# Env name → prefix, via the conda environments registry (exact basename match, first hit wins).
resolve_prefix() {
  local env_name="$1" line
  [ -f "$HOME/.conda/environments.txt" ] || return 1
  while IFS= read -r line; do
    if [ "$(basename "$line")" = "$env_name" ] && [ -d "$line" ]; then
      echo "$line"
      return 0
    fi
  done < "$HOME/.conda/environments.txt"
  return 1
}

create_env() {
  local env_name="$1" dir="$2"
  echo "[$env_name] env not found — creating from $dir/environment.yml (this can take a few minutes)…"
  case "$(basename "$LAUNCHER")" in
    micromamba) "$LAUNCHER" create -y -f "$REPO_ROOT/$dir/environment.yml" ;;
    *) "$LAUNCHER" env create -y -f "$REPO_ROOT/$dir/environment.yml" ;;
  esac
}

PORTS=()
PIDS=()

kill_port_listeners() {
  local port="$1" pids
  pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "freeing port $port (pid(s): $pids)"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
  fi
}

stop_all() {
  local port
  for port in 8000 8001 8002 8003; do
    kill_port_listeners "$port"
  done
}

if [ "${1:-start}" = "stop" ]; then
  stop_all
  exit 0
fi

shutdown() {
  trap - INT TERM
  echo ""
  echo "shutting down services…"
  local pid port
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  for port in "${PORTS[@]}"; do
    kill_port_listeners "$port"
  done
  wait 2>/dev/null || true
  echo "all services stopped."
}
trap shutdown INT TERM

prefix_lines() { # prefix_lines <name>  — tag each stdout/stderr line with its service
  local name="$1" line
  while IFS= read -r line; do
    printf '[%s] %s\n' "$name" "$line"
  done
}

for spec in "${SERVICES[@]}"; do
  IFS=: read -r name env_name dir port <<< "$spec"
  if ! prefix="$(resolve_prefix "$env_name")"; then
    create_env "$env_name" "$dir"
    prefix="$(resolve_prefix "$env_name")" || {
      echo "error: created $env_name but cannot resolve its prefix" >&2
      exit 1
    }
  fi
  echo "[$name] starting on http://127.0.0.1:$port (env: $prefix)"
  (
    cd "$REPO_ROOT/$dir"
    exec "$LAUNCHER" run -p "$prefix" uvicorn app.main:app --host 127.0.0.1 --port "$port"
  ) 2>&1 | prefix_lines "$name" &
  PIDS+=($!)
  PORTS+=("$port")
done

# Wait until every /health answers (MLX/OCCT imports take a few seconds per service).
for spec in "${SERVICES[@]}"; do
  IFS=: read -r name env_name dir port <<< "$spec"
  for _ in $(seq 1 60); do
    if curl -sf --max-time 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      echo "[$name] healthy: http://127.0.0.1:$port/health"
      break
    fi
    sleep 1
  done
done

echo "all services up — Ctrl-C to stop."
wait
