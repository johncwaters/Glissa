import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const operatorIdentifiers = String.raw`\bjohn\b|johncwaters|jwaters|personal-[123]|glimmervoid|posthog|projects/glissa`
const operatorIdentifierPattern = new RegExp(operatorIdentifiers, 'i')
const exemptions = [
  { file: '.claude/settings.json', text: '"mcp__posthog__*"', reason: 'Denying third-party tools protects every install.' },
  { file: 'systemd/glissa-settings.json', text: '"mcp__posthog__*"', reason: 'Denying third-party tools protects every install.' },
  { file: 'systemd/glissa-settings.json', text: '"Read(~/.glimmervoid/config.json*)"', reason: 'Denying access to third-party credentials protects every install.' },
  { file: '.gitignore', text: '.glimmervoid/', reason: 'The tool state directory must stay out of git.' },
  { file: '.claude/settings.json', text: '@posthog/coherence', reason: 'The Coherence package is published under this npm scope.' },
  { file: '.codex/hooks.json', text: '@posthog/coherence', reason: 'The Coherence package is published under this npm scope.' },
  { file: 'package.json', text: '@posthog/coherence', reason: 'The Coherence package is published under this npm scope.' },
  { file: 'package-lock.json', text: '@posthog/coherence', reason: 'The Coherence package is published under this npm scope.' },
]

function checkLineAgainstExemptions(file, lineText) {
  const matchingExemptions = exemptions.filter((exemption) => exemption.file === file && lineText.includes(exemption.text))
  const textOutsideExemptions = matchingExemptions.reduce((remainingText, exemption) => remainingText.replaceAll(exemption.text, ' '), lineText)
  return { matchingExemptions, hasUnexemptedIdentifier: operatorIdentifierPattern.test(textOutsideExemptions) }
}

test('an exempted line still fails when it carries another operator identifier', () => {
  assert.equal(checkLineAgainstExemptions('.gitignore', '.glimmervoid/').hasUnexemptedIdentifier, false)
  assert.equal(checkLineAgainstExemptions('.gitignore', '.glimmervoid/ # John personal-1 Projects/Glissa PostHog').hasUnexemptedIdentifier, true)
})

test('tracked sources contain no original operator identifiers outside protective exemptions', (context) => {
  const workTreeCheck = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repositoryRoot, encoding: 'utf8' })
  if (workTreeCheck.error?.code === 'ENOENT') {
    context.skip('git is unavailable in this installation')
    return
  }
  assert.ifError(workTreeCheck.error)
  if (workTreeCheck.stdout.trim() === 'false' || /not a git repository|must be run in a work tree/.test(workTreeCheck.stderr)) {
    context.skip('this installation is not a git work tree')
    return
  }
  assert.equal(workTreeCheck.status, 0, workTreeCheck.stderr)
  const identifierSearch = spawnSync('git', [
    'grep', '-n', '-I', '-i', '-E', '--no-color', operatorIdentifiers, '--', '.',
    ':!*.test.mjs', ':!*-test-helpers.mjs', ':!config.example.json', ':!.coherence/',
  ], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.ifError(identifierSearch.error)
  assert.ok([0, 1].includes(identifierSearch.status), identifierSearch.stderr)
  const matchedExemptions = new Set()
  const problems = []
  for (const hit of identifierSearch.stdout.trimEnd().split('\n').filter(Boolean)) {
    const [, file, , lineText] = /^([^:]+):(\d+):(.*)$/.exec(hit) ?? []
    const { matchingExemptions, hasUnexemptedIdentifier } = checkLineAgainstExemptions(file, lineText)
    if (hasUnexemptedIdentifier) problems.push(hit)
    for (const exemption of matchingExemptions) matchedExemptions.add(exemption)
  }
  for (const exemption of exemptions) {
    if (matchedExemptions.has(exemption)) continue
    problems.push(`Stale exemption: ${exemption.file}: ${exemption.text} (${exemption.reason})`)
  }
  assert.equal(problems.length, 0, problems.join('\n'))
})
