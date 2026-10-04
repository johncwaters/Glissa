import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { addUsageExitCode } from './command-line.mjs'
import { captureTestCommand } from './process-test-helpers.mjs'
import { briefFile, operatorChosenBrief, quietDayBrief, withTemporaryFile } from './brief-test-helpers.mjs'
import { withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { briefViolationsExitCode, findBriefViolations, parseItemDateToken, runBriefCheck } from './brief-check.mjs'

const scriptPath = new URL('./brief-check.mjs', import.meta.url)

function firstReason(fileText) {
  return findBriefViolations(fileText)[0]?.reason
}

async function runBriefCliProcess(...commandArguments) {
  return captureTestCommand(process.execPath, [scriptPath.pathname, ...commandArguments])
}

test('accepts a brief with decisions and an ahead part', () => {
  assert.deepEqual(findBriefViolations(briefFile()), [])
})

test('rejects task ids containing digits as whole words and ignores all-letter ids', () => {
  const parts = ['Ahead:', 'Tue Sept 15 Complete i2r6, then review v34w; archive xi2r6x and task abcd.']
  const violations = findBriefViolations(briefFile({ parts }), { taskIds: ['i2r6', 'v34w', 'abcd'] })
  assert.deepEqual(violations.filter((violation) => violation.reason.startsWith('Task id')), [
    { line: 5, reason: 'Task id "i2r6" named in the brief; John cannot act on an id' },
    { line: 5, reason: 'Task id "v34w" named in the brief; John cannot act on an id' },
  ])
})

test('CLI reads task ids from the resolved ledger path', async () => {
  await withTemporaryDirectory('assistant-brief-task-ids-', async (temporaryDirectory) => {
    const taskFilePath = join(temporaryDirectory, 'tasks.json')
    const briefFilePath = join(temporaryDirectory, 'brief.md')
    await writeFile(taskFilePath, JSON.stringify({ tasks: [{ id: 'i2r6' }] }))
    await writeFile(briefFilePath, briefFile({ parts: ['Ahead:', 'Tue Sept 15 Complete i2r6.'] }))
    const commandRun = await captureTestCommand(process.execPath, [scriptPath.pathname, briefFilePath], {
      env: { ...process.env, ASSISTANT_TASKS_FILE: taskFilePath },
    })
    assert.equal(commandRun.exitCode, briefViolationsExitCode)
    assert.match(commandRun.stderr, /Task id "i2r6" named in the brief; John cannot act on an id/)
  })
})

test('rejects an ahead item repeated from the newest earlier morning brief', async () => {
  await withTemporaryDirectory('assistant-brief-', async (temporaryDirectory) => {
    await writeFile(join(temporaryDirectory, '2026-09-12.md'), briefFile({ date: '2026-09-12', parts: ['Ahead:', 'Tue Sept 15 Bring the library card.'] }))
    const checkedBriefPath = join(temporaryDirectory, '2026-09-13.md')
    await writeFile(checkedBriefPath, briefFile({ date: '2026-09-13', parts: ['Ahead:', 'Tue Sept 15 Bring the library card.'] }))
    const errorLines = []
    assert.equal(await runBriefCheck([checkedBriefPath], { writeError: (line) => errorLines.push(line) }), briefViolationsExitCode)
    assert.deepEqual(errorLines, ['5: Ahead item repeats 2026-09-12.md: Tue Sept 15 Bring the library card.'])
  })
})

test('rejects a repeated ahead item whose countdown decremented overnight', async () => {
  await withTemporaryDirectory('assistant-brief-', async (temporaryDirectory) => {
    await writeFile(join(temporaryDirectory, '2026-09-12.md'), briefFile({ date: '2026-09-12', parts: ['Ahead:', 'Tue Sept 15 (3d) Bring the library card.'] }))
    const checkedBriefPath = join(temporaryDirectory, '2026-09-13.md')
    await writeFile(checkedBriefPath, briefFile({ date: '2026-09-13', parts: ['Ahead:', 'Tue Sept 15 (2d) Bring the library card.'] }))
    const errorLines = []
    assert.equal(await runBriefCheck([checkedBriefPath], { writeError: (line) => errorLines.push(line) }), briefViolationsExitCode)
    assert.deepEqual(errorLines, ['5: Ahead item repeats 2026-09-12.md: Tue Sept 15 (2d) Bring the library card.'])
  })
})

test('allows a repeated ahead item dated the day after the morning brief', async () => {
  await withTemporaryDirectory('assistant-brief-', async (temporaryDirectory) => {
    await writeFile(join(temporaryDirectory, '2026-09-12.md'), briefFile({ date: '2026-09-12', parts: ['Ahead:', 'Mon Sept 14 Bring the library card.'] }))
    const checkedBriefPath = join(temporaryDirectory, '2026-09-13.md')
    await writeFile(checkedBriefPath, briefFile({ date: '2026-09-13', parts: ['Ahead:', 'Mon Sept 14 Bring the library card.'] }))
    assert.equal(await runBriefCheck([checkedBriefPath], { writeError: () => {} }), 0)
  })
})

test('allows a repeated ahead item dated the day after a morning brief across the year boundary', async () => {
  await withTemporaryDirectory('assistant-brief-', async (temporaryDirectory) => {
    await writeFile(join(temporaryDirectory, '2026-12-30.md'), briefFile({ date: '2026-12-30', parts: ['Ahead:', 'Fri Jan 1 Renew the library appointment.'] }))
    const checkedBriefPath = join(temporaryDirectory, '2026-12-31.md')
    await writeFile(checkedBriefPath, briefFile({ date: '2026-12-31', parts: ['Ahead:', 'Fri Jan 1 Renew the library appointment.'] }))
    assert.equal(await runBriefCheck([checkedBriefPath], { writeError: () => {} }), 0)
  })
})

test('allows an ahead item when no earlier morning brief exists in the seven-day window', async () => {
  await withTemporaryDirectory('assistant-brief-', async (temporaryDirectory) => {
    await writeFile(join(temporaryDirectory, '2026-09-01.md'), briefFile({ date: '2026-09-01', parts: ['Ahead:', 'Tue Sept 15 Bring the library card.'] }))
    const checkedBriefPath = join(temporaryDirectory, '2026-09-13.md')
    await writeFile(checkedBriefPath, briefFile({ date: '2026-09-13', parts: ['Ahead:', 'Tue Sept 15 Bring the library card.'] }))
    assert.equal(await runBriefCheck([checkedBriefPath], { writeError: () => {} }), 0)
  })
})

test('exempts evening briefs from repeated ahead item checks', async () => {
  await withTemporaryDirectory('assistant-brief-', async (temporaryDirectory) => {
    await writeFile(join(temporaryDirectory, '2026-09-12.md'), briefFile({ date: '2026-09-12', parts: ['Ahead:', 'Tue Sept 15 Bring the library card.'] }))
    const checkedBriefPath = join(temporaryDirectory, '2026-09-13-evening.md')
    await writeFile(checkedBriefPath, briefFile({ date: '2026-09-13', parts: ['Ahead:', 'Tue Sept 15 Bring the library card.'] }))
    assert.equal(await runBriefCheck([checkedBriefPath], { writeError: () => {} }), 0)
  })
})

test('rejects an item about picking seats on a spelled-out carrier', () => {
  const parts = ['Ahead:', 'Tue Sept 15 Pick seats on Example Air 202.']
  assert.match(firstReason(briefFile({ parts })), /Airline seat selection never earns a brief item/)
})

test('accepts an item where a seat count is the fact the decision turns on', () => {
  const parts = ['Decisions:', '[medium] Sun Sept 20 (8d) Book XY 101 now. Two seats left at $399.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('accepts an item naming an assigned seat', () => {
  const parts = ['Ahead:', 'Tue Sept 15 Save a seat for Lakeside.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('exempts a due task batch from the seat rule', () => {
  const parts = ['Decisions:', '[low] Wed Sept 16 (1d) Pick seats for XY 202, task t12.']
  assert.deepEqual(findBriefViolations(briefFile({ parts }), { filePath: 'briefs/2026-09-15-tasks.md' }), [])
})

test('rejects an item naming seat selection as a noun phrase', () => {
  const parts = ['Ahead:', 'Tue Sept 15 Seat selection for XY 202 opens.']
  assert.match(firstReason(briefFile({ parts })), /Airline seat selection never earns a brief item/)
})

test('rejects an item about picking seats written as a gerund', () => {
  const parts = ['Ahead:', 'Tue Sept 15 Picking seats for XY 202.']
  assert.match(firstReason(briefFile({ parts })), /Airline seat selection never earns a brief item/)
})

test('accepts a daily-brief item whose only seat wording sits inside a quoted span', () => {
  const parts = ['Ahead:', 'Tue Sept 15 Reply to Lakeside about the group outing: "pick the seats yourself."']
  assert.deepEqual(findBriefViolations(briefFile({ parts }), { filePath: 'briefs/2026-09-15.md' }), [])
})

test('accepts a decision where a seat count and an unrelated change share the item', () => {
  const parts = ['Decisions:', '[medium] Sun Sept 20 (3d) Book XY 101 tonight. Two seats left and the fare changes at midnight.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('accepts an ahead item where a seat count sits beside an unrelated verb', () => {
  const parts = ['Ahead:', 'Tue Sept 15 Sam changes workshops; two seats open in the class.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('accepts the shape the operator chose', () => {
  assert.deepEqual(findBriefViolations(operatorChosenBrief), [])
})

test('accepts the quiet-day one-liner as the whole brief', () => {
  assert.deepEqual(findBriefViolations(quietDayBrief), [])
})

test('accepts a today part between decisions and ahead', () => {
  const parts = [
    'Decisions:',
    '[medium] Sun Sept 20 (8d) Book an evening departure. The Oslo flight is unbooked and a Mon Sept 21 flight likely lands late.',
    'Today:',
    'Thu Sept 10 7pm choir: bring the printed music.',
    'Ahead:',
    'Tue Sept 15 8am Card appt, Lakeside: bring library card.',
  ]
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('rejects a part label carrying its item on the same line', () => {
  const parts = ['Decisions: Mon Sept 14 (2d) Drop oldshop.example.']
  assert.match(firstReason(briefFile({ parts })), /Part label must stand alone on its line/)
})

test('rejects a part label with no blank line after it', () => {
  const parts = ['Decisions:\nMon Sept 14 (2d) Drop oldshop.example.']
  assert.match(firstReason(briefFile({ parts })), /Part label must be followed by a blank line/)
})

test('rejects two items with no blank line between them', () => {
  const parts = [
    'Decisions:',
    '[high] Mon Sept 14 (2d) Drop oldshop.example.\n[medium] Sun Sept 20 Book the Oslo flight today.',
  ]
  assert.match(firstReason(briefFile({ parts })), /Item must not wrap onto a second line/)
})

test('rejects an item wrapped onto a second line', () => {
  const parts = ['Decisions:', '[high] Mon Sept 14 (2d) Drop oldshop.example.\nThe registrar lapsed July 19.']
  assert.match(firstReason(briefFile({ parts })), /Item must not wrap onto a second line/)
})

test('accepts a date token carrying both a time and a countdown', () => {
  const parts = ['Ahead:', 'Tue Sept 15 8am (3d) Bring the library card to the Card renewal.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('accepts a date token carrying a minute-precise time', () => {
  const parts = ['Ahead:', 'Tue Sept 15 2:30pm Leave for Lakeside.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('accepts an item with no date opening with Undated', () => {
  const parts = ['Decisions:', '[low] Undated Decide whether the client keeps the domain. The registrar lapsed July 19.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('rejects an item opening with prose instead of a date', () => {
  const parts = ['Decisions:', '[high] Drop oldshop.example by Mon Sept 14 (2d).']
  assert.match(firstReason(briefFile({ parts })), /Item must open with its date or "Undated"/)
})

test('rejects an item carrying nothing after its date token', () => {
  const parts = ['Ahead:', 'Tue Sept 15 8am']
  assert.match(firstReason(briefFile({ parts })), /Item must carry its action after the date token/)
})

test('rejects an item carrying nothing after its date token and countdown', () => {
  const parts = ['Decisions:', '[high] Mon Sept 14 (2d)']
  assert.match(firstReason(briefFile({ parts })), /Item must carry its action after the date token/)
})

test('parses the level, date token, countdown, and remaining text of an item', () => {
  assert.deepEqual(parseItemDateToken('[high] Mon Sept 14 (2d) Drop oldshop.example.'), {
    urgencyLevel: 'high',
    dateToken: 'Mon Sept 14',
    countdown: '2d',
    textAfterDateToken: 'Drop oldshop.example.',
  })
  assert.deepEqual(parseItemDateToken('Tue Sept 15 8am Card appt, Lakeside.'), {
    urgencyLevel: undefined,
    dateToken: 'Tue Sept 15 8am',
    countdown: undefined,
    textAfterDateToken: 'Card appt, Lakeside.',
  })
  assert.deepEqual(parseItemDateToken('Undated Decide whether the client keeps the domain.'), {
    urgencyLevel: undefined,
    dateToken: 'Undated',
    countdown: undefined,
    textAfterDateToken: 'Decide whether the client keeps the domain.',
  })
  assert.equal(parseItemDateToken('[high] Drop oldshop.example by Mon Sept 14.'), undefined)
})

test('rejects a date token whose day is not followed by the action', () => {
  const parts = ['Ahead:', 'Tue Sept 15, 8am, Card appt, Lakeside: bring library card.']
  assert.match(firstReason(briefFile({ parts })), /Item must open with its date or "Undated"/)
})

test('accepts every urgency level on a decisions item', () => {
  const parts = [
    'Decisions:',
    '[high] Mon Sept 14 (2d) Drop oldshop.example.',
    '[medium] Sun Sept 20 (8d) Book an evening departure.',
    '[low] Wed Sept 23 (11d) Move the library appointment.',
  ]
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('rejects a decisions item carrying no urgency level', () => {
  const parts = ['Decisions:', 'Mon Sept 14 (2d) Drop oldshop.example.']
  assert.match(firstReason(briefFile({ parts })), /Decisions item must open with \[high\], \[medium\], or \[low\]/)
})

test('rejects an unknown urgency level on a decisions item', () => {
  const parts = ['Decisions:', '[urgent] Mon Sept 14 (2d) Drop oldshop.example.']
  assert.match(firstReason(briefFile({ parts })), /Decisions item must open with \[high\], \[medium\], or \[low\]/)
})

test('rejects an urgency level on an ahead item', () => {
  const parts = ['Ahead:', '[high] Tue Sept 15 8am Card appt, Lakeside: bring library card.']
  assert.match(firstReason(briefFile({ parts })), /Only a Decisions item carries an urgency level/)
})

test('rejects an urgency level on a today item', () => {
  const parts = ['Today:', '[low] Thu Sept 10 7pm choir: bring the printed music.']
  assert.match(firstReason(briefFile({ parts })), /Only a Decisions item carries an urgency level/)
})

for (const bannedPhrase of ['carries weight', 'the one to watch', 'looms', 'has teeth', 'the one with weight', 'heavy day']) {
  test(`rejects the banned phrase ${bannedPhrase}`, () => {
    const parts = ['Ahead:', `Fri Sept 18 The Riverton trip ${bannedPhrase} against the Oslo start.`]
    assert.match(firstReason(briefFile({ parts })), new RegExp(`Banned phrase "${bannedPhrase}"`))
  })
}

for (const hedgingModal of ['could', 'might', 'may']) {
  test(`rejects the hedging modal ${hedgingModal}`, () => {
    const parts = ['Ahead:', `Mon Sept 21 The flight ${hedgingModal} land after the first day starts.`]
    assert.match(firstReason(briefFile({ parts })), new RegExp(`Banned phrase "${hedgingModal}"`))
  })
}

for (const negatedModal of ['could not be read', "couldn't be read", 'might not be read', 'may not be read']) {
  test(`accepts the negated modal ${negatedModal}`, () => {
    const parts = ['Ahead:', `Tue Sept 15 8am Card appt, Lakeside: Slack ${negatedModal}.`]
    assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
  })
}

test('accepts the month May before a day number', () => {
  const parts = ['Ahead:', 'Sun May 3 Renew the library card before it expires May 3.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('accepts a word that merely contains a banned phrase', () => {
  const parts = ['Ahead:', 'Tue Sept 15 Check the garden, which blooms Tue Sept 15.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('accepts a banned phrase inside quoted sender words', () => {
  const parts = ['Decisions:', '[high] Mon Sept 14 (2d) Answer Morgan. Morgan wrote “the week looms” about the lodging.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('accepts a closing offer inside quoted sender words', () => {
  const parts = ['Decisions:', '[high] Mon Sept 14 (2d) Answer Morgan. Morgan wrote "let me know by Friday" about the lodging.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('accepts a hedging modal inside quoted sender words', () => {
  const quotedParts = ['Decisions:', '[high] Mon Sept 14 (2d) Answer Morgan. Morgan wrote "we might reschedule" about the lodging.']
  assert.deepEqual(findBriefViolations(briefFile({ parts: quotedParts })), [])
  const unquotedParts = ['Decisions:', '[high] Mon Sept 14 (2d) Answer Morgan. Morgan wrote we might reschedule about the lodging.']
  assert.match(firstReason(briefFile({ parts: unquotedParts })), /Banned phrase "might"/)
})

test('rejects a banned phrase in any letter case', () => {
  const parts = ['Ahead:', 'Fri Sept 18 Looms over the week: the Riverton drive.']
  assert.match(firstReason(briefFile({ parts })), /Banned phrase "looms"/)
})

for (const closingOffer of ['say which', 'let me know', 'want me to', 'shall I']) {
  test(`rejects the closing offer ${closingOffer}`, () => {
    const parts = ['Ahead:', `Tue Sept 15 8am Card appt, Lakeside. Just ${closingOffer} before Monday.`]
    assert.match(firstReason(briefFile({ parts })), new RegExp(`Closing offer "${closingOffer.toLowerCase()}"`))
  })
}

test('rejects a paragraph opening with narrative prose', () => {
  const parts = [
    'Toronto is next week, and the flight is still unbooked.',
    'Ahead:',
    'Tue Sept 15 8am Card appt, Lakeside: bring library card.',
  ]
  assert.match(firstReason(briefFile({ parts })), /Paragraph must open with one of/)
})

test('rejects a heading other than the brief title', () => {
  const parts = ['## Mail', 'Decisions:', '[high] Mon Sept 14 (2d) Renew or drop the domain.']
  assert.match(firstReason(briefFile({ parts })), /Paragraph must open with one of/)
})

test('rejects a wrong title line', () => {
  const fileText = briefFile().replace('# Brief for 2026-09-12', '# Daily brief')
  assert.match(firstReason(fileText), /Paragraph must open with one of/)
})

test('accepts a part split into two item paragraphs', () => {
  const parts = [
    'Decisions:',
    '[high] Mon Sept 14 (2d) Drop oldshop.example.',
    '[medium] Sun Sept 20 (9d) Book an evening departure. The Oslo flight is unbooked.',
    'Ahead:',
    'Tue Sept 15 8am Card appt, Lakeside: bring library card.',
  ]
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('rejects a paragraph opening with a label outside the allowed set', () => {
  const parts = ['Decisions:', '[high] Mon Sept 14 (2d) Drop oldshop.example.', 'Summary: the week is quiet after Monday.']
  assert.match(firstReason(briefFile({ parts })), /Paragraph must open with one of/)
})

for (const listMarker of ['1.', '2)', '-', '*', '+']) {
  test(`rejects a line opening with the list marker ${listMarker}`, () => {
    const parts = ['Decisions:', `${listMarker} Mon Sept 14 (2d) Drop oldshop.example.`]
    assert.match(firstReason(briefFile({ parts })), /List marker where prose belongs/)
  })
}

test('rejects an indented list marker', () => {
  const parts = ['Decisions:', '  - Mon Sept 14 (2d) Drop oldshop.example.']
  assert.match(firstReason(briefFile({ parts })), /List marker where prose belongs/)
})

test('accepts a sentence opening with a date that is not a list marker', () => {
  const parts = ['Ahead:', '2026-09-15 8am Card appt, Lakeside: bring library card.']
  const violations = findBriefViolations(briefFile({ parts }))
  assert.ok(!violations.some(({ reason }) => /List marker/.test(reason)))
})

test('rejects an empty file', () => {
  assert.match(firstReason(''), /Brief must open with/)
})

test('rejects a file holding only the title', () => {
  assert.match(firstReason('# Brief for 2026-09-12\n'), /Brief must carry a part opening with one of/)
})

test('rejects a body with no title line', () => {
  const fileText = 'Decisions:\n\n[high] Mon Sept 14 (2d) Drop oldshop.example.\n'
  assert.match(firstReason(fileText), /Brief must open with/)
})

test('reports violations in line order', () => {
  const parts = ['Ahead:', 'Mon Sept 14 The week looms.', 'Tue Sept 15 Just let me know before Monday.']
  const violations = findBriefViolations(briefFile({ parts }))
  assert.deepEqual(violations.map((violation) => violation.line), [5, 7])
})

test('runner returns the clean, violation, and usage exit codes', async () => {
  await withTemporaryFile('assistant-brief-', briefFile(), async (briefFilePath) => {
    const errorLines = []
    assert.equal(await runBriefCheck([briefFilePath], { writeError: (line) => errorLines.push(line) }), 0)
    assert.deepEqual(errorLines, [])
    assert.equal(await runBriefCheck([], { writeError: (line) => errorLines.push(line) }), addUsageExitCode)
    assert.match(errorLines.at(-1), /usage/)
    await writeFile(briefFilePath, briefFile({ parts: ['Ahead:', 'Mon Sept 14 The week looms.'] }))
    assert.equal(await runBriefCheck([briefFilePath], { writeError: (line) => errorLines.push(line) }), briefViolationsExitCode)
    assert.match(errorLines.at(-1), /Banned phrase "looms"/)
  })
})

test('CLI returns the clean, violation, and usage exit codes', async () => {
  await withTemporaryFile('assistant-brief-', briefFile(), async (briefFilePath) => {
    assert.equal((await runBriefCliProcess(briefFilePath)).exitCode, 0)
    await writeFile(briefFilePath, briefFile({ parts: ['Ahead:', 'Mon Sept 14 The week looms.'] }))
    assert.equal((await runBriefCliProcess(briefFilePath)).exitCode, briefViolationsExitCode)
    assert.equal((await runBriefCliProcess()).exitCode, addUsageExitCode)
  })
})

test('accepts a decisions item carrying the action and one fact', () => {
  const parts = ['Decisions:', '[high] Mon Sept 14 (2d) Drop oldshop.example. The registrar lapsed July 19.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('rejects a decisions item carrying a second fact sentence', () => {
  const parts = ['Decisions:', '[high] Mon Sept 14 (2d) Drop oldshop.example. The registrar lapsed July 19. Notion has it archived.']
  assert.match(firstReason(briefFile({ parts })), /Item carries 3 sentences, over the 2 cap/)
})

test('rejects a decisions item running past the character cap', () => {
  const longFact = `The registrar lapsed around ${'the nineteenth of July and nobody has run the site since '.repeat(3)}then.`
  const parts = ['Decisions:', `[high] Mon Sept 14 (2d) Drop oldshop.example. ${longFact}`]
  assert.match(firstReason(briefFile({ parts })), /Item runs \d+ characters, over the 200 cap/)
})

test('rejects an ahead item carrying a fact sentence after its action', () => {
  const parts = ['Ahead:', 'Tue Sept 15 8am Card renewal, Lakeside: bring the town library card. The drive takes ninety minutes.']
  assert.match(firstReason(briefFile({ parts })), /Item carries 2 sentences, over the 1 cap/)
})

test('rejects an ahead item running past the character cap', () => {
  const parts = ['Ahead:', `Tue Sept 15 8am Card renewal in Lakeside, ${'bringing the sample library card and the requested form '.repeat(2)}both.`]
  assert.match(firstReason(briefFile({ parts })), /Item runs \d+ characters, over the 120 cap/)
})

test('counts a decimal point inside a fare as part of its sentence', () => {
  const parts = ['Decisions:', '[medium] Sun Sept 20 Book XY 101. The Saver fare is $399.20 and bags go at the gate.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('accepts an ahead item whose only period closes a known abbreviation', () => {
  const parts = ['Ahead:', 'Tue Sept 15 8am Sam sees Dr. Example in Riverton.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('accepts an ahead item carrying a dotted acronym', () => {
  const parts = ['Ahead:', 'Tue Sept 15 Mail the U.S. library forms.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('accepts an ahead item carrying a middle initial', () => {
  const parts = ['Ahead:', 'Tue Sept 15 Sign the leases for Dana C. Rios.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('accepts an ahead item whose only sentence break sits inside quoted sender words', () => {
  const parts = ['Ahead:', 'Tue Sept 15 Morgan wrote "We ship Tue. Confirm by noon."']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('accepts a decisions item carrying an action, a two-sentence quote, and one fact', () => {
  const parts = ['Decisions:', '[high] Mon Sept 14 (2d) Answer Morgan. Morgan wrote "We ship Tue. Confirm by noon." Lodging is unbooked.']
  assert.deepEqual(findBriefViolations(briefFile({ parts })), [])
})

test('rejects an ahead item whose second sentence sits outside quoted sender words', () => {
  const parts = ['Ahead:', 'Tue Sept 15 Morgan wrote we ship Tue. Confirm by noon.']
  assert.match(firstReason(briefFile({ parts })), /Item carries 2 sentences, over the 1 cap/)
})

test('rejects an ahead item whose fact sentence follows a capitalised word that is not an abbreviation', () => {
  const parts = ['Ahead:', 'Tue Sept 15 Book the later flight to Oslo. Morgan has the lodging.']
  assert.match(firstReason(briefFile({ parts })), /Item carries 2 sentences, over the 1 cap/)
})

test('accepts a one-sentence prep item past the plain-brief cap in a prep note', () => {
  const parts = ['Today:', 'Tue Sept 15 9am Library renewal, Lakeside: bring the old library card, the printed renewal form, and the reading list from the drawer.']
  assert.deepEqual(findBriefViolations(briefFile({ parts }), { filePath: 'briefs/2026-09-15-prep.md' }), [])
})

test('rejects that same prep-length item in a plain brief', () => {
  const parts = ['Today:', 'Tue Sept 15 9am Library renewal, Lakeside: bring the old library card, the printed renewal form, and the reading list from the drawer.']
  assert.match(firstReason(briefFile({ parts })), /Item runs 134 characters, over the 120 cap/)
})

test('rejects a prep item past the prep cap', () => {
  const parts = ['Ahead:', `Tue Sept 15 9am Library renewal, Lakeside: ${'bring the sample library card and the printed forms and '.repeat(3)}the sheet.`]
  const violations = findBriefViolations(briefFile({ parts }), { filePath: 'briefs/2026-09-15-prep.md' })
  assert.match(violations[0].reason, /Item runs \d+ characters, over the 200 cap/)
})

test('runner reads the prep cap off the path it was given', async () => {
  const parts = ['Today:', 'Tue Sept 15 9am Library renewal, Lakeside: bring the old library card, the printed renewal form, and the reading list from the drawer.']
  const prepNote = briefFile({ parts })
  await withTemporaryFile('assistant-prep-', prepNote, async (prepNotePath) => {
    assert.equal(await runBriefCheck([prepNotePath], { writeError: () => {} }), 0)
  }, { fileName: '2026-09-15-prep.md' })
  await withTemporaryFile('assistant-brief-', prepNote, async (briefFilePath) => {
    assert.equal(await runBriefCheck([briefFilePath], { writeError: () => {} }), briefViolationsExitCode)
  })
})
