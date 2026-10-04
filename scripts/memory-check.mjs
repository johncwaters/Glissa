import fs from 'node:fs';
import path from 'node:path';
import { resolveAssistantStateDirectory } from './assistant-state-directory.mjs';
import { isCalendarDate } from './calendar-date.mjs';
import { addUsageExitCode, isMainModule, runCommandLine } from './command-line.mjs';
import { logEvent } from './log.mjs';
import { contextByteCap, findContextDigestViolations, findProfileGrammarViolations, localCalendarDate } from './profile.mjs';
import { resolveRepositoryPath } from './repository-path.mjs';
import { isPathInsideDirectory } from './serve-results.mjs';

const memoryDirectoryEnvironmentVariable = 'ASSISTANT_MEMORY_DIR';
const reservedMemoryBasenames = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']);
const profilePathPrefix = 'profile/';
const contextPathPrefix = 'context/';
const archiveDirectoryName = 'archive';
const archivePathPrefix = `${archiveDirectoryName}/`;
const archiveContextPathPrefix = 'archive/context/';
const statedFieldLinePattern = /^- ([^:]+): (.*) \(stated (\d{4}-\d{2}-\d{2})(?:, until \d{4}-\d{2}-\d{2})?\)$/;
const forwardedFieldLinePattern = /^- ([^:]+): (.*\S) \(forwarded \d{4}-\d{2}-\d{2}(?:, until \d{4}-\d{2}-\d{2})?\)$/;
const inapplicableFieldValue = 'n/a';
export const memoryByteCap = 24576;
const contextFileNamePattern = /^(\d{4}-\d{2}-\d{2})-[a-z0-9-]+\.md$/;
const prefixedCredentialPatterns = [/\bsk-/, /\bghp_/, /\bxox/, /\bBearer\s/];
const urlTokenPattern = /(?:https?:\/\/|www\.)\S+/g;
const longDigitRunPattern = /\d{9,}/;
const longMixedRunPattern = /[A-Za-z0-9+/]{32,}={0,2}/g;
const letterPattern = /[A-Za-z]/;
const digitPattern = /\d/;
const executeBitsMask = 0o111;
const digitGroupSeparators = new Set([' ', '-', '.', '/']);
const shortestCardDigitCount = 13;
const longestCardDigitCount = 19;
const snapshotDirectoryName = 'memory-snapshots';
const snapshotDirectoryNamePattern = /^\d{4}-\d{2}-\d{2}$/;
const retainedSnapshotCount = 30;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const memoryViolationExitCode = 1;
const disallowedPathReason = 'is not a memory markdown file: memory files end in .md, sit outside dot-prefixed directories, carry no control characters, and are never CLAUDE.md, CLAUDE.local.md, or AGENTS.md';
const irregularFileReason = 'is not a regular non-executable file';

export function resolveMemoryDirectory(environment = process.env) {
  if (environment[memoryDirectoryEnvironmentVariable]) return environment[memoryDirectoryEnvironmentVariable];
  return resolveRepositoryPath('memory');
}

function describeMemoryPath(relativePath) {
  if (relativePath === '') return 'memory';
  return `memory/${relativePath}`;
}

function createViolation(relativePath, reason) {
  return { path: describeMemoryPath(relativePath), reason };
}

export function formatViolation(violation) {
  return `${violation.path} ${violation.reason}`;
}

function splitFileLines(fileText) {
  return fileText.split(/\r?\n/);
}

function hasDotPrefixedSegment(relativePath) {
  return relativePath.split('/').some((pathSegment) => pathSegment.startsWith('.'));
}

function hasControlCharacter(relativePath) {
  return [...relativePath].some((character) => character < ' ');
}

export function isAllowedMemoryFilePath(relativePath) {
  if (hasControlCharacter(relativePath)) return false;
  if (!relativePath.endsWith('.md')) return false;
  if (hasDotPrefixedSegment(relativePath)) return false;
  return !reservedMemoryBasenames.has(path.posix.basename(relativePath));
}

function isRegularNonExecutableFile(fileStats) {
  return fileStats.isFile() && (fileStats.mode & executeBitsMask) === 0;
}

function hasContextFileNameGrammar(relativePath) {
  const contextFileNameMatch = contextFileNamePattern.exec(relativePath.slice(contextPathPrefix.length));
  if (contextFileNameMatch === null) return false;
  return isCalendarDate(contextFileNameMatch[1]);
}

function describeLineViolations(lineViolations) {
  return lineViolations.map(({ line, reason }) => `line ${line} ${reason}`).join('; ');
}

function findProfileGrammarReasons(relativePath, fileText) {
  if (!relativePath.startsWith(profilePathPrefix)) return [];
  const grammarViolations = findProfileGrammarViolations(fileText);
  if (grammarViolations.length === 0) return [];
  return [`fails the profile grammar: ${describeLineViolations(grammarViolations)}`];
}

function findContextDigestReasons(relativePath, fileText) {
  if (!relativePath.startsWith(contextPathPrefix)) return [];
  if (!hasContextFileNameGrammar(relativePath)) return ['fails the context digest name: digests are named context/YYYY-MM-DD-slug.md'];
  const digestViolations = findContextDigestViolations(fileText);
  if (digestViolations.length === 0) return [];
  return [`fails the context digest grammar: ${describeLineViolations(digestViolations)}`];
}

function matchStatedFieldLine(line) {
  const statedFieldMatch = statedFieldLinePattern.exec(line);
  if (statedFieldMatch === null) return null;
  if (statedFieldMatch[2] === inapplicableFieldValue) return null;
  return { fieldName: statedFieldMatch[1], statedOn: statedFieldMatch[3] };
}

function findFieldLinesByName(fileText) {
  const fieldLinesByName = new Map();
  for (const line of splitFileLines(fileText)) {
    const statedField = matchStatedFieldLine(line);
    if (statedField === null) continue;
    fieldLinesByName.set(statedField.fieldName, { line, statedOn: statedField.statedOn });
  }
  return fieldLinesByName;
}

function listStatedFieldLines(fileText) {
  return splitFileLines(fileText).flatMap((line) => {
    const statedField = matchStatedFieldLine(line);
    if (statedField === null) return [];
    return [{ ...statedField, line }];
  });
}

function findForwardedFieldNames(fileText) {
  return new Set(splitFileLines(fileText).flatMap((line) => {
    const forwardedFieldMatch = forwardedFieldLinePattern.exec(line);
    if (forwardedFieldMatch === null) return [];
    return [forwardedFieldMatch[1].trim()];
  }));
}

function findForwardedFieldValues(fileText) {
  return splitFileLines(fileText).flatMap((line) => {
    const forwardedFieldMatch = forwardedFieldLinePattern.exec(line);
    if (forwardedFieldMatch === null) return [];
    return [forwardedFieldMatch[2]];
  });
}

function collectStatedFieldNames(fileTexts) {
  const statedFieldNames = new Set();
  for (const fileText of fileTexts) {
    for (const line of splitFileLines(fileText)) {
      const statedFieldMatch = statedFieldLinePattern.exec(line);
      if (statedFieldMatch === null) continue;
      statedFieldNames.add(statedFieldMatch[1].trim());
    }
  }
  return statedFieldNames;
}

function isLuhnValid(digitRun) {
  let checksum = 0;
  let shouldDoubleDigit = false;
  for (let digitIndex = digitRun.length - 1; digitIndex >= 0; digitIndex -= 1) {
    let digit = Number(digitRun[digitIndex]);
    if (shouldDoubleDigit) digit *= 2;
    if (digit > 9) digit -= 9;
    checksum += digit;
    shouldDoubleDigit = !shouldDoubleDigit;
  }
  return checksum % 10 === 0;
}

function isDigitCharacter(character) {
  return character !== undefined && character >= '0' && character <= '9';
}

function hasLuhnValidPaddedWindow(digitRun) {
  if (digitRun.length <= longestCardDigitCount) return false;
  for (let windowStart = 0; windowStart + shortestCardDigitCount <= digitRun.length; windowStart += 1) {
    for (let windowLength = shortestCardDigitCount; windowLength <= longestCardDigitCount; windowLength += 1) {
      if (windowStart + windowLength > digitRun.length) break;
      if (isLuhnValid(digitRun.slice(windowStart, windowStart + windowLength))) return true;
    }
  }
  return false;
}

function hasLuhnValidSubGroupSpan(subGroups) {
  for (let firstSubGroupIndex = 0; firstSubGroupIndex < subGroups.length; firstSubGroupIndex += 1) {
    let spannedDigits = '';
    for (let lastSubGroupIndex = firstSubGroupIndex; lastSubGroupIndex < subGroups.length; lastSubGroupIndex += 1) {
      spannedDigits += subGroups[lastSubGroupIndex];
      if (spannedDigits.length > longestCardDigitCount) break;
      if (spannedDigits.length < shortestCardDigitCount) continue;
      if (isLuhnValid(spannedDigits)) return true;
    }
  }
  return subGroups.some(hasLuhnValidPaddedWindow);
}

export function hasLuhnValidCardNumber(fileText) {
  let subGroups = [];
  let currentSubGroup = '';
  let groupSeparator = null;
  for (let characterIndex = 0; characterIndex < fileText.length; characterIndex += 1) {
    const character = fileText[characterIndex];
    if (isDigitCharacter(character)) {
      currentSubGroup += character;
      continue;
    }
    const separatesTwoDigitGroups = currentSubGroup.length > 0
      && digitGroupSeparators.has(character)
      && isDigitCharacter(fileText[characterIndex + 1]);
    const joinsTheSameGroup = separatesTwoDigitGroups && (groupSeparator === null || groupSeparator === character);
    if (joinsTheSameGroup) {
      groupSeparator = character;
      subGroups.push(currentSubGroup);
      currentSubGroup = '';
      continue;
    }
    if (hasLuhnValidSubGroupSpan([...subGroups, currentSubGroup])) return true;
    if (separatesTwoDigitGroups) {
      subGroups = [currentSubGroup];
      currentSubGroup = '';
      groupSeparator = character;
      continue;
    }
    subGroups = [];
    currentSubGroup = '';
    groupSeparator = null;
  }
  return hasLuhnValidSubGroupSpan([...subGroups, currentSubGroup]);
}

function hasLongMixedAlphanumericRun(textOutsideUrls) {
  const longRuns = textOutsideUrls.match(longMixedRunPattern) ?? [];
  return longRuns.some((longRun) => letterPattern.test(longRun) && digitPattern.test(longRun));
}

function hasCredentialShapedText(fileText) {
  if (prefixedCredentialPatterns.some((credentialPattern) => credentialPattern.test(fileText))) return true;
  const textOutsideUrls = fileText.replace(urlTokenPattern, ' ');
  if (longDigitRunPattern.test(textOutsideUrls)) return true;
  return hasLongMixedAlphanumericRun(textOutsideUrls);
}

function isContextDigestPath(relativePath) {
  return relativePath.startsWith(contextPathPrefix) || relativePath.startsWith(archiveContextPathPrefix);
}

function hasCredentialBearingText(relativePath, fileText) {
  if (isContextDigestPath(relativePath)) return hasCredentialShapedText(fileText);
  if (!relativePath.startsWith(profilePathPrefix)) return false;
  return findForwardedFieldValues(fileText).some(hasCredentialShapedText);
}

export function findFileContentViolations(relativePath, fileText) {
  const reasons = [
    ...(isAllowedMemoryFilePath(relativePath) ? [] : [disallowedPathReason]),
    ...findProfileGrammarReasons(relativePath, fileText),
    ...findContextDigestReasons(relativePath, fileText),
    ...(hasLuhnValidCardNumber(fileText) ? ['carries a card number'] : []),
    ...(hasCredentialBearingText(relativePath, fileText) ? ['carries a credential, token, or long digit run'] : [])
  ];
  return reasons.map((reason) => createViolation(relativePath, reason));
}

function resolveArchivePathForProfile(relativePath) {
  return `${archivePathPrefix}${path.posix.basename(relativePath)}`;
}

function isFactStillCarried(beforeFieldLine, afterFieldLine, afterLines, archiveLines) {
  if (afterLines.has(beforeFieldLine.line)) return true;
  if (archiveLines.has(beforeFieldLine.line)) return true;
  return afterFieldLine !== undefined && afterFieldLine.statedOn >= beforeFieldLine.statedOn;
}

export function findDroppedStatedFieldViolations(relativePath, beforeText, afterText, archiveText) {
  if (!relativePath.startsWith(profilePathPrefix)) return [];
  const afterLines = new Set(splitFileLines(afterText));
  const archiveLines = new Set(splitFileLines(archiveText));
  const afterFieldLinesByName = findFieldLinesByName(afterText);
  const archivePath = resolveArchivePathForProfile(relativePath);
  return listStatedFieldLines(beforeText)
    .filter((beforeFieldLine) => !isFactStillCarried(beforeFieldLine, afterFieldLinesByName.get(beforeFieldLine.fieldName), afterLines, archiveLines))
    .map(({ fieldName }) => createViolation(relativePath, `drops the stated field ${fieldName}; restate it with a date no older or move the line verbatim into ${describeMemoryPath(archivePath)}`));
}

export function findDroppedArchiveLineViolations(relativePath, beforeText, afterText) {
  if (!relativePath.startsWith(archivePathPrefix)) return [];
  const afterLines = new Set(splitFileLines(afterText));
  const droppedFieldLinesByLine = new Map(listStatedFieldLines(beforeText)
    .filter((beforeFieldLine) => !afterLines.has(beforeFieldLine.line))
    .map((droppedFieldLine) => [droppedFieldLine.line, droppedFieldLine]));
  return [...droppedFieldLinesByLine.values()]
    .map(({ fieldName }) => createViolation(relativePath, `drops the archived stated line for ${fieldName}; archived stated lines are never removed`));
}

function isFactScopePath(relativePath) {
  if (relativePath.startsWith(archiveContextPathPrefix)) return false;
  return relativePath.startsWith(profilePathPrefix) || relativePath.startsWith(archivePathPrefix);
}

function findDowngradedFieldViolations(relativePath, forwardedFieldNames, statedFieldNames) {
  return [...forwardedFieldNames]
    .filter((fieldName) => statedFieldNames.has(fieldName))
    .map((fieldName) => createViolation(relativePath, `gives the field ${fieldName} a forwarded value, but John stated that field; write the forwarded value as context instead`));
}

function classifyByteTotal(relativePath) {
  if (!relativePath.endsWith('.md')) return null;
  if (relativePath.startsWith(archivePathPrefix)) return null;
  if (relativePath.startsWith(contextPathPrefix)) return 'contextByteTotal';
  return 'memoryByteTotal';
}

function sumByteTotals(byteCountsByPath) {
  const byteTotals = { memoryByteTotal: 0, contextByteTotal: 0 };
  for (const [relativePath, byteCount] of byteCountsByPath) {
    const byteTotalName = classifyByteTotal(relativePath);
    if (byteTotalName === null) continue;
    byteTotals[byteTotalName] += byteCount;
  }
  return byteTotals;
}

function findCapViolations(byteTotals, toleratedByteTotals) {
  const violations = [];
  if (byteTotals.memoryByteTotal > memoryByteCap && byteTotals.memoryByteTotal > toleratedByteTotals.memoryByteTotal) {
    violations.push(createViolation('', `is over the ${memoryByteCap} byte cap at ${byteTotals.memoryByteTotal} bytes; compact memory/ first`));
  }
  if (byteTotals.contextByteTotal > contextByteCap && byteTotals.contextByteTotal > toleratedByteTotals.contextByteTotal) {
    violations.push(createViolation('context', `is over the ${contextByteCap} byte cap at ${byteTotals.contextByteTotal} bytes; let the housekeep timer evict the oldest digests`));
  }
  return violations;
}

function measureTextByteCounts(fileTextsByPath) {
  return new Map([...fileTextsByPath].map(([relativePath, fileText]) => [relativePath, Buffer.byteLength(fileText)]));
}

function walkMemoryDirectory(directoryPath, relativePrefix, shouldDescend) {
  return fs.readdirSync(directoryPath, { withFileTypes: true }).flatMap((directoryEntry) => {
    const relativePath = `${relativePrefix}${directoryEntry.name}`;
    const absolutePath = path.join(directoryPath, directoryEntry.name);
    if (directoryEntry.isDirectory() && !shouldDescend(relativePath)) return [];
    if (directoryEntry.isDirectory()) return walkMemoryDirectory(absolutePath, `${relativePath}/`, shouldDescend);
    return [{ relativePath, absolutePath, directoryEntry }];
  });
}

function descendIntoEveryDirectory() {
  return true;
}

function readMemoryTree(memoryDirectory) {
  const fileTextsByPath = new Map();
  const irregularPaths = [];
  for (const { relativePath, absolutePath, directoryEntry } of walkMemoryDirectory(memoryDirectory, '', descendIntoEveryDirectory)) {
    if (!directoryEntry.isFile() || !isRegularNonExecutableFile(fs.lstatSync(absolutePath))) {
      irregularPaths.push(relativePath);
      continue;
    }
    fileTextsByPath.set(relativePath, fs.readFileSync(absolutePath, 'utf8'));
  }
  return { fileTextsByPath, irregularPaths };
}

function findChangedProfilePaths(previousFileTextsByPath, currentFileTextsByPath) {
  return [...currentFileTextsByPath]
    .filter(([relativePath, fileText]) => relativePath.startsWith(profilePathPrefix) && previousFileTextsByPath.get(relativePath) !== fileText)
    .map(([relativePath]) => relativePath);
}

function findStateDowngradeViolations(previousFileTextsByPath, currentFileTextsByPath) {
  const forwardedFieldNamesByPath = findChangedProfilePaths(previousFileTextsByPath, currentFileTextsByPath)
    .map((relativePath) => [relativePath, findForwardedFieldNames(currentFileTextsByPath.get(relativePath))])
    .filter(([, forwardedFieldNames]) => forwardedFieldNames.size > 0);
  if (forwardedFieldNamesByPath.length === 0) return [];
  const factScopeTexts = [...previousFileTextsByPath, ...currentFileTextsByPath]
    .filter(([relativePath]) => isFactScopePath(relativePath))
    .map(([, fileText]) => fileText);
  const statedFieldNames = collectStatedFieldNames(factScopeTexts);
  return forwardedFieldNamesByPath.flatMap(([relativePath, forwardedFieldNames]) => findDowngradedFieldViolations(relativePath, forwardedFieldNames, statedFieldNames));
}

function findStateRemovalViolations(previousFileTextsByPath, currentFileTextsByPath) {
  return [...previousFileTextsByPath].flatMap(([relativePath, previousText]) => {
    const currentText = currentFileTextsByPath.get(relativePath) ?? '';
    if (currentText === previousText) return [];
    const archiveText = currentFileTextsByPath.get(resolveArchivePathForProfile(relativePath)) ?? '';
    return [
      ...findDroppedStatedFieldViolations(relativePath, previousText, currentText, archiveText),
      ...findDroppedArchiveLineViolations(relativePath, previousText, currentText)
    ];
  });
}

export function findMemoryStateViolations(previousFileTextsByPath, currentTree) {
  const { fileTextsByPath, irregularPaths } = currentTree;
  const previousContextByteTotal = sumByteTotals(measureTextByteCounts(previousFileTextsByPath)).contextByteTotal;
  return [
    ...irregularPaths.map((relativePath) => createViolation(relativePath, irregularFileReason)),
    ...[...fileTextsByPath].flatMap(([relativePath, fileText]) => findFileContentViolations(relativePath, fileText)),
    ...findStateRemovalViolations(previousFileTextsByPath, fileTextsByPath),
    ...findStateDowngradeViolations(previousFileTextsByPath, fileTextsByPath),
    ...findCapViolations(sumByteTotals(measureTextByteCounts(fileTextsByPath)), { memoryByteTotal: 0, contextByteTotal: previousContextByteTotal })
  ];
}

function readLinkStatsOrNull(absolutePath) {
  try {
    return fs.lstatSync(absolutePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function readTextOrEmpty(absolutePath) {
  try {
    return fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
}

function isInsideOrEqualDirectory(directoryPath, candidatePath) {
  return candidatePath === directoryPath || isPathInsideDirectory(directoryPath, candidatePath);
}

function resolveRealPathThroughNearestExistingAncestor(absolutePath) {
  const missingSegments = [];
  let existingAncestorPath = absolutePath;
  for (;;) {
    try {
      return path.join(fs.realpathSync(existingAncestorPath), ...missingSegments.toReversed());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parentPath = path.dirname(existingAncestorPath);
      if (parentPath === existingAncestorPath) return absolutePath;
      missingSegments.push(path.basename(existingAncestorPath));
      existingAncestorPath = parentPath;
    }
  }
}

function toPosixRelativePath(directoryPath, candidatePath) {
  return path.relative(directoryPath, candidatePath).split(path.sep).join('/');
}

export function isLexicallyInsideMemory(memoryDirectory, absoluteFilePath) {
  return isInsideOrEqualDirectory(path.resolve(memoryDirectory), path.resolve(absoluteFilePath));
}

export function resolveMemoryRelativePath(memoryDirectory, absoluteFilePath) {
  const lexicalMemoryDirectory = path.resolve(memoryDirectory);
  const lexicalFilePath = path.resolve(absoluteFilePath);
  const realMemoryDirectory = resolveRealPathThroughNearestExistingAncestor(lexicalMemoryDirectory);
  const realFilePath = resolveRealPathThroughNearestExistingAncestor(lexicalFilePath);
  const isLexicallyInside = isInsideOrEqualDirectory(lexicalMemoryDirectory, lexicalFilePath);
  const isReallyInside = isInsideOrEqualDirectory(realMemoryDirectory, realFilePath);
  if (!isLexicallyInside && !isReallyInside) return { isMemoryPath: false };
  if (isLexicallyInside) return { isMemoryPath: true, relativePath: toPosixRelativePath(lexicalMemoryDirectory, lexicalFilePath), resolvesOutsideMemory: !isReallyInside };
  return { isMemoryPath: true, relativePath: toPosixRelativePath(realMemoryDirectory, realFilePath), resolvesOutsideMemory: false };
}

export function inspectMemoryWriteTarget(memoryDirectory, relativePath) {
  if (!isAllowedMemoryFilePath(relativePath)) return { violations: [createViolation(relativePath, disallowedPathReason)], currentText: null };
  const targetPath = path.join(memoryDirectory, relativePath);
  const targetStats = readLinkStatsOrNull(targetPath);
  if (targetStats === null) return { violations: [], currentText: null };
  if (!isRegularNonExecutableFile(targetStats)) return { violations: [createViolation(relativePath, irregularFileReason)], currentText: null };
  return { violations: [], currentText: fs.readFileSync(targetPath, 'utf8') };
}

function isOutsideArchive(relativePath) {
  return relativePath !== archiveDirectoryName;
}

function measureDiskByteCounts(memoryDirectory) {
  const byteCountsByPath = new Map();
  for (const { relativePath, absolutePath, directoryEntry } of walkMemoryDirectory(memoryDirectory, '', isOutsideArchive)) {
    if (!directoryEntry.isFile()) continue;
    byteCountsByPath.set(relativePath, fs.lstatSync(absolutePath).size);
  }
  return byteCountsByPath;
}

function isFactScopeDirectory(relativePath) {
  if (relativePath === 'archive/context') return false;
  return relativePath.startsWith('profile') || relativePath.startsWith(archiveDirectoryName);
}

function readFactScopeTexts(memoryDirectory) {
  return walkMemoryDirectory(memoryDirectory, '', isFactScopeDirectory)
    .filter(({ relativePath, directoryEntry }) => directoryEntry.isFile() && isFactScopePath(relativePath))
    .map(({ absolutePath }) => fs.readFileSync(absolutePath, 'utf8'));
}

function findWriteDowngradeViolations(memoryDirectory, relativePath, proposedText) {
  if (!relativePath.startsWith(profilePathPrefix)) return [];
  const forwardedFieldNames = findForwardedFieldNames(proposedText);
  if (forwardedFieldNames.size === 0) return [];
  const statedFieldNames = collectStatedFieldNames([...readFactScopeTexts(memoryDirectory), proposedText]);
  return findDowngradedFieldViolations(relativePath, forwardedFieldNames, statedFieldNames);
}

function findWriteCapViolations(memoryDirectory, relativePath, proposedText) {
  const currentByteCountsByPath = measureDiskByteCounts(memoryDirectory);
  const currentByteTotals = sumByteTotals(currentByteCountsByPath);
  const proposedByteCountsByPath = new Map(currentByteCountsByPath).set(relativePath, Buffer.byteLength(proposedText));
  return findCapViolations(sumByteTotals(proposedByteCountsByPath), currentByteTotals);
}

function findWriteDroppedFieldViolations(memoryDirectory, relativePath, beforeText, proposedText) {
  if (!relativePath.startsWith(profilePathPrefix)) return [];
  const archiveText = readTextOrEmpty(path.join(memoryDirectory, resolveArchivePathForProfile(relativePath)));
  return findDroppedStatedFieldViolations(relativePath, beforeText, proposedText, archiveText);
}

export function findMemoryWriteViolations({ memoryDirectory, relativePath, currentText, proposedText }) {
  const beforeText = currentText ?? '';
  return [
    ...findFileContentViolations(relativePath, proposedText),
    ...findWriteDroppedFieldViolations(memoryDirectory, relativePath, beforeText, proposedText),
    ...findDroppedArchiveLineViolations(relativePath, beforeText, proposedText),
    ...findWriteDowngradeViolations(memoryDirectory, relativePath, proposedText),
    ...findWriteCapViolations(memoryDirectory, relativePath, proposedText)
  ];
}

export function createMemoryWriteInspector(memoryDirectory) {
  return {
    resolveTarget: (absoluteFilePath) => resolveMemoryRelativePath(memoryDirectory, absoluteFilePath),
    inspectTarget: (relativePath) => inspectMemoryWriteTarget(memoryDirectory, relativePath),
    findViolations: ({ relativePath, currentText, proposedText }) => findMemoryWriteViolations({ memoryDirectory, relativePath, currentText, proposedText })
  };
}

function resolveSnapshotRootDirectory(environment) {
  return path.join(resolveAssistantStateDirectory(environment), snapshotDirectoryName);
}

function listSnapshotNames(snapshotRootDirectory) {
  return fs.readdirSync(snapshotRootDirectory, { withFileTypes: true })
    .filter((directoryEntry) => directoryEntry.isDirectory() && snapshotDirectoryNamePattern.test(directoryEntry.name))
    .map((directoryEntry) => directoryEntry.name)
    .sort();
}

function readNewestSnapshot(snapshotRootDirectory) {
  const newestSnapshotName = listSnapshotNames(snapshotRootDirectory).at(-1);
  if (newestSnapshotName === undefined) return new Map();
  return readMemoryTree(path.join(snapshotRootDirectory, newestSnapshotName)).fileTextsByPath;
}

function createPrivateDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true, mode: privateDirectoryMode });
  fs.chmodSync(directoryPath, privateDirectoryMode);
}

function writeSnapshot(snapshotRootDirectory, snapshotName, fileTextsByPath) {
  const stagingDirectory = path.join(snapshotRootDirectory, `.${snapshotName}-${process.pid}`);
  fs.rmSync(stagingDirectory, { recursive: true, force: true });
  createPrivateDirectory(stagingDirectory);
  for (const [relativePath, fileText] of fileTextsByPath) {
    const snapshotFilePath = path.join(stagingDirectory, relativePath);
    createPrivateDirectory(path.dirname(snapshotFilePath));
    fs.writeFileSync(snapshotFilePath, fileText, { mode: privateFileMode });
  }
  const snapshotDirectory = path.join(snapshotRootDirectory, snapshotName);
  fs.rmSync(snapshotDirectory, { recursive: true, force: true });
  fs.renameSync(stagingDirectory, snapshotDirectory);
  return snapshotDirectory;
}

function pruneSnapshots(snapshotRootDirectory) {
  const snapshotNames = listSnapshotNames(snapshotRootDirectory);
  const expiredSnapshotNames = snapshotNames.slice(0, Math.max(0, snapshotNames.length - retainedSnapshotCount));
  for (const expiredSnapshotName of expiredSnapshotNames) {
    fs.rmSync(path.join(snapshotRootDirectory, expiredSnapshotName), { recursive: true, force: true });
  }
  return expiredSnapshotNames.length;
}

export function snapshotMemory({ memoryDirectory, snapshotRootDirectory, today }) {
  createPrivateDirectory(snapshotRootDirectory);
  const currentTree = readMemoryTree(memoryDirectory);
  const violations = findMemoryStateViolations(readNewestSnapshot(snapshotRootDirectory), currentTree);
  if (violations.length > 0) {
    logEvent('memory', 'snapshot_refused', { violation_count: violations.length });
    return { violations };
  }
  const snapshotDirectory = writeSnapshot(snapshotRootDirectory, today, currentTree.fileTextsByPath);
  const prunedSnapshotCount = pruneSnapshots(snapshotRootDirectory);
  logEvent('memory', 'snapshot_written', { file_count: currentTree.fileTextsByPath.size, pruned_count: prunedSnapshotCount });
  return { violations, snapshotDirectory, fileCount: currentTree.fileTextsByPath.size };
}

export async function runMemoryCheckCommand(commandArguments, { environment = process.env, now = new Date(), writeOutput = console.log, writeError = console.error } = {}) {
  if (commandArguments.length !== 1 || commandArguments[0] !== 'snapshot') {
    writeError('usage: memory-check.mjs snapshot');
    return addUsageExitCode;
  }
  const snapshotOutcome = snapshotMemory({
    memoryDirectory: resolveMemoryDirectory(environment),
    snapshotRootDirectory: resolveSnapshotRootDirectory(environment),
    today: localCalendarDate(now)
  });
  if (snapshotOutcome.violations.length > 0) {
    snapshotOutcome.violations.forEach((violation) => writeError(formatViolation(violation)));
    return memoryViolationExitCode;
  }
  writeOutput(`snapshot ${snapshotOutcome.snapshotDirectory}: ${snapshotOutcome.fileCount} files`);
  return 0;
}

if (isMainModule(import.meta.url)) runCommandLine(runMemoryCheckCommand);
