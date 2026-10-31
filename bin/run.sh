#!/bin/sh
# Start ubercal with its secrets from hush, by name. Settings that are not secret live in ~/.ubercal/env.
set -e
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.."
[ -f "$HOME/.ubercal/env" ] && . "$HOME/.ubercal/env"
NODE="${UBERCAL_NODE:-$(command -v node)}"
set -- "$NODE" src/main.js
for name in FLUXKIT_SESSION_KEY UBERCAL_DATA_KEY UBERCAL_MONGO_PASSWORD FLUXKIT_GOOGLE_CLIENT_SECRET FLUXKIT_RESEND_API_KEY; do
  if hush info "$name" >/dev/null 2>&1; then
    set -- hush run --name "$name" --env "$name" --redact -- "$@"
  elif [ "$name" != FLUXKIT_GOOGLE_CLIENT_SECRET ] && [ "$name" != FLUXKIT_RESEND_API_KEY ]; then
    # Without its keys ubercal cannot start; waiting keeps a supervisor from restarting it in a loop.
    echo "ubercal: hush has no $name" >&2
    sleep 300
    exit 1
  fi
done
exec "$@"
