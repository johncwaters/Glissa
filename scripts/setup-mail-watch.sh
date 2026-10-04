#!/usr/bin/env bash
set -euo pipefail

setupScriptDirectory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$setupScriptDirectory/environment.sh"
reauthorizeAccounts=0
skipTimer=0

usage() {
  echo "usage: $0 [--reauth] [--skip-timer] <client_secret.json> <email-1> <email-2> <email-3>" >&2
  exit 2
}

setupMessage() {
  echo "setup: $1"
}

promptForKeyringPassword() {
  local environmentFile="$1"
  local firstPassword
  local secondPassword
  if grep -q '^GOG_KEYRING_PASSWORD=' "$environmentFile"; then
    setupMessage "kept existing keyring password"
    return
  fi
  IFS= read -rs -p 'Keyring password: ' firstPassword
  printf '\n' >&2
  IFS= read -rs -p 'Confirm keyring password: ' secondPassword
  printf '\n' >&2
  [ -n "$firstPassword" ] || { echo "setup: keyring password cannot be empty" >&2; exit 1; }
  [ "$firstPassword" = "$secondPassword" ] || { echo "setup: keyring passwords did not match" >&2; exit 1; }
  printf 'GOG_KEYRING_BACKEND=file\nGOG_KEYRING_PASSWORD=%q\n' "$firstPassword" >> "$environmentFile"
  setupMessage "saved keyring password"
}

ensureEnvFile() {
  local configurationDirectory="${HOME}/.config/assistant"
  local environmentFile="$configurationDirectory/gog.env"
  local environmentFileMode
  mkdir -p "$configurationDirectory"
  (umask 077 && touch "$environmentFile")
  environmentFileMode="$(stat -c %a "$environmentFile")"
  if [ "$((8#$environmentFileMode & 8#077))" -ne 0 ]; then
    chmod 600 "$environmentFile"
    setupMessage "secured $environmentFile"
  fi
  promptForKeyringPassword "$environmentFile"
  loadEnvironmentFile "$environmentFile" "$@"
}

accountAlreadyAuthorized() {
  local accountEmail="$1"
  [ "$reauthorizeAccounts" -eq 0 ] || return 1
  gog auth list --json | node -e 'const authListEnvelope = JSON.parse(require("fs").readFileSync(0, "utf8")); const authorizedAccounts = authListEnvelope.accounts ?? []; process.exit(authorizedAccounts.some((account) => account.email === process.argv[1]) ? 0 : 1)' "$accountEmail"
}

addAccount() {
  local accountAlias="$1"
  local accountEmail="$2"
  if accountAlreadyAuthorized "$accountEmail"; then
    setupMessage "skipped authorization for $accountAlias"
    echo "setup: $accountAlias was authorized earlier; if that was before calendar writes, rerun with --reauth" >&2
    return
  fi
  gog auth add "$accountEmail" --services gmail,calendar --gmail-scope readonly --manual
  setupMessage "authorized $accountAlias"
}

authorizeAccount() {
  local accountAlias="$1"
  local accountEmail="$2"
  addAccount "$accountAlias" "$accountEmail"
  gog auth alias set "$accountAlias" "$accountEmail"
  setupMessage "set alias $accountAlias"
}

verifyAccount() {
  local accountAlias="$1"
  local searchEnvelope
  searchEnvelope="$(gog --account "$accountAlias" gmail search 'newer_than:7d' --max 1 --json)" || {
    echo "setup: verification failed for $accountAlias" >&2
    exit 1
  }
  if printf '%s' "$searchEnvelope" | node -e 'const searchEnvelope = JSON.parse(require("fs").readFileSync(0, "utf8")); const foundThreads = searchEnvelope.threads ?? []; process.exit(foundThreads.length > 0 ? 0 : 1)'; then
    setupMessage "verified mail access for $accountAlias"
    return
  fi
  setupMessage "$accountAlias reachable, no mail in the last 7 days"
}

enableTimer() {
  "$setupScriptDirectory/install-units.sh"
  setupMessage "next watch ticks at :04 :19 :34 :49; inspect context/situation.md and logs/assistant.jsonl"
}

requireTerminalStandardInput() {
  if [ ! -t 0 ]; then
    echo "setup: refusing to run unless standard input is a terminal" >&2
    exit 2
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --reauth) reauthorizeAccounts=1 ;;
    --skip-timer) skipTimer=1 ;;
    --*) usage ;;
    *) break ;;
  esac
  shift
done

[ "$#" -eq 4 ] || usage
clientSecretFile="$1"
[ -f "$clientSecretFile" ] || usage

requireTerminalStandardInput
ensureEnvFile
gog auth credentials set "$clientSecretFile"
setupMessage "registered OAuth client"
gog auth keyring file
setupMessage "selected file keyring"
authorizeAccount personal-1 "$2"
authorizeAccount personal-2 "$3"
authorizeAccount personal-3 "$4"
gog auth doctor --check
setupMessage "checked gog configuration"
verifyAccount personal-1
verifyAccount personal-2
verifyAccount personal-3
if [ "$skipTimer" -eq 1 ]; then
  setupMessage "skipped timer setup"
  exit 0
fi
enableTimer
