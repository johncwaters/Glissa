import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import {
  closeServer,
  listenOnUnixSocket,
  sendDispatchToken,
  waitForCondition,
  waitForProcessExit,
  waitForProcessExitEvent,
  withServeFixture,
} from './serve-test-helpers.mjs'
import { buildClaudeArguments } from './serve.mjs'

async function writeControlledClaudeShim(fixture) {
  const claudeShimPath = join(fixture.temporaryDirectory, 'controlled-claude')
  await writeFile(claudeShimPath, `#!/usr/bin/env bash
set -u
printf '%s\n' "$$" > "$ASSISTANT_TEST_CHILD_PID_FILE"
bash -c 'exec -a assistant-server.ts sleep 60' &
pollerPid=$!
printf '%s\n' "$pollerPid" > "$ASSISTANT_TEST_CHANNEL_DIR/bot.pid"
trap 'kill "$pollerPid" 2>/dev/null || true' EXIT
trap 'exit 0' TERM
if [ "\${ASSISTANT_TEST_START_CHANNEL_TURN:-0}" = "1" ]; then
  printf '{"type":"user","message":{"role":"user","content":"channel turn"}}\n'
fi
if [ "\${ASSISTANT_TEST_START_CHANNEL_TURN:-0}" != "1" ]; then
  IFS= read -r inputLine
  printf '%s\n' "$inputLine" >> "$ASSISTANT_TEST_CAPTURE_FILE"
  printf '%s\n' "$inputLine"
fi
while [ ! -f "$ASSISTANT_TEST_RELEASE_FILE" ]; do sleep 0.02; done
printf '{"type":"result","subtype":"success","is_error":false,"result":"done"}\n'
while IFS= read -r inputLine; do :; done
`)
  await chmod(claudeShimPath, 0o755)
  return claudeShimPath
}

test('the session loads project settings only, so the operator\'s personal instructions and hooks stay out', () => {
  const claudeArguments = buildClaudeArguments('/repo')

  assert.equal(claudeArguments[claudeArguments.indexOf('--setting-sources') + 1], 'project')
  assert.equal(claudeArguments[claudeArguments.indexOf('--settings') + 1], '/repo/systemd/assistant-settings.json')
})

test('startup without a poller exits non-zero after the grace period and logs the reason', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe({ ASSISTANT_TEST_DISABLE_POLLER: '1' })
    const exitCode = await waitForProcessExit(supervisor)
    assert.notEqual(exitCode, 0)
    const loggedEvents = await fixture.readLoggedEvents()
    assert.equal(loggedEvents.find(({ event }) => event === 'poller_lost')?.reason, 'startup grace expired')
  })
})

test('healthy startup creates an owner-only socket and logs poller readiness', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe()
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    assert.equal(await fixture.socketMode(), 0o600)
    assert.equal(await fixture.stopServe(supervisor), 0)
  })
})

test('a dispatch token reaches the child as the exact stream-json prompt line', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe()
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    assert.equal(await sendDispatchToken(fixture.socketPath, 'tasks'), 'accepted')
    await waitForCondition(async () => (await fixture.readCapturedLines()).length === 1, 'captured dispatch')
    assert.deepEqual(await fixture.readCapturedLines(), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '/tasks due ' } }),
    ])
    await fixture.stopServe(supervisor)
  })
})

test('an unknown token is rejected without reaching the child', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe()
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    assert.equal(await sendDispatchToken(fixture.socketPath, 'unknown-mode'), 'rejected unknown mode')
    await fixture.waitForLogEvent(({ event }) => event === 'dispatch_rejected', 'dispatch rejection')
    assert.deepEqual(await fixture.readCapturedLines(), [])
    assert.equal((await fixture.readLoggedEvents()).find(({ event }) => event === 'dispatch_rejected')?.reason, 'unknown mode')
    await fixture.stopServe(supervisor)
  })
})

test('a duplicate mode waiting behind an active turn is dropped', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe({ ASSISTANT_TEST_EMIT_RESULT: '0', ASSISTANT_IDLE_WAIT_SECONDS: '0.1' })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    assert.equal(await sendDispatchToken(fixture.socketPath, 'morning'), 'accepted')
    await waitForCondition(async () => (await fixture.readCapturedLines()).length === 1, 'active dispatch')
    assert.equal(await sendDispatchToken(fixture.socketPath, 'tasks'), 'queued')
    await waitForCondition(async () => (await fixture.readCapturedLines()).length === 2, 'queued dispatch written straight to the child')
    assert.equal(await sendDispatchToken(fixture.socketPath, 'tasks'), 'rejected mode already queued')
    await fixture.waitForLogEvent(({ event, reason }) => event === 'dispatch_rejected' && reason === 'mode already queued', 'duplicate rejection')
    assert.equal((await fixture.readCapturedLines()).length, 2)
    const dispatchEvents = (await fixture.readLoggedEvents()).filter(({ event }) => event === 'dispatch')
    assert.deepEqual(dispatchEvents.map(({ mode, queued }) => ({ mode, queued })), [
      { mode: 'morning', queued: false },
      { mode: 'tasks', queued: true },
    ])
    await fixture.stopServe(supervisor)
  })
})

test('an init event with a disconnected Telegram server stops the supervisor', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe({ ASSISTANT_TEST_TELEGRAM_STATUS: 'failed' })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    await sendDispatchToken(fixture.socketPath, 'watch')
    const exitCode = await waitForProcessExit(supervisor)
    assert.notEqual(exitCode, 0)
    const initEvent = (await fixture.readLoggedEvents()).find(({ event }) => event === 'init')
    assert.deepEqual({ plugins_ok: initEvent.plugins_ok, mcp_ok: initEvent.mcp_ok }, { plugins_ok: true, mcp_ok: false })
  })
})

test('a child exit stops the supervisor with a non-zero status', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe({ ASSISTANT_TEST_EXIT_IMMEDIATELY: '1' })
    assert.notEqual(await waitForProcessExit(supervisor), 0)
    assert.notEqual((await fixture.readLoggedEvents()).find(({ event }) => event === 'exit')?.exit_code, 0)
  })
})

test('a socket bind failure stops the child poller and records the failure class', async () => {
  await withServeFixture(async (fixture) => {
    await chmod(fixture.runtimeDirectory, 0o500)
    const supervisor = fixture.startServe({ ASSISTANT_TEST_POLLER_SECONDS: '0.1' })
    const exitCode = await waitForProcessExit(supervisor)
    await chmod(fixture.runtimeDirectory, 0o700)
    assert.notEqual(exitCode, 0)
    await waitForCondition(() => fixture.isPollerGone(), 'stopped poller')
    assert.equal((await fixture.readLoggedEvents()).find(({ event }) => event === 'exit')?.reason, 'socket server error')
  })
})

test('a regular file at the socket path fails startup without leaving a poller', async () => {
  await withServeFixture(async (fixture) => {
    await writeFile(fixture.socketPath, 'not a socket')
    const supervisor = fixture.startServe()
    assert.notEqual(await waitForProcessExit(supervisor), 0)
    assert.equal(await fixture.isPollerGone(), true)
    assert.equal((await fixture.readLoggedEvents()).find(({ event }) => event === 'exit')?.reason, 'socket path unavailable')
  })
})

test('an over-long socket path exits with the socket path reason', async () => {
  await withServeFixture(async (fixture) => {
    const longRuntimeDirectory = join(fixture.temporaryDirectory, 'r'.repeat(100))
    await mkdir(longRuntimeDirectory)
    const supervisor = fixture.startServe({ ASSISTANT_RUNTIME_DIR: longRuntimeDirectory })
    assert.notEqual(await waitForProcessExit(supervisor), 0)
    assert.equal(await fixture.isPollerGone(), true)
    assert.equal((await fixture.readLoggedEvents()).find(({ event }) => event === 'exit')?.reason, 'socket path too long')
  })
})

test('repeated matching init events only produce one init row', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe()
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    await sendDispatchToken(fixture.socketPath, 'morning')
    await sendDispatchToken(fixture.socketPath, 'tasks')
    await waitForCondition(async () => (await fixture.readCapturedLines()).length === 2, 'two dispatches')
    assert.equal((await fixture.readLoggedEvents()).filter(({ event }) => event === 'init').length, 1)
    await fixture.stopServe(supervisor)
  })
})

test('child stdout marker text never reaches the supervisor log', async () => {
  await withServeFixture(async (fixture) => {
    const marker = 'private-stream-marker-7281'
    const supervisor = fixture.startServe({ ASSISTANT_TEST_EMIT_REPLY: '1', ASSISTANT_TEST_MARKER: marker })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    await sendDispatchToken(fixture.socketPath, 'evening')
    await waitForCondition(async () => {
      try {
        return Boolean((await fixture.readState()).lastReplyAt?.evening)
      } catch {
        return false
      }
    }, 'reply state')
    assert.doesNotMatch(await readFile(fixture.logFilePath, 'utf8'), new RegExp(marker))
    await fixture.stopServe(supervisor)
  })
})

test('serve state records the Telegram reply under the dispatched mode alone', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe({ ASSISTANT_TEST_EMIT_REPLY: '1' })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    await sendDispatchToken(fixture.socketPath, 'morning')
    await waitForCondition(async () => {
      try {
        const serveState = await fixture.readState()
        return Boolean(serveState.lastDispatchAt?.morning && serveState.lastReplyAt?.morning)
      } catch {
        return false
      }
    }, 'persisted serve state')
    const serveState = await fixture.readState()
    assert.match(serveState.lastDispatchAt.morning, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(serveState.lastReplyAt.morning, /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual(Object.keys(serveState.lastReplyAt), ['morning'])
    await fixture.stopServe(supervisor)
  })
})

test('a Telegram turn with no dispatch outstanding stamps no mode', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe({ ASSISTANT_TEST_EMIT_CHANNEL_TURN: 'startup', ASSISTANT_TEST_EMIT_REPLY: '1' })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    assert.equal(await sendDispatchToken(fixture.socketPath, 'tasks'), 'accepted')
    await waitForCondition(async () => Boolean((await fixture.readState().catch(() => ({}))).lastReplyAt?.tasks), 'tasks reply state')
    assert.deepEqual(Object.keys((await fixture.readState()).lastReplyAt), ['tasks'])
    await fixture.stopServe(supervisor)
  })
})

test('a user echo whose text is not the prompt still attributes the oldest dispatched mode', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe({ ASSISTANT_TEST_REPLAY_USER: 'expanded', ASSISTANT_TEST_EMIT_REPLY: '1' })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    assert.equal(await sendDispatchToken(fixture.socketPath, 'evening'), 'accepted')
    await waitForCondition(async () => Boolean((await fixture.readState().catch(() => ({}))).lastReplyAt?.evening), 'evening reply state')
    assert.deepEqual(Object.keys((await fixture.readState()).lastReplyAt), ['evening'])
    await fixture.stopServe(supervisor)
  })
})

test('a tool_result user event starts no turn and stamps no reply', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe({
      ASSISTANT_TEST_REPLAY_USER: '0',
      ASSISTANT_TEST_EMIT_TOOL_RESULT: '1',
      ASSISTANT_TEST_EMIT_REPLY: '1',
    })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    assert.equal(await sendDispatchToken(fixture.socketPath, 'morning'), 'accepted')
    await waitForCondition(
      async () => await sendDispatchToken(fixture.socketPath, 'morning') === 'accepted',
      'a later morning dispatch once the unattributed turn ended',
    )
    await sendDispatchToken(fixture.socketPath, 'tasks')
    await waitForCondition(
      async () => Boolean((await fixture.readState().catch(() => ({}))).lastDispatchAt?.tasks),
      'serve state written after every earlier event',
    )
    assert.deepEqual((await fixture.readState()).lastReplyAt, {})
    await fixture.stopServe(supervisor)
  })
})

test('a turn that ends without an echo unblocks the next dispatch of the same mode', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe({ ASSISTANT_TEST_REPLAY_USER: '0' })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    assert.equal(await sendDispatchToken(fixture.socketPath, 'morning'), 'accepted')
    await waitForCondition(async () => (await fixture.readCapturedLines()).length === 1, 'first dispatch')
    await waitForCondition(
      async () => await sendDispatchToken(fixture.socketPath, 'morning') === 'accepted',
      'a second morning dispatch after the unechoed turn ended',
    )
    await waitForCondition(async () => (await fixture.readCapturedLines()).length >= 2, 'second dispatch reaching the child')
    await fixture.stopServe(supervisor)
  })
})

test('a second dispatch of a mode already written but not yet started is dropped', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe({
      ASSISTANT_TEST_REPLAY_USER: '0',
      ASSISTANT_TEST_EMIT_RESULT: '0',
      ASSISTANT_IDLE_WAIT_SECONDS: '0.1',
    })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    assert.equal(await sendDispatchToken(fixture.socketPath, 'morning'), 'accepted')
    await waitForCondition(async () => (await fixture.readCapturedLines()).length === 1, 'unstarted dispatch')
    assert.equal(await sendDispatchToken(fixture.socketPath, 'morning'), 'rejected mode already queued')
    assert.equal((await fixture.readCapturedLines()).length, 1)
    await fixture.stopServe(supervisor)
  })
})

test('a plugin error naming another plugin leaves the supervisor running', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe({
      ASSISTANT_TEST_PLUGIN_ERRORS: '[{"name":"notes","message":"telegram bridge unavailable"}]',
    })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    assert.equal(await sendDispatchToken(fixture.socketPath, 'watch'), 'accepted')
    await fixture.waitForLogEvent(({ event }) => event === 'init', 'init status')
    const initEvent = (await fixture.readLoggedEvents()).find(({ event }) => event === 'init')
    assert.deepEqual({ plugins_ok: initEvent.plugins_ok, mcp_ok: initEvent.mcp_ok }, { plugins_ok: true, mcp_ok: true })
    assert.equal(supervisor.exitCode, null)
    assert.equal(await fixture.stopServe(supervisor), 0)
  })
})

test('a plugin error naming the Telegram plugin stops the supervisor', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe({
      ASSISTANT_TEST_PLUGIN_ERRORS: '[{"name":"telegram","message":"load failed"}]',
    })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    await sendDispatchToken(fixture.socketPath, 'watch')
    assert.notEqual(await waitForProcessExit(supervisor), 0)
    const initEvent = (await fixture.readLoggedEvents()).find(({ event }) => event === 'init')
    assert.deepEqual({ plugins_ok: initEvent.plugins_ok, mcp_ok: initEvent.mcp_ok }, { plugins_ok: false, mcp_ok: true })
  })
})

test('a child that ignores SIGTERM is killed before the supervisor exits', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe({
      ASSISTANT_TEST_IGNORE_TERM: '1',
      ASSISTANT_TEST_IGNORE_TERM_SECONDS: '3',
      ASSISTANT_TEST_POLLER_SECONDS: '2',
      ASSISTANT_CHILD_KILL_SECONDS: '0.3',
    })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    supervisor.kill('SIGTERM')
    assert.equal(await waitForProcessExitEvent(supervisor), 0)
    await waitForCondition(() => fixture.isChildGone(), 'killed child', 1_000)
    assert.equal(await waitForProcessExit(supervisor, 5_000), 0)
  })
})

test('SIGTERM waits for a dispatched mode to emit its result', async () => {
  await withServeFixture(async (fixture) => {
    const claudeShimPath = await writeControlledClaudeShim(fixture)
    const releaseFilePath = join(fixture.temporaryDirectory, 'release-result')
    const supervisor = fixture.startServe({
      ASSISTANT_CLAUDE_COMMAND: claudeShimPath,
      ASSISTANT_TEST_RELEASE_FILE: releaseFilePath,
      ASSISTANT_IDLE_WAIT_SECONDS: '1',
    })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    assert.equal(await sendDispatchToken(fixture.socketPath, 'tasks'), 'accepted')
    await waitForCondition(async () => (await fixture.readCapturedLines()).length === 1, 'open dispatched turn')
    supervisor.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(supervisor.exitCode, null)
    assert.equal(await fixture.isChildGone(), false)
    await assert.rejects(sendDispatchToken(fixture.socketPath, 'morning'))
    assert.equal((await fixture.readCapturedLines()).length, 1)
    await writeFile(releaseFilePath, '')
    assert.equal(await waitForProcessExit(supervisor), 0)
  })
})

test('SIGTERM waits for an open Telegram channel turn without a dispatch', async () => {
  await withServeFixture(async (fixture) => {
    const claudeShimPath = await writeControlledClaudeShim(fixture)
    const releaseFilePath = join(fixture.temporaryDirectory, 'release-result')
    const supervisor = fixture.startServe({
      ASSISTANT_CLAUDE_COMMAND: claudeShimPath,
      ASSISTANT_TEST_RELEASE_FILE: releaseFilePath,
      ASSISTANT_TEST_START_CHANNEL_TURN: '1',
      ASSISTANT_IDLE_WAIT_SECONDS: '1',
    })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    await new Promise((resolve) => setTimeout(resolve, 100))
    supervisor.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(supervisor.exitCode, null)
    await writeFile(releaseFilePath, '')
    assert.equal(await waitForProcessExit(supervisor), 0)
  })
})

test('a child that closes while the supervisor is stopping exits cleanly', async () => {
  await withServeFixture(async (fixture) => {
    const claudeShimPath = await writeControlledClaudeShim(fixture)
    const supervisor = fixture.startServe({
      ASSISTANT_CLAUDE_COMMAND: claudeShimPath,
      ASSISTANT_TEST_RELEASE_FILE: join(fixture.temporaryDirectory, 'release-result'),
      ASSISTANT_IDLE_WAIT_SECONDS: '5',
    })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    assert.equal(await sendDispatchToken(fixture.socketPath, 'tasks'), 'accepted')
    await waitForCondition(async () => (await fixture.readCapturedLines()).length === 1, 'open dispatched turn')
    supervisor.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 100))
    const childPid = Number((await readFile(join(fixture.temporaryDirectory, 'child.pid'), 'utf8')).trim())
    process.kill(childPid, 'SIGTERM')
    assert.equal(await waitForProcessExit(supervisor), 0)
  })
})

test('SIGTERM stops waiting after the configured idle wait bound', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe({ ASSISTANT_TEST_EMIT_RESULT: '0', ASSISTANT_IDLE_WAIT_SECONDS: '0.2' })
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    assert.equal(await sendDispatchToken(fixture.socketPath, 'tasks'), 'accepted')
    await waitForCondition(async () => (await fixture.readCapturedLines()).length === 1, 'open dispatched turn')
    supervisor.kill('SIGTERM')
    assert.equal(await waitForProcessExit(supervisor), 0)
  })
})

test('a live listener at the socket path refuses startup and keeps the socket', async () => {
  await withServeFixture(async (fixture) => {
    const runningServer = createServer((connection) => {
      connection.on('data', () => connection.end('accepted\n'))
    })
    await listenOnUnixSocket(runningServer, fixture.socketPath)
    try {
      const supervisor = fixture.startServe()
      assert.notEqual(await waitForProcessExit(supervisor), 0)
      assert.equal(await fixture.isPollerGone(), true)
      assert.equal((await fixture.readLoggedEvents()).find(({ event }) => event === 'exit')?.reason, 'dispatch socket already in use')
      assert.equal(await sendDispatchToken(fixture.socketPath, 'watch'), 'accepted')
    } finally {
      await closeServer(runningServer)
    }
  })
})

test('startup without a configured runtime directory refuses to run', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe({ ASSISTANT_RUNTIME_DIR: '', XDG_RUNTIME_DIR: '' })
    assert.notEqual(await waitForProcessExit(supervisor), 0)
    assert.equal(await fixture.isPollerGone(), true)
    assert.equal((await fixture.readLoggedEvents()).find(({ event }) => event === 'exit')?.reason, 'no runtime directory')
  })
})

test('a symlinked runtime directory refuses startup', async () => {
  await withServeFixture(async (fixture) => {
    const linkedRuntimeDirectory = join(fixture.temporaryDirectory, 'linked-runtime')
    await symlink(fixture.runtimeDirectory, linkedRuntimeDirectory)
    const supervisor = fixture.startServe({ ASSISTANT_RUNTIME_DIR: linkedRuntimeDirectory })
    assert.notEqual(await waitForProcessExit(supervisor), 0)
    assert.equal(await fixture.isPollerGone(), true)
    assert.equal((await fixture.readLoggedEvents()).find(({ event }) => event === 'exit')?.reason, 'runtime directory unsafe')
  })
})
