import { lstat, mkdir, readdir, rmdir, stat, unlink } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { isCalendarDate } from './calendar-date.mjs'
import { addUsageExitCode, isMainModule, nothingToDoExitCode, parseFlags, readProcessStandardInput, runCommandLine, unreadableStateExitCode } from './command-line.mjs'
import { readJsonFile, withJsonFileLock, writeJsonFileAtomically } from './json-file.mjs'
import { isPlainObject, validateStringFields } from './object-fields.mjs'
import { formatLocalTimestamp, getLocalDateAndMinutes } from './operator-time-zone.mjs'
import { resolveRepositoryPath } from './repository-path.mjs'
import { parseWhen } from './tasks.mjs'

const postStatuses = new Set(['draft', 'queued', 'published', 'skipped'])
const assetReadinessValues = new Set(['yes', 'no', 'not-needed'])
const editableTextFields = new Set(['copy', 'threadFollowUps', 'openingLine', 'altText'])
const optionalTextFields = ['url', 'bufferPostId', 'publishedAt', 'fallback', 'threadFollowUps', 'sourceCopy', 'sourceThreadFollowUps', 'rewrittenAt']
const postTextFields = ['pillar', 'openingLine', 'copy', 'format', 'assetBrief', 'altText', 'followUp', 'evidenceToCheck', 'experiment', ...optionalTextFields]
const metricNames = ['impressions', 'membersReached', 'reactions', 'comments', 'reposts', 'saves', 'sends', 'profileViews', 'follows', 'linkClicks', 'usefulConversations']
const metricWindows = [{ name: '72h', ageMs: 72 * 3_600_000 }, { name: '7d', ageMs: 7 * 86_400_000 }]
const platforms = ['linkedin', 'x']
const playbookFields = new Set(['area', 'decision', 'howToUse', 'evidence'])
const chatShorthandPattern = /\b(?:lol|lmao|rofl|tbh|imo|imho|idk|ngl|fwiw|smh|xd)\b|(?<![\w:])[:;]-?[()DPp/|](?![\w/])|<3|\p{Extended_Pictographic}/iu
const baselineMetricNames = ['linkedInImpressions', 'linkedInMembersReached', 'linkedInEngagements', 'linkedInFollowers', 'grossNewLinkedInFollows']

export function getContentFilePath(environment = process.env) {
  return environment.GLISSA_CONTENT_FILE || resolveRepositoryPath('content/plan.json')
}

function validateTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || /^[+-]/.test(timeZone)) throw new Error('Invalid content time zone')
  new Intl.DateTimeFormat('en-US', { timeZone })
}

export function getScheduledAt(post, timeZone) {
  const localTimestamp = Date.parse(`${post.plannedDate}T${post.slot}:00.000Z`)
  const [hour, minute] = post.slot.split(':').map(Number)
  const scheduledMinutes = hour * 60 + minute
  const offsets = new Set([-86_400_000, 0, 86_400_000].map((shiftMs) => {
    const sampledTimestamp = localTimestamp + shiftMs
    const { calendarDate, minutesAfterMidnight } = getLocalDateAndMinutes(new Date(sampledTimestamp), timeZone)
    return Date.parse(`${calendarDate}T00:00:00.000Z`) + minutesAfterMidnight * 60_000 - sampledTimestamp
  }))
  const matchingTimestamps = [...offsets].map((offsetMs) => localTimestamp - offsetMs).filter((timestamp) => {
    const { calendarDate, minutesAfterMidnight } = getLocalDateAndMinutes(new Date(timestamp), timeZone)
    return calendarDate === post.plannedDate && minutesAfterMidnight === scheduledMinutes
  })
  if (matchingTimestamps.length === 0) throw new Error(`Nonexistent scheduled local time: ${post.plannedDate} ${post.slot}`)
  return new Date(Math.min(...matchingTimestamps)).toISOString()
}

export function getMissingReadiness(post) {
  const missing = []
  if (post.factsVerified === false) missing.push('facts')
  if (post.assetReady === 'no') missing.push('asset')
  if ([post.copy, post.threadFollowUps].some((text) => typeof text === 'string' && /\[[^\]\n]+\]/.test(text))) missing.push('placeholders')
  if ([post.copy, post.threadFollowUps, post.openingLine].some(hasChatShorthand)) missing.push('shorthand')
  return missing
}

export function hasChatShorthand(text) {
  return typeof text === 'string' && chatShorthandPattern.test(text)
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function validateMetrics(metrics) {
  if (!isPlainObject(metrics)) throw new Error('Post metrics must be an object')
  for (const { name } of metricWindows) {
    if (!Object.hasOwn(metrics, name)) continue
    const windowMetrics = metrics[name]
    if (!isPlainObject(windowMetrics)) throw new Error(`Invalid metrics window: ${name}`)
    for (const metricName of metricNames) {
      if (Object.hasOwn(windowMetrics, metricName) && !isNonNegativeInteger(windowMetrics[metricName])) throw new Error(`Invalid metric: ${name}.${metricName}`)
    }
  }
  if (Object.hasOwn(metrics, 'amplified') && !['yes', 'no'].includes(metrics.amplified)) throw new Error('Invalid metrics.amplified')
}

function normalizePost(post, timeZone) {
  if (!isPlainObject(post)) throw new Error('Post must be an object')
  if (typeof post.id !== 'string' || !/^[LX]O?\d{2}$/.test(post.id)) throw new Error('Invalid post id')
  const offPlan = post.offPlan === undefined ? false : post.offPlan
  if (typeof offPlan !== 'boolean') throw new Error('Invalid offPlan')
  if (offPlan !== /^[LX]O\d{2}$/.test(post.id)) throw new Error(`Invalid offPlan for post: ${post.id}`)
  const expectedPlatform = post.id.startsWith('L') ? 'linkedin' : 'x'
  if (post.platform !== expectedPlatform) throw new Error(`Invalid platform for post: ${post.id}`)
  if (typeof post.plannedDate !== 'string' || !isCalendarDate(post.plannedDate)) throw new Error('Invalid plannedDate')
  if (typeof post.slot !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(post.slot)) throw new Error('Invalid slot')
  if (!postStatuses.has(post.status)) throw new Error('Invalid post status')
  if (!assetReadinessValues.has(post.assetReady)) throw new Error('Invalid assetReady')
  if (typeof post.factsVerified !== 'boolean') throw new Error('Invalid factsVerified')
  const normalizedPost = { ...post, offPlan }
  optionalTextFields.forEach((fieldName) => {
    if (normalizedPost[fieldName] === undefined) normalizedPost[fieldName] = null
  })
  for (const fieldName of postTextFields) {
    if (normalizedPost[fieldName] !== null && typeof normalizedPost[fieldName] !== 'string') throw new Error(`Post field must be a string or null: ${fieldName}`)
  }
  if (normalizedPost.publishedAt && !parseIsoTimestamp(normalizedPost.publishedAt)) throw new Error('Invalid publishedAt')
  if (normalizedPost.rewrittenAt && !parseIsoTimestamp(normalizedPost.rewrittenAt)) throw new Error('Invalid rewrittenAt')
  if (normalizedPost.metrics === undefined) normalizedPost.metrics = {}
  validateMetrics(normalizedPost.metrics)
  getScheduledAt(normalizedPost, timeZone)
  return normalizedPost
}

function validateBaseline(baseline) {
  if (!isPlainObject(baseline)) throw new Error('Content baseline must be an object')
  for (const fieldName of ['windowStart', 'windowEnd']) {
    if (typeof baseline[fieldName] !== 'string' || !isCalendarDate(baseline[fieldName])) throw new Error(`Invalid baseline ${fieldName}`)
  }
  for (const fieldName of baselineMetricNames) {
    if (!isNonNegativeInteger(baseline[fieldName])) throw new Error(`Invalid baseline ${fieldName}`)
  }
}

function normalizeLedger(ledger) {
  if (!isPlainObject(ledger)) throw new Error('Content plan must be a JSON object')
  const timeZone = ledger.timeZone === undefined ? 'America/Denver' : ledger.timeZone
  validateTimeZone(timeZone)
  validateBaseline(ledger.baseline)
  if (!Array.isArray(ledger.playbook)) throw new Error('Content playbook must be an array')
  ledger.playbook.forEach((entry) => {
    if (!isPlainObject(entry)) throw new Error('Playbook entry must be an object')
    validateStringFields(entry, playbookFields, { inputName: 'Playbook entry' })
    if ([...playbookFields].some((fieldName) => !Object.hasOwn(entry, fieldName))) throw new Error('Missing playbook entry field')
  })
  if (!Array.isArray(ledger.posts)) throw new Error('Content plan must contain a posts array')
  const posts = ledger.posts.map((post) => normalizePost(post, timeZone))
  if (new Set(posts.map((post) => post.id)).size !== posts.length) throw new Error('Duplicate post id')
  return { ...ledger, timeZone, posts }
}

async function readLedger(contentFilePath) {
  try {
    return normalizeLedger(await readJsonFile(contentFilePath))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    throw new Error(`Content plan not found: ${contentFilePath}`)
  }
}

async function initializeLedger(argumentsToParse, contentFilePath, writeError, readStandardInput) {
  if (argumentsToParse.length === 0) {
    writeError('usage: content.mjs init --stdin < plan.json')
    return addUsageExitCode
  }
  parseFlags(argumentsToParse, new Set(['--stdin']))
  const ledger = normalizeLedger(JSON.parse(await readStandardInput()))
  await mkdir(dirname(contentFilePath), { recursive: true })
  return withJsonFileLock(contentFilePath, async () => {
    try {
      await stat(contentFilePath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await writeJsonFileAtomically(contentFilePath, ledger)
      return
    }
    throw new Error(`Content plan already exists: ${contentFilePath}`)
  })
}

function extendPost(post, timeZone) {
  return { ...post, scheduledAt: getScheduledAt(post, timeZone), missing: getMissingReadiness(post) }
}

function formatPost(post, timeZone) {
  const readiness = post.missing.length === 0 ? 'ready' : `missing ${post.missing.join(',')}`
  const openingLine = post.openingLine || ''
  const shortenedOpeningLine = openingLine.length > 60 ? `${openingLine.slice(0, 57)}...` : openingLine
  return `${post.id}  ${post.platform}  ${formatLocalTimestamp(post.scheduledAt, timeZone)}  ${post.status}  ${readiness}  ${shortenedOpeningLine}`
}

function listScheduledPosts(command, argumentsToParse, ledger, now, writeOutput) {
  const flags = parseFlags(argumentsToParse, new Set(['--json']))
  const { calendarDate } = getLocalDateAndMinutes(now, ledger.timeZone)
  const endDate = new Date(`${calendarDate}T00:00:00.000Z`)
  endDate.setUTCDate(endDate.getUTCDate() + (command === 'week' ? 6 : 0))
  const posts = ledger.posts.filter((post) => post.plannedDate >= calendarDate && post.plannedDate <= endDate.toISOString().slice(0, 10))
    .map((post) => extendPost(post, ledger.timeZone))
    .sort((firstPost, secondPost) => firstPost.scheduledAt.localeCompare(secondPost.scheduledAt))
  if (flags.has('--json')) writeOutput(JSON.stringify(posts))
  if (!flags.has('--json')) posts.forEach((post) => writeOutput(formatPost(post, ledger.timeZone)))
  return posts.length > 0 ? 0 : nothingToDoExitCode
}

function findPost(ledger, postId) {
  const post = ledger.posts.find((candidatePost) => candidatePost.id === postId)
  if (!post) throw new Error(`Unknown post id: ${postId}`)
  return post
}

function showPost(argumentsToParse, ledger, writeOutput) {
  if (argumentsToParse.length !== 1) throw new Error('Post id is required')
  writeOutput(JSON.stringify(extendPost(findPost(ledger, argumentsToParse[0]), ledger.timeZone), null, 2))
}

function parseIsoTimestamp(value) {
  if (value.startsWith('+')) return null
  return parseWhen(value)
}

function parseSetting(assignment) {
  const equalsIndex = assignment.indexOf('=')
  if (equalsIndex < 1) throw new Error(`Invalid setting: ${assignment}`)
  const path = assignment.slice(0, equalsIndex)
  const value = assignment.slice(equalsIndex + 1)
  if (path === 'status' && postStatuses.has(value)) return { path, value }
  if (path === 'assetReady' && assetReadinessValues.has(value)) return { path, value }
  if (path === 'factsVerified' && ['true', 'false'].includes(value)) return { path, value: value === 'true' }
  if (path === 'url' && value.startsWith('https://')) return { path, value }
  if (path === 'bufferPostId' && value === '') return { path, value: null }
  if (path === 'bufferPostId' && value.trim()) return { path, value }
  if (path === 'rewrittenAt' && value === '') return { path, value: null }
  if ((path === 'publishedAt' || path === 'rewrittenAt') && parseIsoTimestamp(value)) return { path, value: parseIsoTimestamp(value).toISOString() }
  if (path === 'metrics.amplified' && ['yes', 'no'].includes(value)) return { path, value }
  const metricMatch = /^metrics\.(72h|7d)\.([a-zA-Z]+)$/.exec(path)
  if (metricMatch && metricNames.includes(metricMatch[2]) && /^\d+$/.test(value) && isNonNegativeInteger(Number(value))) return { path, value: Number(value) }
  throw new Error(`Invalid setting: ${assignment}`)
}

async function readTextSettings(readStandardInput) {
  const inputFields = JSON.parse(await readStandardInput())
  if (!isPlainObject(inputFields)) throw new Error('Post input must be a JSON object')
  const stringFields = Object.fromEntries(Object.entries(inputFields).map(([fieldName, value]) => [fieldName, value === null ? '' : value]))
  validateStringFields(stringFields, editableTextFields, { inputName: 'Post input' })
  return Object.entries(inputFields).map(([path, value]) => ({ path, value }))
}

function rejectChatShorthand(settings) {
  const shorthandSetting = settings.find(({ path, value }) => (path === 'copy' || path === 'threadFollowUps' || path === 'openingLine') && hasChatShorthand(value))
  if (shorthandSetting) throw new Error(`Chat shorthand in ${shorthandSetting.path}: posts follow the long-form voice, not chat`)
}

function getFirstNonEmptyLine(copy) {
  return copy.split(/\r?\n/).find((line) => line.trim()) || ''
}

function createOffPlanPost(ledger, platform, now, fields) {
  const idPrefix = platform === 'linkedin' ? 'LO' : 'XO'
  const existingIds = new Set(ledger.posts.map((post) => post.id))
  for (let postNumber = 1; postNumber <= 99; postNumber += 1) {
    const id = `${idPrefix}${String(postNumber).padStart(2, '0')}`
    if (existingIds.has(id)) continue
    return {
      id, offPlan: true, platform, pillar: 'Off-plan', copy: null, openingLine: null,
      threadFollowUps: null, altText: null, format: null, assetBrief: null, followUp: null,
      evidenceToCheck: null, experiment: null, fallback: null, factsVerified: true,
      assetReady: 'not-needed', status: 'draft', rewrittenAt: now.toISOString(),
      sourceCopy: null, sourceThreadFollowUps: null, bufferPostId: null, publishedAt: null,
      url: null, metrics: {}, ...fields,
    }
  }
  throw new Error(`No free off-plan post id for platform: ${platform}`)
}

async function addPost(argumentsToParse, contentFilePath, now, readStandardInput, writeOutput) {
  const [platform, plannedDate, slot, ...options] = argumentsToParse
  if (!platform || !plannedDate || !slot || options.length === 0) throw new Error('Platform, plannedDate, slot and --stdin are required')
  if (!platforms.includes(platform)) throw new Error('Invalid platform')
  parseFlags(options, new Set(['--stdin']))
  const settings = await readTextSettings(readStandardInput)
  const fields = Object.fromEntries(settings.map(({ path, value }) => [path, value]))
  if (typeof fields.copy !== 'string' || !fields.copy.trim()) throw new Error('Post copy must be a non-empty string')
  rejectChatShorthand(settings)
  return withJsonFileLock(contentFilePath, async () => {
    const ledger = await readLedger(contentFilePath)
    const post = createOffPlanPost(ledger, platform, now, {
      ...fields, plannedDate, slot, openingLine: fields.openingLine ?? getFirstNonEmptyLine(fields.copy),
    })
    ledger.posts.push(post)
    await writeJsonFileAtomically(contentFilePath, normalizeLedger(ledger))
    writeOutput(post.id)
  })
}

function getPublicationSlot(publishedAt, timeZone) {
  const { calendarDate, minutesAfterMidnight } = getLocalDateAndMinutes(new Date(publishedAt), timeZone)
  const hours = String(Math.floor(minutesAfterMidnight / 60)).padStart(2, '0')
  const minutes = String(minutesAfterMidnight % 60).padStart(2, '0')
  return { plannedDate: calendarDate, slot: `${hours}:${minutes}` }
}

async function detachPost(argumentsToParse, contentFilePath, now, writeOutput) {
  if (argumentsToParse.length !== 1) throw new Error('Post id is required')
  return withJsonFileLock(contentFilePath, async () => {
    const ledger = await readLedger(contentFilePath)
    const post = findPost(ledger, argumentsToParse[0])
    if (post.offPlan) throw new Error(`Post is already off-plan: ${post.id}`)
    if (post.sourceCopy === null) throw new Error(`Post has no source copy: ${post.id}`)
    if (post.publishedAt === null) throw new Error(`Post is not published yet: ${post.id}. Detach it once it is published`)
    const offPlanPost = createOffPlanPost(ledger, post.platform, now, {
      ...getPublicationSlot(post.publishedAt, ledger.timeZone), copy: post.copy, openingLine: post.openingLine,
      threadFollowUps: post.threadFollowUps, altText: post.altText, bufferPostId: post.bufferPostId,
      status: post.status, publishedAt: post.publishedAt, url: post.url, metrics: post.metrics,
      assetReady: post.assetReady, rewrittenAt: post.rewrittenAt || now.toISOString(),
    })
    post.copy = post.sourceCopy
    post.threadFollowUps = post.sourceThreadFollowUps
    post.openingLine = getFirstNonEmptyLine(post.copy)
    for (const fieldName of ['sourceCopy', 'sourceThreadFollowUps', 'rewrittenAt', 'bufferPostId', 'publishedAt', 'url']) post[fieldName] = null
    post.status = 'draft'
    post.metrics = {}
    ledger.posts.push(offPlanPost)
    await writeJsonFileAtomically(contentFilePath, normalizeLedger(ledger))
    writeOutput(offPlanPost.id)
  })
}

function applySetting(post, { path, value }) {
  const pathParts = path.split('.')
  if (pathParts[0] !== 'metrics') {
    post[path] = value
    return
  }
  if (pathParts.length === 2) {
    post.metrics[pathParts[1]] = value
    return
  }
  const [, windowName, metricName] = pathParts
  if (!post.metrics[windowName]) post.metrics[windowName] = {}
  post.metrics[windowName][metricName] = value
}

async function setPost(argumentsToParse, contentFilePath, now, readStandardInput) {
  const [postId, ...assignments] = argumentsToParse
  if (!postId || assignments.length === 0) throw new Error('Post id and settings are required')
  const usesStandardInput = assignments.includes('--stdin')
  if (usesStandardInput) parseFlags(assignments, new Set(['--stdin']))
  const settings = usesStandardInput ? await readTextSettings(readStandardInput) : assignments.map(parseSetting)
  rejectChatShorthand(settings)
  return withJsonFileLock(contentFilePath, async () => {
    const ledger = await readLedger(contentFilePath)
    const post = findPost(ledger, postId)
    const isRewrite = settings.some(({ path, value }) => (path === 'copy' || path === 'threadFollowUps') && value !== post[path])
    const marksRewritten = isRewrite || settings.some(({ path }) => path === 'rewrittenAt')
    if (marksRewritten && post.sourceCopy === null && post.rewrittenAt === null) {
      post.sourceCopy = post.copy
      post.sourceThreadFollowUps = post.threadFollowUps
    }
    settings.forEach((setting) => applySetting(post, setting))
    if (isRewrite) post.rewrittenAt = now.toISOString()
    if (settings.some(({ path, value }) => path === 'status' && value === 'published') && !post.publishedAt) post.publishedAt = now.toISOString()
    await writeJsonFileAtomically(contentFilePath, ledger)
  })
}

function listDueMetrics(argumentsToParse, ledger, now, writeOutput) {
  const flags = parseFlags(argumentsToParse, new Set(['--json']))
  const dueWindows = ledger.posts.filter((post) => !post.offPlan && post.status === 'published' && post.publishedAt).flatMap((post) => metricWindows
    .filter(({ name, ageMs }) => now.getTime() >= Date.parse(post.publishedAt) + ageMs && !Object.hasOwn(post.metrics[name] || {}, 'impressions'))
    .map(({ name }) => ({ ...post, window: name })))
  if (flags.has('--json')) writeOutput(JSON.stringify(dueWindows))
  if (!flags.has('--json')) dueWindows.forEach((post) => writeOutput(`${post.id}  ${post.platform}  ${post.window}  published ${formatLocalTimestamp(post.publishedAt, ledger.timeZone)}`))
  return dueWindows.length > 0 ? 0 : nothingToDoExitCode
}

function summarizePlatform(posts, platform) {
  const platformPosts = posts.filter((post) => !post.offPlan && post.platform === platform)
  const impressions = platformPosts.filter((post) => Object.hasOwn(post.metrics['7d'] || {}, 'impressions'))
    .map((post) => post.metrics['7d'].impressions).sort((firstCount, secondCount) => firstCount - secondCount)
  const middleIndex = Math.floor(impressions.length / 2)
  const median = impressions.length % 2 === 0 ? (impressions[middleIndex - 1] + impressions[middleIndex]) / 2 : impressions[middleIndex]
  return { publishedCount: platformPosts.filter((post) => post.status === 'published').length, matureCount: impressions.length, median: impressions.length >= 8 ? median : null }
}

function formatMedian(summary) {
  if (summary.median === null) return `Median needs 8 mature posts (${summary.matureCount} so far)`
  return `Median 7-day impressions: ${summary.median} (${summary.matureCount} mature posts)`
}

function appendMarkdownPostTable(lines, title, posts) {
  lines.push('', `## ${title}`, '', '| ID | Date | Status | 7d impressions | Reactions | Comments | Reposts | Saves | Sends | Follows | Useful conversations |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const post of posts) {
    const metrics = post.metrics['7d'] || {}
    const cells = [post.id, post.plannedDate, post.status, ...['impressions', 'reactions', 'comments', 'reposts', 'saves', 'sends', 'follows', 'usefulConversations'].map((name) => metrics[name] ?? '')]
    lines.push(`| ${cells.join(' | ')} |`)
  }
}

function formatMarkdownScoreboard(ledger, summaries) {
  const baseline = ledger.baseline
  const lines = ['# Content scoreboard', '', `Baseline (${baseline.windowStart} through ${baseline.windowEnd}): ${baseline.linkedInImpressions} LinkedIn impressions; ${baseline.linkedInMembersReached} members reached; ${baseline.linkedInEngagements} engagements; ${baseline.linkedInFollowers} followers; ${baseline.grossNewLinkedInFollows} gross new follows.`]
  for (const platform of platforms) {
    appendMarkdownPostTable(lines, platform, ledger.posts.filter((post) => !post.offPlan && post.platform === platform && post.status !== 'draft'))
    lines.push('', formatMedian(summaries[platform]))
  }
  const offPlanPosts = ledger.posts.filter((post) => post.offPlan && post.status !== 'draft')
  if (offPlanPosts.length > 0) appendMarkdownPostTable(lines, 'Off-plan', offPlanPosts)
  return lines.join('\n')
}

function showScoreboard(argumentsToParse, ledger, writeOutput) {
  const flags = parseFlags(argumentsToParse, new Set(['--json', '--markdown']))
  if (flags.size > 1) throw new Error('Invalid command options')
  const summaries = Object.fromEntries(platforms.map((platform) => [platform, summarizePlatform(ledger.posts, platform)]))
  if (flags.has('--json')) {
    writeOutput(JSON.stringify({ baseline: ledger.baseline, ...summaries }))
    return
  }
  if (flags.has('--markdown')) {
    writeOutput(formatMarkdownScoreboard(ledger, summaries))
    return
  }
  platforms.forEach((platform) => writeOutput(`${platform}  ${summaries[platform].publishedCount} published  ${formatMedian(summaries[platform])}`))
}

async function readPruneFileStatus(filePath) {
  try {
    return await lstat(filePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return null
  }
}

async function pruneDirectory(directoryPath, contentDirectory, shouldRemoveFile, isRecursive, writeOutput) {
  const directoryStatus = await readPruneFileStatus(directoryPath)
  if (!directoryStatus?.isDirectory()) return 0
  let removedFileCount = 0
  for (const fileName of await readdir(directoryPath)) {
    const filePath = join(directoryPath, fileName)
    const fileStatus = await readPruneFileStatus(filePath)
    if (!fileStatus || fileStatus.isSymbolicLink()) continue
    if (fileStatus.isDirectory()) {
      if (!isRecursive) continue
      removedFileCount += await pruneDirectory(filePath, contentDirectory, shouldRemoveFile, isRecursive, writeOutput)
      if ((await readdir(filePath)).length === 0) await rmdir(filePath)
      continue
    }
    if (!fileStatus.isFile() || !shouldRemoveFile(fileName, fileStatus)) continue
    await unlink(filePath)
    writeOutput(`prune: removed ${relative(contentDirectory, filePath)}`)
    removedFileCount += 1
  }
  return removedFileCount
}

async function pruneContent(argumentsToParse, contentFilePath, now, writeOutput) {
  if (argumentsToParse.length !== 0) throw new Error('Invalid command options')
  const ledger = await readLedger(contentFilePath)
  const contentDirectory = dirname(contentFilePath)
  const expiredPostIds = new Set(ledger.posts.filter((post) => post.status === 'published' && post.publishedAt && Date.parse(post.publishedAt) <= now.getTime() - 7 * 86_400_000).map((post) => post.id))
  let removedFileCount = await pruneDirectory(join(contentDirectory, 'assets'), contentDirectory, (fileName) => expiredPostIds.has(fileName.split('.')[0]), false, writeOutput)
  const socialDirectory = join(contentDirectory, 'social')
  const socialDirectoryStatus = await readPruneFileStatus(socialDirectory)
  if (socialDirectoryStatus?.isDirectory()) {
    removedFileCount += await pruneDirectory(join(socialDirectory, 'out'), contentDirectory, (fileName, fileStatus) => fileStatus.mtimeMs <= now.getTime() - 30 * 86_400_000, true, writeOutput)
  }
  return removedFileCount > 0 ? 0 : nothingToDoExitCode
}

export async function runContentCommand(commandArguments, { contentFilePath = getContentFilePath(), now = new Date(), writeOutput = console.log, writeError = console.error, readStandardInput = readProcessStandardInput } = {}) {
  const [command, ...argumentsToParse] = commandArguments
  if (!['init', 'set', 'add', 'detach', 'prune', 'today', 'week', 'show', 'due-metrics', 'scoreboard'].includes(command)) throw new Error('Unknown command')
  if (command === 'add') return addPost(argumentsToParse, contentFilePath, now, readStandardInput, writeOutput)
  if (command === 'detach') return detachPost(argumentsToParse, contentFilePath, now, writeOutput)
  if (command === 'init') return initializeLedger(argumentsToParse, contentFilePath, writeError, readStandardInput)
  if (command === 'set') return setPost(argumentsToParse, contentFilePath, now, readStandardInput)
  if (command === 'prune') return pruneContent(argumentsToParse, contentFilePath, now, writeOutput)
  const ledger = await readLedger(contentFilePath)
  if (command === 'today' || command === 'week') return listScheduledPosts(command, argumentsToParse, ledger, now, writeOutput)
  if (command === 'show') return showPost(argumentsToParse, ledger, writeOutput)
  if (command === 'due-metrics') return listDueMetrics(argumentsToParse, ledger, now, writeOutput)
  return showScoreboard(argumentsToParse, ledger, writeOutput)
}

if (isMainModule(import.meta.url)) {
  runCommandLine(async (commandArguments) => {
    try {
      return await runContentCommand(commandArguments)
    } catch (error) {
      if (!error.message.startsWith('Content plan not found:')) throw error
      console.error(error.message)
      return unreadableStateExitCode
    }
  })
}
