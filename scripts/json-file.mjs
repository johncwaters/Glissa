import { readFileSync } from 'node:fs'
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const lockRetryIntervalMs = 50
const lockTimeoutMs = 5_000
const staleLockAgeMs = 30_000

async function removeLockFile(lockFilePath) {
  try {
    await unlink(lockFilePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function removeLockFileWhenStale(lockFilePath) {
  try {
    const lockFileStats = await stat(lockFilePath)
    if (Date.now() - lockFileStats.mtimeMs < staleLockAgeMs) return
    await removeLockFile(lockFilePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function acquireFileLock(lockFilePath, lockedFilePath) {
  const giveUpAt = Date.now() + lockTimeoutMs
  while (true) {
    try {
      const lockFileHandle = await open(lockFilePath, 'wx')
      await lockFileHandle.close()
      return
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      await removeLockFileWhenStale(lockFilePath)
      if (Date.now() >= giveUpAt) throw new Error(`File is locked by another process: ${lockedFilePath}`)
      await delay(lockRetryIntervalMs)
    }
  }
}

export async function withJsonFileLock(jsonFilePath, runInsideLock) {
  const lockFilePath = `${jsonFilePath}.lock`
  await acquireFileLock(lockFilePath, jsonFilePath)
  try {
    return await runInsideLock()
  } finally {
    await removeLockFile(lockFilePath)
  }
}

export async function readJsonFile(jsonFilePath) {
  return JSON.parse(await readFile(jsonFilePath, 'utf8'))
}

export function readJsonFileSync(jsonFilePath) {
  return JSON.parse(readFileSync(jsonFilePath, 'utf8'))
}

export async function writeJsonFileAtomically(jsonFilePath, contents) {
  const temporaryFilePath = `${jsonFilePath}.${process.pid}.tmp`
  await writeFile(temporaryFilePath, `${JSON.stringify(contents, null, 2)}\n`)
  await rename(temporaryFilePath, jsonFilePath)
}
