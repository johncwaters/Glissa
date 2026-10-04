import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { createLogFilePath, createTemporaryDirectoryRemovedAfterTest, setTestEnvironment } from './fixture-test-helpers.mjs';
import { findFileContentViolations, findMemoryStateViolations, formatViolation, hasLuhnValidCardNumber, runMemoryCheckCommand } from './memory-check.mjs';

let restoreEnvironment;

before(() => {
  restoreEnvironment = setTestEnvironment({ ASSISTANT_LOG_FILE: createLogFilePath('assistant-memory-check-log-') });
});

after(() => restoreEnvironment());

const homeAirportFieldLine = '- Home airport: XYZ (stated 2026-09-10)';
const seatPreferenceFieldLine = '- Seat preference: aisle (stated 2026-09-10)';
const employerFieldLine = '- Employer: Example Corp (stated 2026-09-10)';
const deskFieldLine = '- Desk: standing (stated 2026-09-10)';
const forwardedManagerFieldLine = '- Manager: Avery (forwarded 2026-09-10)';
const paddedDigestBody = 'plan '.repeat(280);

function buildProfileText(domainName, updatedOn, fieldLines) {
  return `---\nname: ${domainName}\ndescription: ${domainName} facts\nupdated: ${updatedOn}\n---\n${fieldLines.join('\n')}\n`;
}

function contextDigest({ title = 'Example plan', source = 'telegram-forward', received = '2026-09-14', until = '2026-12-13', body = 'The forwarded page describes the next-quarter plan.' } = {}) {
  return `---\ntitle: ${title}\nsource: ${source}\nreceived: ${received}\nuntil: ${until}\n---\n${body}\n`;
}

const travelProfileFiles = { 'profile/travel.md': buildProfileText('Travel', '2026-09-10', [homeAirportFieldLine, seatPreferenceFieldLine]) };

function checkMemoryState(currentFileTexts, previousFileTexts = {}) {
  const currentTree = { fileTextsByPath: new Map(Object.entries(currentFileTexts)), irregularPaths: [] };
  return findMemoryStateViolations(new Map(Object.entries(previousFileTexts)), currentTree);
}

function listViolationPaths(violations) {
  return violations.map((violation) => violation.path);
}

function assertSingleViolation(violations, expectedPath, expectedReasonPattern) {
  assert.deepEqual(listViolationPaths(violations), [expectedPath], violations.map(formatViolation).join('\n'));
  assert.match(violations[0].reason, expectedReasonPattern);
}

function writeContextDigests(fileTextsByPath, digestCount) {
  for (let digestIndex = 0; digestIndex < digestCount; digestIndex += 1) {
    fileTextsByPath[`context/2026-09-14-plan-${digestIndex}.md`] = contextDigest({ body: paddedDigestBody });
  }
  return fileTextsByPath;
}

test('accepts a well-formed profile file', () => {
  assert.deepEqual(checkMemoryState(travelProfileFiles), []);
});

test('refuses a malformed profile file', () => {
  assertSingleViolation(checkMemoryState({ 'profile/travel.md': 'no frontmatter\n' }), 'memory/profile/travel.md', /fails the profile grammar/);
});

test('does not grammar-check a memory file outside the profile directory', () => {
  assert.deepEqual(checkMemoryState({ 'contacts.md': 'not a profile\n' }), []);
});

test('accepts an archive file without grammar checking it', () => {
  assert.deepEqual(checkMemoryState({ 'archive/travel.md': 'free text with no frontmatter and no fields\n' }), []);
});

test('accepts a valid forwarded context digest', () => {
  assert.deepEqual(checkMemoryState({ 'context/2026-09-14-example-plan.md': contextDigest() }), []);
});

test('refuses context digests with missing keys, bad dates, reversed dates, or 1500 bytes', async (testContext) => {
  const invalidDigests = [
    ['missing key', contextDigest().replace('title: Example plan\n', '')],
    ['bad received date', contextDigest({ received: '2026-02-30' })],
    ['bad until date', contextDigest({ until: 'September 20' })],
    ['until before received', contextDigest({ until: '2026-09-13' })],
    ['oversize', contextDigest({ body: 'x'.repeat(1500) })]
  ];
  for (const [name, fileText] of invalidDigests) {
    await testContext.test(name, () => {
      assertSingleViolation(checkMemoryState({ 'context/2026-09-14-plan.md': fileText }), 'memory/context/2026-09-14-plan.md', /fails the context digest grammar/);
    });
  }
});

test('refuses a context digest whose file name breaks the YYYY-MM-DD-slug grammar', async (testContext) => {
  const invalidNames = ['example-plan.md', '2026-02-30-plan.md', '2026-09-14-.md', '2026-09-14-Example.md', '20260914-plan.md', 'sub/2026-09-14-plan.md'];
  for (const invalidName of invalidNames) {
    await testContext.test(invalidName, () => {
      assertSingleViolation(checkMemoryState({ [`context/${invalidName}`]: contextDigest() }), `memory/context/${invalidName}`, /fails the context digest name/);
    });
  }
});

test('refuses a context digest carrying a credential, token, or long digit run', async (testContext) => {
  const credentialBodies = [
    ['bearer header', 'The page pasted a Bearer abcdefghij header.'],
    ['openai key', 'The page pasted sk-abcdefghijklmnop as the key.'],
    ['github token', 'The page pasted ghp_abcdefghijklmnop as the token.'],
    ['slack token', 'The page pasted xoxb-abcdefghij as the token.'],
    ['long base64 run', `The page pasted ${'QWxhZGRpbjpvcGVuIHNlc2FtZQ'.repeat(2)} as the key.`],
    ['long digit run', 'The account reference is 123456789012 on the page.'],
    ['forty-character hex token', 'The page pasted a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 as the token.'],
    ['bearer token inside a URL query string', 'The page linked https://example.com/api?authorization=Bearer abcdefghij for access.']
  ];
  for (const [name, body] of credentialBodies) {
    await testContext.test(name, () => {
      assertSingleViolation(checkMemoryState({ 'context/2026-09-14-plan.md': contextDigest({ body }) }), 'memory/context/2026-09-14-plan.md', /carries a credential/);
    });
  }
});

test('accepts a context digest whose prose merely resembles a token prefix', () => {
  assert.deepEqual(checkMemoryState({ 'context/2026-09-14-plan.md': contextDigest({ body: 'The task-force risk-register lands 2026-09-20 with 4 owners.' }) }), []);
});

test('accepts a context digest citing a long document URL', () => {
  const body = 'The plan lives at https://www.example.com/team/Q4-Plan-1f2e3d4c5b6a7980abcdef0123456789 and covers pricing.';
  assert.deepEqual(checkMemoryState({ 'context/2026-09-14-plan.md': contextDigest({ body }) }), []);
});

test('refuses an archived context digest carrying a credential', () => {
  const violations = checkMemoryState({ 'archive/context/2026-09-14-plan.md': contextDigest({ body: 'The page pasted sk-abcdefghijklmnop as the key.' }) });
  assertSingleViolation(violations, 'memory/archive/context/2026-09-14-plan.md', /carries a credential/);
});

test('refuses a forwarded profile value carrying a credential', () => {
  const violations = checkMemoryState({ 'profile/work.md': buildProfileText('Work', '2026-09-14', ['- API key: sk-abcdefghijklmnop (forwarded 2026-09-14)']) });
  assertSingleViolation(violations, 'memory/profile/work.md', /carries a credential/);
});

test('refuses Luhn-valid card numbers however their digit groups are separated', async (testContext) => {
  const cardTexts = [
    'Card 4111111111111111\n',
    'Cards 4111 1111 1111 1111 and 4111-1111-1111-1111\n',
    'Card 4111 1111 1111 1111 12/25\n',
    'Card 4111.1111.1111.1111\n',
    'Card 4111/1111/1111/1111\n',
    'Reference 99411111111111111199\n',
    'Card 1 4111-1111-1111-1111\n',
    'ref 12 4111 1111 1111 1111\n'
  ];
  for (const cardText of cardTexts) {
    await testContext.test(cardText.trim(), () => {
      assertSingleViolation(checkMemoryState({ 'contacts.md': cardText }), 'memory/contacts.md', /carries a card number/);
    });
  }
});

test('accepts digit runs that are not card numbers', async (testContext) => {
  const ordinaryTexts = [
    '- Trip: 2026-01-01 2026-01-09 (stated 2026-09-10)\n',
    'Called 2026-09-10T14:30:00 from +1-555-123-4567\n',
    'Identifier 1234567890123456\n'
  ];
  for (const ordinaryText of ordinaryTexts) {
    await testContext.test(ordinaryText.trim(), () => {
      assert.deepEqual(checkMemoryState({ 'contacts.md': ordinaryText }), []);
    });
  }
});

test('reports every memory file carrying a card number', () => {
  const violations = checkMemoryState({ 'contacts.md': 'Card 4111111111111111\n', 'wallet.md': 'Card 4111-1111-1111-1111\n' });
  assert.deepEqual(listViolationPaths(violations).sort(), ['memory/contacts.md', 'memory/wallet.md']);
});

function createSeededRandomIntegerReader(seed) {
  let randomState = seed;
  return (exclusiveUpperBound) => {
    randomState = (randomState * 1103515245 + 12345) % 2147483648;
    return randomState % exclusiveUpperBound;
  };
}

function appendLuhnCheckDigit(leadingFifteenDigits) {
  let checksum = 0;
  let shouldDoubleDigit = true;
  for (let digitIndex = leadingFifteenDigits.length - 1; digitIndex >= 0; digitIndex -= 1) {
    let digit = Number(leadingFifteenDigits[digitIndex]);
    if (shouldDoubleDigit) digit *= 2;
    if (digit > 9) digit -= 9;
    checksum += digit;
    shouldDoubleDigit = !shouldDoubleDigit;
  }
  return `${leadingFifteenDigits}${(10 - (checksum % 10)) % 10}`;
}

function buildGroupedDigits(sixteenDigits, groupSeparator) {
  const digitGroups = [];
  for (let groupStart = 0; groupStart < sixteenDigits.length; groupStart += 4) digitGroups.push(sixteenDigits.slice(groupStart, groupStart + 4));
  return digitGroups.join(groupSeparator);
}

test('refuses every generated card number that follows a short prefix and a different separator', () => {
  const readRandomIntegerBelow = createSeededRandomIntegerReader(20260910);
  const availableSeparators = [' ', '-', '.', '/'];
  const acceptedTexts = [];
  for (let generatedCase = 0; generatedCase < 200; generatedCase += 1) {
    let leadingFifteenDigits = '';
    while (leadingFifteenDigits.length < 15) leadingFifteenDigits += String(readRandomIntegerBelow(10));
    const cardSeparator = availableSeparators[readRandomIntegerBelow(availableSeparators.length)];
    const otherSeparators = availableSeparators.filter((separator) => separator !== cardSeparator);
    const prefixSeparator = otherSeparators[readRandomIntegerBelow(otherSeparators.length)];
    const prefixDigits = String(readRandomIntegerBelow(90) + 1);
    const memoryText = `Card ${prefixDigits}${prefixSeparator}${buildGroupedDigits(appendLuhnCheckDigit(leadingFifteenDigits), cardSeparator)}\n`;
    if (hasLuhnValidCardNumber(memoryText)) continue;
    acceptedTexts.push(memoryText);
  }
  assert.deepEqual(acceptedTexts, []);
});

test('refuses memory paths that are not plain markdown memory files', async (testContext) => {
  const disallowedPaths = ['CLAUDE.md', 'notes/CLAUDE.local.md', 'AGENTS.md', 'notes.txt', '.hidden/notes.md', 'notes\tmore.md', 'notes\nmore.md'];
  for (const disallowedPath of disallowedPaths) {
    await testContext.test(JSON.stringify(disallowedPath), () => {
      assertSingleViolation(findFileContentViolations(disallowedPath, 'a durable fact\n'), `memory/${disallowedPath}`, /is not a memory markdown file/);
    });
  }
});

test('refuses a stated field that disappears with no newer stamp and no archive line', () => {
  const violations = checkMemoryState({ 'profile/travel.md': buildProfileText('Travel', '2026-09-10', [homeAirportFieldLine]) }, travelProfileFiles);
  assertSingleViolation(violations, 'memory/profile/travel.md', /drops the stated field Seat preference; .*memory\/archive\/travel\.md/);
});

test('refuses a stated field erased from a CRLF profile file', () => {
  const previousFiles = { 'profile/travel.md': travelProfileFiles['profile/travel.md'].replace(/\n/g, '\r\n') };
  const violations = checkMemoryState({ 'profile/travel.md': buildProfileText('Travel', '2026-09-10', [homeAirportFieldLine]).replace(/\n/g, '\r\n') }, previousFiles);
  assertSingleViolation(violations, 'memory/profile/travel.md', /drops the stated field Seat preference/);
});

test('accepts a stated field restated with a newer stamp', () => {
  const currentFiles = { 'profile/travel.md': buildProfileText('Travel', '2026-09-11', [homeAirportFieldLine, '- Seat preference: window (stated 2026-09-11)']) };
  assert.deepEqual(checkMemoryState(currentFiles, travelProfileFiles), []);
});

test('accepts a stated field corrected on the day it was first stated', () => {
  const currentFiles = { 'profile/travel.md': buildProfileText('Travel', '2026-09-10', ['- Home airport: XYW (stated 2026-09-10)', seatPreferenceFieldLine]) };
  assert.deepEqual(checkMemoryState(currentFiles, travelProfileFiles), []);
});

test('refuses a stated field restated under an older date', () => {
  const currentFiles = { 'profile/travel.md': buildProfileText('Travel', '2026-09-10', [homeAirportFieldLine, '- Seat preference: window (stated 2026-09-09)']) };
  assertSingleViolation(checkMemoryState(currentFiles, travelProfileFiles), 'memory/profile/travel.md', /drops the stated field Seat preference/);
});

test('accepts a stated field moved verbatim into the archive file', () => {
  const currentFiles = {
    'profile/travel.md': buildProfileText('Travel', '2026-09-10', [homeAirportFieldLine]),
    'archive/travel.md': `## archived 2026-09-11\n${seatPreferenceFieldLine}\n`
  };
  assert.deepEqual(checkMemoryState(currentFiles, travelProfileFiles), []);
});

test('refuses a deleted profile file whose fields were not archived', () => {
  const violations = checkMemoryState({}, travelProfileFiles);
  assert.deepEqual(listViolationPaths(violations), ['memory/profile/travel.md', 'memory/profile/travel.md']);
});

test('refuses deleting an archive file that carries a stated field line', () => {
  const previousFiles = {
    'profile/travel.md': buildProfileText('Travel', '2026-09-10', [homeAirportFieldLine]),
    'archive/travel.md': `## archived 2026-09-10\n${seatPreferenceFieldLine}\n`
  };
  const violations = checkMemoryState({ 'profile/travel.md': previousFiles['profile/travel.md'] }, previousFiles);
  assertSingleViolation(violations, 'memory/archive/travel.md', /drops the archived stated line for Seat preference/);
});

test('refuses dropping an older archived stated line when a newer line for the same field stays', () => {
  const newerHomeAirportLine = '- Home airport: XYZ (stated 2026-05-01)';
  const previousFiles = { 'archive/travel.md': `## archived 2026-09-10\n- Home airport: XYZ (stated 2026-01-01)\n${newerHomeAirportLine}\n` };
  const currentFiles = { 'archive/travel.md': `## archived 2026-09-10\n${newerHomeAirportLine}\n` };
  assertSingleViolation(checkMemoryState(currentFiles, previousFiles), 'memory/archive/travel.md', /drops the archived stated line for Home airport/);
});

test('refuses dropping a newer stated profile line when only an older line for the same field stays', () => {
  const olderHomeAirportLine = '- Home airport: XYZ (stated 2026-01-01)';
  const previousFiles = { 'profile/travel.md': buildProfileText('Travel', '2026-09-10', ['- Home airport: XYZ (stated 2026-05-01)', olderHomeAirportLine]) };
  const currentFiles = { 'profile/travel.md': buildProfileText('Travel', '2026-09-10', [olderHomeAirportLine]) };
  assertSingleViolation(checkMemoryState(currentFiles, previousFiles), 'memory/profile/travel.md', /drops the stated field Home airport/);
});

test('accepts a stated field appended to an archive file that already carries one', () => {
  const previousFiles = { 'archive/travel.md': `## archived 2026-09-10\n${seatPreferenceFieldLine}\n` };
  const currentFiles = { 'archive/travel.md': `## archived 2026-09-10\n${seatPreferenceFieldLine}\n${employerFieldLine}\n` };
  assert.deepEqual(checkMemoryState(currentFiles, previousFiles), []);
});

test('accepts moving a field between profile files when the other archive already carries its line', () => {
  const previousFiles = {
    'profile/travel.md': buildProfileText('Travel', '2026-09-10', [homeAirportFieldLine]),
    'profile/work.md': buildProfileText('Work', '2026-09-10', [employerFieldLine, deskFieldLine]),
    'archive/work.md': `## archived 2026-09-10\n${employerFieldLine}\n`
  };
  const currentFiles = {
    ...previousFiles,
    'profile/travel.md': buildProfileText('Travel', '2026-09-10', [homeAirportFieldLine, seatPreferenceFieldLine]),
    'profile/work.md': buildProfileText('Work', '2026-09-10', [deskFieldLine])
  };
  assert.deepEqual(checkMemoryState(currentFiles, previousFiles), []);
});

test('accepts adding and removing a forwarded profile field', () => {
  const forwardedFiles = { 'profile/work.md': buildProfileText('Work', '2026-09-10', [forwardedManagerFieldLine]) };
  assert.deepEqual(checkMemoryState(forwardedFiles), []);
  assert.deepEqual(checkMemoryState({ 'profile/work.md': buildProfileText('Work', '2026-09-11', []) }, forwardedFiles), []);
});

test('refuses a forwarded value for a field John stated anywhere in the fact scope', async (testContext) => {
  const cases = [
    ['replacing the stated line', { 'profile/work.md': buildProfileText('Work', '2026-09-10', ['- Manager: Avery (stated 2026-09-10)']) }, {}],
    ['stated line already archived', {}, { 'archive/work.md': '## archived 2026-09-11\n- Manager: Avery (stated 2026-09-10)\n' }],
    ['stated line in another profile file', {}, { 'profile/travel.md': buildProfileText('Travel', '2026-09-10', ['- Manager: Avery (stated 2026-09-10)']) }],
    ['archived stated line pads the field name', {}, { 'archive/work.md': '## archived 2026-09-11\n- Manager : Avery (stated 2026-09-10)\n' }]
  ];
  for (const [name, previousFiles, unchangedFiles] of cases) {
    await testContext.test(name, () => {
      const currentFiles = { ...unchangedFiles, 'profile/work.md': buildProfileText('Work', '2026-09-12', ['- Manager: Blake (forwarded 2026-09-12)']) };
      const violations = checkMemoryState(currentFiles, { ...previousFiles, ...unchangedFiles });
      const downgradeViolations = violations.filter((violation) => /forwarded value/.test(violation.reason));
      assert.deepEqual(listViolationPaths(downgradeViolations), ['memory/profile/work.md'], violations.map(formatViolation).join('\n'));
    });
  }
});

test('accepts a forwarded field whose name appears only inside an archived context digest', () => {
  const unchangedFiles = { 'archive/context/2026-09-01-plan.md': contextDigest({ body: 'The page quoted\n- Manager: Avery (stated 2026-09-10)\nin its body.' }) };
  const currentFiles = { ...unchangedFiles, 'profile/work.md': buildProfileText('Work', '2026-09-12', [forwardedManagerFieldLine]) };
  assert.deepEqual(checkMemoryState(currentFiles, unchangedFiles), []);
});

test('refuses a forwarded profile line whose field name carries a trailing space', () => {
  const currentFiles = { 'profile/work.md': buildProfileText('Work', '2026-09-14', [employerFieldLine, '- Employer : Acme (forwarded 2026-09-14)']) };
  const violations = checkMemoryState(currentFiles, { 'profile/work.md': buildProfileText('Work', '2026-09-10', [employerFieldLine]) });
  assert.ok(violations.some((violation) => /fails the profile grammar/.test(violation.reason)), violations.map(formatViolation).join('\n'));
});

test('refuses memory over the byte cap and leaves archive and context bytes out of it', () => {
  assertSingleViolation(checkMemoryState({ 'contacts.md': `${'a'.repeat(24576)}\n` }), 'memory', /is over the 24576 byte cap/);
  assert.deepEqual(checkMemoryState({ 'archive/travel.md': `${'a'.repeat(24576)}\n` }), []);
  assert.deepEqual(checkMemoryState(writeContextDigests({ 'contacts.md': 'a'.repeat(24000) }, 8)), []);
});

test('refuses a context directory that grew past its own byte cap', () => {
  assertSingleViolation(checkMemoryState(writeContextDigests({}, 9)), 'memory/context', /is over the 12288 byte cap/);
  assertSingleViolation(checkMemoryState(writeContextDigests({}, 10), writeContextDigests({}, 9)), 'memory/context', /is over the 12288 byte cap/);
});

test('tolerates an over-cap context directory that did not grow', () => {
  const overCapFiles = writeContextDigests({}, 10);
  const shrunkFiles = { ...overCapFiles };
  delete shrunkFiles['context/2026-09-14-plan-0.md'];
  assert.deepEqual(checkMemoryState(shrunkFiles, overCapFiles), []);
  const profileAddedFiles = { ...overCapFiles, 'profile/travel.md': buildProfileText('Travel', '2026-09-10', [homeAirportFieldLine]) };
  assert.deepEqual(checkMemoryState(profileAddedFiles, overCapFiles), []);
});

function createMemoryFixture(fileTextsByPath) {
  const fixtureRoot = createTemporaryDirectoryRemovedAfterTest('assistant-memory-check-');
  const memoryDirectory = path.join(fixtureRoot, 'memory');
  fs.mkdirSync(memoryDirectory, { recursive: true });
  for (const [relativePath, fileText] of Object.entries(fileTextsByPath)) writeFixtureFile(memoryDirectory, relativePath, fileText);
  return { memoryDirectory, stateDirectory: path.join(fixtureRoot, 'state') };
}

function writeFixtureFile(memoryDirectory, relativePath, fileText) {
  const absolutePath = path.join(memoryDirectory, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, fileText);
}

async function runSnapshotCommand({ memoryDirectory, stateDirectory }, now = new Date(2026, 9, 4, 3)) {
  const outputLines = [];
  const errorLines = [];
  const exitCode = await runMemoryCheckCommand(['snapshot'], {
    environment: { ASSISTANT_MEMORY_DIR: memoryDirectory, ASSISTANT_STATE_DIR: stateDirectory },
    now,
    writeOutput: (line) => outputLines.push(line),
    writeError: (line) => errorLines.push(line)
  });
  return { exitCode, outputLines, errorLines };
}

function listSnapshotNames(stateDirectory) {
  return fs.readdirSync(path.join(stateDirectory, 'memory-snapshots')).sort();
}

test('snapshot writes a private copy of clean memory under the state directory', async () => {
  const fixture = createMemoryFixture(travelProfileFiles);
  const snapshotRun = await runSnapshotCommand(fixture);
  assert.equal(snapshotRun.exitCode, 0, snapshotRun.errorLines.join('\n'));
  const snapshotDirectory = path.join(fixture.stateDirectory, 'memory-snapshots', '2026-10-04');
  assert.equal(fs.readFileSync(path.join(snapshotDirectory, 'profile', 'travel.md'), 'utf8'), travelProfileFiles['profile/travel.md']);
  assert.equal(fs.statSync(path.join(fixture.stateDirectory, 'memory-snapshots')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(snapshotDirectory).mode & 0o777, 0o700);
});

test('snapshot refuses a stated field dropped since the newest snapshot and writes no new snapshot', async () => {
  const fixture = createMemoryFixture(travelProfileFiles);
  assert.equal((await runSnapshotCommand(fixture)).exitCode, 0);
  writeFixtureFile(fixture.memoryDirectory, 'profile/travel.md', buildProfileText('Travel', '2026-09-10', [homeAirportFieldLine]));
  const secondRun = await runSnapshotCommand(fixture, new Date(2026, 9, 5, 3));
  assert.equal(secondRun.exitCode, 1);
  assert.equal(secondRun.errorLines.length, 1);
  assert.match(secondRun.errorLines[0], /^memory\/profile\/travel\.md drops the stated field Seat preference/);
  assert.deepEqual(listSnapshotNames(fixture.stateDirectory), ['2026-10-04']);
});

test('snapshot refuses a symlink, an executable file, or a file in a dot-prefixed directory inside memory', async (testContext) => {
  const arrangements = [
    ['symlink', (memoryDirectory) => fs.symlinkSync('/etc/hostname', path.join(memoryDirectory, 'linked.md')), 'memory/linked.md'],
    ['executable', (memoryDirectory) => fs.chmodSync(path.join(memoryDirectory, 'contacts.md'), 0o755), 'memory/contacts.md'],
    ['dot-prefixed directory', (memoryDirectory) => writeFixtureFile(memoryDirectory, '.cache/notes.md', 'a note\n'), 'memory/.cache/notes.md']
  ];
  for (const [name, arrange, expectedPath] of arrangements) {
    await testContext.test(name, async () => {
      const fixture = createMemoryFixture({ 'contacts.md': 'a contact\n' });
      arrange(fixture.memoryDirectory);
      const snapshotRun = await runSnapshotCommand(fixture);
      assert.equal(snapshotRun.exitCode, 1);
      assert.deepEqual(snapshotRun.errorLines.map((line) => line.split(' ')[0]), [expectedPath]);
    });
  }
});

test('snapshot keeps only the newest thirty snapshots', async () => {
  const fixture = createMemoryFixture(travelProfileFiles);
  for (let dayOfMonth = 1; dayOfMonth <= 31; dayOfMonth += 1) {
    assert.equal((await runSnapshotCommand(fixture, new Date(2026, 9, dayOfMonth, 3))).exitCode, 0);
  }
  const snapshotNames = listSnapshotNames(fixture.stateDirectory);
  assert.equal(snapshotNames.length, 30);
  assert.equal(snapshotNames[0], '2026-10-02');
});

test('snapshot prints usage for any other command', async () => {
  const errorLines = [];
  const exitCode = await runMemoryCheckCommand([], { writeError: (line) => errorLines.push(line) });
  assert.equal(exitCode, 2);
  assert.match(errorLines[0], /usage: memory-check\.mjs snapshot/);
});
