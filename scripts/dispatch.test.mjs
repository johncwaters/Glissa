import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { runDispatch as dispatchCommand } from './dispatch.mjs'
import { readLoggedEvents } from './file-test-helpers.mjs'
import { setTestEnvironment, withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { captureTestCommand } from './process-test-helpers.mjs'
import { closeServer, listenOnUnixSocket, waitForCondition, withServeFixture } from './serve-test-helpers.mjs'

const restoreHomeTimeZone = setTestEnvironment({ ASSISTANT_HOME_TIME_ZONE: 'America/Chicago' })
after(restoreHomeTimeZone)

const dispatchScriptPath = fileURLToPath(new URL('./dispatch.mjs', import.meta.url))

test('brief timers check each hour at minute ten', async () => {
  for (const mode of ['morning', 'evening']) {
    const timerPath = fileURLToPath(new URL(`../systemd/assistant-${mode}.timer`, import.meta.url))
    assert.match(await readFile(timerPath, 'utf8'), /^OnCalendar=\*-\*-\* \*:10:00$/m)
  }
})

function runDispatch(runtimeDirectory, logFilePath, ...argumentsToPass) {
  return captureTestCommand(process.execPath, [dispatchScriptPath, ...argumentsToPass], {
    env: { ...process.env, ASSISTANT_RUNTIME_DIR: runtimeDirectory, ASSISTANT_LOG_FILE: logFilePath },
  })
}

test('tasks with nothing due exits zero without contacting the socket', async () => {
  await withTemporaryDirectory('assistant-dispatch-', async (temporaryDirectory) => {
    const socketPath = join(temporaryDirectory, 'dispatch.sock')
    const logFilePath = join(temporaryDirectory, 'assistant.jsonl')
    const taskFilePath = join(temporaryDirectory, 'tasks.json')
    let connectionCount = 0
    await writeFile(taskFilePath, JSON.stringify({ tasks: [] }))
    const server = createServer(() => { connectionCount += 1 })
    await listenOnUnixSocket(server, socketPath)
    const dispatchResult = await captureTestCommand(process.execPath, [dispatchScriptPath, 'tasks'], {
      env: { ...process.env, ASSISTANT_RUNTIME_DIR: temporaryDirectory, ASSISTANT_LOG_FILE: logFilePath, ASSISTANT_TASKS_FILE: taskFilePath },
    })
    assert.equal(dispatchResult.exitCode, 0)
    assert.equal(connectionCount, 0)
    assert.deepEqual(await readLoggedEvents(logFilePath), [])
    await closeServer(server)
  })
})

test('tasks with a due task dispatches as before', async () => {
  await withTemporaryDirectory('assistant-dispatch-', async (temporaryDirectory) => {
    const socketPath = join(temporaryDirectory, 'dispatch.sock')
    const logFilePath = join(temporaryDirectory, 'assistant.jsonl')
    const taskFilePath = join(temporaryDirectory, 'tasks.json')
    let capturedTokenText = ''
    await writeFile(taskFilePath, JSON.stringify({ tasks: [{ id: 'abcd', status: 'open', due: '2026-01-01T00:00:00.000Z', notifiedAt: null }] }))
    const server = createServer((connection) => {
      connection.setEncoding('utf8')
      connection.on('data', (chunk) => {
        capturedTokenText += chunk
        connection.end('accepted\n')
      })
    })
    await listenOnUnixSocket(server, socketPath)
    const dispatchResult = await captureTestCommand(process.execPath, [dispatchScriptPath, 'tasks'], {
      env: { ...process.env, ASSISTANT_RUNTIME_DIR: temporaryDirectory, ASSISTANT_LOG_FILE: logFilePath, ASSISTANT_TASKS_FILE: taskFilePath },
    })
    assert.equal(dispatchResult.exitCode, 0)
    await waitForCondition(() => capturedTokenText === 'tasks\n', 'the dispatched task mode line')
    await closeServer(server)
  })
})

test('dispatch writes the mode and succeeds after an accepted answer', async () => {
  await withTemporaryDirectory('assistant-dispatch-', async (temporaryDirectory) => {
    const socketPath = join(temporaryDirectory, 'dispatch.sock')
    const logFilePath = join(temporaryDirectory, 'assistant.jsonl')
    let capturedTokenText = ''
    const server = createServer((connection) => {
      connection.setEncoding('utf8')
      connection.on('data', (chunk) => {
        capturedTokenText += chunk
        connection.end('accepted\n')
      })
    })
    await listenOnUnixSocket(server, socketPath)
    const dispatchResult = await runDispatch(temporaryDirectory, logFilePath, 'watch')
    assert.equal(dispatchResult.exitCode, 0)
    await waitForCondition(() => capturedTokenText === 'watch\n', 'the dispatched mode line')
    assert.deepEqual((await readLoggedEvents(logFilePath)).map(({ component, event, mode, answer }) => ({ component, event, mode, answer })), [
      { component: 'dispatch', event: 'sent', mode: 'watch', answer: 'accepted' },
    ])
    await closeServer(server)
  })
})

test('a missing argument exits two without connecting', async () => {
  await withTemporaryDirectory('assistant-dispatch-', async (temporaryDirectory) => {
    const socketPath = join(temporaryDirectory, 'dispatch.sock')
    const logFilePath = join(temporaryDirectory, 'assistant.jsonl')
    let connectionCount = 0
    const server = createServer(() => { connectionCount += 1 })
    await listenOnUnixSocket(server, socketPath)
    const dispatchResult = await runDispatch(temporaryDirectory, logFilePath)
    assert.equal(dispatchResult.exitCode, 2)
    assert.equal(connectionCount, 0)
    assert.deepEqual(await readLoggedEvents(logFilePath), [])
    await closeServer(server)
  })
})

test('an absent socket exits three and logs failure', async () => {
  await withTemporaryDirectory('assistant-dispatch-', async (temporaryDirectory) => {
    const logFilePath = join(temporaryDirectory, 'assistant.jsonl')
    const dispatchResult = await runDispatch(temporaryDirectory, logFilePath, 'watch')
    assert.equal(dispatchResult.exitCode, 3)
    assert.deepEqual((await readLoggedEvents(logFilePath)).map(({ component, event, mode }) => ({ component, event, mode })), [
      { component: 'dispatch', event: 'failed', mode: 'watch' },
    ])
  })
})

test('morning dispatch uses Oslo local time and skips Chicago morning for a Oslo profile', async () => {
  await withTemporaryDirectory('assistant-dispatch-', async (temporaryDirectory) => {
    const socketPath = join(temporaryDirectory, 'dispatch.sock')
    const profileDirectory = join(temporaryDirectory, 'profile')
    const logFilePath = join(temporaryDirectory, 'assistant.jsonl')
    await mkdir(profileDirectory)
    await writeFile(join(profileDirectory, 'travel.md'), '- Time zone from 2027-06-27: Europe/Oslo (stated 2027-06-26, until 2027-06-30)\n')
    const receivedModes = []
    const server = createServer((connection) => {
      connection.on('data', (mode) => {
        receivedModes.push(String(mode))
        connection.end('accepted\n')
      })
    })
    await listenOnUnixSocket(server, socketPath)
    const environment = { ...process.env, ASSISTANT_RUNTIME_DIR: temporaryDirectory, ASSISTANT_STATE_DIR: temporaryDirectory, ASSISTANT_LOG_FILE: logFilePath }
    try {
      assert.equal(await dispatchCommand(['morning'], { environment, profileDirectory, now: new Date('2027-06-28T05:10:00.000Z') }), 0)
      assert.equal(await dispatchCommand(['morning'], { environment, profileDirectory, now: new Date('2027-06-28T12:10:00.000Z') }), 0)
      assert.deepEqual(receivedModes, ['morning\n'])
    } finally {
      await closeServer(server)
    }
  })
})

test('evening dispatch keeps Chicago time on the evening before a Oslo from-date', async () => {
  await withTemporaryDirectory('assistant-dispatch-', async (temporaryDirectory) => {
    const socketPath = join(temporaryDirectory, 'dispatch.sock')
    const profileDirectory = join(temporaryDirectory, 'profile')
    const logFilePath = join(temporaryDirectory, 'assistant.jsonl')
    await mkdir(profileDirectory)
    await writeFile(join(profileDirectory, 'travel.md'), '- Time zone from 2027-06-28: Europe/Oslo (stated 2027-06-27)\n')
    const receivedModes = []
    const server = createServer((connection) => {
      connection.on('data', (mode) => {
        receivedModes.push(String(mode))
        connection.end('accepted\n')
      })
    })
    await listenOnUnixSocket(server, socketPath)
    const environment = { ...process.env, ASSISTANT_RUNTIME_DIR: temporaryDirectory, ASSISTANT_STATE_DIR: temporaryDirectory, ASSISTANT_LOG_FILE: logFilePath }
    try {
      assert.equal(await dispatchCommand(['evening'], { environment, profileDirectory, now: new Date('2027-06-28T01:10:00.000Z') }), 0)
      assert.equal(await dispatchCommand(['evening'], { environment, profileDirectory, now: new Date('2027-06-29T01:10:00.000Z') }), 0)
      assert.deepEqual(receivedModes, ['evening\n'])
    } finally {
      await closeServer(server)
    }
  })
})

test('evening dispatch sends the first Oslo recap after a Chicago recap sent the evening before', async () => {
  await withTemporaryDirectory('assistant-dispatch-', async (temporaryDirectory) => {
    const socketPath = join(temporaryDirectory, 'dispatch.sock')
    const profileDirectory = join(temporaryDirectory, 'profile')
    const logFilePath = join(temporaryDirectory, 'assistant.jsonl')
    await mkdir(profileDirectory)
    await writeFile(join(profileDirectory, 'travel.md'), '- Time zone from 2027-06-28: Europe/Oslo (stated 2027-06-27)\n')
    await writeFile(join(temporaryDirectory, 'serve-state.json'), JSON.stringify({ lastDispatchAt: { evening: '2027-06-28T01:10:00.000Z' }, lastReplyAt: {} }))
    const receivedModes = []
    const server = createServer((connection) => {
      connection.on('data', (mode) => {
        receivedModes.push(String(mode))
        connection.end('accepted\n')
      })
    })
    await listenOnUnixSocket(server, socketPath)
    const environment = { ...process.env, ASSISTANT_RUNTIME_DIR: temporaryDirectory, ASSISTANT_STATE_DIR: temporaryDirectory, ASSISTANT_LOG_FILE: logFilePath }
    try {
      assert.equal(await dispatchCommand(['evening'], { environment, profileDirectory, now: new Date('2027-06-28T18:10:00.000Z') }), 0)
      assert.deepEqual(receivedModes, ['evening\n'])
    } finally {
      await closeServer(server)
    }
  })
})

test('morning dispatch lands one hourly tick in a half-hour Kolkata zone', async () => {
  await withTemporaryDirectory('assistant-dispatch-', async (temporaryDirectory) => {
    const socketPath = join(temporaryDirectory, 'dispatch.sock')
    const profileDirectory = join(temporaryDirectory, 'profile')
    const logFilePath = join(temporaryDirectory, 'assistant.jsonl')
    await mkdir(profileDirectory)
    await writeFile(join(profileDirectory, 'travel.md'), '- Time zone from 2027-06-27: Asia/Kolkata (stated 2027-06-26)\n')
    const receivedModes = []
    const server = createServer((connection) => {
      connection.on('data', (mode) => {
        receivedModes.push(String(mode))
        connection.end('accepted\n')
      })
    })
    await listenOnUnixSocket(server, socketPath)
    const environment = { ...process.env, ASSISTANT_RUNTIME_DIR: temporaryDirectory, ASSISTANT_STATE_DIR: temporaryDirectory, ASSISTANT_LOG_FILE: logFilePath }
    try {
      assert.equal(await dispatchCommand(['morning'], { environment, profileDirectory, now: new Date('2027-06-28T02:10:00.000Z') }), 0)
      assert.equal(await dispatchCommand(['morning'], { environment, profileDirectory, now: new Date('2027-06-28T01:10:00.000Z') }), 0)
      assert.deepEqual(receivedModes, ['morning\n'])
    } finally {
      await closeServer(server)
    }
  })
})

test('evening dispatch skips a second brief on the same Chicago date after a Lisbon line expires', async () => {
  await withTemporaryDirectory('assistant-dispatch-', async (temporaryDirectory) => {
    const socketPath = join(temporaryDirectory, 'dispatch.sock')
    const profileDirectory = join(temporaryDirectory, 'profile')
    const logFilePath = join(temporaryDirectory, 'assistant.jsonl')
    const serveStateFilePath = join(temporaryDirectory, 'serve-state.json')
    await mkdir(profileDirectory)
    await writeFile(join(profileDirectory, 'travel.md'), '- Time zone from 2027-07-01: Europe/Lisbon (stated 2027-06-28, until 2027-07-09)\n')
    const firstEveningDispatchAt = new Date('2027-07-09T19:10:00.000Z')
    const receivedModes = []
    const server = createServer((connection) => {
      connection.on('data', async (mode) => {
        receivedModes.push(String(mode))
        await writeFile(serveStateFilePath, JSON.stringify({ lastDispatchAt: { evening: firstEveningDispatchAt.toISOString() }, lastReplyAt: {} }))
        connection.end('accepted\n')
      })
    })
    await listenOnUnixSocket(server, socketPath)
    const environment = { ...process.env, ASSISTANT_RUNTIME_DIR: temporaryDirectory, ASSISTANT_STATE_DIR: temporaryDirectory, ASSISTANT_LOG_FILE: logFilePath }
    try {
      assert.equal(await dispatchCommand(['evening'], { environment, profileDirectory, now: firstEveningDispatchAt }), 0)
      assert.equal(await dispatchCommand(['evening'], { environment, profileDirectory, now: new Date('2027-07-10T01:10:00.000Z') }), 0)
      assert.deepEqual(receivedModes, ['evening\n'])
    } finally {
      await closeServer(server)
    }
  })
})

test('evening dispatch still sends when serve state is missing or unreadable', async () => {
  await withTemporaryDirectory('assistant-dispatch-', async (temporaryDirectory) => {
    const socketPath = join(temporaryDirectory, 'dispatch.sock')
    const profileDirectory = join(temporaryDirectory, 'profile')
    const logFilePath = join(temporaryDirectory, 'assistant.jsonl')
    const missingStateDirectory = join(temporaryDirectory, 'missing-state')
    const unreadableStateDirectory = join(temporaryDirectory, 'unreadable-state')
    await mkdir(profileDirectory)
    await mkdir(unreadableStateDirectory)
    await writeFile(join(unreadableStateDirectory, 'serve-state.json'), '{not json')
    const receivedModes = []
    const server = createServer((connection) => {
      connection.on('data', (mode) => {
        receivedModes.push(String(mode))
        connection.end('accepted\n')
      })
    })
    await listenOnUnixSocket(server, socketPath)
    const chicagoEveningInWindow = new Date('2027-07-10T01:10:00.000Z')
    try {
      for (const stateDirectory of [missingStateDirectory, unreadableStateDirectory]) {
        const environment = { ...process.env, ASSISTANT_RUNTIME_DIR: temporaryDirectory, ASSISTANT_STATE_DIR: stateDirectory, ASSISTANT_LOG_FILE: logFilePath }
        assert.equal(await dispatchCommand(['evening'], { environment, profileDirectory, now: chicagoEveningInWindow }), 0)
      }
      assert.deepEqual(receivedModes, ['evening\n', 'evening\n'])
    } finally {
      await closeServer(server)
    }
  })
})

test('a rejected answer exits four', async () => {
  await withTemporaryDirectory('assistant-dispatch-', async (temporaryDirectory) => {
    const socketPath = join(temporaryDirectory, 'dispatch.sock')
    const logFilePath = join(temporaryDirectory, 'assistant.jsonl')
    const server = createServer((connection) => {
      connection.on('data', () => connection.end('rejected unknown mode\n'))
    })
    await listenOnUnixSocket(server, socketPath)
    const dispatchResult = await runDispatch(temporaryDirectory, logFilePath, 'bogus')
    assert.equal(dispatchResult.exitCode, 4)
    assert.deepEqual((await readLoggedEvents(logFilePath)).map(({ component, event, mode, reason, answer }) => ({ component, event, mode, reason, answer })), [
      { component: 'dispatch', event: 'failed', mode: 'bogus', reason: 'unknown mode', answer: 'rejected' },
    ])
    await closeServer(server)
  })
})

test('a server that closes without an answer exits three', async () => {
  await withTemporaryDirectory('assistant-dispatch-', async (temporaryDirectory) => {
    const socketPath = join(temporaryDirectory, 'dispatch.sock')
    const logFilePath = join(temporaryDirectory, 'assistant.jsonl')
    const server = createServer((connection) => {
      connection.on('data', () => connection.end())
    })
    await listenOnUnixSocket(server, socketPath)
    const dispatchResult = await runDispatch(temporaryDirectory, logFilePath, 'watch')
    assert.equal(dispatchResult.exitCode, 3)
    assert.deepEqual((await readLoggedEvents(logFilePath)).map(({ component, event, mode, reason }) => ({ component, event, mode, reason })), [
      { component: 'dispatch', event: 'failed', mode: 'watch', reason: 'no answer' },
    ])
    await closeServer(server)
  })
})

test('dispatch and serve agree on the accepted and rejected answers', async () => {
  await withServeFixture(async (fixture) => {
    const supervisor = fixture.startServe()
    await fixture.waitForLogEvent(({ event }) => event === 'poller_ready', 'poller readiness')
    const dispatchLogFilePath = join(fixture.temporaryDirectory, 'dispatch.jsonl')
    assert.equal((await runDispatch(fixture.runtimeDirectory, dispatchLogFilePath, 'watch')).exitCode, 0)
    assert.equal((await runDispatch(fixture.runtimeDirectory, dispatchLogFilePath, 'bogus')).exitCode, 4)
    assert.deepEqual((await readLoggedEvents(dispatchLogFilePath)).map(({ event, mode, answer, reason = null }) => ({ event, mode, answer, reason })), [
      { event: 'sent', mode: 'watch', answer: 'accepted', reason: null },
      { event: 'failed', mode: 'bogus', answer: 'rejected', reason: 'unknown mode' },
    ])
    await waitForCondition(async () => (await fixture.readCapturedLines()).length === 1, 'the dispatched mode line')
    await fixture.stopServe(supervisor)
  })
})

test('dispatch without a configured runtime directory fails without connecting', async () => {
  await withTemporaryDirectory('assistant-dispatch-', async (temporaryDirectory) => {
    const logFilePath = join(temporaryDirectory, 'assistant.jsonl')
    const dispatchResult = await captureTestCommand(process.execPath, [dispatchScriptPath, 'watch'], {
      env: { ...process.env, ASSISTANT_RUNTIME_DIR: '', XDG_RUNTIME_DIR: '', ASSISTANT_LOG_FILE: logFilePath },
    })
    assert.equal(dispatchResult.exitCode, 3)
    assert.deepEqual((await readLoggedEvents(logFilePath)).map(({ event, mode, reason }) => ({ event, mode, reason })), [
      { event: 'failed', mode: 'watch', reason: 'no runtime directory' },
    ])
  })
})
