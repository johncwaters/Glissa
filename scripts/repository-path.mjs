import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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
  return resolveInstalledDataDirectory(environment)
}

export function resolveInstalledDataDirectory(environment = process.env) {
  if (environment.GLISSA_DATA_DIR) return resolve(environment.GLISSA_DATA_DIR)
  return join(environment.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'glissa')
}

export async function canonicalDirectory(directoryPath) {
  const absolutePath = resolve(directoryPath)
  try {
    return await realpath(absolutePath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return join(await canonicalDirectory(dirname(absolutePath)), basename(absolutePath))
  }
}

export function resolveDataPath(environment, ...pathSegments) {
  return resolve(resolveGlissaDataDirectory(environment), ...pathSegments)
}
