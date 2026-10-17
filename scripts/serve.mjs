import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { createConnection, createServer } from 'node:net'
import { resolveGlissaStateDirectory } from './glissa-state-directory.mjs'
import { isMainModule, runCommandLine } from './command-line.mjs'
import { readJsonFile, writeJsonFileAtomically } from './json-file.mjs'
import { logEvent } from './log.mjs'
import { isModuleEnabled, readGlissaConfig, resolveGlissaConfigDirectory } from './glissa-config.mjs'
import { resolveGlissaDataDirectory, resolveRepositoryPath } from './repository-path.mjs'

export const acceptedDispatchAnswer = 'accepted'
export const queuedDispatchAnswer = 'queued'
export const rejectedDispatchAnswerPrefix = 'rejected '

const telegramPluginSource = 'telegram@claude-plugins-official'
const telegramPluginName = 'telegram'
const telegramServerName = 'plugin:telegram:telegram'
const socketProbeTimeoutMs = 500
const promptsByMode = {
  hello: 'First start: follow the First start rule.',
  morning: '/glissa:daily-brief morning ',
  evening: '/glissa:daily-brief evening ',
  tasks: '/glissa:tasks due ',
  watch: '/glissa:mail-watch ',
  changelog: '/glissa:content changelog ',
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

export function resolveGlissaDirectories(environment) {
  const runtimeBase = environment.XDG_RUNTIME_DIR
  return {
    stateDirectory: resolveGlissaStateDirectory(environment),
    runtimeDirectory: environment.GLISSA_RUNTIME_DIR || (runtimeBase ? join(runtimeBase, 'glissa') : null),
    channelDirectory: environment.GLISSA_TELEGRAM_CHANNEL_DIR || join(homedir(), '.claude', 'channels', 'telegram'),
  }
}

export function resolveDispatchSocketPath(runtimeDirectory) {
  return join(runtimeDirectory, 'dispatch.sock')
}

export function resolveServeStateFilePath(stateDirectory) {
  return join(stateDirectory, 'serve-state.json')
}

export function renderMcpServers(config, packageRoot) {
  const mcpServers = Object.fromEntries(config.accounts.map(({ alias }) => [
    `gog_${alias.replaceAll('-', '_')}`,
    { command: join(packageRoot, 'scripts', 'gog-mcp.sh'), args: [alias] },
  ]))
  mcpServers.browser = { command: join(packageRoot, 'scripts', 'browser-mcp.sh') }
  if (isModuleEnabled(config, 'content')) mcpServers.buffer = { command: join(packageRoot, 'scripts', 'buffer-mcp.sh') }
  return mcpServers
}

export function renderSystemPrompt({ config, runtimeText, personaText }) {
  const { name, pronouns, formOfAddress = name } = config.operator
  const identityLine = `The operator is ${name} (${pronouns}); address them as ${formOfAddress}.`
  const modules = (config.modules ?? []).map((moduleName) => {
    if (moduleName === 'changelog') {
      const { productName, productDescription, changelogFile, capturesDirectory } = config.changelog
      return `changelog (product ${productName}, ${productDescription}; changelog at ${changelogFile}${capturesDirectory ? `; captures in ${capturesDirectory}` : ''})`
    }
    if (moduleName === 'digest') {
      const { newsletterSender, workContext } = config.digest
      return `digest (newsletter from ${newsletterSender}; rank stories by ${workContext})`
    }
    return moduleName
  })
  const modulesLine = `Modules on: ${modules.length > 0 ? modules.join('; ') : 'none'}.`.replace(/[\r\n]+/g, ' ')
  return `${identityLine}\n${modulesLine}\n\n${runtimeText.trim()}\n\n${personaText.trim()}\n`
}

async function writeLaunchFileAtomically(filePath, contents) {
  const temporaryFilePath = `${filePath}.${process.pid}.tmp`
  await writeFile(temporaryFilePath, contents, { mode: 0o600, flag: 'wx' })
  try {
    await rename(temporaryFilePath, filePath)
  } finally {
    await unlink(temporaryFilePath).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

async function ensureScriptsSymlink(dataDirectory, packageRoot) {
  if (await realpath(dataDirectory) === await realpath(packageRoot)) return
  const scriptsPath = join(dataDirectory, 'scripts')
  const packageScriptsPath = join(packageRoot, 'scripts')
  let scriptsStatus
  try {
    scriptsStatus = await lstat(scriptsPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!scriptsStatus) {
    await symlink(packageScriptsPath, scriptsPath)
    return
  }
  if (!scriptsStatus.isSymbolicLink()) throw new Error(`${scriptsPath} is occupied by a non-symlink file or directory`)
  if (resolve(dirname(scriptsPath), await readlink(scriptsPath)) === packageScriptsPath) return
  await unlink(scriptsPath)
  await symlink(packageScriptsPath, scriptsPath)
}

async function readPersonaText(configDirectory, packageRoot) {
  try {
    return await readFile(join(configDirectory, 'persona.md'), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return readFile(join(packageRoot, 'prompts', 'persona.md'), 'utf8')
  }
}

export function buildClaudeArguments({ packageRoot, mcpConfigPath, systemPromptPath }) {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--replay-user-messages',
    '--model', 'opus',
    '--fallback-model', 'sonnet',
    '--channels', `plugin:${telegramPluginSource}`,
    '--setting-sources', '',
    '--settings', join(packageRoot, 'systemd', 'glissa-settings.json'),
    '--plugin-dir', packageRoot,
    '--mcp-config', mcpConfigPath,
    '--append-system-prompt-file', systemPromptPath,
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

function createDispatchMessage(content) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`
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

  const packageRoot = resolveRepositoryPath()
  const dataDirectory = resolveGlissaDataDirectory(environment)
  const configDirectory = resolve(resolveGlissaConfigDirectory(environment))
  const configPath = join(configDirectory, 'config.json')
  const launchDirectory = join(dataDirectory, 'launch')
  const mcpConfigPath = join(launchDirectory, 'mcp.json')
  const systemPromptPath = join(launchDirectory, 'system-prompt.md')
  const { stateDirectory, runtimeDirectory, channelDirectory } = resolveGlissaDirectories(environment)
  const stateFilePath = resolveServeStateFilePath(stateDirectory)
  const pollerCheckSeconds = parsePositiveSeconds(environment.GLISSA_POLLER_CHECK_SECONDS || '30', 'GLISSA_POLLER_CHECK_SECONDS')
  const pollerGraceSeconds = parsePositiveSeconds(environment.GLISSA_POLLER_GRACE_SECONDS || '60', 'GLISSA_POLLER_GRACE_SECONDS')
  const childKillSeconds = parsePositiveSeconds(environment.GLISSA_CHILD_KILL_SECONDS || '5', 'GLISSA_CHILD_KILL_SECONDS')
  const idleWaitSeconds = parsePositiveSeconds(environment.GLISSA_IDLE_WAIT_SECONDS || '600', 'GLISSA_IDLE_WAIT_SECONDS')
  const claudeCommand = environment.GLISSA_CLAUDE_COMMAND || 'claude'
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
  try {
    const config = readGlissaConfig(configPath)
    await mkdir(dataDirectory, { recursive: true })
    await ensureScriptsSymlink(dataDirectory, packageRoot)
    await mkdir(launchDirectory, { recursive: true })
    const runtimeText = await readFile(join(packageRoot, 'prompts', 'runtime.md'), 'utf8')
    const personaText = await readPersonaText(configDirectory, packageRoot)
    await writeLaunchFileAtomically(mcpConfigPath, `${JSON.stringify({ mcpServers: renderMcpServers(config, packageRoot) }, null, 2)}\n`)
    await writeLaunchFileAtomically(systemPromptPath, renderSystemPrompt({ config, runtimeText, personaText }))
  } catch (error) {
    return failStartup(error.message)
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
  child = spawn(claudeCommand, buildClaudeArguments({ packageRoot, mcpConfigPath, systemPromptPath }), {
    cwd: dataDirectory,
    env: { ...environment, TELEGRAM_STATE_DIR: channelDirectory, GLISSA_RUNTIME_SESSION: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })

  function writeModeToChild(mode, content = promptsByMode[mode], onWritten = async () => {}) {
    if (!child.stdin.writable) {
      requestExit(1, 'child input unavailable')
      return
    }
    dispatchedModesAwaitingStart.push(mode)
    serveState.lastDispatchAt[mode] = new Date().toISOString()
    queueStateWrite()
    try {
      child.stdin.write(createDispatchMessage(content), (error) => {
        if (error) {
          requestExit(1, 'child input failed')
          return
        }
        onWritten().catch(() => requestExit(1, 'dispatch completion failed'))
      })
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

  let hasCheckedFirstStart = false
  async function sendFirstStartHello() {
    if (hasCheckedFirstStart || isStopping || requestedExitCode !== null) return
    hasCheckedFirstStart = true
    const markerPath = join(stateDirectory, 'first-start')
    try {
      await lstat(markerPath)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    const access = await readJsonFile(join(channelDirectory, 'access.json'))
    const pairedChatId = access.allowFrom?.[0]
    if (access.dmPolicy !== 'allowlist' || access.allowFrom?.length !== 1 || !/^[1-9]\d*$/.test(String(pairedChatId ?? ''))) throw new Error('first start needs one paired chat')
    if (isStopping || requestedExitCode !== null) return
    writeModeToChild('hello', `${promptsByMode.hello} Paired chat_id: ${pairedChatId}.`, () => unlink(markerPath))
  }

  async function checkPoller() {
    if (requestedExitCode !== null) return
    const isAlive = await isTelegramPollerAlive({ channelDirectory, childPid: child.pid })
    if (isAlive) {
      if (!isPollerReady) logEvent('serve', 'poller_ready')
      isPollerReady = true
      await sendFirstStartHello().catch(() => requestExit(1, 'first start failed'))
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
