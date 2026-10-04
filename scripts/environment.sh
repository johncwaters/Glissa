loadEnvironmentFile() {
  local environmentFileToLoad="$1"
  shift
  set -a
  source "$environmentFileToLoad"
  set +a
}
