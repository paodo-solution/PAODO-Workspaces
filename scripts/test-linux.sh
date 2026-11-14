#!/usr/bin/env bash
# Runs the unit suite in a Linux container as an unprivileged user, on a copy of the working tree.
# rootedFs pins directories through /proc/self/fd only on Linux, so macOS never runs that path.
set -euo pipefail
cd "$(dirname "$0")/.."

docker run --rm -v "$PWD":/src:ro node:24-trixie-slim bash -c '
  set -euo pipefail
  mkdir /app && cd /src
  tar --exclude=./node_modules --exclude=./.next --exclude=./.git --exclude=./logs --exclude=./test-results -cf - . |
    tar -xf - -C /app
  chown -R node:node /app && cd /app
  runuser -u node -- env HOME=/home/node bash -c "npm ci --no-audit --no-fund >/tmp/npm.log 2>&1 || { cat /tmp/npm.log; exit 1; }
    npx vitest run $*"
' -- "$@"
