import { readFile } from 'node:fs/promises'
import { addUsageExitCode, isMainModule, runCommandLine } from './command-line.mjs'
import { getTaskIds } from './tasks.mjs'
import {
  briefTitlePattern,
  briefViolationsExitCode,
  findBriefViolations,
  parseItemDateToken,
  splitSentences,
  standaloneBriefPartLabels,
} from './brief-check.mjs'

const reservedCharacterPattern = /[_*[\]()~`>#+\-=|{}.!\\]/g

const maximumChunkLength = 4000

const partEmojiByLabel = { 'Decisions:': '⚠️', 'Today:': '▫️', 'Ahead:': '📅' }

const urgencyEmojiByLevel = { high: '🔺', medium: '🔸', low: '🔹' }

export function briefPartEmoji(partLabel) {
  const partEmoji = partEmojiByLabel[partLabel]
  if (partEmoji) return partEmoji
  throw new Error(`Brief part label "${partLabel}" has no emoji in brief-format.mjs`)
}

export function escapeReservedCharacters(plainText) {
  return plainText.replace(reservedCharacterPattern, (character) => `\\${character}`)
}

function renderCountdown(countdown) {
  if (!countdown) return ''
  return ` · ${countdown}`
}

function renderTodayItem(partEmoji, parsedItem) {
  const timeOfDay = parsedItem.dateToken.match(/\d{1,2}(?::\d{2})?(?:am|pm)$/)?.[0]
  const countdown = parsedItem.countdown && `(${parsedItem.countdown})`
  const itemText = [timeOfDay, countdown, parsedItem.textAfterDateToken].filter(Boolean).join(' ')
  return `${partEmoji} ${escapeReservedCharacters(itemText)}`
}

function renderItem(lineText, partLabel) {
  const partEmoji = partLabel ? briefPartEmoji(partLabel) : ''
  const parsedItem = parseItemDateToken(lineText)
  if (!parsedItem) return escapeReservedCharacters(lineText)
  if (partLabel === 'Today:') return renderTodayItem(partEmoji, parsedItem)
  const itemEmoji = urgencyEmojiByLevel[parsedItem.urgencyLevel] ?? partEmoji
  const dateLine = `${itemEmoji} \`${parsedItem.dateToken}\`${renderCountdown(parsedItem.countdown)}`.trimStart()
  const [actionSentence, ...factSentences] = splitSentences(parsedItem.textAfterDateToken)
  if (!actionSentence) return dateLine
  const factLines = factSentences.map((factSentence) => `\n${escapeReservedCharacters(factSentence)}`)
  return `${dateLine}\n→ ${escapeReservedCharacters(actionSentence)}${factLines.join('')}`
}

function renderPartLabel(partLabel) {
  return `*${escapeReservedCharacters(partLabel.slice(0, -1))}*`
}

export function formatBriefForTelegram(fileText) {
  const bodyLines = fileText.split(/\r?\n/).filter((lineText) => !briefTitlePattern.test(lineText.trim()))
  const renderedLines = []
  let openPartLabel = ''
  for (const lineText of bodyLines) {
    const partLabel = standaloneBriefPartLabels.find((label) => lineText.trim() === label)
    if (partLabel) {
      openPartLabel = partLabel
      renderedLines.push(renderPartLabel(partLabel))
      continue
    }
    renderedLines.push(lineText.trim() ? renderItem(lineText, openPartLabel) : '')
  }
  return renderedLines.join('\n').trim()
}

function splitBlockAtLines(oversizedBlock) {
  const blockChunks = []
  let openChunk = ''
  for (const lineText of oversizedBlock.split('\n')) {
    if (lineText.length > maximumChunkLength) {
      throw new Error(`Brief line of ${lineText.length} characters exceeds the ${maximumChunkLength}-character chunk limit`)
    }
    if (openChunk && openChunk.length + 1 + lineText.length <= maximumChunkLength) {
      openChunk = `${openChunk}\n${lineText}`
      continue
    }
    if (openChunk) blockChunks.push(openChunk)
    openChunk = lineText
  }
  if (openChunk) blockChunks.push(openChunk)
  return blockChunks
}

export function chunkFormattedBrief(formattedText) {
  const chunks = []
  let openChunk = ''
  for (const blankLineSeparatedBlock of formattedText.split('\n\n')) {
    if (blankLineSeparatedBlock.length > maximumChunkLength) {
      if (openChunk) chunks.push(openChunk)
      const blockChunks = splitBlockAtLines(blankLineSeparatedBlock)
      chunks.push(...blockChunks.slice(0, -1))
      openChunk = blockChunks.at(-1) ?? ''
      continue
    }
    if (!openChunk) {
      openChunk = blankLineSeparatedBlock
      continue
    }
    if (openChunk.length + 2 + blankLineSeparatedBlock.length <= maximumChunkLength) {
      openChunk = `${openChunk}\n\n${blankLineSeparatedBlock}`
      continue
    }
    chunks.push(openChunk)
    openChunk = blankLineSeparatedBlock
  }
  if (openChunk) chunks.push(openChunk)
  return chunks
}

export async function runBriefFormat(commandArguments, { writeOutput = console.log, writeError = console.error } = {}) {
  const wantsChunks = commandArguments[0] === '--chunks'
  const pathArguments = wantsChunks ? commandArguments.slice(1) : commandArguments
  if (pathArguments.length !== 1 || pathArguments[0].startsWith('-')) {
    writeError('usage: brief-format.mjs [--chunks] <path>')
    return addUsageExitCode
  }
  const fileText = await readFile(pathArguments[0], 'utf8')
  const taskIds = await getTaskIds()
  const violations = findBriefViolations(fileText, { filePath: pathArguments[0], taskIds })
  if (violations.length > 0) {
    violations.forEach((violation) => writeError(`${violation.line}: ${violation.reason}`))
    return briefViolationsExitCode
  }
  const formattedText = formatBriefForTelegram(fileText)
  if (wantsChunks) {
    writeOutput(JSON.stringify(chunkFormattedBrief(formattedText)))
    return 0
  }
  writeOutput(formattedText)
  return 0
}

if (isMainModule(import.meta.url)) runCommandLine(runBriefFormat)
