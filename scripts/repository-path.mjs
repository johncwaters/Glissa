import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

export function resolveRepositoryPath(...pathSegments) {
  return resolve(repositoryRoot, ...pathSegments)
}

function isLegacyCheckoutHoldingLiveData() {
  return existsSync(resolveRepositoryPath('memory'))
}

export function resolveGlissaDataDirectory(environment = process.env) {
  if (environment.GLISSA_DATA_DIR) return resolve(environment.GLISSA_DATA_DIR)
  if (isLegacyCheckoutHoldingLiveData()) return resolveRepositoryPath()
  return join(environment.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'glissa')
}

export function resolveDataPath(environment, ...pathSegments) {
  return resolve(resolveGlissaDataDirectory(environment), ...pathSegments)
}
