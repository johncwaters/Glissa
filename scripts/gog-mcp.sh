#!/usr/bin/env bash
set -eu
accountAlias="$1"
source "$(dirname "${BASH_SOURCE[0]}")/environment.sh"
gogEnvironmentFile="${HOME}/.config/assistant/gog.env"
if [ -f "$gogEnvironmentFile" ]; then
  gogEnvironmentFileMode="$(stat -c %a "$gogEnvironmentFile")"
  if [ "$((8#$gogEnvironmentFileMode & 8#077))" -ne 0 ]; then
    echo "Refusing to read $gogEnvironmentFile: mode $gogEnvironmentFileMode is readable beyond the owner, run chmod 600 on it" >&2
    exit 1
  fi
  loadEnvironmentFile "$gogEnvironmentFile" "$@"
fi
exec gog --account "$accountAlias" --readonly mcp --allow-tool gmail,calendar
