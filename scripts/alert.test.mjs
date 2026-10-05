import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import { readLoggedEvents, readOptionalLines } from './file-test-helpers.mjs'
import { withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { captureTestCommand } from './process-test-helpers.mjs'

const alertScriptPath = fileURLToPath(new URL('./alert.sh', import.meta.url))
const allowedChatId = '987654321'

async function withAlertFixture(testFunction) {
  return withTemporaryDirectory('glissa-alert-', async (temporaryDirectory) => {
    const channelDirectory = join(temporaryDirectory, 'telegram')
    const shimDirectory = join(temporaryDirectory, 'bin')
    const logFilePath = join(temporaryDirectory, 'glissa.jsonl')
    const commandLogPath = join(temporaryDirectory, 'commands.log')
    await mkdir(channelDirectory, { recursive: true })
    await mkdir(shimDirectory)
    await writeFile(join(channelDirectory, 'access.json'), JSON.stringify({ policy: 'allowlist', allowFrom: [allowedChatId] }))
    await writeFile(join(shimDirectory, 'journalctl'), `#!/usr/bin/env bash
printf 'journalctl %s\n' "$*" >> "$ALERT_TEST_COMMAND_LOG"
printf 'fixture journal line\n'
`)
    await chmod(join(shimDirectory, 'journalctl'), 0o755)
    await testFunction({ channelDirectory, shimDirectory, logFilePath, commandLogPath, stateDirectory: join(temporaryDirectory, 'state') })
  })
}

async function runAlertScript(
  { channelDirectory, shimDirectory, logFilePath, commandLogPath, stateDirectory },
  alertArguments,
  environmentOverrides = {},
) {
  const alertEnvironment = {
    ...process.env,
    PATH: `${shimDirectory}:${process.env.PATH}`,
    TELEGRAM_CHANNEL_DIR: channelDirectory,
    GLISSA_LOG_FILE: logFilePath,
    GLISSA_STATE_DIR: stateDirectory,
    ALERT_TEST_COMMAND_LOG: commandLogPath,
  }
  delete alertEnvironment.MONITOR_INVOCATION_ID
  delete alertEnvironment.MONITOR_UNIT
  return captureTestCommand('bash', [alertScriptPath, ...alertArguments], {
    env: { ...alertEnvironment, ...environmentOverrides },
  })
}

test('dry run resolves the allowed chat id from the channel directory without sending', async () => {
  await withAlertFixture(async (fixture) => {
    await writeFile(join(fixture.channelDirectory, '.env'), 'TELEGRAM_BOT_TOKEN=123456:fake-token\n')
    const alertResult = await runAlertScript(fixture, ['tasks', '--dry-run'])
    assert.equal(alertResult.exitCode, 0)
    assert.match(alertResult.stdout, new RegExp(`^chat_id ${allowedChatId}$`, 'm'))
    assert.match(alertResult.stdout, /^target https:\/\/api\.telegram\.org\/bot<token>\/sendMessage$/m)
    assert.doesNotMatch(alertResult.stdout, /fake-token/)
    assert.match(alertResult.stdout, /could not complete the tasks run/)
    assert.deepEqual(await readOptionalLines(fixture.commandLogPath), [
      'journalctl --user -u glissa-dispatch@tasks.service -n 20 -o cat --since -1h',
    ])
  })
})

test('a health alert names the health instance and reads the overridden unit journal', async () => {
  await withAlertFixture(async (fixture) => {
    await writeFile(join(fixture.channelDirectory, '.env'), 'TELEGRAM_BOT_TOKEN=123456:fake-token\n')
    const alertResult = await runAlertScript(fixture, ['health', '--dry-run'], { MONITOR_UNIT: 'glissa-health.service' })
    assert.equal(alertResult.exitCode, 0)
    assert.match(alertResult.stdout, /could not complete the health run/)
    assert.deepEqual(await readOptionalLines(fixture.commandLogPath), [
      'journalctl --user -u glissa-health.service -n 20 -o cat --since -1h',
    ])
  })
})

test('a missing bot token exits one and logs a failed alert carrying only the reason', async () => {
  await withAlertFixture(async (fixture) => {
    const alertResult = await runAlertScript(fixture, ['tasks', '--dry-run'])
    assert.equal(alertResult.exitCode, 1)
    assert.match(alertResult.stderr, /no telegram bot token/)
    const loggedEvents = await readLoggedEvents(fixture.logFilePath)
    assert.deepEqual(loggedEvents.map(({ component, event, instance, reason }) => ({ component, event, instance, reason })), [
      { component: 'alert', event: 'failed', instance: 'tasks', reason: 'no bot token' },
    ])
  })
})

test('a missing allowed sender exits one before any token read', async () => {
  await withAlertFixture(async (fixture) => {
    await writeFile(join(fixture.channelDirectory, 'access.json'), JSON.stringify({ policy: 'allowlist', allowFrom: [] }))
    const alertResult = await runAlertScript(fixture, ['tasks', '--dry-run'])
    assert.equal(alertResult.exitCode, 1)
    const [loggedEvent] = await readLoggedEvents(fixture.logFilePath)
    assert.equal(loggedEvent.event, 'failed')
    assert.equal(loggedEvent.reason, 'no allowed sender')
  })
})
