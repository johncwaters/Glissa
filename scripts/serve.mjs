import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createConnection, createServer } from 'node:net'
import { resolveAssistantStateDirectory } from './assistant-state-directory.mjs'
import { isMainModule, runCommandLine } from './command-line.mjs'
import { readJsonFile, writeJsonFileAtomically } from './json-file.mjs'
import { logEvent } from './log.mjs'
import { resolveRepositoryPath } from './repository-path.mjs'

export const acceptedDispatchAnswer = 'accepted'
export const queuedDispatchAnswer = 'queued'
export const rejectedDispatchAnswerPrefix = 'rejected '

const telegramPluginSource = 'telegram@claude-plugins-official'
const telegramPluginName = 'telegram'
const telegramServerName = 'plugin:telegram:telegram'
const socketProbeTimeoutMs = 500
const promptsByMode = {
  morning: '/daily-brief morning ',
  evening: '/daily-brief evening ',
  tasks: '/tasks due ',
  watch: '/mail-watch ',
}

function isProcessAlive(processId) {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function readParentProcessId(processId) {
  const processStat = await readFile(`/proc/${processId}/stat`, 'utf8')
  const commandEndIndex = processStat.lastIndexOf(')')
  if (commandEndIndex === -1) return null
  const processFields = processStat.slice(commandEndIndex + 1).trim().split(/\s+/)
  const parentProcessId = Number(processFields[1])
  if (!Number.isInteger(parentProcessId) || parentProcessId < 1) return null
  return parentProcessId
}

async function isTelegramPollerAlive({ channelDirectory, childPid }) {
  try {
    const pollerPidText = (await readFile(join(channelDirectory, 'bot.pid'), 'utf8')).trim()
    if (!/^\d+$/.test(pollerPidText)) return false
    const pollerPid = Number(pollerPidText)
    if (!isProcessAlive(pollerPid)) return false
    const pollerCommandLine = await readFile(`/proc/${pollerPid}/cmdline`, 'utf8')
    if (!pollerCommandLine.includes('server.ts')) return false

    const visitedProcessIds = new Set()
    let processId = pollerPid
    while (processId > 1 && !visitedProcessIds.has(processId)) {
      if (processId === childPid) return true
      visitedProcessIds.add(processId)
      processId = await readParentProcessId(processId)
      if (processId === null) return false
    }
    return false
  } catch {
    return false
  }
}

function parsePositiveSeconds(value, variableName) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`${variableName} must be a positive number`)
  return seconds
}

export function resolveAssistantDirectories(environment) {
  const runtimeBase = environment.XDG_RUNTIME_DIR
  return {
    stateDirectory: resolveAssistantStateDirectory(environment),
    runtimeDirectory: environment.ASSISTANT_RUNTIME_DIR || (runtimeBase ? join(runtimeBase, 'assistant') : null),
    channelDirectory: environment.ASSISTANT_TELEGRAM_CHANNEL_DIR || join(homedir(), '.claude', 'channels', 'telegram'),
  }
}

export function resolveDispatchSocketPath(runtimeDirectory) {
  return join(runtimeDirectory, 'dispatch.sock')
}

export function resolveServeStateFilePath(stateDirectory) {
  return join(stateDirectory, 'serve-state.json')
}

export function buildClaudeArguments(repositoryRoot) {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--replay-user-messages',
    '--model', 'opus',
    '--fallback-model', 'sonnet',
    '--channels', `plugin:${telegramPluginSource}`,
    '--setting-sources', 'project',
    '--settings', join(repositoryRoot, 'systemd', 'assistant-settings.json'),
  ]
}

export async function isSocketAnswering(socketPath) {
  return new Promise((resolve) => {
    const probeConnection = createConnection(socketPath)
    const settle = (isAnswering) => {
      probeConnection.destroy()
      resolve(isAnswering)
    }
    probeConnection.setTimeout(socketProbeTimeoutMs, () => settle(false))
    probeConnection.once('connect', () => settle(true))
    probeConnection.once('error', () => settle(false))
  })
}

async function isDirectoryOwnedByThisUser(directoryPath) {
  const directoryStatus = await lstat(directoryPath)
  return directoryStatus.isDirectory() && directoryStatus.uid === process.getuid()
}

async function removeSocket(socketPath) {
  try {
    const socketStatus = await lstat(socketPath)
    if (!socketStatus.isSocket()) throw new Error('socket path is not a socket')
    await unlink(socketPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export async function readServeState(stateFilePath) {
  try {
    const savedState = await readJsonFile(stateFilePath)
    const lastDispatchAt = savedState?.lastDispatchAt && typeof savedState.lastDispatchAt === 'object'
      ? savedState.lastDispatchAt
      : {}
    const lastReplyAt = savedState?.lastReplyAt && typeof savedState.lastReplyAt === 'object'
      ? savedState.lastReplyAt
      : {}
    return { lastDispatchAt, lastReplyAt }
  } catch (error) {
    if (error?.code === 'ENOENT') return { lastDispatchAt: {}, lastReplyAt: {} }
    throw error
  }
}

function listErrorEntries(errors) {
  if (Array.isArray(errors)) return errors
  if (errors && typeof errors === 'object') return Object.keys(errors)
  return []
}

function listErrorEntryNames(errorEntry) {
  if (typeof errorEntry === 'string') return [errorEntry]
  if (!errorEntry || typeof errorEntry !== 'object') return []
  return ['name', 'source', 'plugin', 'server']
    .map((fieldName) => errorEntry[fieldName])
    .filter((fieldValue) => typeof fieldValue === 'string')
}

function hasErrorNamed(errors, names) {
  return listErrorEntries(errors).some((errorEntry) => listErrorEntryNames(errorEntry).some((name) => names.includes(name)))
}

function getTelegramInitStatus(event) {
  const hasTelegramPlugin = Array.isArray(event.plugins)
    && event.plugins.some((plugin) => plugin?.source === telegramPluginSource)
  const hasTelegramPluginError = hasErrorNamed(event.plugin_errors, [telegramPluginSource, telegramPluginName])
  const telegramServer = Array.isArray(event.mcp_servers)
    ? event.mcp_servers.find((server) => server?.name === telegramServerName)
    : undefined
  const hasTelegramServerError = hasErrorNamed(event.mcp_server_errors, [telegramServerName, telegramPluginSource])
  return {
    pluginsOk: hasTelegramPlugin && !hasTelegramPluginError,
    mcpOk: telegramServer?.status === 'connected' && !hasTelegramServerError,
  }
}

function createDispatchMessage(mode) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: promptsByMode[mode] } })}\n`
}

// --replay-user-messages may echo the expanded skill text, so a turn start is told from a tool result alone.
function isTurnStartUserEvent(event) {
  const messageContent = event.message?.content
  if (typeof messageContent === 'string') return true
  if (!Array.isArray(messageContent)) return false
  return !messageContent.some((block) => block?.type === 'tool_result')
}

async function runServe(commandArguments, { environment = process.env } = {}) {
  if (commandArguments.length > 0) throw new Error('serve.mjs takes no arguments')

  const repositoryRoot = resolveRepositoryPath()
  const { stateDirectory, runtimeDirectory, channelDirectory } = resolveAssistantDirectories(environment)
  const stateFilePath = resolveServeStateFilePath(stateDirectory)
  const pollerCheckSeconds = parsePositiveSeconds(environment.ASSISTANT_POLLER_CHECK_SECONDS || '30', 'ASSISTANT_POLLER_CHECK_SECONDS')
  const pollerGraceSeconds = parsePositiveSeconds(environment.ASSISTANT_POLLER_GRACE_SECONDS || '60', 'ASSISTANT_POLLER_GRACE_SECONDS')
  const childKillSeconds = parsePositiveSeconds(environment.ASSISTANT_CHILD_KILL_SECONDS || '5', 'ASSISTANT_CHILD_KILL_SECONDS')
  const idleWaitSeconds = parsePositiveSeconds(environment.ASSISTANT_IDLE_WAIT_SECONDS || '600', 'ASSISTANT_IDLE_WAIT_SECONDS')
  const claudeCommand = environment.ASSISTANT_CLAUDE_COMMAND || 'claude'
  const launchedAtMs = Date.now()

  function failStartup(reason) {
    logEvent('serve', 'launch')
    logEvent('serve', 'exit', { exit_code: 1, ran_for_seconds: 0, reason })
    return 1
  }

  if (!runtimeDirectory) return failStartup('no runtime directory')
  const socketPath = resolveDispatchSocketPath(runtimeDirectory)

  await mkdir(stateDirectory, { recursive: true })
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  if (!await isDirectoryOwnedByThisUser(runtimeDirectory).catch(() => false)) return failStartup('runtime directory unsafe')
  // Linux sun_path permits 107 path bytes plus its terminating NUL.
  if (Buffer.byteLength(socketPath) >= 108) return failStartup('socket path too long')
  if (await isSocketAnswering(socketPath)) return failStartup('dispatch socket already in use')
  try {
    await removeSocket(socketPath)
  } catch {
    return failStartup('socket path unavailable')
  }
  const serveState = await readServeState(stateFilePath)
  const openConnections = new Set()
  const dispatchedModesAwaitingStart = []
  let modeInFlight = null
  let isPollerReady = false
  let lastLoggedInitStatus = null
  let requestedExitCode = null
  let requestedExitReason = null
  let isStopping = false
  let isTurnOpen = false
  let hasFinished = false
  let stateWritePromise = Promise.resolve()
  let pollerCheckTimer
  let pollerGraceTimer
  let childKillTimer
  let idleWaitTimer
  let finishRun
  const runFinished = new Promise((resolve) => { finishRun = resolve })
  let markChildClosed
  const childClosed = new Promise((resolve) => { markChildClosed = resolve })

  const server = createServer()
  let child

  function queueStateWrite() {
    const stateSnapshot = {
      lastDispatchAt: { ...serveState.lastDispatchAt },
      lastReplyAt: { ...serveState.lastReplyAt },
    }
    stateWritePromise = stateWritePromise
      .catch(() => undefined)
      .then(() => writeJsonFileAtomically(stateFilePath, stateSnapshot))
    stateWritePromise.catch(() => requestExit(1, 'state write failed'))
  }

  async function finish(exitCode) {
    if (hasFinished) return
    hasFinished = true
    clearInterval(pollerCheckTimer)
    clearTimeout(pollerGraceTimer)
    for (const connection of openConnections) connection.destroy()
    await childClosed
    clearTimeout(childKillTimer)
    await stateWritePromise.catch(() => undefined)
    await removeSocket(socketPath).catch(() => undefined)
    const ranForSeconds = Math.max(0, Math.floor((Date.now() - launchedAtMs) / 1_000))
    const exitFields = { exit_code: exitCode, ran_for_seconds: ranForSeconds }
    if (requestedExitReason !== null) exitFields.reason = requestedExitReason
    logEvent('serve', 'exit', exitFields)
    finishRun(exitCode)
  }

  function requestExit(exitCode, reason = null) {
    if (requestedExitCode !== null) return
    requestedExitCode = exitCode
    requestedExitReason = reason
    clearTimeout(idleWaitTimer)
    if (child && !child.killed) {
      child.kill('SIGTERM')
      childKillTimer = setTimeout(() => child.kill('SIGKILL'), childKillSeconds * 1_000)
    }
    for (const connection of openConnections) connection.destroy()
    if (!server.listening) {
      finish(exitCode)
      return
    }
    server.close(() => finish(exitCode))
  }

  function finishStoppingWhenIdle() {
    if (!isStopping || requestedExitCode !== null) return
    if (isTurnOpen || modeInFlight !== null || dispatchedModesAwaitingStart.length > 0) return
    requestExit(0)
  }

  function terminate() {
    if (isStopping || requestedExitCode !== null) return
    isStopping = true
    for (const connection of openConnections) connection.destroy()
    if (server.listening) server.close()
    idleWaitTimer = setTimeout(() => requestExit(0), idleWaitSeconds * 1_000)
    finishStoppingWhenIdle()
  }
  process.once('SIGTERM', terminate)

  logEvent('serve', 'launch')
  child = spawn(claudeCommand, buildClaudeArguments(repositoryRoot), {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['pipe', 'pipe', 'inherit'],
  })

  function writeModeToChild(mode) {
    if (!child.stdin.writable) {
      requestExit(1, 'child input unavailable')
      return
    }
    dispatchedModesAwaitingStart.push(mode)
    serveState.lastDispatchAt[mode] = new Date().toISOString()
    queueStateWrite()
    try {
      child.stdin.write(createDispatchMessage(mode))
    } catch {
      requestExit(1, 'child input failed')
    }
  }

  function acceptDispatchToken(mode) {
    if (isStopping) return `${rejectedDispatchAnswerPrefix}stopping`
    if (!Object.hasOwn(promptsByMode, mode)) {
      logEvent('serve', 'dispatch_rejected', { reason: 'unknown mode' })
      return `${rejectedDispatchAnswerPrefix}unknown mode`
    }
    if (modeInFlight === mode || dispatchedModesAwaitingStart.includes(mode)) {
      logEvent('serve', 'dispatch_rejected', { reason: 'mode already queued' })
      return `${rejectedDispatchAnswerPrefix}mode already queued`
    }
    const hasEarlierTurnOutstanding = modeInFlight !== null || dispatchedModesAwaitingStart.length > 0
    logEvent('serve', 'dispatch', { mode, queued: hasEarlierTurnOutstanding })
    // The child queues stdin messages itself, so every accepted mode is written straight through.
    writeModeToChild(mode)
    if (hasEarlierTurnOutstanding) return queuedDispatchAnswer
    return acceptedDispatchAnswer
  }

  function handleChildEvent(line) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (event.type === 'system' && event.subtype === 'init') {
      const { pluginsOk, mcpOk } = getTelegramInitStatus(event)
      const initStatus = `${pluginsOk}:${mcpOk}`
      if (lastLoggedInitStatus !== initStatus) logEvent('serve', 'init', { plugins_ok: pluginsOk, mcp_ok: mcpOk })
      lastLoggedInitStatus = initStatus
      if (!pluginsOk || !mcpOk) requestExit(1)
      return
    }
    if (event.type === 'user') {
      if (!isTurnStartUserEvent(event)) return
      isTurnOpen = true
      if (dispatchedModesAwaitingStart.length === 0) return
      modeInFlight = dispatchedModesAwaitingStart.shift()
      return
    }
    if (event.type === 'assistant' && Array.isArray(event.message?.content) && modeInFlight !== null) {
      const hasTelegramReply = event.message.content.some((block) => block?.type === 'tool_use' && block.name === 'mcp__plugin_telegram_telegram__reply')
      if (hasTelegramReply) {
        serveState.lastReplyAt[modeInFlight] = new Date().toISOString()
        queueStateWrite()
      }
    }
    if (event.type !== 'result') return
    isTurnOpen = false
    if (modeInFlight === null) {
      dispatchedModesAwaitingStart.shift()
      finishStoppingWhenIdle()
      return
    }
    modeInFlight = null
    finishStoppingWhenIdle()
  }

  server.on('connection', (connection) => {
    openConnections.add(connection)
    connection.setEncoding('utf8')
    let tokenText = ''
    let hasHandledToken = false
    connection.on('data', (chunk) => {
      if (hasHandledToken) return
      tokenText += chunk
      const newlineIndex = tokenText.indexOf('\n')
      if (newlineIndex === -1 && tokenText.length <= 128) return
      hasHandledToken = true
      if (newlineIndex === -1) {
        logEvent('serve', 'dispatch_rejected', { reason: 'token line too long' })
        connection.end(`${rejectedDispatchAnswerPrefix}token line too long\n`)
        return
      }
      const dispatchAnswer = acceptDispatchToken(tokenText.slice(0, newlineIndex).replace(/\r$/, ''))
      connection.end(`${dispatchAnswer}\n`)
    })
    connection.on('close', () => openConnections.delete(connection))
  })

  server.on('error', () => requestExit(1, 'socket server error'))
  child.on('error', () => requestExit(1, 'child process error'))
  child.stdin.on('error', () => requestExit(1, 'child input error'))
  child.on('close', (exitCode) => {
    markChildClosed()
    if (requestedExitCode !== null) {
      finish(requestedExitCode)
      return
    }
    if (isStopping) {
      requestExit(0)
      return
    }
    const supervisorExitCode = Number.isInteger(exitCode) && exitCode !== 0 ? exitCode : 1
    requestExit(supervisorExitCode, 'child process closed')
  })

  const childOutputLines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  childOutputLines.on('line', handleChildEvent)

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
  } catch {
    requestExit(1, 'socket bind failed')
    const exitCode = await runFinished
    process.removeListener('SIGTERM', terminate)
    return exitCode
  }
  try {
    await chmod(socketPath, 0o600)
  } catch {
    requestExit(1, 'socket chmod failed')
    const exitCode = await runFinished
    process.removeListener('SIGTERM', terminate)
    return exitCode
  }
  if (requestedExitCode !== null) {
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await removeSocket(socketPath).catch(() => undefined)
    process.removeListener('SIGTERM', terminate)
    return runFinished
  }

  async function checkPoller() {
    if (requestedExitCode !== null) return
    const isAlive = await isTelegramPollerAlive({ channelDirectory, childPid: child.pid })
    if (isAlive) {
      if (!isPollerReady) logEvent('serve', 'poller_ready')
      isPollerReady = true
      return
    }
    if (Date.now() - launchedAtMs < pollerGraceSeconds * 1_000) return
    logEvent('serve', 'poller_lost', { reason: isPollerReady ? 'poller process missing' : 'startup grace expired' })
    requestExit(1)
  }

  pollerCheckTimer = setInterval(checkPoller, pollerCheckSeconds * 1_000)
  pollerGraceTimer = setTimeout(checkPoller, pollerGraceSeconds * 1_000)
  checkPoller()

  const exitCode = await runFinished
  process.removeListener('SIGTERM', terminate)
  return exitCode
}

if (isMainModule(import.meta.url)) runCommandLine(runServe).then(() => process.exit(process.exitCode ?? 0))
