import { readFile } from 'node:fs/promises'
import { addUsageExitCode, isMainModule, runCommandLine } from './command-line.mjs'
import { isCalendarDate } from './calendar-date.mjs'
import { readFrontmatter } from './frontmatter.mjs'

export const researchViolationsExitCode = 4

const requiredHeadings = ['Answer', 'Sources', 'Contradictions', 'Not verified']
const allowedFrontmatterKeys = ['question', 'asked', 'confidence']
const confidenceLevels = new Set(['high', 'medium', 'low'])
const sourceReadStatuses = new Set(['full', 'summary', 'blocked'])
const maximumAnswerWords = 199
const calendarDatePattern = /\b\d{4}-\d{2}-\d{2}\b/g
const schemeUrlPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+/gi

function blankFencedCodeLines(bodyLines) {
  let isInsideFence = false
  return bodyLines.map((bodyLine) => {
    if (bodyLine.startsWith('```')) {
      isInsideFence = !isInsideFence
      return ''
    }
    if (isInsideFence) return ''
    return bodyLine
  })
}

function findHeadingViolations(bodyLines, firstBodyLineNumber) {
  const violations = []
  const headings = bodyLines.flatMap((bodyLine, lineIndex) => {
    const headingMatch = /^## (.+)$/.exec(bodyLine)
    if (!headingMatch) return []
    return [{ name: headingMatch[1].trim(), line: firstBodyLineNumber + lineIndex, lineIndex }]
  })
  headings.forEach((heading, headingIndex) => {
    const expectedHeadingName = requiredHeadings[headingIndex]
    if (heading.name === expectedHeadingName) return
    if (!expectedHeadingName) {
      violations.push({ line: heading.line, reason: `Unexpected heading: ## ${heading.name}` })
      return
    }
    violations.push({ line: heading.line, reason: `Expected heading: ## ${expectedHeadingName}` })
  })
  requiredHeadings.slice(headings.length).forEach((headingName) => {
    violations.push({ line: firstBodyLineNumber, reason: `Missing heading: ## ${headingName}` })
  })
  return { violations, headings }
}

function sectionLines(bodyLines, headings, headingName) {
  const headingIndex = headings.findIndex((heading) => heading.name === headingName)
  if (headingIndex === -1) return []
  const sectionStart = headings[headingIndex].lineIndex + 1
  const sectionEnd = headings[headingIndex + 1]?.lineIndex ?? bodyLines.length
  return bodyLines.slice(sectionStart, sectionEnd)
}

function hasCalendarDateOutsideUrls(sourceLine) {
  const textOutsideUrls = sourceLine.replace(schemeUrlPattern, '')
  const dateCandidates = textOutsideUrls.match(calendarDatePattern) ?? []
  return dateCandidates.some((dateCandidate) => isCalendarDate(dateCandidate))
}

function readSourceStatus(sourceBulletText) {
  const statusMatch = /read:\s*([a-z]+)\s*$/.exec(sourceBulletText)
  if (!statusMatch) return ''
  if (!sourceReadStatuses.has(statusMatch[1])) return ''
  return statusMatch[1]
}

function findSourceViolations(sourceLines, sourcesHeadingLine) {
  const violations = []
  const fullyReadHostnames = []
  sourceLines.forEach((sourceLine, sourceLineIndex) => {
    if (!/^-\s+/.test(sourceLine)) return
    const sourceBulletLine = sourcesHeadingLine + sourceLineIndex + 1
    const readStatus = readSourceStatus(sourceLine)
    if (readStatus === '') {
      violations.push({ line: sourceBulletLine, reason: 'Source bullet must end with read: full, read: summary, or read: blocked' })
      return
    }
    const urlMatch = /https:\/\/[^\s)>\]]+/.exec(sourceLine)
    if (!urlMatch) {
      violations.push({ line: sourceBulletLine, reason: 'Source bullet must contain an https:// URL' })
      return
    }
    if (!hasCalendarDateOutsideUrls(sourceLine)) {
      violations.push({ line: sourceBulletLine, reason: 'Source bullet must carry the date read or published as YYYY-MM-DD' })
      return
    }
    let sourceHostname
    try {
      sourceHostname = new URL(urlMatch[0]).hostname
    } catch {
      violations.push({ line: sourceBulletLine, reason: 'Source bullet must contain a valid https:// URL' })
      return
    }
    if (readStatus !== 'full') return
    fullyReadHostnames.push(sourceHostname)
  })
  if (fullyReadHostnames.length < 3) {
    violations.push({ line: sourcesHeadingLine, reason: 'Sources must contain at least three bullets read in full' })
    violations.push({ line: sourcesHeadingLine, reason: 'Sources must contain at least three https:// URLs read in full' })
  }
  if (new Set(fullyReadHostnames).size < 3) {
    violations.push({ line: sourcesHeadingLine, reason: 'Sources must use at least three distinct hostnames read in full' })
  }
  return violations
}

export function findResearchViolations(fileText) {
  let frontmatter
  try {
    frontmatter = readFrontmatter(fileText)
  } catch (error) {
    return [{ line: 1, reason: error.message }]
  }
  const violations = []
  for (const fieldName of allowedFrontmatterKeys) {
    if (!frontmatter.fields[fieldName]?.trim()) violations.push({ line: 1, reason: `Missing frontmatter key: ${fieldName}` })
  }
  for (const fieldName of Object.keys(frontmatter.fields)) {
    if (allowedFrontmatterKeys.includes(fieldName)) continue
    violations.push({ line: 1, reason: `Unexpected frontmatter key: ${fieldName}` })
  }
  const askedDate = frontmatter.fields.asked?.trim()
  const confidenceLevel = frontmatter.fields.confidence?.trim()
  if (askedDate && !isCalendarDate(askedDate)) {
    violations.push({ line: 1, reason: `Invalid asked date: ${askedDate}` })
  }
  if (confidenceLevel && !confidenceLevels.has(confidenceLevel)) {
    violations.push({ line: 1, reason: `Invalid confidence: ${confidenceLevel}` })
  }
  const bodyLines = frontmatter.bodyText.split(/\r?\n/)
  const bodyLinesOutsideFences = blankFencedCodeLines(bodyLines)
  const { violations: headingViolations, headings } = findHeadingViolations(bodyLinesOutsideFences, frontmatter.firstBodyLineNumber)
  violations.push(...headingViolations)
  const sourcesHeading = headings.find((heading) => heading.name === 'Sources')
  if (sourcesHeading) {
    violations.push(...findSourceViolations(sectionLines(bodyLinesOutsideFences, headings, 'Sources'), sourcesHeading.line))
  }
  const answerHeading = headings.find((heading) => heading.name === 'Answer')
  if (answerHeading) {
    const answerWordCount = sectionLines(bodyLinesOutsideFences, headings, 'Answer').join(' ').split(/\s+/).filter(Boolean).length
    if (answerWordCount > maximumAnswerWords) {
      violations.push({ line: answerHeading.line, reason: `Answer must be under 200 words, found ${answerWordCount}` })
    }
  }
  for (const headingName of ['Answer', 'Contradictions', 'Not verified']) {
    const heading = headings.find((candidateHeading) => candidateHeading.name === headingName)
    if (heading && !sectionLines(bodyLines, headings, headingName).some((sectionLine) => sectionLine.trim())) {
      violations.push({ line: heading.line, reason: `Section must not be empty: ## ${headingName}` })
    }
  }
  return violations
}

export async function runResearchCheck(commandArguments, { writeError = console.error } = {}) {
  if (commandArguments.length !== 1 || commandArguments[0].startsWith('-')) {
    writeError('usage: research-check.mjs <path>')
    return addUsageExitCode
  }
  const fileText = await readFile(commandArguments[0], 'utf8')
  const violations = findResearchViolations(fileText)
  if (violations.length === 0) return 0
  violations.forEach((violation) => writeError(`${violation.line}: ${violation.reason}`))
  return researchViolationsExitCode
}

if (isMainModule(import.meta.url)) runCommandLine(runResearchCheck)
