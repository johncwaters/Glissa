import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isMainModule, runCommandLine } from './command-line.mjs'
import { canonicalDirectory, resolveInstalledDataDirectory } from './repository-path.mjs'

const migrationPaths = ['memory', 'context', 'briefs', 'research', 'travel', 'content', 'logs', 'tasks.json', 'calendar-allow.json', 'browse-domains.json']

function parseArguments(argumentsList, environment) {
  const options = { destination: resolveInstalledDataDirectory(environment), isDryRun: false, isVerifyOnly: false }
  const seenOptions = new Set()
  for (let argumentIndex = 0; argumentIndex < argumentsList.length; argumentIndex += 1) {
    const argument = argumentsList[argumentIndex]
    if (seenOptions.has(argument)) throw new Error(`Duplicate option: ${argument}`)
    seenOptions.add(argument)
    if (argument === '--dry-run') {
      options.isDryRun = true
      continue
    }
    if (argument === '--verify') {
      options.isVerifyOnly = true
      continue
    }
    if (!['--from', '--to'].includes(argument)) throw new Error(`Unknown option: ${argument}`)
    const value = argumentsList[++argumentIndex]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`)
    options[argument === '--from' ? 'source' : 'destination'] = resolve(value)
  }
  if (!options.source) throw new Error('usage: glissa migrate --from <checkout> [--to <data directory>] [--dry-run | --verify]')
  return options
}

async function readPathStats(filePath) {
  try {
    return await lstat(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function isInsideOrEqual(parentPath, childPath) {
  const relativePath = relative(parentPath, childPath)
  return relativePath === '' || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
}

function runProcess(command, commandArguments, environment) {
  return new Promise((resolveExitCode, reject) => {
    const child = spawn(command, commandArguments, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let outputText = ''
    let errorText = ''
    child.stdout.on('data', (chunk) => { outputText = `${outputText}${chunk}`.slice(-4096) })
    child.stderr.on('data', (chunk) => { errorText = `${errorText}${chunk}`.slice(-4096) })
    child.once('error', reject)
    child.once('close', (exitCode, signal) => {
      if (signal) return reject(new Error(`${command} terminated by ${signal}`))
      resolveExitCode({ exitCode, outputText: outputText.trim(), errorText: errorText.trim() })
    })
  })
}

export async function buildManifest(rootPath) {
  const entries = new Map()
  let fileCount = 0
  let linkCount = 0
  async function visit(absolutePath, relativePath) {
    const pathStats = await lstat(absolutePath)
    if (pathStats.isSymbolicLink()) {
      entries.set(relativePath, `link:${await readlink(absolutePath)}`)
      linkCount += 1
      return
    }
    if (pathStats.isDirectory()) {
      entries.set(relativePath, 'directory')
      for (const name of (await readdir(absolutePath)).sort()) await visit(join(absolutePath, name), join(relativePath, name))
      return
    }
    if (!pathStats.isFile()) throw new Error(`Unsupported entry: ${absolutePath}`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(absolutePath)) hash.update(chunk)
    entries.set(relativePath, `file:${hash.digest('hex')}`)
    fileCount += 1
  }
  await visit(rootPath, '')
  return { entries, fileCount, linkCount }
}

async function findEscapingLinks(sourceDirectory, presentPaths) {
  const escapingLinks = []
  const isInsideMigratedPaths = (targetPath) => presentPaths.some((migrationPath) => isInsideOrEqual(join(sourceDirectory, migrationPath), targetPath))
  async function visit(absolutePath) {
    const pathStats = await lstat(absolutePath)
    if (pathStats.isSymbolicLink()) {
      const linkTarget = await readlink(absolutePath)
      if (isAbsolute(linkTarget) || !isInsideMigratedPaths(resolve(dirname(absolutePath), linkTarget))) escapingLinks.push(`${absolutePath} -> ${linkTarget}`)
      return
    }
    if (!pathStats.isDirectory()) return
    for (const name of await readdir(absolutePath)) await visit(join(absolutePath, name))
  }
  for (const migrationPath of presentPaths) {
    const absolutePath = join(sourceDirectory, migrationPath)
    if ((await lstat(absolutePath)).isSymbolicLink()) {
      escapingLinks.push(`${absolutePath} is itself a symlink`)
      continue
    }
    await visit(absolutePath)
  }
  return escapingLinks
}

async function moveIntoPlaceWithoutOverwriting(stagedPath, targetPath) {
  try {
    if ((await lstat(stagedPath)).isDirectory()) {
      await mkdir(targetPath)
      await rename(stagedPath, targetPath)
      return
    }
    await link(stagedPath, targetPath)
    await unlink(stagedPath)
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
    throw new Error(`${targetPath} appeared during the migration; nothing was overwritten, staged copies remain in ${dirname(stagedPath)}`)
  }
}

async function describeMatchingCopy(sourceDirectory, copyDirectory, migrationPath) {
  const sourceManifest = await buildManifest(join(sourceDirectory, migrationPath))
  const copyManifest = await buildManifest(join(copyDirectory, migrationPath))
  for (const entryPath of new Set([...sourceManifest.entries.keys(), ...copyManifest.entries.keys()])) {
    if (sourceManifest.entries.get(entryPath) !== copyManifest.entries.get(entryPath)) {
      throw new Error(`${migrationPath}: mismatch at ${entryPath || '.'}`)
    }
  }
  return `${migrationPath}: ${sourceManifest.fileCount} files, ${sourceManifest.linkCount} links, match`
}

async function resolveSeparateDirectories(source, destination) {
  if (!(await readPathStats(join(source, 'memory')))?.isDirectory()) throw new Error('--from must contain a memory/ directory')
  const sourceDirectory = await realpath(source)
  const destinationDirectory = await canonicalDirectory(destination)
  if (isInsideOrEqual(sourceDirectory, destinationDirectory) || isInsideOrEqual(destinationDirectory, sourceDirectory)) {
    throw new Error('Source and destination must be separate directories; neither may contain the other')
  }
  return { sourceDirectory, destinationDirectory }
}

async function confirmServiceStopped(environment, reasonToStop) {
  const serviceStatus = await runProcess(environment.GLISSA_SYSTEMCTL || 'systemctl', ['--user', 'is-active', 'glissa.service'], environment)
  if (serviceStatus.exitCode === 0) throw new Error(`glissa.service is active; ${reasonToStop}`)
  if (!['inactive', 'failed'].includes(serviceStatus.outputText)) {
    throw new Error(`Could not confirm glissa.service is stopped (${serviceStatus.errorText || serviceStatus.outputText || 'no state'}); ${reasonToStop}`)
  }
}

async function verifyMigratedPaths({ source, destination }, environment, writeOutput) {
  const { sourceDirectory, destinationDirectory } = await resolveSeparateDirectories(source, destination)
  await confirmServiceStopped(environment, 'verify compares the copy against the originals and the running service changes the data directory, so verify only before its first start')
  for (const migrationPath of migrationPaths) {
    if (!(await readPathStats(join(sourceDirectory, migrationPath)))) {
      writeOutput(`${migrationPath}: absent, skipped`)
      continue
    }
    if (!(await readPathStats(join(destinationDirectory, migrationPath)))) throw new Error(`${migrationPath}: missing from ${destinationDirectory}`)
    writeOutput(await describeMatchingCopy(sourceDirectory, destinationDirectory, migrationPath))
  }
}

async function migratePaths({ source, destination, isDryRun }, environment, writeOutput) {
  const { sourceDirectory, destinationDirectory } = await resolveSeparateDirectories(source, destination)
  await confirmServiceStopped(environment, 'stop it before migrating')
  const presentPaths = []
  for (const migrationPath of migrationPaths) {
    if (!(await readPathStats(join(sourceDirectory, migrationPath)))) {
      writeOutput(`${migrationPath}: absent, skipped`)
      continue
    }
    if (await readPathStats(join(destinationDirectory, migrationPath))) {
      throw new Error(`${join(destinationDirectory, migrationPath)} already exists; move it aside before migrating`)
    }
    presentPaths.push(migrationPath)
  }
  const escapingLinks = await findEscapingLinks(sourceDirectory, presentPaths)
  if (escapingLinks.length > 0) {
    throw new Error(`Symlinks would not carry their data to the destination; replace them with the data they point at and rerun:\n${escapingLinks.join('\n')}`)
  }
  if (isDryRun) {
    for (const migrationPath of presentPaths) writeOutput(`${migrationPath}: would copy to ${join(destinationDirectory, migrationPath)}`)
    return
  }
  await mkdir(destinationDirectory, { recursive: true })
  const stagingDirectory = await mkdtemp(join(destinationDirectory, '.migrate-'))
  for (const migrationPath of presentPaths) {
    const copyStatus = await runProcess('cp', ['-a', join(sourceDirectory, migrationPath), join(stagingDirectory, migrationPath)], environment)
    if (copyStatus.exitCode !== 0) throw new Error(`cp failed for ${migrationPath}: ${copyStatus.errorText || copyStatus.exitCode}`)
  }
  const matchLines = []
  for (const migrationPath of presentPaths) matchLines.push(await describeMatchingCopy(sourceDirectory, stagingDirectory, migrationPath))
  for (const migrationPath of presentPaths) await moveIntoPlaceWithoutOverwriting(join(stagingDirectory, migrationPath), join(destinationDirectory, migrationPath))
  await rmdir(stagingDirectory)
  for (const matchLine of matchLines) writeOutput(matchLine)
  writeOutput(`Destination: ${destinationDirectory}`)
  writeOutput('Originals stay in place until the operator deletes them; rollback is reinstalling the old units.')
}

export async function main({ argumentsList = process.argv.slice(2), environment = process.env, writeOutput = console.log, writeError = console.error } = {}) {
  try {
    const options = parseArguments(argumentsList, environment)
    if (options.isDryRun && options.isVerifyOnly) throw new Error('--dry-run and --verify cannot be combined')
    if (options.isVerifyOnly) {
      await verifyMigratedPaths(options, environment, writeOutput)
      return 0
    }
    await migratePaths(options, environment, writeOutput)
    return 0
  } catch (error) {
    writeError(error.message)
    return 1
  }
}

if (isMainModule(import.meta.url)) runCommandLine((argumentsList) => main({ argumentsList }))
