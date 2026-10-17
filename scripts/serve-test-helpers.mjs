import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readLoggedEvents, readOptionalLines } from './file-test-helpers.mjs'
import { withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { readJsonFile } from './json-file.mjs'

const serveScriptPath = fileURLToPath(new URL('./serve.mjs', import.meta.url))

const claudeShimSource = `#!/usr/bin/env bash
set -u
pollerPid=""
cleanup() {
  [ -z "$pollerPid" ] || kill "$pollerPid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT
[ "\${GLISSA_TEST_IGNORE_TERM:-0}" = "1" ] && trap '' TERM INT
printf '%s\n' "$$" > "$GLISSA_TEST_CHILD_PID_FILE"
emitChannelTurn() {
  printf '{"type":"user","message":{"role":"user","content":"a telegram message from john"}}\n'
  printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__plugin_telegram_telegram__reply","input":{"text":"channel-reply"}}]}}\n'
  printf '{"type":"result","subtype":"success","is_error":false,"result":"channel"}\n'
}
printf '%s\\n' "$PWD" "$GLISSA_RUNTIME_SESSION" "$@" > "$GLISSA_TEST_LAUNCH_FILE"
if [ "\${GLISSA_TEST_DISABLE_POLLER:-0}" != "1" ]; then
  bash -c 'exec -a glissa-server.ts sleep "\${GLISSA_TEST_POLLER_SECONDS:-60}"' &
  pollerPid=$!
  printf '%s\n' "$pollerPid" > "$GLISSA_TEST_CHANNEL_DIR/bot.pid"
fi
if [ "\${GLISSA_TEST_EMIT_CHANNEL_TURN:-0}" = "startup" ]; then
  emitChannelTurn
fi
if [ "\${GLISSA_TEST_EXIT_IMMEDIATELY:-0}" = "1" ]; then
  sleep 0.05
  exit 0
fi
if [ "\${GLISSA_TEST_IGNORE_TERM:-0}" = "1" ]; then
  sleep "\${GLISSA_TEST_IGNORE_TERM_SECONDS:-2}"
  exit 0
fi
channelEnableRefusalsLeft="\${GLISSA_TEST_CHANNEL_ENABLE_REFUSALS:-0}"
while IFS= read -r inputLine; do
  case "$inputLine" in
    *'"type":"control_request"'*)
      printf '%s\n' "$inputLine" >> "$GLISSA_TEST_CAPTURE_FILE.control"
      if [ "$channelEnableRefusalsLeft" -gt 0 ]; then
        channelEnableRefusalsLeft=$((channelEnableRefusalsLeft - 1))
        printf '{"type":"control_response","response":{"subtype":"error","request_id":"glissa-channel-enable","error":"server plugin:telegram:telegram is not connected"}}\n'
      else
        printf '{"type":"control_response","response":{"subtype":"success","request_id":"glissa-channel-enable"}}\n'
      fi
      continue
      ;;
  esac
  telegramStatus="\${GLISSA_TEST_TELEGRAM_STATUS:-connected}"
  printf '{"type":"system","subtype":"init","mcp_servers":[{"name":"plugin:telegram:telegram","status":"%s"}],"plugins":[{"name":"telegram","source":"telegram@claude-plugins-official","version":"0.0.7"}],"plugin_errors":%s,"permissionMode":"auto"}\n' "$telegramStatus" "\${GLISSA_TEST_PLUGIN_ERRORS:-[]}"
  printf '%s\n' "$inputLine" >> "$GLISSA_TEST_CAPTURE_FILE"
  if [ "\${GLISSA_TEST_EMIT_CHANNEL_TURN:-0}" = "1" ]; then
    emitChannelTurn
  fi
  if [ "\${GLISSA_TEST_EMIT_TOOL_RESULT:-0}" = "1" ]; then
    printf '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"ok"}]}}\n'
  fi
  if [ "\${GLISSA_TEST_REPLAY_USER:-1}" = "1" ]; then
    printf '%s\n' "$inputLine"
  fi
  if [ "\${GLISSA_TEST_REPLAY_USER:-1}" = "expanded" ]; then
    printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"expanded skill body, not the prompt line"}]}}\n'
  fi
  if [ "\${GLISSA_TEST_EMIT_REPLY:-0}" = "1" ]; then
    printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__plugin_telegram_telegram__reply","input":{"text":"%s"}}]}}\n' "\${GLISSA_TEST_MARKER:-fixture-marker}"
  fi
  if [ "\${GLISSA_TEST_EMIT_RESULT:-1}" = "1" ]; then
    printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}\n' "\${GLISSA_TEST_MARKER:-fixture-marker}"
  fi
done
`

export async function waitForCondition(condition, description, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

export function waitForProcessExit(childProcess, timeoutMs = 2_000) {
  if (childProcess.exitCode !== null) return Promise.resolve(childProcess.exitCode)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for supervisor exit')), timeoutMs)
    childProcess.once('close', (exitCode) => {
      clearTimeout(timeout)
      resolve(exitCode)
    })
  })
}

export function waitForProcessExitEvent(childProcess, timeoutMs = 5_000) {
  if (childProcess.exitCode !== null) return Promise.resolve(childProcess.exitCode)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for supervisor exit event')), timeoutMs)
    childProcess.once('exit', (exitCode) => {
      clearTimeout(timeout)
      resolve(exitCode)
    })
  })
}

export async function listenOnUnixSocket(server, socketPath) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
}

export async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve))
}

export async function sendDispatchToken(socketPath, token) {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socketPath)
    let answerText = ''
    connection.once('error', reject)
    connection.once('connect', () => {
      connection.write(`${token}\n`)
    })
    connection.on('data', (chunk) => { answerText += chunk })
    connection.once('end', () => resolve(answerText.trim()))
  })
}

export async function withServeFixture(testFunction) {
  return withTemporaryDirectory('glissa-serve-', async (temporaryDirectory) => {
    const stateDirectory = join(temporaryDirectory, 'state')
    const dataDirectory = join(temporaryDirectory, 'data')
    const configDirectory = join(temporaryDirectory, 'config')
    const runtimeDirectory = join(temporaryDirectory, 'runtime')
    const channelDirectory = join(temporaryDirectory, 'telegram')
    const shimDirectory = join(temporaryDirectory, 'bin')
    const captureFilePath = join(temporaryDirectory, 'stdin.ndjson')
    const childPidFilePath = join(temporaryDirectory, 'child.pid')
    const logFilePath = join(temporaryDirectory, 'glissa.jsonl')
    const socketPath = join(runtimeDirectory, 'dispatch.sock')
    await Promise.all([
      mkdir(stateDirectory),
      mkdir(configDirectory),
      mkdir(runtimeDirectory),
      mkdir(channelDirectory),
      mkdir(shimDirectory),
    ])
    await writeFile(join(configDirectory, 'config.json'), await readFile(new URL('../config.example.json', import.meta.url), 'utf8'))
    const claudeShimPath = join(shimDirectory, 'claude')
    await writeFile(claudeShimPath, claudeShimSource)
    await chmod(claudeShimPath, 0o755)
    const runningProcesses = new Set()
    const fixture = {
      temporaryDirectory,
      dataDirectory,
      configDirectory,
      runtimeDirectory,
      logFilePath,
      socketPath,
      async readCapturedLines() {
        return readOptionalLines(captureFilePath)
      },
      async readCapturedControlRequests() {
        return (await readOptionalLines(`${captureFilePath}.control`)).map((line) => JSON.parse(line))
      },
      async readLoggedEvents() {
        return readLoggedEvents(logFilePath)
      },
      async waitForLogEvent(predicate, description) {
        await waitForCondition(async () => (await readLoggedEvents(logFilePath)).some(predicate), description)
      },
      startServe(overrides = {}) {
        const environment = {
          ...process.env,
          PATH: `${shimDirectory}:${process.env.PATH}`,
          GLISSA_CLAUDE_COMMAND: 'claude',
          GLISSA_STATE_DIR: stateDirectory,
          GLISSA_DATA_DIR: dataDirectory,
          GLISSA_CONFIG_DIR: configDirectory,
          GLISSA_RUNTIME_DIR: runtimeDirectory,
          GLISSA_TELEGRAM_CHANNEL_DIR: channelDirectory,
          GLISSA_LOG_FILE: logFilePath,
          GLISSA_POLLER_CHECK_SECONDS: '0.05',
          GLISSA_POLLER_GRACE_SECONDS: '1',
          GLISSA_TEST_CAPTURE_FILE: captureFilePath,
          GLISSA_TEST_LAUNCH_FILE: join(temporaryDirectory, 'launch.txt'),
          GLISSA_TEST_CHANNEL_DIR: channelDirectory,
          GLISSA_TEST_CHILD_PID_FILE: childPidFilePath,
          GLISSA_TEST_EMIT_RESULT: '1',
          ...overrides,
        }
        const childProcess = spawn(process.execPath, [serveScriptPath], {
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        runningProcesses.add(childProcess)
        childProcess.once('close', () => runningProcesses.delete(childProcess))
        return childProcess
      },
      async stopServe(childProcess) {
        if (childProcess.exitCode === null) childProcess.kill('SIGTERM')
        return waitForProcessExit(childProcess)
      },
      async socketMode() {
        return (await stat(socketPath)).mode & 0o777
      },
      async readState() {
        return readJsonFile(join(stateDirectory, 'serve-state.json'))
      },
      async isChildGone() {
        try {
          const childPid = Number((await readFile(childPidFilePath, 'utf8')).trim())
          process.kill(childPid, 0)
          return false
        } catch {
          return true
        }
      },
      async isPollerGone() {
        try {
          const pollerPid = Number((await readFile(join(channelDirectory, 'bot.pid'), 'utf8')).trim())
          process.kill(pollerPid, 0)
          return false
        } catch {
          return true
        }
      },
    }
    try {
      await testFunction(fixture)
    } finally {
      for (const childProcess of runningProcesses) childProcess.kill('SIGTERM')
      await Promise.all([...runningProcesses].map((childProcess) => waitForProcessExit(childProcess).catch(() => undefined)))
    }
  })
}
