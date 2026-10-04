#!/usr/bin/env bash
set -eu
browserProfileDirectory="${HOME}/.config/assistant/browser-profile"
if [ ! -d "$browserProfileDirectory" ]; then
  echo "Refusing to start: $browserProfileDirectory is missing, run install -d -m 700 on it" >&2
  exit 1
fi
browserProfileMode="$(stat -c %a "$browserProfileDirectory")"
if [ "$((8#$browserProfileMode & 8#077))" -ne 0 ]; then
  echo "Refusing to use $browserProfileDirectory: mode $browserProfileMode is readable beyond the owner, run chmod 700 on it" >&2
  exit 1
fi
if ! command -v playwright-mcp >/dev/null 2>&1; then
  echo "Refusing to start: playwright-mcp is not on PATH ($PATH), run npm install -g @playwright/mcp@0.0.81" >&2
  exit 1
fi
browserOutputDirectory="${ASSISTANT_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/assistant}/browser"
mkdir -p "$browserOutputDirectory"
exec playwright-mcp \
  --headless \
  --browser chromium \
  --user-data-dir "$browserProfileDirectory" \
  --output-dir "$browserOutputDirectory" \
  --output-max-size 1048576 \
  --idle-timeout 600000 \
  --block-service-workers
