#!/usr/bin/env sh
# VH UNO launcher for macOS / Linux
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org and run this again."
  exit 1
fi
exec node server.js "$@"
