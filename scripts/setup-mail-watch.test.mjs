import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, readdir, readlink, stat, symlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import { readOptionalLines as readCommandLog, readOptionalText } from './file-test-helpers.mjs'
import { withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { captureTestCommand } from './process-test-helpers.mjs'

const setupScriptPath = fileURLToPath(new URL('./setup-mail-watch.sh', import.meta.url))
const installUnitsScriptPath = fileURLToPath(new URL('./install-units.sh', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const accountEmails = ['first@example.com', 'second@example.com', 'third@example.com']

async function withSetupFixture(testFunction) {
  return withTemporaryDirectory('assistant-setup-mail-watch-', async (temporaryDirectory) => {
    const homeDirectory = join(temporaryDirectory, 'home')
    const shimDirectory = join(temporaryDirectory, 'bin')
    const commandLogPath = join(temporaryDirectory, 'commands.log')
    const authorizedAccountsPath = join(temporaryDirectory, 'authorized-accounts')
    const clientSecretPath = join(temporaryDirectory, 'client-secret.json')
    await mkdir(join(homeDirectory, 'Projects'), { recursive: true })
    await mkdir(shimDirectory)
    await symlink(repositoryRoot, join(homeDirectory, 'Projects', 'assistant'))
    await writeFile(authorizedAccountsPath, JSON.stringify({ accounts: [] }))
    await writeFile(clientSecretPath, '{}')
    await writeFile(join(shimDirectory, 'gog'), `#!/usr/bin/env bash
printf 'gog %s\\n' "$*" >> "$SETUP_COMMAND_LOG"
if [[ "$1" == auth && "$2" == list ]]; then
  cat "$SETUP_AUTHORIZED_ACCOUNTS"
  exit 0
fi
if [[ "$1" == --account ]]; then
  if [[ "$SETUP_FAILING_ALIAS" == "$2" ]]; then
    exit 4
  fi
  if [[ "$SETUP_EMPTY_ALIAS" == "$2" ]]; then
    printf '{"threads":[]}\\n'
    exit 0
  fi
  printf '{"threads":[{"id":"x","snippet":"s"}]}\\n'
fi
`)
    await writeFile(join(shimDirectory, 'systemctl'), `#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >> "$SETUP_COMMAND_LOG"
if [[ "$2" == cat ]]; then
  exit 1
fi
if [[ "$2" == link ]]; then
  unitPath="$3"
  unitDirectory="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unitDirectory"
  ln -sfn "$unitPath" "$unitDirectory/\${unitPath##*/}"
fi
if [[ "$2" == disable ]]; then
  installedUnitPath="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$3"
  if [[ ! -e "$installedUnitPath" ]]; then
    exit 1
  fi
  rm -f "$installedUnitPath"
fi
`)
    await chmod(join(shimDirectory, 'gog'), 0o755)
    await chmod(join(shimDirectory, 'systemctl'), 0o755)
    await testFunction({ authorizedAccountsPath, clientSecretPath, commandLogPath, homeDirectory, shimDirectory, temporaryDirectory })
  })
}

async function seedEnvironmentFile(homeDirectory, contents = 'GOG_KEYRING_BACKEND=file\nGOG_KEYRING_PASSWORD=unprintable-test-password\n') {
  const configurationDirectory = join(homeDirectory, '.config', 'assistant')
  await mkdir(configurationDirectory, { recursive: true })
  await writeFile(join(configurationDirectory, 'gog.env'), contents)
  return join(configurationDirectory, 'gog.env')
}

function buildSetupEnvironment(fixture, overrides) {
  return {
    ...process.env,
    HOME: fixture.homeDirectory,
    XDG_CONFIG_HOME: join(fixture.homeDirectory, '.config'),
    PATH: `${fixture.shimDirectory}:${process.env.PATH}`,
    SETUP_AUTHORIZED_ACCOUNTS: fixture.authorizedAccountsPath,
    SETUP_COMMAND_LOG: fixture.commandLogPath,
    SETUP_EMPTY_ALIAS: '',
    SETUP_FAILING_ALIAS: '',
    ...overrides,
  }
}

function quoteForShell(argumentText) {
  return `'${argumentText.replaceAll("'", "'\\''")}'`
}

async function runSetupScript(fixture, setupArguments, overrides = {}) {
  const standardErrorPath = join(fixture.temporaryDirectory, 'stderr.log')
  const quotedCommand = [setupScriptPath, ...setupArguments].map(quoteForShell).join(' ')
  const terminalCommand = `bash ${quotedCommand} 2>${quoteForShell(standardErrorPath)}`
  const terminalResult = await captureTestCommand('script', ['-qfec', terminalCommand, '/dev/null'], { env: buildSetupEnvironment(fixture, overrides) })
  const capturedStandardError = await readOptionalText(standardErrorPath)
  return { stdout: terminalResult.stdout ?? '', exitCode: terminalResult.exitCode, stderr: capturedStandardError }
}

async function runSetupScriptWithPipedStandardInput(fixture, setupArguments, overrides = {}) {
  return captureTestCommand('bash', [setupScriptPath, ...setupArguments], { env: buildSetupEnvironment(fixture, overrides) })
}

async function runInstallUnitsScript(fixture, overrides = {}) {
  return captureTestCommand('bash', [installUnitsScriptPath], { env: buildSetupEnvironment(fixture, overrides) })
}

async function getSystemdUnitNames() {
  const systemdEntries = await readdir(join(repositoryRoot, 'systemd'))
  return systemdEntries.filter((entryName) => entryName.endsWith('.service') || entryName.endsWith('.timer')).sort()
}

async function assertUnitIsLinked(unitDirectory, unitName) {
  const installedUnitPath = join(unitDirectory, unitName)
  assert.ok((await lstat(installedUnitPath)).isSymbolicLink())
  assert.equal(await readlink(installedUnitPath), join(repositoryRoot, 'systemd', unitName))
}

test('installing units links every unit, reloads, enables and restarts timers, and restarts assistant', async () => {
  await withSetupFixture(async (fixture) => {
    const configurationHome = join(fixture.temporaryDirectory, 'config')
    const installResult = await runInstallUnitsScript(fixture, { XDG_CONFIG_HOME: configurationHome })
    assert.equal(installResult.exitCode, 0)
    const unitDirectory = join(configurationHome, 'systemd', 'user')
    const unitNames = await getSystemdUnitNames()
    await Promise.all(unitNames.map((unitName) => assertUnitIsLinked(unitDirectory, unitName)))
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.deepEqual(commandLines.filter((commandLine) => commandLine.includes(' link ')), unitNames.map((unitName) => `systemctl --user link ${join(repositoryRoot, 'systemd', unitName)}`))
    assert.ok(commandLines.includes('systemctl --user daemon-reload'))
    const timerNames = unitNames.filter((unitName) => unitName.endsWith('.timer'))
    assert.deepEqual(commandLines.filter((commandLine) => commandLine.includes(' enable ') || commandLine.includes(' restart ')), [
      ...timerNames.flatMap((timerName) => [
        `systemctl --user enable --now ${timerName}`,
        `systemctl --user restart ${timerName}`,
      ]),
      'systemctl --user enable assistant.service',
      'systemctl --user restart assistant.service',
      'systemctl --user enable assistant-results.service',
      'systemctl --user restart assistant-results.service',
    ])
  })
})

test('installing units warns about every local environment key when the local env file is missing', async () => {
  await withSetupFixture(async (fixture) => {
    const installResult = await runInstallUnitsScript(fixture)
    assert.equal(installResult.exitCode, 0)
    assert.match(installResult.stderr, /install: warning: .*local\.env is missing; .*ASSISTANT_RESULT_HOST ASSISTANT_RESULT_LOGIN ASSISTANT_RESULT_SELF_ADDRESSES ASSISTANT_HOME_TIME_ZONE/)
  })
})

test('installing units names each key the local env file lacks and still installs', async () => {
  await withSetupFixture(async (fixture) => {
    const configurationDirectory = join(fixture.homeDirectory, '.config', 'assistant')
    await mkdir(configurationDirectory, { recursive: true })
    await writeFile(join(configurationDirectory, 'local.env'), 'ASSISTANT_RESULT_HOST=host.example\nASSISTANT_HOME_TIME_ZONE=America/Chicago\n')
    const installResult = await runInstallUnitsScript(fixture)
    assert.equal(installResult.exitCode, 0)
    const warningLines = installResult.stderr.split('\n').filter((stderrLine) => stderrLine.startsWith('install: warning:'))
    assert.deepEqual(warningLines.map((warningLine) => warningLine.split(' ').at(-1)), ['ASSISTANT_RESULT_LOGIN', 'ASSISTANT_RESULT_SELF_ADDRESSES'])
    assert.ok((await readCommandLog(fixture.commandLogPath)).includes('systemctl --user daemon-reload'))
  })
})

test('installing units stays quiet when the local env file carries every key', async () => {
  await withSetupFixture(async (fixture) => {
    const configurationDirectory = join(fixture.homeDirectory, '.config', 'assistant')
    await mkdir(configurationDirectory, { recursive: true })
    await writeFile(join(configurationDirectory, 'local.env'), 'ASSISTANT_RESULT_HOST=host.example\nASSISTANT_RESULT_LOGIN=login@example.com\nASSISTANT_RESULT_SELF_ADDRESSES=100.64.0.1\nASSISTANT_HOME_TIME_ZONE=America/Chicago\n')
    const installResult = await runInstallUnitsScript(fixture)
    assert.equal(installResult.exitCode, 0)
    assert.doesNotMatch(installResult.stderr, /install: warning/)
  })
})

test('installing units removes stale assistant entries and preserves unrelated entries', async () => {
  await withSetupFixture(async (fixture) => {
    const unitDirectory = join(fixture.homeDirectory, '.config', 'systemd', 'user')
    await mkdir(unitDirectory, { recursive: true })
    await symlink(join(fixture.temporaryDirectory, 'missing-nudge.service'), join(unitDirectory, 'assistant-nudge@.service'))
    await mkdir(join(unitDirectory, 'assistant-dispatch@tasks.service.d'))
    await writeFile(join(unitDirectory, 'other.service'), 'unrelated')
    const installResult = await runInstallUnitsScript(fixture)
    assert.equal(installResult.exitCode, 0)
    await assert.rejects(lstat(join(unitDirectory, 'assistant-nudge@.service')))
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.ok(commandLines.includes('systemctl --user stop assistant-nudge@.service'))
    assert.ok(commandLines.includes('systemctl --user disable assistant-nudge@.service'))
    assert.equal((await stat(join(unitDirectory, 'assistant-dispatch@tasks.service.d'))).isDirectory(), true)
    assert.equal((await stat(join(unitDirectory, 'other.service'))).isFile(), true)
  })
})

test('installing units refuses to run from a checkout that is not the live one', async () => {
  await withSetupFixture(async (fixture) => {
    const homeWithoutLiveCheckout = join(fixture.temporaryDirectory, 'other-home')
    await mkdir(homeWithoutLiveCheckout)
    const installResult = await runInstallUnitsScript(fixture, { HOME: homeWithoutLiveCheckout, XDG_CONFIG_HOME: join(homeWithoutLiveCheckout, '.config') })
    assert.equal(installResult.exitCode, 1)
    assert.match(installResult.stderr, /install: refusing/)
    assert.deepEqual(await readCommandLog(fixture.commandLogPath), [])
  })
})

test('installing units disables and removes a stale timer whose unit file is gone', async () => {
  await withSetupFixture(async (fixture) => {
    const unitDirectory = join(fixture.homeDirectory, '.config', 'systemd', 'user')
    await mkdir(unitDirectory, { recursive: true })
    await symlink(join(fixture.temporaryDirectory, 'missing-old.timer'), join(unitDirectory, 'assistant-old.timer'))
    const installResult = await runInstallUnitsScript(fixture)
    assert.equal(installResult.exitCode, 0)
    await assert.rejects(lstat(join(unitDirectory, 'assistant-old.timer')))
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.ok(commandLines.includes('systemctl --user stop assistant-old.timer'))
    assert.ok(commandLines.includes('systemctl --user disable assistant-old.timer'))
    assert.ok(commandLines.includes('systemctl --user daemon-reload'))
    assert.ok(commandLines.includes('systemctl --user restart assistant.service'))
  })
})

test('installing units relinks a unit that points outside the repository', async () => {
  await withSetupFixture(async (fixture) => {
    const unitDirectory = join(fixture.homeDirectory, '.config', 'systemd', 'user')
    await mkdir(unitDirectory, { recursive: true })
    const unitName = 'assistant-watch.timer'
    await symlink(join(fixture.temporaryDirectory, 'wrong.timer'), join(unitDirectory, unitName))
    const installResult = await runInstallUnitsScript(fixture)
    assert.equal(installResult.exitCode, 0)
    await assertUnitIsLinked(unitDirectory, unitName)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.ok(commandLines.includes(`systemctl --user link ${join(repositoryRoot, 'systemd', unitName)}`))
  })
})

test('installing units leaves a correctly linked unit in place', async () => {
  await withSetupFixture(async (fixture) => {
    const unitDirectory = join(fixture.homeDirectory, '.config', 'systemd', 'user')
    await mkdir(unitDirectory, { recursive: true })
    const unitName = 'assistant-watch.timer'
    await symlink(join(repositoryRoot, 'systemd', unitName), join(unitDirectory, unitName))
    const installResult = await runInstallUnitsScript(fixture)
    assert.equal(installResult.exitCode, 0)
    await assertUnitIsLinked(unitDirectory, unitName)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.ok(commandLines.includes(`systemctl --user link ${join(repositoryRoot, 'systemd', unitName)}`) === false)
  })
})

async function writeAuthorizedAccounts(fixture, authorizedEmails) {
  await writeFile(fixture.authorizedAccountsPath, JSON.stringify({ accounts: authorizedEmails.map((accountEmail) => ({ email: accountEmail, services: ['gmail'] })) }))
}

test('usage rejects three positional arguments and a missing client secret', async () => {
  await withSetupFixture(async (fixture) => {
    const threeArgumentResult = await runSetupScript(fixture, [fixture.clientSecretPath, accountEmails[0], accountEmails[1]])
    assert.equal(threeArgumentResult.exitCode, 2)
    assert.match(threeArgumentResult.stderr, /usage:/)
    const missingClientResult = await runSetupScript(fixture, [join(fixture.temporaryDirectory, 'missing.json'), ...accountEmails])
    assert.equal(missingClientResult.exitCode, 2)
    assert.match(missingClientResult.stderr, /usage:/)
  })
})

test('fresh setup authorizes accounts, verifies mail, and enables the timer in order', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    const setupResult = await runSetupScript(fixture, [fixture.clientSecretPath, ...accountEmails])
    assert.equal(setupResult.exitCode, 0)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.deepEqual(commandLines.filter((commandLine) => commandLine.includes('auth add')), accountEmails.map((accountEmail) => `gog auth add ${accountEmail} --services gmail,calendar --gmail-scope readonly --manual`))
    assert.deepEqual(commandLines.filter((commandLine) => commandLine.includes('auth alias set')), accountEmails.map((accountEmail, accountIndex) => `gog auth alias set personal-${accountIndex + 1} ${accountEmail}`))
    assert.ok(commandLines.includes(`gog auth credentials set ${fixture.clientSecretPath}`))
    assert.ok(commandLines.includes('gog auth keyring file'))
    assert.ok(commandLines.includes('gog auth doctor --check'))
    assert.deepEqual(commandLines.filter((commandLine) => commandLine.includes('gmail search')), accountEmails.map((accountEmail, accountIndex) => `gog --account personal-${accountIndex + 1} gmail search newer_than:7d --max 1 --json`))
    const unitNames = await getSystemdUnitNames()
    const timerNames = unitNames.filter((unitName) => unitName.endsWith('.timer'))
    assert.deepEqual(commandLines.filter((commandLine) => commandLine.startsWith('systemctl')), [
      ...unitNames.map((unitName) => `systemctl --user link ${join(repositoryRoot, 'systemd', unitName)}`),
      'systemctl --user daemon-reload',
      ...timerNames.flatMap((timerName) => [
        `systemctl --user enable --now ${timerName}`,
        `systemctl --user restart ${timerName}`,
      ]),
      'systemctl --user enable assistant.service',
      'systemctl --user restart assistant.service',
      'systemctl --user enable assistant-results.service',
      'systemctl --user restart assistant-results.service',
    ])
    assert.match(setupResult.stdout, /next watch ticks at :04 :19 :34 :49/)
  })
})

test('an authorized rerun skips adds and still sets every alias', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    await writeAuthorizedAccounts(fixture, accountEmails)
    const setupResult = await runSetupScript(fixture, ['--skip-timer', fixture.clientSecretPath, ...accountEmails])
    assert.equal(setupResult.exitCode, 0)
    assert.match(setupResult.stderr, /setup: personal-1 was authorized earlier; if that was before calendar writes, rerun with --reauth/)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.equal(commandLines.filter((commandLine) => commandLine.includes('auth add')).length, 0)
    assert.equal(commandLines.filter((commandLine) => commandLine.includes('auth alias set')).length, 3)
  })
})

test('an authorized address that merely contains the wanted one is not treated as authorized', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    await writeAuthorizedAccounts(fixture, accountEmails.map((accountEmail) => `not-${accountEmail}.uk`))
    const setupResult = await runSetupScript(fixture, ['--skip-timer', fixture.clientSecretPath, ...accountEmails])
    assert.equal(setupResult.exitCode, 0)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.equal(commandLines.filter((commandLine) => commandLine.includes('auth add')).length, 3)
  })
})

test('reauthentication adds every account even when all are authorized', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    await writeAuthorizedAccounts(fixture, accountEmails)
    const setupResult = await runSetupScript(fixture, ['--reauth', '--skip-timer', fixture.clientSecretPath, ...accountEmails])
    assert.equal(setupResult.exitCode, 0)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.equal(commandLines.filter((commandLine) => commandLine.includes('auth add')).length, 3)
  })
})

test('an account with no recent mail is reported as reachable and still enables the timer', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    const setupResult = await runSetupScript(fixture, [fixture.clientSecretPath, ...accountEmails], { SETUP_EMPTY_ALIAS: 'personal-2' })
    assert.equal(setupResult.exitCode, 0)
    assert.match(setupResult.stdout, /setup: personal-2 reachable, no mail in the last 7 days/)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.ok(commandLines.includes('systemctl --user enable --now assistant-watch.timer'))
  })
})

test('a failing mail search stops before systemctl and names the failed alias', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    const setupResult = await runSetupScript(fixture, [fixture.clientSecretPath, ...accountEmails], { SETUP_FAILING_ALIAS: 'personal-2' })
    assert.equal(setupResult.exitCode, 1)
    assert.match(setupResult.stderr, /verification failed for personal-2/)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.equal(commandLines.filter((commandLine) => commandLine.startsWith('systemctl')).length, 0)
  })
})

test('skip timer makes no systemctl calls and promises no watch ticks', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    const setupResult = await runSetupScript(fixture, ['--skip-timer', fixture.clientSecretPath, ...accountEmails])
    assert.equal(setupResult.exitCode, 0)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.equal(commandLines.filter((commandLine) => commandLine.startsWith('systemctl')).length, 0)
    assert.doesNotMatch(setupResult.stdout, /next watch ticks/)
  })
})

test('standard input that is not a terminal exits 2 before any gog call', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    const setupResult = await runSetupScriptWithPipedStandardInput(fixture, ['--skip-timer', fixture.clientSecretPath, ...accountEmails])
    assert.equal(setupResult.exitCode, 2)
    assert.match(setupResult.stderr, /terminal/)
    assert.deepEqual(await readCommandLog(fixture.commandLogPath), [])
  })
})

test('an environment file readable beyond its owner is secured', async () => {
  await withSetupFixture(async (fixture) => {
    const environmentFile = await seedEnvironmentFile(fixture.homeDirectory)
    await chmod(environmentFile, 0o644)
    const setupResult = await runSetupScript(fixture, ['--skip-timer', fixture.clientSecretPath, ...accountEmails])
    assert.equal(setupResult.exitCode, 0)
    assert.equal((await stat(environmentFile)).mode & 0o777, 0o600)
  })
})

test('keyring environment contents never appear in setup output', async () => {
  await withSetupFixture(async (fixture) => {
    const secretEnvironmentContents = 'GOG_KEYRING_BACKEND=file\nGOG_KEYRING_PASSWORD=never-print-this-secret\n'
    await seedEnvironmentFile(fixture.homeDirectory, secretEnvironmentContents)
    const setupResult = await runSetupScript(fixture, ['--skip-timer', fixture.clientSecretPath, ...accountEmails])
    assert.equal(setupResult.exitCode, 0)
    assert.doesNotMatch(`${setupResult.stdout}${setupResult.stderr}`, /never-print-this-secret/)
  })
})
