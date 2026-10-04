import { createHash } from 'node:crypto'
import { frontmatterBlockPattern } from './frontmatter.mjs'

const headingPattern = /^(#{1,6})\s+(.*)$/
const fencePattern = /^\s*(```|~~~)/
const ruleLinePattern = /^\s*([-*_])(\s*\1){2,}\s*$/
const listItemPattern = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const quoteLinePattern = /^\s*>\s?(.*)$/
const placeholderPattern = /\u0000(\d+)\u0000/g
const anyPlaceholderPattern = /\u0000\d+\u0000/
const htmlEscapeByCharacter = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const characterByHtmlEscape = Object.fromEntries(Object.entries(htmlEscapeByCharacter).map(([character, htmlEscape]) => [htmlEscape, character]))
const linkableProtocols = new Set(['http:', 'https:'])

const pageStyle = `
:root { --text: #1d1d1f; --muted: #6e6e73; --background: #ffffff; --surface: #f4f4f6; --border: #d9d9de; --link: #0a58ca; }
@media (prefers-color-scheme: dark) {
  :root { --text: #e8e8ea; --muted: #a0a0a8; --background: #16161a; --surface: #222228; --border: #3a3a42; --link: #7ab4ff; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--background); color: var(--text); font: 17px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-text-size-adjust: 100%; }
main { max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; overflow-wrap: anywhere; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 0.5em; }
h1 { font-size: 1.6em; margin-top: 0.4em; }
h2 { font-size: 1.3em; padding-bottom: 0.2em; border-bottom: 1px solid var(--border); }
h3 { font-size: 1.1em; }
p, ul, ol, blockquote, pre { margin: 0 0 1em; }
ul, ol { padding-left: 1.4em; }
li { margin: 0.3em 0; }
li > ul, li > ol { margin: 0.3em 0 0; }
a { color: var(--link); }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--surface); padding: 0.1em 0.3em; border-radius: 4px; }
pre { background: var(--surface); padding: 12px; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid var(--border); padding-left: 12px; color: var(--muted); }
hr { border: 0; border-top: 1px solid var(--border); margin: 2em 0; }
.metadata { color: var(--muted); font-size: 0.9em; border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 20px; }
.metadata div { margin: 2px 0; }
.link-host { color: var(--muted); font-size: 0.85em; }
`

export const pageStyleHash = createHash('sha256').update(pageStyle).digest('base64')

function escapeHtml(plainText) {
  return plainText.replace(/[&<>"']/g, (character) => htmlEscapeByCharacter[character])
}

function unescapeHtml(escapedText) {
  return escapedText.replace(/&(?:amp|lt|gt|quot|#39);/g, (htmlEscape) => characterByHtmlEscape[htmlEscape])
}

function renderLink(linkText, escapedLinkTarget) {
  const linkTarget = unescapeHtml(escapedLinkTarget)
  if (!/^https?:\/\//i.test(linkTarget)) return linkText
  if (!URL.canParse(linkTarget)) return linkText
  const parsedUrl = new URL(linkTarget)
  if (!linkableProtocols.has(parsedUrl.protocol)) return linkText
  if (parsedUrl.username !== '' || parsedUrl.password !== '') return linkText
  const anchorHtml = `<a href="${escapeHtml(parsedUrl.href)}" rel="noopener noreferrer">${linkText}</a>`
  if (linkText === escapedLinkTarget) return anchorHtml
  return `${anchorHtml} <span class="link-host">(${escapeHtml(parsedUrl.hostname)})</span>`
}

function stripClosingHashes(headingText) {
  const trimmedHeadingText = headingText.trimEnd()
  let contentEnd = trimmedHeadingText.length
  while (contentEnd > 0 && trimmedHeadingText[contentEnd - 1] === '#') contentEnd -= 1
  return trimmedHeadingText.slice(0, contentEnd).trimEnd()
}

export function renderInline(markdownText) {
  const protectedFragments = []
  const protect = (htmlFragment) => `\u0000${protectedFragments.push(htmlFragment) - 1}\u0000`
  let html = escapeHtml(markdownText.replace(/\u0000/g, ''))
  html = html.replace(/`([^`]+)`/g, (_, codeText) => protect(`<code>${codeText}</code>`))
  html = html.replace(/!?\[([^\]]*)\]\(([^)\s\u0000]+)\)/g, (_, linkText, linkTarget) => protect(renderLink(linkText, linkTarget)))
  html = html.replace(/https?:\/\/(?:[^\s&<\u0000]|&amp;)*[^\s&<.,;:!?)\]\u0000]/g, (bareUrl) => protect(renderLink(bareUrl, bareUrl)))
  html = html.replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/__(?=\S)(.+?)__/g, '<strong>$1</strong>')
  html = html.replace(/~~(?=\S)(.+?)~~/g, '<del>$1</del>')
  html = html.replace(/(^|[^\w*])\*(?=\S)([^*]+?)\*(?!\w)/g, '$1<em>$2</em>')
  html = html.replace(/(^|[^\w])_(?=\S)([^_]+?)_(?!\w)/g, '$1<em>$2</em>')
  while (anyPlaceholderPattern.test(html)) {
    html = html.replace(placeholderPattern, (_, fragmentIndex) => protectedFragments[Number(fragmentIndex)])
  }
  return html
}

function renderMetadata(frontmatterText) {
  const metadataRows = frontmatterText
    .split(/\r?\n/)
    .map((frontmatterLine) => /^([^:\s][^:]*):\s*(.*)$/.exec(frontmatterLine))
    .filter(Boolean)
    .map(([, fieldName, fieldValue]) => `<div><strong>${escapeHtml(fieldName)}:</strong> ${renderInline(fieldValue)}</div>`)
  if (metadataRows.length === 0) return ''
  return `<div class="metadata">${metadataRows.join('')}</div>`
}

function readListItem(line) {
  const itemMatch = listItemPattern.exec(line)
  if (!itemMatch) return null
  return { indentWidth: itemMatch[1].length, isOrdered: /\d/.test(itemMatch[2]), startNumber: Number.parseInt(itemMatch[2], 10), text: itemMatch[3] }
}

function findNextNonBlankLineIndex(lines, startIndex) {
  let lineIndex = startIndex
  while (lineIndex < lines.length && lines[lineIndex].trim() === '') lineIndex += 1
  return lineIndex
}

function continuesListAfterBlankLines(firstListItem, nextLine) {
  const nextListItem = nextLine === undefined ? null : readListItem(nextLine)
  if (!nextListItem) return false
  return nextListItem.indentWidth > firstListItem.indentWidth || nextListItem.isOrdered === firstListItem.isOrdered
}

function readListItems(lines, startIndex) {
  const listItems = []
  let lineIndex = startIndex
  while (lineIndex < lines.length) {
    const listItem = readListItem(lines[lineIndex])
    if (listItem) {
      listItems.push(listItem)
      lineIndex += 1
      continue
    }
    const nextNonBlankLineIndex = findNextNonBlankLineIndex(lines, lineIndex)
    if (nextNonBlankLineIndex > lineIndex && continuesListAfterBlankLines(listItems[0], lines[nextNonBlankLineIndex])) {
      lineIndex = nextNonBlankLineIndex
      continue
    }
    const isContinuationLine = /^\s+\S/.test(lines[lineIndex]) && listItems.length > 0
    if (!isContinuationLine) break
    listItems[listItems.length - 1].text += ` ${lines[lineIndex].trim()}`
    lineIndex += 1
  }
  return { listItems, nextLineIndex: lineIndex }
}

function renderListItems(listItems) {
  const openLists = []
  const htmlParts = []
  for (const listItem of listItems) {
    while (openLists.length > 0 && listItem.indentWidth < openLists[openLists.length - 1].indentWidth) {
      htmlParts.push(`</li></${openLists.pop().tagName}>`)
    }
    const innermostList = openLists[openLists.length - 1]
    if (!innermostList || listItem.indentWidth > innermostList.indentWidth) {
      const tagName = listItem.isOrdered ? 'ol' : 'ul'
      openLists.push({ indentWidth: listItem.indentWidth, tagName })
      const startAttribute = listItem.isOrdered && listItem.startNumber !== 1 ? ` start="${listItem.startNumber}"` : ''
      htmlParts.push(`<${tagName}${startAttribute}><li>${renderInline(listItem.text)}`)
      continue
    }
    htmlParts.push(`</li><li>${renderInline(listItem.text)}`)
  }
  while (openLists.length > 0) htmlParts.push(`</li></${openLists.pop().tagName}>`)
  return htmlParts.join('')
}

function readFencedCode(lines, startIndex) {
  const fenceMarker = fencePattern.exec(lines[startIndex])[1]
  const codeLines = []
  let lineIndex = startIndex + 1
  while (lineIndex < lines.length && !lines[lineIndex].trim().startsWith(fenceMarker)) {
    codeLines.push(lines[lineIndex])
    lineIndex += 1
  }
  return { html: `<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`, nextLineIndex: lineIndex + 1 }
}

function readQuote(lines, startIndex) {
  const quotedLines = []
  let lineIndex = startIndex
  while (lineIndex < lines.length && quoteLinePattern.test(lines[lineIndex])) {
    quotedLines.push(quoteLinePattern.exec(lines[lineIndex])[1])
    lineIndex += 1
  }
  return { html: `<blockquote>${renderBlocks(quotedLines)}</blockquote>`, nextLineIndex: lineIndex }
}

function startsNewBlock(line) {
  return headingPattern.test(line) || fencePattern.test(line) || ruleLinePattern.test(line) || listItemPattern.test(line) || quoteLinePattern.test(line)
}

function readParagraph(lines, startIndex) {
  const paragraphLines = [lines[startIndex].trim()]
  let lineIndex = startIndex + 1
  while (lineIndex < lines.length && lines[lineIndex].trim() !== '' && !startsNewBlock(lines[lineIndex])) {
    paragraphLines.push(lines[lineIndex].trim())
    lineIndex += 1
  }
  return { html: `<p>${renderInline(paragraphLines.join(' '))}</p>`, nextLineIndex: lineIndex }
}

function readBlock(lines, lineIndex) {
  const line = lines[lineIndex]
  const headingMatch = headingPattern.exec(line)
  if (headingMatch) {
    const headingLevel = headingMatch[1].length
    return { html: `<h${headingLevel}>${renderInline(stripClosingHashes(headingMatch[2]))}</h${headingLevel}>`, nextLineIndex: lineIndex + 1 }
  }
  if (fencePattern.test(line)) return readFencedCode(lines, lineIndex)
  if (ruleLinePattern.test(line)) return { html: '<hr>', nextLineIndex: lineIndex + 1 }
  if (listItemPattern.test(line)) {
    const { listItems, nextLineIndex } = readListItems(lines, lineIndex)
    return { html: renderListItems(listItems), nextLineIndex }
  }
  if (quoteLinePattern.test(line)) return readQuote(lines, lineIndex)
  return readParagraph(lines, lineIndex)
}

function renderBlocks(lines) {
  const htmlBlocks = []
  let lineIndex = 0
  while (lineIndex < lines.length) {
    if (lines[lineIndex].trim() === '') {
      lineIndex += 1
      continue
    }
    const block = readBlock(lines, lineIndex)
    htmlBlocks.push(block.html)
    lineIndex = block.nextLineIndex
  }
  return htmlBlocks.join('\n')
}

function findPageTitle(bodyText, fallbackTitle) {
  const firstHeadingMatch = new RegExp(headingPattern.source, 'm').exec(bodyText)
  if (!firstHeadingMatch) return escapeHtml(fallbackTitle)
  return escapeHtml(stripClosingHashes(firstHeadingMatch[2]).replace(/[*_`]/g, ''))
}

export function renderMarkdownPage(markdownText, fallbackTitle) {
  const frontmatterMatch = frontmatterBlockPattern.exec(markdownText)
  const metadataHtml = frontmatterMatch ? renderMetadata(frontmatterMatch[1] ?? '') : ''
  const bodyText = frontmatterMatch ? markdownText.slice(frontmatterMatch[0].length) : markdownText
  const bodyHtml = renderBlocks(bodyText.split(/\r?\n/))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${findPageTitle(bodyText, fallbackTitle)}</title>
<style>${pageStyle}</style>
</head>
<body>
<main>
${metadataHtml}${bodyHtml}
</main>
</body>
</html>
`
}
