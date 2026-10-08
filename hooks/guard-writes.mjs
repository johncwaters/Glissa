import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { judgeBrowseAction, readOperatorTurn } from './browse-judge.mjs';
import { readRecordedPageHost } from './browse-page-origin.mjs';
import {
  carriesStatedProvenance,
  decideToolPermission,
  plainEventRecurrence,
  seriesMasterEventRecurrence,
  seriesOccurrenceEventRecurrence,
  unreadableEventRecurrence
} from './guard-writes-core.mjs';
import { readHookPayload } from './hook-payload.mjs';
import { readChatRecords } from '../scripts/chat-log.mjs';
import { getContentFilePath, getScheduledAt } from '../scripts/content.mjs';
import { readJsonFileSync } from '../scripts/json-file.mjs';
import { logEvent } from '../scripts/log.mjs';
import { createMemoryWriteInspector, resolveMemoryDirectory } from '../scripts/memory-check.mjs';
import { isPlainObject } from '../scripts/object-fields.mjs';
import { resolveRepositoryPath } from '../scripts/repository-path.mjs';

const unreadableHookPayloadReason = 'Write policy denies unreadable hook payload.';
const browseDomainsFileEnvironmentVariable = 'GLISSA_BROWSE_DOMAINS_FILE';
const browseDomainsFileName = 'browse-domains.json';
const calendarAllowFileEnvironmentVariable = 'GLISSA_CALENDAR_ALLOW_FILE';
const calendarAllowFileName = 'calendar-allow.json';
const memoryDirectoryNamesOutsideContactLookup = new Set(['context', 'archive']);
const markdownFileExtension = '.md';
const calendarWrapperEnvironmentVariable = 'GLISSA_CALENDAR_WRAPPER';
const calendarWrapperFilePath = 'scripts/gog-calendar.sh';
const calendarReadTimeoutEnvironmentVariable = 'GLISSA_CALENDAR_READ_TIMEOUT_MS';
const maxCalendarReadTimeoutMs = 20_000;
const calendarReadKillSignal = 'SIGKILL';
const calendarEventEnvelopeKey = 'event';
const calendarReadMaxOutputBytes = 1024 * 1024;
const outboundChatDirection = 'out';
const replyChatRecordKind = 'reply';
const proposalReplyMaxAgeMs = 30 * 60 * 1000;

function resolveBrowseDomainsFilePath(environment) {
  if (environment[browseDomainsFileEnvironmentVariable]) return environment[browseDomainsFileEnvironmentVariable];
  return resolveRepositoryPath(browseDomainsFileName);
}

function readBrowseHosts(environment) {
  try {
    const browseDomainsFile = readJsonFileSync(resolveBrowseDomainsFilePath(environment));
    if (!Array.isArray(browseDomainsFile?.hosts)) return new Set();
    return new Set(
      browseDomainsFile.hosts
        .filter((host) => typeof host === 'string' && host.length > 0)
        .map((host) => host.toLowerCase())
    );
  } catch {
    return new Set();
  }
}

function resolveCalendarAllowFilePath(environment) {
  if (environment[calendarAllowFileEnvironmentVariable]) return environment[calendarAllowFileEnvironmentVariable];
  return resolveRepositoryPath(calendarAllowFileName);
}

function readAllowedCalendarIds(environment) {
  try {
    const calendarAllowFile = readJsonFileSync(resolveCalendarAllowFilePath(environment));
    if (!Array.isArray(calendarAllowFile?.calendarIds)) return new Set();
    return new Set(
      calendarAllowFile.calendarIds.filter((calendarId) => typeof calendarId === 'string' && calendarId.length > 0)
    );
  } catch {
    return new Set();
  }
}

function toPlannedBufferPosts(post, timeZone) {
  try {
    const scheduledAtMs = Date.parse(getScheduledAt(post, timeZone));
    return [{ scheduledAtMs, copy: post.copy, fallback: post.fallback, threadFollowUps: post.threadFollowUps }];
  } catch {
    return [];
  }
}

function readPlannedBufferPosts(environment) {
  try {
    const contentPlan = readJsonFileSync(getContentFilePath(environment));
    if (!Array.isArray(contentPlan?.posts)) return null;
    return contentPlan.posts.flatMap((post) => toPlannedBufferPosts(post, contentPlan.timeZone));
  } catch {
    return null;
  }
}

function listContactMarkdownFilePaths(memoryDirectory) {
  return readdirSync(memoryDirectory, { withFileTypes: true }).flatMap((directoryEntry) => {
    const entryPath = join(memoryDirectory, directoryEntry.name);
    if (directoryEntry.isDirectory() && memoryDirectoryNamesOutsideContactLookup.has(directoryEntry.name)) return [];
    if (directoryEntry.isDirectory()) return listContactMarkdownFilePaths(entryPath);
    if (directoryEntry.isFile() && directoryEntry.name.toLowerCase().endsWith(markdownFileExtension)) return [entryPath];
    return [];
  });
}

function readStatedContactText(environment) {
  return listContactMarkdownFilePaths(resolveMemoryDirectory(environment))
    .flatMap((contactFilePath) => readFileSync(contactFilePath, 'utf8').split('\n'))
    .filter(carriesStatedProvenance)
    .join('\n');
}

function resolveCalendarWrapperFilePath(environment) {
  if (environment[calendarWrapperEnvironmentVariable]) return environment[calendarWrapperEnvironmentVariable];
  return resolveRepositoryPath(calendarWrapperFilePath);
}

function resolveCalendarReadTimeoutMs(environment) {
  const requestedTimeoutMs = Number(environment[calendarReadTimeoutEnvironmentVariable]);
  if (Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 && requestedTimeoutMs < maxCalendarReadTimeoutMs) {
    return requestedTimeoutMs;
  }
  return maxCalendarReadTimeoutMs;
}

function createCalendarEventReadArguments(accountAlias, calendarId, eventId) {
  const accountWords = accountAlias === undefined ? [] : ['--account', accountAlias];
  return [...accountWords, 'calendar', 'event', calendarId, eventId, '--json'];
}

function runCalendarEventRead(environment, accountAlias, calendarId, eventId) {
  return execFileSync(
    resolveCalendarWrapperFilePath(environment),
    createCalendarEventReadArguments(accountAlias, calendarId, eventId),
    {
      timeout: resolveCalendarReadTimeoutMs(environment),
      killSignal: calendarReadKillSignal,
      maxBuffer: calendarReadMaxOutputBytes,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }
  );
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function namesRecurrenceRules(recurrenceField) {
  return (
    Array.isArray(recurrenceField) &&
    recurrenceField.length > 0 &&
    recurrenceField.every((recurrenceRule) => typeof recurrenceRule === 'string')
  );
}

function readEventFromEnvelope(envelopeText) {
  const envelope = JSON.parse(envelopeText);
  if (!isPlainObject(envelope)) return null;
  const envelopeKeys = Object.keys(envelope);
  if (envelopeKeys.length !== 1) return null;
  if (envelopeKeys[0] !== calendarEventEnvelopeKey) return null;
  const event = envelope[calendarEventEnvelopeKey];
  if (!isPlainObject(event)) return null;
  return event;
}

function readNamedEventFromEnvelope(envelopeText, eventId) {
  const event = readEventFromEnvelope(envelopeText);
  if (event === null) return null;
  if (typeof event.id !== 'string' || event.id !== eventId) return null;
  return event;
}

function readRecurrenceFromEventJson(envelopeText, eventId) {
  const event = readNamedEventFromEnvelope(envelopeText, eventId);
  if (event === null) return unreadableEventRecurrence;
  const carriesRecurrence = 'recurrence' in event;
  const carriesRecurringEventId = 'recurringEventId' in event;
  if (carriesRecurrence && carriesRecurringEventId) return unreadableEventRecurrence;
  if (carriesRecurrence && namesRecurrenceRules(event.recurrence)) return seriesMasterEventRecurrence;
  if (carriesRecurrence) return unreadableEventRecurrence;
  if (carriesRecurringEventId && isNonEmptyString(event.recurringEventId)) return seriesOccurrenceEventRecurrence;
  if (carriesRecurringEventId) return unreadableEventRecurrence;
  return plainEventRecurrence;
}

function readCalendarEventRecurrence(environment, accountAlias, calendarId, eventId) {
  try {
    return readRecurrenceFromEventJson(
      runCalendarEventRead(environment, accountAlias, calendarId, eventId),
      eventId
    );
  } catch {
    return unreadableEventRecurrence;
  }
}

function readSummaryFromEventJson(envelopeText, eventId) {
  const event = readNamedEventFromEnvelope(envelopeText, eventId);
  if (event === null) return null;
  if (!isNonEmptyString(event.summary)) return null;
  return event.summary;
}

function readCalendarEventSummary(environment, accountAlias, calendarId, eventId) {
  try {
    return readSummaryFromEventJson(runCalendarEventRead(environment, accountAlias, calendarId, eventId), eventId);
  } catch {
    return null;
  }
}

function isReadableAttendee(attendee) {
  return isPlainObject(attendee) && isNonEmptyString(attendee.email);
}

function readAttendeesFromEventJson(envelopeText, eventId) {
  const event = readNamedEventFromEnvelope(envelopeText, eventId);
  if (event === null) return null;
  if (!('attendees' in event)) return [];
  if (!Array.isArray(event.attendees) || !event.attendees.every(isReadableAttendee)) return null;
  return event.attendees.filter((attendee) => attendee.self !== true).map((attendee) => attendee.email);
}

function readCalendarEventAttendees(environment, accountAlias, calendarId, eventId) {
  try {
    return readAttendeesFromEventJson(
      runCalendarEventRead(environment, accountAlias, calendarId, eventId),
      eventId
    );
  } catch {
    return null;
  }
}

function findLastReplyTextBefore(chatRecords, newestMessageSentAtMs) {
  const lastReplyBeforeNewestMessage = chatRecords.findLast(
    (chatRecord) =>
      chatRecord.direction === outboundChatDirection &&
      chatRecord.kind === replyChatRecordKind &&
      Date.parse(chatRecord.ts) < newestMessageSentAtMs
  );
  if (lastReplyBeforeNewestMessage === undefined) return '';
  if (typeof lastReplyBeforeNewestMessage.text !== 'string') return '';
  return lastReplyBeforeNewestMessage.text;
}

function readLastReplyTextBeforeNewestMessage(newestMessageSentAtMs) {
  if (!Number.isFinite(newestMessageSentAtMs)) return '';
  try {
    const chatRecordsInTheProposalWindow = readChatRecords({
      since: new Date(newestMessageSentAtMs - proposalReplyMaxAgeMs)
    });
    return findLastReplyTextBefore(chatRecordsInTheProposalWindow, newestMessageSentAtMs);
  } catch {
    return '';
  }
}

function writeDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }));
}

async function readPayloadOrNull() {
  try {
    return await readHookPayload();
  } catch {
    return null;
  }
}

function hasReadableToolName(payload) {
  return Boolean(payload) && typeof payload.tool_name === 'string' && payload.tool_name.length > 0;
}

function getInputFields(toolInput) {
  if (!isPlainObject(toolInput)) return [];
  return Object.keys(toolInput);
}

function getToolLevelReason(reason) {
  const detailSeparatorIndex = reason.indexOf(':');
  if (detailSeparatorIndex === -1) return reason;
  return `${reason.slice(0, detailSeparatorIndex)}.`;
}

function logDecision(payload, decision) {
  const fields = {
    tool_name: payload.tool_name,
    allow: decision.allow,
    session_id: payload.session_id,
    tool_use_id: payload.tool_use_id,
    input_fields: getInputFields(payload.tool_input)
  };
  if (!decision.allow) fields.reason = getToolLevelReason(decision.reason);
  logEvent('guard', 'decision', fields);
}

function readOperatorTurnWithTheLastReply(transcriptPath) {
  const operatorTurn = readOperatorTurn(transcriptPath);
  return {
    ...operatorTurn,
    lastReplyBeforeNewestMessageText: readLastReplyTextBeforeNewestMessage(operatorTurn.newestMessageSentAtMs)
  };
}

function createOperatorTurnReaderReadingTheTranscriptOnce(transcriptPath) {
  let operatorTurn;
  return () => {
    if (operatorTurn === undefined) operatorTurn = readOperatorTurnWithTheLastReply(transcriptPath);
    return operatorTurn;
  };
}

async function run() {
  const payload = await readPayloadOrNull();
  if (!hasReadableToolName(payload)) {
    logEvent('guard', 'unreadable_payload');
    return writeDeny(unreadableHookPayloadReason);
  }

  const readOperatorTurnOnce = createOperatorTurnReaderReadingTheTranscriptOnce(payload.transcript_path);
  const memoryDirectory = resolveMemoryDirectory(process.env);
  const decision = decideToolPermission(payload.tool_name, payload.tool_input, {
    transcriptPath: payload.transcript_path,
    browseHosts: readBrowseHosts(process.env),
    allowedCalendarIds: readAllowedCalendarIds(process.env),
    assetBaseUrl: process.env.GLISSA_ASSET_BASE_URL,
    readPlannedBufferPosts: () => readPlannedBufferPosts(process.env),
    memoryDirectory,
    repositoryRoot: resolveRepositoryPath(),
    workingDirectory: payload.cwd,
    memoryWriteInspector: createMemoryWriteInspector(memoryDirectory),
    readStatedContactText: () => readStatedContactText(process.env),
    isOperatorStartedTurn: () => readOperatorTurnOnce().startedByOperator,
    readNewestOperatorMessageText: () => readOperatorTurnOnce().newestMessageText,
    readOperatorExchangeText: () => readOperatorTurnOnce().requestText,
    readLastReplyBeforeNewestMessageText: () => readOperatorTurnOnce().lastReplyBeforeNewestMessageText,
    readCalendarEventRecurrence: (accountAlias, calendarId, eventId) =>
      readCalendarEventRecurrence(process.env, accountAlias, calendarId, eventId),
    readCalendarEventSummary: (accountAlias, calendarId, eventId) =>
      readCalendarEventSummary(process.env, accountAlias, calendarId, eventId),
    readCalendarEventAttendees: (accountAlias, calendarId, eventId) =>
      readCalendarEventAttendees(process.env, accountAlias, calendarId, eventId),
    readRecordedPageHost: () => readRecordedPageHost(),
    judge: judgeBrowseAction
  });
  logDecision(payload, decision);
  if (decision.allow) return;
  writeDeny(decision.reason);
}

await run();
