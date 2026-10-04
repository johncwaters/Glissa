#!/usr/bin/env bash
set -euo pipefail

installScriptDirectory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repositoryRoot="$(cd "$installScriptDirectory/.." && pwd)"
liveCheckoutRoot="$HOME/Projects/assistant"
systemdDirectory="$repositoryRoot/systemd"
configurationHome="${XDG_CONFIG_HOME:-$HOME/.config}"
userUnitDirectory="$configurationHome/systemd/user"

installMessage() {
  echo "install: $1"
}

if [ "$(readlink -f "$repositoryRoot")" != "$(readlink -f "$liveCheckoutRoot")" ]; then
  echo "install: refusing to link units from $repositoryRoot; run this from $liveCheckoutRoot" >&2
  exit 1
fi

warnAboutMissingLocalEnvironmentKeys() {
  local localEnvironmentPath="$HOME/.config/assistant/local.env"
  local requiredLocalEnvironmentKeys=(ASSISTANT_RESULT_HOST ASSISTANT_RESULT_LOGIN ASSISTANT_RESULT_SELF_ADDRESSES ASSISTANT_HOME_TIME_ZONE)
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
  linkUnit "$unitPath"
done

shopt -s nullglob
for installedUnitPath in "$userUnitDirectory"/assistant*.service "$userUnitDirectory"/assistant*.timer; do
  unitName="$(basename "$installedUnitPath")"
  if [ -f "$systemdDirectory/$unitName" ]; then
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
  systemctl --user enable --now "$unitName"
  installMessage "enabled $unitName"
  # A timer left running across a unit rename stalls on its next tick with no next elapse.
  systemctl --user restart "$unitName"
  installMessage "restarted $unitName"
done
for serviceName in assistant.service assistant-results.service; do
  systemctl --user enable "$serviceName"
  installMessage "enabled $serviceName"
  systemctl --user restart "$serviceName"
  installMessage "restarted $serviceName"
done
