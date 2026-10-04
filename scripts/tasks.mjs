import { randomInt } from 'node:crypto'
import { addUsageExitCode, isMainModule, nothingToDoExitCode, parseFlags, readProcessStandardInput, runCommandLine, unreadableStateExitCode } from './command-line.mjs'
import { readJsonFile, withJsonFileLock, writeJsonFileAtomically } from './json-file.mjs'
import { isPlainObject, validateStringFields } from './object-fields.mjs'
import { resolveOperatorTimeZone } from './operator-time-zone.mjs'
import { getProfileDirectory } from './profile.mjs'
import { resolveRepositoryPath } from './repository-path.mjs'

const taskKinds = new Set(['reminder', 'follow-up', 'todo', 'buy', 'hunt'])
const taskFields = ['id', 'title', 'kind', 'status', 'due', 'source', 'notes', 'createdAt', 'updatedAt', 'notifiedAt', 'doneAt', 'every', 'until', 'seen']
const taskInputFields = new Set(['title', 'kind', 'due', 'source', 'notes', 'every', 'until'])
const standardInputFlagName = '--stdin'
const doneTaskRetentionDays = 30
const huntLifetimeDays = 30
const minimumHuntIntervalHours = 6
const maxSeenUrlsPerHunt = 200

export function parseRelativeTime(when, now = new Date()) {
  const relativeTimeMatch = /^\+(\d+)([mhd])$/.exec(when)
  if (!relativeTimeMatch) return null
  const amount = Number(relativeTimeMatch[1])
  const millisecondsByUnit = { m: 60_000, h: 3_600_000, d: 86_400_000 }
  return new Date(now.getTime() + amount * millisecondsByUnit[relativeTimeMatch[2]])
}

export function parseWhen(when, now = new Date()) {
  const relativeTime = parseRelativeTime(when, now)
  if (relativeTime) return relativeTime
  const isIsoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(when)
  if (!isIsoDateTime) return null
  const parsedTime = new Date(when)
  if (Number.isNaN(parsedTime.getTime())) return null
  return parsedTime
}

export function getTaskFilePath(environment = process.env) {
  return environment.ASSISTANT_TASKS_FILE || resolveRepositoryPath('tasks.json')
}

async function readLedger(taskFilePath) {
  try {
    const ledger = await readJsonFile(taskFilePath)
    if (!Array.isArray(ledger.tasks)) throw new Error('Task ledger must contain a tasks array')
    return ledger
  } catch (error) {
    if (error?.code === 'ENOENT') return { tasks: [] }
    throw error
  }
}

export async function getTaskIds(taskFilePath = getTaskFilePath()) {
  const ledger = await readLedger(taskFilePath)
  return ledger.tasks.map((task) => task.id)
}

function createTaskId(tasks) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const taskIds = new Set(tasks.map((task) => task.id))
  let taskId = ''
  do {
    taskId = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('')
  } while (taskIds.has(taskId))
  return taskId
}

function formatDueInLocalTime(due, timeZone) {
  if (!due) return '-'
  const dueDate = new Date(due)
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(dueDate)
  const partValue = (type) => dateParts.find((part) => part.type === type)?.value
  return `${partValue('weekday')} ${partValue('month')} ${partValue('day')} ${partValue('hour')}:${partValue('minute')} ${partValue('dayPeriod')}`
}

function formatTask(task, now, timeZone) {
  const isOverdue = task.due && new Date(task.due) <= now
  const dueText = `${isOverdue ? 'overdue ' : ''}${formatDueInLocalTime(task.due, timeZone)}`
  const sourceText = task.source ? `  [${task.source}]` : ''
  const cadenceText = task.kind === 'hunt' ? ` every ${task.every}` : ''
  return `${task.id}  ${task.kind}${cadenceText}  ${dueText}  ${task.title}${sourceText}`
}

function sortTasks(tasks) {
  return [...tasks].sort((firstTask, secondTask) => {
    if (firstTask.due && secondTask.due) return new Date(firstTask.due) - new Date(secondTask.due)
    if (firstTask.due) return -1
    if (secondTask.due) return 1
    return new Date(firstTask.createdAt) - new Date(secondTask.createdAt)
  })
}

function findOpenTask(tasks, taskId) {
  const task = tasks.find((candidateTask) => candidateTask.id === taskId)
  if (!task) throw new Error(`Unknown task id: ${taskId}`)
  if (task.status !== 'open') throw new Error(`Task already done: ${taskId}`)
  return task
}

function parseTaskInputJson(inputText) {
  try {
    return JSON.parse(inputText)
  } catch (error) {
    throw new Error(`Invalid task input JSON: ${error.message}`)
  }
}

async function readTaskInputFromStandardInput(readStandardInput) {
  const taskInput = parseTaskInputJson(await readStandardInput())
  if (!isPlainObject(taskInput)) throw new Error('Task input must be a JSON object')
  validateStringFields(taskInput, taskInputFields, { inputName: 'Task input' })
  return taskInput
}

function parseHuntEndDate(until, now) {
  if (until === undefined) return new Date(now.getTime() + huntLifetimeDays * 86_400_000)
  if (until.startsWith('+')) return null
  const isPlainDate = /^\d{4}-\d{2}-\d{2}$/.test(until)
  if (!isPlainDate) return parseWhen(until, now)
  const [year, month, day] = until.split('-').map(Number)
  const endDate = new Date(`${until}T23:59:59.999`)
  const isCalendarDate = endDate.getFullYear() === year && endDate.getMonth() + 1 === month && endDate.getDate() === day
  if (Number.isNaN(endDate.getTime()) || !isCalendarDate) return null
  return endDate
}

function buildTaskFromInput({ title, kind, due, source, notes, every, until }) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('Task title is required')
  const dueDate = due ? parseWhen(due) : null
  if (due && !dueDate) throw new Error('Invalid due time')
  const taskKind = kind || 'todo'
  if (!taskKinds.has(taskKind)) throw new Error('Invalid task kind')
  if (taskKind !== 'hunt' && (every !== undefined || until !== undefined)) throw new Error('Only hunts accept every and until')
  const now = new Date()
  const createdAt = now.toISOString()
  const task = {
    title, kind: taskKind, status: 'open', due: dueDate?.toISOString() || (taskKind === 'hunt' ? createdAt : null),
    source: source || null, notes: notes || null, createdAt, updatedAt: createdAt,
    notifiedAt: null, doneAt: null,
  }
  if (taskKind !== 'hunt') return task
  const nextCheck = every && /^[+]\d+[hd]$/.test(every) ? parseRelativeTime(every, now) : null
  if (!nextCheck || !Number.isFinite(nextCheck.getTime()) || nextCheck.getTime() - now.getTime() < minimumHuntIntervalHours * 3_600_000) throw new Error('Hunt every must be +Nh or +Nd and at least 6 hours')
  const endDate = parseHuntEndDate(until, now)
  if (!endDate) throw new Error('Invalid hunt until time')
  return { ...task, every, until: endDate.toISOString(), seen: [] }
}

async function appendTask(newTask, taskFilePath, writeOutput, now, timeZone) {
  const ledger = await readLedger(taskFilePath)
  const task = { id: createTaskId(ledger.tasks), ...newTask }
  ledger.tasks.push(task)
  await writeJsonFileAtomically(taskFilePath, ledger)
  writeOutput(formatTask(task, now, timeZone))
}

async function addTask(argumentsToParse, taskFilePath, writeOutput, writeError, readStandardInput, now, timeZone) {
  if (!argumentsToParse.includes(standardInputFlagName)) {
    writeError(`usage: tasks.mjs add ${standardInputFlagName} < task.json`)
    return addUsageExitCode
  }
  if (argumentsToParse.length !== 1) throw new Error(`${standardInputFlagName} takes no other arguments`)
  const newTask = buildTaskFromInput(await readTaskInputFromStandardInput(readStandardInput))
  return withJsonFileLock(taskFilePath, () => appendTask(newTask, taskFilePath, writeOutput, now, timeZone))
}

async function listTasks(argumentsToParse, taskFilePath, writeOutput, now, timeZone) {
  const flags = parseFlags(argumentsToParse, new Set(['--all', '--json']))
  const ledger = await readLedger(taskFilePath)
  const visibleTasks = flags.has('--all') ? ledger.tasks : ledger.tasks.filter((task) => task.status === 'open')
  const sortedTasks = sortTasks(visibleTasks)
  if (flags.has('--json')) {
    writeOutput(JSON.stringify(sortedTasks))
    return
  }
  sortedTasks.forEach((task) => writeOutput(formatTask(task, now, timeZone)))
}

async function showTask(argumentsToParse, taskFilePath, writeOutput) {
  if (argumentsToParse.length !== 1) throw new Error('Task id is required')
  const ledger = await readLedger(taskFilePath)
  const task = ledger.tasks.find((candidateTask) => candidateTask.id === argumentsToParse[0])
  if (!task) throw new Error(`Unknown task id: ${argumentsToParse[0]}`)
  taskFields.filter((fieldName) => Object.hasOwn(task, fieldName)).forEach((fieldName) => writeOutput(`${fieldName}: ${task[fieldName]}`))
}

async function completeTasks(argumentsToParse, taskFilePath) {
  if (argumentsToParse.length === 0) throw new Error('Task id is required')
  return withJsonFileLock(taskFilePath, () => completeTasksInLedger(argumentsToParse, taskFilePath))
}

async function completeTasksInLedger(taskIds, taskFilePath, resolution = null) {
  const ledger = await readLedger(taskFilePath)
  const completedAt = new Date().toISOString()
  const tasksToComplete = taskIds.map((taskId) => findOpenTask(ledger.tasks, taskId))
  const resolutionNote = resolution && `resolved ${completedAt.slice(0, 10)}: ${resolution}`
  tasksToComplete.forEach((task) => {
    task.status = 'done'
    task.doneAt = completedAt
    task.updatedAt = completedAt
    if (resolutionNote) task.notes = task.notes ? `${task.notes}\n${resolutionNote}` : resolutionNote
  })
  await writeJsonFileAtomically(taskFilePath, ledger)
}

function readDoneTaskInput(inputText) {
  const doneTaskInput = parseTaskInputJson(inputText)
  if (!isPlainObject(doneTaskInput)) return null
  const { ids, resolution } = doneTaskInput
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((taskId) => typeof taskId !== 'string' || !taskId)) return null
  if (typeof resolution !== 'string' || !resolution.trim()) return null
  return { ids, resolution }
}

async function completeTasksFromStandardInput(argumentsToParse, taskFilePath, writeError, readStandardInput) {
  if (argumentsToParse.length !== 1 || argumentsToParse[0] !== standardInputFlagName) {
    writeError(`usage: tasks.mjs done ${standardInputFlagName} < done.json`)
    return addUsageExitCode
  }
  const doneTaskInput = readDoneTaskInput(await readStandardInput())
  if (!doneTaskInput) {
    writeError(`usage: tasks.mjs done ${standardInputFlagName} < done.json`)
    return addUsageExitCode
  }
  return withJsonFileLock(taskFilePath, () => completeTasksInLedger(doneTaskInput.ids, taskFilePath, doneTaskInput.resolution))
}

function findMarkableTask(tasks, taskId) {
  const task = tasks.find((candidateTask) => candidateTask.id === taskId)
  if (!task) return { skipReason: 'unknown' }
  if (task.status !== 'open') return { skipReason: 'already done' }
  return { task }
}

async function markTasksNotified(argumentsToParse, taskFilePath, writeError) {
  if (argumentsToParse.length === 0) throw new Error('Task id is required')
  return withJsonFileLock(taskFilePath, () => markTasksNotifiedInLedger(argumentsToParse, taskFilePath, writeError))
}

async function markTasksNotifiedInLedger(argumentsToParse, taskFilePath, writeError) {
  const ledger = await readLedger(taskFilePath)
  const notifiedAt = new Date().toISOString()
  let markedTaskCount = 0
  argumentsToParse.forEach((taskId) => {
    const { task, skipReason } = findMarkableTask(ledger.tasks, taskId)
    if (skipReason) {
      writeError(`mark: skipped ${taskId} (${skipReason})`)
      return
    }
    task.notifiedAt = notifiedAt
    task.updatedAt = notifiedAt
    markedTaskCount += 1
  })
  if (markedTaskCount === 0) throw new Error('mark: no task was marked')
  await writeJsonFileAtomically(taskFilePath, ledger)
}

async function snoozeTask(argumentsToParse, taskFilePath) {
  if (argumentsToParse.length !== 2) throw new Error('Task id and due time are required')
  const dueDate = parseWhen(argumentsToParse[1])
  if (!dueDate) throw new Error('Invalid due time')
  return withJsonFileLock(taskFilePath, () => snoozeTaskInLedger(argumentsToParse[0], dueDate, taskFilePath))
}

async function snoozeTaskInLedger(taskId, dueDate, taskFilePath) {
  const ledger = await readLedger(taskFilePath)
  const task = findOpenTask(ledger.tasks, taskId)
  setNextTaskDue(task, dueDate)
  await writeJsonFileAtomically(taskFilePath, ledger)
}

function setNextTaskDue(task, dueDate, updatedAt = new Date().toISOString()) {
  task.due = dueDate.toISOString()
  task.notifiedAt = null
  task.updatedAt = updatedAt
}

function readRecheckTaskInput(inputText) {
  let recheckInput
  try {
    recheckInput = parseTaskInputJson(inputText)
  } catch {
    return null
  }
  if (!isPlainObject(recheckInput)) return null
  const { id, reported } = recheckInput
  if (typeof id !== 'string' || !id.trim()) return null
  if (!Array.isArray(reported) || reported.some((url) => typeof url !== 'string' || !url)) return null
  return { id, reported }
}

async function recheckTask(argumentsToParse, taskFilePath, writeOutput, writeError, readStandardInput) {
  const usage = `usage: tasks.mjs recheck ${standardInputFlagName} < recheck.json`
  if (argumentsToParse.length !== 1 || argumentsToParse[0] !== standardInputFlagName) {
    writeError(usage)
    return addUsageExitCode
  }
  const recheckInput = readRecheckTaskInput(await readStandardInput())
  if (!recheckInput) {
    writeError(usage)
    return addUsageExitCode
  }
  return withJsonFileLock(taskFilePath, () => recheckTaskInLedger(recheckInput, taskFilePath, writeOutput))
}

function appendReportedUrls(task, reportedUrls) {
  const seenUrls = new Set(task.seen)
  const newlyReportedUrls = [...new Set(reportedUrls)].filter((url) => !seenUrls.has(url))
  task.seen = [...task.seen, ...newlyReportedUrls].slice(-maxSeenUrlsPerHunt)
}

async function recheckTaskInLedger({ id, reported }, taskFilePath, writeOutput) {
  const ledger = await readLedger(taskFilePath)
  const task = findOpenTask(ledger.tasks, id)
  if (task.kind !== 'hunt') throw new Error(`Task is not a hunt: ${id}`)
  const now = new Date()
  appendReportedUrls(task, reported)
  if (now > new Date(task.until)) {
    await writeJsonFileAtomically(taskFilePath, ledger)
    await completeTasksInLedger([id], taskFilePath, 'hunt ended')
    writeOutput('ended')
    return
  }
  setNextTaskDue(task, parseRelativeTime(task.every, now), now.toISOString())
  await writeJsonFileAtomically(taskFilePath, ledger)
}

export async function getDueTasks(taskFilePath = getTaskFilePath(), now = new Date()) {
  const ledger = await readLedger(taskFilePath)
  return sortTasks(ledger.tasks.filter((task) => task.status === 'open' && task.due && !task.notifiedAt && new Date(task.due) <= now))
}

async function listDueTasks(argumentsToParse, taskFilePath, writeOutput, now, timeZone) {
  const flags = parseFlags(argumentsToParse, new Set(['--json', '--quiet']))
  const dueTasks = await getDueTasks(taskFilePath, now)
  if (!flags.has('--quiet')) {
    if (flags.has('--json')) writeOutput(JSON.stringify(dueTasks))
    if (!flags.has('--json')) dueTasks.forEach((task) => writeOutput(formatTask(task, now, timeZone)))
  }
  return dueTasks.length > 0 ? 0 : nothingToDoExitCode
}

async function pruneDoneTasks(argumentsToParse, taskFilePath, writeOutput) {
  if (argumentsToParse.length !== 0) throw new Error('prune takes no arguments')
  return withJsonFileLock(taskFilePath, () => pruneDoneTasksInLedger(taskFilePath, writeOutput))
}

async function pruneDoneTasksInLedger(taskFilePath, writeOutput) {
  const ledger = await readLedger(taskFilePath)
  const retentionThreshold = new Date(Date.now() - doneTaskRetentionDays * 86_400_000)
  const tasksToRemove = ledger.tasks.filter((task) => task.status === 'done' && task.doneAt && new Date(task.doneAt) < retentionThreshold)
  if (tasksToRemove.length === 0) return nothingToDoExitCode
  const taskIdsToRemove = new Set(tasksToRemove.map((task) => task.id))
  ledger.tasks = ledger.tasks.filter((task) => !taskIdsToRemove.has(task.id))
  await writeJsonFileAtomically(taskFilePath, ledger)
  tasksToRemove.forEach((task) => writeOutput(`prune: removed ${task.id}`))
}

export async function runTaskCommand(commandArguments, { taskFilePath = getTaskFilePath(), profileDirectory = getProfileDirectory(), now = new Date(), writeOutput = console.log, writeError = console.error, readStandardInput = readProcessStandardInput } = {}) {
  const [command, ...argumentsToParse] = commandArguments
  const timeZone = ['add', 'list', 'due'].includes(command) ? resolveOperatorTimeZone({ profileDirectory, now }) : null
  if (command === 'add') return addTask(argumentsToParse, taskFilePath, writeOutput, writeError, readStandardInput, now, timeZone)
  if (command === 'list') return listTasks(argumentsToParse, taskFilePath, writeOutput, now, timeZone)
  if (command === 'show') return showTask(argumentsToParse, taskFilePath, writeOutput)
  if (command === 'done' && argumentsToParse[0] === standardInputFlagName) return completeTasksFromStandardInput(argumentsToParse, taskFilePath, writeError, readStandardInput)
  if (command === 'done') return completeTasks(argumentsToParse, taskFilePath)
  if (command === 'mark') return markTasksNotified(argumentsToParse, taskFilePath, writeError)
  if (command === 'snooze') return snoozeTask(argumentsToParse, taskFilePath)
  if (command === 'recheck') return recheckTask(argumentsToParse, taskFilePath, writeOutput, writeError, readStandardInput)
  if (command === 'due') return listDueTasks(argumentsToParse, taskFilePath, writeOutput, now, timeZone)
  if (command === 'prune') return pruneDoneTasks(argumentsToParse, taskFilePath, writeOutput)
  throw new Error('Unknown command')
}

if (isMainModule(import.meta.url)) {
  const statefulReadCommandNames = new Set(['due', 'prune'])
  runCommandLine(runTaskCommand, { failureExitCode: statefulReadCommandNames.has(process.argv[2]) ? unreadableStateExitCode : 1 })
}
