import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { readChatRecords } from './chat-log.mjs'
import { isMainModule, runCommandLine } from './command-line.mjs'
import { logEvent } from './log.mjs'
import { eveningBriefWindow, getLocalDateAndMinutes, morningBriefWindow, resolveOperatorTimeZone } from './operator-time-zone.mjs'
import { getProfileDirectory } from './profile.mjs'
import { resolveRepositoryPath } from './repository-path.mjs'
import {
  isSocketAnswering,
  readServeState,
  resolveGlissaDirectories,
  resolveDispatchSocketPath,
  resolveServeStateFilePath,
} from './serve.mjs'
import { getWatchStateFilePath, readWatchState } from './watch.mjs'

const maximumWatchAgeMs = 35 * 60 * 1_000
const missedMessageMinimumAgeMs = 10 * 60 * 1_000
const missedMessageMaximumAgeMs = 20 * 60 * 1_000
const runningTriggeredUnitStates = new Set(['active', 'activating', 'deactivating'])
const maximumTriggeredUnitRunMs = 5 * 60 * 1_000
const briefOverdueAfterWindowMinutes = 30
const executeFile = promisify(execFile)

async function runSystemCommand(command, commandArguments) {
  const { stdout } = await executeFile(command, commandArguments)
  return stdout
}

async function showUnitProperty(runCommand, unitName, propertyName, extraArguments = []) {
  const propertyValue = await runCommand('systemctl', ['--user', 'show', ...extraArguments, unitName, '-p', propertyName, '--value'])
  return propertyValue.trim()
}

// A Type=oneshot triggered unit never reaches active, so ActiveEnterTimestamp stays blank and only InactiveExitTimestamp dates its run.
async function readTriggeredUnitRunMs(runCommand, triggeredUnitName, now) {
  const inactiveExitTimestamp = await showUnitProperty(runCommand, triggeredUnitName, 'InactiveExitTimestamp', ['--timestamp=unix'])
  const unixSecondsMatch = /^@(\d+)$/.exec(inactiveExitTimestamp)
  if (!unixSecondsMatch) return null
  return new Date(now).getTime() - Number(unixSecondsMatch[1]) * 1_000
}

// The property reads below are separate systemctl calls, so a triggered unit that finishes between them leaves a next elapse that was blank only while it ran.
async function confirmStallAfterRereadingNextElapse(runCommand, timerUnitName, stallReason) {
  const rereadNextElapse = await showUnitProperty(runCommand, timerUnitName, 'NextElapseUSecRealtime')
  if (rereadNextElapse) return null
  return stallReason
}

async function describeTimerStall(runCommand, timerUnitName, now) {
  const nextElapse = await showUnitProperty(runCommand, timerUnitName, 'NextElapseUSecRealtime')
  if (nextElapse) return null
  const triggeredUnitName = await showUnitProperty(runCommand, timerUnitName, 'Unit')
  if (!triggeredUnitName) return `${timerUnitName} has no next elapse (timer not loaded)`
  const triggeredUnitState = await showUnitProperty(runCommand, triggeredUnitName, 'ActiveState')
  const timerState = await showUnitProperty(runCommand, timerUnitName, 'ActiveState')
  const stallPrefix = `${timerUnitName} has no next elapse (timer ${timerState}, ${triggeredUnitName} ${triggeredUnitState}`
  if (!runningTriggeredUnitStates.has(triggeredUnitState)) return confirmStallAfterRereadingNextElapse(runCommand, timerUnitName, `${stallPrefix})`)
  const triggeredUnitRunMs = await readTriggeredUnitRunMs(runCommand, triggeredUnitName, now)
  if (triggeredUnitRunMs !== null && triggeredUnitRunMs <= maximumTriggeredUnitRunMs) return null
  const runDescription = triggeredUnitRunMs === null ? 'unknown' : `${Math.floor(triggeredUnitRunMs / 60_000)}m`
  return confirmStallAfterRereadingNextElapse(runCommand, timerUnitName, `${stallPrefix} for ${runDescription})`)
}

async function findStalledTimerReason(repositoryRoot, runCommand, now) {
  const unitFileNames = await readdir(join(repositoryRoot, 'systemd'))
  const timerUnitNames = unitFileNames.filter((unitFileName) => unitFileName.endsWith('.timer'))
  for (const timerUnitName of timerUnitNames) {
    const stallReason = await describeTimerStall(runCommand, timerUnitName, now)
    if (stallReason) return stallReason
  }
  return null
}

async function pathIsSocket(filePath) {
  try {
    return (await stat(filePath)).isSocket()
  } catch {
    return false
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function timestampIsOnCalendarDate(timestamp, calendarDate, profileDirectory) {
  if (typeof timestamp !== 'string' || Number.isNaN(new Date(timestamp).getTime())) return false
  const instant = new Date(timestamp)
  const timeZoneAtInstant = resolveOperatorTimeZone({ profileDirectory, now: instant })
  return getLocalDateAndMinutes(instant, timeZoneAtInstant).calendarDate === calendarDate
}

function formatLocalMessageTime(timestamp, timeZone) {
  const timeParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(timestamp))
  const valueByType = Object.fromEntries(timeParts.map(({ type, value }) => [type, value]))
  return `${valueByType.hour}:${valueByType.minute} ${valueByType.dayPeriod.toLowerCase()} ${timeZone}`
}

function findMissedMessageReason(now, readChatRecordsFromLog, timeZone) {
  const currentTimeMs = now.getTime()
  const recentChatRecords = readChatRecordsFromLog({ since: new Date(currentTimeMs - missedMessageMaximumAgeMs) })
    .filter((record) => new Date(record.ts).getTime() <= currentTimeMs)
  const outboundTimesMs = recentChatRecords
    .filter((record) => record.direction === 'out')
    .map((record) => new Date(record.ts).getTime())
  const missedMessage = recentChatRecords.find((record) => {
    if (record.direction !== 'in') return false
    const receivedAtMs = new Date(record.ts).getTime()
    const messageAgeMs = currentTimeMs - receivedAtMs
    if (messageAgeMs < missedMessageMinimumAgeMs || messageAgeMs >= missedMessageMaximumAgeMs) return false
    return !outboundTimesMs.some((outboundTimeMs) => outboundTimeMs > receivedAtMs)
  })
  if (!missedMessage) return null
  return `Missed your message at ${formatLocalMessageTime(missedMessage.ts, timeZone)}, resend it`
}

export async function checkHealth({
  now,
  repositoryRoot,
  stateDirectory,
  runtimeDirectory,
  watchStateFilePath,
  runCommand = runSystemCommand,
  readChatRecordsFromLog = readChatRecords,
  profileDirectory,
}) {
  const currentTime = new Date(now)
  const timeZone = resolveOperatorTimeZone({ profileDirectory, now: currentTime })
  if (!runtimeDirectory) return 'no runtime directory'
  const socketPath = resolveDispatchSocketPath(runtimeDirectory)
  if (!await pathIsSocket(socketPath)) return 'dispatch socket absent'
  if (!await isSocketAnswering(socketPath)) return 'dispatch socket not answering'
  const missedMessageReason = findMissedMessageReason(currentTime, readChatRecordsFromLog, timeZone)
  if (missedMessageReason) return missedMessageReason
  const stalledTimerReason = await findStalledTimerReason(repositoryRoot, runCommand, currentTime)
  if (stalledTimerReason) return stalledTimerReason

  let watchState
  try {
    watchState = await readWatchState(watchStateFilePath)
  } catch {
    return 'watch state cannot be read'
  }
  const accountChecks = Object.entries(watchState.accounts).map(([accountName, accountState]) => ({
    accountName,
    checkedAtMs: new Date(accountState.checkedAt).getTime(),
  }))
  if (accountChecks.length === 0) return 'watch state has no checkedAt timestamp'
  const staleAccountCheck = accountChecks.find(({ checkedAtMs }) => !Number.isFinite(checkedAtMs))
  if (staleAccountCheck) return `mail watch has no checkedAt for ${staleAccountCheck.accountName}`
  // One account losing its gog authorization freezes only its own cursor, so the oldest account decides.
  const oldestAccountCheck = accountChecks.reduce(
    (oldestSoFar, accountCheck) => (accountCheck.checkedAtMs < oldestSoFar.checkedAtMs ? accountCheck : oldestSoFar),
  )
  if (currentTime.getTime() - oldestAccountCheck.checkedAtMs > maximumWatchAgeMs) {
    return `mail watch checkedAt for ${oldestAccountCheck.accountName} is older than ${maximumWatchAgeMs / 60_000} minutes`
  }

  const { calendarDate, minutesAfterMidnight } = getLocalDateAndMinutes(currentTime, timeZone)
  let serveState
  try {
    serveState = await readServeState(resolveServeStateFilePath(stateDirectory))
  } catch {
    return 'serve state cannot be read'
  }
  const morningDispatchAt = serveState.lastDispatchAt.morning
  const morningWasDispatchedToday = timestampIsOnCalendarDate(morningDispatchAt, calendarDate, profileDirectory)
  if (minutesAfterMidnight >= morningBriefWindow.endMinutes + briefOverdueAfterWindowMinutes && morningWasDispatchedToday) {
    const briefPath = join(repositoryRoot, 'briefs', `${calendarDate}.md`)
    if (!await pathExists(briefPath)) return `morning brief missing for ${calendarDate}`
  }

  const eveningDispatchAt = serveState.lastDispatchAt.evening
  const eveningWasDispatchedToday = timestampIsOnCalendarDate(eveningDispatchAt, calendarDate, profileDirectory)
  if (minutesAfterMidnight < eveningBriefWindow.endMinutes + briefOverdueAfterWindowMinutes || !eveningWasDispatchedToday) return null
  const eveningReplyAtMs = new Date(serveState.lastReplyAt.evening).getTime()
  if (!Number.isFinite(eveningReplyAtMs) || eveningReplyAtMs < new Date(eveningDispatchAt).getTime()) {
    return `Telegram reply missing after evening dispatch for ${calendarDate}`
  }
  return null
}

async function runHealth(commandArguments, { environment = process.env, now = new Date(), profileDirectory = getProfileDirectory(environment) } = {}) {
  if (commandArguments.length > 0) throw new Error('health.mjs takes no arguments')
  const { stateDirectory, runtimeDirectory } = resolveGlissaDirectories(environment)
  const failure = await checkHealth({
    now,
    profileDirectory,
    repositoryRoot: resolveRepositoryPath(),
    stateDirectory,
    runtimeDirectory,
    watchStateFilePath: getWatchStateFilePath(environment),
  })
  if (!failure) return 0
  logEvent('health', 'failed', { reason: failure })
  console.log(`health: ${failure}`)
  return 1
}

if (isMainModule(import.meta.url)) runCommandLine(runHealth)
