import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { isCalendarDate } from './calendar-date.mjs'
import { addUsageExitCode, isMainModule, nothingToDoExitCode, parseFlags, runCommandLine } from './command-line.mjs'
import { readFrontmatter } from './frontmatter.mjs'
import { resolveRepositoryPath } from './repository-path.mjs'

const notAskedWithinDays = 14
const expireFailureExitCode = 1

const profileFieldPattern = /^- ([^:]+): (.*)$/
const statedValuePattern = /^(.*\S) \(stated (\d{4}-\d{2}-\d{2})(?:, until (\d{4}-\d{2}-\d{2}))?\)$/
const forwardedValuePattern = /^(.*\S) \(forwarded (\d{4}-\d{2}-\d{2})(?:, until (\d{4}-\d{2}-\d{2}))?\)$/
const askedValuePattern = /^\? \(asked (\d{4}-\d{2}-\d{2})\)$/
const notApplicableValuePattern = /^n\/a \(stated (\d{4}-\d{2}-\d{2})\)$/
export const trailingProvenanceStampPattern = /\((stated|forwarded) \d{4}-\d{2}-\d{2}(?:, until \d{4}-\d{2}-\d{2})?\)\.?$/
const frontmatterBlockPattern = /^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/
const contextDigestByteLimit = 1500
export const contextByteCap = 12288
export const contextLowWaterByteMark = Math.floor(contextByteCap * 0.75)

export function getProfileDirectory(environment = process.env) {
  return environment.GLISSA_PROFILE_DIR || resolveRepositoryPath('memory/profile')
}

function parseProfileValue(valueText) {
  if (valueText === '?') return { kind: 'never-asked', askedOn: null, stampedOn: null, untilDate: null }
  const askedValueMatch = askedValuePattern.exec(valueText)
  if (askedValueMatch) return { kind: 'asked', askedOn: askedValueMatch[1], stampedOn: askedValueMatch[1], untilDate: null }
  const notApplicableValueMatch = notApplicableValuePattern.exec(valueText)
  if (notApplicableValueMatch) return { kind: 'not-applicable', askedOn: null, stampedOn: notApplicableValueMatch[1], untilDate: null }
  const statedValueMatch = statedValuePattern.exec(valueText)
  if (statedValueMatch) return { kind: 'fact', provenance: 'stated', value: statedValueMatch[1], askedOn: null, stampedOn: statedValueMatch[2], untilDate: statedValueMatch[3] ?? null }
  const forwardedValueMatch = forwardedValuePattern.exec(valueText)
  if (forwardedValueMatch) return { kind: 'fact', provenance: 'forwarded', value: forwardedValueMatch[1], askedOn: null, stampedOn: forwardedValueMatch[2], untilDate: forwardedValueMatch[3] ?? null }
  return null
}

export function parseProfileLine(profileLine) {
  const fieldMatch = profileFieldPattern.exec(profileLine)
  if (!fieldMatch) return null
  const profileValue = parseProfileValue(fieldMatch[2])
  if (!profileValue) return null
  return { fieldName: fieldMatch[1], ...profileValue }
}

function findBodyGrammarViolations(bodyText, firstBodyLineNumber) {
  const violations = []
  const fieldNames = new Set()
  const stampedDates = []
  bodyText.split(/\r?\n/).forEach((bodyLine, lineIndex) => {
    const line = firstBodyLineNumber + lineIndex
    if (!bodyLine || /^## .+/.test(bodyLine)) return
    const fieldMatch = profileFieldPattern.exec(bodyLine)
    if (!fieldMatch) {
      violations.push({ line, reason: 'Body lines must be blank, headings, or fields' })
      return
    }
    const [, fieldName, valueText] = fieldMatch
    if (!fieldName.trim()) {
      violations.push({ line, reason: 'Field name must not be empty' })
      return
    }
    if (fieldName !== fieldName.trim()) {
      violations.push({ line, reason: `Field name must not carry leading or trailing whitespace: ${fieldName}` })
      return
    }
    if (fieldNames.has(fieldName)) violations.push({ line, reason: `Duplicate field name: ${fieldName}` })
    fieldNames.add(fieldName)
    const profileValue = parseProfileValue(valueText)
    if (!profileValue) {
      violations.push({ line, reason: 'Field value must be a fact, unknown, asked unknown, or not applicable' })
      return
    }
    if (!profileValue.stampedOn) return
    if (!isCalendarDate(profileValue.stampedOn)) {
      violations.push({ line, reason: `Invalid date: ${profileValue.stampedOn}` })
      return
    }
    if (profileValue.untilDate && !isCalendarDate(profileValue.untilDate)) {
      violations.push({ line, reason: `Invalid date: ${profileValue.untilDate}` })
      return
    }
    const isUntilBeforeStamp = profileValue.untilDate && profileValue.untilDate < profileValue.stampedOn
    if (isUntilBeforeStamp) {
      violations.push({ line, reason: `Until date is earlier than ${profileValue.provenance} date: ${profileValue.untilDate}` })
      return
    }
    stampedDates.push(profileValue.stampedOn)
  })
  return { violations, stampedDates }
}

export function findContextDigestViolations(fileText) {
  const violations = []
  if (Buffer.byteLength(fileText) >= contextDigestByteLimit) violations.push({ line: 1, reason: `Context digest must be under ${contextDigestByteLimit} bytes` })
  let frontmatter
  try {
    frontmatter = readFrontmatter(fileText)
  } catch (error) {
    violations.push({ line: 1, reason: error.message })
    return violations
  }
  for (const fieldName of ['title', 'source', 'received', 'until']) {
    if (!Object.hasOwn(frontmatter.fields, fieldName)) violations.push({ line: 1, reason: `Missing frontmatter key: ${fieldName}` })
  }
  if (frontmatter.fields.title === '') violations.push({ line: 1, reason: 'Title must not be empty' })
  if (frontmatter.fields.source !== 'telegram-forward') violations.push({ line: 1, reason: 'Source must be telegram-forward' })
  for (const dateFieldName of ['received', 'until']) {
    const dateText = frontmatter.fields[dateFieldName]
    if (dateText !== undefined && !isCalendarDate(dateText)) violations.push({ line: 1, reason: `Invalid ${dateFieldName} date: ${dateText}` })
  }
  const { received, until } = frontmatter.fields
  if (isCalendarDate(received) && isCalendarDate(until) && until < received) violations.push({ line: 1, reason: `Until date is earlier than received date: ${until}` })
  return violations
}

export function findProfileGrammarViolations(fileText) {
  let frontmatter
  try {
    frontmatter = readFrontmatter(fileText)
  } catch (error) {
    return [{ line: 1, reason: error.message }]
  }
  const { violations, stampedDates } = findBodyGrammarViolations(frontmatter.bodyText, frontmatter.firstBodyLineNumber)
  for (const fieldName of ['name', 'description', 'updated']) {
    if (!Object.hasOwn(frontmatter.fields, fieldName)) violations.push({ line: 1, reason: `Missing frontmatter key: ${fieldName}` })
  }
  if (!Object.hasOwn(frontmatter.fields, 'updated')) return violations
  const updated = frontmatter.fields.updated
  if (!isCalendarDate(updated)) {
    violations.push({ line: 1, reason: `Invalid updated date: ${updated}` })
    return violations
  }
  const newestStampedDate = stampedDates.sort().at(-1)
  if (newestStampedDate && updated < newestStampedDate) {
    violations.push({ line: 1, reason: `Updated date is earlier than newest stamp: ${newestStampedDate}` })
  }
  return violations
}

function listBlankFields(fileText) {
  const frontmatter = readFrontmatter(fileText)
  return frontmatter.bodyText.split(/\r?\n/).flatMap((bodyLine, lineIndex) => {
    const fieldMatch = profileFieldPattern.exec(bodyLine)
    if (!fieldMatch) return []
    const profileValue = parseProfileValue(fieldMatch[2])
    if (!profileValue || !['never-asked', 'asked'].includes(profileValue.kind)) return []
    return [{ line: frontmatter.firstBodyLineNumber + lineIndex, field: fieldMatch[1], askedOn: profileValue.askedOn, isNeverAsked: profileValue.kind === 'never-asked' }]
  })
}

function daysBetween(firstDateText, secondDateText) {
  return (Date.parse(`${secondDateText}T00:00:00Z`) - Date.parse(`${firstDateText}T00:00:00Z`)) / 86_400_000
}

function replaceUpdatedDate(fileText, frontmatter, updatedDate) {
  const frontmatterText = fileText.slice(0, fileText.length - frontmatter.bodyText.length)
  return `${frontmatterText.replace(/^updated:.*$/m, `updated: ${updatedDate}`)}${frontmatter.bodyText}`
}

function isSectionHeading(bodyLine) {
  return /^## .+/.test(bodyLine ?? '')
}

export function expireProfileText(fileText, today) {
  const frontmatter = readFrontmatter(fileText)
  const lineEnding = fileText.includes('\r\n') ? '\r\n' : '\n'
  const bodyLines = frontmatter.bodyText.split(/\r?\n/)
  const archivedLines = []
  const headingIndexesThatLostFields = new Set()
  let governingHeadingIndex = -1
  const retainedLines = bodyLines.map((bodyLine, bodyLineIndex) => {
    if (isSectionHeading(bodyLine)) governingHeadingIndex = bodyLineIndex
    const fieldMatch = profileFieldPattern.exec(bodyLine)
    if (!fieldMatch) return bodyLine
    const profileValue = parseProfileValue(fieldMatch[2])
    if (!profileValue?.untilDate || profileValue.untilDate >= today) return bodyLine
    archivedLines.push(bodyLine)
    if (governingHeadingIndex !== -1) headingIndexesThatLostFields.add(governingHeadingIndex)
    return null
  })
  headingIndexesThatLostFields.forEach((headingIndex) => {
    const nextHeadingIndex = retainedLines.findIndex((candidateLine, candidateIndex) => candidateIndex > headingIndex && isSectionHeading(candidateLine))
    const sectionEndIndex = nextHeadingIndex === -1 ? retainedLines.length : nextHeadingIndex
    const hasRetainedField = retainedLines.slice(headingIndex + 1, sectionEndIndex).some((candidateLine) => profileFieldPattern.test(candidateLine ?? ''))
    if (hasRetainedField) return
    for (let sectionLineIndex = headingIndex; sectionLineIndex < sectionEndIndex; sectionLineIndex += 1) {
      retainedLines[sectionLineIndex] = null
    }
  })
  if (archivedLines.length === 0) return { text: fileText, archivedLines }
  const updatedFileText = replaceUpdatedDate(fileText, frontmatter, today)
  const updatedFrontmatter = readFrontmatter(updatedFileText)
  const retainedBodyText = retainedLines.filter((bodyLine) => bodyLine !== null).join(lineEnding)
  return { text: `${updatedFileText.slice(0, updatedFileText.length - updatedFrontmatter.bodyText.length)}${retainedBodyText}`, archivedLines }
}

function createArchiveText(domain, today, archivedLines) {
  return `---\nname: ${domain}\ndescription: Expired facts moved out of the ${domain} profile.\nupdated: ${today}\n---\n\n## archived ${today}\n${archivedLines.join('\n')}\n\n`
}

function restampArchiveUpdatedDate(archiveText, today) {
  if (!frontmatterBlockPattern.test(archiveText)) return archiveText
  return replaceUpdatedDate(archiveText, readFrontmatter(archiveText), today)
}

function appendArchivedLines(archiveText, today, archivedLines) {
  const archiveWithUpdatedDate = restampArchiveUpdatedDate(archiveText, today)
  const archiveSeparator = archiveWithUpdatedDate.endsWith('\n') ? '\n' : '\n\n'
  return `${archiveWithUpdatedDate}${archiveSeparator}## archived ${today}\n${archivedLines.join('\n')}\n\n`
}

async function listMarkdownFileNames(directoryPath) {
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true })
  return directoryEntries
    .filter((directoryEntry) => directoryEntry.isFile() && directoryEntry.name.endsWith('.md'))
    .map((directoryEntry) => directoryEntry.name)
    .sort()
}

async function listContextFileNames(contextDirectory) {
  try {
    return await listMarkdownFileNames(contextDirectory)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return []
  }
}

async function readExistingArchiveText(archiveFilePath) {
  try {
    return await readFile(archiveFilePath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

async function expireProfileFile({ profileDirectory, archiveDirectory, profileFileName, today }) {
  const profileFilePath = resolve(profileDirectory, profileFileName)
  const profileText = await readFile(profileFilePath, 'utf8')
  const expiredProfile = expireProfileText(profileText, today)
  if (expiredProfile.archivedLines.length === 0) return 0
  const domain = basename(profileFileName, '.md')
  const archiveFilePath = resolve(archiveDirectory, profileFileName)
  const archiveText = await readExistingArchiveText(archiveFilePath)
  await mkdir(archiveDirectory, { recursive: true })
  await writeFile(archiveFilePath, archiveText ? appendArchivedLines(archiveText, today, expiredProfile.archivedLines) : createArchiveText(domain, today, expiredProfile.archivedLines))
  await writeFile(profileFilePath, expiredProfile.text)
  return expiredProfile.archivedLines.length
}

async function isExistingPath(filePath) {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return false
  }
}

async function resolveFreeArchiveFileName(archiveContextDirectory, contextFileName) {
  if (!(await isExistingPath(resolve(archiveContextDirectory, contextFileName)))) return contextFileName
  const fileStem = basename(contextFileName, '.md')
  let duplicateIndex = 2
  while (await isExistingPath(resolve(archiveContextDirectory, `${fileStem}-${duplicateIndex}.md`))) duplicateIndex += 1
  return `${fileStem}-${duplicateIndex}.md`
}

async function moveContextFileToArchive({ contextDirectory, archiveContextDirectory, contextFileName }) {
  await mkdir(archiveContextDirectory, { recursive: true })
  const archiveFileName = await resolveFreeArchiveFileName(archiveContextDirectory, contextFileName)
  await rename(resolve(contextDirectory, contextFileName), resolve(archiveContextDirectory, archiveFileName))
  return archiveFileName
}

function compareByReceivedThenFileName(firstFile, secondFile) {
  if (firstFile.received !== secondFile.received) return firstFile.received.localeCompare(secondFile.received)
  return firstFile.contextFileName.localeCompare(secondFile.contextFileName)
}

async function expireContextFiles({ profileDirectory, today }) {
  const memoryDirectory = resolve(profileDirectory, '..')
  const contextDirectory = resolve(memoryDirectory, 'context')
  const archiveContextDirectory = resolve(memoryDirectory, 'archive', 'context')
  await mkdir(contextDirectory, { recursive: true })
  const contextFileNames = await listContextFileNames(contextDirectory)
  const archivedContextFiles = []
  const failureMessagesByContextFile = {}
  const evictionCandidates = []
  let retainedByteTotal = 0
  for (const contextFileName of contextFileNames) {
    try {
      const contextText = await readFile(resolve(contextDirectory, contextFileName), 'utf8')
      const byteCount = Buffer.byteLength(contextText)
      const violations = findContextDigestViolations(contextText)
      if (violations.length > 0) throw new Error(violations.map(({ reason }) => reason).join('; '))
      const { received, until } = readFrontmatter(contextText).fields
      if (until < today) {
        archivedContextFiles.push(await moveContextFileToArchive({ contextDirectory, archiveContextDirectory, contextFileName }))
        continue
      }
      retainedByteTotal += byteCount
      evictionCandidates.push({ contextFileName, received, byteCount })
    } catch (error) {
      failureMessagesByContextFile[contextFileName] = error.message
    }
  }
  const evictionByteTarget = retainedByteTotal > contextByteCap ? contextLowWaterByteMark : retainedByteTotal
  for (const evictionCandidate of evictionCandidates.sort(compareByReceivedThenFileName)) {
    if (retainedByteTotal <= evictionByteTarget) break
    try {
      archivedContextFiles.push(await moveContextFileToArchive({ contextDirectory, archiveContextDirectory, contextFileName: evictionCandidate.contextFileName }))
      retainedByteTotal -= evictionCandidate.byteCount
    } catch (error) {
      failureMessagesByContextFile[evictionCandidate.contextFileName] = error.message
    }
  }
  return { archivedContextFiles, failureMessagesByContextFile }
}

export async function expireProfiles({ profileDirectory, today }) {
  const profileFileNames = await listMarkdownFileNames(profileDirectory)
  const archiveDirectory = resolve(profileDirectory, '..', 'archive')
  const archivedLinesByDomain = {}
  const failureMessagesByDomain = {}
  for (const profileFileName of profileFileNames) {
    const domain = basename(profileFileName, '.md')
    try {
      const archivedLineCount = await expireProfileFile({ profileDirectory, archiveDirectory, profileFileName, today })
      if (archivedLineCount > 0) archivedLinesByDomain[domain] = archivedLineCount
    } catch (error) {
      failureMessagesByDomain[domain] = error.message
    }
  }
  const expiredContexts = await expireContextFiles({ profileDirectory, today })
  return { archivedLinesByDomain, failureMessagesByDomain, ...expiredContexts }
}

export async function pickBlank({ profileDirectory, domain, today, notAskedWithinDays: notAskedWindowDays }) {
  const profileFileNames = (await listMarkdownFileNames(profileDirectory)).filter((profileFileName) => !domain || profileFileName === `${domain}.md`)
  const skipped = []
  const blanks = []
  for (const profileFileName of profileFileNames) {
    const profileFilePath = resolve(profileDirectory, profileFileName)
    const fileText = await readFile(profileFilePath, 'utf8')
    const violations = findProfileGrammarViolations(fileText)
    if (violations.length > 0) {
      skipped.push(profileFilePath)
      continue
    }
    listBlankFields(fileText).forEach((blank) => {
      if (!blank.isNeverAsked && daysBetween(blank.askedOn, today) <= notAskedWindowDays) return
      blanks.push({ ...blank, file: profileFilePath })
    })
  }
  blanks.sort((firstBlank, secondBlank) => {
    if (firstBlank.isNeverAsked !== secondBlank.isNeverAsked) return firstBlank.isNeverAsked ? -1 : 1
    if (firstBlank.file !== secondBlank.file) return firstBlank.file.localeCompare(secondBlank.file)
    return firstBlank.line - secondBlank.line
  })
  const blank = blanks[0]
  if (!blank) return { blank: null, skipped }
  return { blank: { file: blank.file, line: blank.line, field: blank.field, askedOn: blank.askedOn }, skipped }
}

function parseOptionArguments(optionArguments, bareFlagNames, valuedFlagNames) {
  const flagNames = []
  const optionValuesByName = new Map()
  for (let argumentIndex = 0; argumentIndex < optionArguments.length; argumentIndex += 1) {
    const optionArgument = optionArguments[argumentIndex]
    if (bareFlagNames.has(optionArgument)) {
      flagNames.push(optionArgument)
      continue
    }
    if (!valuedFlagNames.has(optionArgument)) throw new Error('Invalid command options')
    const optionValue = optionArguments[argumentIndex + 1]
    if (!optionValue || optionValue.startsWith('--')) throw new Error(`${optionArgument} requires a value`)
    flagNames.push(optionArgument)
    optionValuesByName.set(optionArgument, optionValue)
    argumentIndex += 1
  }
  const flags = parseFlags(flagNames, new Set([...bareFlagNames, ...valuedFlagNames]))
  return { flags, optionValuesByName }
}

function parseBlanksCommandOptions(optionArguments) {
  const { flags, optionValuesByName } = parseOptionArguments(optionArguments, new Set(['--pick']), new Set(['--domain', '--dir']))
  if (!flags.has('--pick')) throw new Error('The --pick option is required')
  return { domain: optionValuesByName.get('--domain'), profileDirectory: optionValuesByName.get('--dir') }
}

function parseExpireCommandOptions(optionArguments) {
  const { optionValuesByName } = parseOptionArguments(optionArguments, new Set(), new Set(['--today', '--dir']))
  const today = optionValuesByName.get('--today')
  if (today && !isCalendarDate(today)) throw new Error(`Invalid date: ${today}`)
  return { today, profileDirectory: optionValuesByName.get('--dir') }
}

function parseProfileCommandOptions(commandArguments) {
  const [command, ...optionArguments] = commandArguments
  if (command === 'blanks') return { command, ...parseBlanksCommandOptions(optionArguments) }
  if (command === 'expire') return { command, ...parseExpireCommandOptions(optionArguments) }
  throw new Error('Unknown command')
}

export function localCalendarDate(now) {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export async function runProfileCommand(commandArguments, { profileDirectory = getProfileDirectory(), writeOutput = console.log, writeError = console.error, now = new Date() } = {}) {
  let commandOptions
  try {
    commandOptions = parseProfileCommandOptions(commandArguments)
  } catch (error) {
    writeError('usage: profile.mjs blanks --pick [--domain <slug>] [--dir <path>]\n       profile.mjs expire [--today YYYY-MM-DD] [--dir <path>]')
    writeError(error.message)
    return addUsageExitCode
  }
  if (commandOptions.command === 'expire') {
    const expiredProfiles = await expireProfiles({
      profileDirectory: commandOptions.profileDirectory || profileDirectory,
      today: commandOptions.today || localCalendarDate(now),
    })
    const archivedDomains = Object.entries(expiredProfiles.archivedLinesByDomain)
    const failedDomains = Object.entries(expiredProfiles.failureMessagesByDomain)
    const archivedContextFiles = expiredProfiles.archivedContextFiles
    const failedContextFiles = Object.entries(expiredProfiles.failureMessagesByContextFile)
    archivedDomains.forEach(([domain, archivedLineCount]) => writeOutput(`${domain}: ${archivedLineCount} archived`))
    archivedContextFiles.forEach((contextFileName) => writeOutput(`context/${contextFileName}: archived`))
    failedDomains.forEach(([domain, failureMessage]) => writeError(`${domain}: ${failureMessage}`))
    failedContextFiles.forEach(([contextFileName, failureMessage]) => writeError(`context/${contextFileName}: ${failureMessage}`))
    if (failedDomains.length > 0) return expireFailureExitCode
    if (archivedDomains.length === 0 && archivedContextFiles.length === 0) {
      writeOutput('nothing to do')
      return nothingToDoExitCode
    }
    return 0
  }
  const selectedBlank = await pickBlank({
    profileDirectory: commandOptions.profileDirectory || profileDirectory,
    domain: commandOptions.domain,
    today: now.toISOString().slice(0, 10),
    notAskedWithinDays,
  })
  selectedBlank.skipped.forEach((skippedProfilePath) => writeError(skippedProfilePath))
  if (!selectedBlank.blank) return nothingToDoExitCode
  writeOutput(JSON.stringify(selectedBlank.blank))
  return 0
}

if (isMainModule(import.meta.url)) runCommandLine(runProfileCommand)
