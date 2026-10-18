import assert from 'node:assert/strict'
import { chmod, copyFile, cp, lstat, mkdir, readdir, readFile, readlink, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import { readOptionalLines as readCommandLog, readOptionalText } from './file-test-helpers.mjs'
import { createTemporaryDirectoryRemovedAfterTest, withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { captureTestCommand } from './process-test-helpers.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const installedPackageRoot = createTemporaryDirectoryRemovedAfterTest('glissa-installed-package-')
await cp(join(repositoryRoot, 'scripts'), join(installedPackageRoot, 'scripts'), { recursive: true })
await cp(join(repositoryRoot, 'systemd'), join(installedPackageRoot, 'systemd'), { recursive: true })
const setupScriptPath = join(installedPackageRoot, 'scripts', 'setup-mail-watch.sh')
const installUnitsScriptPath = join(installedPackageRoot, 'scripts', 'install-units.sh')
const glissaBinaryPath = join(repositoryRoot, 'bin', 'glissa.mjs')
const accountEmails = ['first@example.com', 'second@example.com', 'third@example.com']
const accountPairs = accountEmails.map((accountEmail, accountIndex) => `personal-${accountIndex + 1}=${accountEmail}`)

async function withSetupFixture(testFunction) {
  return withTemporaryDirectory('glissa-setup-mail-watch-', async (temporaryDirectory) => {
    const homeDirectory = join(temporaryDirectory, 'home')
    const shimDirectory = join(temporaryDirectory, 'bin')
    const commandLogPath = join(temporaryDirectory, 'commands.log')
    const authorizedAccountsPath = join(temporaryDirectory, 'authorized-accounts')
    const clientSecretPath = join(temporaryDirectory, 'client-secret.json')
    const configDirectory = join(homeDirectory, '.config', 'glissa')
    await mkdir(configDirectory, { recursive: true })
    await mkdir(shimDirectory)
    const config = JSON.parse(await readFile(join(repositoryRoot, 'config.example.json'), 'utf8'))
    config.modules = ['content', 'changelog']
    await writeFile(join(configDirectory, 'config.json'), JSON.stringify(config))
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
  const configurationDirectory = join(homeDirectory, '.config', 'glissa')
  await mkdir(configurationDirectory, { recursive: true })
  await writeFile(join(configurationDirectory, 'gog.env'), contents)
  return join(configurationDirectory, 'gog.env')
}

function buildSetupEnvironment(fixture, overrides) {
  return {
    ...process.env,
    HOME: fixture.homeDirectory,
    XDG_CONFIG_HOME: join(fixture.homeDirectory, '.config'),
    GLISSA_CONFIG_DIR: join(fixture.homeDirectory, '.config', 'glissa'),
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
  return captureTestCommand('bash', [installUnitsScriptPath], { cwd: fixture.temporaryDirectory, env: buildSetupEnvironment(fixture, overrides) })
}

async function getSystemdUnitNames() {
  const systemdEntries = await readdir(join(installedPackageRoot, 'systemd'))
  return systemdEntries.filter((entryName) => entryName.endsWith('.service') || entryName.endsWith('.timer')).sort()
}

async function assertUnitIsLinked(unitDirectory, unitName) {
  const installedUnitPath = join(unitDirectory, unitName)
  assert.ok((await lstat(installedUnitPath)).isSymbolicLink())
  assert.equal(await readlink(installedUnitPath), join(installedPackageRoot, 'systemd', unitName))
}

test('installing units links every unit, reloads, restarts glissa, then enables and restarts timers', async () => {
  await withSetupFixture(async (fixture) => {
    const configurationHome = join(fixture.temporaryDirectory, 'config')
    const checkoutInstallResult = await captureTestCommand('bash', [join(repositoryRoot, 'scripts', 'install-units.sh')], { env: buildSetupEnvironment(fixture, { XDG_CONFIG_HOME: configurationHome }) })
    assert.equal(checkoutInstallResult.exitCode, 1)
    assert.match(checkoutInstallResult.stderr, /glissa deploy/)
    assert.deepEqual(await readCommandLog(fixture.commandLogPath), [])
    const installResult = await runInstallUnitsScript(fixture, { XDG_CONFIG_HOME: configurationHome })
    assert.equal(installResult.exitCode, 0)
    const unitDirectory = join(configurationHome, 'systemd', 'user')
    const unitNames = await getSystemdUnitNames()
    await Promise.all(unitNames.map((unitName) => assertUnitIsLinked(unitDirectory, unitName)))
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.deepEqual(commandLines.filter((commandLine) => commandLine.includes(' link ')), unitNames.map((unitName) => `systemctl --user link ${join(installedPackageRoot, 'systemd', unitName)}`))
    assert.ok(commandLines.includes('systemctl --user daemon-reload'))
    const timerNames = unitNames.filter((unitName) => unitName.endsWith('.timer'))
    assert.deepEqual(commandLines.filter((commandLine) => commandLine.includes(' enable ') || commandLine.includes(' restart ')), [
      'systemctl --user enable glissa.service',
      'systemctl --user restart glissa.service',
      'systemctl --user enable glissa-results.service',
      'systemctl --user restart glissa-results.service',
      ...timerNames.flatMap((timerName) => [
        `systemctl --user enable --now ${timerName}`,
        `systemctl --user restart ${timerName}`,
      ]),
    ])
  })
})

test('installing units warns about every local environment key when the local env file is missing', async () => {
  await withSetupFixture(async (fixture) => {
    const installResult = await runInstallUnitsScript(fixture)
    assert.equal(installResult.exitCode, 0)
    assert.match(installResult.stderr, /install: warning: .*local\.env is missing; .*GLISSA_RESULT_HOST GLISSA_RESULT_LOGIN GLISSA_RESULT_SELF_ADDRESSES GLISSA_HOME_TIME_ZONE/)
  })
})

test('installing units names each key the local env file lacks and still installs', async () => {
  await withSetupFixture(async (fixture) => {
    const configurationDirectory = join(fixture.homeDirectory, '.config', 'glissa')
    await mkdir(configurationDirectory, { recursive: true })
    await writeFile(join(configurationDirectory, 'local.env'), 'GLISSA_RESULT_HOST=host.example\nGLISSA_HOME_TIME_ZONE=America/Chicago\n')
    const installResult = await runInstallUnitsScript(fixture)
    assert.equal(installResult.exitCode, 0)
    const warningLines = installResult.stderr.split('\n').filter((stderrLine) => stderrLine.startsWith('install: warning:'))
    assert.deepEqual(warningLines.map((warningLine) => warningLine.split(' ').at(-1)), ['GLISSA_RESULT_LOGIN', 'GLISSA_RESULT_SELF_ADDRESSES'])
    assert.ok((await readCommandLog(fixture.commandLogPath)).includes('systemctl --user daemon-reload'))
  })
})

test('installing units stays quiet when the local env file carries every key', async () => {
  await withSetupFixture(async (fixture) => {
    const configurationDirectory = join(fixture.homeDirectory, '.config', 'glissa')
    await mkdir(configurationDirectory, { recursive: true })
    await writeFile(join(configurationDirectory, 'local.env'), 'GLISSA_RESULT_HOST=host.example\nGLISSA_RESULT_LOGIN=login@example.com\nGLISSA_RESULT_SELF_ADDRESSES=100.64.0.1\nGLISSA_HOME_TIME_ZONE=America/Chicago\n')
    const installResult = await runInstallUnitsScript(fixture)
    assert.equal(installResult.exitCode, 0)
    assert.doesNotMatch(installResult.stderr, /install: warning/)
  })
})

test('installing units removes stale glissa entries and preserves unrelated entries', async () => {
  await withSetupFixture(async (fixture) => {
    const unitDirectory = join(fixture.homeDirectory, '.config', 'systemd', 'user')
    await mkdir(unitDirectory, { recursive: true })
    await symlink(join(fixture.temporaryDirectory, 'missing-nudge.service'), join(unitDirectory, 'glissa-nudge@.service'))
    await mkdir(join(unitDirectory, 'glissa-dispatch@tasks.service.d'))
    await writeFile(join(unitDirectory, 'other.service'), 'unrelated')
    const installResult = await runInstallUnitsScript(fixture)
    assert.equal(installResult.exitCode, 0)
    await assert.rejects(lstat(join(unitDirectory, 'glissa-nudge@.service')))
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.ok(commandLines.includes('systemctl --user stop glissa-nudge@.service'))
    assert.ok(commandLines.includes('systemctl --user disable glissa-nudge@.service'))
    assert.equal((await stat(join(unitDirectory, 'glissa-dispatch@tasks.service.d'))).isDirectory(), true)
    assert.equal((await stat(join(unitDirectory, 'other.service'))).isFile(), true)
  })
})

test('installing units removes every legacy service and timer link before restarting Glissa', async () => {
  await withSetupFixture(async (fixture) => {
    const unitDirectory = join(fixture.homeDirectory, '.config', 'systemd', 'user')
    await mkdir(unitDirectory, { recursive: true })
    const unitNames = await getSystemdUnitNames()
    const legacyUnitNames = unitNames.map((unitName) => unitName.replace(/^glissa/, 'assistant'))
    for (const [unitIndex, legacyUnitName] of legacyUnitNames.entries()) {
      const linkTarget = legacyUnitName.endsWith('.timer')
        ? join(fixture.temporaryDirectory, legacyUnitName)
        : join(installedPackageRoot, 'systemd', unitNames[unitIndex])
      await symlink(linkTarget, join(unitDirectory, legacyUnitName))
    }
    const installResult = await runInstallUnitsScript(fixture)
    assert.equal(installResult.exitCode, 0)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    const restartIndex = commandLines.indexOf('systemctl --user restart glissa.service')
    assert.ok(restartIndex >= 0)
    for (const legacyUnitName of legacyUnitNames) {
      await assert.rejects(lstat(join(unitDirectory, legacyUnitName)), { code: 'ENOENT' })
      assert.ok(commandLines.includes(`systemctl --user stop ${legacyUnitName}`))
      const disableIndex = commandLines.indexOf(`systemctl --user disable ${legacyUnitName}`)
      assert.ok(disableIndex >= 0 && disableIndex < restartIndex)
    }
    await Promise.all(unitNames.map((unitName) => assertUnitIsLinked(unitDirectory, unitName)))
  })
})

test('installing units skips and removes the changelog timer when its module is off and refuses an unreadable config', async () => {
  await withSetupFixture(async (fixture) => {
    const configurationHome = join(fixture.temporaryDirectory, 'other-config')
    const configDirectory = join(configurationHome, 'glissa')
    const unitDirectory = join(configurationHome, 'systemd', 'user')
    await mkdir(configDirectory, { recursive: true })
    const config = JSON.parse(await readFile(join(repositoryRoot, 'config.example.json'), 'utf8'))
    await writeFile(join(configDirectory, 'config.json'), JSON.stringify(config))
    for (const configOverride of [configDirectory, '']) {
      await mkdir(unitDirectory, { recursive: true })
      await symlink(join(installedPackageRoot, 'systemd', 'glissa-changelog.timer'), join(unitDirectory, 'glissa-changelog.timer'))
      await writeFile(fixture.commandLogPath, '')
      const installResult = await runInstallUnitsScript(fixture, { XDG_CONFIG_HOME: configurationHome, GLISSA_CONFIG_DIR: configOverride })
      assert.equal(installResult.exitCode, 0, installResult.stderr)
      await assert.rejects(lstat(join(unitDirectory, 'glissa-changelog.timer')), { code: 'ENOENT' })
      await assertUnitIsLinked(unitDirectory, 'glissa-watch.timer')
      const changelogCommands = (await readCommandLog(fixture.commandLogPath)).filter((commandLine) => commandLine.includes('glissa-changelog.timer'))
      assert.deepEqual(changelogCommands, ['systemctl --user stop glissa-changelog.timer', 'systemctl --user disable glissa-changelog.timer'])
    }
    await writeFile(fixture.commandLogPath, '')
    const unreadableConfigResult = await runInstallUnitsScript(fixture, { XDG_CONFIG_HOME: configurationHome, GLISSA_CONFIG_DIR: join(configurationHome, 'missing') })
    assert.equal(unreadableConfigResult.exitCode, 1)
    assert.match(unreadableConfigResult.stderr, /No Glissa config/)
    assert.deepEqual(await readCommandLog(fixture.commandLogPath), [])
  })
})

test('the glissa script command creates its data directory, inherits arguments and cwd, and passes through exit codes', async () => {
  await withSetupFixture(async (fixture) => {
    const packageDirectory = join(fixture.temporaryDirectory, 'package')
    const dataDirectory = join(fixture.temporaryDirectory, 'new-data')
    await mkdir(join(packageDirectory, 'bin'), { recursive: true })
    await mkdir(join(packageDirectory, 'scripts'))
    await copyFile(glissaBinaryPath, join(packageDirectory, 'bin', 'glissa.mjs'))
    for (const scriptName of ['command-line.mjs', 'repository-path.mjs']) {
      await copyFile(join(repositoryRoot, 'scripts', scriptName), join(packageDirectory, 'scripts', scriptName))
    }
    await writeFile(join(packageDirectory, 'scripts', 'probe.mjs'), "console.log(JSON.stringify({ cwd: process.cwd(), arguments: process.argv.slice(2) })); process.exitCode = 7\n")
    await writeFile(join(packageDirectory, 'scripts', 'probe.sh'), '#!/usr/bin/env bash\nprintf "%s\\n" "$PWD" "$1"\nexit 5\n')
    for (const scriptName of ['probe.mjs', 'probe.sh']) {
      const execution = await captureTestCommand(process.execPath, [join(packageDirectory, 'bin', 'glissa.mjs'), 'script', scriptName, 'two words'], {
        env: buildSetupEnvironment(fixture, { GLISSA_DATA_DIR: dataDirectory }),
      })
      assert.equal(execution.exitCode, scriptName.endsWith('.mjs') ? 7 : 5, execution.stderr)
      assert.match(execution.stdout, /two words/)
      assert.ok(execution.stdout.includes(dataDirectory))
      assert.ok((await stat(dataDirectory)).isDirectory())
    }
    for (const scriptName of ['../probe.mjs', 'probe..mjs', 'missing.mjs']) {
      const execution = await captureTestCommand(process.execPath, [glissaBinaryPath, 'script', scriptName], {
        env: buildSetupEnvironment(fixture, { GLISSA_DATA_DIR: dataDirectory }),
      })
      assert.notEqual(execution.exitCode, 0)
    }
    await writeFile(join(packageDirectory, 'scripts', 'serve.mjs'), 'console.log(JSON.stringify(process.env))\n')
    const channelDirectory = join(fixture.temporaryDirectory, 'dev-channel')
    await mkdir(channelDirectory)
    await writeFile(join(channelDirectory, '.env'), 'TELEGRAM_BOT_TOKEN=second-bot\n')
    const execution = await captureTestCommand(process.execPath, [join(packageDirectory, 'bin', 'glissa.mjs'), 'run', '--dev'], {
      env: buildSetupEnvironment(fixture, {
        GLISSA_DATA_DIR: '',
        GLISSA_STATE_DIR: '',
        GLISSA_RUNTIME_DIR: '',
        GLISSA_DEV_TELEGRAM_DIR: channelDirectory,
        XDG_DATA_HOME: join(fixture.temporaryDirectory, 'data-home'),
        XDG_RUNTIME_DIR: join(fixture.temporaryDirectory, 'runtime'),
        TELEGRAM_STATE_DIR: '',
        TELEGRAM_BOT_TOKEN: 'live-token-from-shell',
        TELEGRAM_ACCESS_MODE: 'static',
      }),
    })
    assert.equal(execution.exitCode, 0, execution.stderr)
    const launchedEnvironment = JSON.parse(execution.stdout.trim().split('\n').at(-1))
    assert.equal(launchedEnvironment.TELEGRAM_BOT_TOKEN, undefined)
    assert.equal(launchedEnvironment.TELEGRAM_ACCESS_MODE, undefined)
    const scratchDirectory = join(fixture.temporaryDirectory, 'data-home', 'glissa-dev')
    assert.equal(launchedEnvironment.GLISSA_DATA_DIR, scratchDirectory)
    assert.equal(launchedEnvironment.TELEGRAM_STATE_DIR, channelDirectory)
    assert.equal(launchedEnvironment.GLISSA_TELEGRAM_CHANNEL_DIR, channelDirectory)
    assert.equal(launchedEnvironment.GLISSA_STATE_DIR, join(scratchDirectory, 'state'))
    assert.equal(launchedEnvironment.GLISSA_RUNTIME_DIR, join(fixture.temporaryDirectory, 'runtime', 'glissa-dev'))
    assert.ok((await stat(scratchDirectory)).isDirectory())
  })
})

test('glissa deploy archives a commit, installs its release and rollback through npm, and prunes only after success', async () => {
  await withSetupFixture(async (fixture) => {
    const globalPackageDirectory = join(fixture.temporaryDirectory, 'global')
    const releasesDirectory = join(fixture.temporaryDirectory, 'data', 'releases')
    await mkdir(join(globalPackageDirectory, 'glissa', 'scripts'), { recursive: true })
    await mkdir(releasesDirectory, { recursive: true })
    await writeFile(join(globalPackageDirectory, 'glissa', 'scripts', 'install-units.sh'), 'printf "installed units\\n" >> "$SETUP_COMMAND_LOG"\n')
    await writeFile(join(fixture.shimDirectory, 'npm'), `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const commandArguments = process.argv.slice(2)
appendFileSync(process.env.SETUP_COMMAND_LOG, JSON.stringify(commandArguments) + '\\n')
if (commandArguments[0] === 'root') {
  console.log(process.env.SETUP_GLOBAL_DIRECTORY)
  process.exit(0)
}
if (commandArguments[0] === 'pack') {
  if (existsSync('.git') || JSON.parse(readFileSync('package.json')).name !== 'glissa') process.exit(9)
  writeFileSync(join(commandArguments.at(-1), 'glissa-0.0.0.tgz'), 'packed archive')
  console.log(JSON.stringify([{ filename: 'glissa-0.0.0.tgz' }]))
  process.exit(0)
}
if (commandArguments[0] === 'install' && commandArguments[1] === '-g' && existsSync(commandArguments[2])) process.exit(Number(process.env.SETUP_INSTALL_EXIT_CODE || 0))
process.exit(9)
`)
    await chmod(join(fixture.shimDirectory, 'npm'), 0o755)
    const environment = buildSetupEnvironment(fixture, {
      GLISSA_DATA_DIR: join(fixture.temporaryDirectory, 'data'),
      SETUP_GLOBAL_DIRECTORY: globalPackageDirectory,
    })
    for (let releaseIndex = 0; releaseIndex < 6; releaseIndex += 1) {
      const releasePath = join(releasesDirectory, `older-${releaseIndex}.tgz`)
      await writeFile(releasePath, 'older release')
      await utimes(releasePath, releaseIndex + 1, releaseIndex + 1)
    }
    const failedInstall = await captureTestCommand(process.execPath, [glissaBinaryPath, 'deploy', '--tarball', join(releasesDirectory, 'older-5.tgz')], {
      cwd: repositoryRoot, env: { ...environment, SETUP_INSTALL_EXIT_CODE: '6' },
    })
    assert.equal(failedInstall.exitCode, 6, failedInstall.stderr)
    assert.equal((await readdir(releasesDirectory)).length, 6)
    assert.ok(!(await readCommandLog(fixture.commandLogPath)).includes('installed units'))
    await writeFile(fixture.commandLogPath, '')
    const deployment = await captureTestCommand(process.execPath, [glissaBinaryPath, 'deploy', 'HEAD'], { cwd: join(repositoryRoot, 'scripts'), env: environment })
    assert.equal(deployment.exitCode, 0, deployment.stderr)
    const commit = await captureTestCommand('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })
    const releasePath = join(releasesDirectory, `glissa-${commit.stdout.trim().slice(0, 12)}.tgz`)
    assert.equal(await readFile(releasePath, 'utf8'), 'packed archive')
    assert.equal((await readdir(releasesDirectory)).length, 5)
    await assert.rejects(stat(join(releasesDirectory, 'older-0.tgz')), { code: 'ENOENT' })
    const rollback = await captureTestCommand(process.execPath, [glissaBinaryPath, 'deploy', '--tarball', join(releasesDirectory, 'older-5.tgz')], { cwd: repositoryRoot, env: environment })
    assert.equal(rollback.exitCode, 0, rollback.stderr)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.deepEqual(commandLines, [
      JSON.stringify(['pack', '--json', '--pack-destination', releasesDirectory]),
      JSON.stringify(['install', '-g', releasePath]),
      JSON.stringify(['root', '-g']),
      'installed units',
      JSON.stringify(['install', '-g', join(releasesDirectory, 'older-5.tgz')]),
      JSON.stringify(['root', '-g']),
      'installed units',
    ])
  })
})

test('glissa run --dev refuses the live Telegram directory, its aliases, copies, and the live token before starting a poller', async () => {
  await withSetupFixture(async (fixture) => {
    const liveDirectory = join(fixture.homeDirectory, '.claude', 'channels', 'telegram')
    const otherLiveDirectory = join(fixture.temporaryDirectory, 'other-live')
    const aliasDirectory = join(fixture.temporaryDirectory, 'alias')
    await mkdir(liveDirectory, { recursive: true })
    await mkdir(otherLiveDirectory)
    await symlink(liveDirectory, aliasDirectory)
    for (const channelDirectory of [liveDirectory, otherLiveDirectory, aliasDirectory]) {
      const execution = await captureTestCommand(process.execPath, [glissaBinaryPath, 'run', '--dev'], {
        env: buildSetupEnvironment(fixture, {
          GLISSA_DATA_DIR: join(fixture.temporaryDirectory, 'scratch'),
          GLISSA_DEV_TELEGRAM_DIR: channelDirectory,
          CLAUDE_CONFIG_DIR: '',
          TELEGRAM_STATE_DIR: otherLiveDirectory,
        }),
      })
      assert.equal(execution.exitCode, 1)
      assert.match(execution.stderr, /refuses the live Telegram channel directory/)
    }
    const configDirectoryLiveChannel = join(fixture.temporaryDirectory, 'claude-config', 'channels', 'telegram')
    await mkdir(configDirectoryLiveChannel, { recursive: true })
    const configDirectoryExecution = await captureTestCommand(process.execPath, [glissaBinaryPath, 'run', '--dev'], {
      env: buildSetupEnvironment(fixture, { CLAUDE_CONFIG_DIR: join(fixture.temporaryDirectory, 'claude-config'), TELEGRAM_STATE_DIR: '', GLISSA_DEV_TELEGRAM_DIR: configDirectoryLiveChannel }),
    })
    assert.equal(configDirectoryExecution.exitCode, 1)
    assert.match(configDirectoryExecution.stderr, /refuses the live Telegram channel directory/)
    await writeFile(join(liveDirectory, '.env'), 'TELEGRAM_BOT_TOKEN=111:LIVE\n')
    await writeFile(join(liveDirectory, 'bot.pid'), '4242')
    const copiedDirectory = join(fixture.temporaryDirectory, 'copied-live')
    await cp(liveDirectory, copiedDirectory, { recursive: true })
    const separateDirectory = join(fixture.temporaryDirectory, 'separate')
    await mkdir(separateDirectory)
    await writeFile(join(separateDirectory, '.env'), 'TELEGRAM_BOT_TOKEN=live-token-from-shell\n')
    const copiedDirectoryWithOwnToken = join(fixture.temporaryDirectory, 'copied-live-own-token')
    await cp(liveDirectory, copiedDirectoryWithOwnToken, { recursive: true })
    await writeFile(join(copiedDirectoryWithOwnToken, '.env'), 'TELEGRAM_BOT_TOKEN=222:DEV\n')
    for (const [channelDirectory, expectedRefusal] of [[copiedDirectory, /needs its own token/], [separateDirectory, /needs its own token/], [copiedDirectoryWithOwnToken, /bot\.pid is the live poller's/]]) {
      const execution = await captureTestCommand(process.execPath, [glissaBinaryPath, 'run', '--dev'], {
        env: buildSetupEnvironment(fixture, {
          GLISSA_DATA_DIR: join(fixture.temporaryDirectory, 'scratch'),
          GLISSA_DEV_TELEGRAM_DIR: channelDirectory,
          CLAUDE_CONFIG_DIR: '',
          TELEGRAM_STATE_DIR: '',
          TELEGRAM_BOT_TOKEN: 'live-token-from-shell',
        }),
      })
      assert.equal(execution.exitCode, 1)
      assert.match(execution.stderr, expectedRefusal)
    }
    const execution = await captureTestCommand(process.execPath, [glissaBinaryPath, 'run', '--dev'], {
      env: buildSetupEnvironment(fixture, { GLISSA_DEV_TELEGRAM_DIR: join(fixture.temporaryDirectory, 'unconfigured') }),
    })
    assert.equal(execution.exitCode, 1)
    assert.match(execution.stderr, /TELEGRAM_BOT_TOKEN=/)
  })
})

test('installing units disables and removes a stale timer whose unit file is gone', async () => {
  await withSetupFixture(async (fixture) => {
    const unitDirectory = join(fixture.homeDirectory, '.config', 'systemd', 'user')
    await mkdir(unitDirectory, { recursive: true })
    await symlink(join(fixture.temporaryDirectory, 'missing-old.timer'), join(unitDirectory, 'glissa-old.timer'))
    const installResult = await runInstallUnitsScript(fixture)
    assert.equal(installResult.exitCode, 0)
    await assert.rejects(lstat(join(unitDirectory, 'glissa-old.timer')))
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.ok(commandLines.includes('systemctl --user stop glissa-old.timer'))
    assert.ok(commandLines.includes('systemctl --user disable glissa-old.timer'))
    assert.ok(commandLines.includes('systemctl --user daemon-reload'))
    assert.ok(commandLines.includes('systemctl --user restart glissa.service'))
  })
})

test('installing units relinks a unit that points outside the repository', async () => {
  await withSetupFixture(async (fixture) => {
    const unitDirectory = join(fixture.homeDirectory, '.config', 'systemd', 'user')
    await mkdir(unitDirectory, { recursive: true })
    const unitName = 'glissa-watch.timer'
    await symlink(join(fixture.temporaryDirectory, 'wrong.timer'), join(unitDirectory, unitName))
    const installResult = await runInstallUnitsScript(fixture)
    assert.equal(installResult.exitCode, 0)
    await assertUnitIsLinked(unitDirectory, unitName)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.ok(commandLines.includes(`systemctl --user link ${join(installedPackageRoot, 'systemd', unitName)}`))
  })
})

test('installing units leaves a correctly linked unit in place', async () => {
  await withSetupFixture(async (fixture) => {
    const unitDirectory = join(fixture.homeDirectory, '.config', 'systemd', 'user')
    await mkdir(unitDirectory, { recursive: true })
    const unitName = 'glissa-watch.timer'
    await symlink(join(installedPackageRoot, 'systemd', unitName), join(unitDirectory, unitName))
    const installResult = await runInstallUnitsScript(fixture)
    assert.equal(installResult.exitCode, 0)
    await assertUnitIsLinked(unitDirectory, unitName)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.ok(commandLines.includes(`systemctl --user link ${join(installedPackageRoot, 'systemd', unitName)}`) === false)
  })
})

async function writeAuthorizedAccounts(fixture, authorizedEmails) {
  await writeFile(fixture.authorizedAccountsPath, JSON.stringify({ accounts: authorizedEmails.map((accountEmail) => ({ email: accountEmail, services: ['gmail'] })) }))
}

test('usage rejects malformed pairs and a missing client secret', async () => {
  await withSetupFixture(async (fixture) => {
    for (const malformedPair of ['missing-pair', 'Bad_alias=first@example.com', 'home=', '=first@example.com']) {
      const malformedPairResult = await runSetupScript(fixture, [fixture.clientSecretPath, malformedPair])
      assert.equal(malformedPairResult.exitCode, 2)
      assert.match(malformedPairResult.stderr, /usage:/)
    }
    const missingClientResult = await runSetupScript(fixture, [join(fixture.temporaryDirectory, 'missing.json'), ...accountPairs])
    assert.equal(missingClientResult.exitCode, 2)
    assert.match(missingClientResult.stderr, /usage:/)
  })
})

test('a single account uses its supplied alias for authorization and verification', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    const setupResult = await runSetupScript(fixture, ['--skip-timer', fixture.clientSecretPath, 'home=first@example.com'])
    assert.equal(setupResult.exitCode, 0, setupResult.stderr)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.deepEqual(commandLines.filter((line) => line.includes('auth alias set')), ['gog auth alias set home first@example.com'])
    assert.deepEqual(commandLines.filter((line) => line.includes('gmail search')), ['gog --account home gmail search newer_than:7d --max 1 --json'])
  })
})

test('fresh setup authorizes accounts, verifies mail, and enables the timer in order', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    const setupResult = await runSetupScript(fixture, [fixture.clientSecretPath, ...accountPairs])
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
      ...unitNames.map((unitName) => `systemctl --user link ${join(installedPackageRoot, 'systemd', unitName)}`),
      'systemctl --user daemon-reload',
      'systemctl --user enable glissa.service',
      'systemctl --user restart glissa.service',
      'systemctl --user enable glissa-results.service',
      'systemctl --user restart glissa-results.service',
      ...timerNames.flatMap((timerName) => [
        `systemctl --user enable --now ${timerName}`,
        `systemctl --user restart ${timerName}`,
      ]),
    ])
    assert.match(setupResult.stdout, /next watch ticks at :04 :19 :34 :49/)
  })
})

test('an authorized rerun skips adds and still sets every alias', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    await writeAuthorizedAccounts(fixture, accountEmails)
    const setupResult = await runSetupScript(fixture, ['--skip-timer', fixture.clientSecretPath, ...accountPairs])
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
    const setupResult = await runSetupScript(fixture, ['--skip-timer', fixture.clientSecretPath, ...accountPairs])
    assert.equal(setupResult.exitCode, 0)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.equal(commandLines.filter((commandLine) => commandLine.includes('auth add')).length, 3)
  })
})

test('reauthentication adds every account even when all are authorized', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    await writeAuthorizedAccounts(fixture, accountEmails)
    const setupResult = await runSetupScript(fixture, ['--reauth', '--skip-timer', fixture.clientSecretPath, ...accountPairs])
    assert.equal(setupResult.exitCode, 0)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.equal(commandLines.filter((commandLine) => commandLine.includes('auth add')).length, 3)
  })
})

test('an account with no recent mail is reported as reachable and still enables the timer', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    const setupResult = await runSetupScript(fixture, [fixture.clientSecretPath, ...accountPairs], { SETUP_EMPTY_ALIAS: 'personal-2' })
    assert.equal(setupResult.exitCode, 0)
    assert.match(setupResult.stdout, /setup: personal-2 reachable, no mail in the last 7 days/)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.ok(commandLines.includes('systemctl --user enable --now glissa-watch.timer'))
  })
})

test('a failing mail search stops before systemctl and names the failed alias', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    const setupResult = await runSetupScript(fixture, [fixture.clientSecretPath, ...accountPairs], { SETUP_FAILING_ALIAS: 'personal-2' })
    assert.equal(setupResult.exitCode, 1)
    assert.match(setupResult.stderr, /verification failed for personal-2/)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.equal(commandLines.filter((commandLine) => commandLine.startsWith('systemctl')).length, 0)
  })
})

test('skip timer makes no systemctl calls and promises no watch ticks', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    const setupResult = await runSetupScript(fixture, ['--skip-timer', fixture.clientSecretPath, ...accountPairs])
    assert.equal(setupResult.exitCode, 0)
    const commandLines = await readCommandLog(fixture.commandLogPath)
    assert.equal(commandLines.filter((commandLine) => commandLine.startsWith('systemctl')).length, 0)
    assert.doesNotMatch(setupResult.stdout, /next watch ticks/)
  })
})

test('standard input that is not a terminal exits 2 before any gog call', async () => {
  await withSetupFixture(async (fixture) => {
    await seedEnvironmentFile(fixture.homeDirectory)
    const setupResult = await runSetupScriptWithPipedStandardInput(fixture, ['--skip-timer', fixture.clientSecretPath, ...accountPairs])
    assert.equal(setupResult.exitCode, 2)
    assert.match(setupResult.stderr, /terminal/)
    assert.deepEqual(await readCommandLog(fixture.commandLogPath), [])
  })
})

test('an environment file readable beyond its owner is secured', async () => {
  await withSetupFixture(async (fixture) => {
    const environmentFile = await seedEnvironmentFile(fixture.homeDirectory)
    await chmod(environmentFile, 0o644)
    const setupResult = await runSetupScript(fixture, ['--skip-timer', fixture.clientSecretPath, ...accountPairs])
    assert.equal(setupResult.exitCode, 0)
    assert.equal((await stat(environmentFile)).mode & 0o777, 0o600)
  })
})

test('keyring environment contents never appear in setup output', async () => {
  await withSetupFixture(async (fixture) => {
    const secretEnvironmentContents = 'GOG_KEYRING_BACKEND=file\nGOG_KEYRING_PASSWORD=never-print-this-secret\n'
    await seedEnvironmentFile(fixture.homeDirectory, secretEnvironmentContents)
    const setupResult = await runSetupScript(fixture, ['--skip-timer', fixture.clientSecretPath, ...accountPairs])
    assert.equal(setupResult.exitCode, 0)
    assert.doesNotMatch(`${setupResult.stdout}${setupResult.stderr}`, /never-print-this-secret/)
  })
})
