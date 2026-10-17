#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { constants, homedir, tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommandLine } from '../scripts/command-line.mjs'
import { canonicalDirectory, resolveGlissaDataDirectory } from '../scripts/repository-path.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

function usage() {
  console.error('usage: glissa serve | script <file> [args...] | deploy [<ref>] [--tarball <path>] | migrate --from <checkout> [--to <data directory>] [--dry-run] | install-units | run --dev')
  return 2
}

function runChild(command, commandArguments, { cwd, env = process.env, capture = false } = {}) {
  return new Promise((resolveChild, reject) => {
    const child = spawn(command, commandArguments, { cwd, env, stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit' })
    let stdout = ''
    if (capture) child.stdout.on('data', (chunk) => { stdout += chunk })
    const forwardTermination = () => child.kill('SIGTERM')
    const forwardInterrupt = () => child.kill('SIGINT')
    process.on('SIGTERM', forwardTermination)
    process.on('SIGINT', forwardInterrupt)
    function removeSignalHandlers() {
      process.off('SIGTERM', forwardTermination)
      process.off('SIGINT', forwardInterrupt)
    }
    child.once('error', (error) => {
      removeSignalHandlers()
      reject(error)
    })
    child.once('close', (exitCode, signal) => {
      removeSignalHandlers()
      resolveChild({ exitCode: exitCode ?? 128 + constants.signals[signal], stdout: stdout.trim() })
    })
  })
}

async function runDeployStep(message, command, commandArguments, options) {
  console.log(`deploy: ${message}`)
  const execution = await runChild(command, commandArguments, options)
  if (execution.exitCode !== 0) throw Object.assign(new Error(`${command} exited ${execution.exitCode}`), { exitCode: execution.exitCode })
  return execution.stdout
}

async function pruneReleases(releasesDirectory) {
  const releaseNames = (await readdir(releasesDirectory)).filter((releaseName) => releaseName.endsWith('.tgz'))
  const releases = await Promise.all(releaseNames.map(async (releaseName) => {
    const releasePath = join(releasesDirectory, releaseName)
    return { releasePath, modifiedAtMs: (await stat(releasePath)).mtimeMs }
  }))
  releases.sort((first, second) => second.modifiedAtMs - first.modifiedAtMs)
  for (const release of releases.slice(5)) await rm(release.releasePath)
}

async function deploy(commandArguments) {
  let reference = 'main'
  let hasReference = false
  let tarballPath
  for (let argumentIndex = 0; argumentIndex < commandArguments.length; argumentIndex += 1) {
    const argument = commandArguments[argumentIndex]
    if (argument === '--tarball') {
      if (tarballPath || !commandArguments[argumentIndex + 1] || commandArguments[argumentIndex + 1].startsWith('-')) return usage()
      tarballPath = resolve(commandArguments[++argumentIndex])
      continue
    }
    if (argument.startsWith('-') || hasReference) return usage()
    reference = argument
    hasReference = true
  }
  const checkoutRoot = await runDeployStep('locate checkout', 'git', ['rev-parse', '--show-toplevel'], { capture: true })
  const checkoutPackage = JSON.parse(await readFile(join(checkoutRoot, 'package.json'), 'utf8'))
  if (checkoutPackage.name !== 'glissa') throw new Error('deploy requires a Glissa git checkout')
  const releasesDirectory = join(resolveGlissaDataDirectory(), 'releases')
  await mkdir(releasesDirectory, { recursive: true })
  if (!tarballPath) {
    const commitSha = await runDeployStep(`resolve ${reference}`, 'git', ['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`], { cwd: checkoutRoot, capture: true })
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'glissa-deploy-'))
    try {
      const archivePath = join(temporaryDirectory, 'source.tar')
      const sourceDirectory = join(temporaryDirectory, 'source')
      await mkdir(sourceDirectory)
      await runDeployStep(`archive ${commitSha}`, 'git', ['archive', '--format=tar', '-o', archivePath, commitSha], { cwd: checkoutRoot })
      await runDeployStep('extract archive', 'tar', ['-xf', archivePath, '-C', sourceDirectory])
      const packOutput = await runDeployStep('pack release', 'npm', ['pack', '--json', '--pack-destination', releasesDirectory], { cwd: sourceDirectory, capture: true })
      const [packedRelease] = JSON.parse(packOutput)
      tarballPath = join(releasesDirectory, `glissa-${commitSha.slice(0, 12)}.tgz`)
      await rename(join(releasesDirectory, basename(packedRelease.filename)), tarballPath)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
  await runDeployStep(`install ${tarballPath}`, 'npm', ['install', '-g', tarballPath])
  const globalPackageDirectory = await runDeployStep('locate installed package', 'npm', ['root', '-g'], { capture: true })
  await runDeployStep('install units', 'bash', [join(globalPackageDirectory, 'glissa', 'scripts', 'install-units.sh')])
  console.log('deploy: keep newest 5 releases')
  await pruneReleases(releasesDirectory)
  return 0
}

function readFileIfReadable(filePath) {
  return readFile(filePath, 'utf8').catch(() => undefined)
}

function readTelegramBotToken(environmentFileContents = '') {
  for (const environmentLine of environmentFileContents.split('\n')) {
    const tokenMatch = environmentLine.match(/^TELEGRAM_BOT_TOKEN=(.*)$/)
    if (tokenMatch) return tokenMatch[1]
  }
  return undefined
}

async function developmentEnvironment() {
  const channelDirectory = await canonicalDirectory(process.env.GLISSA_DEV_TELEGRAM_DIR || join(homedir(), '.claude', 'channels', 'telegram-dev'))
  const defaultLiveChannelDirectory = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'channels', 'telegram')
  const liveChannelDirectories = await Promise.all([defaultLiveChannelDirectory, process.env.TELEGRAM_STATE_DIR].filter(Boolean).map(canonicalDirectory))
  if (liveChannelDirectories.includes(channelDirectory)) throw new Error('run --dev refuses the live Telegram channel directory')
  const tokenFilePath = join(channelDirectory, '.env')
  const tokenContents = await readFile(tokenFilePath, 'utf8').catch((error) => {
    throw new Error(`run --dev needs ${tokenFilePath} with TELEGRAM_BOT_TOKEN=: ${error.code}`)
  })
  if (!/^[ \t]*(?:export[ \t]+)?TELEGRAM_BOT_TOKEN=(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s'"#]+)/m.test(tokenContents)) throw new Error(`run --dev needs TELEGRAM_BOT_TOKEN= in ${tokenFilePath}`)
  const developmentBotToken = readTelegramBotToken(tokenContents)
  const developmentBotPid = (await readFileIfReadable(join(channelDirectory, 'bot.pid')))?.trim()
  const liveBotTokenRefusal = `run --dev refuses the live bot token in ${tokenFilePath}; the dev bot needs its own token`
  if (developmentBotToken && developmentBotToken === process.env.TELEGRAM_BOT_TOKEN) throw new Error(liveBotTokenRefusal)
  for (const liveChannelDirectory of liveChannelDirectories) {
    if (developmentBotToken && developmentBotToken === readTelegramBotToken(await readFileIfReadable(join(liveChannelDirectory, '.env')))) throw new Error(liveBotTokenRefusal)
    const liveBotPid = (await readFileIfReadable(join(liveChannelDirectory, 'bot.pid')))?.trim()
    if (developmentBotPid && developmentBotPid === liveBotPid) throw new Error(`run --dev refuses ${channelDirectory} because its bot.pid is the live poller's; delete that file`)
  }
  const dataDirectory = resolve(process.env.GLISSA_DATA_DIR || join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'glissa-dev'))
  console.log(`dev: data directory ${dataDirectory}`)
  console.log(`dev: Telegram channel directory ${channelDirectory}`)
  const childEnvironment = {
    ...process.env,
    GLISSA_DATA_DIR: dataDirectory,
    GLISSA_STATE_DIR: process.env.GLISSA_STATE_DIR || join(dataDirectory, 'state'),
    GLISSA_RUNTIME_DIR: process.env.GLISSA_RUNTIME_DIR || join(process.env.XDG_RUNTIME_DIR || dataDirectory, 'glissa-dev'),
    TELEGRAM_STATE_DIR: channelDirectory,
    GLISSA_TELEGRAM_CHANNEL_DIR: channelDirectory,
  }
  delete childEnvironment.TELEGRAM_BOT_TOKEN
  delete childEnvironment.TELEGRAM_ACCESS_MODE
  return childEnvironment
}

async function runGlissa(commandArguments) {
  const [command, ...childArguments] = commandArguments
  if (command === 'deploy') return deploy(childArguments)
  if (command === 'migrate') {
    const { main } = await import('../scripts/glissa-migrate.mjs')
    return main({ argumentsList: childArguments })
  }
  if (!['serve', 'script', 'install-units', 'run'].includes(command)) return usage()
  if (['serve', 'install-units'].includes(command) && childArguments.length > 0) return usage()
  if (command === 'run' && (childArguments.length !== 1 || childArguments[0] !== '--dev')) return usage()
  const environment = command === 'run' ? await developmentEnvironment() : { ...process.env }
  const dataDirectory = resolveGlissaDataDirectory(environment)
  environment.GLISSA_DATA_DIR = dataDirectory
  await mkdir(dataDirectory, { recursive: true })
  const options = { cwd: dataDirectory, env: environment }
  if (command === 'install-units') return (await runChild('bash', [join(packageRoot, 'scripts', 'install-units.sh')], options)).exitCode
  if (command === 'serve' || command === 'run') return (await runChild(process.execPath, [join(packageRoot, 'scripts', 'serve.mjs')], options)).exitCode
  const [scriptName, ...scriptArguments] = childArguments
  if (!scriptName || scriptName.includes('/') || scriptName.includes('..') || !['.mjs', '.sh'].includes(extname(scriptName))) return usage()
  const scriptPath = join(packageRoot, 'scripts', scriptName)
  if (!(await stat(scriptPath)).isFile()) throw new Error(`Not a script: ${scriptName}`)
  return (await runChild(scriptName.endsWith('.sh') ? 'bash' : process.execPath, [scriptPath, ...scriptArguments], options)).exitCode
}

runCommandLine(async (commandArguments) => {
  try {
    return await runGlissa(commandArguments)
  } catch (error) {
    console.error(error.message)
    return error.exitCode || 1
  }
})
