import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import { readOptionalLines as readCommandLog } from './file-test-helpers.mjs'
import { withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { captureTestCommand } from './process-test-helpers.mjs'

const wrapperScriptPath = fileURLToPath(new URL('./gog-calendar.sh', import.meta.url))
const keyringEnvironmentContents = 'GOG_KEYRING_BACKEND=file\nGOG_KEYRING_PASSWORD=never-print-this-secret\n'

async function withWrapperFixture(testFunction) {
  return withTemporaryDirectory('assistant-calendar-wrapper-', async (temporaryDirectory) => {
    const homeDirectory = join(temporaryDirectory, 'home')
    const shimDirectory = join(temporaryDirectory, 'bin')
    const commandLogPath = join(temporaryDirectory, 'commands.log')
    await mkdir(homeDirectory)
    await mkdir(shimDirectory)
    await writeFile(join(shimDirectory, 'gog'), `#!/usr/bin/env bash
printf 'gog %s\\n' "$*" >> "$WRAPPER_COMMAND_LOG"
printf 'keyring %s\\n' "$GOG_KEYRING_PASSWORD" >> "$WRAPPER_COMMAND_LOG"
`)
    await chmod(join(shimDirectory, 'gog'), 0o755)
    await testFunction({ commandLogPath, homeDirectory, shimDirectory })
  })
}

async function seedEnvironmentFile(homeDirectory, fileMode = 0o600) {
  const configurationDirectory = join(homeDirectory, '.config', 'assistant')
  await mkdir(configurationDirectory, { recursive: true })
  const environmentFilePath = join(configurationDirectory, 'gog.env')
  await writeFile(environmentFilePath, keyringEnvironmentContents)
  await chmod(environmentFilePath, fileMode)
  return environmentFilePath
}

async function runWrapper(fixture, wrapperArguments) {
  return captureTestCommand('bash', [wrapperScriptPath, ...wrapperArguments], {
    env: {
      ...process.env,
      HOME: fixture.homeDirectory,
      PATH: `${fixture.shimDirectory}:${process.env.PATH}`,
      WRAPPER_COMMAND_LOG: fixture.commandLogPath,
    },
  })
}

test('a calendar read reaches gog with the account flag intact and the keyring password loaded', async () => {
  await withWrapperFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    const wrapperResult = await runWrapper(fixture, ['--account', 'personal-1', 'calendar', 'events', 'primary', '--json'])
    assert.equal(wrapperResult.exitCode, 0)
    assert.deepEqual(await readCommandLog(fixture.commandLogPath), [
      'gog --account personal-1 calendar events primary --json',
      'keyring never-print-this-secret',
    ])
  })
})

test('a calendar delete reaches gog with every flag it was given', async () => {
  await withWrapperFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    const wrapperResult = await runWrapper(fixture, ['calendar', 'delete', 'primary', 'event-1', '--send-updates', 'none', '--original-start', '2027-03-02T09:00:00'])
    assert.equal(wrapperResult.exitCode, 0)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.equal(commandLines[0], 'gog calendar delete primary event-1 --send-updates none --original-start 2027-03-02T09:00:00')
  })
})

test('an environment file readable beyond its owner refuses before reaching gog', async () => {
  await withWrapperFixture(async (fixture) => {
    const environmentFilePath = await seedEnvironmentFile(fixture.homeDirectory, 0o644)
    const wrapperResult = await runWrapper(fixture, ['calendar', 'events', 'primary'])
    assert.equal(wrapperResult.exitCode, 1)
    assert.match(wrapperResult.stderr, new RegExp(`Refusing to read ${environmentFilePath}`))
    assert.match(wrapperResult.stderr, /readable beyond the owner/)
    assert.doesNotMatch(wrapperResult.stderr, /never-print-this-secret/)
    assert.deepEqual(await readCommandLog(fixture.commandLogPath), [])
  })
})

test('a missing environment file still runs the calendar command', async () => {
  await withWrapperFixture(async (fixture) => {
    const wrapperResult = await runWrapper(fixture, ['calendar', 'events', 'primary'])
    assert.equal(wrapperResult.exitCode, 0)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.equal(commandLines[0], 'gog calendar events primary')
  })
})
