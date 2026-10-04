import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import test from 'node:test'
import { addUsageExitCode } from './command-line.mjs'
import { captureTestCommand } from './process-test-helpers.mjs'
import { withTemporaryFile } from './brief-test-helpers.mjs'
import { findResearchViolations, researchViolationsExitCode, runResearchCheck } from './research-check.mjs'

const scriptPath = new URL('./research-check.mjs', import.meta.url)

function researchFile({ question = 'Which option should I choose?', asked = '2026-09-10', confidence = 'high', headings = ['Answer', 'Sources', 'Contradictions', 'Not verified'], answer = 'Choose the first option.', sources = [
  '- First source https://example.com/one — primary evidence. read 2026-09-10. read: full',
  '- Second source https://example.org/two — independent evidence. read 2026-09-10. read: full',
  '- Third source https://example.net/three — supporting evidence. read 2026-09-10. read: full',
], contradictions = 'None found.', notVerified = 'None.' } = {}) {
  const sections = {
    Answer: answer,
    Sources: sources.join('\n'),
    Contradictions: contradictions,
    'Not verified': notVerified,
  }
  const body = headings.map((heading) => `## ${heading}\n${sections[heading] ?? 'Extra section.'}`).join('\n\n')
  return `---\nquestion: ${question}\nasked: ${asked}\nconfidence: ${confidence}\n---\n\n${body}\n`
}

function firstReason(fileText) {
  return findResearchViolations(fileText)[0]?.reason
}

async function runResearchCliProcess(...commandArguments) {
  return captureTestCommand(process.execPath, [scriptPath.pathname, ...commandArguments])
}

test('accepts a valid research file', () => {
  assert.deepEqual(findResearchViolations(researchFile()), [])
})

for (const frontmatterKey of ['question', 'asked', 'confidence']) {
  test(`rejects a missing ${frontmatterKey} frontmatter key`, () => {
    assert.match(firstReason(researchFile().replace(new RegExp(`^${frontmatterKey}: .*\\n`, 'm'), '')), new RegExp(`Missing frontmatter key: ${frontmatterKey}`))
  })
}

test('rejects a frontmatter key outside question, asked, and confidence', () => {
  assert.match(firstReason(researchFile().replace('confidence: high', 'confidence: high\nsummary: extra')), /Unexpected frontmatter key: summary/)
})

test('rejects a question spilling onto a second line that parses as a stray key', () => {
  assert.match(firstReason(researchFile({ question: 'Which option should I choose?\nWhy: the deadline moved' })), /Unexpected frontmatter key: Why/)
})

test('accepts a fenced code block whose line starts with a heading marker', () => {
  const answer = 'Choose the first option.\n\n```\n## Sources\n- not a source bullet\n```'
  assert.deepEqual(findResearchViolations(researchFile({ answer })), [])
})

test('treats end of file as closing an unclosed fence and still recognises the headings before it', () => {
  const notVerified = 'None.\n\n```\n## Appendix'
  assert.deepEqual(findResearchViolations(researchFile({ notVerified })), [])
})

test('rejects an invalid asked date', () => {
  assert.match(firstReason(researchFile({ asked: '2026-02-30' })), /Invalid asked date/)
})

test('rejects an invalid confidence', () => {
  assert.match(firstReason(researchFile({ confidence: 'certain' })), /Invalid confidence/)
})

test('accepts a confidence with a trailing space', () => {
  assert.deepEqual(findResearchViolations(researchFile({ confidence: 'high ' })), [])
})

test('accepts an asked date with a trailing space', () => {
  assert.deepEqual(findResearchViolations(researchFile({ asked: '2026-09-10 ' })), [])
})

test('accepts a heading with a trailing space', () => {
  assert.deepEqual(findResearchViolations(researchFile({ headings: ['Answer ', 'Sources', 'Contradictions', 'Not verified'] })), [])
})

test('accepts an indented sub-bullet under a source bullet', () => {
  const sources = [
    '- First source https://example.com/one read 2026-09-10. read: full',
    '  - retrieved 2026-09-10, section two',
    '- Second source https://example.org/two read 2026-09-10. read: full',
    '- Third source https://example.net/three read 2026-09-10. read: full',
  ]
  assert.deepEqual(findResearchViolations(researchFile({ sources })), [])
})

test('counts a source bullet with an indented sub-bullet as one source', () => {
  const sources = [
    '- First source https://example.com/one read 2026-09-10. read: full',
    '  - retrieved 2026-09-10',
    '- Second source https://example.org/two read 2026-09-10. read: full',
    '  - retrieved 2026-09-10',
  ]
  assert.match(firstReason(researchFile({ sources })), /at least three bullets/)
})

test('rejects a source bullet with no read status', () => {
  const sources = [
    '- First source https://example.com/one — primary evidence.',
    '- Second source https://example.org/two read 2026-09-10. read: full',
    '- Third source https://example.net/three read 2026-09-10. read: full',
  ]
  assert.match(firstReason(researchFile({ sources })), /must end with read: full, read: summary, or read: blocked/)
})

test('rejects a source bullet with an unknown read status', () => {
  const sources = [
    '- First source https://example.com/one read: skimmed',
    '- Second source https://example.org/two read 2026-09-10. read: full',
    '- Third source https://example.net/three read 2026-09-10. read: full',
  ]
  assert.match(firstReason(researchFile({ sources })), /must end with read: full, read: summary, or read: blocked/)
})

test('accepts three sources read in full alongside a blocked source', () => {
  const sources = [
    '- First source https://example.com/one read 2026-09-10. read: full',
    '- Second source https://example.org/two read 2026-09-10. read: full',
    '- Third source https://example.net/three read 2026-09-10. read: full',
    '- Fourth source https://example.edu/four read 2026-09-10. read: blocked',
  ]
  assert.deepEqual(findResearchViolations(researchFile({ sources })), [])
})

test('rejects a summary source bullet with no URL', () => {
  const sources = [
    '- First source https://example.com/one read 2026-09-10. read: full',
    '- Second source https://example.org/two read 2026-09-10. read: full',
    '- Third source https://example.net/three read 2026-09-10. read: full',
    '- Fourth source with no url at all read: summary',
  ]
  assert.match(firstReason(researchFile({ sources })), /must contain an https:\/\/ URL/)
})

test('rejects a blocked source bullet whose URL is not https', () => {
  const sources = [
    '- First source https://example.com/one read 2026-09-10. read: full',
    '- Second source https://example.org/two read 2026-09-10. read: full',
    '- Third source https://example.net/three read 2026-09-10. read: full',
    '- Fourth source ftp://example.edu/four read: blocked',
  ]
  assert.match(firstReason(researchFile({ sources })), /must contain an https:\/\/ URL/)
})

test('rejects a summary standing in for the third source read in full', () => {
  const sources = [
    '- First source https://example.com/one read 2026-09-10. read: full',
    '- Second source https://example.org/two read 2026-09-10. read: full',
    '- Third source https://example.net/three read 2026-09-10. read: summary',
  ]
  assert.match(firstReason(researchFile({ sources })), /at least three bullets read in full/)
})

test('rejects headings out of order', () => {
  assert.match(firstReason(researchFile({ headings: ['Sources', 'Answer', 'Contradictions', 'Not verified'] })), /Expected heading/)
})

test('rejects an extra level-two heading', () => {
  assert.match(firstReason(researchFile({ headings: ['Answer', 'Sources', 'Extra', 'Contradictions', 'Not verified'] })), /Expected heading/)
})

test('rejects a heading after the required four', () => {
  assert.match(firstReason(researchFile({ headings: ['Answer', 'Sources', 'Contradictions', 'Not verified', 'Appendix'] })), /Unexpected heading: ## Appendix/)
})

test('rejects fewer than three sources', () => {
  assert.match(firstReason(researchFile({ sources: ['- First source https://example.com/one read 2026-09-10. read: full', '- Second source https://example.org/two read 2026-09-10. read: full'] })), /at least three bullets/)
})

test('rejects three sources on one hostname', () => {
  const sources = ['- First https://example.com/one read 2026-09-10. read: full', '- Second https://example.com/two read 2026-09-10. read: full', '- Third https://example.com/three read 2026-09-10. read: full']
  assert.match(firstReason(researchFile({ sources })), /distinct hostnames/)
})

test('rejects an Answer of 200 words or more', () => {
  assert.match(firstReason(researchFile({ answer: 'word '.repeat(200).trim() })), /Answer must be under 200 words, found 200/)
})

test('accepts an Answer of 199 words', () => {
  assert.deepEqual(findResearchViolations(researchFile({ answer: 'word '.repeat(199).trim() })), [])
})

test('rejects a source bullet with no date read or published', () => {
  const sources = ['- First https://example.com/one read: full', '- Second https://example.org/two read 2026-09-10. read: full', '- Third https://example.net/three read 2026-09-10. read: full']
  assert.match(firstReason(researchFile({ sources })), /must carry the date read or published/)
})

test('does not count a date inside the source URL as the source date', () => {
  const sources = ['- First https://example.com/2026-09-10/one read: full', '- Second https://example.org/two read 2026-09-10. read: full', '- Third https://example.net/three read 2026-09-10. read: full']
  assert.match(firstReason(researchFile({ sources })), /must carry the date read or published/)
})

test('rejects a source bullet whose only date is not a real calendar date', () => {
  const sources = ['- First https://example.com/one read 2026-13-45. read: full', '- Second https://example.org/two read 2026-09-10. read: full', '- Third https://example.net/three read 2026-09-10. read: full']
  assert.match(firstReason(researchFile({ sources })), /must carry the date read or published/)
})

test('does not count a date inside a second source URL as the source date', () => {
  const sources = ['- First https://example.com/one archived https://web.archive.org/web/2026-09-10/one read: full', '- Second https://example.org/two read 2026-09-10. read: full', '- Third https://example.net/three read 2026-09-10. read: full']
  assert.match(firstReason(researchFile({ sources })), /must carry the date read or published/)
})

test('does not count a date inside an http mirror URL as the source date', () => {
  const sources = ['- First https://example.com/one mirror http://mirror.example.com/2026-09-10/one read: full', '- Second https://example.org/two read 2026-09-10. read: full', '- Third https://example.net/three read 2026-09-10. read: full']
  assert.match(firstReason(researchFile({ sources })), /must carry the date read or published/)
})

test('rejects an empty Answer section', () => {
  assert.match(firstReason(researchFile({ answer: '' })), /Section must not be empty: ## Answer/)
})

test('rejects an empty Contradictions section', () => {
  assert.match(firstReason(researchFile({ contradictions: '' })), /Section must not be empty: ## Contradictions/)
})

test('rejects an empty Not verified section', () => {
  assert.match(firstReason(researchFile({ notVerified: '' })), /Section must not be empty: ## Not verified/)
})

test('runner returns the clean, violation, and usage exit codes', async () => {
  await withTemporaryFile('assistant-research-', researchFile(), async (researchFilePath) => {
    const errorLines = []
    assert.equal(await runResearchCheck([researchFilePath], { writeError: (line) => errorLines.push(line) }), 0)
    assert.deepEqual(errorLines, [])
    assert.equal(await runResearchCheck([], { writeError: (line) => errorLines.push(line) }), addUsageExitCode)
    assert.match(errorLines.at(-1), /usage/)
    await writeFile(researchFilePath, researchFile({ confidence: 'certain' }))
    assert.equal(await runResearchCheck([researchFilePath], { writeError: (line) => errorLines.push(line) }), researchViolationsExitCode)
  }, { fileName: 'research.md' })
})

test('CLI returns the clean, violation, and usage exit codes', async () => {
  await withTemporaryFile('assistant-research-', researchFile(), async (researchFilePath) => {
    assert.equal((await runResearchCliProcess(researchFilePath)).exitCode, 0)
    await writeFile(researchFilePath, researchFile({ confidence: 'certain' }))
    assert.equal((await runResearchCliProcess(researchFilePath)).exitCode, researchViolationsExitCode)
    assert.equal((await runResearchCliProcess()).exitCode, addUsageExitCode)
  }, { fileName: 'research.md' })
})
