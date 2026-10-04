import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { isCalendarDate } from './calendar-date.mjs'
import { addUsageExitCode, isMainModule, nothingToDoExitCode, runCommandLine } from './command-line.mjs'
import { readFrontmatter } from './frontmatter.mjs'
import { parseProfileLine } from './profile.mjs'
import { resolveRepositoryPath } from './repository-path.mjs'

const expiringWithinDays = 3
const openStateMinimumAgeDays = 7
const openStatePattern = /\b(?:not yet|waiting on|pending|tbd|to be confirmed)\b/i
const supersededPattern = /\bsuperseded\b/i

function daysBetween(firstDateText, secondDateText) {
  return (Date.parse(`${secondDateText}T00:00:00Z`) - Date.parse(`${firstDateText}T00:00:00Z`)) / 86_400_000
}

async function listMarkdownPaths(directoryPath) {
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  return directoryEntries
    .filter((directoryEntry) => directoryEntry.isFile() && directoryEntry.name.endsWith('.md'))
    .map((directoryEntry) => join(directoryPath, directoryEntry.name))
    .sort()
}

async function readMemoryFiles(memoryDirectory) {
  const livePaths = [
    ...(await listMarkdownPaths(memoryDirectory)),
    ...(await listMarkdownPaths(join(memoryDirectory, 'profile'))),
    ...(await listMarkdownPaths(join(memoryDirectory, 'context'))),
  ]
  return Promise.all(livePaths.map(async (filePath) => {
    const path = relative(memoryDirectory, filePath)
    const [firstSegment, ...remainingSegments] = path.split('/')
    return { path, group: remainingSegments.length === 0 ? 'top' : firstSegment, text: await readFile(filePath, 'utf8') }
  }))
}

function findStubFiles(memoryFiles) {
  return memoryFiles
    .filter(({ group }) => group !== 'context')
    .filter(({ text }) => !text.split(/\r?\n/).some((line) => line.startsWith('- ')))
    .map(({ path }) => ({ kind: 'stub-file', where: path, message: 'holds no facts' }))
}

function findSupersededDigests(memoryFiles) {
  return memoryFiles
    .filter(({ group }) => group === 'context')
    .filter(({ text }) => supersededPattern.test(readFrontmatter(text).bodyText))
    .map(({ path }) => ({ kind: 'superseded-digest', where: path, message: 'body says it was superseded, rewrite it to the current state' }))
}

function findProfileLineFindings(memoryFiles, today) {
  return memoryFiles.filter(({ group }) => group === 'profile').flatMap(({ path, text }) => text.split(/\r?\n/).flatMap((line, lineIndex) => {
    const profileLine = parseProfileLine(line)
    if (profileLine?.kind !== 'fact') return []
    const where = `${path}:${lineIndex + 1}`
    const findings = []
    const daysUntilEnd = profileLine.untilDate ? daysBetween(today, profileLine.untilDate) : null
    if (daysUntilEnd !== null && daysUntilEnd >= 0 && daysUntilEnd <= expiringWithinDays) {
      findings.push({ kind: 'expiring-soon', where, message: `${profileLine.fieldName} ends ${profileLine.untilDate}` })
    }
    if (openStatePattern.test(profileLine.value) && daysBetween(profileLine.stampedOn, today) >= openStateMinimumAgeDays) {
      findings.push({ kind: 'open-state-recheck', where, message: `${profileLine.fieldName} describes an open state stamped ${profileLine.stampedOn}` })
    }
    return findings
  }))
}

export async function auditMemory({ memoryDirectory, today }) {
  const memoryFiles = await readMemoryFiles(memoryDirectory)
  return [
    ...findStubFiles(memoryFiles),
    ...findSupersededDigests(memoryFiles),
    ...findProfileLineFindings(memoryFiles, today),
  ]
}

function localCalendarDate(now) {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function parseAuditOptions(commandArguments) {
  const optionValuesByName = new Map()
  for (let argumentIndex = 0; argumentIndex < commandArguments.length; argumentIndex += 2) {
    const [optionName, optionValue] = commandArguments.slice(argumentIndex, argumentIndex + 2)
    if (!['--dir', '--today'].includes(optionName) || !optionValue || optionValue.startsWith('--')) throw new Error('Invalid command options')
    optionValuesByName.set(optionName, optionValue)
  }
  const today = optionValuesByName.get('--today')
  if (today && !isCalendarDate(today)) throw new Error(`Invalid date: ${today}`)
  return { memoryDirectory: optionValuesByName.get('--dir'), today }
}

export async function runMemoryAuditCommand(commandArguments, { memoryDirectory = resolveRepositoryPath('memory'), writeOutput = console.log, writeError = console.error, now = new Date() } = {}) {
  let options
  try {
    options = parseAuditOptions(commandArguments)
  } catch (error) {
    writeError('usage: memory-audit.mjs [--today YYYY-MM-DD] [--dir <path>]')
    writeError(error.message)
    return addUsageExitCode
  }
  const findings = await auditMemory({
    memoryDirectory: options.memoryDirectory ? resolve(options.memoryDirectory) : memoryDirectory,
    today: options.today || localCalendarDate(now),
  })
  if (findings.length === 0) return nothingToDoExitCode
  findings.forEach(({ kind, where, message }) => writeOutput(`${kind} ${where} ${message}`))
  return 0
}

if (isMainModule(import.meta.url)) runCommandLine(runMemoryAuditCommand)
