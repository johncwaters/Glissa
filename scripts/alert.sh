#!/usr/bin/env bash
set -u
alertScriptDirectory="$(cd "$(dirname "$0")" && pwd)"
logScriptPath="$alertScriptDirectory/log.mjs"
alertInstance=""
isDryRun=0
for alertArgument in "$@"; do
  [ "$alertArgument" = "--dry-run" ] && isDryRun=1 && continue
  alertInstance="$alertArgument"
done

logAlertEvent() {
  local alertEvent="$1"
  shift
  node "$logScriptPath" alert "$alertEvent" instance="$alertInstance" "$@"
}

failAlert() {
  local failureReason="$1"
  local operatorMessage="$2"
  logAlertEvent failed reason="$failureReason"
  echo "alert: $operatorMessage" >&2
  exit 1
}

if [ -z "$alertInstance" ]; then
  failAlert "missing instance" "missing instance argument"
fi
telegramChannelDirectory="${TELEGRAM_CHANNEL_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/telegram}"
chatId="$(node -e 'const access=require(process.argv[1]);process.stdout.write(String((access.allowFrom||[])[0]||""))' "$telegramChannelDirectory/access.json" 2>/dev/null)"
if [ -z "$chatId" ]; then
  failAlert "no allowed sender" "no telegram chat id in $telegramChannelDirectory/access.json"
fi

readFailingInvocationJournal() {
  if [ -n "${MONITOR_INVOCATION_ID:-}" ]; then
    journalctl --user "_SYSTEMD_INVOCATION_ID=$MONITOR_INVOCATION_ID" -o cat 2>/dev/null
    return 0
  fi
  local monitorUnit="${MONITOR_UNIT:-glissa-dispatch@$alertInstance.service}"
  journalctl --user -u "$monitorUnit" -n 20 -o cat --since -1h 2>/dev/null
}

failureJournalLine="$(readFailingInvocationJournal | grep -v '^[[:space:]]*$' | tail -n 1)"
[ -z "$failureJournalLine" ] && failureJournalLine="no journal output"
messageText="Glissa could not complete the $alertInstance run."$'\n'"$failureJournalLine"
botToken="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$telegramChannelDirectory/.env" 2>/dev/null | tr -d '\r' | head -n 1)"
if [ -z "$botToken" ]; then
  failAlert "no bot token" "no telegram bot token in $telegramChannelDirectory/.env"
fi
if [ "$isDryRun" = "1" ]; then
  printf 'chat_id %s\ntarget https://api.telegram.org/bot<token>/sendMessage\n%s\n' "$chatId" "$messageText"
  exit 0
fi
stampFile="${GLISSA_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/glissa}/alert-$alertInstance"
stampModifiedSeconds="$(stat -c %Y "$stampFile" 2>/dev/null || echo 0)"
if [ "$(($(date +%s) - stampModifiedSeconds))" -lt 3600 ]; then
  logAlertEvent throttled
  echo "alert: throttled" >&2
  exit 0
fi
httpStatus="$(printf '%s' "$messageText" | curl -sS --fail --max-time 15 --retry 2 --retry-delay 5 --retry-all-errors -o /dev/null -w '%{http_code}' -K /dev/fd/3 \
  --data-urlencode "chat_id=$chatId" \
  --data-urlencode text@- \
  3< <(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$botToken"))"
if [ "$?" -ne 0 ]; then
  logAlertEvent failed reason="telegram api error" http_status="${httpStatus:-000}"
  echo "alert: telegram sendMessage failed for $alertInstance" >&2
  exit 1
fi
mkdir -p "$(dirname "$stampFile")"
touch "$stampFile"
logAlertEvent sent
