import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import test from 'node:test'
import { briefViolationsExitCode } from './brief-check.mjs'
import { parseMarkdownV2, withTemporaryFile } from './brief-test-helpers.mjs'
import { addUsageExitCode } from './command-line.mjs'
import { captureTestCommand } from './process-test-helpers.mjs'
import { formatReplyForTelegram, runReplyFormat } from './reply-format.mjs'

const scriptPath = new URL('./reply-format.mjs', import.meta.url)

async function runReplyFormatCliProcess(...commandArguments) {
  return captureTestCommand(process.execPath, [scriptPath.pathname, ...commandArguments])
}

test('renders bold, code, bullets, emoji, and reserved characters as valid MarkdownV2', () => {
  const replyText = '✅ **Pay $41.95 (2d)!**\n- Keep `code_name\\path` and the receipt.\n- Date: Mon Sept 14 - done!'
  const formattedText = formatReplyForTelegram(replyText)
  assert.equal(formattedText, '✅ *Pay $41\\.95 \\(2d\\)\\!*\n• Keep `code_name\\\\path` and the receipt\\.\n• Date: Mon Sept 14 \\- done\\!')
  assert.equal(parseMarkdownV2(formattedText), '✅ Pay $41.95 (2d)!\n• Keep code_name\\path and the receipt.\n• Date: Mon Sept 14 - done!')
})

test('renders a link while escaping only closing parentheses and backslashes in its URL', () => {
  const formattedText = formatReplyForTelegram('📅 [A. - B!](https://maps.example/a_(b)?price=$41.95)')
  assert.equal(formattedText, '📅 [A\\. \\- B\\!](https://maps.example/a_(b\\)?price=$41.95)')
  assert.equal(parseMarkdownV2(formattedText), '📅 A. - B!')
})

test('flags bare URLs on their source line', async () => {
  await withTemporaryFile('glissa-reply-', '✅ Done.\nSee https://example.com/a_b', async (replyPath) => {
    const errorLines = []
    const exitCode = await runReplyFormat([replyPath], { writeOutput: () => {}, writeError: (line) => errorLines.push(line) })
    assert.equal(exitCode, briefViolationsExitCode)
    assert.deepEqual(errorLines, ['line 2: bare URL, wrap it as [label](url)'])
  })
})

test('flags a link label that looks like a URL or a domain', () => {
  const urlLikeLabels = ['https://accounts.google.com', 'www.google.com', 'accounts.google.com', 'Open oldshop.example']
  urlLikeLabels.forEach((urlLikeLabel) => {
    assert.throws(() => formatReplyForTelegram(`✅ Done.\n📅 [${urlLikeLabel}](https://evil.example)`), {
      message: 'line 2: link label looks like a URL, use words',
    })
  })
})

test('accepts a link label written in words with sentence punctuation', () => {
  assert.equal(formatReplyForTelegram('[Full research. Read it](https://example.com)'), '[Full research\\. Read it](https://example.com)')
})

test('flags an unclosed bold marker and an unclosed backtick', async () => {
  await withTemporaryFile('glissa-reply-', '**Book now', async (replyPath) => {
    const errorLines = []
    const writers = { writeOutput: () => {}, writeError: (line) => errorLines.push(line) }
    assert.equal(await runReplyFormat([replyPath], writers), briefViolationsExitCode)
    assert.equal(errorLines.at(-1), 'line 1: unclosed **')
    await writeFile(replyPath, '✅ Done.\n`unfinished')
    assert.equal(await runReplyFormat([replyPath], writers), briefViolationsExitCode)
    assert.equal(errorLines.at(-1), 'line 2: unclosed backtick')
  })
})

test('chunks long replies into valid messages no longer than 4000 characters', async () => {
  const replyText = Array.from({ length: 180 }, (unusedValue, itemIndex) => `- Item ${itemIndex}: pay $41.95 (2d)!`).join('\n')
  await withTemporaryFile('glissa-reply-', replyText, async (replyPath) => {
    const outputLines = []
    assert.equal(await runReplyFormat([replyPath], { writeOutput: (line) => outputLines.push(line) }), 0)
    const chunks = JSON.parse(outputLines.at(-1))
    assert.ok(chunks.length > 1)
    chunks.forEach((chunk) => {
      assert.ok(chunk.length <= 4000)
      assert.doesNotThrow(() => parseMarkdownV2(chunk))
    })
    assert.deepEqual(chunks.flatMap((chunk) => chunk.split('\n')), formatReplyForTelegram(replyText).split('\n'))
  })
})

test('CLI prints JSON chunks and uses the clean, violation, usage, and failure exit codes', async () => {
  await withTemporaryFile('glissa-reply-', '✅ **Done.** [Map](https://maps.example/a_(b))', async (replyPath) => {
    const cleanRun = await runReplyFormatCliProcess(replyPath)
    assert.equal(cleanRun.exitCode, 0)
    const chunks = JSON.parse(cleanRun.stdout)
    assert.deepEqual(chunks, ['✅ *Done\\.* [Map](https://maps.example/a_(b\\))'])
    assert.equal(parseMarkdownV2(chunks[0]), '✅ Done. Map')
    await writeFile(replyPath, 'https://example.com')
    const violationRun = await runReplyFormatCliProcess(replyPath)
    assert.equal(violationRun.exitCode, briefViolationsExitCode)
    assert.match(violationRun.stderr, /line 1: bare URL, wrap it as \[label\]\(url\)/)
    assert.equal((await runReplyFormatCliProcess()).exitCode, addUsageExitCode)
    assert.equal((await runReplyFormatCliProcess(`${replyPath}.missing`)).exitCode, 1)
  })
})
