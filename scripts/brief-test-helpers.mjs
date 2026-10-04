import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTemporaryDirectory } from './fixture-test-helpers.mjs'

export async function withTemporaryFile(temporaryDirectoryPrefix, fileText, testFunction, { fileName = 'brief.md' } = {}) {
  return withTemporaryDirectory(temporaryDirectoryPrefix, async (temporaryDirectory) => {
    const briefFilePath = join(temporaryDirectory, fileName)
    await writeFile(briefFilePath, fileText)
    await testFunction(briefFilePath)
  })
}

export const operatorChosenBrief = `# Brief for 2027-03-13

Decisions:

[high] Mon Mar 15 (2d) Drop oldshop.example. The registrar lapsed July 19.

[medium] Sun Mar 21 Book the Oslo flight, evening departure. Riverton ends Sun Mar 21 at 2pm and the conference starts in person Mon Mar 22 (9d).

[low] Wed Mar 24 (11d) Move Sam's Lakeside library appointment. Likely conflict: the Oslo hold runs Mar 22 to 24.

Ahead:

Tue Mar 16 8am Card renewal, Lakeside: bring the library card.
`

export const quietDayBrief = '# Brief for 2026-09-12\n\nNothing due today. Next decision: oldshop.example renewal, Mon Sept 14.\n'

export function briefFile({ date = '2026-09-12', parts = [
  'Decisions:',
  '[high] Mon Sept 14 (2d) Drop oldshop.example. The name serves a site nobody runs.',
  'Ahead:',
  'Tue Sept 15 8am Card appt, Lakeside: bring library card.',
] } = {}) {
  return `# Brief for ${date}\n\n${parts.join('\n\n')}\n`
}

const reservedCharacters = new Set([...'_*[]()~`>#+-=|{}.!'])

function readEscapedCharacter(renderedText, backslashIndex, allowedCharacters) {
  const escapedCharacter = renderedText[backslashIndex + 1]
  assert.ok(escapedCharacter !== undefined, `trailing backslash at ${backslashIndex}`)
  assert.ok(allowedCharacters.has(escapedCharacter), `backslash escapes "${escapedCharacter}" at ${backslashIndex}`)
  return escapedCharacter
}

export function parseMarkdownV2(renderedText) {
  const plainCharacters = []
  let insideCodeSpan = false
  let insideLinkLabel = false
  let insideLinkUrl = false
  let boldMarkerCount = 0
  let index = 0
  while (index < renderedText.length) {
    const character = renderedText[index]
    if (character === '\\') {
      const allowedCharacters = insideCodeSpan
        ? new Set(['`', '\\'])
        : insideLinkUrl ? new Set([')', '\\']) : new Set([...reservedCharacters, '\\'])
      const escapedCharacter = readEscapedCharacter(renderedText, index, allowedCharacters)
      if (!insideLinkUrl) plainCharacters.push(escapedCharacter)
      index += 2
      continue
    }
    if (insideLinkUrl) {
      if (character === ')') insideLinkUrl = false
      index += 1
      continue
    }
    if (character === '`') {
      insideCodeSpan = !insideCodeSpan
      index += 1
      continue
    }
    if (!insideCodeSpan && character === '*') {
      boldMarkerCount += 1
      index += 1
      continue
    }
    if (!insideCodeSpan && character === '[') {
      insideLinkLabel = true
      index += 1
      continue
    }
    if (insideLinkLabel && character === ']' && renderedText[index + 1] === '(') {
      insideLinkLabel = false
      insideLinkUrl = true
      index += 2
      continue
    }
    assert.ok(insideCodeSpan || !reservedCharacters.has(character), `unescaped "${character}" at ${index}`)
    plainCharacters.push(character)
    index += 1
  }
  assert.ok(!insideCodeSpan, 'unclosed code span')
  assert.ok(!insideLinkLabel && !insideLinkUrl, 'unclosed link')
  assert.equal(boldMarkerCount % 2, 0, 'unbalanced bold markers')
  return plainCharacters.join('')
}
