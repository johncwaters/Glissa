import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { addUsageExitCode, nothingToDoExitCode } from './command-line.mjs'
import { withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { auditMemory, runMemoryAuditCommand } from './memory-audit.mjs'

const today = '2027-07-03'

function profileFile(fields) {
  return `---\nname: travel\ndescription: Travel facts\nupdated: 2027-06-09\n---\n\n## Trips\n${fields}\n`
}

function digestFile(body) {
  return `---\ntitle: Lodging\nsource: telegram-forward\nreceived: 2027-06-18\nuntil: 2027-07-16\n---\n${body}\n`
}

async function withMemoryDirectory({ topFiles = {}, profileFiles = {}, contextFiles = {} }, testFunction) {
  return withTemporaryDirectory('assistant-memory-audit-', async (memoryDirectory) => {
    await mkdir(join(memoryDirectory, 'profile'))
    await mkdir(join(memoryDirectory, 'context'))
    for (const [fileName, fileText] of Object.entries(topFiles)) await writeFile(join(memoryDirectory, fileName), fileText)
    for (const [fileName, fileText] of Object.entries(profileFiles)) await writeFile(join(memoryDirectory, 'profile', fileName), fileText)
    for (const [fileName, fileText] of Object.entries(contextFiles)) await writeFile(join(memoryDirectory, 'context', fileName), fileText)
    await testFunction(memoryDirectory)
  })
}

test('reports nothing for clean memory', async () => {
  await withMemoryDirectory({ profileFiles: { 'travel.md': profileFile('- Airline: Example Air (stated 2027-06-12)') } }, async (memoryDirectory) => {
    assert.deepEqual(await auditMemory({ memoryDirectory, today }), [])
  })
})

test('flags a file that holds no facts', async () => {
  await withMemoryDirectory({ topFiles: { 'travel-preferences.md': '---\nname: travel-preferences\ndescription: Prefs\nupdated: 2027-06-09\n---\n\n# Placeholder\n' } }, async (memoryDirectory) => {
    const findings = await auditMemory({ memoryDirectory, today })
    assert.deepEqual(findings.map(({ kind, where }) => ({ kind, where })), [{ kind: 'stub-file', where: 'travel-preferences.md' }])
  })
})

test('flags a context digest that says it was superseded', async () => {
  await withMemoryDirectory({ contextFiles: { 'lodging.md': digestFile('Plan A.\n\nSuperseded the same day: plan B.') } }, async (memoryDirectory) => {
    const findings = await auditMemory({ memoryDirectory, today })
    assert.deepEqual(findings.map(({ kind, where }) => ({ kind, where })), [{ kind: 'superseded-digest', where: 'context/lodging.md' }])
  })
})

test('flags an open-state fact only once it is a week old', async () => {
  const fields = '- Flights: not yet booked (stated 2027-06-09)\n- Hotel: pending (stated 2027-06-30)'
  await withMemoryDirectory({ profileFiles: { 'travel.md': profileFile(fields) } }, async (memoryDirectory) => {
    const findings = await auditMemory({ memoryDirectory, today })
    assert.deepEqual(findings.map(({ kind, where }) => ({ kind, where })), [{ kind: 'open-state-recheck', where: 'profile/travel.md:8' }])
  })
})

test('flags a fact whose until date is within three days and skips later ones', async () => {
  const fields = '- Zone: Oslo (stated 2027-06-28, until 2027-07-04)\n- Trip: Lisbon (stated 2027-06-09, until 2027-07-09)'
  await withMemoryDirectory({ profileFiles: { 'travel.md': profileFile(fields) } }, async (memoryDirectory) => {
    const findings = await auditMemory({ memoryDirectory, today })
    assert.deepEqual(findings.map(({ kind, where }) => ({ kind, where })), [{ kind: 'expiring-soon', where: 'profile/travel.md:8' }])
  })
})

test('command exits 5 on clean memory and 0 with findings printed', async () => {
  await withMemoryDirectory({ contextFiles: { 'lodging.md': digestFile('Superseded.') } }, async (memoryDirectory) => {
    const printedLines = []
    const dirtyExitCode = await runMemoryAuditCommand(['--dir', memoryDirectory, '--today', today], { writeOutput: (line) => printedLines.push(line) })
    assert.equal(dirtyExitCode, 0)
    assert.match(printedLines[0], /^superseded-digest context\/lodging\.md /)
  })
  await withMemoryDirectory({}, async (memoryDirectory) => {
    assert.equal(await runMemoryAuditCommand(['--dir', memoryDirectory, '--today', today], { writeOutput: () => {} }), nothingToDoExitCode)
  })
})

test('command rejects unknown options and invalid dates', async () => {
  const errors = []
  assert.equal(await runMemoryAuditCommand(['--bogus', 'x'], { writeError: (line) => errors.push(line) }), addUsageExitCode)
  assert.equal(await runMemoryAuditCommand(['--today', '2026-02-30'], { writeError: (line) => errors.push(line) }), addUsageExitCode)
  assert.match(errors.join('\n'), /Invalid date: 2026-02-30/)
})
