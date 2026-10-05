import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { addUsageExitCode, nothingToDoExitCode, unreadableStateExitCode } from './command-line.mjs'
import { withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { readJsonFile } from './json-file.mjs'
import { captureTestCommand } from './process-test-helpers.mjs'
import { getDueTasks, parseRelativeTime, parseWhen, runTaskCommand } from './tasks.mjs'

const scriptPath = new URL('./tasks.mjs', import.meta.url)

async function withTemporaryLedger(testFunction) {
  return withTemporaryDirectory('glissa-tasks-', async (temporaryDirectory) => {
    const taskFilePath = join(temporaryDirectory, 'tasks.json')
    await mkdir(join(temporaryDirectory, 'profile'))
    await testFunction(taskFilePath)
  })
}

async function runTaskCliProcess(taskFilePath, ...commandArguments) {
  return runTaskCliProcessWithStandardInput(taskFilePath, undefined, ...commandArguments)
}

async function runTaskCliProcessWithStandardInput(taskFilePath, standardInputText, ...commandArguments) {
  return captureTestCommand(process.execPath, [scriptPath.pathname, ...commandArguments], {
    env: { ...process.env, GLISSA_TASKS_FILE: taskFilePath, GLISSA_PROFILE_DIR: join(dirname(taskFilePath), 'profile') },
  }, standardInputText)
}

async function collectTaskCommandOutput(taskFilePath, commandArguments, standardInputText = '') {
  const outputLines = []
  const exitCode = await runTaskCommand(commandArguments, {
    taskFilePath,
    profileDirectory: join(dirname(taskFilePath), 'profile'),
    writeOutput: (line) => outputLines.push(line),
    readStandardInput: async () => standardInputText,
  })
  return { outputLines, exitCode }
}

async function addTaskFromStandardInput(taskFilePath, taskInput) {
  return runTaskCliProcessWithStandardInput(taskFilePath, JSON.stringify(taskInput), 'add', '--stdin')
}

async function readTasks(taskFilePath) {
  const ledger = await readJsonFile(taskFilePath)
  return ledger.tasks
}

function readTaskIdFromAddOutput(addOutput) {
  return addOutput.split('  ')[0]
}

test('parses relative and local-zone ISO due times', () => {
  const now = new Date('2026-09-09T12:00:00.000Z')
  assert.equal(parseRelativeTime('+2h', now)?.toISOString(), '2026-09-09T14:00:00.000Z')
  assert.equal(parseRelativeTime('+9x', now), null)
  assert.equal(parseWhen('2026-09-09T12:00', now)?.getFullYear(), 2026)
  assert.equal(parseWhen('not-a-time', now), null)
})

test('adds tasks and lists dated tasks before undated tasks', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    await addTaskFromStandardInput(taskFilePath, { title: 'Undated task' })
    await addTaskFromStandardInput(taskFilePath, { title: 'Later task', due: '+2h' })
    const listResult = await runTaskCliProcess(taskFilePath, 'list')
    assert.equal(listResult.exitCode, 0)
    assert.match(listResult.stdout.split('\n')[0], /Later task/)
    assert.match(listResult.stdout, /Undated task/)
  })
})

test('task list and due output use the current Oslo profile zone', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    await writeFile(join(dirname(taskFilePath), 'profile', 'travel.md'), '- Time zone from 2027-06-28: Europe/Oslo (stated 2027-06-27)\n')
    await writeFile(taskFilePath, JSON.stringify({ tasks: [{ id: 'abcd', kind: 'todo', status: 'open', title: 'Oslo call', due: '2027-06-28T13:10:00.000Z', notifiedAt: null }] }))
    const now = new Date('2027-06-28T13:11:00.000Z')
    const profileDirectory = join(dirname(taskFilePath), 'profile')
    const listLines = []
    await runTaskCommand(['list'], { taskFilePath, profileDirectory, now, writeOutput: (line) => listLines.push(line) })
    assert.match(listLines[0], /Mon Jun 28 3:10 PM  Oslo call/)
    const dueLines = []
    assert.equal(await runTaskCommand(['due'], { taskFilePath, profileDirectory, now, writeOutput: (line) => dueLines.push(line) }), 0)
    assert.match(dueLines[0], /Mon Jun 28 3:10 PM  Oslo call/)
  })
})

test('due leaves notification state alone until mark runs', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const addResult = await addTaskFromStandardInput(taskFilePath, { title: 'Due now', due: '+0m' })
    const taskId = readTaskIdFromAddOutput(addResult.stdout)
    const dueResult = await runTaskCliProcess(taskFilePath, 'due')
    assert.equal(dueResult.exitCode, 0)
    assert.match(dueResult.stdout, /Due now/)
    assert.equal((await readTasks(taskFilePath))[0].notifiedAt, null)
    const markResult = await runTaskCliProcess(taskFilePath, 'mark', taskId)
    assert.equal(markResult.exitCode, 0)
    assert.notEqual((await readTasks(taskFilePath))[0].notifiedAt, null)
  })
})

test('due --quiet exits with the no-due-tasks exit code when nothing is due', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const emptyLedgerResult = await runTaskCliProcess(taskFilePath, 'due', '--quiet')
    assert.equal(emptyLedgerResult.exitCode, nothingToDoExitCode)
    const addResult = await addTaskFromStandardInput(taskFilePath, { title: 'Due now', due: '+0m' })
    await runTaskCliProcess(taskFilePath, 'mark', readTaskIdFromAddOutput(addResult.stdout))
    const markedLedgerResult = await runTaskCliProcess(taskFilePath, 'due', '--quiet')
    assert.equal(markedLedgerResult.exitCode, nothingToDoExitCode)
    assert.equal(markedLedgerResult.stdout, '')
  })
})

test('snoozing clears notification state and done tasks only appear with all', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const addResult = await addTaskFromStandardInput(taskFilePath, { title: 'Finish report', due: '+0m' })
    const taskId = readTaskIdFromAddOutput(addResult.stdout)
    await runTaskCliProcess(taskFilePath, 'mark', taskId)
    await runTaskCliProcess(taskFilePath, 'snooze', taskId, '+1h')
    const shownTask = await runTaskCliProcess(taskFilePath, 'show', taskId)
    assert.match(shownTask.stdout, /notifiedAt: null/)
    await runTaskCliProcess(taskFilePath, 'done', taskId)
    const openTasks = await runTaskCliProcess(taskFilePath, 'list')
    const allTasks = await runTaskCliProcess(taskFilePath, 'list', '--all')
    assert.doesNotMatch(openTasks.stdout, /Finish report/)
    assert.match(allTasks.stdout, /Finish report/)
  })
})

test('returns exit code one for unknown task ids', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const commandResult = await runTaskCliProcess(taskFilePath, 'done', 'nope')
    assert.equal(commandResult.exitCode, 1)
    assert.match(commandResult.stderr, /Unknown task id/)
  })
})

test('distinguishes an already done task from an unknown task id', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const addResult = await addTaskFromStandardInput(taskFilePath, { title: 'Call the dentist' })
    const taskId = readTaskIdFromAddOutput(addResult.stdout)
    await runTaskCliProcess(taskFilePath, 'done', taskId)
    const repeatedDoneResult = await runTaskCliProcess(taskFilePath, 'done', taskId)
    assert.equal(repeatedDoneResult.exitCode, 1)
    assert.match(repeatedDoneResult.stderr, new RegExp(`Task already done: ${taskId}`))
  })
})

test('done stdin records a resolution for tasks with and without notes', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const unnotedTask = await addTaskFromStandardInput(taskFilePath, { title: 'Decide on venue' })
    const notedTask = await addTaskFromStandardInput(taskFilePath, { title: 'Decide on catering', notes: 'Waiting for quotes' })
    const unnotedTaskId = readTaskIdFromAddOutput(unnotedTask.stdout)
    const notedTaskId = readTaskIdFromAddOutput(notedTask.stdout)
    const completionResult = await runTaskCliProcessWithStandardInput(taskFilePath, JSON.stringify({
      ids: [unnotedTaskId, notedTaskId], resolution: 'Selected the downtown venue.',
    }), 'done', '--stdin')
    assert.equal(completionResult.exitCode, 0)
    const tasksById = new Map((await readTasks(taskFilePath)).map((task) => [task.id, task]))
    const resolutionNote = `resolved ${new Date().toISOString().slice(0, 10)}: Selected the downtown venue.`
    assert.equal(tasksById.get(unnotedTaskId).notes, resolutionNote)
    assert.equal(tasksById.get(notedTaskId).notes, `Waiting for quotes\n${resolutionNote}`)
    assert.equal(tasksById.get(unnotedTaskId).status, 'done')
    assert.equal(tasksById.get(notedTaskId).status, 'done')
  })
})

test('done stdin rejects missing ids or resolution without changing the ledger', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const addResult = await addTaskFromStandardInput(taskFilePath, { title: 'Choose a vendor' })
    const taskId = readTaskIdFromAddOutput(addResult.stdout)
    const missingIdsResult = await runTaskCliProcessWithStandardInput(taskFilePath, JSON.stringify({ resolution: 'Approved the quote.' }), 'done', '--stdin')
    assert.equal(missingIdsResult.exitCode, addUsageExitCode)
    assert.match(missingIdsResult.stderr, /usage: tasks\.mjs done --stdin < done\.json/)
    const missingResolutionResult = await runTaskCliProcessWithStandardInput(taskFilePath, JSON.stringify({ ids: [taskId] }), 'done', '--stdin')
    assert.equal(missingResolutionResult.exitCode, addUsageExitCode)
    assert.equal((await readTasks(taskFilePath))[0].status, 'open')
  })
})

test('mark persists the ids it can and skips the rest', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const openAddResult = await addTaskFromStandardInput(taskFilePath, { title: 'Still open', due: '+0m' })
    const completedAddResult = await addTaskFromStandardInput(taskFilePath, { title: 'Already handled', due: '+0m' })
    const openTaskId = readTaskIdFromAddOutput(openAddResult.stdout)
    const completedTaskId = readTaskIdFromAddOutput(completedAddResult.stdout)
    await runTaskCliProcess(taskFilePath, 'done', completedTaskId)
    const markResult = await runTaskCliProcess(taskFilePath, 'mark', openTaskId, completedTaskId, 'nope')
    assert.equal(markResult.exitCode, 0)
    assert.match(markResult.stderr, new RegExp(`mark: skipped ${completedTaskId} \\(already done\\)`))
    assert.match(markResult.stderr, /mark: skipped nope \(unknown\)/)
    const tasks = await readTasks(taskFilePath)
    assert.notEqual(tasks.find((task) => task.id === openTaskId).notifiedAt, null)
    const remainingDueResult = await runTaskCliProcess(taskFilePath, 'due', '--quiet')
    assert.equal(remainingDueResult.exitCode, nothingToDoExitCode)
  })
})

test('mark exits one when no id could be marked', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    await addTaskFromStandardInput(taskFilePath, { title: 'Untouched task', due: '+0m' })
    const markResult = await runTaskCliProcess(taskFilePath, 'mark', 'nope')
    assert.equal(markResult.exitCode, 1)
    assert.match(markResult.stderr, /mark: skipped nope \(unknown\)/)
    assert.equal((await readTasks(taskFilePath))[0].notifiedAt, null)
  })
})

test('add --stdin stores shell metacharacters in the title verbatim', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const hostileTitle = 'Reply to $(id) re "`uname -a`; rm -rf / && echo ${HOME}"'
    const addResult = await runTaskCliProcessWithStandardInput(taskFilePath, JSON.stringify({
      title: hostileTitle, kind: 'follow-up', due: '+2d', source: 'thread-abc', notes: 'draft created',
    }), 'add', '--stdin')
    assert.equal(addResult.exitCode, 0)
    const [storedTask] = await readTasks(taskFilePath)
    assert.equal(storedTask.title, hostileTitle)
    assert.equal(storedTask.kind, 'follow-up')
    assert.equal(storedTask.source, 'thread-abc')
    assert.equal(storedTask.notes, 'draft created')
    assert.notEqual(storedTask.due, null)
  })
})

test('add --stdin stores an undated buy-list item', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const addResult = await runTaskCliProcessWithStandardInput(taskFilePath, JSON.stringify({ title: 'Buy a USB hub', kind: 'buy' }), 'add', '--stdin')
    assert.equal(addResult.exitCode, 0)
    const [storedTask] = await readTasks(taskFilePath)
    assert.equal(storedTask.kind, 'buy')
    assert.equal(storedTask.due, null)
  })
})

test('hunt input requires a cadence of at least six hours and keeps non-hunt tasks unchanged', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const invalidInputs = [
      { title: 'Find paper', kind: 'hunt' },
      { title: 'Find paper', kind: 'hunt', every: '+2h' },
      { title: 'Find paper', kind: 'hunt', every: '+360m' },
      { title: 'Buy paper', kind: 'todo', every: '+1d' },
      { title: 'Buy paper', kind: 'todo', until: '2026-10-01' },
      { title: 'Find paper', kind: 'hunt', every: '+1d', until: '2026-02-30' },
      { title: 'Find paper', kind: 'hunt', every: '+1d', until: '+2d' },
    ]
    for (const taskInput of invalidInputs) {
      const addResult = await addTaskFromStandardInput(taskFilePath, taskInput)
      assert.equal(addResult.exitCode, 1)
    }
    const hourlyResult = await addTaskFromStandardInput(taskFilePath, { title: 'Find paper', kind: 'hunt', every: '+6h' })
    const dailyResult = await addTaskFromStandardInput(taskFilePath, { title: 'Find cartridges', kind: 'hunt', every: '+1d', until: '2026-12-01' })
    const todoResult = await addTaskFromStandardInput(taskFilePath, { title: 'Buy paper', kind: 'todo' })
    assert.equal(hourlyResult.exitCode, 0)
    assert.equal(dailyResult.exitCode, 0)
    assert.equal(todoResult.exitCode, 0)
    assert.match(hourlyResult.stdout, /hunt every \+6h/)
    const [hourlyHunt, dailyHunt, todoTask] = await readTasks(taskFilePath)
    assert.equal(hourlyHunt.until, new Date(new Date(hourlyHunt.createdAt).getTime() + 30 * 86_400_000).toISOString())
    assert.deepEqual(hourlyHunt.seen, [])
    assert.equal(hourlyHunt.due, hourlyHunt.createdAt)
    assert.equal(dailyHunt.until, new Date(2026, 11, 1, 23, 59, 59, 999).toISOString())
    assert.equal(Object.hasOwn(todoTask, 'every'), false)
    assert.equal(Object.hasOwn(todoTask, 'until'), false)
    assert.equal(Object.hasOwn(todoTask, 'seen'), false)
    const shownHunt = await runTaskCliProcess(taskFilePath, 'show', hourlyHunt.id)
    const shownTodo = await runTaskCliProcess(taskFilePath, 'show', todoTask.id)
    assert.match(shownHunt.stdout, /every: \+6h/)
    assert.doesNotMatch(shownTodo.stdout, /every:|until:|seen:/)
  })
})

test('a hunt added with a past due time appears in the due set', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const addResult = await addTaskFromStandardInput(taskFilePath, { title: 'Find paper', kind: 'hunt', every: '+1d', due: '2025-01-01T00:00:00Z' })
    const taskId = readTaskIdFromAddOutput(addResult.stdout)
    assert.deepEqual((await getDueTasks(taskFilePath)).map((task) => task.id), [taskId])
  })
})

test('recheck appends reported URLs once and schedules the next check silently', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const addResult = await addTaskFromStandardInput(taskFilePath, { title: 'Find paper', kind: 'hunt', every: '+6h' })
    const taskId = readTaskIdFromAddOutput(addResult.stdout)
    await runTaskCliProcess(taskFilePath, 'mark', taskId)
    assert.notEqual((await readTasks(taskFilePath))[0].notifiedAt, null)
    const firstCheckStartedAt = Date.now()
    const firstResult = await runTaskCliProcessWithStandardInput(taskFilePath, JSON.stringify({ id: taskId, reported: ['https://example.com/a', 'https://example.com/a', 'https://example.com/b'] }), 'recheck', '--stdin')
    assert.equal(firstResult.exitCode, 0)
    assert.equal(firstResult.stdout, '')
    const [firstTask] = await readTasks(taskFilePath)
    assert.deepEqual(firstTask.seen, ['https://example.com/a', 'https://example.com/b'])
    assert.equal(firstTask.notifiedAt, null)
    assert.ok(new Date(firstTask.due).getTime() >= firstCheckStartedAt + 6 * 3_600_000)
    const secondResult = await runTaskCliProcessWithStandardInput(taskFilePath, JSON.stringify({ id: taskId, reported: ['https://example.com/b', 'https://example.com/c'] }), 'recheck', '--stdin')
    assert.equal(secondResult.exitCode, 0)
    assert.equal(secondResult.stdout, '')
    const [secondTask] = await readTasks(taskFilePath)
    assert.deepEqual(secondTask.seen, ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'])
    assert.ok(new Date(secondTask.due) >= new Date(firstTask.due))
  })
})

test('recheck with nothing reported re-arms the hunt and leaves seen unchanged', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const addResult = await addTaskFromStandardInput(taskFilePath, { title: 'Find paper', kind: 'hunt', every: '+1d' })
    const taskId = readTaskIdFromAddOutput(addResult.stdout)
    await runTaskCliProcess(taskFilePath, 'mark', taskId)
    const checkStartedAt = Date.now()
    const recheckResult = await runTaskCliProcessWithStandardInput(taskFilePath, JSON.stringify({ id: taskId, reported: [] }), 'recheck', '--stdin')
    assert.equal(recheckResult.exitCode, 0)
    const [rearmedHunt] = await readTasks(taskFilePath)
    assert.deepEqual(rearmedHunt.seen, [])
    assert.equal(rearmedHunt.notifiedAt, null)
    assert.equal(rearmedHunt.status, 'open')
    assert.ok(new Date(rearmedHunt.due).getTime() >= checkStartedAt + 86_400_000)
  })
})

test('recheck keeps only the newest 200 reported URLs', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const addResult = await addTaskFromStandardInput(taskFilePath, { title: 'Find paper', kind: 'hunt', every: '+1d' })
    const taskId = readTaskIdFromAddOutput(addResult.stdout)
    const reportedUrls = Array.from({ length: 205 }, (_, index) => `https://example.com/${index}`)
    const recheckResult = await collectTaskCommandOutput(taskFilePath, ['recheck', '--stdin'], JSON.stringify({ id: taskId, reported: reportedUrls }))
    assert.equal(recheckResult.outputLines.length, 0)
    assert.deepEqual((await readTasks(taskFilePath))[0].seen, reportedUrls.slice(-200))
  })
})

test('recheck records the last report and closes a past-end hunt, and rejects non-hunts', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const huntResult = await addTaskFromStandardInput(taskFilePath, { title: 'Find paper', kind: 'hunt', every: '+1d', until: '2025-01-01' })
    const todoResult = await addTaskFromStandardInput(taskFilePath, { title: 'Buy paper', kind: 'todo' })
    const huntId = readTaskIdFromAddOutput(huntResult.stdout)
    const todoId = readTaskIdFromAddOutput(todoResult.stdout)
    const endedResult = await runTaskCliProcessWithStandardInput(taskFilePath, JSON.stringify({ id: huntId, reported: ['https://example.com/a'] }), 'recheck', '--stdin')
    assert.equal(endedResult.exitCode, 0)
    assert.equal(endedResult.stdout.trim(), 'ended')
    const [endedHunt] = await readTasks(taskFilePath)
    assert.equal(endedHunt.status, 'done')
    assert.deepEqual(endedHunt.seen, ['https://example.com/a'])
    assert.match(endedHunt.notes, /: hunt ended$/)
    const nonHuntResult = await runTaskCliProcessWithStandardInput(taskFilePath, JSON.stringify({ id: todoId, reported: [] }), 'recheck', '--stdin')
    assert.equal(nonHuntResult.exitCode, 1)
    assert.match(nonHuntResult.stderr, /Task is not a hunt/)
  })
})

test('a plain-date until ends the hunt at the close of that local day', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const addResult = await addTaskFromStandardInput(taskFilePath, { title: 'Find paper', kind: 'hunt', every: '+1d', until: '2026-10-01' })
    assert.equal(addResult.exitCode, 0)
    const [hunt] = await readTasks(taskFilePath)
    const endDate = new Date(hunt.until)
    assert.deepEqual([endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), endDate.getHours(), endDate.getMinutes()], [2026, 9, 1, 23, 59])
  })
})

test('recheck rejects bad stdin with usage exit code', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const badInputs = ['{', '{}', '{"id":"","reported":[]}', '{"id":"abcd","reported":"no"}', '{"id":"abcd","reported":[3]}', '{"id":"abcd","urls":[]}']
    for (const badInput of badInputs) {
      const recheckResult = await runTaskCliProcessWithStandardInput(taskFilePath, badInput, 'recheck', '--stdin')
      assert.equal(recheckResult.exitCode, addUsageExitCode)
      assert.match(recheckResult.stderr, /usage: tasks\.mjs recheck --stdin < recheck\.json/)
    }
    const missingFlagResult = await runTaskCliProcess(taskFilePath, 'recheck')
    assert.equal(missingFlagResult.exitCode, addUsageExitCode)
  })
})

test('add without --stdin prints usage and stores nothing', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const flagFormResult = await runTaskCliProcess(taskFilePath, 'add', 'Call the dentist', '--due', '+2d')
    assert.equal(flagFormResult.exitCode, addUsageExitCode)
    assert.match(flagFormResult.stderr, /usage: tasks\.mjs add --stdin < task\.json/)
    const bareAddResult = await runTaskCliProcess(taskFilePath, 'add')
    assert.equal(bareAddResult.exitCode, addUsageExitCode)
    assert.deepEqual(await readTasks(taskFilePath).catch(() => []), [])
  })
})

test('add --stdin rejects malformed input, unknown fields, and a positional title', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const malformedResult = await runTaskCliProcessWithStandardInput(taskFilePath, '{', 'add', '--stdin')
    assert.equal(malformedResult.exitCode, 1)
    assert.match(malformedResult.stderr, /Invalid task input JSON/)
    const arrayResult = await runTaskCliProcessWithStandardInput(taskFilePath, '[]', 'add', '--stdin')
    assert.match(arrayResult.stderr, /Task input must be a JSON object/)
    const unknownFieldResult = await runTaskCliProcessWithStandardInput(taskFilePath, '{"title":"A","status":"done"}', 'add', '--stdin')
    assert.match(unknownFieldResult.stderr, /Unknown task input fields: status/)
    const nonStringResult = await runTaskCliProcessWithStandardInput(taskFilePath, '{"title":["A"]}', 'add', '--stdin')
    assert.match(nonStringResult.stderr, /Task input fields must be strings: title/)
    const missingTitleResult = await runTaskCliProcessWithStandardInput(taskFilePath, '{"kind":"todo"}', 'add', '--stdin')
    assert.match(missingTitleResult.stderr, /Task title is required/)
    const badKindResult = await runTaskCliProcessWithStandardInput(taskFilePath, '{"title":"A","kind":"urgent"}', 'add', '--stdin')
    assert.match(badKindResult.stderr, /Invalid task kind/)
    const positionalTitleResult = await runTaskCliProcessWithStandardInput(taskFilePath, '{"title":"A"}', 'add', 'Typed title', '--stdin')
    assert.match(positionalTitleResult.stderr, /--stdin takes no other arguments/)
    assert.deepEqual(await readTasks(taskFilePath).catch(() => []), [])
  })
})

test('due and prune exit with the ledger failure code when the ledger cannot be parsed', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    await writeFile(taskFilePath, '{')
    const dueResult = await runTaskCliProcess(taskFilePath, 'due', '--quiet')
    assert.equal(dueResult.exitCode, unreadableStateExitCode)
    const pruneResult = await runTaskCliProcess(taskFilePath, 'prune')
    assert.equal(pruneResult.exitCode, unreadableStateExitCode)
    const listResult = await runTaskCliProcess(taskFilePath, 'list')
    assert.equal(listResult.exitCode, 1)
  })
})

test('prune removes done tasks older than the retention period', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const now = new Date()
    const oldDoneAt = new Date(now.getTime() - 31 * 86_400_000).toISOString()
    const recentDoneAt = new Date(now.getTime() - 29 * 86_400_000).toISOString()
    await writeFile(taskFilePath, JSON.stringify({ tasks: [
      { id: 'old1', title: 'Old done task', status: 'done', doneAt: oldDoneAt },
      { id: 'new1', title: 'Recent done task', status: 'done', doneAt: recentDoneAt },
      { id: 'open', title: 'Open task', status: 'open', doneAt: null },
    ] }))
    const firstPruneResult = await collectTaskCommandOutput(taskFilePath, ['prune'])
    assert.equal(firstPruneResult.exitCode, undefined)
    assert.deepEqual(firstPruneResult.outputLines, ['prune: removed old1'])
    assert.deepEqual((await readTasks(taskFilePath)).map((task) => task.id), ['new1', 'open'])
    const secondPruneResult = await collectTaskCommandOutput(taskFilePath, ['prune'])
    assert.equal(secondPruneResult.exitCode, nothingToDoExitCode)
    assert.deepEqual(secondPruneResult.outputLines, [])
  })
})

test('concurrent add processes keep every task in a parsable ledger', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    for (let roundIndex = 0; roundIndex < 10; roundIndex += 1) {
      const roundResults = await Promise.all([
        addTaskFromStandardInput(taskFilePath, { title: `First task of round ${roundIndex}` }),
        addTaskFromStandardInput(taskFilePath, { title: `Second task of round ${roundIndex}` }),
      ])
      roundResults.forEach((roundResult) => assert.equal(roundResult.exitCode, 0))
    }
    const tasks = await readTasks(taskFilePath)
    assert.equal(tasks.length, 20)
    assert.equal(new Set(tasks.map((task) => task.id)).size, 20)
  })
})

test('runs commands in process against an injected ledger path', async () => {
  await withTemporaryLedger(async (taskFilePath) => {
    const addOutput = await collectTaskCommandOutput(taskFilePath, ['add', '--stdin'], JSON.stringify({ title: 'In-process task', due: '+0m' }))
    assert.match(addOutput.outputLines[0], /In-process task/)
    const dueOutput = await collectTaskCommandOutput(taskFilePath, ['due', '--json'])
    assert.equal(dueOutput.exitCode, 0)
    assert.equal(JSON.parse(dueOutput.outputLines[0]).length, 1)
    await assert.rejects(collectTaskCommandOutput(taskFilePath, ['nonsense']), /Unknown command/)
  })
})
