import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { addUsageExitCode } from './command-line.mjs'
import { withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { readJsonFile } from './json-file.mjs'
import { executeTestCommand } from './process-test-helpers.mjs'
import { runWatchCommand, watchStateFailureExitCode } from './watch.mjs'

const now = new Date('2026-09-10T12:00:00.000Z')
const scriptPath = new URL('./watch.mjs', import.meta.url)

async function withTemporaryWatchState(testFunction) {
  return withTemporaryDirectory('assistant-watch-', async (temporaryDirectory) => {
    const watchStateFilePath = join(temporaryDirectory, 'context', 'watch-state.json')
    await testFunction(watchStateFilePath)
  })
}

async function runWatch(watchStateFilePath, commandArguments, standardInputText = '') {
  const outputLines = []
  const errorLines = []
  const exitCode = await runWatchCommand(commandArguments, {
    watchStateFilePath,
    now,
    writeOutput: (line) => outputLines.push(line),
    writeError: (line) => errorLines.push(line),
    readStandardInput: async () => standardInputText,
  })
  return { outputLines, errorLines, exitCode }
}

async function runWatchCliWithStandardInput(watchStateFilePath, standardInputText, ...commandArguments) {
  return executeTestCommand(process.execPath, [scriptPath.pathname, ...commandArguments], {
    env: { ...process.env, ASSISTANT_WATCH_STATE_FILE: watchStateFilePath },
  }, standardInputText)
}

test('treats a missing state file as empty and seeds accounts one day back', async () => {
  await withTemporaryWatchState(async (watchStateFilePath) => {
    const emptyCursor = await runWatch(watchStateFilePath, ['cursor', '--json'])
    assert.equal(emptyCursor.exitCode, 0)
    assert.deepEqual(JSON.parse(emptyCursor.outputLines[0]), { accounts: {} })
    const seededCursor = await runWatch(watchStateFilePath, ['cursor', '--json', '--seed', 'first@example.com'])
    assert.deepEqual(JSON.parse(seededCursor.outputLines[0]), { accounts: { 'first@example.com': { after: Math.floor((now.getTime() - 86_400_000) / 1_000) } } })
  })
})

test('advance changes only the named account', async () => {
  await withTemporaryWatchState(async (watchStateFilePath) => {
    await runWatch(watchStateFilePath, ['cursor', '--json', '--seed', 'first@example.com', '--seed', 'second@example.com'])
    const advanceResult = await runWatch(watchStateFilePath, ['advance', '--stdin'], JSON.stringify({ account: 'first@example.com', checkedAt: '2026-09-10T11:00:00.000Z' }))
    assert.equal(advanceResult.exitCode, 0)
    const watchState = await readJsonFile(watchStateFilePath)
    assert.equal(watchState.accounts['first@example.com'].checkedAt, '2026-09-10T11:00:00.000Z')
    assert.equal(watchState.accounts['second@example.com'].checkedAt, '2026-09-09T12:00:00.000Z')
  })
})

test('advance rejects an invalid timestamp and missing account as usage errors', async () => {
  await withTemporaryWatchState(async (watchStateFilePath) => {
    const badTimestamp = await runWatch(watchStateFilePath, ['advance', '--stdin'], JSON.stringify({ account: 'first@example.com', checkedAt: 'not-a-date' }))
    const missingAccount = await runWatch(watchStateFilePath, ['advance', '--stdin'], JSON.stringify({ checkedAt: '2026-09-10T11:00:00.000Z' }))
    assert.equal(badTimestamp.exitCode, addUsageExitCode)
    assert.equal(missingAccount.exitCode, addUsageExitCode)
  })
})

test('rejects positional ids, a missing --json, and unknown commands as usage errors', async () => {
  await withTemporaryWatchState(async (watchStateFilePath) => {
    const positionalAdvance = await runWatch(watchStateFilePath, ['advance', 'first@example.com', '2026-09-10T11:00:00.000Z'])
    const cursorWithoutJson = await runWatch(watchStateFilePath, ['cursor'])
    const unknownCommand = await runWatch(watchStateFilePath, ['sweep'])
    const removedPingedCommand = await runWatch(watchStateFilePath, ['pinged', '--stdin'], JSON.stringify({ threadId: 'thread-1' }))
    assert.deepEqual([positionalAdvance.exitCode, cursorWithoutJson.exitCode, unknownCommand.exitCode, removedPingedCommand.exitCode], Array(4).fill(addUsageExitCode))
    await assert.rejects(() => readFile(watchStateFilePath, 'utf8'))
  })
})

test('rewrites a legacy pinged state without its pinged key', async () => {
  await withTemporaryWatchState(async (watchStateFilePath) => {
    await mkdir(join(watchStateFilePath, '..'), { recursive: true })
    await writeFile(watchStateFilePath, JSON.stringify({
      accounts: { 'first@example.com': { checkedAt: '2026-09-10T00:00:00.000Z' } },
      pinged: { 'thread-1': '2026-09-10T00:00:00.000Z' },
    }))
    const advanceResult = await runWatch(watchStateFilePath, ['advance', '--stdin'], JSON.stringify({ account: 'first@example.com', checkedAt: '2026-09-10T11:00:00.000Z' }))
    assert.equal(advanceResult.exitCode, 0)
    assert.deepEqual(await readJsonFile(watchStateFilePath), {
      accounts: { 'first@example.com': { checkedAt: '2026-09-10T11:00:00.000Z' } },
    })
  })
})

test('reports unreadable state without changing it', async () => {
  await withTemporaryWatchState(async (watchStateFilePath) => {
    await mkdir(join(watchStateFilePath, '..'), { recursive: true })
    await writeFile(watchStateFilePath, '{')
    const unreadableResult = await runWatch(watchStateFilePath, ['cursor', '--json'])
    assert.equal(unreadableResult.exitCode, watchStateFailureExitCode)
    assert.equal(unreadableResult.errorLines.length, 1)
    assert.equal(await readFile(watchStateFilePath, 'utf8'), '{')
  })
})

test('writes state atomically and leaves no temporary file', async () => {
  await withTemporaryWatchState(async (watchStateFilePath) => {
    await runWatch(watchStateFilePath, ['advance', '--stdin'], JSON.stringify({ account: 'first@example.com', checkedAt: '2026-09-10T11:00:00.000Z' }))
    assert.equal((await readdir(join(watchStateFilePath, '..'))).some((fileName) => fileName.endsWith('.tmp')), false)
    assert.equal((await readJsonFile(watchStateFilePath)).accounts['first@example.com'].checkedAt, '2026-09-10T11:00:00.000Z')
  })
})

test('prints cursor JSON with unix-second after values', async () => {
  await withTemporaryWatchState(async (watchStateFilePath) => {
    await runWatch(watchStateFilePath, ['advance', '--stdin'], JSON.stringify({ account: 'first@example.com', checkedAt: '2026-09-10T11:00:00.000Z' }))
    const cursorResult = await runWatch(watchStateFilePath, ['cursor', '--json'])
    assert.deepEqual(JSON.parse(cursorResult.outputLines[0]), { accounts: { 'first@example.com': { after: Math.floor(new Date('2026-09-10T11:00:00.000Z').getTime() / 1_000) } } })
  })
})

test('uses the environment state-file override from the command line', async () => {
  await withTemporaryWatchState(async (watchStateFilePath) => {
    const commandResult = await runWatchCliWithStandardInput(watchStateFilePath, JSON.stringify({ account: 'first@example.com', checkedAt: '2026-09-10T11:00:00.000Z' }), 'advance', '--stdin')
    assert.equal(commandResult.stderr, '')
    assert.equal((await readJsonFile(watchStateFilePath)).accounts['first@example.com'].checkedAt, '2026-09-10T11:00:00.000Z')
  })
})
