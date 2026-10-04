import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const addUsageExitCode = 2
export const nothingToDoExitCode = 5
export const unreadableStateExitCode = 255

export function parseFlags(argumentsToParse, allowedFlagNames) {
  const flags = new Set(argumentsToParse)
  if (flags.size !== argumentsToParse.length || [...flags].some((flag) => !allowedFlagNames.has(flag))) {
    throw new Error('Invalid command options')
  }
  return flags
}

export function isMainModule(moduleUrl) {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(moduleUrl)
}

export async function readProcessStandardInput() {
  const inputChunks = []
  for await (const inputChunk of process.stdin) inputChunks.push(inputChunk)
  return Buffer.concat(inputChunks).toString('utf8')
}

export async function runCommandLine(runCommand, { writeError = console.error, failureExitCode = 1 } = {}) {
  try {
    const exitCode = await runCommand(process.argv.slice(2))
    if (exitCode) process.exitCode = exitCode
  } catch (error) {
    writeError(error.message)
    process.exitCode = failureExitCode
  }
}
