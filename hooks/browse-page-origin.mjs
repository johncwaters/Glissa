import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { resolveAssistantStateDirectory } from '../scripts/assistant-state-directory.mjs';
import { isMainModule } from '../scripts/command-line.mjs';
import { isPathInsideDirectory } from '../scripts/serve-results.mjs';
import { readHookPayload } from './hook-payload.mjs';

const browseToolPrefix = 'mcp__browser__';
const responseSectionPattern = /^### /m;
const pageSectionName = 'Page';
const pageUrlLinePattern = /^- Page URL:[^\S\n]*(\S+)[^\S\n]*$/;
const snapshotSectionName = 'Snapshot';
const modalStateSectionName = 'Modal state';
const snapshotLinkLinePattern = /^- \[Snapshot\]\((.+)\)$/;
const snapshotToolName = 'browser_snapshot';
const tabsToolName = 'browser_tabs';
const snapshotFieldNamesThatCurateTheTree = ['target', 'depth', 'filename', 'boxes'];
const snapshotFileNameThePlaywrightServerWritesPattern = /^page-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.yml$/;
const fenceMarker = '```';
const browseOriginFileEnvironmentVariable = 'ASSISTANT_BROWSE_ORIGIN_FILE';
const browseOriginFileName = 'browse-origin.json';
const browsePageTextFileEnvironmentVariable = 'ASSISTANT_BROWSE_PAGE_TEXT_FILE';
const browsePageTextFileName = 'browse-page-text.json';
const browserOutputDirectoryName = 'browser';
const noPageText = '';

export const recordedPageOriginMaxAgeMs = 2 * 60 * 1000;
export const recordedPageOriginClockToleranceMs = 60 * 1000;
export const recordedPageTextMaxLength = 120_000;

export const browserToolsThatRenderPageState = new Set([
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_press_key',
  'browser_select_option',
  'browser_drag',
  'browser_hover',
  'browser_wait_for',
  'browser_tabs'
]);

export const browserToolsWhoseEveryResultCarriesASnapshot = new Set([
  'browser_click',
  'browser_drag',
  'browser_drop',
  'browser_file_upload',
  'browser_hover',
  'browser_mouse_click_xy',
  'browser_mouse_drag_xy',
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_reload',
  'browser_select_option',
  'browser_stop_recording',
  'browser_wait_for'
]);

export function resolveBrowseOriginFilePath(environment = process.env) {
  if (environment[browseOriginFileEnvironmentVariable]) return environment[browseOriginFileEnvironmentVariable];
  return join(resolveAssistantStateDirectory(environment), browseOriginFileName);
}

export function resolveBrowsePageTextFilePath(environment = process.env) {
  if (environment[browsePageTextFileEnvironmentVariable]) return environment[browsePageTextFileEnvironmentVariable];
  return join(resolveAssistantStateDirectory(environment), browsePageTextFileName);
}

function resolveBrowserOutputDirectory(environment = process.env) {
  return join(resolveAssistantStateDirectory(environment), browserOutputDirectoryName);
}

function collectToolResponseText(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  if (Array.isArray(toolResponse)) return toolResponse.map(collectToolResponseText).join('\n');
  if (!toolResponse || typeof toolResponse !== 'object') return '';
  if (typeof toolResponse.text === 'string') return toolResponse.text;
  if (Object.hasOwn(toolResponse, 'content')) return collectToolResponseText(toolResponse.content);
  return '';
}

function collectToolResultText(payload) {
  return [payload.tool_response, payload.error].map(collectToolResponseText).join('\n');
}

function readHostOrNull(urlText) {
  try {
    const destination = new URL(urlText);
    if (destination.hostname.length === 0) return null;
    return destination.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function splitResponseSections(toolResponseText) {
  return toolResponseText
    .split(responseSectionPattern)
    .slice(1)
    .map((sectionText) => {
      const firstNewlineIndex = sectionText.indexOf('\n');
      if (firstNewlineIndex === -1) return null;
      return { name: sectionText.slice(0, firstNewlineIndex), content: sectionText.slice(firstNewlineIndex + 1) };
    })
    .filter((section) => section !== null);
}

function readPageSectionUrl(pageSection) {
  const [firstContentLine] = pageSection.content.split('\n', 1);
  const pageUrlMatch = pageUrlLinePattern.exec(firstContentLine);
  if (!pageUrlMatch) return null;
  return pageUrlMatch[1];
}

function readPageSectionHost(pageSection) {
  const pageUrl = readPageSectionUrl(pageSection);
  if (pageUrl === null) return null;
  return readHostOrNull(pageUrl);
}

function findSectionsNamed(toolResponseText, sectionName) {
  if (typeof toolResponseText !== 'string') return [];
  return splitResponseSections(toolResponseText).filter((section) => section.name === sectionName);
}

export function findPageSections(toolResponseText) {
  return findSectionsNamed(toolResponseText, pageSectionName);
}

function readAgreedPageHost(pageSections) {
  const claimedHosts = new Set(pageSections.map(readPageSectionHost));
  if (claimedHosts.size !== 1) return null;
  return [...claimedHosts][0];
}

export function findOpenPageHost(toolResponseText) {
  const pageSections = findPageSections(toolResponseText);
  if (pageSections.length === 0) return null;
  return readAgreedPageHost(pageSections);
}

function readFileText(filePath) {
  return readFileSync(filePath, 'utf8');
}

function writeRecordFile(recordFilePath, recordFields, readClockMs) {
  mkdirSync(dirname(recordFilePath), { recursive: true, mode: 0o700 });
  const record = { ...recordFields, recordedAt: new Date(readClockMs()).toISOString() };
  writeFileSync(recordFilePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function readFreshRecordOrNull(recordFilePath, readClockMs, readRecordFile) {
  let record;
  try {
    record = JSON.parse(readRecordFile(recordFilePath));
  } catch {
    return null;
  }
  const recordedAtMs = Date.parse(record?.recordedAt);
  if (!Number.isFinite(recordedAtMs)) return null;
  const recordAgeMs = readClockMs() - recordedAtMs;
  if (recordAgeMs < -recordedPageOriginClockToleranceMs) return null;
  if (recordAgeMs > recordedPageOriginMaxAgeMs) return null;
  return record;
}

export function recordPageHost(pageHostOrNull, { environment = process.env, readClockMs = Date.now } = {}) {
  writeRecordFile(resolveBrowseOriginFilePath(environment), { host: pageHostOrNull }, readClockMs);
}

export function readRecordedPageHost({
  environment = process.env,
  readClockMs = Date.now,
  readOriginFile = readFileText
} = {}) {
  const record = readFreshRecordOrNull(resolveBrowseOriginFilePath(environment), readClockMs, readOriginFile);
  const recordedHost = record?.host;
  if (typeof recordedHost !== 'string' || recordedHost.length === 0) return null;
  return recordedHost.toLowerCase();
}

function recordPageText(pageTextRecord, { environment = process.env, readClockMs = Date.now } = {}) {
  writeRecordFile(resolveBrowsePageTextFilePath(environment), pageTextRecord, readClockMs);
}

function findRealPathOrNull(candidatePath) {
  try {
    return realpathSync(candidatePath);
  } catch {
    return null;
  }
}

function readSnapshotFileInsideBrowserOutput(snapshotFilePath, environment, readSnapshotFile) {
  if (typeof snapshotFilePath !== 'string' || snapshotFilePath.length === 0) return noPageText;
  const browserOutputDirectory = findRealPathOrNull(resolveBrowserOutputDirectory(environment));
  if (browserOutputDirectory === null) return noPageText;
  const realSnapshotFilePath = findRealPathOrNull(snapshotFilePath);
  if (realSnapshotFilePath === null) return noPageText;
  if (!isPathInsideDirectory(browserOutputDirectory, realSnapshotFilePath)) return noPageText;
  try {
    return readSnapshotFile(realSnapshotFilePath);
  } catch {
    return noPageText;
  }
}

export function readRecordedPageText({
  environment = process.env,
  readClockMs = Date.now,
  readPageTextFile = readFileText,
  readSnapshotFile = readFileText
} = {}) {
  const record = readFreshRecordOrNull(resolveBrowsePageTextFilePath(environment), readClockMs, readPageTextFile);
  if (record === null) return noPageText;
  if (typeof record.pageText === 'string') return record.pageText.slice(0, recordedPageTextMaxLength);
  const snapshotText = readSnapshotFileInsideBrowserOutput(record.snapshotFilePath, environment, readSnapshotFile);
  return snapshotText.slice(0, recordedPageTextMaxLength);
}

function keepRecordedPageHost(options) {
  const recordedHost = readRecordedPageHost(options);
  if (recordedHost === null) return;
  recordPageHost(recordedHost, options);
}

export function recordPageHostFromBrowserResult(browserToolName, toolResultText, options = {}) {
  const pageSections = findPageSections(toolResultText);
  if (pageSections.length === 0) return keepRecordedPageHost(options);
  if (!browserToolsThatRenderPageState.has(browserToolName)) return recordPageHost(null, options);
  return recordPageHost(readAgreedPageHost(pageSections), options);
}

function readInlineSnapshotText(sectionLines) {
  const openingFenceIndex = sectionLines.findIndex((sectionLine) => sectionLine.trimStart().startsWith(fenceMarker));
  if (openingFenceIndex === -1) return sectionLines.join('\n').trim();
  const linesAfterOpeningFence = sectionLines.slice(openingFenceIndex + 1);
  const closingFenceIndex = linesAfterOpeningFence.findIndex((sectionLine) => sectionLine.trim() === fenceMarker);
  if (closingFenceIndex === -1) return linesAfterOpeningFence.join('\n').trim();
  return linesAfterOpeningFence.slice(0, closingFenceIndex).join('\n');
}

function readSnapshotLinkRecord(snapshotLinkPath, environment) {
  const snapshotFileName = basename(snapshotLinkPath.trim());
  if (!snapshotFileNameThePlaywrightServerWritesPattern.test(snapshotFileName)) return { pageText: noPageText };
  return { snapshotFilePath: join(resolveBrowserOutputDirectory(environment), snapshotFileName) };
}

const forgedSnapshotSection = null;

function readSnapshotRecord(browserToolName, snapshotSection, environment) {
  const sectionLines = snapshotSection.content.split('\n');
  const firstFilledLine = sectionLines.find((sectionLine) => sectionLine.trim().length > 0) ?? '';
  const snapshotLinkMatch = snapshotLinkLinePattern.exec(firstFilledLine.trim());
  if (snapshotLinkMatch) {
    if (!browserToolsWhoseEveryResultCarriesASnapshot.has(browserToolName)) return forgedSnapshotSection;
    return readSnapshotLinkRecord(snapshotLinkMatch[1], environment);
  }
  if (browserToolName !== snapshotToolName) return forgedSnapshotSection;
  return { pageText: readInlineSnapshotText(sectionLines) };
}

function clearRecordedPageText(options) {
  recordPageText({ pageText: noPageText }, options);
}

function browserSnapshotCallCuratesTheTree(browserToolInput) {
  if (!browserToolInput || typeof browserToolInput !== 'object') return false;
  return snapshotFieldNamesThatCurateTheTree.some(
    (fieldName) => browserToolInput[fieldName] !== undefined && browserToolInput[fieldName] !== null
  );
}

export function recordPageTextFromBrowserResult(browserToolName, toolResultText, options = {}) {
  if (!browserToolsThatRenderPageState.has(browserToolName)) return;
  if (browserToolName === tabsToolName) return clearRecordedPageText(options);
  if (browserToolName === snapshotToolName && browserSnapshotCallCuratesTheTree(options.browserToolInput)) {
    return clearRecordedPageText(options);
  }
  if (findSectionsNamed(toolResultText, modalStateSectionName).length > 0) return clearRecordedPageText(options);
  const snapshotSections = findSectionsNamed(toolResultText, snapshotSectionName);
  if (snapshotSections.length !== 1) return clearRecordedPageText(options);
  const environment = options.environment ?? process.env;
  const snapshotRecord = readSnapshotRecord(browserToolName, snapshotSections[0], environment);
  if (snapshotRecord === forgedSnapshotSection) return clearRecordedPageText(options);
  return recordPageText(snapshotRecord, options);
}

async function run() {
  let payload;
  try {
    payload = await readHookPayload();
  } catch {
    return;
  }
  if (typeof payload?.tool_name !== 'string' || !payload.tool_name.startsWith(browseToolPrefix)) return;
  const browserToolName = payload.tool_name.slice(browseToolPrefix.length);
  try {
    const toolResultText = collectToolResultText(payload);
    recordPageHostFromBrowserResult(browserToolName, toolResultText);
    recordPageTextFromBrowserResult(browserToolName, toolResultText, { browserToolInput: payload.tool_input });
  } catch {
    return;
  }
}

if (isMainModule(import.meta.url)) await run();
