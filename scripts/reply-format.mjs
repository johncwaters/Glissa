import { readFile } from 'node:fs/promises'
import { chunkFormattedBrief, escapeReservedCharacters } from './brief-format.mjs'
import { briefViolationsExitCode } from './brief-check.mjs'
import { addUsageExitCode, isMainModule, runCommandLine } from './command-line.mjs'

class ReplyMarkupViolation extends Error {}

const urlLikeLabelPattern = /:\/\/|^\s*www\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i


function readLink(lineText, startIndex, lineNumber) {
  const labelEndIndex = lineText.indexOf('](', startIndex + 1)
  if (labelEndIndex === -1) return undefined
  const urlStartIndex = labelEndIndex + 2
  const urlPrefix = lineText.slice(urlStartIndex).match(/^https?:\/\//)?.[0]
  if (!urlPrefix) return undefined
  let nestedParentheses = 0
  for (let index = urlStartIndex + urlPrefix.length; index < lineText.length; index += 1) {
    const character = lineText[index]
    if (character === '(') nestedParentheses += 1
    if (character !== ')') continue
    if (nestedParentheses > 0) {
      nestedParentheses -= 1
      continue
    }
    const label = lineText.slice(startIndex + 1, labelEndIndex)
    if (urlLikeLabelPattern.test(label)) throw new ReplyMarkupViolation(`line ${lineNumber}: link label looks like a URL, use words`)
    const url = lineText.slice(urlStartIndex, index)
    return { text: `[${escapeReservedCharacters(label)}](${url.replace(/[)\\]/g, '\\$&')})`, endIndex: index + 1 }
  }
  return undefined
}

function formatReplyLine(lineText, lineNumber) {
  const hasBullet = lineText.startsWith('- ')
  const textAfterBullet = hasBullet ? lineText.slice(2) : lineText
  const renderedParts = hasBullet ? ['• '] : []
  let insideBold = false
  let index = 0
  while (index < textAfterBullet.length) {
    if (textAfterBullet.startsWith('http://', index) || textAfterBullet.startsWith('https://', index)) {
      throw new ReplyMarkupViolation(`line ${lineNumber}: bare URL, wrap it as [label](url)`)
    }
    if (textAfterBullet.startsWith('**', index)) {
      insideBold = !insideBold
      renderedParts.push('*')
      index += 2
      continue
    }
    if (textAfterBullet[index] === '`') {
      const codeEndIndex = textAfterBullet.indexOf('`', index + 1)
      if (codeEndIndex === -1) throw new ReplyMarkupViolation(`line ${lineNumber}: unclosed backtick`)
      const codeText = textAfterBullet.slice(index + 1, codeEndIndex)
      if (/https?:\/\//.test(codeText)) {
        throw new ReplyMarkupViolation(`line ${lineNumber}: bare URL, wrap it as [label](url)`)
      }
      renderedParts.push(`\`${codeText.replace(/[`\\]/g, '\\$&')}\``)
      index = codeEndIndex + 1
      continue
    }
    if (textAfterBullet[index] === '[') {
      const link = readLink(textAfterBullet, index, lineNumber)
      if (link) {
        renderedParts.push(link.text)
        index = link.endIndex
        continue
      }
    }
    renderedParts.push(escapeReservedCharacters(textAfterBullet[index]))
    index += 1
  }
  if (insideBold) throw new ReplyMarkupViolation(`line ${lineNumber}: unclosed **`)
  return renderedParts.join('')
}

export function formatReplyForTelegram(fileText) {
  return fileText.split(/\r?\n/).map((lineText, lineIndex) => formatReplyLine(lineText, lineIndex + 1)).join('\n').trim()
}

export async function runReplyFormat(commandArguments, { writeOutput = console.log, writeError = console.error } = {}) {
  if (commandArguments.length !== 1 || commandArguments[0].startsWith('-')) {
    writeError('usage: reply-format.mjs <path>')
    return addUsageExitCode
  }
  const fileText = await readFile(commandArguments[0], 'utf8')
  let formattedText
  try {
    formattedText = formatReplyForTelegram(fileText)
  } catch (error) {
    if (!(error instanceof ReplyMarkupViolation)) throw error
    writeError(error.message)
    return briefViolationsExitCode
  }
  writeOutput(JSON.stringify(chunkFormattedBrief(formattedText)))
  return 0
}

if (isMainModule(import.meta.url)) runCommandLine(runReplyFormat)
