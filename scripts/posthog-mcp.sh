#!/usr/bin/env bash
set -eu
posthogHeaderFile="${HOME}/.config/glissa/posthog-headers.txt"
if [ ! -f "$posthogHeaderFile" ]; then
  echo "Refusing to start: $posthogHeaderFile is missing, run scripts/setup-posthog.sh in a terminal" >&2
  exit 1
fi
posthogHeaderFileMode="$(stat -c %a "$posthogHeaderFile")"
if [ "$((8#$posthogHeaderFileMode & 8#077))" -ne 0 ]; then
  echo "Refusing to use $posthogHeaderFile: mode $posthogHeaderFileMode is readable beyond the owner, run chmod 600 on it" >&2
  exit 1
fi
if ! command -v mcp-remote >/dev/null 2>&1; then
  echo "Refusing to start: mcp-remote is not on PATH ($PATH), converge dotfiles, whose npm globals list installs it" >&2
  exit 1
fi
exec mcp-remote 'https://mcp.posthog.com/mcp?readonly=true' --transport http-only --header-file "$posthogHeaderFile"
