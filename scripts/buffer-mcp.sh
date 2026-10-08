#!/usr/bin/env bash
set -eu
bufferHeaderFile="${HOME}/.config/glissa/buffer-headers.txt"
if [ ! -f "$bufferHeaderFile" ]; then
  echo "Refusing to start: $bufferHeaderFile is missing, write 'Authorization: Bearer <key>' to it at mode 600" >&2
  exit 1
fi
bufferHeaderFileMode="$(stat -c %a "$bufferHeaderFile")"
if [ "$((8#$bufferHeaderFileMode & 8#077))" -ne 0 ]; then
  echo "Refusing to use $bufferHeaderFile: mode $bufferHeaderFileMode is readable beyond the owner, run chmod 600 on it" >&2
  exit 1
fi
if ! command -v mcp-remote >/dev/null 2>&1; then
  echo "Refusing to start: mcp-remote is not on PATH ($PATH), run npm install -g mcp-remote@0.14.3" >&2
  exit 1
fi
exec mcp-remote https://mcp.buffer.com/mcp --transport http-only --header-file "$bufferHeaderFile"
