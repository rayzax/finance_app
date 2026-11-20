#!/usr/bin/env bash
# Set the GitHub Actions secrets the deploy workflow needs.
# Usage: scripts/set-secrets.sh [owner/repo]   (defaults to the current repo)
set -euo pipefail

command -v gh >/dev/null 2>&1 || { echo "gh CLI is required" >&2; exit 1; }
REPO_ARGS=()
[[ $# -ge 1 ]] && REPO_ARGS=(--repo "$1")

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

set_secret() {
  local name="$1" value="$2"
  [[ -n "$value" ]] || { echo "$name is empty, aborting" >&2; exit 1; }
  printf %s "$value" | gh secret set "$name" "${REPO_ARGS[@]}"
}

read -r -s -p "PLAID_CLIENT_ID: " PLAID_CLIENT_ID; echo
set_secret PLAID_CLIENT_ID "$PLAID_CLIENT_ID"
unset PLAID_CLIENT_ID

read -r -s -p "PLAID_SECRET (for the environment you deploy: sandbox or production): " PLAID_SECRET; echo
set_secret PLAID_SECRET "$PLAID_SECRET"
unset PLAID_SECRET

read -r -p "Generate APP_PASSWORD_HASH from a password now? [Y/n] " ans
if [[ "${ans:-Y}" =~ ^[Nn] ]]; then
  read -r -s -p "Paste existing bcrypt hash: " HASH; echo
else
  [[ -d "$ROOT/server/node_modules" ]] || (cd "$ROOT/server" && npm ci)
  # hash-password reads the password from stdin without echo and prints the hash.
  HASH="$(cd "$ROOT/server" && npm run --silent hash-password | tail -n 1)"
fi
set_secret APP_PASSWORD_HASH "$HASH"
unset HASH

echo "Done. Secrets set: PLAID_CLIENT_ID, PLAID_SECRET, APP_PASSWORD_HASH"
