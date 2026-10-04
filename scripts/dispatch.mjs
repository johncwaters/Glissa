import { createConnection } from 'node:net'
import { isMainModule, runCommandLine } from './command-line.mjs'
import { logEvent } from './log.mjs'
import { eveningBriefWindow, getLocalDateAndMinutes, morningBriefWindow, resolveOperatorTimeZone } from './operator-time-zone.mjs'
import { getProfileDirectory } from './profile.mjs'
import { getDueTasks, getTaskFilePath } from './tasks.mjs'
import {
  acceptedDispatchAnswer,
  queuedDispatchAnswer,
  readServeState,
  rejectedDispatchAnswerPrefix,
  resolveAssistantDirectories,
  resolveDispatchSocketPath,
  resolveServeStateFilePath,
} from './serve.mjs'

async function wasBriefDispatchedOnLocalDate({ mode, localCalendarDate, profileDirectory, environment }) {
  const { stateDirectory } = resolveAssistantDirectories(environment)
  let serveState
  try {
    serveState = await readServeState(resolveServeStateFilePath(stateDirectory))
  } catch {
    logEvent('dispatch', 'state_unreadable', { mode })
    return false
  }
  const lastDispatchTimestamp = serveState.lastDispatchAt[mode]
  if (typeof lastDispatchTimestamp !== 'string') return false
  const lastDispatchTime = new Date(lastDispatchTimestamp)
  if (Number.isNaN(lastDispatchTime.getTime())) return false
  const timeZoneAtLastDispatch = resolveOperatorTimeZone({ profileDirectory, now: lastDispatchTime })
  return getLocalDateAndMinutes(lastDispatchTime, timeZoneAtLastDispatch).calendarDate === localCalendarDate
}

export async function runDispatch(commandArguments, { environment = process.env, now = new Date(), profileDirectory = getProfileDirectory(environment) } = {}) {
  const [mode] = commandArguments
  if (!mode) return 2
  if (mode === 'tasks' && (await getDueTasks(getTaskFilePath(environment))).length === 0) return 0
  if (mode === 'morning' || mode === 'evening') {
    const timeZone = resolveOperatorTimeZone({ profileDirectory, now })
    const { calendarDate: localCalendarDate, minutesAfterMidnight } = getLocalDateAndMinutes(now, timeZone)
    const briefWindow = mode === 'morning' ? morningBriefWindow : eveningBriefWindow
    if (minutesAfterMidnight < briefWindow.startMinutes || minutesAfterMidnight >= briefWindow.endMinutes) return 0
    if (await wasBriefDispatchedOnLocalDate({ mode, localCalendarDate, profileDirectory, environment })) return 0
  }
  const { runtimeDirectory } = resolveAssistantDirectories(environment)
  if (!runtimeDirectory) {
    logEvent('dispatch', 'failed', { mode, reason: 'no runtime directory' })
    return 3
  }
  return new Promise((resolve) => {
    const connection = createConnection(resolveDispatchSocketPath(runtimeDirectory))
    let hasFinished = false
    let answerText = ''
    let responseTimeout
    const finish = (exitCode, event, reason = null, answer = null) => {
      if (hasFinished) return
      hasFinished = true
      clearTimeout(responseTimeout)
      const eventFields = { mode }
      if (reason !== null) eventFields.reason = reason
      if (answer !== null) eventFields.answer = answer
      logEvent('dispatch', event, eventFields)
      connection.destroy()
      resolve(exitCode)
    }
    responseTimeout = setTimeout(() => finish(3, 'failed', 'no answer'), 5_000)
    connection.once('error', () => finish(3, 'failed', 'socket unavailable'))
    connection.once('connect', () => {
      connection.write(`${mode}\n`)
    })
    connection.on('data', (chunk) => {
      answerText += chunk
      const newlineIndex = answerText.indexOf('\n')
      if (newlineIndex === -1) return
      const answerLine = answerText.slice(0, newlineIndex).replace(/\r$/, '')
      if (answerLine === acceptedDispatchAnswer || answerLine === queuedDispatchAnswer) {
        finish(0, 'sent', null, answerLine)
        return
      }
      if (answerLine.startsWith(rejectedDispatchAnswerPrefix)) {
        finish(4, 'failed', answerLine.slice(rejectedDispatchAnswerPrefix.length), 'rejected')
        return
      }
      finish(3, 'failed', 'invalid answer')
    })
    connection.once('end', () => {
      if (!hasFinished) finish(3, 'failed', 'no answer')
    })
  })
}

if (isMainModule(import.meta.url)) runCommandLine(runDispatch)
