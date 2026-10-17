#!/usr/bin/env bash
set -euo pipefail

installScriptDirectory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
packageRoot="$(cd "$installScriptDirectory/.." && pwd)"
if [ -e "$packageRoot/.git" ]; then
  echo "install: refusing to link units to the checkout $packageRoot; run glissa deploy to install a release" >&2
  exit 1
fi
systemdDirectory="$packageRoot/systemd"
configurationHome="${XDG_CONFIG_HOME:-$HOME/.config}"
userUnitDirectory="$configurationHome/systemd/user"
glissaConfigDirectory="${GLISSA_CONFIG_DIR:-$configurationHome/glissa}"
if ! isChangelogEnabled="$(node --input-type=module - "$installScriptDirectory/glissa-config.mjs" "$glissaConfigDirectory/config.json" <<'NODE'
import { pathToFileURL } from 'node:url'
const { readGlissaConfig, isModuleEnabled } = await import(pathToFileURL(process.argv[2]))
try {
  console.log(isModuleEnabled(readGlissaConfig(process.argv[3]), 'changelog'))
} catch (error) {
  console.error(`install: ${error.message}`)
  process.exit(1)
}
NODE
)"; then
  exit 1
fi

installMessage() {
  echo "install: $1"
}

shouldInstallUnit() {
  [ "$1" != glissa-changelog.timer ] || [ "$isChangelogEnabled" = true ]
}

warnAboutMissingLocalEnvironmentKeys() {
  local localEnvironmentPath="$HOME/.config/glissa/local.env"
  local requiredLocalEnvironmentKeys=(GLISSA_RESULT_HOST GLISSA_RESULT_LOGIN GLISSA_RESULT_SELF_ADDRESSES GLISSA_HOME_TIME_ZONE)
  if [ ! -f "$localEnvironmentPath" ]; then
    echo "install: warning: $localEnvironmentPath is missing; result links and the home time zone need ${requiredLocalEnvironmentKeys[*]}" >&2
    return
  fi
  local requiredKey
  for requiredKey in "${requiredLocalEnvironmentKeys[@]}"; do
    if grep -q "^$requiredKey=" "$localEnvironmentPath"; then
      continue
    fi
    echo "install: warning: $localEnvironmentPath lacks $requiredKey" >&2
  done
}

warnAboutMissingLocalEnvironmentKeys

linkUnit() {
  local unitPath="$1"
  local unitName
  local installedUnitPath="$userUnitDirectory/$(basename "$unitPath")"
  unitName="$(basename "$unitPath")"
  if [ -L "$installedUnitPath" ] && [ "$(readlink -f "$installedUnitPath")" = "$unitPath" ]; then
    return
  fi
  rm -rf "$installedUnitPath"
  systemctl --user link "$unitPath"
  installMessage "linked $unitName"
}

disableStaleUnit() {
  local unitName="$1"
  local disableFailed=0
  systemctl --user stop "$unitName" || disableFailed=1
  systemctl --user disable "$unitName" || disableFailed=1
  if [ "$disableFailed" -eq 1 ]; then
    installMessage "could not fully disable $unitName"
    return
  fi
  installMessage "disabled $unitName"
}

removeStaleUnit() {
  local installedUnitPath="$1"
  local unitName
  unitName="$(basename "$installedUnitPath")"
  disableStaleUnit "$unitName"
  rm -rf "$installedUnitPath"
  installMessage "removed $unitName"
}

mkdir -p "$userUnitDirectory"
mapfile -t unitPaths < <(find "$systemdDirectory" -maxdepth 1 -type f \( -name '*.service' -o -name '*.timer' \) -print | LC_ALL=C sort)
for unitPath in "${unitPaths[@]}"; do
  if ! shouldInstallUnit "$(basename "$unitPath")"; then
    continue
  fi
  linkUnit "$unitPath"
done

shopt -s nullglob
for installedUnitPath in "$userUnitDirectory"/glissa*.service "$userUnitDirectory"/glissa*.timer "$userUnitDirectory"/assistant*.service "$userUnitDirectory"/assistant*.timer; do
  unitName="$(basename "$installedUnitPath")"
  if [ -f "$systemdDirectory/$unitName" ] && shouldInstallUnit "$unitName"; then
    continue
  fi
  removeStaleUnit "$installedUnitPath"
done

systemctl --user daemon-reload
installMessage "reloaded user systemd"
for unitPath in "${unitPaths[@]}"; do
  unitName="$(basename "$unitPath")"
  if [[ "$unitName" != *.timer ]]; then
    continue
  fi
  if ! shouldInstallUnit "$unitName"; then
    continue
  fi
  systemctl --user enable --now "$unitName"
  installMessage "enabled $unitName"
  # A timer left running across a unit rename stalls on its next tick with no next elapse.
  systemctl --user restart "$unitName"
  installMessage "restarted $unitName"
done
for serviceName in glissa.service glissa-results.service; do
  systemctl --user enable "$serviceName"
  installMessage "enabled $serviceName"
  systemctl --user restart "$serviceName"
  installMessage "restarted $serviceName"
done
