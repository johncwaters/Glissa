import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, readdir, symlink, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

test('legacy stored plans load with offPlan defaulting to false', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    await writeFile(contentFilePath, JSON.stringify(createLedger()))
    const post = readOutputJson(await collectContentCommandOutput(contentFilePath, ['show', 'L01']))
    assert.equal(post.offPlan, false)
  })
})

test('loading rejects non-boolean offPlan and id mismatches', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    for (const overrides of [
      { offPlan: null }, { offPlan: 'false' }, { offPlan: true },
      { id: 'LO01', offPlan: false }, { id: 'LO01' },
      { id: 'X01', platform: 'x', offPlan: true },
      { id: 'XO01', platform: 'x', offPlan: false },
      { id: 'LO01', platform: 'x', offPlan: true },
    ]) {
      await writeFile(contentFilePath, JSON.stringify(createLedger([createPost(overrides)])))
      await assert.rejects(collectContentCommandOutput(contentFilePath, ['today']), /Invalid offPlan|Invalid platform/)
    }
  })
})

test('add creates sequential platform ids and the documented off-plan fields', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    const copy = '\n\nJohn wrote this.\nA second line.'
    const firstOutput = await collectContentCommandOutput(contentFilePath, ['add', 'linkedin', '2026-10-13', '11:05', '--stdin'], JSON.stringify({ copy }))
    assert.deepEqual(firstOutput.outputLines, ['LO01'])
    assert.deepEqual(await readPost(contentFilePath, 'LO01'), {
      id: 'LO01', offPlan: true, platform: 'linkedin', plannedDate: '2026-10-13', slot: '11:05',
      pillar: 'Off-plan', copy, openingLine: 'John wrote this.', threadFollowUps: null, altText: null,
      format: null, assetBrief: null, followUp: null, evidenceToCheck: null, experiment: null,
      fallback: null, factsVerified: true, assetReady: 'not-needed', status: 'draft',
      rewrittenAt: fixedNow.toISOString(), sourceCopy: null, sourceThreadFollowUps: null,
      bufferPostId: null, publishedAt: null, url: null, metrics: {},
    })
    const optionalFields = { copy: 'Another post', openingLine: 'Custom opening', threadFollowUps: 'Second post', altText: 'Description' }
    assert.deepEqual((await collectContentCommandOutput(contentFilePath, ['add', 'linkedin', '2026-10-14', '12:00', '--stdin'], JSON.stringify(optionalFields))).outputLines, ['LO02'])
    for (const [fieldName, value] of Object.entries(optionalFields)) assert.equal((await readPost(contentFilePath, 'LO02'))[fieldName], value)
    for (const id of ['XO01', 'XO02']) {
      assert.deepEqual((await collectContentCommandOutput(contentFilePath, ['add', 'x', '2026-10-13', '13:00', '--stdin'], JSON.stringify({ copy: 'An X post', openingLine: null, threadFollowUps: null, altText: null }))).outputLines, [id])
      assert.equal((await readPost(contentFilePath, id)).platform, 'x')
      assert.equal((await readPost(contentFilePath, id)).openingLine, 'An X post')
    }
    assert.equal((await readPost(contentFilePath)).copy, 'Verified copy')
    for (const command of ['today', 'week']) {
      const ids = readOutputJson(await collectContentCommandOutput(contentFilePath, [command, '--json'])).map((post) => post.id)
      assert.ok(ids.includes('LO01'))
      assert.ok(ids.includes('XO01'))
    }
  })
})

test('add fills the next free id and concurrent additions keep distinct ids', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath, createLedger([createPost({ id: 'LO02', offPlan: true })]))
    const additions = await Promise.all([
      collectContentCommandOutput(contentFilePath, ['add', 'linkedin', '2026-10-13', '12:00', '--stdin'], JSON.stringify({ copy: 'First addition' })),
      collectContentCommandOutput(contentFilePath, ['add', 'linkedin', '2026-10-13', '13:00', '--stdin'], JSON.stringify({ copy: 'Second addition' })),
    ])
    assert.deepEqual(additions.flatMap((addition) => addition.outputLines).sort(), ['LO01', 'LO03'])
    assert.equal((await readJsonFile(contentFilePath)).posts.length, 3)
  })
})

test('add rejects shorthand and invalid inputs without writing', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    const originalContents = await readFile(contentFilePath, 'utf8')
    const validArguments = ['add', 'linkedin', '2026-10-13', '12:00', '--stdin']
    for (const [commandArguments, input, expectedError] of [
      [['add', 'mastodon', '2026-10-13', '12:00', '--stdin'], { copy: 'Copy' }, /Invalid platform/],
      [['add', 'linkedin', '2026-02-30', '12:00', '--stdin'], { copy: 'Copy' }, /Invalid plannedDate/],
      [['add', 'linkedin', '2026-10-13', '24:00', '--stdin'], { copy: 'Copy' }, /Invalid slot/],
      [['add', 'linkedin', '2026-03-08', '02:30', '--stdin'], { copy: 'Copy' }, /Nonexistent scheduled local time/],
      [['add', 'linkedin', '2026-10-13', '12:00'], { copy: 'Copy' }, /--stdin are required/],
      [[...validArguments, '--json'], { copy: 'Copy' }, /Invalid command options/],
      [validArguments, {}, /non-empty string/],
      [validArguments, { copy: null }, /non-empty string/],
      [validArguments, { copy: ' \n ' }, /non-empty string/],
      [validArguments, { copy: 7 }, /fields must be strings/],
      [validArguments, [], /JSON object/],
      [validArguments, { copy: 'Copy', altText: 7 }, /fields must be strings/],
      [validArguments, { copy: 'Copy', status: 'published' }, /Unknown post input fields/],
      [validArguments, { copy: 'Useful lol' }, /Chat shorthand in copy: posts follow the long-form voice, not chat/],
      [validArguments, { copy: 'Copy', openingLine: 'Useful tbh' }, /Chat shorthand in openingLine: posts follow the long-form voice, not chat/],
      [validArguments, { copy: 'Copy', threadFollowUps: 'Useful imo' }, /Chat shorthand in threadFollowUps: posts follow the long-form voice, not chat/],
    ]) {
      await assert.rejects(collectContentCommandOutput(contentFilePath, commandArguments, JSON.stringify(input)), expectedError)
      assert.equal(await readFile(contentFilePath, 'utf8'), originalContents)
    }
  })
})

test('detach moves a published replacement to its local publication slot and restores the plan post', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    const metrics = { '7d': { impressions: 100, comments: 0 }, amplified: 'no' }
    const replacementFields = {
      copy: 'John wrote a replacement', openingLine: 'Replacement opening', threadFollowUps: 'Replacement thread',
      altText: 'Replacement image', bufferPostId: 'buffer-post', status: 'published',
      publishedAt: '2026-10-14T05:07:00.000Z', url: 'https://example.com/post', metrics,
      assetReady: 'yes', factsVerified: false, rewrittenAt: '2026-10-12T12:00:00.000Z',
    }
    await initializeLedger(contentFilePath, createLedger([createPost({
      ...replacementFields, sourceCopy: '\nOriginal plan opening\nOriginal body', sourceThreadFollowUps: 'Original thread',
    })]))
    assert.deepEqual((await collectContentCommandOutput(contentFilePath, ['detach', 'L01'])).outputLines, ['LO01'])
    assert.deepEqual(await readPost(contentFilePath, 'LO01'), {
      id: 'LO01', offPlan: true, platform: 'linkedin', plannedDate: '2026-10-13', slot: '23:07',
      pillar: 'Off-plan', format: null, assetBrief: null, followUp: null, evidenceToCheck: null,
      experiment: null, fallback: null, sourceCopy: null, sourceThreadFollowUps: null,
      ...replacementFields, factsVerified: true,
    })
    const restoredPost = await readPost(contentFilePath)
    assert.equal(restoredPost.copy, '\nOriginal plan opening\nOriginal body')
    assert.equal(restoredPost.threadFollowUps, 'Original thread')
    assert.equal(restoredPost.openingLine, 'Original plan opening')
    assert.equal(restoredPost.status, 'draft')
    assert.equal(restoredPost.offPlan, false)
    assert.equal(restoredPost.pillar, 'Agent operations')
    assert.equal(restoredPost.plannedDate, '2026-10-13')
    assert.equal(restoredPost.slot, '09:15')
    for (const fieldName of ['sourceCopy', 'sourceThreadFollowUps', 'rewrittenAt', 'bufferPostId', 'publishedAt', 'url']) assert.equal(restoredPost[fieldName], null)
    assert.deepEqual(restoredPost.metrics, {})
  })
})

test('detach refuses an unpublished post without a Buffer draft without writing', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath, createLedger([createPost({ id: 'X01', platform: 'x', sourceCopy: 'Original', status: 'queued' })]))
    const originalContents = await readFile(contentFilePath, 'utf8')
    await assert.rejects(collectContentCommandOutput(contentFilePath, ['detach', 'X01']), /Post is not published yet: X01/)
    assert.equal(await readFile(contentFilePath, 'utf8'), originalContents)
  })
})

test('detach refuses missing source copy, off-plan posts, and unpublished posts with a Buffer draft without writing', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath, createLedger([
      createPost(), createPost({ id: 'LO01', offPlan: true, sourceCopy: 'Source' }),
      createPost({ id: 'L02', sourceCopy: 'Source', bufferPostId: 'buffer-draft', status: 'queued' }),
    ]))
    const originalContents = await readFile(contentFilePath, 'utf8')
    for (const [commandArguments, expectedError] of [
      [['detach', 'L01'], /Post has no source copy: L01/],
      [['detach', 'LO01'], /Post is already off-plan: LO01/],
      [['detach', 'L02'], /Post is not published yet: L02/],
      [['detach'], /Post id is required/],
      [['detach', 'L01', '--json'], /Post id is required/],
    ]) {
      await assert.rejects(collectContentCommandOutput(contentFilePath, commandArguments), expectedError)
      assert.equal(await readFile(contentFilePath, 'utf8'), originalContents)
    }
  })
})

test('scoreboard and due-metrics exclude off-plan posts while markdown lists them separately', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    const publishedAt = '2026-10-01T12:00:00.000Z'
    await initializeLedger(contentFilePath, createLedger([
      ...Array.from({ length: 8 }, (_, index) => createPost({ id: `L${String(index + 1).padStart(2, '0')}`, status: 'published', publishedAt, metrics: { '7d': { impressions: (index + 1) * 10 } } })),
      createPost({ id: 'LO01', offPlan: true, status: 'published', publishedAt, metrics: { '7d': { impressions: 9999 } } }),
      createPost({ id: 'XO01', platform: 'x', offPlan: true, status: 'published', publishedAt }),
      createPost({ id: 'LO02', offPlan: true }),
      createPost({ id: 'LO03', offPlan: true, status: 'queued' }),
      createPost({ id: 'XO02', platform: 'x', offPlan: true, status: 'skipped' }),
    ]))
    const scoreboard = readOutputJson(await collectContentCommandOutput(contentFilePath, ['scoreboard', '--json']))
    assert.deepEqual(scoreboard.linkedin, { publishedCount: 8, matureCount: 8, median: 45 })
    assert.deepEqual(scoreboard.x, { publishedCount: 0, matureCount: 0, median: null })
    assert.deepEqual((await collectContentCommandOutput(contentFilePath, ['scoreboard'])).outputLines, [
      'linkedin  8 published  Median 7-day impressions: 45 (8 mature posts)',
      'x  0 published  Median needs 8 mature posts (0 so far)',
    ])
    const markdown = (await collectContentCommandOutput(contentFilePath, ['scoreboard', '--markdown'])).outputLines[0]
    const [planSections, offPlanSection] = markdown.split('## Off-plan\n')
    assert.ok(!planSections.includes('| LO'))
    assert.ok(!planSections.includes('| XO'))
    assert.match(planSections, /Median 7-day impressions: 45 \(8 mature posts\)/)
    assert.match(offPlanSection, /\| ID \| Date \| Status \| 7d impressions \| Reactions \| Comments \| Reposts \| Saves \| Sends \| Follows \| Useful conversations \|/)
    for (const id of ['LO01', 'XO01', 'LO03', 'XO02']) assert.ok(offPlanSection.includes(`| ${id} |`))
    assert.ok(!offPlanSection.includes('| LO02 |'))
    const dueMetrics = readOutputJson(await collectContentCommandOutput(contentFilePath, ['due-metrics', '--json']))
    assert.equal(dueMetrics.length, 8)
    assert.ok(dueMetrics.every((post) => !post.offPlan && post.window === '72h'))
    const dueOutput = await collectContentCommandOutput(contentFilePath, ['due-metrics'])
    assert.equal(dueOutput.outputLines.length, 8)
    assert.ok(dueOutput.outputLines.every((line) => /^L\d{2}  /.test(line)))
  })
})

test('markdown omits Off-plan when every off-plan post is a draft', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath, createLedger([createPost({ id: 'LO01', offPlan: true })]))
    assert.ok(!(await collectContentCommandOutput(contentFilePath, ['scoreboard', '--markdown'])).outputLines[0].includes('## Off-plan'))
    assert.equal((await collectContentCommandOutput(contentFilePath, ['due-metrics'])).exitCode, nothingToDoExitCode)
  })
})

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
    for (const fieldName of ['url', 'bufferPostId', 'publishedAt', 'fallback', 'threadFollowUps', 'sourceCopy', 'sourceThreadFollowUps', 'rewrittenAt']) assert.equal(storedLedger.posts[0][fieldName], null)
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
  ['bad rewrite timestamp', { rewrittenAt: 'tomorrow' }, /Invalid rewrittenAt/],
  ['bad source copy', { sourceCopy: 3 }, /string or null: sourceCopy/],
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

test('readiness flags chat shorthand in copy or thread and spares the long-form aside', () => {
  for (const copy of ['Kind of an odd way to help lol', 'Useful bug tbh.', 'Dev tools could use that imo.', 'Shipped it :)', 'Shipped it :).', 'nice ;),', 'hmm :/', 'XD', 'love it <3', 'ship it 🚀']) {
    assert.deepEqual(getMissingReadiness(createPost({ copy })), ['shorthand'], copy)
  }
  assert.deepEqual(getMissingReadiness(createPost({ threadFollowUps: 'Part 2\nidk yet' })), ['shorthand'])
  assert.deepEqual(getMissingReadiness(createPost({ fallback: 'Backup lol' })), [])
  assert.deepEqual(getMissingReadiness(createPost({ openingLine: 'Opening tbh' })), ['shorthand'])
  for (const copy of ['Only two eyes, duh.', 'The Imogen release logs it.', 'Ratio 3:1 holds.', 'See https://github.com/johncwaters/glimmervoid', 'At 9:15 (MT) it runs.', 'Note: (811 is the dig line)']) {
    assert.deepEqual(getMissingReadiness(createPost({ copy })), [], copy)
  }
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
    const badAssignments = ['id=X01', 'copy=new', 'status=bad', 'assetReady=maybe', 'factsVerified=1', 'url=http://example.com', 'bufferPostId= ', 'publishedAt=+1d', 'publishedAt=noon', 'rewrittenAt=+1d', 'rewrittenAt=noon', 'metrics.7d.unknown=1', 'metrics.24h.impressions=2', 'metrics.7d.impressions=-1', 'metrics.7d.impressions=1.5', 'metrics.7d.impressions=9007199254740992', 'metrics.amplified=maybe', 'metrics.__proto__.impressions=1', 'no-equals']
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

test('set clears a recorded Buffer post id with an empty value', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', 'bufferPostId=buffer-1'])
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', 'bufferPostId='])
    assert.equal((await readPost(contentFilePath)).bufferPostId, null)
  })
})

test('set clears the rewrite stamp with an empty value and keeps the source copy', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    const originalCopy = (await readPost(contentFilePath)).copy
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', 'rewrittenAt=2026-10-08T20:48:13.000Z'])
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', 'rewrittenAt='])
    const clearedPost = await readPost(contentFilePath)
    assert.equal(clearedPost.rewrittenAt, null)
    assert.equal(clearedPost.sourceCopy, originalCopy)
  })
})

test('set rejects chat shorthand in copy or thread without writing', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    const originalContents = await readFile(contentFilePath, 'utf8')
    await assert.rejects(collectContentCommandOutput(contentFilePath, ['set', 'L01', '--stdin'], JSON.stringify({ copy: 'Odd way to help lol' })), /Chat shorthand in copy/)
    await assert.rejects(collectContentCommandOutput(contentFilePath, ['set', 'L01', '--stdin'], JSON.stringify({ threadFollowUps: 'Part 2\nUseful tbh' })), /Chat shorthand in threadFollowUps/)
    assert.equal(await readFile(contentFilePath, 'utf8'), originalContents)
  })
})

test('first stdin copy change keeps the original copy and thread and stamps the rewrite time', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath, createLedger([createPost({ threadFollowUps: 'Part 2\nOriginal reply' })]))
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', '--stdin'], JSON.stringify({ copy: 'First rewrite', threadFollowUps: 'Part 2\nNew reply' }))
    const rewrittenPost = await readPost(contentFilePath)
    assert.equal(rewrittenPost.copy, 'First rewrite')
    assert.equal(rewrittenPost.sourceCopy, 'Verified copy')
    assert.equal(rewrittenPost.sourceThreadFollowUps, 'Part 2\nOriginal reply')
    assert.equal(rewrittenPost.rewrittenAt, fixedNow.toISOString())
    const shownPost = readOutputJson(await collectContentCommandOutput(contentFilePath, ['show', 'L01']))
    assert.equal(shownPost.sourceCopy, 'Verified copy')
    assert.equal(shownPost.rewrittenAt, fixedNow.toISOString())
  })
})

test('a later copy change keeps the first source copy and restamps the rewrite time', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', '--stdin'], JSON.stringify({ copy: 'First rewrite' }))
    const laterNow = new Date('2026-10-15T03:00:00.000Z')
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', '--stdin'], JSON.stringify({ copy: 'Second rewrite' }), laterNow)
    const post = await readPost(contentFilePath)
    assert.equal(post.copy, 'Second rewrite')
    assert.equal(post.sourceCopy, 'Verified copy')
    assert.equal(post.sourceThreadFollowUps, null)
    assert.equal(post.rewrittenAt, laterNow.toISOString())
  })
})

test('a thread-only change keeps the original copy and thread and stamps the rewrite time', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath, createLedger([createPost({ threadFollowUps: 'Part 2\nOriginal reply' })]))
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', '--stdin'], JSON.stringify({ threadFollowUps: 'Part 2\nNew reply' }))
    const rewrittenPost = await readPost(contentFilePath)
    assert.equal(rewrittenPost.sourceCopy, 'Verified copy')
    assert.equal(rewrittenPost.sourceThreadFollowUps, 'Part 2\nOriginal reply')
    assert.equal(rewrittenPost.rewrittenAt, fixedNow.toISOString())
    const laterNow = new Date('2026-10-15T03:00:00.000Z')
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', '--stdin'], JSON.stringify({ copy: 'Second rewrite' }), laterNow)
    const laterPost = await readPost(contentFilePath)
    assert.equal(laterPost.copy, 'Second rewrite')
    assert.equal(laterPost.sourceCopy, 'Verified copy')
    assert.equal(laterPost.sourceThreadFollowUps, 'Part 2\nOriginal reply')
    assert.equal(laterPost.rewrittenAt, laterNow.toISOString())
  })
})

test('stdin edits that leave copy unchanged record no rewrite', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', '--stdin'], JSON.stringify({ copy: 'Verified copy', altText: 'New alt' }))
    const post = await readPost(contentFilePath)
    assert.equal(post.sourceCopy, null)
    assert.equal(post.rewrittenAt, null)
  })
})

test('set rewrittenAt marks a kept-as-is post rewritten and keeps its original copy and thread as source', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath, createLedger([createPost({ threadFollowUps: 'Part 2\nOriginal reply' })]))
    await collectContentCommandOutput(contentFilePath, ['set', 'L01', 'rewrittenAt=2026-10-11T09:00:00-06:00'])
    const post = await readPost(contentFilePath)
    assert.equal(post.rewrittenAt, '2026-10-11T15:00:00.000Z')
    assert.equal(post.copy, 'Verified copy')
    assert.equal(post.sourceCopy, 'Verified copy')
    assert.equal(post.sourceThreadFollowUps, 'Part 2\nOriginal reply')
  })
})

test('a stored plan without rewrite fields still loads and lists', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await mkdir(dirname(contentFilePath), { recursive: true })
    await writeFile(contentFilePath, JSON.stringify(createLedger()))
    const [listedPost] = readOutputJson(await collectContentCommandOutput(contentFilePath, ['week', '--json']))
    assert.equal(listedPost.sourceCopy, null)
    assert.equal(listedPost.rewrittenAt, null)
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

test('prune removes assets only for posts published at least seven days ago', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    const publishedAt = new Date(fixedNow.getTime() - 8 * 86_400_000).toISOString()
    await initializeLedger(contentFilePath, createLedger([
      createPost({ id: 'L09', status: 'published', publishedAt }),
      createPost({ id: 'L06', status: 'published', publishedAt: new Date(fixedNow.getTime() - 6 * 86_400_000).toISOString() }),
      createPost({ id: 'L07', status: 'draft', publishedAt }),
      createPost({ id: 'L08', status: 'queued', publishedAt }),
      createPost({ id: 'L05', status: 'published' }),
    ]))
    const assetsDirectory = join(dirname(contentFilePath), 'assets')
    await mkdir(join(assetsDirectory, 'nested'), { recursive: true })
    for (const fileName of ['L09.png', 'L09.preview.webm', 'L09.john', 'L06.webm', 'L07.john', 'L08.png', 'L05.png', 'L99.png', 'nested/L09.png']) {
      await writeFile(join(assetsDirectory, fileName), '')
    }
    const pruneOutput = await collectContentCommandOutput(contentFilePath, ['prune'])
    assert.equal(pruneOutput.exitCode, 0)
    assert.deepEqual(pruneOutput.outputLines.sort(), ['prune: removed assets/L09.john', 'prune: removed assets/L09.png', 'prune: removed assets/L09.preview.webm'])
    assert.deepEqual((await readdir(assetsDirectory)).sort(), ['L05.png', 'L06.webm', 'L07.john', 'L08.png', 'L99.png', 'nested'])
    assert.equal(await readFile(join(assetsDirectory, 'nested/L09.png'), 'utf8'), '')
  })
})

test('prune removes old scratch files recursively and directories left empty', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    const socialDirectory = join(dirname(contentFilePath), 'social')
    const outputDirectory = join(socialDirectory, 'out')
    await mkdir(join(outputDirectory, 'nested', 'deeper'), { recursive: true })
    const oldFilePath = join(outputDirectory, 'nested', 'deeper', 'old.png')
    const recentFilePath = join(outputDirectory, 'recent.png')
    const outsideFilePath = join(socialDirectory, 'keep.png')
    const oldTime = new Date(fixedNow.getTime() - 31 * 86_400_000)
    for (const filePath of [oldFilePath, recentFilePath, outsideFilePath]) await writeFile(filePath, '')
    await utimes(oldFilePath, oldTime, oldTime)
    await utimes(outsideFilePath, oldTime, oldTime)
    const recentTime = new Date(fixedNow.getTime() - 29 * 86_400_000)
    await utimes(recentFilePath, recentTime, recentTime)
    const pruneOutput = await collectContentCommandOutput(contentFilePath, ['prune'])
    assert.equal(pruneOutput.exitCode, 0)
    assert.deepEqual(pruneOutput.outputLines, ['prune: removed social/out/nested/deeper/old.png'])
    assert.deepEqual(await readdir(outputDirectory), ['recent.png'])
    assert.equal(await readFile(outsideFilePath, 'utf8'), '')
  })
})

test('prune skips asset and scratch symlinks without touching their targets', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath, createLedger([createPost({ status: 'published', publishedAt: '2026-10-01T00:00:00Z' })]))
    const contentDirectory = dirname(contentFilePath)
    const assetsDirectory = join(contentDirectory, 'assets')
    const outputDirectory = join(contentDirectory, 'social', 'out')
    await mkdir(assetsDirectory)
    await mkdir(outputDirectory, { recursive: true })
    const targetFilePath = join(contentDirectory, 'keep.png')
    await writeFile(targetFilePath, 'keep')
    const oldTime = new Date(fixedNow.getTime() - 31 * 86_400_000)
    await utimes(targetFilePath, oldTime, oldTime)
    const assetLinkPath = join(assetsDirectory, 'L01.png')
    const scratchLinkPath = join(outputDirectory, 'old.png')
    const directoryLinkPath = join(outputDirectory, 'linked')
    await symlink(targetFilePath, assetLinkPath)
    await symlink(targetFilePath, scratchLinkPath)
    await symlink(assetsDirectory, directoryLinkPath)
    const pruneOutput = await collectContentCommandOutput(contentFilePath, ['prune'])
    assert.equal(pruneOutput.exitCode, nothingToDoExitCode)
    assert.deepEqual(pruneOutput.outputLines, [])
    for (const linkPath of [assetLinkPath, scratchLinkPath, directoryLinkPath]) assert.equal((await lstat(linkPath)).isSymbolicLink(), true)
    assert.equal(await readFile(targetFilePath, 'utf8'), 'keep')
  })
})

for (const directoryName of ['assets', 'social', 'social/out']) {
  test(`prune skips a symlink at ${directoryName}`, async () => {
    await withTemporaryLedger(async (contentFilePath) => {
      await initializeLedger(contentFilePath, createLedger([createPost({ status: 'published', publishedAt: '2026-10-01T00:00:00Z' })]))
      const contentDirectory = dirname(contentFilePath)
      const targetDirectory = join(contentDirectory, 'untouched')
      await mkdir(join(targetDirectory, 'out'), { recursive: true })
      for (const filePath of [join(targetDirectory, 'L01.png'), join(targetDirectory, 'out', 'old.png')]) {
        await writeFile(filePath, 'keep')
        const oldTime = new Date(fixedNow.getTime() - 31 * 86_400_000)
        await utimes(filePath, oldTime, oldTime)
      }
      const linkPath = join(contentDirectory, directoryName)
      await mkdir(dirname(linkPath), { recursive: true })
      await symlink(targetDirectory, linkPath)
      const pruneOutput = await collectContentCommandOutput(contentFilePath, ['prune'])
      assert.equal(pruneOutput.exitCode, nothingToDoExitCode)
      assert.deepEqual(pruneOutput.outputLines, [])
      assert.equal((await lstat(linkPath)).isSymbolicLink(), true)
      assert.equal(await readFile(join(targetDirectory, 'L01.png'), 'utf8'), 'keep')
      assert.equal(await readFile(join(targetDirectory, 'out', 'old.png'), 'utf8'), 'keep')
    })
  })
}

test('prune returns nothing-to-do for missing or empty directories', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath)
    const missingOutput = await collectContentCommandOutput(contentFilePath, ['prune'])
    assert.equal(missingOutput.exitCode, nothingToDoExitCode)
    assert.deepEqual(missingOutput.outputLines, [])
    await mkdir(join(dirname(contentFilePath), 'assets'))
    await mkdir(join(dirname(contentFilePath), 'social', 'out', 'empty'), { recursive: true })
    const emptyOutput = await collectContentCommandOutput(contentFilePath, ['prune'])
    assert.equal(emptyOutput.exitCode, nothingToDoExitCode)
    assert.deepEqual(emptyOutput.outputLines, [])
    assert.deepEqual(await readdir(join(dirname(contentFilePath), 'social', 'out')), [])
  })
})

test('prune rejects arguments before deleting files', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath, createLedger([createPost({ status: 'published', publishedAt: '2026-10-01T00:00:00Z' })]))
    const assetsDirectory = join(dirname(contentFilePath), 'assets')
    await mkdir(assetsDirectory)
    await writeFile(join(assetsDirectory, 'L01.png'), '')
    for (const argument of ['extra', '--json', '--stdin']) {
      await assert.rejects(collectContentCommandOutput(contentFilePath, ['prune', argument]), /Invalid command options/)
      assert.deepEqual(await readdir(assetsDirectory), ['L01.png'])
    }
  })
})

test('prune includes the exact seven-day and thirty-day thresholds using injected now', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    const publishedAt = new Date(fixedNow.getTime() - 7 * 86_400_000).toISOString()
    await initializeLedger(contentFilePath, createLedger([createPost({ status: 'published', publishedAt })]))
    const assetsDirectory = join(dirname(contentFilePath), 'assets')
    const outputDirectory = join(dirname(contentFilePath), 'social', 'out')
    await mkdir(assetsDirectory)
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(join(assetsDirectory, 'L01.png'), '')
    const scratchFilePath = join(outputDirectory, 'old.png')
    await writeFile(scratchFilePath, '')
    const oldTime = new Date(fixedNow.getTime() - 30 * 86_400_000)
    await utimes(scratchFilePath, oldTime, oldTime)
    const beforeThreshold = await collectContentCommandOutput(contentFilePath, ['prune'], '', new Date(fixedNow.getTime() - 1))
    assert.equal(beforeThreshold.exitCode, nothingToDoExitCode)
    assert.deepEqual(beforeThreshold.outputLines, [])
    const pruneOutput = await collectContentCommandOutput(contentFilePath, ['prune'])
    assert.equal(pruneOutput.exitCode, 0)
    assert.deepEqual(pruneOutput.outputLines, ['prune: removed assets/L01.png', 'prune: removed social/out/old.png'])
    assert.deepEqual(await readdir(assetsDirectory), [])
    assert.deepEqual(await readdir(outputDirectory), [])
  })
})

test('CLI prune uses the ledger directory and returns nothing-to-do after deletion', async () => {
  await withTemporaryLedger(async (contentFilePath) => {
    await initializeLedger(contentFilePath, createLedger([createPost({ status: 'published', publishedAt: '2000-01-01T00:00:00Z' })]))
    const assetsDirectory = join(dirname(contentFilePath), 'assets')
    await mkdir(assetsDirectory)
    await writeFile(join(assetsDirectory, 'L01.png'), '')
    const options = { env: { ...process.env, GLISSA_CONTENT_FILE: contentFilePath } }
    const pruneOutput = await captureTestCommand(process.execPath, [scriptPath.pathname, 'prune'], options)
    assert.equal(pruneOutput.exitCode, 0)
    assert.equal(pruneOutput.stdout.trim(), 'prune: removed assets/L01.png')
    assert.deepEqual(await readdir(assetsDirectory), [])
    const emptyOutput = await captureTestCommand(process.execPath, [scriptPath.pathname, 'prune'], options)
    assert.equal(emptyOutput.exitCode, nothingToDoExitCode)
    assert.equal(emptyOutput.stdout, '')
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
