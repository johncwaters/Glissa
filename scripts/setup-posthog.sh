#!/usr/bin/env bash
set -euo pipefail

configurationDirectory="${GLISSA_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/glissa}"
posthogHeaderFile="${HOME}/.config/glissa/posthog-headers.txt"
candidateHeaderFile=""

setupMessage() {
  echo "setup: $1"
}

removeCandidateHeaderFile() {
  [ -z "$candidateHeaderFile" ] || rm -f "$candidateHeaderFile"
}
trap removeCandidateHeaderFile EXIT

resolveInstalledGlissaConfigModule() {
  local installedGlissaCommand
  installedGlissaCommand="$(command -v glissa)" || { echo "setup: glissa is not on PATH, run glissa deploy from a checkout first" >&2; exit 1; }
  echo "$(dirname "$(dirname "$(readlink -f "$installedGlissaCommand")")")/scripts/glissa-config.mjs"
}

requireInstalledGlissaKnowsPosthog() {
  INSTALLED_GLISSA_CONFIG_MODULE="$1" node --input-type=module -e "const { knownModuleNames } = await import(process.env.INSTALLED_GLISSA_CONFIG_MODULE); process.exit(knownModuleNames.includes('posthog') ? 0 : 1)" \
    || { echo "setup: the installed glissa predates the posthog module, run glissa deploy from a checkout first" >&2; exit 1; }
}

writeCandidateHeaderFile() {
  local personalApiKey
  echo "Create a personal API key at https://us.posthog.com/settings/user-api-keys (or the EU host) with every read scope, no write scope, and access to all organizations and projects." >&2
  IFS= read -rs -p 'PostHog personal API key: ' personalApiKey
  printf '\n' >&2
  [ -n "$personalApiKey" ] || { echo "setup: the key cannot be empty" >&2; exit 1; }
  case "$personalApiKey" in
    phx_*) ;;
    *) echo "setup: a personal API key starts with phx_" >&2; exit 1 ;;
  esac
  mkdir -p "$(dirname "$posthogHeaderFile")"
  candidateHeaderFile="$(umask 077 && mktemp "$(dirname "$posthogHeaderFile")/.posthog-candidate.XXXXXX")"
  printf 'Authorization: Bearer %s\n' "$personalApiKey" > "$candidateHeaderFile"
}

refuseKeyWithWriteScope() {
  local posthogHost
  local currentKeyResponse
  for posthogHost in https://us.posthog.com https://eu.posthog.com; do
    currentKeyResponse="$(curl -sS --fail --max-time 20 -H "@$candidateHeaderFile" "$posthogHost/api/personal_api_keys/@current/" 2>/dev/null)" || continue
    node -e 'const { scopes = [] } = JSON.parse(require("fs").readFileSync(0, "utf8")); const nonReadScopes = scopes.filter((scope) => !scope.endsWith(":read")); if (nonReadScopes.length > 0) { console.error(`setup: the key carries non-read scopes ${nonReadScopes.join(", ")}; make one with read scopes only`); process.exit(1) }' <<<"$currentKeyResponse"
    setupMessage "the key on $posthogHost carries read scopes only"
    return
  done
  echo "setup: neither us.posthog.com nor eu.posthog.com accepted the key" >&2
  exit 1
}

enablePosthogModule() {
  node --input-type=module - "$1" "$configurationDirectory/config.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
const [glissaConfigModulePath, configFilePath] = process.argv.slice(2)
const { findConfigProblems } = await import(glissaConfigModulePath)
const config = JSON.parse(readFileSync(configFilePath, 'utf8'))
const modules = Array.isArray(config.modules) ? config.modules : []
if (modules.includes('posthog')) {
  console.log('setup: the posthog module was already on')
  process.exit(0)
}
const updatedConfig = { ...config, modules: [...modules, 'posthog'] }
const problems = findConfigProblems(updatedConfig)
if (problems.length > 0) {
  console.error(`setup: config would be invalid: ${problems.join('; ')}`)
  process.exit(1)
}
writeFileSync(configFilePath, `${JSON.stringify(updatedConfig, null, 2)}\n`)
console.log(`setup: turned the posthog module on in ${configFilePath}`)
NODE
}

[ -f "$configurationDirectory/config.json" ] || { echo "setup: $configurationDirectory/config.json is missing, run glissa init first" >&2; exit 1; }
command -v mcp-remote >/dev/null 2>&1 || { echo "setup: mcp-remote is not on PATH, converge dotfiles, whose npm globals list installs it" >&2; exit 1; }
installedGlissaConfigModule="$(resolveInstalledGlissaConfigModule)"
requireInstalledGlissaKnowsPosthog "$installedGlissaConfigModule"
writeCandidateHeaderFile
refuseKeyWithWriteScope
mv "$candidateHeaderFile" "$posthogHeaderFile"
candidateHeaderFile=""
setupMessage "wrote $posthogHeaderFile at mode 600"
enablePosthogModule "$installedGlissaConfigModule"
systemctl --user restart glissa.service
setupMessage "restarted glissa.service; the posthog_read server starts with the next session"
