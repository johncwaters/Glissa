import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { addUsageExitCode, nothingToDoExitCode } from './command-line.mjs'
import { withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { readFrontmatter } from './frontmatter.mjs'
import { captureTestCommand } from './process-test-helpers.mjs'
import { contextByteCap, contextLowWaterByteMark, expireProfileText, expireProfiles, findProfileGrammarViolations, pickBlank, runProfileCommand, trailingProvenanceStampPattern } from './profile.mjs'

const scriptPath = new URL('./profile.mjs', import.meta.url)

function profileFile({ updated = '2026-09-10', fields = '- Employer: Example Labs (stated 2026-09-09)' } = {}) {
  return `---\nname: work\ndescription: Work facts\nupdated: ${updated}\n---\n\n## Details\n${fields}\n`
}

function contextFile({ title = 'Example Labs plan', received = '2026-09-14', until = '2026-12-13', body = 'A digest of the forwarded plan.' } = {}) {
  return `---\ntitle: ${title}\nsource: telegram-forward\nreceived: ${received}\nuntil: ${until}\n---\n${body}\n`
}

async function withTemporaryProfileDirectory(testFunction) {
  return withTemporaryDirectory('glissa-profile-', async (temporaryDirectory) => {
    const profileDirectory = join(temporaryDirectory, 'profile')
    await mkdir(profileDirectory)
    await testFunction(profileDirectory)
  })
}

async function writeProfile(profileDirectory, fileName, fileText) {
  await writeFile(join(profileDirectory, fileName), fileText)
}

async function runProfileCliProcess(...commandArguments) {
  return captureTestCommand(process.execPath, [scriptPath.pathname, ...commandArguments])
}

test('parses a clean profile with no grammar violations', () => {
  assert.deepEqual(findProfileGrammarViolations(profileFile()), [])
})

test('accepts every profile field value form', () => {
  const fields = [
    '- Employer: Example Labs (stated 2026-09-09)',
    '- Office: Riverton (forwarded 2026-09-10)',
    '- Project: migration (forwarded 2026-09-10, until 2026-12-01)',
    '- Manager: ?',
    '- Pets: ? (asked 2026-09-10)',
    '- Second vehicle: n/a (stated 2026-09-10)',
  ].join('\n')
  assert.deepEqual(findProfileGrammarViolations(profileFile({ fields })), [])
})

test('accepts an until suffix and rejects an invalid until date', () => {
  assert.deepEqual(findProfileGrammarViolations(profileFile({ fields: '- Employer: Example Labs (stated 2026-09-09, until 2026-10-09)' })), [])
  const violations = findProfileGrammarViolations(profileFile({ fields: '- Employer: Example Labs (stated 2026-09-09, until 2026-02-30)' }))
  assert.deepEqual(violations, [{ line: 8, reason: 'Invalid date: 2026-02-30' }])
})

test('rejects an until date before the stated date', () => {
  const violations = findProfileGrammarViolations(profileFile({ fields: '- Employer: Example Labs (stated 2026-09-09, until 2026-09-08)' }))
  assert.deepEqual(violations, [{ line: 8, reason: 'Until date is earlier than stated date: 2026-09-08' }])
})

test('rejects facts without stamps and unknown trailing parentheticals', () => {
  assert.equal(findProfileGrammarViolations(profileFile({ fields: '- Employer: Example Labs' }))[0].line, 8)
  assert.equal(findProfileGrammarViolations(profileFile({ fields: '- Manager: ? (later)' }))[0].line, 8)
})

test('rejects duplicate field names', () => {
  const violations = findProfileGrammarViolations(profileFile({ fields: '- Employer: Example Labs (stated 2026-09-09)\n- Employer: Acme (stated 2026-09-10)' }))
  assert.match(violations[0].reason, /Duplicate field name/)
})

test('rejects a field name padded with whitespace', () => {
  const violations = findProfileGrammarViolations(profileFile({ fields: '- Employer : Example Labs (stated 2026-09-09)' }))
  assert.deepEqual(violations, [{ line: 8, reason: 'Field name must not carry leading or trailing whitespace: Employer ' }])
})

test('rejects a missing frontmatter key and stale updated date', () => {
  assert.match(findProfileGrammarViolations(profileFile().replace('description: Work facts\n', ''))[0].reason, /Missing frontmatter key: description/)
  assert.match(findProfileGrammarViolations(profileFile({ updated: '2026-09-08' }))[0].reason, /Updated date is earlier/)
})

test('rejects paragraphs and invalid calendar dates', () => {
  assert.match(findProfileGrammarViolations(profileFile({ fields: 'A paragraph' }))[0].reason, /Body lines/)
  assert.match(findProfileGrammarViolations(profileFile({ fields: '- Employer: Example Labs (stated 2026-02-30)' }))[0].reason, /Invalid date/)
})

test('rejects a file whose frontmatter block does not start it', () => {
  assert.deepEqual(findProfileGrammarViolations(`stray line\n${profileFile()}`), [{ line: 1, reason: 'Missing frontmatter block' }])
  assert.deepEqual(findProfileGrammarViolations(`\n${profileFile()}`), [{ line: 1, reason: 'Missing frontmatter block' }])
})

test('reports the true file line of a violation', () => {
  const fileText = profileFile({ fields: '- Employer: Example Labs (stated 2026-09-09)\n\n## More\nA paragraph' })
  assert.equal(findProfileGrammarViolations(fileText)[0].line, fileText.split('\n').indexOf('A paragraph') + 1)
})

test('reports the true file line of a picked blank', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    const fileText = profileFile({ fields: '- Employer: Example Labs (stated 2026-09-09)\n\n## More\n- Manager: ?' })
    await writeProfile(profileDirectory, 'work.md', fileText)
    const selection = await pickBlank({ profileDirectory, today: '2026-09-10', notAskedWithinDays: 14 })
    assert.equal(selection.blank.line, fileText.split('\n').indexOf('- Manager: ?') + 1)
  })
})

test('reads every frontmatter key', () => {
  const frontmatter = readFrontmatter(profileFile().replace('updated: 2026-09-10', 'updated: 2026-09-10\nsource: operator'))
  assert.equal(frontmatter.fields.source, 'operator')
  assert.match(frontmatter.bodyText, /## Details/)
})

test('pickBlank prefers never-asked blanks over expired asked blanks', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile({ fields: '- Manager: ? (asked 2026-08-01)' }))
    await writeProfile(profileDirectory, 'home.md', profileFile({ fields: '- Pets: ?' }))
    const selection = await pickBlank({ profileDirectory, today: '2026-09-10', notAskedWithinDays: 14 })
    assert.equal(selection.blank.field, 'Pets')
  })
})

test('pickBlank skips recent questions and returns null when all blanks are recent', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile({ fields: '- Manager: ? (asked 2026-09-01)' }))
    const selection = await pickBlank({ profileDirectory, today: '2026-09-10', notAskedWithinDays: 14 })
    assert.equal(selection.blank, null)
  })
})

test('pickBlank restricts selection to the requested domain', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile({ fields: '- Manager: ?' }))
    await writeProfile(profileDirectory, 'home.md', profileFile({ fields: '- Pets: ?' }))
    const selection = await pickBlank({ profileDirectory, domain: 'work', today: '2026-09-10', notAskedWithinDays: 14 })
    assert.equal(selection.blank.field, 'Manager')
  })
})

test('pickBlank ordering is deterministic across runs', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'zeta.md', profileFile({ fields: '- Zed: ?\n- Later: ?' }))
    await writeProfile(profileDirectory, 'alpha.md', profileFile({ fields: '- First: ?' }))
    const firstSelection = await pickBlank({ profileDirectory, today: '2026-09-10', notAskedWithinDays: 14 })
    const secondSelection = await pickBlank({ profileDirectory, today: '2026-09-10', notAskedWithinDays: 14 })
    assert.deepEqual(firstSelection, secondSelection)
    assert.match(firstSelection.blank.file, /alpha\.md$/)
  })
})

test('pickBlank skips malformed profiles and records their paths', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'broken.md', profileFile({ fields: '- Bad: missing stamp' }))
    await writeProfile(profileDirectory, 'work.md', profileFile({ fields: '- Manager: ?' }))
    const selection = await pickBlank({ profileDirectory, today: '2026-09-10', notAskedWithinDays: 14 })
    assert.equal(selection.blank.field, 'Manager')
    assert.deepEqual(selection.skipped, [join(profileDirectory, 'broken.md')])
  })
})

test('expire moves past-until fields into the archive', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile({ fields: '- Employer: Example Labs (stated 2026-09-09, until 2026-10-09)' }))
    const expiration = await expireProfiles({ profileDirectory, today: '2026-12-01' })
    assert.deepEqual(expiration.archivedLinesByDomain, { work: 1 })
    const profileText = await readFile(join(profileDirectory, 'work.md'), 'utf8')
    const archiveText = await readFile(join(profileDirectory, '..', 'archive', 'work.md'), 'utf8')
    assert.equal(profileText, '---\nname: work\ndescription: Work facts\nupdated: 2026-12-01\n---\n')
    assert.equal(archiveText, '---\nname: work\ndescription: Expired facts moved out of the work profile.\nupdated: 2026-12-01\n---\n\n## archived 2026-12-01\n- Employer: Example Labs (stated 2026-09-09, until 2026-10-09)\n\n')
  })
})

test('expire leaves fields with no until or a future until alone', () => {
  const fileText = profileFile({ fields: '- Employer: Example Labs (stated 2026-09-09)\n- Office: Riverton (stated 2026-09-09, until 2026-12-01)' })
  const expiration = expireProfileText(fileText, '2026-12-01')
  assert.deepEqual(expiration.archivedLines, [])
  assert.equal(expiration.text, fileText)
})

test('expire moves a forwarded field with a past until into the archive', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    const forwardedField = '- Office: Riverton (forwarded 2026-09-09, until 2026-10-09)'
    await writeProfile(profileDirectory, 'work.md', profileFile({ fields: forwardedField }))
    const expiration = await expireProfiles({ profileDirectory, today: '2026-12-01' })
    assert.deepEqual(expiration.archivedLinesByDomain, { work: 1 })
    assert.doesNotMatch(await readFile(join(profileDirectory, 'work.md'), 'utf8'), /Office/)
    assert.match(await readFile(join(profileDirectory, '..', 'archive', 'work.md'), 'utf8'), /\(forwarded 2026-09-09, until 2026-10-09\)/)
  })
})

test('expire moves expired context, leaves future context, and reports malformed context without failing', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile())
    const contextDirectory = join(profileDirectory, '..', 'context')
    await mkdir(contextDirectory)
    const expiredContextText = contextFile({ title: 'Expired', until: '2026-10-01' })
    const futureContextText = contextFile({ title: 'Future', until: '2027-01-01' })
    await writeFile(join(contextDirectory, 'expired.md'), expiredContextText)
    await writeFile(join(contextDirectory, 'future.md'), futureContextText)
    await writeFile(join(contextDirectory, 'malformed.md'), 'missing frontmatter\n')
    const outputLines = []
    const errorLines = []

    const exitCode = await runProfileCommand(['expire', '--today', '2026-12-01', '--dir', profileDirectory], {
      writeOutput: (line) => outputLines.push(line),
      writeError: (line) => errorLines.push(line),
    })

    assert.equal(exitCode, 0)
    await assert.rejects(readFile(join(contextDirectory, 'expired.md'), 'utf8'), { code: 'ENOENT' })
    assert.equal(await readFile(join(profileDirectory, '..', 'archive', 'context', 'expired.md'), 'utf8'), expiredContextText)
    assert.equal(await readFile(join(contextDirectory, 'future.md'), 'utf8'), futureContextText)
    assert.equal(await readFile(join(contextDirectory, 'malformed.md'), 'utf8'), 'missing frontmatter\n')
    assert.deepEqual(outputLines, ['context/expired.md: archived'])
    assert.match(errorLines[0], /^context\/malformed\.md: Missing frontmatter block$/)
  })
})

test('expire reports a malformed context digest without a failing exit code', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile())
    const contextDirectory = join(profileDirectory, '..', 'context')
    await mkdir(contextDirectory)
    await writeFile(join(contextDirectory, 'malformed.md'), 'missing frontmatter\n')
    const errorLines = []

    const exitCode = await runProfileCommand(['expire', '--today', '2026-12-01', '--dir', profileDirectory], {
      writeOutput: () => {},
      writeError: (line) => errorLines.push(line),
    })

    assert.equal(exitCode, nothingToDoExitCode)
    assert.match(errorLines[0], /^context\/malformed\.md: Missing frontmatter block$/)
  })
})

test('expire evicts the oldest received context first down to the low-water mark', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile())
    const contextDirectory = join(profileDirectory, '..', 'context')
    await mkdir(contextDirectory)
    const paddedBody = 'x'.repeat(1400)
    const recentFileNames = ['a1.md', 'a2.md', 'a3.md', 'a4.md', 'a5.md', 'a6.md', 'a7.md', 'a8.md']
    for (const recentFileName of recentFileNames) {
      await writeFile(join(contextDirectory, recentFileName), contextFile({ title: 'Plan', received: '2026-06-01', until: '2027-01-01', body: paddedBody }))
    }
    for (const oldestFileName of ['z1.md', 'z2.md']) {
      await writeFile(join(contextDirectory, oldestFileName), contextFile({ title: 'Plan', received: '2026-01-01', until: '2027-01-01', body: paddedBody }))
    }

    const expiration = await expireProfiles({ profileDirectory, today: '2026-12-01' })

    assert.deepEqual(expiration.archivedContextFiles, ['z1.md', 'z2.md', 'a1.md', 'a2.md'])
    assert.deepEqual(expiration.failureMessagesByContextFile, {})
    assert.deepEqual((await readdir(contextDirectory)).sort(), ['a3.md', 'a4.md', 'a5.md', 'a6.md', 'a7.md', 'a8.md'])
    assert.deepEqual((await readdir(join(profileDirectory, '..', 'archive', 'context'))).sort(), ['a1.md', 'a2.md', 'z1.md', 'z2.md'])
  })
})

test('expire evicts nothing when context sits between the low-water mark and the cap', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile())
    const contextDirectory = join(profileDirectory, '..', 'context')
    await mkdir(contextDirectory)
    const retainedFileNames = ['a1.md', 'a2.md', 'a3.md', 'a4.md', 'a5.md', 'a6.md', 'a7.md', 'a8.md']
    for (const retainedFileName of retainedFileNames) {
      await writeFile(join(contextDirectory, retainedFileName), contextFile({ title: 'Plan', received: '2026-06-01', until: '2027-01-01', body: 'x'.repeat(1400) }))
    }

    const expiration = await expireProfiles({ profileDirectory, today: '2026-12-01' })

    assert.ok(contextLowWaterByteMark < 8 * 1485 && 8 * 1485 <= contextByteCap)
    assert.deepEqual(expiration.archivedContextFiles, [])
    assert.deepEqual((await readdir(contextDirectory)).sort(), retainedFileNames)
  })
})

test('expire keeps every valid digest when a malformed digest is oversized', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile())
    const contextDirectory = join(profileDirectory, '..', 'context')
    await mkdir(contextDirectory)
    const validFileNames = ['a1.md', 'a2.md', 'a3.md']
    for (const validFileName of validFileNames) {
      await writeFile(join(contextDirectory, validFileName), contextFile({ received: '2026-06-01', until: '2027-01-01', body: 'x'.repeat(1400) }))
    }
    await writeFile(join(contextDirectory, 'malformed.md'), 'x'.repeat(20000))

    const expiration = await expireProfiles({ profileDirectory, today: '2026-12-01' })

    assert.deepEqual(expiration.archivedContextFiles, [])
    assert.deepEqual(Object.keys(expiration.failureMessagesByContextFile), ['malformed.md'])
    assert.deepEqual((await readdir(contextDirectory)).sort(), ['a1.md', 'a2.md', 'a3.md', 'malformed.md'])
  })
})

test('expire archives a context digest under a suffixed name when the archived name is taken', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile())
    const contextDirectory = join(profileDirectory, '..', 'context')
    const archiveContextDirectory = join(profileDirectory, '..', 'archive', 'context')
    await mkdir(contextDirectory)
    await mkdir(archiveContextDirectory, { recursive: true })
    const earlierArchivedText = contextFile({ title: 'Earlier', until: '2026-09-01' })
    const expiringText = contextFile({ title: 'Later', until: '2026-10-01' })
    await writeFile(join(archiveContextDirectory, 'expired.md'), earlierArchivedText)
    await writeFile(join(contextDirectory, 'expired.md'), expiringText)
    const outputLines = []

    const exitCode = await runProfileCommand(['expire', '--today', '2026-12-01', '--dir', profileDirectory], {
      writeOutput: (line) => outputLines.push(line),
      writeError: () => {},
    })

    assert.equal(exitCode, 0)
    assert.equal(await readFile(join(archiveContextDirectory, 'expired.md'), 'utf8'), earlierArchivedText)
    assert.equal(await readFile(join(archiveContextDirectory, 'expired-2.md'), 'utf8'), expiringText)
    assert.deepEqual(outputLines, ['context/expired-2.md: archived'])
  })
})

test('expire appends to an existing archive file and bumps its updated date', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile({ fields: '- Employer: Example Labs (stated 2026-09-09, until 2026-10-09)' }))
    const archiveDirectory = join(profileDirectory, '..', 'archive')
    await mkdir(archiveDirectory)
    await writeFile(join(archiveDirectory, 'work.md'), '---\nname: work\ndescription: Expired facts moved out of the work profile.\nupdated: 2026-10-10\n---\n\n## archived 2026-10-10\n- Office: Riverton (stated 2026-09-09, until 2026-10-09)\n\n')
    await expireProfiles({ profileDirectory, today: '2026-12-01' })
    const archiveText = await readFile(join(archiveDirectory, 'work.md'), 'utf8')
    assert.match(archiveText, /updated: 2026-12-01/)
    assert.match(archiveText, /## archived 2026-10-10/)
    assert.match(archiveText, /## archived 2026-12-01/)
  })
})

test('expire leaves the profile file unchanged when the archive write fails', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    const profileText = profileFile({ fields: '- Employer: Example Labs (stated 2026-09-09, until 2026-10-09)' })
    await writeProfile(profileDirectory, 'work.md', profileText)
    await writeFile(join(profileDirectory, '..', 'archive'), 'not a directory')
    const expiration = await expireProfiles({ profileDirectory, today: '2026-12-01' })
    assert.deepEqual(expiration.archivedLinesByDomain, {})
    assert.deepEqual(Object.keys(expiration.failureMessagesByDomain), ['work'])
    assert.equal(await readFile(join(profileDirectory, 'work.md'), 'utf8'), profileText)
  })
})

test('expire appends to an archive file that has no frontmatter block', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile({ fields: '- Employer: Example Labs (stated 2026-09-09, until 2026-10-09)' }))
    const archiveDirectory = join(profileDirectory, '..', 'archive')
    await mkdir(archiveDirectory)
    await writeFile(join(archiveDirectory, 'work.md'), '## archived 2026-10-10\n- Office: Riverton (stated 2026-09-09, until 2026-10-09)\n')
    const expiration = await expireProfiles({ profileDirectory, today: '2026-12-01' })
    assert.deepEqual(expiration.archivedLinesByDomain, { work: 1 })
    const archiveText = await readFile(join(archiveDirectory, 'work.md'), 'utf8')
    assert.equal(archiveText, '## archived 2026-10-10\n- Office: Riverton (stated 2026-09-09, until 2026-10-09)\n\n## archived 2026-12-01\n- Employer: Example Labs (stated 2026-09-09, until 2026-10-09)\n\n')
  })
})

test('expire archives the next domain after one domain fails', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    const expiringField = '- Employer: Example Labs (stated 2026-09-09, until 2026-10-09)'
    await writeProfile(profileDirectory, 'work.md', profileFile({ fields: expiringField }))
    await writeProfile(profileDirectory, 'travel.md', profileFile({ fields: expiringField }))
    await mkdir(join(profileDirectory, '..', 'archive', 'work.md'), { recursive: true })
    const expiration = await expireProfiles({ profileDirectory, today: '2026-12-01' })
    assert.deepEqual(expiration.archivedLinesByDomain, { travel: 1 })
    assert.deepEqual(Object.keys(expiration.failureMessagesByDomain), ['work'])
    assert.match(await readFile(join(profileDirectory, '..', 'archive', 'travel.md'), 'utf8'), /## archived 2026-12-01/)
  })
})

test('CLI expire exits non-zero on a failed domain while reporting the archived domain', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    const expiringField = '- Employer: Example Labs (stated 2026-09-09, until 2026-10-09)'
    await writeProfile(profileDirectory, 'work.md', profileFile({ fields: expiringField }))
    await writeProfile(profileDirectory, 'travel.md', profileFile({ fields: expiringField }))
    await mkdir(join(profileDirectory, '..', 'archive', 'work.md'), { recursive: true })
    const outputLines = []
    const errorLines = []
    const exitCode = await runProfileCommand(['expire', '--today', '2026-12-01', '--dir', profileDirectory], {
      writeOutput: (line) => outputLines.push(line),
      writeError: (line) => errorLines.push(line),
    })
    assert.equal(exitCode, 1)
    assert.deepEqual(outputLines, ['travel: 1 archived'])
    assert.match(errorLines[0], /^work: /)
  })
})

test('expire keeps a section that never held a field when another section expires', () => {
  const fileText = profileFile({ fields: '- Employer: Example Labs (stated 2026-09-09, until 2026-10-09)\n\n## Health\n\n## Equipment\n- Desk lamp: Example Model (stated 2026-09-09)' })
  const expiration = expireProfileText(fileText, '2026-12-01')
  assert.match(expiration.text, /## Health/)
  assert.match(expiration.text, /## Equipment/)
  assert.doesNotMatch(expiration.text, /## Details/)
})

test('expire bumps updated only when a field moved', () => {
  const unexpiredText = profileFile({ fields: '- Employer: Example Labs (stated 2026-09-09)' })
  assert.equal(expireProfileText(unexpiredText, '2026-12-01').text, unexpiredText)
  const expiredText = profileFile({ fields: '- Employer: Example Labs (stated 2026-09-09, until 2026-10-09)' })
  assert.match(expireProfileText(expiredText, '2026-12-01').text, /updated: 2026-12-01/)
})

test('CLI exits with no-due-tasks when no blank qualifies', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile())
    const commandResult = await runProfileCliProcess('blanks', '--pick', '--dir', profileDirectory)
    assert.equal(commandResult.exitCode, nothingToDoExitCode)
  })
})

test('CLI expire reports nothing to do when nothing expired', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile())
    const commandResult = await runProfileCliProcess('expire', '--today', '2026-12-01', '--dir', profileDirectory)
    assert.equal(commandResult.exitCode, nothingToDoExitCode)
    assert.match(commandResult.stdout, /nothing to do/)
  })
})

test('CLI expire creates the context directory when nothing expires', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile())
    const contextDirectory = join(profileDirectory, '..', 'context')
    const commandResult = await runProfileCliProcess('expire', '--today', '2026-12-01', '--dir', profileDirectory)
    assert.equal(commandResult.exitCode, nothingToDoExitCode)
    assert.deepEqual(await readdir(contextDirectory), [])
  })
})

test('CLI prints the selected blank as JSON for a temporary profile directory', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'work.md', profileFile({ fields: '- Manager: ?' }))
    const commandResult = await runProfileCliProcess('blanks', '--pick', '--domain', 'work', '--dir', profileDirectory)
    assert.equal(commandResult.exitCode, 0)
    assert.deepEqual(JSON.parse(commandResult.stdout), {
      file: join(profileDirectory, 'work.md'), line: 8, field: 'Manager', askedOn: null,
    })
  })
})

test('CLI reports a skipped malformed profile while printing the blank it did find', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'broken.md', profileFile({ fields: '- Bad: missing stamp' }))
    await writeProfile(profileDirectory, 'work.md', profileFile({ fields: '- Manager: ?' }))
    const commandResult = await runProfileCliProcess('blanks', '--pick', '--dir', profileDirectory)
    assert.equal(commandResult.exitCode, 0)
    assert.equal(commandResult.stderr.trim(), join(profileDirectory, 'broken.md'))
    assert.equal(JSON.parse(commandResult.stdout).field, 'Manager')
  })
})

test('CLI reports a skipped malformed profile when no blank qualifies', async () => {
  await withTemporaryProfileDirectory(async (profileDirectory) => {
    await writeProfile(profileDirectory, 'broken.md', profileFile({ fields: '- Bad: missing stamp' }))
    const commandResult = await runProfileCliProcess('blanks', '--pick', '--dir', profileDirectory)
    assert.equal(commandResult.exitCode, nothingToDoExitCode)
    assert.equal(commandResult.stderr.trim(), join(profileDirectory, 'broken.md'))
  })
})

test('reads the provenance word only from a stamp that ends the line', () => {
  const statedLines = [
    "- Robin (household@example.com): a household contact (stated 2026-09-11).",
    '- Rhea Voss: rhea@example.com (stated 2026-09-11, until 2026-12-01)'
  ]
  statedLines.forEach((statedLine) => {
    assert.equal(trailingProvenanceStampPattern.exec(statedLine)[1], 'stated', statedLine)
  })
  assert.equal(trailingProvenanceStampPattern.exec('- Mara Vogt: mara@example.com (forwarded 2026-09-16)')[1], 'forwarded')
  assert.equal(trailingProvenanceStampPattern.test('- Note: example (stated 2026-09-17) forwarded text: dana@example.com'), false)
  assert.equal(trailingProvenanceStampPattern.test('- Ivo Sand: ivo@example.com'), false)
})

test('CLI requires --pick', async () => {
  const outputLines = []
  const errorLines = []
  const exitCode = await runProfileCommand(['blanks'], {
    writeOutput: (line) => outputLines.push(line),
    writeError: (line) => errorLines.push(line),
  })
  assert.equal(exitCode, addUsageExitCode)
  assert.deepEqual(outputLines, [])
  assert.match(errorLines[0], /--pick/)
})
