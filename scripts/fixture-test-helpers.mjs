import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

export function createTemporaryDirectory(prefix) {
  const temporaryDirectoryPath = mkdtempSync(join(tmpdir(), prefix))
  return { temporaryDirectoryPath, removeTemporaryDirectory: () => rmSync(temporaryDirectoryPath, { recursive: true, force: true }) }
}

export function createTemporaryDirectoryRemovedAfterTest(prefix) {
  const { temporaryDirectoryPath, removeTemporaryDirectory } = createTemporaryDirectory(prefix)
  after(removeTemporaryDirectory)
  return temporaryDirectoryPath
}

export async function withTemporaryDirectory(prefix, testFunction) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), prefix))
  try {
    await testFunction(temporaryDirectory)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

export function createLogFilePath(prefix) {
  return join(createTemporaryDirectoryRemovedAfterTest(prefix), 'assistant.jsonl')
}

function assignEnvironment(environment) {
  for (const [name, value] of Object.entries(environment)) {
    delete process.env[name]
    if (value !== undefined) process.env[name] = value
  }
}

export function setTestEnvironment(overrides) {
  const savedEnvironment = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]))
  assignEnvironment(overrides)
  return () => assignEnvironment(savedEnvironment)
}

export function withTestEnvironment(overrides, testFunction) {
  const restoreEnvironment = setTestEnvironment(overrides)
  try {
    return testFunction()
  } finally {
    restoreEnvironment()
  }
}
