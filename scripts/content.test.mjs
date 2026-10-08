import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { addUsageExitCode, nothingToDoExitCode, unreadableStateExitCode } from './command-line.mjs'
import { getContentFilePath, getMissingReadiness, getScheduledAt, runContentCommand } from './content.mjs'
import { withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { readJsonFile } from './json-file.mjs'
import { captureTestCommand } from './process-test-helpers.mjs'

const scriptPath = new URL('./content.mjs', import.meta.url)
const fixedNow = new Date('2026-10-14T03:00:00.000Z')

function createPost(overrides = {}) {
  return {
    id: 'L01', platform: 'linkedin', plannedDate: '2026-10-13', slot: '09:15',
    pillar: 'Agent operations', openingLine: 'An AI parser can get...', copy: 'Verified copy',
    format: 'Annotated image', assetBrief: 'An annotated diagram', altText: 'Diagram',
    followUp: 'Reply to comments', evidenceToCheck: 'Source', factsVerified: true,
    assetReady: 'not-needed', status: 'draft', experiment: 'Time A/B', ...overrides,
  }
}

function createLedger(posts = [createPost()], overrides = {}) {
  return {
    timeZone: 'America/Denver',
    baseline: { windowStart: '2026-10-02', windowEnd: '2026-10-08', linkedInImpressions: 3776, linkedInMembersReached: 1825, linkedInEngagements: 65, linkedInFollowers: 193, grossNewLinkedInFollows: 15 },
    playbook: [{ area: 'Voice', decision: 'Use evidence', howToUse: 'Check sources', evidence: 'Baseline' }],
    posts, ...overrides,
  }
}

async function withTemporaryLedger(testFunction) {
  return withTemporaryDirectory('glissa-content-', async (temporaryDirectory) => {
    await testFunction(join(temporaryDirectory, 'content', 'plan.json'))
  })
}

async function collectContentCommandOutput(contentFilePath, commandArguments, standardInputText = '', now = fixedNow) {
  const outputLines = []
  const errorLines = []
  const exitCode = await runContentCommand(commandArguments, {
    contentFilePath, now,
    writeOutput: (line) => outputLines.push(line),
    writeError: (line) => errorLines.push(line),
    readStandardInput: async () => standardInputText,
  })
  return { outputLines, errorLines, exitCode }
}

async function initializeLedger(contentFilePath, ledger = createLedger()) {
  return collectContentCommandOutput(contentFilePath, ['init', '--stdin'], JSON.stringify(ledger))
}

async function readPost(contentFilePath, postId = 'L01') {
  return (await readJsonFile(contentFilePath)).posts.find((post) => post.id === postId)
}

function readOutputJson(commandOutput) {
  return JSON.parse(commandOutput.outputLines[0])
}

test('content path uses the environment override or the repository default', () => {
  assert.equal(getContentFilePath({ GLISSA_CONTENT_FILE: '/tmp/custom-plan.json' }), '/tmp/custom-plan.json')
  assert.match(getContentFilePath({}), /\/content\/plan\.json$/)
})

test('init validates the ledger, supplies defaults, creates the directory, and refuses overwrite', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    const ledger = createLedger()
    delete ledger.timeZone
    await initializeLedger(contentFilePath, ledger)
    const storedLedger = await readJsonFile(contentFilePath)
    assert.equal(storedLedger.timeZone, 'America/Denver')
    for (const fieldName of ['url', 'bufferPostId', 'publishedAt', 'fallback', 'threadFollowUps']) assert.equal(storedLedger.posts[0][fieldName], null)
    assert.deepEqual(storedLedger.posts[0].metrics, {})
    const originalContents = await readFile(contentFilePath, 'utf8')
    await assert.rejects(initializeLedger(contentFilePath, createLedger([])), /Content plan already exists/)
    assert.equal(await readFile(contentFilePath, 'utf8'), originalContents)
  })
})

const invalidPostCases = [
  ['bad id', { id: 'L1' }, /Invalid post id/],
  ['platform mismatch', { platform: 'x' }, /Invalid platform/],
  ['X platform mismatch', { id: 'X01' }, /Invalid platform/],
  ['bad slot', { slot: '24:00' }, /Invalid slot/],
  ['bad slot minutes', { slot: '09:60' }, /Invalid slot/],
  ['bad calendar date', { plannedDate: '2026-02-30' }, /Invalid plannedDate/],
  ['bad status', { status: 'pending' }, /Invalid post status/],
  ['bad asset readiness', { assetReady: true }, /Invalid assetReady/],
  ['bad facts verification', { factsVerified: 'true' }, /Invalid factsVerified/],
  ['bad text field', { copy: [] }, /string or null: copy/],
  ['bad optional text field', { threadFollowUps: 3 }, /string or null: threadFollowUps/],
  ['bad metrics object', { metrics: [] }, /metrics must be an object/],
  ['bad metrics window', { metrics: { '7d': 3 } }, /Invalid metrics window/],
  ['bad publication timestamp', { publishedAt: 'tomorrow' }, /Invalid publishedAt/],
]

for (const [caseName, overrides, expectedError] of invalidPostCases) {
  test(`init rejects ${caseName} without creating a ledger`, async () => {
    await withTemporaryLedger(async (contentFilePath) => {
      await assert.rejects(initializeLedger(contentFilePath, createLedger([createPost(overrides)])), expectedError)
      await assert.rejects(readFile(contentFilePath), { code: 'ENOENT' })
    })
  })
}

test('init rejects duplicate ids, invalid time zones, and invalid ledger metadata', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await assert.rejects(initializeLedger(contentFilePath, createLedger([createPost(), createPost()])), /Duplicate post id/)
    for (const timeZone of ['Not/AZone', '+01:00', null, '']) {
      await assert.rejects(initializeLedger(contentFilePath, createLedger([], { timeZone })))
    }
    await assert.rejects(initializeLedger(contentFilePath, createLedger([], { baseline: {} })), /Invalid baseline/)
    await assert.rejects(initializeLedger(contentFilePath, createLedger([], { playbook: [{}] })), /Missing playbook entry field/)
    await assert.rejects(initializeLedger(contentFilePath, createLedger([], { posts: {} })), /posts array/)
    await assert.rejects(collectContentCommandOutput(contentFilePath, ['init', '--stdin'], '[]'), /JSON object/)
    await assert.rejects(collectContentCommandOutput(contentFilePath, ['init', '--stdin'], '{'), /JSON/)
    const missingFlagOutput = await collectContentCommandOutput(contentFilePath, ['init'])
    assert.equal(missingFlagOutput.exitCode, addUsageExitCode)
    assert.match(missingFlagOutput.errorLines[0], /usage: content.mjs init --stdin/)
  })
})

test('concurrent init commands create only one ledger', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    const initializationAttempts = await Promise.allSettled([
      initializeLedger(contentFilePath),
      initializeLedger(contentFilePath, createLedger([createPost({ id: 'X01', platform: 'x' })])),
    ])
    assert.equal(initializationAttempts.filter((attempt) => attempt.status === 'fulfilled').length, 1)
    assert.equal(initializationAttempts.filter((attempt) => attempt.status === 'rejected').length, 1)
    assert.equal((await readJsonFile(contentFilePath)).posts.length, 1)
  })
})

test('scheduled instants follow Denver DST before and after Nov 1', () => {
  assert.equal(getScheduledAt(createPost({ plannedDate: '2026-10-30', slot: '15:30' }), 'America/Denver'), '2026-10-30T21:30:00.000Z')
  assert.equal(getScheduledAt(createPost({ plannedDate: '2026-11-02', slot: '15:30' }), 'America/Denver'), '2026-11-02T22:30:00.000Z')
  assert.equal(getScheduledAt(createPost({ plannedDate: '2026-11-01', slot: '01:30' }), 'America/Denver'), '2026-11-01T07:30:00.000Z')
  assert.equal(getScheduledAt(createPost({ slot: '00:00' }), 'Asia/Kathmandu'), '2026-10-12T18:15:00.000Z')
  assert.throws(() => getScheduledAt(createPost({ plannedDate: '2026-03-08', slot: '02:30' }), 'America/Denver'), /Nonexistent scheduled local time/)
})

test('readiness reports facts, asset, and placeholders in order', () => {
  assert.deepEqual(getMissingReadiness(createPost()), [])
  assert.deepEqual(getMissingReadiness(createPost({ factsVerified: false })), ['facts'])
  assert.deepEqual(getMissingReadiness(createPost({ assetReady: 'no' })), ['asset'])
  assert.deepEqual(getMissingReadiness(createPost({ copy: 'Add [source]' })), ['placeholders'])
  assert.deepEqual(getMissingReadiness(createPost({ threadFollowUps: '[reply]' })), ['placeholders'])
  assert.deepEqual(getMissingReadiness(createPost({ factsVerified: false, assetReady: 'no', copy: '[source]', threadFollowUps: '[reply]' })), ['facts', 'asset', 'placeholders'])
  assert.deepEqual(getMissingReadiness(createPost({ copy: null, threadFollowUps: '[] [line\nbreak]' })), [])
})

test('today and week use the Denver date near UTC midnight and sort by schedule', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath, createLedger([
      createPost({ id: 'L05', plannedDate: '2026-10-20' }),
      createPost({ id: 'L04', plannedDate: '2026-10-19' }),
      createPost({ id: 'L03', plannedDate: '2026-10-12' }),
      createPost({ id: 'L02', slot: '15:30' }),
      createPost(),
    ]))
    const todayOutput = await collectContentCommandOutput(contentFilePath, ['today', '--json'])
    assert.equal(todayOutput.exitCode, 0)
    assert.deepEqual(readOutputJson(todayOutput).map((post) => post.id), ['L01', 'L02'])
    assert.equal(readOutputJson(todayOutput)[0].scheduledAt, '2026-10-13T15:15:00.000Z')
    assert.deepEqual(readOutputJson(todayOutput)[0].missing, [])
    const weekOutput = await collectContentCommandOutput(contentFilePath, ['week', '--json'])
    assert.deepEqual(readOutputJson(weekOutput).map((post) => post.id), ['L01', 'L02', 'L04'])
    const textOutput = await collectContentCommandOutput(contentFilePath, ['today'])
    assert.equal(textOutput.outputLines[0], 'L01  linkedin  Tue Oct 13 9:15am  draft  ready  An AI parser can get...')
    const weekTextOutput = await collectContentCommandOutput(contentFilePath, ['week'])
    assert.equal(weekTextOutput.outputLines.length, 3)
  })
})

test('text output truncates opening lines and shows missing readiness', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath, createLedger([createPost({ openingLine: 'a'.repeat(80), factsVerified: false, assetReady: 'no' })]))
    const todayOutput = await collectContentCommandOutput(contentFilePath, ['today'])
    assert.equal(todayOutput.outputLines[0], `L01  linkedin  Tue Oct 13 9:15am  draft  missing facts,asset  ${'a'.repeat(57)}...`)
    const showOutput = await collectContentCommandOutput(contentFilePath, ['show', 'L01'])
    assert.deepEqual(readOutputJson(showOutput).missing, ['facts', 'asset'])
    assert.match(showOutput.outputLines[0], /\n  "id": "L01"/)
    await assert.rejects(collectContentCommandOutput(contentFilePath, ['show', 'L99']), /Unknown post id: L99/)
  })
})

test('empty today, week, and due-metrics return nothing-to-do', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath, createLedger([]))
    for (const command of ['today', 'week', 'due-metrics']) {
      const commandOutput = await collectContentCommandOutput(contentFilePath, [command, '--json'])
      assert.equal(commandOutput.exitCode, nothingToDoExitCode)
      assert.deepEqual(readOutputJson(commandOutput), [])
      assert.deepEqual((await collectContentCommandOutput(contentFilePath, [command])).outputLines, [])
    }
  })
})

test('set updates every allowed scalar and metric path and normalizes publication time', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', 'status=queued', 'assetReady=yes', 'factsVerified=false', 'url=https://example.com/post?a=b', 'bufferPostId=buffer-1', 'publishedAt=2026-10-13T09:15:00-06:00', 'metrics.amplified=yes'])
    const metricNames = ['impressions', 'membersReached', 'reactions', 'comments', 'reposts', 'saves', 'sends', 'profileViews', 'follows', 'linkClicks', 'usefulConversations']
    for (const windowName of ['72h', '7d']) {
      await collectContentCommandOutput(contentFilePath, ['set', 'L01', ...metricNames.map((name, index) => `metrics.${windowName}.${name}=${index}`)])
    }
    const post = await readPost(contentFilePath)
    assert.equal(post.status, 'queued')
    assert.equal(post.assetReady, 'yes')
    assert.equal(post.factsVerified, false)
    assert.equal(post.url, 'https://example.com/post?a=b')
    assert.equal(post.bufferPostId, 'buffer-1')
    assert.equal(post.publishedAt, '2026-10-13T15:15:00.000Z')
    assert.equal(post.metrics.amplified, 'yes')
    for (const windowName of ['72h', '7d']) assert.deepEqual(post.metrics[windowName], Object.fromEntries(metricNames.map((name, index) => [name, index])))
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', 'status=skipped', 'assetReady=not-needed', 'factsVerified=true', 'metrics.amplified=no'])
    assert.equal((await readPost(contentFilePath)).metrics.amplified, 'no')
  })
})

test('set rejects all invalid assignments before any write', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    const originalContents = await readFile(contentFilePath, 'utf8')
    const badAssignments = ['id=X01', 'copy=new', 'status=bad', 'assetReady=maybe', 'factsVerified=1', 'url=http://example.com', 'bufferPostId=', 'publishedAt=+1d', 'publishedAt=noon', 'metrics.7d.unknown=1', 'metrics.24h.impressions=2', 'metrics.7d.impressions=-1', 'metrics.7d.impressions=1.5', 'metrics.7d.impressions=9007199254740992', 'metrics.amplified=maybe', 'metrics.__proto__.impressions=1', 'no-equals']
    for (const assignment of badAssignments) {
      await assert.rejects(collectContentCommandOutput(contentFilePath, ['set', 'L01', 'status=published', assignment]), /Invalid setting/)
      assert.equal(await readFile(contentFilePath, 'utf8'), originalContents)
    }
    await assert.rejects(collectContentCommandOutput(contentFilePath, ['set', 'L99', 'status=queued']), /Unknown post id: L99/)
    assert.equal(await readFile(contentFilePath, 'utf8'), originalContents)
  })
})

test('publishing stamps now, preserves an existing timestamp, and accepts a timestamp in the same call', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath, createLedger([createPost(), createPost({ id: 'L02' })]))
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', 'status=published'])
    assert.equal((await readPost(contentFilePath)).publishedAt, fixedNow.toISOString())
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', 'status=published'], '', new Date('2026-10-15T00:00:00Z'))
    assert.equal((await readPost(contentFilePath)).publishedAt, fixedNow.toISOString())
    await collectContentCommandOutput(contentFilePath, ['set', 'L02', 'status=published', 'publishedAt=2026-10-09T21:30Z'])
    assert.equal((await readPost(contentFilePath, 'L02')).publishedAt, '2026-10-09T21:30:00.000Z')
  })
})

test('set stdin accepts only the four nullable text fields and rejects invalid input atomically', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    const fields = { copy: 'Updated copy', threadFollowUps: '[reply]', openingLine: null, altText: '' }
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', '--stdin'], JSON.stringify(fields))
    const post = await readPost(contentFilePath)
    for (const [name, value] of Object.entries(fields)) assert.equal(post[name], value)
    const originalContents = await readFile(contentFilePath, 'utf8')
    for (const inputText of ['{"copy":"changed","status":"published"}', '{"copy":3}', '[]', '{', '{"__proto__":null}']) {
      await assert.rejects(collectContentCommandOutput(contentFilePath, ['set', 'L01', '--stdin'], inputText))
      assert.equal(await readFile(contentFilePath, 'utf8'), originalContents)
    }
    await assert.rejects(collectContentCommandOutput(contentFilePath, ['set', 'L01', '--stdin', 'status=published'], '{}'), /Invalid command options/)
  })
})

test('concurrent set commands preserve independent updates under the ledger lock', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    await Promise.all([
      collectContentCommandOutput(contentFilePath, ['set', 'L01', 'metrics.72h.impressions=10']),
      collectContentCommandOutput(contentFilePath, ['set', 'L01', 'metrics.7d.impressions=20']),
    ])
    assert.deepEqual((await readPost(contentFilePath)).metrics, { '72h': { impressions: 10 }, '7d': { impressions: 20 } })
  })
})

test('due-metrics includes each missing window at its exact threshold and respects zero impressions', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    const publishedAt = '2026-10-09T21:30:00.000Z'
    await initializeLedger(contentFilePath, createLedger([
      createPost({ status: 'published', publishedAt }),
      createPost({ id: 'L02', status: 'published', publishedAt, metrics: { '72h': { impressions: 0 }, '7d': { impressions: 0 } } }),
      createPost({ id: 'L03', status: 'queued', publishedAt }),
      createPost({ id: 'L04', status: 'published' }),
    ]))
    const beforeThreshold = await collectContentCommandOutput(contentFilePath, ['due-metrics', '--json'], '', new Date('2026-10-12T21:29:59.999Z'))
    assert.equal(beforeThreshold.exitCode, nothingToDoExitCode)
    const firstWindow = await collectContentCommandOutput(contentFilePath, ['due-metrics', '--json'], '', new Date('2026-10-12T21:30Z'))
    assert.deepEqual(readOutputJson(firstWindow).map(({ id, window }) => ({ id, window })), [{ id: 'L01', window: '72h' }])
    const bothWindows = await collectContentCommandOutput(contentFilePath, ['due-metrics', '--json'], '', new Date('2026-10-16T21:30Z'))
    assert.deepEqual(readOutputJson(bothWindows).map(({ id, window }) => ({ id, window })), [{ id: 'L01', window: '72h' }, { id: 'L01', window: '7d' }])
    const textOutput = await collectContentCommandOutput(contentFilePath, ['due-metrics'], '', new Date('2026-10-16T21:30Z'))
    assert.equal(textOutput.outputLines[1], 'L01  linkedin  7d  published Fri Oct 9 3:30pm')
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', 'metrics.72h.impressions=0'])
    const remainingWindows = await collectContentCommandOutput(contentFilePath, ['due-metrics', '--json'], '', new Date('2026-10-16T21:30Z'))
    assert.deepEqual(readOutputJson(remainingWindows).map((post) => post.window), ['7d'])
  })
})

test('scoreboard suppresses medians below eight and computes even and odd medians at maturity', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    const posts = Array.from({ length: 7 }, (_, index) => createPost({ id: `L0${index + 1}`, status: 'published', metrics: { '7d': { impressions: index * 10 } } }))
    posts.push(createPost({ id: 'L08', status: 'published' }), createPost({ id: 'L09', status: 'published' }), createPost({ id: 'X01', platform: 'x', status: 'queued' }))
    await initializeLedger(contentFilePath, createLedger(posts))
    const initialScoreboard = readOutputJson(await collectContentCommandOutput(contentFilePath, ['scoreboard', '--json']))
    assert.deepEqual(initialScoreboard.linkedin, { publishedCount: 9, matureCount: 7, median: null })
    assert.deepEqual(initialScoreboard.x, { publishedCount: 0, matureCount: 0, median: null })
    assert.deepEqual(initialScoreboard.baseline, createLedger().baseline)
    await collectContentCommandOutput(contentFilePath, ['set', 'L08', 'metrics.7d.impressions=70'])
    assert.deepEqual(readOutputJson(await collectContentCommandOutput(contentFilePath, ['scoreboard', '--json'])).linkedin, { publishedCount: 9, matureCount: 8, median: 35 })
    await collectContentCommandOutput(contentFilePath, ['set', 'L09', 'metrics.7d.impressions=80'])
    assert.equal(readOutputJson(await collectContentCommandOutput(contentFilePath, ['scoreboard', '--json'])).linkedin.median, 40)
    const textOutput = await collectContentCommandOutput(contentFilePath, ['scoreboard'])
    assert.deepEqual(textOutput.outputLines, ['linkedin  9 published  Median 7-day impressions: 40 (9 mature posts)', 'x  0 published  Median needs 8 mature posts (0 so far)'])
    assert.match((await collectContentCommandOutput(contentFilePath, ['scoreboard', '--markdown'])).outputLines[0], /Median 7-day impressions: 40 \(9 mature posts\)/)
  })
})

test('markdown scoreboard includes every non-draft post and keeps unknown metrics blank and known zeros visible', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath, createLedger([
      createPost(),
      createPost({ id: 'L02', status: 'published', metrics: { '7d': { impressions: 0, comments: 0 } } }),
      createPost({ id: 'L03', status: 'skipped' }),
      createPost({ id: 'X01', platform: 'x', status: 'queued' }),
    ]))
    const markdown = (await collectContentCommandOutput(contentFilePath, ['scoreboard', '--markdown'])).outputLines[0]
    assert.match(markdown, /^# Content scoreboard\n/)
    assert.match(markdown, /Baseline \(2026-10-02 through 2026-10-08\): 3776 LinkedIn impressions/)
    assert.match(markdown, /\| ID \| Date \| Status \| 7d impressions \| Reactions \| Comments \| Reposts \| Saves \| Sends \| Follows \| Useful conversations \|/)
    assert.ok(markdown.includes('| L02 | 2026-10-13 | published | 0 |  | 0 |  |  |  |  |  |'))
    assert.ok(markdown.includes('| L03 | 2026-10-13 | skipped |  |  |  |  |  |  |  |  |'))
    assert.ok(markdown.includes('| X01 | 2026-10-13 | queued |  |  |  |  |  |  |  |  |'))
    assert.ok(!markdown.includes('| L01 |'))
    assert.match(markdown, /Median needs 8 mature posts \(1 so far\)/)
  })
})

test('commands reject unknown commands, invalid flags, and missing ids', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    await assert.rejects(collectContentCommandOutput(contentFilePath, ['unknown']), /^Error: Unknown command$/)
    for (const command of ['today', 'week', 'due-metrics', 'scoreboard']) {
      await assert.rejects(collectContentCommandOutput(contentFilePath, [command, '--bad']), /Invalid command options/)
      await assert.rejects(collectContentCommandOutput(contentFilePath, [command, '--json', '--json']), /Invalid command options/)
    }
    await assert.rejects(collectContentCommandOutput(contentFilePath, ['scoreboard', '--json', '--markdown']), /Invalid command options/)
    await assert.rejects(collectContentCommandOutput(contentFilePath, ['show']), /Post id is required/)
    await assert.rejects(collectContentCommandOutput(contentFilePath, ['set', 'L01']), /Post id and settings are required/)
  })
})

test('CLI reads GLISSA_CONTENT_FILE, initializes from stdin, shows posts, and reports a missing ledger', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    const options = { env: { ...process.env, GLISSA_CONTENT_FILE: contentFilePath } }
    const missingOutput = await captureTestCommand(process.execPath, [scriptPath.pathname, 'today'], options)
    assert.equal(missingOutput.exitCode, unreadableStateExitCode)
    assert.equal(missingOutput.stderr.trim(), `Content plan not found: ${contentFilePath}`)
    const initOutput = await captureTestCommand(process.execPath, [scriptPath.pathname, 'init', '--stdin'], options, JSON.stringify(createLedger()))
    assert.equal(initOutput.exitCode, 0)
    const showOutput = await captureTestCommand(process.execPath, [scriptPath.pathname, 'show', 'L01'], options)
    assert.equal(showOutput.exitCode, 0)
    assert.equal(JSON.parse(showOutput.stdout).scheduledAt, '2026-10-13T15:15:00.000Z')
    const unknownIdOutput = await captureTestCommand(process.execPath, [scriptPath.pathname, 'show', 'L99'], options)
    assert.equal(unknownIdOutput.exitCode, 1)
    assert.equal(unknownIdOutput.stderr.trim(), 'Unknown post id: L99')
    await writeFile(contentFilePath, '{')
    await assert.rejects(collectContentCommandOutput(contentFilePath, ['today']), /JSON/)
  })
})
