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
[ "\${ASSISTANT_TEST_IGNORE_TERM:-0}" = "1" ] && trap '' TERM INT
printf '%s\n' "$$" > "$ASSISTANT_TEST_CHILD_PID_FILE"
emitChannelTurn() {
  printf '{"type":"user","message":{"role":"user","content":"a telegram message from john"}}\n'
  printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__plugin_telegram_telegram__reply","input":{"text":"channel-reply"}}]}}\n'
  printf '{"type":"result","subtype":"success","is_error":false,"result":"channel"}\n'
}
if [ "\${ASSISTANT_TEST_DISABLE_POLLER:-0}" != "1" ]; then
  bash -c 'exec -a assistant-server.ts sleep "\${ASSISTANT_TEST_POLLER_SECONDS:-60}"' &
  pollerPid=$!
  printf '%s\n' "$pollerPid" > "$ASSISTANT_TEST_CHANNEL_DIR/bot.pid"
fi
if [ "\${ASSISTANT_TEST_EMIT_CHANNEL_TURN:-0}" = "startup" ]; then
  emitChannelTurn
fi
if [ "\${ASSISTANT_TEST_EXIT_IMMEDIATELY:-0}" = "1" ]; then
  sleep 0.05
  exit 0
fi
if [ "\${ASSISTANT_TEST_IGNORE_TERM:-0}" = "1" ]; then
  sleep "\${ASSISTANT_TEST_IGNORE_TERM_SECONDS:-2}"
  exit 0
fi
while IFS= read -r inputLine; do
  telegramStatus="\${ASSISTANT_TEST_TELEGRAM_STATUS:-connected}"
  printf '{"type":"system","subtype":"init","mcp_servers":[{"name":"plugin:telegram:telegram","status":"%s"}],"plugins":[{"name":"telegram","source":"telegram@claude-plugins-official","version":"0.0.7"}],"plugin_errors":%s,"permissionMode":"auto"}\n' "$telegramStatus" "\${ASSISTANT_TEST_PLUGIN_ERRORS:-[]}"
  printf '%s\n' "$inputLine" >> "$ASSISTANT_TEST_CAPTURE_FILE"
  if [ "\${ASSISTANT_TEST_EMIT_CHANNEL_TURN:-0}" = "1" ]; then
    emitChannelTurn
  fi
  if [ "\${ASSISTANT_TEST_EMIT_TOOL_RESULT:-0}" = "1" ]; then
    printf '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"ok"}]}}\n'
  fi
  if [ "\${ASSISTANT_TEST_REPLAY_USER:-1}" = "1" ]; then
    printf '%s\n' "$inputLine"
  fi
  if [ "\${ASSISTANT_TEST_REPLAY_USER:-1}" = "expanded" ]; then
    printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"expanded skill body, not the prompt line"}]}}\n'
  fi
  if [ "\${ASSISTANT_TEST_EMIT_REPLY:-0}" = "1" ]; then
    printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__plugin_telegram_telegram__reply","input":{"text":"%s"}}]}}\n' "\${ASSISTANT_TEST_MARKER:-fixture-marker}"
  fi
  if [ "\${ASSISTANT_TEST_EMIT_RESULT:-1}" = "1" ]; then
    printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}\n' "\${ASSISTANT_TEST_MARKER:-fixture-marker}"
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
  return withTemporaryDirectory('assistant-serve-', async (temporaryDirectory) => {
    const stateDirectory = join(temporaryDirectory, 'state')
    const runtimeDirectory = join(temporaryDirectory, 'runtime')
    const channelDirectory = join(temporaryDirectory, 'telegram')
    const shimDirectory = join(temporaryDirectory, 'bin')
    const captureFilePath = join(temporaryDirectory, 'stdin.ndjson')
    const childPidFilePath = join(temporaryDirectory, 'child.pid')
    const logFilePath = join(temporaryDirectory, 'assistant.jsonl')
    const socketPath = join(runtimeDirectory, 'dispatch.sock')
    await Promise.all([
      mkdir(stateDirectory),
      mkdir(runtimeDirectory),
      mkdir(channelDirectory),
      mkdir(shimDirectory),
    ])
    const claudeShimPath = join(shimDirectory, 'claude')
    await writeFile(claudeShimPath, claudeShimSource)
    await chmod(claudeShimPath, 0o755)
    const runningProcesses = new Set()
    const fixture = {
      temporaryDirectory,
      runtimeDirectory,
      logFilePath,
      socketPath,
      async readCapturedLines() {
        return readOptionalLines(captureFilePath)
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
          ASSISTANT_CLAUDE_COMMAND: 'claude',
          ASSISTANT_STATE_DIR: stateDirectory,
          ASSISTANT_RUNTIME_DIR: runtimeDirectory,
          ASSISTANT_TELEGRAM_CHANNEL_DIR: channelDirectory,
          ASSISTANT_LOG_FILE: logFilePath,
          ASSISTANT_POLLER_CHECK_SECONDS: '0.05',
          ASSISTANT_POLLER_GRACE_SECONDS: '1',
          ASSISTANT_TEST_CAPTURE_FILE: captureFilePath,
          ASSISTANT_TEST_CHANNEL_DIR: channelDirectory,
          ASSISTANT_TEST_CHILD_PID_FILE: childPidFilePath,
          ASSISTANT_TEST_EMIT_RESULT: '1',
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
