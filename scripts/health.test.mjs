import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { appendChatRecords, readChatRecords } from './chat-log.mjs'
import { setTestEnvironment, withTemporaryDirectory, withTestEnvironment } from './fixture-test-helpers.mjs'
import { checkHealth } from './health.mjs'
import { closeServer, listenOnUnixSocket } from './serve-test-helpers.mjs'

const restoreHomeTimeZone = setTestEnvironment({ GLISSA_HOME_TIME_ZONE: 'America/Chicago' })
after(restoreHomeTimeZone)

async function withHealthFixture(now, testFunction, { createSocket = true } = {}) {
  return withTemporaryDirectory('glissa-health-', async (repositoryRoot) => {
    const stateDirectory = join(repositoryRoot, 'state')
    const runtimeDirectory = join(repositoryRoot, 'runtime')
    const watchStateFilePath = join(repositoryRoot, 'context', 'watch-state.json')
    const chatLogDirectory = join(repositoryRoot, 'context', 'chat')
    const profileDirectory = join(repositoryRoot, 'profile')
    await Promise.all([
      mkdir(join(repositoryRoot, 'context')),
      mkdir(join(repositoryRoot, 'briefs')),
      mkdir(stateDirectory),
      mkdir(runtimeDirectory),
      mkdir(join(repositoryRoot, 'systemd')),
      mkdir(profileDirectory),
    ])
    await mkdir(chatLogDirectory)
    await writeFile(join(repositoryRoot, 'systemd', 'glissa-tasks.timer'), '')
    await writeFile(watchStateFilePath, JSON.stringify({
      accounts: { primary: { checkedAt: new Date(now.getTime() - 10 * 60 * 1_000).toISOString() } },
    }))
    const server = createServer()
    if (createSocket) await listenOnUnixSocket(server, join(runtimeDirectory, 'dispatch.sock'))
    const writeServeState = (serveState) => writeFile(join(stateDirectory, 'serve-state.json'), JSON.stringify(serveState))
    const writeServeStateText = (serveStateText) => writeFile(join(stateDirectory, 'serve-state.json'), serveStateText)
    const writeChatRecords = (records) => withTestEnvironment(
      { GLISSA_CHAT_LOG_DIR: chatLogDirectory },
      () => appendChatRecords(records),
    )
    try {
      await testFunction(
        {
          now, repositoryRoot, stateDirectory, runtimeDirectory, watchStateFilePath, profileDirectory,
          runCommand: async () => 'Sun 2027-06-13 20:17:00 CDT\n',
          readChatRecordsFromLog: (options) => withTestEnvironment(
            { GLISSA_CHAT_LOG_DIR: chatLogDirectory },
            () => readChatRecords(options),
          ),
        },
        writeServeState,
        writeServeStateText,
        writeChatRecords,
      )
    } finally {
      if (createSocket) await closeServer(server)
    }
  })
}

function stubSystemctlWithBlankNextElapse({
  timerActiveState = 'active',
  triggeredUnitActiveState,
  triggeredUnitName = 'glissa-tasks.service',
  inactiveExitTimestamp = '@1812909480',
  nextElapseOnLaterReads = '',
}) {
  const timerUnitName = 'glissa-tasks.timer'
  let nextElapseReadCount = 0
  return async (command, commandArguments) => {
    assert.equal(command, 'systemctl')
    const propertyFlagIndex = commandArguments.indexOf('-p')
    const unitName = commandArguments[propertyFlagIndex - 1]
    const propertyName = commandArguments[propertyFlagIndex + 1]
    assert.ok(unitName, 'systemctl was asked for a property of an empty unit name')
    if (propertyName === 'NextElapseUSecRealtime') {
      nextElapseReadCount += 1
      if (nextElapseReadCount === 1) return ''
      return nextElapseOnLaterReads
    }
    if (propertyName === 'Unit') return `${triggeredUnitName}\n`
    if (propertyName === 'InactiveExitTimestamp') {
      assert.ok(commandArguments.includes('--timestamp=unix'))
      return `${inactiveExitTimestamp}\n`
    }
    if (unitName === timerUnitName) return `${timerActiveState}\n`
    return `${triggeredUnitActiveState}\n`
  }
}

async function leaveAbandonedSocketFile(socketPath) {
  const listener = spawn(
    process.execPath,
    ['-e', "require('net').createServer().listen(process.argv[1], () => console.log('ready'))", socketPath],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  await new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.stdout.once('data', resolve)
  })
  listener.kill('SIGKILL')
  await new Promise((resolve) => listener.once('close', resolve))
}

test('health passes with a live socket and recent mail watch', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput) => {
    assert.equal(await checkHealth(healthInput), null)
  })
})

test('an unanswered Telegram message between 10 and 20 minutes old fails health', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState, writeServeStateText, writeChatRecords) => {
    writeChatRecords([{ direction: 'in', ts: '2027-06-13T17:45:00.000Z', chat_id: '1', message_id: '11', text: 'private' }])
    assert.equal(await checkHealth(healthInput), 'Missed your message at 12:45 pm America/Chicago, resend it')
  })
})

test('missed-message time uses the Oslo profile zone', async () => {
  const now = new Date('2027-06-28T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState, writeServeStateText, writeChatRecords) => {
    await writeFile(join(healthInput.profileDirectory, 'travel.md'), '- Time zone from 2027-06-28: Europe/Oslo (stated 2027-06-27)\n')
    writeChatRecords([{ direction: 'in', ts: '2027-06-28T17:45:00.000Z', chat_id: '1', message_id: '11', text: 'private' }])
    assert.equal(await checkHealth(healthInput), 'Missed your message at 7:45 pm Europe/Oslo, resend it')
  })
})

test('a Telegram reply or reaction after an inbound message passes health', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState, writeServeStateText, writeChatRecords) => {
    writeChatRecords([
      { direction: 'in', ts: '2027-06-13T17:45:00.000Z', chat_id: '1', message_id: '11', text: 'first' },
      { direction: 'out', kind: 'reply', ts: '2027-06-13T17:46:00.000Z', chat_id: '1', text: 'answered' },
      { direction: 'in', ts: '2027-06-13T17:47:00.000Z', chat_id: '1', message_id: '12', text: 'second' },
      { direction: 'out', kind: 'react', ts: '2027-06-13T17:48:00.000Z', chat_id: '1', message_id: '12', emoji: '👍' },
    ])
    assert.equal(await checkHealth(healthInput), null)
  })
})

test('a late Telegram reply without reply_to counts as an answer', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState, writeServeStateText, writeChatRecords) => {
    writeChatRecords([
      { direction: 'in', ts: '2027-06-13T17:41:00.000Z', chat_id: '1', message_id: '11', text: 'question' },
      { direction: 'out', kind: 'reply', ts: '2027-06-13T17:56:00.000Z', chat_id: '1', text: 'late answer' },
    ])
    assert.equal(await checkHealth(healthInput), null)
  })
})

test('an unanswered Telegram message at least 20 minutes old is ignored', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState, writeServeStateText, writeChatRecords) => {
    writeChatRecords([{ direction: 'in', ts: '2027-06-13T17:40:00.000Z', chat_id: '1', message_id: '11', text: 'older' }])
    assert.equal(await checkHealth(healthInput), null)
  })
})

test('an unanswered Telegram message younger than 10 minutes is ignored', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState, writeServeStateText, writeChatRecords) => {
    writeChatRecords([{ direction: 'in', ts: '2027-06-13T17:51:00.000Z', chat_id: '1', message_id: '11', text: 'newer' }])
    assert.equal(await checkHealth(healthInput), null)
  })
})

test('an unanswered Telegram message before Central midnight is found after midnight', async () => {
  const now = new Date('2027-06-14T05:05:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState, writeServeStateText, writeChatRecords) => {
    writeChatRecords([{ direction: 'in', ts: '2027-06-14T04:50:00.000Z', chat_id: '1', message_id: '11', text: 'midnight' }])
    assert.equal(await checkHealth(healthInput), 'Missed your message at 11:50 pm America/Chicago, resend it')
  })
})

test('an unanswered Telegram message remains visible across UTC chat log files', async () => {
  const now = new Date('2027-06-14T00:05:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState, writeServeStateText, writeChatRecords) => {
    writeChatRecords([{ direction: 'in', ts: '2027-06-13T23:50:00.000Z', chat_id: '1', message_id: '11', text: 'file rollover' }])
    assert.equal(await checkHealth(healthInput), 'Missed your message at 6:50 pm America/Chicago, resend it')
  })
})

test('an unanswered Telegram message is reported while the mail watch is stale', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState, writeServeStateText, writeChatRecords) => {
    await writeFile(healthInput.watchStateFilePath, JSON.stringify({
      accounts: { primary: { checkedAt: '2027-06-13T16:00:00.000Z' } },
    }))
    writeChatRecords([{ direction: 'in', ts: '2027-06-13T17:45:00.000Z', chat_id: '1', message_id: '11', text: 'private' }])
    assert.equal(await checkHealth(healthInput), 'Missed your message at 12:45 pm America/Chicago, resend it')
  })
})

test('an unanswered Telegram message is reported while a timer is stalled and the serve state is unreadable', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState, writeServeStateText, writeChatRecords) => {
    await writeServeStateText('{not json')
    writeChatRecords([{ direction: 'in', ts: '2027-06-13T17:45:00.000Z', chat_id: '1', message_id: '11', text: 'private' }])
    const runCommand = stubSystemctlWithBlankNextElapse({ triggeredUnitActiveState: 'inactive' })
    assert.equal(
      await checkHealth({ ...healthInput, runCommand }),
      'Missed your message at 12:45 pm America/Chicago, resend it',
    )
  })
})

test('health fails first when the dispatch socket is absent', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput) => {
    assert.equal(await checkHealth(healthInput), 'dispatch socket absent')
  }, { createSocket: false })
})

test('health fails when a leftover socket file has no listener', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput) => {
    await leaveAbandonedSocketFile(join(healthInput.runtimeDirectory, 'dispatch.sock'))
    assert.equal(await checkHealth(healthInput), 'dispatch socket not answering')
  }, { createSocket: false })
})

test('health fails when a timer has no next elapse', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput) => {
    const runCommand = stubSystemctlWithBlankNextElapse({ timerActiveState: 'failed', triggeredUnitActiveState: 'failed' })
    assert.equal(
      await checkHealth({ ...healthInput, runCommand }),
      'glissa-tasks.timer has no next elapse (timer failed, glissa-tasks.service failed)',
    )
  })
})

test('health passes when a timer has no next elapse because the unit it triggers started minutes ago', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput) => {
    for (const triggeredUnitActiveState of ['active', 'activating', 'deactivating']) {
      const runCommand = stubSystemctlWithBlankNextElapse({ triggeredUnitActiveState })
      assert.equal(await checkHealth({ ...healthInput, runCommand }), null)
    }
  })
})

test('health fails when the unit a timer triggers has been running past the five minute bound', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput) => {
    const runCommand = stubSystemctlWithBlankNextElapse({
      triggeredUnitActiveState: 'activating',
      inactiveExitTimestamp: '@1812908400',
    })
    assert.equal(
      await checkHealth({ ...healthInput, runCommand }),
      'glissa-tasks.timer has no next elapse (timer active, glissa-tasks.service activating for 20m)',
    )
  })
})

test('health fails when the running unit a timer triggers has no readable start timestamp', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput) => {
    const runCommand = stubSystemctlWithBlankNextElapse({
      triggeredUnitActiveState: 'activating',
      inactiveExitTimestamp: '',
    })
    assert.equal(
      await checkHealth({ ...healthInput, runCommand }),
      'glissa-tasks.timer has no next elapse (timer active, glissa-tasks.service activating for unknown)',
    )
  })
})

test('health fails without querying an empty unit name when a timer file is not loaded', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput) => {
    const runCommand = stubSystemctlWithBlankNextElapse({ triggeredUnitName: '', triggeredUnitActiveState: 'inactive' })
    assert.equal(
      await checkHealth({ ...healthInput, runCommand }),
      'glissa-tasks.timer has no next elapse (timer not loaded)',
    )
  })
})

test('health fails when a timer has no next elapse and the unit it triggers is idle', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput) => {
    const runCommand = stubSystemctlWithBlankNextElapse({ triggeredUnitActiveState: 'inactive' })
    assert.equal(
      await checkHealth({ ...healthInput, runCommand }),
      'glissa-tasks.timer has no next elapse (timer active, glissa-tasks.service inactive)',
    )
  })
})

test('health passes when a timer regains its next elapse while the triggered unit state is being read', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput) => {
    const runCommand = stubSystemctlWithBlankNextElapse({
      triggeredUnitActiveState: 'inactive',
      nextElapseOnLaterReads: 'Sun 2027-06-13 20:17:00 CDT\n',
    })
    assert.equal(await checkHealth({ ...healthInput, runCommand }), null)
  })
})

test('health fails when the oldest mail watch check is older than 35 minutes', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput) => {
    await writeFile(healthInput.watchStateFilePath, JSON.stringify({
      accounts: {
        first: { checkedAt: '2027-06-13T16:00:00.000Z' },
        second: { checkedAt: '2027-06-13T17:20:00.000Z' },
      },
    }))
    assert.equal(await checkHealth(healthInput), 'mail watch checkedAt for first is older than 35 minutes')
  })
})

test('health fails and names the one stale account while the other two are fresh', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput) => {
    await writeFile(healthInput.watchStateFilePath, JSON.stringify({
      accounts: {
        'personal-1': { checkedAt: '2027-06-13T17:50:00.000Z' },
        'personal-2': { checkedAt: '2027-06-13T16:30:00.000Z' },
        'personal-3': { checkedAt: '2027-06-13T17:55:00.000Z' },
      },
    }))
    assert.equal(await checkHealth(healthInput), 'mail watch checkedAt for personal-2 is older than 35 minutes')
  })
})

test('health fails after 08:30 when todays dispatched morning brief is missing', async () => {
  const now = new Date('2027-06-13T13:40:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState) => {
    await writeServeState({ lastDispatchAt: { morning: '2027-06-13T12:15:00.000Z' }, lastReplyAt: {} })
    assert.equal(await checkHealth(healthInput), 'morning brief missing for 2027-06-13')
  })
})

test('health checks the morning brief date and window in Oslo', async () => {
  const now = new Date('2027-06-29T06:40:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState) => {
    await writeFile(join(healthInput.profileDirectory, 'travel.md'), '- Time zone from 2027-06-28: Europe/Oslo (stated 2027-06-27)\n')
    await writeServeState({ lastDispatchAt: { morning: '2027-06-29T05:10:00.000Z' }, lastReplyAt: {} })
    assert.equal(await checkHealth(healthInput), 'morning brief missing for 2027-06-29')
  })
})

test('health fails after 21:30 when no Telegram reply follows todays evening dispatch', async () => {
  const now = new Date('2027-06-14T02:40:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState) => {
    await writeServeState({
      lastDispatchAt: { evening: '2027-06-14T01:10:00.000Z' },
      lastReplyAt: { evening: '2027-06-14T01:00:00.000Z' },
    })
    assert.equal(await checkHealth(healthInput), 'Telegram reply missing after evening dispatch for 2027-06-13')
  })
})

test('a reply belonging to another mode does not stand in for the evening recap', async () => {
  const now = new Date('2027-06-14T02:40:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState) => {
    await writeServeState({
      lastDispatchAt: { evening: '2027-06-14T01:10:00.000Z' },
      lastReplyAt: { tasks: '2027-06-14T01:30:00.000Z' },
    })
    assert.equal(await checkHealth(healthInput), 'Telegram reply missing after evening dispatch for 2027-06-13')
  })
})

test('an evening reply after the evening dispatch passes', async () => {
  const now = new Date('2027-06-14T02:40:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState) => {
    await writeServeState({
      lastDispatchAt: { evening: '2027-06-14T01:10:00.000Z' },
      lastReplyAt: { evening: '2027-06-14T01:30:00.000Z' },
    })
    assert.equal(await checkHealth(healthInput), null)
  })
})

test('health passes before 08:30 while todays dispatched morning brief is still missing', async () => {
  const now = new Date('2027-06-13T13:20:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState) => {
    await writeServeState({ lastDispatchAt: { morning: '2027-06-13T12:10:00.000Z' }, lastReplyAt: {} })
    assert.equal(await checkHealth(healthInput), null)
  })
})

test('health fails when the serve state cannot be parsed', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState, writeServeStateText) => {
    await writeServeStateText('{"lastDispatchAt": {')
    assert.equal(await checkHealth(healthInput), 'serve state cannot be read')
  })
})

test('health fails when the watch state shape is invalid', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput) => {
    await writeFile(healthInput.watchStateFilePath, JSON.stringify({ accounts: { primary: { checkedAt: 'not a timestamp' } } }))
    assert.equal(await checkHealth(healthInput), 'watch state cannot be read')
  })
})

test('health reads the watch state from the configured path', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput) => {
    const configuredWatchStateFilePath = join(healthInput.repositoryRoot, 'elsewhere-watch-state.json')
    await writeFile(configuredWatchStateFilePath, JSON.stringify({
      accounts: { primary: { checkedAt: '2027-06-13T10:00:00.000Z' } },
    }))
    assert.equal(
      await checkHealth({ ...healthInput, watchStateFilePath: configuredWatchStateFilePath }),
      'mail watch checkedAt for primary is older than 35 minutes',
    )
  })
})

test('health fails when no runtime directory is configured', async () => {
  const now = new Date('2027-06-13T18:00:00.000Z')
  await withHealthFixture(now, async (healthInput) => {
    assert.equal(await checkHealth({ ...healthInput, runtimeDirectory: null }), 'no runtime directory')
  })
})

test('a missing morning brief is healthy when morning was never dispatched', async () => {
  const now = new Date('2027-06-13T13:40:00.000Z')
  await withHealthFixture(now, async (healthInput, writeServeState) => {
    await writeServeState({ lastDispatchAt: {}, lastReplyAt: {} })
    assert.equal(await checkHealth(healthInput), null)
  })
})
