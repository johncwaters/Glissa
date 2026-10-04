import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isCalendarDate } from './calendar-date.mjs'
import { isMainModule, runCommandLine } from './command-line.mjs'
import { getProfileDirectory, parseProfileLine } from './profile.mjs'

export const morningBriefWindow = { startMinutes: 7 * 60, endMinutes: 8 * 60 }
export const eveningBriefWindow = { startMinutes: 20 * 60, endMinutes: 21 * 60 }

const timeZoneFieldNamePattern = /^Time zone from (\d{4}-\d{2}-\d{2})$/
const monthNamesByShortName = { Sep: 'Sept' }

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch (error) {
    if (error instanceof RangeError) return false
    throw error
  }
}

function parseStatedTimeZoneLine(profileLine) {
  const profileField = parseProfileLine(profileLine)
  if (profileField?.kind !== 'fact' || profileField.provenance !== 'stated') return null
  const fieldNameMatch = timeZoneFieldNamePattern.exec(profileField.fieldName)
  if (!fieldNameMatch) return null
  const [, fromDate] = fieldNameMatch
  const { value: timeZone, untilDate } = profileField
  if (!isCalendarDate(fromDate) || !isValidTimeZone(timeZone)) return null
  if (untilDate && !isCalendarDate(untilDate)) return null
  return { fromDate, timeZone, untilDate }
}

function readStatedTimeZoneLines(profileDirectory) {
  let profileFileNames
  try {
    profileFileNames = readdirSync(profileDirectory, { withFileTypes: true })
      .filter((directoryEntry) => directoryEntry.isFile() && directoryEntry.name.endsWith('.md'))
      .map((directoryEntry) => directoryEntry.name)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return profileFileNames.flatMap((profileFileName) => readFileSync(join(profileDirectory, profileFileName), 'utf8')
    .split(/\r?\n/)
    .map(parseStatedTimeZoneLine)
    .filter(Boolean))
}

function readHomeTimeZone() {
  const configuredHomeTimeZone = process.env.ASSISTANT_HOME_TIME_ZONE
  if (!configuredHomeTimeZone) return 'UTC'
  if (isValidTimeZone(configuredHomeTimeZone)) return configuredHomeTimeZone
  process.stderr.write(`operator-time-zone: ASSISTANT_HOME_TIME_ZONE ${JSON.stringify(configuredHomeTimeZone)} is not a valid IANA zone; using UTC\n`)
  return 'UTC'
}

export function resolveOperatorTimeZone({ profileDirectory = getProfileDirectory(), now = new Date() } = {}) {
  const timeZoneLinesInFromDateOrder = readStatedTimeZoneLines(profileDirectory)
    .sort((firstLine, secondLine) => firstLine.fromDate.localeCompare(secondLine.fromDate))
  let timeZoneInEffect = readHomeTimeZone()
  for (const { fromDate, timeZone, untilDate } of timeZoneLinesInFromDateOrder) {
    if (fromDate > getLocalDateAndMinutes(now, timeZoneInEffect).calendarDate) break
    if (untilDate && untilDate < getLocalDateAndMinutes(now, timeZone).calendarDate) continue
    timeZoneInEffect = timeZone
  }
  return timeZoneInEffect
}

export function getLocalDateAndMinutes(now, timeZone) {
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const valueByType = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]))
  const calendarDate = `${valueByType.year}-${valueByType.month}-${valueByType.day}`
  if (!isCalendarDate(calendarDate)) throw new Error('Local calendar date is invalid')
  return { calendarDate, minutesAfterMidnight: Number(valueByType.hour) * 60 + Number(valueByType.minute) }
}

export function formatLocalTimestamp(timestamp, timeZone) {
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(timestamp))
  const valueByType = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]))
  const monthName = monthNamesByShortName[valueByType.month] || valueByType.month
  const minuteText = valueByType.minute === '00' ? '' : `:${valueByType.minute}`
  return `${valueByType.weekday} ${monthName} ${valueByType.day} ${valueByType.hour}${minuteText}${valueByType.dayPeriod.toLowerCase()}`
}

export function runOperatorTimeZone(commandArguments, { now = new Date(), profileDirectory = getProfileDirectory(), writeOutput = console.log } = {}) {
  if (commandArguments.length > 0) throw new Error('operator-time-zone.mjs takes no arguments')
  const timeZone = resolveOperatorTimeZone({ profileDirectory, now })
  writeOutput(`${timeZone} ${formatLocalTimestamp(now, timeZone)}`)
  return 0
}

if (isMainModule(import.meta.url)) runCommandLine(runOperatorTimeZone)
