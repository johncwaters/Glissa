import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { addUsageExitCode, isMainModule, readProcessStandardInput, runCommandLine } from './command-line.mjs'
import { readJsonFile, withJsonFileLock, writeJsonFileAtomically } from './json-file.mjs'
import { isPlainObject } from './object-fields.mjs'
import { resolveRepositoryPath } from './repository-path.mjs'

export const watchStateFailureExitCode = 255

const seedWindowMs = 86_400_000

class WatchUsageError extends Error {}

class WatchStateError extends Error {}

export function getWatchStateFilePath(environment = process.env) {
  return environment.GLISSA_WATCH_STATE_FILE || resolveRepositoryPath('context/watch-state.json')
}

function isValidIsoTimestamp(timestamp) {
  if (typeof timestamp !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp)) return false
  return !Number.isNaN(new Date(timestamp).getTime())
}

function validateWatchState(watchState) {
  if (!isPlainObject(watchState) || !isPlainObject(watchState.accounts)) throw new WatchStateError('Watch state is invalid')
  for (const accountState of Object.values(watchState.accounts)) {
    if (!isPlainObject(accountState) || !isValidIsoTimestamp(accountState.checkedAt)) throw new WatchStateError('Watch state is invalid')
  }
  return { accounts: watchState.accounts }
}

export async function readWatchState(watchStateFilePath) {
  try {
    return validateWatchState(await readJsonFile(watchStateFilePath))
  } catch (error) {
    if (error?.code === 'ENOENT') return { accounts: {} }
    if (error instanceof WatchStateError) throw error
    throw new WatchStateError('Watch state cannot be read')
  }
}

async function withWatchStateLock(watchStateFilePath, runInsideLock) {
  await mkdir(dirname(watchStateFilePath), { recursive: true })
  return withJsonFileLock(watchStateFilePath, runInsideLock)
}

function parseCursorArguments(argumentsToParse) {
  const seedAccounts = []
  for (let argumentIndex = 0; argumentIndex < argumentsToParse.length; argumentIndex += 1) {
    const argument = argumentsToParse[argumentIndex]
    if (argument === '--json') continue
    if (argument !== '--seed') throw new WatchUsageError('Invalid command options')
    const account = argumentsToParse[argumentIndex + 1]
    if (!account || account.startsWith('--')) throw new WatchUsageError('--seed requires an account')
    seedAccounts.push(account)
    argumentIndex += 1
  }
  if (argumentsToParse.filter((argument) => argument === '--json').length !== 1) throw new WatchUsageError('cursor requires --json')
  return seedAccounts
}

function parseStandardInputArguments(argumentsToParse, command) {
  if (argumentsToParse.length === 1 && argumentsToParse[0] === '--stdin') return
  throw new WatchUsageError(`usage: watch.mjs ${command} --stdin < input.json`)
}

async function readStandardInputObject(readStandardInput) {
  let input
  try {
    input = JSON.parse(await readStandardInput())
  } catch {
    throw new WatchUsageError('Invalid watch input JSON')
  }
  if (!isPlainObject(input)) throw new WatchUsageError('Watch input must be a JSON object')
  return input
}

function formatCursorOutput(watchState) {
  const accounts = Object.fromEntries(Object.entries(watchState.accounts).map(([account, accountState]) => [account, {
    after: Math.floor(new Date(accountState.checkedAt).getTime() / 1_000),
  }]))
  return JSON.stringify({ accounts })
}

async function showCursor(argumentsToParse, watchStateFilePath, now, writeOutput) {
  const seedAccounts = parseCursorArguments(argumentsToParse)
  if (seedAccounts.length === 0) {
    writeOutput(formatCursorOutput(await readWatchState(watchStateFilePath)))
    return 0
  }
  return withWatchStateLock(watchStateFilePath, async () => {
    const watchState = await readWatchState(watchStateFilePath)
    const seedCheckedAt = new Date(now.getTime() - seedWindowMs).toISOString()
    seedAccounts.forEach((account) => {
      if (!Object.hasOwn(watchState.accounts, account)) watchState.accounts[account] = { checkedAt: seedCheckedAt }
    })
    await writeJsonFileAtomically(watchStateFilePath, watchState)
    writeOutput(formatCursorOutput(watchState))
    return 0
  })
}

function readAdvanceInput(watchInput) {
  if (Object.keys(watchInput).length !== 2 || typeof watchInput.account !== 'string' || !watchInput.account || !isValidIsoTimestamp(watchInput.checkedAt)) throw new WatchUsageError('advance requires account and checkedAt')
  return watchInput
}

async function advanceCursor(argumentsToParse, watchStateFilePath, readStandardInput) {
  parseStandardInputArguments(argumentsToParse, 'advance')
  const { account, checkedAt } = readAdvanceInput(await readStandardInputObject(readStandardInput))
  return withWatchStateLock(watchStateFilePath, async () => {
    const watchState = await readWatchState(watchStateFilePath)
    watchState.accounts[account] = { checkedAt }
    await writeJsonFileAtomically(watchStateFilePath, watchState)
    return 0
  })
}

export async function runWatchCommand(commandArguments, { watchStateFilePath = getWatchStateFilePath(), now = new Date(), writeOutput = console.log, writeError = console.error, readStandardInput = readProcessStandardInput } = {}) {
  const [command, ...argumentsToParse] = commandArguments
  try {
    if (command === 'cursor') return await showCursor(argumentsToParse, watchStateFilePath, now, writeOutput)
    if (command === 'advance') return await advanceCursor(argumentsToParse, watchStateFilePath, readStandardInput)
    throw new WatchUsageError('Unknown command')
  } catch (error) {
    if (error instanceof WatchUsageError) {
      writeError(error.message)
      return addUsageExitCode
    }
    if (error instanceof WatchStateError) {
      writeError(error.message)
      return watchStateFailureExitCode
    }
    throw error
  }
}

if (isMainModule(import.meta.url)) runCommandLine(runWatchCommand)
