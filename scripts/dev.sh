#!/usr/bin/env bash
# Local dev: Firestore emulator + API (:8080) + Vite (:5173). Ctrl-C stops everything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Java 21+ is required by the Firestore emulator.
if ! command -v java >/dev/null 2>&1; then
  echo "ERROR: Java is not installed. The Firestore emulator needs Java 21 or newer." >&2
  echo "  Debian/Ubuntu: sudo apt install openjdk-21-jre-headless" >&2
  echo "  macOS:         brew install openjdk@21" >&2
  exit 1
fi
JAVA_MAJOR="$(java -version 2>&1 | awk -F '"' '/version/ {split($2, v, "."); print (v[1] == "1" ? v[2] : v[1]); exit}')"
if [[ "${JAVA_MAJOR:-0}" -lt 21 ]]; then
  echo "ERROR: Java ${JAVA_MAJOR:-unknown} found; the Firestore emulator needs Java 21 or newer." >&2
  exit 1
fi
command -v gcloud >/dev/null 2>&1 || { echo "ERROR: gcloud is required (gcloud emulators firestore)." >&2; exit 1; }

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
else
  echo "WARN: no .env found (copy .env.example to .env)" >&2
fi

export GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-reserve-dev}"
export FIRESTORE_EMULATOR_HOST="${FIRESTORE_EMULATOR_HOST:-localhost:8081}"
export PORT=8080

# Job control gives each background job its own process group, so we can kill trees.
set -m
PIDS=()
cleanup() {
  trap - EXIT INT TERM
  echo; echo "Stopping dev processes..."
  for pid in "${PIDS[@]}"; do kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

gcloud emulators firestore start --host-port="$FIRESTORE_EMULATOR_HOST" &
PIDS+=($!)

HOST="${FIRESTORE_EMULATOR_HOST%:*}"; EPORT="${FIRESTORE_EMULATOR_HOST##*:}"
echo "Waiting for Firestore emulator on ${FIRESTORE_EMULATOR_HOST}..."
for _ in $(seq 1 60); do
  if (exec 3<>"/dev/tcp/${HOST}/${EPORT}") 2>/dev/null; then break; fi
  kill -0 "${PIDS[0]}" 2>/dev/null || { echo "Emulator exited early." >&2; exit 1; }
  sleep 1
done

(cd server && exec npm run dev) &
PIDS+=($!)
(cd web && exec npm run dev) &
PIDS+=($!)

echo "Server: http://localhost:8080   Web: http://localhost:5173"
# Exit as soon as any child dies.
wait -n
