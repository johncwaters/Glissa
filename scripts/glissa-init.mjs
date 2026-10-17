import { spawn } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { stdin, stdout } from 'node:process'
import { isMainModule, runCommandLine } from './command-line.mjs'
import { findConfigProblems, resolveGlissaConfigDirectory } from './glissa-config.mjs'
import { resolveGlissaStateDirectory } from './glissa-state-directory.mjs'
import { readJsonFile } from './json-file.mjs'
import { resolveGlissaDataDirectory, resolveRepositoryPath } from './repository-path.mjs'
import { resolveGlissaDirectories } from './serve.mjs'

const moduleSettingFields = {
  changelog: ['productName', 'productDescription', 'changelogFile', 'capturesDirectory'],
  digest: ['newsletterSender', 'workContext'],
}

function parseOptions(commandArguments) {
  const options = {}
  for (let argumentIndex = 0; argumentIndex < commandArguments.length; argumentIndex += 1) {
    const argument = commandArguments[argumentIndex]
    if (argument === '--answers' && !options.answersFile && commandArguments[argumentIndex + 1] && !commandArguments[argumentIndex + 1].startsWith('--')) {
      options.answersFile = commandArguments[++argumentIndex]
      continue
    }
    if (argument === '--reconfigure' && !options.reconfigure) {
      options.reconfigure = true
      continue
    }
    if (argument === '--skip-google' && !options.skipGoogle) {
      options.skipGoogle = true
      continue
    }
    throw new Error('usage: glissa init [--answers <file.json>] [--reconfigure] [--skip-google]')
  }
  return options
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function makePrivateDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 })
  await chmod(directoryPath, 0o700)
}

async function writePrivateFileAtomically(filePath, contents) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, contents, { mode: 0o600, flag: 'wx' })
  try {
    await rename(temporaryPath, filePath)
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function parseAccounts(accounts) {
  if (typeof accounts === 'string') return parseAccounts(accounts.split(/[\s,]+/).filter(Boolean))
  if (!Array.isArray(accounts)) return accounts
  return accounts.map((account) => {
    if (typeof account !== 'string') return account
    const pairMatch = /^([a-z0-9][a-z0-9-]*)=([^=]+)$/.exec(account)
    if (!pairMatch) throw new Error('Accounts must be alias=email pairs with lowercase letters, digits, and hyphens in aliases')
    return { alias: pairMatch[1], email: pairMatch[2] }
  })
}

function buildConfig(answers) {
  const operator = answers.operator ?? {}
  return {
    operator: { ...operator, formOfAddress: operator.formOfAddress ?? operator.name },
    homeTimeZone: answers.homeTimeZone === undefined ? Intl.DateTimeFormat().resolvedOptions().timeZone : answers.homeTimeZone,
    accounts: parseAccounts(answers.accounts === undefined ? [] : answers.accounts),
    modules: typeof answers.modules === 'string' ? answers.modules.split(',').map((name) => name.trim()).filter(Boolean) : answers.modules === undefined ? [] : answers.modules,
    ...(answers.changelog === undefined ? {} : { changelog: answers.changelog }),
    ...(answers.digest === undefined ? {} : { digest: answers.digest }),
  }
}

function createPrompter() {
  let isSecret = false
  const promptOutput = new Writable({
    write(chunk, encoding, done) {
      if (!isSecret) stdout.write(chunk, encoding)
      done()
    },
  })
  const readline = createInterface({ input: stdin, output: promptOutput, terminal: true })
  return {
    async ask(label, defaultValue = '') {
      const answer = await readline.question(`${label}${defaultValue ? ` [${defaultValue}]` : ''}: `)
      return answer.trim() || defaultValue
    },
    async askToken() {
      stdout.write('Telegram bot token from @BotFather: ')
      isSecret = true
      try {
        return (await readline.question('')).trim()
      } finally {
        isSecret = false
        stdout.write('\n')
      }
    },
    close() { readline.close() },
  }
}

async function askConfig(prompter, previousAnswers) {
  const name = await prompter.ask('Operator name', previousAnswers.operator?.name)
  const pronouns = await prompter.ask('Pronouns', previousAnswers.operator?.pronouns)
  const formOfAddress = await prompter.ask('Form of address', previousAnswers.operator?.formOfAddress ?? name)
  const homeTimeZone = await prompter.ask('Home time zone', previousAnswers.homeTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const previousAccounts = previousAnswers.accounts ?? []
  const accountPairs = typeof previousAccounts === 'string' ? previousAccounts : previousAccounts.map((account) => typeof account === 'string' ? account : `${account.alias}=${account.email}`).join(',')
  const accounts = await prompter.ask('Accounts (alias=email pairs, or none)', accountPairs)
  const previousModules = previousAnswers.modules ?? []
  const modules = await prompter.ask('Modules (content,changelog,digest, or none)', Array.isArray(previousModules) ? previousModules.join(',') : previousModules)
  const answers = {
    operator: { name, pronouns, formOfAddress }, homeTimeZone,
    accounts: accounts === 'none' ? [] : accounts,
    modules: modules === 'none' ? [] : modules.split(',').map((moduleName) => moduleName.trim()).filter(Boolean),
  }
  for (const moduleName of answers.modules) {
    const settingFields = moduleSettingFields[moduleName]
    if (!settingFields) continue
    answers[moduleName] = {}
    for (const fieldName of settingFields) {
      const settingValue = await prompter.ask(`${moduleName}.${fieldName}`, previousAnswers[moduleName]?.[fieldName])
      if (settingValue) answers[moduleName][fieldName] = settingValue
    }
  }
  return answers
}

async function refuseLivePoller(channelDirectory) {
  const processIdText = (await readOptionalFile(join(channelDirectory, 'bot.pid')))?.trim()
  if (!/^\d+$/.test(processIdText ?? '')) return
  const processId = Number(processIdText)
  if (!Number.isSafeInteger(processId) || processId < 1) return
  try {
    process.kill(processId, 0)
  } catch (error) {
    if (error.code === 'ESRCH') return
    if (error.code !== 'EPERM') throw error
  }
  throw new Error('Telegram bot.pid names a live process; stop the poller before pairing')
}

async function runChild(command, commandArguments, environment, stdio = 'inherit') {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, commandArguments, { env: environment, stdio })
    child.once('error', () => reject(new Error('Required command could not start')))
    child.once('close', (code) => resolve(code ?? 1))
  })
  if (exitCode !== 0) throw Object.assign(new Error(`Required command exited ${exitCode}`), { exitCode })
}

function createTelegramClient(token, environment) {
  const apiBase = (environment.GLISSA_TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '')
  return async (method, parameters = {}, timeoutMs = 35_000) => {
    try {
      const response = await fetch(`${apiBase}/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parameters), signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error('HTTP failure')
      const envelope = await response.json()
      if (!envelope.ok) throw new Error('API failure')
      return envelope.result
    } catch {
      throw new Error(`Telegram ${method} failed`)
    }
  }
}

function describeTelegramSender(sender) {
  const senderName = typeof sender.username === 'string' && sender.username ? `@${sender.username}` : String(sender.first_name ?? 'no name')
  return senderName.replace(/\p{Cc}/gu, '')
}

async function pairTelegram({ telegram, channelDirectory, token, report }) {
  await refuseLivePoller(channelDirectory)
  const bot = await telegram('getMe')
  if (!/^[a-zA-Z0-9_]+$/.test(bot?.username ?? '')) throw new Error('Telegram getMe returned no valid bot username')
  await makePrivateDirectory(channelDirectory)
  await writePrivateFileAtomically(join(channelDirectory, '.env'), `TELEGRAM_BOT_TOKEN=${token}\n`)
  const backlogUpdates = await telegram('getUpdates', { offset: -1, timeout: 0 })
  if (!Array.isArray(backlogUpdates)) throw new Error('Telegram getUpdates returned invalid updates')
  let offset = 0
  for (const update of backlogUpdates) {
    if (Number.isSafeInteger(update.update_id)) offset = Math.max(offset, update.update_id + 1)
  }
  const pairingCode = String(randomInt(0, 1_000_000)).padStart(6, '0')
  report(`send ${pairingCode} to @${bot.username} from your own Telegram account`)
  const pairingDeadlineMs = Date.now() + 10 * 60_000
  while (true) {
    const longPollSeconds = Math.min(30, Math.floor((pairingDeadlineMs - Date.now() - 5_000) / 1_000))
    if (longPollSeconds <= 0) throw new Error('Telegram pairing timed out after 10 minutes')
    const updates = await telegram('getUpdates', { offset, timeout: longPollSeconds }, (longPollSeconds + 5) * 1_000)
    if (!Array.isArray(updates)) throw new Error('Telegram getUpdates returned invalid updates')
    for (const update of updates) {
      if (!Number.isSafeInteger(update.update_id)) continue
      offset = Math.max(offset, update.update_id + 1)
      const message = update.message
      if (message?.chat?.type !== 'private' || message.from?.is_bot || !Number.isSafeInteger(message.from?.id) || message.from.id < 1) continue
      if (typeof message.text !== 'string' || message.text.trim() !== pairingCode) continue
      const accessPath = join(channelDirectory, 'access.json')
      const previousAccessText = await readOptionalFile(accessPath)
      const previousAccess = previousAccessText === undefined ? {} : JSON.parse(previousAccessText)
      const chatId = String(message.from.id)
      const groups = Object.hasOwn(previousAccess, 'groups') ? previousAccess.groups : {}
      await writePrivateFileAtomically(accessPath, jsonText({ dmPolicy: 'allowlist', allowFrom: [chatId], groups }))
      await telegram('getUpdates', { offset, timeout: 0 })
      await telegram('sendMessage', { chat_id: chatId, text: 'Paired with Glissa' })
      report(`Telegram paired: ok with ${chatId} (${describeTelegramSender(message.from)})`)
      return
    }
  }
}

async function seedProfiles(dataDirectory) {
  const profileDirectory = join(dataDirectory, 'memory', 'profile')
  await makePrivateDirectory(profileDirectory)
  const templateDirectory = resolveRepositoryPath('profile-template')
  for (const templateName of await readdir(templateDirectory)) {
    try {
      await copyFile(join(templateDirectory, templateName), join(profileDirectory, templateName), constants.COPYFILE_EXCL)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
}

export async function main(commandArguments, { environment = process.env } = {}) {
  const report = (message) => console.log(`init: ${message}`)
  let prompter
  let token
  try {
    const options = parseOptions(commandArguments)
    const configDirectory = resolveGlissaConfigDirectory(environment)
    const configPath = join(configDirectory, 'config.json')
    const previousConfigText = await readOptionalFile(configPath)
    if (previousConfigText !== undefined && !options.reconfigure) throw new Error('Config already exists; use --reconfigure')
    report(options.reconfigure ? 'reconfigure' : 'new configuration')
    const { channelDirectory } = resolveGlissaDirectories(environment)
    await refuseLivePoller(channelDirectory)
    if (!options.answersFile && (!stdin.isTTY || !stdout.isTTY)) throw new Error('Use a terminal or --answers <file.json>')
    if (!options.answersFile) prompter = createPrompter()
    const previousConfig = previousConfigText === undefined ? {} : JSON.parse(previousConfigText)
    const suppliedAnswers = options.answersFile ? await readJsonFile(options.answersFile) : {}
    token = suppliedAnswers.botToken
    let answers = { ...previousConfig, ...suppliedAnswers, operator: { ...previousConfig.operator, ...suppliedAnswers.operator } }
    let config
    while (true) {
      if (prompter) answers = await askConfig(prompter, answers)
      try {
        config = buildConfig(answers)
        const problems = findConfigProblems(config)
        if (problems.length > 0) throw new Error(problems.join('; '))
        break
      } catch (error) {
        if (!prompter) throw error
        report(error.message)
      }
    }
    await makePrivateDirectory(configDirectory)
    await writePrivateFileAtomically(configPath, jsonText(config))
    report('configuration saved')
    if (config.accounts.length > 0 && !options.skipGoogle) {
      const clientSecretFile = prompter ? await prompter.ask('Google OAuth client secret file') : answers.clientSecretFile
      if (typeof clientSecretFile !== 'string' || !clientSecretFile.trim()) throw new Error('clientSecretFile is required for Google setup')
      prompter?.close()
      prompter = undefined
      report('authorizing Google accounts')
      await runChild(environment.GLISSA_SETUP_MAIL_WATCH || resolveRepositoryPath('scripts', 'setup-mail-watch.sh'), ['--skip-timer', clientSecretFile, ...config.accounts.map(({ alias, email }) => `${alias}=${email}`)], environment)
      for (const { alias } of config.accounts) report(`Google ${alias}: ok`)
    }
    if (config.accounts.length === 0 || options.skipGoogle) report('Google setup skipped')
    if (!options.answersFile && !prompter) prompter = createPrompter()
    token = prompter ? await prompter.askToken() : answers.botToken
    prompter?.close()
    prompter = undefined
    if (typeof token !== 'string' || !/^\d+:[a-zA-Z0-9_-]+$/.test(token)) throw new Error('A valid Telegram botToken from @BotFather is required')
    const telegram = createTelegramClient(token, environment)
    await pairTelegram({ telegram, channelDirectory, token, report })
    const dataDirectory = resolveGlissaDataDirectory(environment)
    await mkdir(dataDirectory, { recursive: true })
    await seedProfiles(dataDirectory)
    report('profile templates seeded')
    const stateDirectory = resolveGlissaStateDirectory(environment)
    await makePrivateDirectory(stateDirectory)
    await writePrivateFileAtomically(join(stateDirectory, 'first-start'), '')
    report('first-start marker created')
    const configProblems = findConfigProblems(await readJsonFile(configPath))
    if (configProblems.length > 0) throw new Error(configProblems.join('; '))
    report('config check: ok')
    await runChild(environment.GLISSA_CLAUDE_COMMAND || 'claude', ['--version'], environment, 'ignore')
    report('claude --version: ok')
    await telegram('getMe')
    report('Telegram getMe: ok')
    const gitEntry = await lstat(resolveRepositoryPath('.git')).catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (gitEntry) {
      report('run glissa deploy from your checkout to install the services')
      return 0
    }
    report('installing services')
    await runChild(resolveRepositoryPath('scripts', 'install-units.sh'), [], environment)
    report('services installed: ok')
    return 0
  } catch (error) {
    const failureMessage = error instanceof SyntaxError ? 'Invalid JSON in init input or channel state' : error.message
    const message = typeof token === 'string' && token ? failureMessage.replaceAll(token, '[redacted]') : failureMessage
    report(message)
    return error.exitCode || 1
  } finally {
    prompter?.close()
  }
}

if (isMainModule(import.meta.url)) runCommandLine(main)
