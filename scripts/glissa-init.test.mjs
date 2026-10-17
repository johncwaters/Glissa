import assert from 'node:assert/strict'
import { chmod, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { captureTestCommand, executeTestCommand } from './process-test-helpers.mjs'
import { readJsonFile } from './json-file.mjs'
import { resolveRepositoryPath } from './repository-path.mjs'

const botToken = '123456:fixture-secret-token'

async function withInitFixture(runTest) {
  await withTemporaryDirectory('glissa-init-', async (temporaryDirectory) => {
    const configDirectory = join(temporaryDirectory, 'config')
    const dataDirectory = join(temporaryDirectory, 'data')
    const stateDirectory = join(temporaryDirectory, 'state')
    const channelDirectory = join(temporaryDirectory, 'telegram')
    const shimDirectory = join(temporaryDirectory, 'bin')
    const commandsPath = join(temporaryDirectory, 'commands.jsonl')
    const answersPath = join(temporaryDirectory, 'answers.json')
    await mkdir(shimDirectory)
    await mkdir(channelDirectory)
    await writeFile(join(channelDirectory, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['999'], groups: { '-123': { requireMention: true } } }))
    const shimSource = `#!${process.execPath}
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.INIT_COMMANDS_PATH, JSON.stringify({ command: process.argv[1].split('/').at(-1), arguments: process.argv.slice(2) }) + '\\n')
process.exit(Number(process.env.INIT_COMMAND_EXIT_CODE || 0))
`
    for (const command of ['mail-setup', 'claude', 'systemctl']) {
      await writeFile(join(shimDirectory, command), shimSource, { mode: 0o755 })
    }
    const answers = {
      operator: { name: 'Ada', pronouns: 'she/her' },
      homeTimeZone: 'America/Denver',
      accounts: ['home=ada@example.com', 'work=ada@example.org'],
      modules: ['content', 'changelog', 'digest'],
      changelog: { productName: 'Example', productDescription: 'A project', changelogFile: '/tmp/example.md' },
      digest: { newsletterSender: 'news@example.com', workContext: 'Tools' },
      clientSecretFile: join(temporaryDirectory, 'client-secret.json'),
      botToken,
    }
    await writeFile(answersPath, JSON.stringify(answers))
    await writeFile(answers.clientSecretFile, '{}')
    const requests = []
    const pairing = { printedCode: undefined }
    const server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const parameters = JSON.parse(Buffer.concat(chunks).toString())
      const method = request.url.split('/').at(-1)
      requests.push({ method, parameters })
      response.setHeader('content-type', 'application/json')
      if (method === 'getMe') {
        response.end(JSON.stringify({ ok: true, result: { id: 123456, username: 'fixture_glissa_bot', is_bot: true } }))
        return
      }
      if (method === 'getUpdates' && parameters.offset === -1) {
        const strangerBacklog = { update_id: 41, message: { date: Math.floor(Date.now() / 1_000) - 3_600, chat: { type: 'private', id: 4242 }, from: { id: 4242, is_bot: false, first_name: 'Stranger' }, text: 'hello' } }
        response.end(JSON.stringify({ ok: true, result: [strangerBacklog] }))
        return
      }
      if (method === 'getUpdates') {
        while (parameters.timeout > 0 && !pairing.printedCode) await delay(10)
        const wrongCode = String((Number(pairing.printedCode) + 1) % 1_000_000).padStart(6, '0')
        const updates = parameters.timeout === 0 ? [] : [
          { update_id: 42, message: { chat: { type: 'group', id: -123 }, from: { id: 88 }, text: pairing.printedCode } },
          { update_id: 43, message: { chat: { type: 'private', id: 4242 }, from: { id: 4242, is_bot: false, first_name: 'Stranger' }, text: wrongCode } },
          { update_id: 44, message: { chat: { type: 'private', id: 777 }, from: { id: 777, is_bot: false, username: 'ada' }, text: ` ${pairing.printedCode} ` } },
        ]
        response.end(JSON.stringify({ ok: true, result: updates }))
        return
      }
      if (method === 'sendMessage') {
        response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }))
        return
      }
      response.writeHead(404).end()
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const environment = {
      ...process.env,
      HOME: temporaryDirectory,
      XDG_CONFIG_HOME: join(temporaryDirectory, 'xdg-config'),
      GLISSA_CONFIG_DIR: configDirectory,
      GLISSA_DATA_DIR: dataDirectory,
      GLISSA_STATE_DIR: stateDirectory,
      GLISSA_TELEGRAM_CHANNEL_DIR: channelDirectory,
      GLISSA_TELEGRAM_API_BASE: `http://127.0.0.1:${server.address().port}`,
      GLISSA_SETUP_MAIL_WATCH: join(shimDirectory, 'mail-setup'),
      GLISSA_CLAUDE_COMMAND: join(shimDirectory, 'claude'),
      GLISSA_LOG_FILE: join(temporaryDirectory, 'glissa.jsonl'),
      INIT_COMMANDS_PATH: commandsPath,
      PATH: `${shimDirectory}:${process.env.PATH}`,
    }
    const fixture = {
      temporaryDirectory, configDirectory, dataDirectory, stateDirectory, channelDirectory,
      answers, answersPath, commandsPath, requests, environment,
      run(argumentsList = [], packageRoot = resolveRepositoryPath(), overrides = {}) {
        pairing.printedCode = undefined
        const execution = executeTestCommand(process.execPath, [join(packageRoot, 'bin', 'glissa.mjs'), 'init', '--answers', answersPath, ...argumentsList], { env: { ...environment, ...overrides } })
        let printedText = ''
        execution.child.stdout.on('data', (chunk) => {
          printedText += chunk
          pairing.printedCode = /send (\d{6}) to @/.exec(printedText)?.[1]
        })
        return execution.then((completed) => ({ ...completed, exitCode: 0 }), (error) => ({ stdout: error.stdout, stderr: error.stderr, exitCode: error.code }))
      },
    }
    try {
      await runTest(fixture)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
}

test('init pairs an installed copy, verifies accounts, seeds valid profiles, and reconfigures without overwriting facts', async (context) => {
  await withInitFixture(async (fixture) => {
    const installedRoot = join(fixture.temporaryDirectory, 'package')
    await mkdir(installedRoot)
    for (const directory of ['bin', 'scripts', 'prompts', 'profile-template', 'systemd']) {
      await cp(resolveRepositoryPath(directory), join(installedRoot, directory), { recursive: true })
    }
    await cp(resolveRepositoryPath('package.json'), join(installedRoot, 'package.json'))
    const initialized = await fixture.run([], installedRoot)
    for (const line of initialized.stdout.split('\n').filter((line) => line.startsWith('init: '))) context.diagnostic(line)
    assert.equal(initialized.exitCode, 0, initialized.stdout + initialized.stderr)
    assert.ok(!`${initialized.stdout}${initialized.stderr}`.includes(botToken))
    const configPath = join(fixture.configDirectory, 'config.json')
    const config = await readJsonFile(configPath)
    assert.deepEqual(config, {
      operator: { name: 'Ada', pronouns: 'she/her', formOfAddress: 'Ada' },
      homeTimeZone: fixture.answers.homeTimeZone,
      accounts: [{ alias: 'home', email: 'ada@example.com' }, { alias: 'work', email: 'ada@example.org' }],
      modules: fixture.answers.modules, changelog: fixture.answers.changelog, digest: fixture.answers.digest,
    })
    const tokenPath = join(fixture.channelDirectory, '.env')
    const accessPath = join(fixture.channelDirectory, 'access.json')
    assert.equal(await readFile(tokenPath, 'utf8'), `TELEGRAM_BOT_TOKEN=${botToken}\n`)
    assert.deepEqual(await readJsonFile(accessPath), { dmPolicy: 'allowlist', allowFrom: ['777'], groups: { '-123': { requireMention: true } } })
    for (const filePath of [configPath, tokenPath, accessPath]) assert.equal((await stat(filePath)).mode & 0o777, 0o600)
    for (const directory of [fixture.configDirectory, fixture.channelDirectory]) assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.deepEqual(fixture.requests, [
      { method: 'getMe', parameters: {} },
      { method: 'getUpdates', parameters: { offset: -1, timeout: 0 } },
      { method: 'getUpdates', parameters: { offset: 42, timeout: 30 } },
      { method: 'getUpdates', parameters: { offset: 45, timeout: 0 } },
      { method: 'sendMessage', parameters: { chat_id: '777', text: 'Paired with Glissa' } },
      { method: 'getMe', parameters: {} },
    ])
    const commands = (await readFile(fixture.commandsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(commands.slice(0, 2), [
      { command: 'mail-setup', arguments: ['--skip-timer', fixture.answers.clientSecretFile, ...fixture.answers.accounts] },
      { command: 'claude', arguments: ['--version'] },
    ])
    assert.ok(commands.some((command) => command.command === 'systemctl' && command.arguments.join(' ') === '--user restart glissa.service'))
    assert.match(initialized.stdout, /init: Telegram paired: ok with 777 \(@ada\)/)
    assert.match(initialized.stdout, /init: Google home: ok/)
    assert.match(initialized.stdout, /init: Google work: ok/)
    const profileDirectory = join(fixture.dataDirectory, 'memory', 'profile')
    assert.deepEqual((await readdir(profileDirectory)).sort(), ['digital.md', 'health.md', 'household.md', 'travel.md', 'work.md'])
    const memoryCheck = await captureTestCommand(process.execPath, [resolveRepositoryPath('scripts', 'memory-check.mjs'), 'snapshot'], { env: fixture.environment })
    assert.equal(memoryCheck.exitCode, 0, memoryCheck.stderr)
    assert.match(memoryCheck.stdout, /5 files/)
    const markerPath = join(fixture.stateDirectory, 'first-start')
    assert.ok((await stat(markerPath)).isFile())
    const profilePath = join(profileDirectory, 'work.md')
    const profileText = (await readFile(profilePath, 'utf8')).replace('- Employer: ?', '- Employer: Example (stated 2026-10-17)')
    await writeFile(profilePath, profileText)
    await chmod(configPath, 0o644)
    await writeFile(fixture.answersPath, JSON.stringify({ accounts: [], modules: [], botToken }))
    const reconfigured = await fixture.run(['--reconfigure'])
    assert.equal(reconfigured.exitCode, 0, reconfigured.stdout + reconfigured.stderr)
    assert.match(reconfigured.stdout, /run glissa deploy from your checkout/)
    assert.deepEqual((await readJsonFile(configPath)).operator, config.operator)
    assert.deepEqual((await readJsonFile(configPath)).accounts, [])
    assert.equal((await stat(configPath)).mode & 0o777, 0o600)
    assert.equal(await readFile(profilePath, 'utf8'), profileText)
    assert.equal((await readFile(fixture.commandsPath, 'utf8')).trim().split('\n').filter((line) => JSON.parse(line).command === 'mail-setup').length, 1)
  })
})

test('init refuses an existing config without reconfigure', async () => {
  await withInitFixture(async (fixture) => {
    await mkdir(fixture.configDirectory)
    const configPath = join(fixture.configDirectory, 'config.json')
    await writeFile(configPath, 'existing config')
    const refused = await fixture.run()
    assert.equal(refused.exitCode, 1)
    assert.match(refused.stdout, /Config already exists; use --reconfigure/)
    assert.equal(await readFile(configPath, 'utf8'), 'existing config')
    assert.deepEqual(fixture.requests, [])
  })
})

test('init refuses pairing while bot.pid names a live process', async () => {
  await withInitFixture(async (fixture) => {
    await writeFile(join(fixture.channelDirectory, 'bot.pid'), String(process.pid))
    const refused = await fixture.run()
    assert.equal(refused.exitCode, 1)
    assert.match(refused.stdout, /bot.pid names a live process/)
    assert.deepEqual(fixture.requests, [])
    await assert.rejects(stat(join(fixture.configDirectory, 'config.json')), { code: 'ENOENT' })
  })
})

test('init validates answers before writing and propagates Google setup failures', async () => {
  await withInitFixture(async (fixture) => {
    const invalidAnswers = [
      { homeTimeZone: 'Invalid/Zone' },
      { accounts: ['Bad_alias=ada@example.com'] },
      { accounts: null },
      { digest: {} },
    ]
    for (const invalidFields of invalidAnswers) {
      await writeFile(fixture.answersPath, JSON.stringify({ ...fixture.answers, ...invalidFields }))
      const refused = await fixture.run()
      assert.equal(refused.exitCode, 1, refused.stdout)
      assert.ok(!`${refused.stdout}${refused.stderr}`.includes(botToken))
      await assert.rejects(stat(join(fixture.configDirectory, 'config.json')), { code: 'ENOENT' })
      assert.deepEqual(fixture.requests, [])
    }
    await writeFile(fixture.answersPath, JSON.stringify(fixture.answers))
    const googleFailure = await fixture.run([], resolveRepositoryPath(), { INIT_COMMAND_EXIT_CODE: '7' })
    assert.equal(googleFailure.exitCode, 7)
    assert.match(googleFailure.stdout, /Required command exited 7/)
    assert.deepEqual(fixture.requests, [])
    const skippedGoogle = await fixture.run(['--reconfigure', '--skip-google'])
    assert.equal(skippedGoogle.exitCode, 0, skippedGoogle.stdout + skippedGoogle.stderr)
    assert.match(skippedGoogle.stdout, /Google setup skipped/)
    assert.deepEqual((await readJsonFile(join(fixture.configDirectory, 'config.json'))).accounts, [
      { alias: 'home', email: 'ada@example.com' }, { alias: 'work', email: 'ada@example.org' },
    ])
    const commands = (await readFile(fixture.commandsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(commands.filter(({ command }) => command === 'mail-setup').length, 1)
    assert.ok((await stat(join(fixture.stateDirectory, 'first-start'))).isFile())
  })
})
