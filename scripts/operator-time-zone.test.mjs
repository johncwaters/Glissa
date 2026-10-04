import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { setTestEnvironment, withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { getLocalDateAndMinutes, resolveOperatorTimeZone, runOperatorTimeZone } from './operator-time-zone.mjs'

const homeTimeZone = 'America/Chicago'

async function withProfileDirectory(testFunction, environmentOverrides = { ASSISTANT_HOME_TIME_ZONE: homeTimeZone }) {
  const restoreEnvironment = setTestEnvironment(environmentOverrides)
  try {
    await withTemporaryDirectory('assistant-time-zone-', testFunction)
  } finally {
    restoreEnvironment()
  }
}

test('the configured home zone is the default when the profile directory is missing or empty', async () => {
  await withProfileDirectory(async (profileDirectory) => {
    const now = new Date('2027-09-28T13:10:00.000Z')
    assert.equal(resolveOperatorTimeZone({ profileDirectory, now }), homeTimeZone)
    assert.equal(resolveOperatorTimeZone({ profileDirectory: join(profileDirectory, 'missing'), now }), homeTimeZone)
  })
})

test('UTC is the default when no home zone is configured', async () => {
  await withProfileDirectory(async (profileDirectory) => {
    assert.equal(resolveOperatorTimeZone({ profileDirectory, now: new Date('2027-09-28T13:10:00.000Z') }), 'UTC')
  }, { ASSISTANT_HOME_TIME_ZONE: undefined })
})

test('UTC is the default when the configured home zone is invalid, with a warning naming the bad value', async (testContext) => {
  const standardErrorWrites = []
  testContext.mock.method(process.stderr, 'write', (writtenText) => {
    standardErrorWrites.push(String(writtenText))
    return true
  })
  await withProfileDirectory(async (profileDirectory) => {
    assert.equal(resolveOperatorTimeZone({ profileDirectory, now: new Date('2027-09-28T13:10:00.000Z') }), 'UTC')
  }, { ASSISTANT_HOME_TIME_ZONE: 'Mars/Olympus' })
  testContext.mock.restoreAll()
  assert.deepEqual(standardErrorWrites, ['operator-time-zone: ASSISTANT_HOME_TIME_ZONE "Mars/Olympus" is not a valid IANA zone; using UTC\n'])
})

test('a valid configured home zone writes no warning', async (testContext) => {
  const standardErrorWrites = []
  testContext.mock.method(process.stderr, 'write', (writtenText) => {
    standardErrorWrites.push(String(writtenText))
    return true
  })
  await withProfileDirectory(async (profileDirectory) => {
    resolveOperatorTimeZone({ profileDirectory, now: new Date('2027-09-28T13:10:00.000Z') })
  })
  testContext.mock.restoreAll()
  assert.deepEqual(standardErrorWrites, [])
})

test('the latest in-effect from-date wins across profile files', async () => {
  await withProfileDirectory(async (profileDirectory) => {
    await writeFile(join(profileDirectory, 'travel.md'), '- Time zone from 2027-09-20: Europe/Lisbon (stated 2027-09-19, until 2027-10-01)\n')
    await writeFile(join(profileDirectory, 'location.md'), '- Time zone from 2027-09-28: Europe/Berlin (stated 2027-09-27, until 2027-09-30)\n')
    const now = new Date('2027-09-28T13:31:00.000Z')
    assert.equal(resolveOperatorTimeZone({ profileDirectory, now }), 'Europe/Berlin')
    const outputLines = []
    assert.equal(runOperatorTimeZone([], { profileDirectory, now, writeOutput: (line) => outputLines.push(line) }), 0)
    assert.deepEqual(outputLines, ['Europe/Berlin Tue Sept 28 3:31pm'])
  })
})

test('future, expired, invalid-date, and invalid-zone lines are ignored', async () => {
  await withProfileDirectory(async (profileDirectory) => {
    await writeFile(join(profileDirectory, 'travel.md'), [
      '- Time zone from 2027-09-01: Europe/Berlin (stated 2027-09-01, until 2027-09-27)',
      '- Time zone from 2027-09-29: Asia/Tokyo (stated 2027-09-28)',
      '- Time zone from 2027-02-30: Europe/Lisbon (stated 2027-02-01)',
      '- Time zone from 2027-09-28: Mars/Olympus (stated 2027-09-28)',
    ].join('\n'))
    const now = new Date('2027-09-28T13:10:00.000Z')
    assert.equal(resolveOperatorTimeZone({ profileDirectory, now }), homeTimeZone)
    assert.deepEqual(getLocalDateAndMinutes(now, homeTimeZone), { calendarDate: '2027-09-28', minutesAfterMidnight: 8 * 60 + 10 })
  })
})

test('a forwarded time zone line never overrides a stated one', async () => {
  await withProfileDirectory(async (profileDirectory) => {
    await writeFile(join(profileDirectory, 'travel.md'), [
      '- Time zone from 2027-09-20: Europe/Berlin (stated 2027-09-19)',
      '- Time zone from 2027-09-27: Asia/Tokyo (forwarded 2027-09-26)',
    ].join('\n'))
    assert.equal(resolveOperatorTimeZone({ profileDirectory, now: new Date('2027-09-28T13:10:00.000Z') }), 'Europe/Berlin')
  })
})

test('a from-date takes effect on that date in the zone in effect before it', async () => {
  await withProfileDirectory(async (profileDirectory) => {
    await writeFile(join(profileDirectory, 'travel.md'), '- Time zone from 2027-09-28: Europe/Berlin (stated 2027-09-27)\n')
    assert.equal(resolveOperatorTimeZone({ profileDirectory, now: new Date('2027-09-28T02:10:00.000Z') }), homeTimeZone)
    assert.equal(resolveOperatorTimeZone({ profileDirectory, now: new Date('2027-09-28T06:10:00.000Z') }), 'Europe/Berlin')
  })
})

test('an until-date ends on that date in the line zone', async () => {
  await withProfileDirectory(async (profileDirectory) => {
    await writeFile(join(profileDirectory, 'travel.md'), '- Time zone from 2027-09-20: Europe/Berlin (stated 2027-09-19, until 2027-09-27)\n')
    assert.equal(resolveOperatorTimeZone({ profileDirectory, now: new Date('2027-09-27T21:30:00.000Z') }), 'Europe/Berlin')
    assert.equal(resolveOperatorTimeZone({ profileDirectory, now: new Date('2027-09-27T22:30:00.000Z') }), homeTimeZone)
  })
})
