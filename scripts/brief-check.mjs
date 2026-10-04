import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { addUsageExitCode, isMainModule, runCommandLine } from './command-line.mjs'
import { getTaskIds } from './tasks.mjs'

export const briefViolationsExitCode = 4

const bannedPhrases = [
  'carries weight',
  'the one to watch',
  'looms',
  'has teeth',
  'the one with weight',
  'heavy day',
]

const hedgingModalPattern = /\b(?:could|might|may)\b/gi

const negationAfterModalPattern = /^\s+not\b/i

const dayNumberAfterMonthPattern = /^\s*\d/

const closingOfferPhrases = ['say which', 'let me know', 'want me to', 'shall i']

const decisionsPartLabel = 'Decisions:'

export const standaloneBriefPartLabels = [decisionsPartLabel, 'Today:', 'Ahead:']

const urgencyLevelPattern = /^\[(high|medium|low)\] /

const decisionsItemCharacterCap = 200

const supportingItemCharacterCap = 120

const prepNoteItemCharacterCap = 200

const decisionsItemSentenceCap = 2

const supportingItemSentenceCap = 1

const prepNotePathSuffix = '-prep.md'

const sentenceEndPattern = /[.?!](?=\s|$)/g

const knownAbbreviations = ['Dr', 'Mr', 'Mrs', 'Ms', 'St', 'Ave', 'Jr', 'Sr', 'No']

const knownAbbreviationSource = `(?:^|[^\\p{L}])(?:${knownAbbreviations.join('|')})`

const singleLetterInitialSource = '(?:^|[^\\p{L}.])\\p{L}'

const dottedAcronymSource = '\\p{L}\\.\\p{L}'

const abbreviationBeforePeriodPattern = new RegExp(
  `(?:${knownAbbreviationSource}|${singleLetterInitialSource}|${dottedAcronymSource})$`,
  'u',
)

const briefPartLabels = [...standaloneBriefPartLabels, 'Nothing due today.']

export const briefTitlePattern = /^# Brief for \d{4}-\d{2}-\d{2}$/

const weekdayAbbreviations = 'Mon|Tue|Wed|Thu|Fri|Sat|Sun'

const monthAbbreviations = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Oct|Nov|Dec'

const clockTimeSource = '\\d{1,2}(?::\\d{2})?(?:am|pm)'

const calendarDateSource = `(?:${weekdayAbbreviations}) (?:${monthAbbreviations}) \\d{1,2}(?: ${clockTimeSource})?`

const itemDateTokenPattern = new RegExp(`^(Undated|${calendarDateSource})( \\(\\d+d\\))?(?= |$)`)

const morningBriefFileNamePattern = /^(\d{4}-\d{2}-\d{2})(?:-unsent)?\.md$/

const sentMorningBriefFileNamePattern = /^(\d{4}-\d{2}-\d{2})\.md$/

const itemCalendarDatePattern = new RegExp(`^(?:${weekdayAbbreviations}) (${monthAbbreviations}) (\\d{1,2})`)

const monthNumbersByAbbreviation = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sept: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
}

const seatHousekeepingPhrasePattern = /\b(?:pick|picks|picking|picked|choose|chooses|choosing|chose|select|selects|selecting|selected|change|changes|changing|changed|upgrade|upgrades|upgrading|upgraded)\s+(?:a|the|your|my|our|his|her|their|new|better)?\s*seats?\b/i

const seatHousekeepingNounPhrasePattern = /\bseat\s+(?:selection|assignment|upgrade|change|pick)s?\b/i

const dailyBriefFileNamePattern = /^\d{4}-\d{2}-\d{2}(?:-unsent|-evening)?\.md$/

export function parseItemDateToken(lineText) {
  const urgencyMatch = urgencyLevelPattern.exec(lineText)
  const textAfterUrgencyLevel = lineText.slice(urgencyMatch?.[0].length ?? 0)
  const dateTokenMatch = itemDateTokenPattern.exec(textAfterUrgencyLevel)
  if (!dateTokenMatch) return undefined
  const [matchedPrefix, dateToken, parenthesisedCountdown] = dateTokenMatch
  return {
    urgencyLevel: urgencyMatch?.[1],
    dateToken,
    countdown: parenthesisedCountdown?.trim().slice(1, -1),
    textAfterDateToken: textAfterUrgencyLevel.slice(matchedPrefix.length).trim(),
  }
}

const quotedSpanPattern = /"[^"]*"|“[^”]*”/g

const allowedParagraphOpeners = ['# Brief for', ...briefPartLabels]

const labelledParagraphPattern = /^(?:#|[A-Z][a-z]*:)/

const listMarkerPattern = /^(?:\d+[.)]|[-*+•])(?:\s|$)/

function withoutQuotedSpans(lineText) {
  return lineText.replace(quotedSpanPattern, ' ')
}

function findPhraseViolations(lines, phrases, violationLabel) {
  return lines.flatMap((lineText, lineIndex) => {
    const unquotedText = withoutQuotedSpans(lineText)
    return phrases
      .filter((phrase) => new RegExp(`\\b${phrase}\\b`, 'i').test(unquotedText))
      .map((phrase) => ({ line: lineIndex + 1, reason: `${violationLabel} "${phrase.trim()}": ${lineText.trim()}` }))
  })
}

function isPermittedModalUse(matchedModal, textAfterModal) {
  if (negationAfterModalPattern.test(textAfterModal)) return true
  return matchedModal === 'May' && dayNumberAfterMonthPattern.test(textAfterModal)
}

function findHedgingModalViolations(lines) {
  return lines.flatMap((lineText, lineIndex) => {
    const unquotedText = withoutQuotedSpans(lineText)
    return [...unquotedText.matchAll(hedgingModalPattern)]
      .filter((modalMatch) => !isPermittedModalUse(modalMatch[0], unquotedText.slice(modalMatch.index + modalMatch[0].length)))
      .map((modalMatch) => ({ line: lineIndex + 1, reason: `Banned phrase "${modalMatch[0].toLowerCase()}": ${lineText.trim()}` }))
  })
}

function findListMarkerViolations(lines) {
  return lines.flatMap((lineText, lineIndex) => {
    if (!listMarkerPattern.test(lineText.trim())) return []
    return [{ line: lineIndex + 1, reason: `List marker where prose belongs: ${lineText.trim()}` }]
  })
}

function opensParagraph(lines, lineIndex) {
  if (!lines[lineIndex].trim()) return false
  return lineIndex === 0 || !lines[lineIndex - 1].trim()
}

function opensAllowedParagraph(lineText) {
  return allowedParagraphOpeners.some((allowedOpener) => lineText.startsWith(allowedOpener))
}

function findOpenerViolations(lines) {
  let paragraphsSeen = 0
  return lines.flatMap((lineText, lineIndex) => {
    if (!opensParagraph(lines, lineIndex)) return []
    paragraphsSeen += 1
    if (opensAllowedParagraph(lineText)) return []
    const opensTitleOrFirstPart = paragraphsSeen <= 2
    if (!opensTitleOrFirstPart && !labelledParagraphPattern.test(lineText)) return []
    return [{ line: lineIndex + 1, reason: `Paragraph must open with one of ${allowedParagraphOpeners.join(', ')}: ${lineText.trim()}` }]
  })
}

function partLabelOpening(lineText) {
  return standaloneBriefPartLabels.find((partLabel) => lineText.trim().startsWith(partLabel))
}

function findPartLabelViolations(lines) {
  return lines.flatMap((lineText, lineIndex) => {
    const partLabel = partLabelOpening(lineText)
    if (!partLabel) return []
    const trimmedLine = lineText.trim()
    if (trimmedLine !== partLabel) {
      return [{ line: lineIndex + 1, reason: `Part label must stand alone on its line: ${trimmedLine}` }]
    }
    if (lines[lineIndex + 1]?.trim() === '') return []
    return [{ line: lineIndex + 1, reason: `Part label must be followed by a blank line: ${trimmedLine}` }]
  })
}

function findRunOnItemViolations(lines) {
  return lines.flatMap((lineText, lineIndex) => {
    if (!lineText.trim()) return []
    if (opensParagraph(lines, lineIndex)) return []
    if (partLabelOpening(lines[lineIndex - 1])) return []
    return [{ line: lineIndex + 1, reason: `Item must not wrap onto a second line, and a blank line separates items: ${lineText.trim()}` }]
  })
}

function itemViolation(lineText, lineIndex, reason) {
  return [{ line: lineIndex + 1, reason: `${reason}: ${lineText.trim()}` }]
}

export function splitSentences(itemText) {
  const sentences = []
  let sentenceStartIndex = 0
  for (const sentenceEndMatch of itemText.matchAll(sentenceEndPattern)) {
    const closesAbbreviation =
      sentenceEndMatch[0] === '.' && abbreviationBeforePeriodPattern.test(itemText.slice(0, sentenceEndMatch.index))
    if (closesAbbreviation) continue
    sentences.push(itemText.slice(sentenceStartIndex, sentenceEndMatch.index + 1).trim())
    sentenceStartIndex = sentenceEndMatch.index + 1
  }
  const textAfterLastSentence = itemText.slice(sentenceStartIndex).trim()
  if (textAfterLastSentence) sentences.push(textAfterLastSentence)
  return sentences
}

function supportingItemCharacterCapFor(isPrepNote) {
  if (isPrepNote) return prepNoteItemCharacterCap
  return supportingItemCharacterCap
}

function findItemLengthViolations(lineText, lineIndex, belongsToDecisions, isPrepNote) {
  const characterCap = belongsToDecisions ? decisionsItemCharacterCap : supportingItemCharacterCapFor(isPrepNote)
  const sentenceCap = belongsToDecisions ? decisionsItemSentenceCap : supportingItemSentenceCap
  const trimmedLine = lineText.trim()
  const sentencesWritten = splitSentences(withoutQuotedSpans(trimmedLine)).length
  const overCharacterCap = trimmedLine.length > characterCap
    ? itemViolation(lineText, lineIndex, `Item runs ${trimmedLine.length} characters, over the ${characterCap} cap, so cut every fact the action does not turn on`)
    : []
  const overSentenceCap = sentencesWritten > sentenceCap
    ? itemViolation(lineText, lineIndex, `Item carries ${sentencesWritten} sentences, over the ${sentenceCap} cap, so keep the action and drop the rest`)
    : []
  return [...overCharacterCap, ...overSentenceCap]
}

function findItemShapeViolations(lineText, lineIndex, openPartLabel, checkedFile) {
  const carriesUrgencyLevel = urgencyLevelPattern.test(lineText)
  const belongsToDecisions = openPartLabel === decisionsPartLabel
  if (belongsToDecisions && !carriesUrgencyLevel) {
    return itemViolation(lineText, lineIndex, 'Decisions item must open with [high], [medium], or [low]')
  }
  if (!belongsToDecisions && carriesUrgencyLevel) {
    return itemViolation(lineText, lineIndex, 'Only a Decisions item carries an urgency level')
  }
  const parsedItem = parseItemDateToken(lineText)
  if (!parsedItem) return itemViolation(lineText, lineIndex, 'Item must open with its date or "Undated"')
  if (!parsedItem.textAfterDateToken) {
    return itemViolation(lineText, lineIndex, 'Item must carry its action after the date token')
  }
  const unquotedText = withoutQuotedSpans(lineText)
  const namesSeatHousekeeping = seatHousekeepingPhrasePattern.test(unquotedText) || seatHousekeepingNounPhrasePattern.test(unquotedText)
  const seatSelectionViolations = checkedFile.isDailyBrief && namesSeatHousekeeping
    ? itemViolation(lineText, lineIndex, 'Airline seat selection never earns a brief item')
    : []
  return [
    ...findItemLengthViolations(lineText, lineIndex, belongsToDecisions, checkedFile.isPrepNote),
    ...seatSelectionViolations,
  ]
}

function findItemViolations(lines, checkedFile) {
  let openPartLabel = undefined
  return lines.flatMap((lineText, lineIndex) => {
    if (!opensParagraph(lines, lineIndex)) return []
    if (opensAllowedParagraph(lineText)) {
      openPartLabel = partLabelOpening(lineText) ?? openPartLabel
      return []
    }
    if (!openPartLabel) return []
    return findItemShapeViolations(lineText, lineIndex, openPartLabel, checkedFile)
  })
}

function opensAllowedPart(lineText) {
  return briefPartLabels.some((partLabel) => lineText.trim().startsWith(partLabel))
}

function findStructureViolations(lines) {
  const titleLineIndex = lines.findIndex((lineText) => lineText.trim())
  if (titleLineIndex === -1) return [{ line: 1, reason: 'Brief must open with "# Brief for YYYY-MM-DD"' }]
  const titleLine = lines[titleLineIndex].trim()
  if (!briefTitlePattern.test(titleLine)) {
    return [{ line: titleLineIndex + 1, reason: `Brief must open with "# Brief for YYYY-MM-DD": ${titleLine}` }]
  }
  if (lines.slice(titleLineIndex + 1).some(opensAllowedPart)) return []
  return [{ line: titleLineIndex + 1, reason: `Brief must carry a part opening with one of ${briefPartLabels.join(', ')}` }]
}

function findTaskIdViolations(lines, taskIds) {
  const eligibleTaskIds = new Set(taskIds.filter((taskId) => /\d/.test(taskId)))
  if (eligibleTaskIds.size === 0) return []
  return lines.flatMap((lineText, lineIndex) => [...lineText.matchAll(/\b[a-z0-9]+\b/gi)]
    .filter((wordMatch) => eligibleTaskIds.has(wordMatch[0]))
    .map((wordMatch) => ({ line: lineIndex + 1, reason: `Task id "${wordMatch[0]}" named in the brief; John cannot act on an id` })))
}

export function findBriefViolations(fileText, { filePath = '', taskIds = [] } = {}) {
  const lines = fileText.split(/\r?\n/)
  const checkedFile = {
    isPrepNote: filePath.endsWith(prepNotePathSuffix),
    isDailyBrief: !filePath || dailyBriefFileNamePattern.test(basename(filePath)),
  }
  const violations = [
    ...findPhraseViolations(lines, bannedPhrases, 'Banned phrase'),
    ...findHedgingModalViolations(lines),
    ...findPhraseViolations(lines, closingOfferPhrases, 'Closing offer'),
    ...findListMarkerViolations(lines),
    ...findOpenerViolations(lines),
    ...findPartLabelViolations(lines),
    ...findRunOnItemViolations(lines),
    ...findItemViolations(lines, checkedFile),
    ...findStructureViolations(lines),
    ...findTaskIdViolations(lines, taskIds),
  ]
  return violations.sort((first, second) => first.line - second.line)
}

function dateFromIsoDate(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined
  return date
}

function morningBriefDateFromFilePath(filePath) {
  const morningBriefMatch = morningBriefFileNamePattern.exec(basename(filePath))
  if (!morningBriefMatch) return undefined
  return dateFromIsoDate(morningBriefMatch[1])
}

function aheadItems(fileText) {
  const lines = fileText.split(/\r?\n/)
  let openPartLabel = undefined
  return lines.flatMap((lineText, lineIndex) => {
    if (!opensParagraph(lines, lineIndex)) return []
    const partLabel = partLabelOpening(lineText)
    if (partLabel) {
      openPartLabel = partLabel
      return []
    }
    if (openPartLabel !== 'Ahead:') return []
    if (!parseItemDateToken(lineText)) return []
    return [{ line: lineIndex + 1, text: lineText.trim() }]
  })
}

function itemYearFrom(checkedBriefDate, monthNumber, dayNumber) {
  const briefYear = checkedBriefDate.getUTCFullYear()
  if (Date.UTC(briefYear, monthNumber, dayNumber) < checkedBriefDate.getTime()) return briefYear + 1
  return briefYear
}

function isItemDatedTomorrow(itemText, checkedBriefDate) {
  const parsedItem = parseItemDateToken(itemText)
  if (!parsedItem) return false
  const calendarDateMatch = itemCalendarDatePattern.exec(parsedItem.dateToken)
  if (!calendarDateMatch) return false
  const monthNumber = monthNumbersByAbbreviation[calendarDateMatch[1]]
  const dayNumber = Number(calendarDateMatch[2])
  const itemDate = new Date(Date.UTC(itemYearFrom(checkedBriefDate, monthNumber, dayNumber), monthNumber, dayNumber))
  if (itemDate.getUTCMonth() !== monthNumber) return false
  const tomorrowDate = new Date(checkedBriefDate)
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1)
  return itemDate.getTime() === tomorrowDate.getTime()
}

const countdownTokenPattern = /\s*\(\d+d\)/g

function withoutCountdownToken(itemText) {
  return itemText.replace(countdownTokenPattern, '')
}

async function newestEarlierMorningBriefPath(filePath, checkedBriefDate) {
  const siblingFileNames = await readdir(dirname(filePath))
  const earlierMorningBriefs = siblingFileNames.flatMap((siblingFileName) => {
    const sentMorningBriefMatch = sentMorningBriefFileNamePattern.exec(siblingFileName)
    if (!sentMorningBriefMatch) return []
    const siblingBriefDate = dateFromIsoDate(sentMorningBriefMatch[1])
    if (!siblingBriefDate) return []
    const ageInDays = (checkedBriefDate.getTime() - siblingBriefDate.getTime()) / 86_400_000
    if (ageInDays <= 0 || ageInDays > 7) return []
    return [{ path: join(dirname(filePath), siblingFileName), date: siblingBriefDate }]
  })
  earlierMorningBriefs.sort((firstBrief, secondBrief) => secondBrief.date.getTime() - firstBrief.date.getTime())
  return earlierMorningBriefs[0]?.path
}

async function findRepeatViolations(fileText, filePath) {
  const checkedBriefDate = morningBriefDateFromFilePath(filePath)
  if (!checkedBriefDate) return []
  const earlierMorningBriefPath = await newestEarlierMorningBriefPath(filePath, checkedBriefDate)
  if (!earlierMorningBriefPath) return []
  const earlierMorningBriefText = await readFile(earlierMorningBriefPath, 'utf8')
  const earlierAheadItemTexts = new Set(aheadItems(earlierMorningBriefText).map((item) => withoutCountdownToken(item.text)))
  return aheadItems(fileText).flatMap((item) => {
    if (!earlierAheadItemTexts.has(withoutCountdownToken(item.text))) return []
    if (isItemDatedTomorrow(item.text, checkedBriefDate)) return []
    return [{ line: item.line, reason: `Ahead item repeats ${basename(earlierMorningBriefPath)}: ${item.text}` }]
  })
}

export async function runBriefCheck(commandArguments, { writeError = console.error } = {}) {
  if (commandArguments.length !== 1 || commandArguments[0].startsWith('-')) {
    writeError('usage: brief-check.mjs <path>')
    return addUsageExitCode
  }
  const fileText = await readFile(commandArguments[0], 'utf8')
  const taskIds = await getTaskIds()
  const violations = [
    ...findBriefViolations(fileText, { filePath: commandArguments[0], taskIds }),
    ...await findRepeatViolations(fileText, commandArguments[0]),
  ].sort((first, second) => first.line - second.line)
  if (violations.length === 0) return 0
  violations.forEach((violation) => writeError(`${violation.line}: ${violation.reason}`))
  return briefViolationsExitCode
}

if (isMainModule(import.meta.url)) runCommandLine(runBriefCheck)
