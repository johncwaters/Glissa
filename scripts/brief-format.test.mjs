import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { addUsageExitCode } from './command-line.mjs'
import { captureTestCommand } from './process-test-helpers.mjs'
import { briefFile, operatorChosenBrief, parseMarkdownV2, quietDayBrief, withTemporaryFile } from './brief-test-helpers.mjs'
import { withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { briefViolationsExitCode, standaloneBriefPartLabels } from './brief-check.mjs'
import { briefPartEmoji, chunkFormattedBrief, formatBriefForTelegram, runBriefFormat } from './brief-format.mjs'

const scriptPath = new URL('./brief-format.mjs', import.meta.url)

const operatorChosenRendering = `*Decisions*

🔺 \`Mon Mar 15\` · 2d
→ Drop oldshop\\.example\\.
The registrar lapsed July 19\\.

🔸 \`Sun Mar 21\`
→ Book the Oslo flight, evening departure\\.
Riverton ends Sun Mar 21 at 2pm and the conference starts in person Mon Mar 22 \\(9d\\)\\.

🔹 \`Wed Mar 24\` · 11d
→ Move Sam's Lakeside library appointment\\.
Likely conflict: the Oslo hold runs Mar 22 to 24\\.

*Ahead*

📅 \`Tue Mar 16 8am\`
→ Card renewal, Lakeside: bring the library card\\.`

const decorationPattern = /[()⚠▫📅🔺🔸🔹→·️]/gu

function plainTextOf(briefText) {
  return briefText
    .replace(/^# Brief for \d{4}-\d{2}-\d{2}\n/, '')
    .replace(/^(Decisions|Today|Ahead):$/gm, '$1')
    .replace(/^\[(?:high|medium|low)\] /gm, '')
    .trim()
}

function comparableWords(text) {
  return text.replace(decorationPattern, ' ').replace(/\s+/g, ' ').trim()
}

async function runBriefFormatCliProcess(...commandArguments) {
  return captureTestCommand(process.execPath, [scriptPath.pathname, ...commandArguments])
}

test('renders the operator brief in the chosen layout', () => {
  assert.equal(formatBriefForTelegram(operatorChosenBrief), operatorChosenRendering)
})

test('renders part labels bold without their colon', () => {
  const rendered = formatBriefForTelegram(operatorChosenBrief)
  assert.match(rendered, /^\*Decisions\*$/m)
  assert.match(rendered, /^\*Ahead\*$/m)
  assert.ok(!rendered.includes('*Decisions:*'))
})

test('renders each urgency level as its own emoji and keeps the marker out of the text', () => {
  const parts = [
    'Decisions:',
    '[high] Mon Sept 14 (2d) Drop oldshop.example.',
    '[medium] Sun Sept 20 Book an evening departure.',
    '[low] Wed Sept 23 (11d) Move the library appointment.',
  ]
  const rendered = formatBriefForTelegram(briefFile({ parts }))
  assert.match(rendered, /^🔺 `Mon Sept 14` · 2d$/m)
  assert.match(rendered, /^🔸 `Sun Sept 20`$/m)
  assert.match(rendered, /^🔹 `Wed Sept 23` · 11d$/m)
  assert.ok(!rendered.includes('high'))
})

test('renders each fact sentence on its own line', () => {
  const parts = ['Decisions:', '[high] Mon Sept 14 (2d) Drop oldshop.example. The registrar lapsed July 19. Nobody runs the site.']
  const rendered = formatBriefForTelegram(briefFile({ parts }))
  assert.equal(
    rendered,
    '*Decisions*\n\n🔺 `Mon Sept 14` · 2d\n→ Drop oldshop\\.example\\.\nThe registrar lapsed July 19\\.\nNobody runs the site\\.',
  )
})

test('renders a today item with its own emoji and its time but not its repeated date', () => {
  const parts = ['Today:', 'Thu Sept 10 7pm choir: bring the printed music.', 'Thu Sept 10 (0d) File the renewal.']
  const rendered = formatBriefForTelegram(briefFile({ date: '2026-09-10', parts }))
  assert.equal(rendered, '*Today*\n\n▫️ 7pm choir: bring the printed music\\.\n\n▫️ \\(0d\\) File the renewal\\.')
})

test('renders an item with no facts as the date line and the action alone', () => {
  const parts = ['Ahead:', 'Tue Sept 15 8am Card renewal, Lakeside: bring the library card.']
  const rendered = formatBriefForTelegram(briefFile({ parts }))
  assert.equal(rendered, '*Ahead*\n\n📅 `Tue Sept 15 8am`\n→ Card renewal, Lakeside: bring the library card\\.')
})

test('renders an undated item with its token as inline code and its urgency emoji', () => {
  const parts = ['Decisions:', '[low] Undated Decide whether the client keeps the domain. The registrar lapsed July 19.']
  const rendered = formatBriefForTelegram(briefFile({ parts }))
  assert.equal(rendered, '*Decisions*\n\n🔹 `Undated`\n→ Decide whether the client keeps the domain\\.\nThe registrar lapsed July 19\\.')
})

test('keeps a period inside a domain name out of the action sentence split', () => {
  const parts = ['Decisions:', '[high] Mon Sept 14 (2d) Drop oldshop.example. The name serves a site nobody runs.']
  const rendered = formatBriefForTelegram(briefFile({ parts }))
  assert.match(rendered, /^→ Drop oldshop\\\.example\\\.$/m)
})

test('keeps a capitalised abbreviation out of the sentence split', () => {
  const parts = ['Decisions:', '[low] Wed Sept 23 (11d) Move the appointment with Dr. Example. It collides with the Oslo hold.']
  const rendered = formatBriefForTelegram(briefFile({ parts }))
  assert.match(rendered, /^→ Move the appointment with Dr\\\. Example\\\.$/m)
  assert.match(rendered, /^It collides with the Oslo hold\\\.$/m)
})

test('splits after a sentence ending in a capitalised word that is not a known abbreviation', () => {
  const parts = ['Decisions:', '[medium] Sun Sept 20 Book the evening flight to Oslo. Morgan has the lodging.']
  const rendered = formatBriefForTelegram(briefFile({ parts }))
  assert.match(rendered, /^→ Book the evening flight to Oslo\\\.$/m)
  assert.match(rendered, /^Morgan has the lodging\\\.$/m)
})

test('ends a sentence at a question mark', () => {
  const parts = ['Decisions:', '[high] Mon Sept 14 (2d) Renew the card? The window closes Monday.']
  const rendered = formatBriefForTelegram(briefFile({ parts }))
  assert.match(rendered, /^→ Renew the card\?$/m)
  assert.match(rendered, /^The window closes Monday\\\.$/m)
})

test('carries an emoji for every part label the checker knows', () => {
  for (const partLabel of standaloneBriefPartLabels) assert.match(briefPartEmoji(partLabel), /\S/)
})

test('throws a named error for a part label with no emoji', () => {
  assert.throws(() => briefPartEmoji('Later:'), /Brief part label "Later:" has no emoji/)
})

test('drops the title line', () => {
  const rendered = formatBriefForTelegram(operatorChosenBrief)
  assert.ok(!rendered.includes('Brief for'))
  assert.match(rendered, /^\*Decisions\*/)
})

test('renders a quiet-day brief', () => {
  const rendered = formatBriefForTelegram(quietDayBrief)
  assert.equal(rendered, 'Nothing due today\\. Next decision: oldshop\\.example renewal, Mon Sept 14\\.')
  assert.equal(parseMarkdownV2(rendered), plainTextOf(quietDayBrief))
})

test('output passes a MarkdownV2 parse that keeps every word except Today date tokens', () => {
  const parts = ['Today:', 'Thu Sept 10 7pm choir: bring the printed music.', 'Ahead:', 'Tue Sept 15 Bring the folder.']
  const briefText = briefFile({ date: '2026-09-10', parts })
  const rendered = formatBriefForTelegram(briefText)
  const expectedText = plainTextOf(briefText).replace(/^Thu Sept 10 /m, '')
  assert.equal(comparableWords(parseMarkdownV2(rendered)), comparableWords(expectedText))
  assert.equal(comparableWords(parseMarkdownV2(formatBriefForTelegram(operatorChosenBrief))), comparableWords(plainTextOf(operatorChosenBrief)))
})

test('a MarkdownV2 parse catches an unescaped reserved character', () => {
  assert.throws(() => parseMarkdownV2('Drop oldshop.example'), /unescaped "\."/)
})

test('a MarkdownV2 parse catches an unclosed code span', () => {
  assert.throws(() => parseMarkdownV2('`Mon Sept 14 Drop it'), /unclosed code span/)
})

test('runner returns the clean, violation, and usage exit codes', async () => {
  await withTemporaryFile('glissa-brief-format-', operatorChosenBrief, async (briefFilePath) => {
    const outputLines = []
    const errorLines = []
    const writers = { writeOutput: (line) => outputLines.push(line), writeError: (line) => errorLines.push(line) }
    assert.equal(await runBriefFormat([briefFilePath], writers), 0)
    assert.deepEqual(errorLines, [])
    assert.equal(outputLines.at(-1), operatorChosenRendering)
    assert.equal(await runBriefFormat([], writers), addUsageExitCode)
    assert.match(errorLines.at(-1), /usage/)
    await writeFile(briefFilePath, briefFile({ parts: ['Ahead:', 'Mon Sept 14 The week looms.'] }))
    assert.equal(await runBriefFormat([briefFilePath], writers), briefViolationsExitCode)
    assert.match(errorLines.at(-1), /Banned phrase "looms"/)
    assert.equal(outputLines.length, 1)
  })
})

test('CLI returns the clean, violation, and usage exit codes', async () => {
  await withTemporaryFile('glissa-brief-format-', operatorChosenBrief, async (briefFilePath) => {
    const cleanRun = await runBriefFormatCliProcess(briefFilePath)
    assert.equal(cleanRun.exitCode, 0)
    assert.equal(cleanRun.stdout.trimEnd(), operatorChosenRendering)
    await writeFile(briefFilePath, briefFile({ parts: ['Ahead:', 'Mon Sept 14 The week looms.'] }))
    assert.equal((await runBriefFormatCliProcess(briefFilePath)).exitCode, briefViolationsExitCode)
    assert.equal((await runBriefFormatCliProcess()).exitCode, addUsageExitCode)
  })
})

test('CLI refuses to format a brief naming a task id from the ledger', async () => {
  await withTemporaryDirectory('glissa-brief-format-tasks-', async (temporaryDirectory) => {
    const taskFilePath = join(temporaryDirectory, 'tasks.json')
    const briefFilePath = join(temporaryDirectory, 'brief.md')
    await writeFile(taskFilePath, JSON.stringify({ tasks: [{ id: 'v34w' }] }))
    await writeFile(briefFilePath, briefFile({ parts: ['Today:', 'Sat Sept 12 Complete v34w.'] }))
    const commandRun = await captureTestCommand(process.execPath, [scriptPath.pathname, briefFilePath], {
      env: { ...process.env, GLISSA_TASKS_FILE: taskFilePath },
    })
    assert.equal(commandRun.exitCode, briefViolationsExitCode)
    assert.match(commandRun.stderr, /Task id "v34w" named in the brief; John cannot act on an id/)
  })
})

test('chunks a long brief at blank lines with every chunk sendable', () => {
  const longItems = Array.from({ length: 40 }, (unusedValue, itemIndex) =>
    `Tue Sept 15 8am Library review number ${itemIndex}, Uptown: bring the town library card. The office confirmed the slot by mail and the drive takes ninety minutes each way.`)
  const rendered = formatBriefForTelegram(briefFile({ parts: ['Ahead:', ...longItems] }))
  const chunks = chunkFormattedBrief(rendered)
  assert.ok(chunks.length > 1, `expected more than one chunk, got ${chunks.length}`)
  chunks.forEach((chunk) => {
    assert.ok(chunk.length < 4000, `chunk of ${chunk.length} characters`)
    assert.doesNotThrow(() => parseMarkdownV2(chunk))
    assert.equal(chunk, chunk.trim())
  })
  assert.equal(chunks.join('\n\n'), rendered)
})

test('splits a single item longer than a chunk at its own fact lines', () => {
  const factSentences = Array.from({ length: 40 }, (unusedValue, factIndex) =>
    `The office confirmed slot number ${factIndex} by mail and the drive from Uptown takes about ninety minutes each way.`)
  const parts = ['Ahead:', `Tue Sept 15 8am Library review, Uptown: bring the town library card. ${factSentences.join(' ')}`]
  const rendered = formatBriefForTelegram(briefFile({ parts }))
  const chunks = chunkFormattedBrief(rendered)
  assert.ok(chunks.length > 1, `expected more than one chunk, got ${chunks.length}`)
  chunks.forEach((chunk) => {
    assert.ok(chunk.length < 4000, `chunk of ${chunk.length} characters`)
    assert.doesNotThrow(() => parseMarkdownV2(chunk))
    assert.equal(chunk, chunk.trim())
  })
  const linesOf = (text) => text.split('\n').filter((lineText) => lineText.length > 0)
  assert.deepEqual(chunks.flatMap(linesOf), linesOf(rendered))
})

test('throws when a single brief line cannot fit in a chunk', () => {
  assert.throws(() => chunkFormattedBrief('x'.repeat(4001)), /exceeds the 4000-character chunk limit/)
})

test('chunks a short brief into a single message', () => {
  assert.deepEqual(chunkFormattedBrief(formatBriefForTelegram(operatorChosenBrief)), [operatorChosenRendering])
})

test('runner prints the chunks as a JSON array', async () => {
  await withTemporaryFile('glissa-brief-format-', operatorChosenBrief, async (briefFilePath) => {
    const outputLines = []
    const writers = { writeOutput: (line) => outputLines.push(line), writeError: () => {} }
    assert.equal(await runBriefFormat(['--chunks', briefFilePath], writers), 0)
    assert.deepEqual(JSON.parse(outputLines.at(-1)), [operatorChosenRendering])
    assert.equal(await runBriefFormat(['--chunks'], writers), addUsageExitCode)
  })
})

test('CLI prints the chunks as a JSON array', async () => {
  await withTemporaryFile('glissa-brief-format-', operatorChosenBrief, async (briefFilePath) => {
    const chunkedRun = await runBriefFormatCliProcess('--chunks', briefFilePath)
    assert.equal(chunkedRun.exitCode, 0)
    assert.deepEqual(JSON.parse(chunkedRun.stdout), [operatorChosenRendering])
  })
})
