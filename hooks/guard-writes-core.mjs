import os from 'node:os';
import path from 'node:path';
import { formatViolation, isLexicallyInsideMemory } from '../scripts/memory-check.mjs';
import { isPlainObject } from '../scripts/object-fields.mjs';
import { trailingProvenanceStampPattern } from '../scripts/profile.mjs';

const mcpToolPrefix = 'mcp__';

export const unreadablePayloadReason = 'guard could not read the tool payload';

const browseSchemes = new Set(['http:', 'https:']);
const transactionWords = ['pay', 'payment', 'purchase', 'buy', 'checkout', 'check[\\s-]?out', 'cvv', 'cart', 'basket', 'paypal', 'stripe', 'subscribe', 'wallet', 'upgrade', 'renew', 'donate', 'tip'];
const recordNounsTheOperatorReads = ['order', 'billing', 'card', 'invoice', 'subscription'];
const purchaseWordInActTextPattern = new RegExp(`\\b(${[...transactionWords, ...recordNounsTheOperatorReads].join('|')})\\b`, 'i');
const transactionWordInUrlPattern = new RegExp(`\\b(${transactionWords.join('|')})\\b`, 'i');
const submitWordPattern = /\b(submit|confirm|send|book|reserve|sign|agree|accept|check[\s-]?in|delete|remove|cancel|transfer|continue|next|proceed|save|apply|finish|ok|yes|place|update|post|publish|join|subscribe|unsubscribe)\b/i;
const submitKeyNames = new Set(['space', ' ']);
const enterKeyFragment = 'enter';
const percentEscapeTokenPattern = /^%[0-9A-Fa-f]{2}$/;
const percentEscapeTokenLength = 3;
const longestUtf8SequenceInBytes = 4;
const maximumUrlDecodingPasses = 5;

const browseReadTools = new Set([
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_find',
  'browser_wait_for',
  'browser_resize',
  'browser_close',
  'browser_navigate_back',
  'browser_hover'
]);

const browseActTools = new Set([
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_press_key',
  'browser_select_option',
  'browser_drag',
  'browser_handle_dialog'
]);

const gmailAllowedTools = new Set([
  'create_draft',
  'update_draft',
  'get_draft',
  'list_drafts',
  'get_message',
  'get_thread',
  'search_threads',
  'list_labels',
  'create_label',
  'update_label',
  'label_message',
  'label_thread',
  'unlabel_message',
  'unlabel_thread',
  'update_message_labels'
]);

const gmailLabelTools = new Set([
  'create_label',
  'label_message',
  'label_thread',
  'unlabel_message',
  'unlabel_thread',
  'update_message_labels'
]);

const writableSystemLabelIds = new Set(['UNREAD', 'STARRED', 'IMPORTANT', 'INBOX']);
const systemLabelIdPattern = /^[A-Z][A-Z0-9_]*$/;

const calendarAllowedTools = new Set([
  'create_event',
  'update_event',
  'get_event',
  'list_calendars',
  'list_events',
  'search_events',
  'suggest_time'
]);

const gatedAttendeeEventFields = new Set([
  'attendees',
  'attendeeEmails',
  'addedAttendees',
  'addedAttendeeEmails'
]);

const allowedAttendeeEntryKeys = new Set(['email']);
const attendeeEmailPattern = /^[^\s@|:]+@[^\s@|:]+$/;
const maxAttendeeEmailLength = 254;
const maxGatedAttendeeCount = 5;
const eventEditActionName = 'update_event';

const addressTokenDelimiterPattern = /[\s<>(),;"]+/;
const addressTokenTrailingPunctuationPattern = /[.!?]+$/;

const guestAdditionIntentWords = ['add', 'invite', 'guest', 'share', 'put'];
const guestAdditionIntentWordForms = [
  'add', 'adds', 'added', 'adding',
  'invite', 'invites', 'invited', 'inviting',
  'guest', 'guests',
  'share', 'shares', 'shared', 'sharing',
  'put', 'puts', 'putting'
];
const calendarDeleteIntentPrefixWords = ['delete', 'remove', 'cancel', 'drop', 'clear', 'trash', 'get rid'];
const calendarDeleteIntentWholeWords = ['clean up', 'replace'];
const calendarDeleteIntentWords = [...calendarDeleteIntentPrefixWords, ...calendarDeleteIntentWholeWords];
const recurringSeriesWords = [
  'series',
  'recurring',
  'all occurrences',
  'all instances',
  'every occurrence',
  'every instance',
  'whole series',
  'entire series'
];
const negationWords = ["don't", 'do not', 'dont', 'never', 'not', 'without', 'stop', 'avoid'];
const negationWordsReadInAProposal = [...negationWords, "won't", 'wont'];
const wordsKeepingTheSeriesBeforeIt = ['keep', 'retain', 'leave', 'except', 'but'];
const wordsKeepingTheSeriesAfterIt = ['keep', 'leave'];
const wordsReadAsNegatingTheIntentWord = 4;
const maxNewestMessageLengthReadAsJohnsOwnAsk = 600;
const whitespaceRunPattern = /\s+/g;
const typographicApostrophePattern = /[‘’]/g;
const shortAffirmativeReplies = ['yes', 'yep', 'yeah', 'do it', 'go ahead'];
const maxShortAffirmativeReplyLength = 40;
const shortAffirmativeReplyPattern = new RegExp(`^(?:${shortAffirmativeReplies.join('|')})[.!]*$`);
const contactLineNamePattern = /^\s*-\s+([^:(]+)/;
const regularExpressionSpecialCharacterPattern = /[.*+?^${}()|[\]\\]/g;
const inviteMailFieldPattern = /^\s*-\s+[^:]*\binvite mail:(.*)$/i;
const statedProvenanceWord = 'stated';
const sentenceBoundaryPattern = /(?<=[.!?])\s+/;
const questionMark = '?';
const deleteIntentPrefixesCompletedInAProposal = new Map([['get rid', 'get rid of']]);

function createIntentWordPatternMatchingEveryOccurrence(intentWords) {
  return new RegExp(`\\b(?:${intentWords.join('|')})`, 'gi');
}

function createWholeWordPattern(words) {
  return new RegExp(`\\b(?:${words.join('|')})\\b`, 'i');
}

function createWholeWordPatternMatchingEveryOccurrence(words) {
  return new RegExp(`\\b(?:${words.join('|')})\\b`, 'gi');
}

const guestAdditionIntentWordPattern = createWholeWordPattern(guestAdditionIntentWordForms);
const guestAdditionProposalWordPattern = createWholeWordPattern(guestAdditionIntentWords);
const calendarDeleteProposalWordPattern = createWholeWordPatternMatchingEveryOccurrence(
  calendarDeleteIntentWords.map((intentWord) => deleteIntentPrefixesCompletedInAProposal.get(intentWord) ?? intentWord)
);
const calendarDeleteIntentWordPattern = new RegExp(
  `${createIntentWordPatternMatchingEveryOccurrence(calendarDeleteIntentPrefixWords).source}|${createWholeWordPatternMatchingEveryOccurrence(calendarDeleteIntentWholeWords).source}`,
  'gi'
);
const recurringSeriesWordPattern = createIntentWordPatternMatchingEveryOccurrence(recurringSeriesWords);
const negationWordPattern = createWholeWordPattern(negationWords);
const proposalNegationWordPattern = createWholeWordPattern(negationWordsReadInAProposal);
const seriesKeptBeforeWordPattern = createWholeWordPattern(wordsKeepingTheSeriesBeforeIt);
const seriesKeptAfterWordPattern = createWholeWordPattern(wordsKeepingTheSeriesAfterIt);

const intentWordAbsent = 'absent';
const intentWordAsked = 'asked';
const intentWordNegated = 'negated';

const guestPermissionsFieldName = 'guestPermissions';
const restrictiveGuestPermissionNames = ['guestsCanInviteOthers', 'guestsCanModify', 'guestsCanSeeGuests'];

const outwardEventFields = [
  ['removedAttendeeEmails', 'would notify removed attendees'],
  ['addGoogleMeetUrl', 'would create a shared meeting link'],
  ['googleMeetUrl', 'would attach a shared meeting link'],
  ['attachments', 'would share files'],
  ['addedAttachments', 'would share files'],
  ['removedAttachmentFileUrls', 'would change shared files']
];

const outwardEventFieldNameFragments = ['attendee', 'guest', 'invit', 'attach'];

const cappedEventTextFields = ['summary', 'description', 'location'];
const maxEventTextLength = 500;
const primaryCalendarId = 'primary';
const forbiddenEventVisibility = 'public';
const silentNotificationLevel = 'NONE';
const everyGuestNotificationLevel = 'ALL';

const slackAllowedTools = new Set(['authenticate', 'complete_authentication']);

const gogAllowedTools = new Set([
  'gmail_search',
  'gmail_get_message',
  'gmail_get_thread',
  'calendar_events'
]);

const bufferAllowedTools = new Set([
  'get_account',
  'list_channels',
  'get_channel',
  'list_posts',
  'get_post',
  'get_aggregated_post_metrics',
  'list_ideas',
  'list_idea_groups',
  'list_post_templates',
  'get_post_template',
  'introspect_schema',
  'execute_query'
]);
const bufferQueryToolName = 'execute_query';
const bufferDraftToolName = 'create_post';
const bufferDraftEditToolName = 'edit_post';
const bufferDraftMode = 'customScheduled';
const bufferAssetKinds = new Set(['image', 'video', 'document']);
const bufferThreadItemKeys = new Set(['text', 'assets']);
const bufferAssetTextKeysByKind = { image: new Set(['altText']), video: new Set(['altText']), document: new Set(['altText', 'title']) };
const threadPartHeaderPattern = /^Part \d+[ \t]*$/m;
const offsetIsoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const graphQlMutationPattern = /\b(?:mutation|subscription)\b/i;

const notionAllowedTools = new Set([
  'notion-search',
  'notion-ai-search',
  'notion-fetch',
  'notion-get-comments',
  'notion-get-users',
  'notion-get-teams',
  'notion-get-self',
  'notion-get-async-task',
  'notion-get-session-status',
  'notion-list-favorite-pages',
  'notion-list-private-pages',
  'notion-list-recent-pages',
  'notion-list-shared-pages',
  'notion-list-session-events',
  'notion-query-data-sources',
  'notion-query-multiple-data-sources',
  'notion-query-meeting-notes',
  'notion-query-sessions',
  'notion-read-session-event',
  'notion-search-agents',
  'notion-search-sessions',
  'notion-search-skills',
  'notion-download-attachment',
  'notion-check-mcp-next-steps',
  'notion-show-advanced-analysis-next-steps'
]);

const bashToolName = 'Bash';
const bashCommandFieldName = 'command';
const gogCommandBasename = 'gog';
const gogCalendarWrapperPath = 'scripts/gog-calendar.sh';
const gogCalendarWrapperBasename = 'gog-calendar.sh';
const shellCompositionMarkers = [';', '&&', '||', '|', '&', '\n', '\r', '`', '$(', '<('];
const shellExpansionMarkers = ['$', '`', '<(', '>('];
const shellGlobMarkers = ['*', '?', '[', '{', '}'];
const shellWordOpeningExpansionMarkers = ['!', '~'];
const shellLineBreakMarkers = ['\n', '\r'];
const shellRedirectionMarkers = ['>>', '>|', '2>', '&>', '>', '<<<', '<<', '<'];
const commandNameForbiddenCharacters = ['$', '*', '?', '[', '`'];
const leadingAssignmentWordPattern = /^[A-Za-z_][A-Za-z0-9_]*=/;
const wrapperCommandBasenames = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'ksh',
  'fish',
  'env',
  'xargs',
  'timeout',
  'nohup',
  'ssh',
  'eval',
  'exec',
  'command',
  'nice',
  'ionice',
  'sudo',
  'doas',
  'su',
  'node',
  'python',
  'python3',
  'perl',
  'ruby',
  'script',
  'setsid',
  'stdbuf',
  'strace',
  'ltrace',
  'flock',
  'chrt',
  'taskset',
  'unbuffer',
  'setarch'
]);
const guardedScriptBasenames = ['gog-mcp.sh', 'setup-mail-watch.sh', 'buffer-mcp.sh'];
const guardedScriptDenyReasonByBasename = {
  'buffer-mcp.sh': 'bridges the Buffer key, which can publish, and never runs from a session'
};
const bufferKeyMarkers = ['buffer-headers', 'api.buffer.com', 'mcp.buffer.com', 'buffer-post-state'];
const bufferDraftLedgerMarker = 'buffer-drafts';
const maxWordsRunByAWrapper = 2;
const gogAccountAliases = new Set(['personal-1', 'personal-2', 'personal-3']);
const gogAccountFlagName = 'account';
const gogAccountFlagWord = '--account';
const gogValuedShortFlagNamesByLetter = new Map([['a', gogAccountFlagName]]);
const gogCalendarSubcommandName = 'calendar';
const gogCalendarReadActions = new Set(['events', 'list', 'ls', 'event', 'get', 'info', 'show']);
const gogCalendarEventListActions = new Set(['events', 'list', 'ls']);
const gogCalendarEventsToolName = 'calendar_events';
const calendarWindowBoundNames = ['from', 'to'];
const calendarRelativeWindowFieldNames = ['today', 'tomorrow', 'week', 'days'];
const calendarWindowRuleText =
  'takes its window as from and to timestamps carrying an explicit UTC offset (2026-10-08T00:00:00+01:00), padded one day beyond the dates wanted, because a bare date or a relative window resolves in the calendar\'s own zone';
const gogCalendarCreateAction = 'create';
const gogCalendarUpdateAction = 'update';
const gogCalendarDeleteAction = 'delete';
const gogCalendarTargetCountsByAction = new Map([
  [gogCalendarCreateAction, 1],
  [gogCalendarUpdateAction, 2],
  [gogCalendarDeleteAction, 2]
]);
const gogBooleanFlagNames = new Set([
  'all',
  'all-day',
  'all-pages',
  'dry-run',
  'fail-empty',
  'force',
  'gmail-no-send',
  'guests-can-invite',
  'guests-can-modify',
  'guests-can-see-others',
  'help',
  'json',
  'no-input',
  'no-reminders',
  'plain',
  'readonly',
  'results-only',
  'today',
  'tomorrow',
  'verbose',
  'version',
  'week',
  'weekday',
  'wrap-untrusted'
]);
const gogValuedFlagNames = new Set([
  'access-token',
  'account',
  'add-attendee',
  'attendees',
  'cal',
  'calendars',
  'client',
  'color',
  'days',
  'description',
  'disable-commands',
  'enable-commands',
  'enable-commands-exact',
  'end-timezone',
  'event-color',
  'event-type',
  'event-types',
  'fields',
  'focus-chat-status',
  'from',
  'home',
  'location',
  'location-search',
  'max',
  'order',
  'original-start',
  'page',
  'place-id',
  'place-language',
  'place-region',
  'private-prop',
  'private-prop-filter',
  'quota-project',
  'query',
  'reminder',
  'rrule',
  'scope',
  'select',
  'send-updates',
  'shared-prop',
  'shared-prop-filter',
  'sort',
  'source-title',
  'source-url',
  'start-timezone',
  'summary',
  'timezone',
  'to',
  'transparency',
  'visibility',
  'week-start',
  'working-building-id',
  'working-custom-label',
  'working-desk-id',
  'working-floor-id',
  'working-location-type',
  'working-office-label'
]);
const gogShortBooleanFlagNames = new Set(['h', 'j', 'n', 'p', 'v', 'y']);
const gogFlagNamesLeavingTheStoredAccount = new Set([
  'access-token',
  'client',
  'disable-commands',
  'enable-commands',
  'enable-commands-exact',
  'home',
  'quota-project'
]);
const gogAttendeeFlagNames = ['attendees', 'add-attendee'];
const gogAttendeeFlagNamesByAction = new Map([
  [gogCalendarCreateAction, 'attendees'],
  [gogCalendarUpdateAction, 'add-attendee']
]);
const gogPlainEmailPattern = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const gogGuestPermissionFlagNames = ['guests-can-invite', 'guests-can-modify', 'guests-can-see-others'];
const gogSendUpdatesFlagName = 'send-updates';
const gogSilentSendUpdatesValue = 'none';
const gogEveryGuestSendUpdatesValue = 'all';
const gogEventTypeFlagName = 'event-type';
const gogOrdinaryEventTypeValue = 'default';
const gogVisibilityFlagName = 'visibility';
const gogEventTextFlagNames = ['summary', 'description', 'location'];
const gogScopeFlagName = 'scope';
const gogSingleInstanceScopeValue = 'single';
const gogOriginalStartFlagName = 'original-start';
const gogForceFlagName = 'force';
const gogBooleanShortFlagNamesByLetter = new Map([['y', gogForceFlagName]]);

export const plainEventRecurrence = 'plain';
export const seriesMasterEventRecurrence = 'master';
export const seriesOccurrenceEventRecurrence = 'occurrence';
export const unreadableEventRecurrence = 'unknown';

const readableEventRecurrences = new Set([
  plainEventRecurrence,
  seriesMasterEventRecurrence,
  seriesOccurrenceEventRecurrence
]);

function deny(toolName) {
  return { allow: false, reason: `Write policy denies ${toolName}.` };
}

function denyWithReason(reason) {
  return { allow: false, reason };
}

function decideOperatorStartedTurn(context, reasonWhenTheGuardCannotTell, reasonWhenJohnDidNotStartTheTurn) {
  if (typeof context.isOperatorStartedTurn !== 'function') return denyWithReason(reasonWhenTheGuardCannotTell);
  if (context.isOperatorStartedTurn(context.transcriptPath) === true) return { allow: true };
  return denyWithReason(reasonWhenJohnDidNotStartTheTurn);
}

function splitToolName(toolName) {
  const serverAndAction = toolName.slice(mcpToolPrefix.length);
  const separatorIndex = serverAndAction.indexOf('__');
  if (separatorIndex === -1) return { serverName: serverAndAction, actionName: '' };
  return {
    serverName: serverAndAction.slice(0, separatorIndex),
    actionName: serverAndAction.slice(separatorIndex + 2)
  };
}

function asFieldMap(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return {};
  return toolInput;
}

function normalizeFieldName(fieldName) {
  return fieldName.toLowerCase().replaceAll('_', '');
}

function isLabelIdFieldName(fieldName) {
  return normalizeFieldName(fieldName).endsWith('labelids');
}

function isArrayOfStrings(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function findMalformedLabelIdField(toolInput) {
  return Object.entries(asFieldMap(toolInput))
    .filter(([fieldName]) => isLabelIdFieldName(fieldName))
    .map(([fieldName]) => fieldName)
    .find((fieldName) => !isArrayOfStrings(asFieldMap(toolInput)[fieldName]));
}

function findForbiddenSystemLabelId(value) {
  if (typeof value === 'string') {
    if (systemLabelIdPattern.test(value) && !writableSystemLabelIds.has(value)) return value;
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(findForbiddenSystemLabelId).find((labelId) => labelId !== undefined);
  }
  if (value && typeof value === 'object') return findForbiddenSystemLabelId(Object.values(value));
  return undefined;
}

function isFieldPopulated(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

function decideGmail(actionName, toolName, toolInput) {
  if (!gmailAllowedTools.has(actionName)) return deny(toolName);
  if (!gmailLabelTools.has(actionName)) return { allow: true };
  const malformedFieldName = findMalformedLabelIdField(toolInput);
  if (malformedFieldName !== undefined) {
    return denyWithReason(
      `Write policy denies ${toolName}: ${malformedFieldName} must be an array of label id strings.`
    );
  }
  const forbiddenLabelId = findForbiddenSystemLabelId(toolInput);
  if (forbiddenLabelId === undefined) return { allow: true };
  return denyWithReason(`Write policy denies ${toolName}: label id ${forbiddenLabelId} is not writable.`);
}

function hasOutwardFieldNameFragment(fieldName) {
  if (gatedAttendeeEventFields.has(fieldName)) return false;
  if (fieldName === guestPermissionsFieldName) return false;
  const loweredFieldName = fieldName.toLowerCase();
  return outwardEventFieldNameFragments.some((fragment) => loweredFieldName.includes(fragment));
}

function findOutwardEventField(eventFields) {
  const namedOutwardField = outwardEventFields.find(([fieldName]) => isFieldPopulated(eventFields[fieldName]));
  if (namedOutwardField) return namedOutwardField;
  const fragmentFieldName = Object.keys(eventFields).find(
    (fieldName) => hasOutwardFieldNameFragment(fieldName) && isFieldPopulated(eventFields[fieldName])
  );
  if (fragmentFieldName === undefined) return undefined;
  return [fragmentFieldName, 'would reach other people'];
}

function findPopulatedAttendeeEventFields(eventFields) {
  return Object.keys(eventFields).filter(
    (fieldName) => gatedAttendeeEventFields.has(fieldName) && isFieldPopulated(eventFields[fieldName])
  );
}

function readAttendeeEntryEmail(attendeeEntry) {
  if (typeof attendeeEntry === 'string') return attendeeEntry;
  if (!attendeeEntry || typeof attendeeEntry !== 'object' || Array.isArray(attendeeEntry)) return '';
  if (!Object.keys(attendeeEntry).every((entryKey) => allowedAttendeeEntryKeys.has(entryKey))) return '';
  if (typeof attendeeEntry.email !== 'string') return '';
  return attendeeEntry.email;
}

function isReadableAttendeeEntry(attendeeEntry) {
  const attendeeEmail = readAttendeeEntryEmail(attendeeEntry);
  if (attendeeEmail.length > maxAttendeeEmailLength) return false;
  return attendeeEmailPattern.test(attendeeEmail);
}

function findUnreadableAttendeeFieldName(attendeeFieldNames, eventFields) {
  return attendeeFieldNames.find((fieldName) => {
    const attendeeValue = eventFields[fieldName];
    if (!Array.isArray(attendeeValue)) return true;
    return !attendeeValue.every(isReadableAttendeeEntry);
  });
}

function countAttendees(attendeeFieldNames, eventFields) {
  return attendeeFieldNames.reduce((runningCount, fieldName) => runningCount + eventFields[fieldName].length, 0);
}

function isRestrictiveGuestPermissions(guestPermissions) {
  if (!guestPermissions || typeof guestPermissions !== 'object' || Array.isArray(guestPermissions)) return false;
  return Object.entries(guestPermissions).every(
    ([permissionName, permissionValue]) =>
      restrictiveGuestPermissionNames.includes(permissionName) && permissionValue === false
  );
}

function keepsEveryGuestRestricted(guestPermissions) {
  if (!isRestrictiveGuestPermissions(guestPermissions)) return false;
  return restrictiveGuestPermissionNames.every((permissionName) => guestPermissions[permissionName] === false);
}

function decideGuestPermissions(toolName, eventFields) {
  if (!(guestPermissionsFieldName in eventFields)) return { allow: true };
  if (isRestrictiveGuestPermissions(eventFields[guestPermissionsFieldName])) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: guestPermissions may only set ${restrictiveGuestPermissionNames.join(', ')} to false.`
  );
}

function collectWrittenAddresses(searchableText) {
  return searchableText
    .split(addressTokenDelimiterPattern)
    .map((writtenWord) => writtenWord.replace(addressTokenTrailingPunctuationPattern, '').toLowerCase())
    .filter((writtenWord) => attendeeEmailPattern.test(writtenWord));
}

function isAddressWrittenIn(searchableText, attendeeEmail) {
  return collectWrittenAddresses(searchableText).includes(attendeeEmail.toLowerCase());
}

function collectAttendeeAddresses(attendeeFieldNames, eventFields) {
  return attendeeFieldNames.flatMap((fieldName) => eventFields[fieldName].map(readAttendeeEntryEmail));
}

function readOperatorTextOrEmpty(readOperatorText, transcriptPath) {
  if (typeof readOperatorText !== 'function') return '';
  const operatorText = readOperatorText(transcriptPath);
  if (typeof operatorText === 'string') return operatorText;
  return '';
}

function readStatedContactTextOrNull(context) {
  try {
    const statedContactText = context.readStatedContactText();
    if (typeof statedContactText === 'string') return statedContactText;
    return null;
  } catch {
    return null;
  }
}

function decideAttendeeAddressesKnown(toolName, changedFieldNames, attendeeFieldNames, eventFields, context) {
  if (typeof context.readStatedContactText !== 'function') {
    return denyWithReason(
      `Write policy denies ${toolName}: ${changedFieldNames} adds a guest and the guard cannot read the contacts memory holds.`
    );
  }
  const statedContactText = readStatedContactTextOrNull(context);
  if (statedContactText === null) {
    return denyWithReason(
      `Write policy denies ${toolName}: ${changedFieldNames} adds a guest and the contacts memory holds could not be read.`
    );
  }
  const unstatedAddress = collectAttendeeAddresses(attendeeFieldNames, eventFields).find(
    (attendeeEmail) => !isAddressWrittenIn(statedContactText, attendeeEmail)
  );
  if (unstatedAddress === undefined) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: guest address ${unstatedAddress} is not a contact John stated in memory.`
  );
}

function isShortAffirmativeReply(messageText) {
  const collapsedText = collapseMessageText(messageText);
  if (collapsedText.length > maxShortAffirmativeReplyLength) return false;
  return shortAffirmativeReplyPattern.test(collapsedText);
}

function affirmsTheLastProposal(context, proposalAskedFor) {
  const newestMessageText = readOperatorTextOrEmpty(context.readNewestOperatorMessageText, context.transcriptPath);
  if (!isShortAffirmativeReply(newestMessageText)) return false;
  return proposalAskedFor(
    readOperatorTextOrEmpty(context.readLastReplyBeforeNewestMessageText, context.transcriptPath)
  );
}

function readContactLineName(contactLine) {
  const contactNameMatch = contactLineNamePattern.exec(contactLine);
  if (contactNameMatch === null) return '';
  return contactNameMatch[1].trim();
}

function isNameWrittenIn(searchableText, contactName) {
  const escapedContactName = contactName.replace(regularExpressionSpecialCharacterPattern, '\\$&');
  return new RegExp(`\\b${escapedContactName}\\b`, 'i').test(searchableText);
}

function namesTheAttendee(proposalText, attendeeEmail, statedContactText) {
  if (isAddressWrittenIn(proposalText, attendeeEmail)) return true;
  return statedContactText
    .split('\n')
    .filter((contactLine) => isAddressWrittenIn(contactLine, attendeeEmail))
    .map(readContactLineName)
    .some((contactName) => contactName.length > 1 && isNameWrittenIn(proposalText, contactName));
}

function splitIntoSentences(text) {
  return text.split(sentenceBoundaryPattern);
}

function isQuestion(sentence) {
  return sentence.includes(questionMark);
}

function proposesAddingEveryAttendee(proposalText, attendeeAddresses, context) {
  if (typeof context.readStatedContactText !== 'function') return false;
  const statedContactText = readStatedContactTextOrNull(context);
  if (statedContactText === null) return false;
  const additionQuestions = splitIntoSentences(proposalText.trim())
    .filter(isQuestion)
    .filter((sentence) => guestAdditionProposalWordPattern.test(sentence));
  return attendeeAddresses.every((attendeeEmail) =>
    additionQuestions.some((sentence) => namesTheAttendee(sentence, attendeeEmail, statedContactText))
  );
}

function decideGuestAdditionAsked(toolName, changedFieldNames, attendeeAddresses, context) {
  if (typeof context.readOperatorExchangeText !== 'function') {
    return denyWithReason(
      `Write policy denies ${toolName}: ${changedFieldNames} adds a guest and the guard cannot read what John asked for.`
    );
  }
  const exchangeText = readOperatorTextOrEmpty(context.readOperatorExchangeText, context.transcriptPath);
  if (guestAdditionIntentWordPattern.test(exchangeText)) return { allow: true };
  const affirmsAnAdditionProposal = affirmsTheLastProposal(context, (proposalText) =>
    proposesAddingEveryAttendee(proposalText, attendeeAddresses, context)
  );
  if (affirmsAnAdditionProposal) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: ${changedFieldNames} adds a guest, no message in this exchange names ${guestAdditionIntentWords.join(', ')}, and John's newest message is not a yes to a proposal naming that guest.`
  );
}

function collapseMessageText(messageText) {
  return messageText
    .replace(typographicApostrophePattern, "'")
    .replace(whitespaceRunPattern, ' ')
    .trim()
    .toLowerCase();
}

function splitIntoWords(text) {
  return text.split(' ').filter((word) => word.length > 0);
}

function wordsPrecedingMatch(collapsedText, intentWordMatch) {
  return splitIntoWords(collapsedText.slice(0, intentWordMatch.index))
    .slice(-wordsReadAsNegatingTheIntentWord)
    .join(' ');
}

function wordsFollowingMatch(collapsedText, intentWordMatch) {
  return splitIntoWords(collapsedText.slice(intentWordMatch.index + intentWordMatch[0].length))
    .slice(0, wordsReadAsNegatingTheIntentWord)
    .join(' ');
}

function readDeletionWordStanding(messageText) {
  const collapsedText = collapseMessageText(messageText);
  const deletionWordMatches = [...collapsedText.matchAll(calendarDeleteIntentWordPattern)];
  if (deletionWordMatches.length === 0) return intentWordAbsent;
  const asked = deletionWordMatches.some(
    (deletionWordMatch) => !negationWordPattern.test(wordsPrecedingMatch(collapsedText, deletionWordMatch))
  );
  if (asked) return intentWordAsked;
  return intentWordNegated;
}

function asksForTheDeleteInTheSentence(sentence) {
  return [...sentence.matchAll(calendarDeleteProposalWordPattern)].some(
    (deletionWordMatch) => !proposalNegationWordPattern.test(wordsPrecedingMatch(sentence, deletionWordMatch))
  );
}

function isEventTitleWrittenIn(sentence, collapsedEventTitle) {
  const escapedEventTitle = collapsedEventTitle.replace(regularExpressionSpecialCharacterPattern, '\\$&');
  return new RegExp(`(?<!\\w)${escapedEventTitle}(?!\\w)`).test(sentence);
}

function proposesDeletingTheEvent(proposalText, targetEventSummary) {
  const collapsedEventTitle = collapseMessageText(targetEventSummary);
  if (collapsedEventTitle.length === 0) return false;
  return splitIntoSentences(collapseMessageText(proposalText))
    .filter(isQuestion)
    .filter((sentence) => isEventTitleWrittenIn(sentence, collapsedEventTitle))
    .some(asksForTheDeleteInTheSentence);
}

function readSeriesWordStanding(messageText) {
  const collapsedText = collapseMessageText(messageText);
  const seriesWordMatches = [...collapsedText.matchAll(recurringSeriesWordPattern)];
  if (seriesWordMatches.length === 0) return intentWordAbsent;
  const keptAfterASeriesWord = seriesWordMatches.some((seriesWordMatch) =>
    seriesKeptAfterWordPattern.test(wordsFollowingMatch(collapsedText, seriesWordMatch))
  );
  if (keptAfterASeriesWord) return intentWordNegated;
  const asked = seriesWordMatches.some((seriesWordMatch) => {
    const precedingWords = wordsPrecedingMatch(collapsedText, seriesWordMatch);
    return !negationWordPattern.test(precedingWords) && !seriesKeptBeforeWordPattern.test(precedingWords);
  });
  if (asked) return intentWordAsked;
  return intentWordNegated;
}

function decideCalendarDeleteAsked(toolName, context, readTargetEventSummary) {
  if (typeof context.readNewestOperatorMessageText !== 'function') {
    return denyWithReason(
      `Write policy denies ${toolName}: the delete removes an event and the guard cannot read what John asked for.`
    );
  }
  const newestMessageText = readOperatorTextOrEmpty(context.readNewestOperatorMessageText, context.transcriptPath);
  if (newestMessageText.length > maxNewestMessageLengthReadAsJohnsOwnAsk) {
    return denyWithReason(
      `Write policy denies ${toolName}: the delete removes an event, and John's newest message is longer than ${maxNewestMessageLengthReadAsJohnsOwnAsk} characters, too long to read as his own ask.`
    );
  }
  const deletionWordStanding = readDeletionWordStanding(newestMessageText);
  if (deletionWordStanding === intentWordAsked) return { allow: true };
  const affirmsADeleteProposal = affirmsTheLastProposal(context, (proposalText) => {
    const targetEventSummary = readTargetEventSummary();
    if (targetEventSummary === null) return false;
    return proposesDeletingTheEvent(proposalText, targetEventSummary);
  });
  if (affirmsADeleteProposal) return { allow: true };
  if (deletionWordStanding === intentWordNegated) {
    return denyWithReason(
      `Write policy denies ${toolName}: the delete removes an event, and every ${calendarDeleteIntentWords.join(', ')} in John's newest message is negated by one of ${negationWords.join(', ')} within the ${wordsReadAsNegatingTheIntentWord} words before it.`
    );
  }
  return denyWithReason(
    `Write policy denies ${toolName}: the delete removes an event, and John's newest message names none of ${calendarDeleteIntentWords.join(', ')}, nor is it a yes to a reply proposing the delete as a question naming that event.`
  );
}

export function carriesStatedProvenance(memoryLine) {
  const trailingStampMatch = trailingProvenanceStampPattern.exec(memoryLine.trim());
  if (trailingStampMatch === null) return false;
  return trailingStampMatch[1] === statedProvenanceWord;
}

function collectInviteMailAddresses(statedContactText) {
  return new Set(
    statedContactText.split('\n').filter(carriesStatedProvenance).flatMap((memoryLine) => {
      const inviteMailMatch = inviteMailFieldPattern.exec(memoryLine.trim().replace(trailingProvenanceStampPattern, ''));
      if (inviteMailMatch === null) return [];
      return collectWrittenAddresses(inviteMailMatch[1]);
    })
  );
}

function findAddressOutsideInviteMail(attendeeAddresses, inviteMailAddresses) {
  return attendeeAddresses.find((attendeeEmail) => !inviteMailAddresses.has(attendeeEmail.toLowerCase()));
}

const noAttendeesBeforeACreate = () => [];

function decideInviteMail(toolName, silentOnlyReason, addedAttendeeAddresses, readAttendeesAlreadyOnTheEvent, context) {
  const operatorTurnDecision = decideOperatorStartedTurn(
    context,
    `Write policy denies ${toolName}: ${silentOnlyReason}, because the guard cannot tell who started this turn.`,
    `Write policy denies ${toolName}: ${silentOnlyReason}, because only a turn John started sends invite mail.`
  );
  if (!operatorTurnDecision.allow) return operatorTurnDecision;
  if (typeof context.readStatedContactText !== 'function') {
    return denyWithReason(
      `Write policy denies ${toolName}: ${silentOnlyReason}, because the guard cannot read which contacts memory marks for invite mail.`
    );
  }
  const statedContactText = readStatedContactTextOrNull(context);
  if (statedContactText === null) {
    return denyWithReason(
      `Write policy denies ${toolName}: ${silentOnlyReason}, because the contacts memory holds could not be read.`
    );
  }
  const inviteMailAddresses = collectInviteMailAddresses(statedContactText);
  const addedAddressOutsideInviteMail = findAddressOutsideInviteMail(addedAttendeeAddresses, inviteMailAddresses);
  if (addedAddressOutsideInviteMail !== undefined) {
    return denyWithReason(
      `Write policy denies ${toolName}: ${silentOnlyReason}, because ${addedAddressOutsideInviteMail} is not a household contact memory marks for invite mail.`
    );
  }
  const attendeesAlreadyOnTheEvent = readAttendeesAlreadyOnTheEvent();
  if (attendeesAlreadyOnTheEvent === null) {
    return denyWithReason(
      `Write policy denies ${toolName}: ${silentOnlyReason}, because reading who is already on the event failed.`
    );
  }
  const existingAddressOutsideInviteMail = findAddressOutsideInviteMail(attendeesAlreadyOnTheEvent, inviteMailAddresses);
  if (existingAddressOutsideInviteMail === undefined) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: ${silentOnlyReason}, because ${existingAddressOutsideInviteMail} is already on the event and is not a household contact memory marks for invite mail.`
  );
}

function decideConnectorNotificationLevel(toolName, eventFields, attendeeAddresses, context, silentOnlyReason) {
  if (eventFields.notificationLevel === silentNotificationLevel) return { allow: true };
  if (eventFields.notificationLevel !== everyGuestNotificationLevel) {
    return denyWithReason(`Write policy denies ${toolName}: ${silentOnlyReason}.`);
  }
  if (splitToolName(toolName).actionName === eventEditActionName) {
    return denyWithReason(
      `Write policy denies ${toolName}: ${silentOnlyReason}, because the connector cannot read who is already on the event.`
    );
  }
  return decideInviteMail(toolName, silentOnlyReason, attendeeAddresses, noAttendeesBeforeACreate, context);
}

function decideAttendeeChange(toolName, attendeeFieldNames, eventFields, context) {
  const changedFieldNames = attendeeFieldNames.join(', ');
  const unreadableFieldName = findUnreadableAttendeeFieldName(attendeeFieldNames, eventFields);
  if (unreadableFieldName !== undefined) {
    return denyWithReason(
      `Write policy denies ${toolName}: ${unreadableFieldName} must be an array of guest addresses the guard can read.`
    );
  }
  if (countAttendees(attendeeFieldNames, eventFields) > maxGatedAttendeeCount) {
    return denyWithReason(
      `Write policy denies ${toolName}: ${changedFieldNames} adds more than ${maxGatedAttendeeCount} guests in one call.`
    );
  }
  const notificationDecision = decideConnectorNotificationLevel(
    toolName,
    eventFields,
    collectAttendeeAddresses(attendeeFieldNames, eventFields),
    context,
    `${changedFieldNames} adds a guest, so notificationLevel must be ${silentNotificationLevel}`
  );
  if (!notificationDecision.allow) return notificationDecision;
  if (!keepsEveryGuestRestricted(eventFields[guestPermissionsFieldName])) {
    return denyWithReason(
      `Write policy denies ${toolName}: ${changedFieldNames} adds a guest, so guestPermissions must set ${restrictiveGuestPermissionNames.join(', ')} to false and keep those guests restricted.`
    );
  }
  const operatorTurnDecision = decideOperatorStartedTurn(
    context,
    `Write policy denies ${toolName}: ${changedFieldNames} adds a guest and the guard cannot tell who started this turn.`,
    `Write policy denies ${toolName}: ${changedFieldNames} adds a guest, and only a turn John started adds one.`
  );
  if (!operatorTurnDecision.allow) return operatorTurnDecision;
  const additionAskedDecision = decideGuestAdditionAsked(
    toolName,
    changedFieldNames,
    collectAttendeeAddresses(attendeeFieldNames, eventFields),
    context
  );
  if (!additionAskedDecision.allow) return additionAskedDecision;
  return decideAttendeeAddressesKnown(toolName, changedFieldNames, attendeeFieldNames, eventFields, context);
}

function findOversizedEventTextField(eventFields) {
  return cappedEventTextFields.find(
    (fieldName) =>
      typeof eventFields[fieldName] === 'string' && eventFields[fieldName].length > maxEventTextLength
  );
}

function decideCalendarIdAllowed(toolName, calendarId, allowedCalendarIds) {
  if (calendarId === primaryCalendarId) return { allow: true };
  if (allowedCalendarIds.has(calendarId)) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: calendarId ${calendarId} is not in calendar-allow.json.`
  );
}

function decideCalendarTarget(toolName, eventFields, allowedCalendarIds) {
  if (!('calendarId' in eventFields)) return { allow: true };
  return decideCalendarIdAllowed(toolName, eventFields.calendarId, allowedCalendarIds);
}

function readAllowedCalendarIds(context) {
  if (context.allowedCalendarIds instanceof Set) return context.allowedCalendarIds;
  return new Set();
}

function decideCalendarEventWrite(toolName, toolInput, allowedCalendarIds, context) {
  const eventFields = asFieldMap(toolInput);
  const targetDecision = decideCalendarTarget(toolName, eventFields, allowedCalendarIds);
  if (!targetDecision.allow) return targetDecision;
  const outwardField = findOutwardEventField(eventFields);
  if (outwardField) {
    const [fieldName, outwardEffect] = outwardField;
    return denyWithReason(`Write policy denies ${toolName}: ${fieldName} ${outwardEffect}.`);
  }
  const guestPermissionsDecision = decideGuestPermissions(toolName, eventFields);
  if (!guestPermissionsDecision.allow) return guestPermissionsDecision;
  const attendeeFieldNames = findPopulatedAttendeeEventFields(eventFields);
  if (attendeeFieldNames.length > 0) {
    const attendeeDecision = decideAttendeeChange(toolName, attendeeFieldNames, eventFields, context);
    if (!attendeeDecision.allow) return attendeeDecision;
  }
  const eventVisibility = eventFields.visibility;
  if (typeof eventVisibility === 'string' && eventVisibility.toLowerCase() === forbiddenEventVisibility) {
    return denyWithReason(`Write policy denies ${toolName}: visibility ${forbiddenEventVisibility} exposes the hold.`);
  }
  const oversizedFieldName = findOversizedEventTextField(eventFields);
  if (oversizedFieldName !== undefined) {
    return denyWithReason(
      `Write policy denies ${toolName}: ${oversizedFieldName} is longer than ${maxEventTextLength} characters.`
    );
  }
  return { allow: true };
}

function decideCalendarEdit(toolName, toolInput, allowedCalendarIds, context) {
  const eventWriteDecision = decideCalendarEventWrite(toolName, toolInput, allowedCalendarIds, context);
  if (!eventWriteDecision.allow) return eventWriteDecision;
  return decideConnectorNotificationLevel(
    toolName,
    asFieldMap(toolInput),
    [],
    context,
    `notificationLevel must be ${silentNotificationLevel} so the edit mails nobody`
  );
}

function decideCalendar(actionName, toolName, toolInput, context = {}) {
  if (!calendarAllowedTools.has(actionName)) return deny(toolName);
  const allowedCalendarIds = readAllowedCalendarIds(context);
  if (actionName === 'create_event') {
    return decideCalendarEventWrite(toolName, toolInput, allowedCalendarIds, context);
  }
  if (actionName === eventEditActionName) {
    return decideCalendarEdit(toolName, toolInput, allowedCalendarIds, context);
  }
  return { allow: true };
}

function decideAllowedTool(allowedTools, actionName, toolName) {
  if (allowedTools.has(actionName)) return { allow: true };
  return deny(toolName);
}

function decideTelegramChannel() {
  return { allow: true };
}

function isCalendarWindowBound(boundValue) {
  return typeof boundValue === 'string' && offsetIsoTimestampPattern.test(boundValue);
}

function denyCalendarWindow(toolName) {
  return denyWithReason(`Write policy denies ${toolName}: a calendar read ${calendarWindowRuleText}.`);
}

function isRelativeWindowRequested(fieldValue) {
  return fieldValue !== undefined && fieldValue !== null && fieldValue !== false && fieldValue !== 0;
}

function decideGogCalendarEventsWindow(toolName, toolInput) {
  const windowFields = asFieldMap(toolInput);
  if (!calendarWindowBoundNames.every((boundName) => isCalendarWindowBound(windowFields[boundName]))) return denyCalendarWindow(toolName);
  if (calendarRelativeWindowFieldNames.some((fieldName) => isRelativeWindowRequested(windowFields[fieldName]))) return denyCalendarWindow(toolName);
  return { allow: true };
}

function decideGogTool(actionName, toolName, toolInput) {
  const allowedToolDecision = decideAllowedTool(gogAllowedTools, actionName, toolName);
  if (!allowedToolDecision.allow) return allowedToolDecision;
  if (actionName === gogCalendarEventsToolName) return decideGogCalendarEventsWindow(toolName, toolInput);
  return allowedToolDecision;
}

function decideSlackTool(actionName, toolName) {
  return decideAllowedTool(slackAllowedTools, actionName, toolName);
}

function decideNotionTool(actionName, toolName) {
  return decideAllowedTool(notionAllowedTools, actionName, toolName);
}

function collectStringValues(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStringValues);
  return [];
}

function isHostedAssetUrl(assetUrl, assetBaseUrl) {
  if (typeof assetUrl !== 'string' || typeof assetBaseUrl !== 'string' || assetBaseUrl.length === 0) return false;
  const parsedAssetUrl = parseUrlOrNull(assetUrl);
  const parsedBaseUrl = parseUrlOrNull(assetBaseUrl);
  if (parsedAssetUrl === null || parsedBaseUrl === null) return false;
  if (parsedAssetUrl.origin === 'null' || parsedAssetUrl.origin !== parsedBaseUrl.origin) return false;
  return parsedAssetUrl.pathname.startsWith(`${parsedBaseUrl.pathname.replace(/\/+$/, '')}/`);
}

function collectUrlFieldValues(value, exemptTextKeys, keyName = null) {
  if (keyName !== null && exemptTextKeys.has(keyName) && typeof value === 'string') return [];
  if (Array.isArray(value)) return value.flatMap((entry) => collectUrlFieldValues(entry, exemptTextKeys, keyName));
  if (isPlainObject(value)) return Object.entries(value).flatMap(([childKey, childValue]) => collectUrlFieldValues(childValue, exemptTextKeys, childKey));
  if (typeof value === 'string') return [value];
  return [];
}

function isHostedAssetEntry(asset, assetBaseUrl) {
  if (!isPlainObject(asset)) return false;
  const assetKinds = Object.keys(asset);
  if (assetKinds.length !== 1 || !bufferAssetKinds.has(assetKinds[0])) return false;
  const assetBody = asset[assetKinds[0]];
  if (!isPlainObject(assetBody)) return false;
  return collectUrlFieldValues(assetBody, bufferAssetTextKeysByKind[assetKinds[0]]).every((assetUrl) => isHostedAssetUrl(assetUrl, assetBaseUrl));
}

function hasOnlyHostedAssets(assets, assetBaseUrl) {
  if (assets === undefined) return true;
  if (!Array.isArray(assets)) return false;
  return assets.every((asset) => isHostedAssetEntry(asset, assetBaseUrl));
}

function hasExactlyOneKey(fieldMap, keyName) {
  const keyNames = Object.keys(fieldMap);
  return keyNames.length === 1 && keyNames[0] === keyName;
}

function isThreadItem(threadItem) {
  if (!isPlainObject(threadItem) || typeof threadItem.text !== 'string') return false;
  return Object.keys(threadItem).every((keyName) => bufferThreadItemKeys.has(keyName));
}

function readThreadItemsOrNull(metadata) {
  if (!isPlainObject(metadata) || !hasExactlyOneKey(metadata, 'twitter')) return null;
  const twitterMetadata = metadata.twitter;
  if (!isPlainObject(twitterMetadata) || !hasExactlyOneKey(twitterMetadata, 'thread')) return null;
  const threadItems = twitterMetadata.thread;
  if (!Array.isArray(threadItems) || threadItems.length === 0 || !threadItems.every(isThreadItem)) return null;
  return threadItems;
}

function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function splitThreadFollowUps(threadFollowUps) {
  if (typeof threadFollowUps !== 'string') return [];
  return threadFollowUps.split(threadPartHeaderPattern).map(collapseWhitespace).filter((partText) => partText.length > 0);
}

function readDueAtMs(dueAt) {
  if (typeof dueAt !== 'string' || !offsetIsoTimestampPattern.test(dueAt)) return Number.NaN;
  return Date.parse(dueAt);
}

function matchesPlannedPost(plannedPost, dueAtMs, draftText, threadItems) {
  if (!isPlainObject(plannedPost) || plannedPost.scheduledAtMs !== dueAtMs) return false;
  const plannedTexts = [plannedPost.copy, plannedPost.fallback].filter((plannedText) => typeof plannedText === 'string').map(collapseWhitespace);
  if (!plannedTexts.includes(draftText)) return false;
  if (threadItems === undefined) return true;
  if (collapseWhitespace(threadItems[0].text) !== draftText) return false;
  const plannedFollowUps = splitThreadFollowUps(plannedPost.threadFollowUps);
  const draftFollowUps = threadItems.slice(1).map((threadItem) => collapseWhitespace(threadItem.text));
  if (draftFollowUps.length !== plannedFollowUps.length) return false;
  return draftFollowUps.every((draftFollowUp, partIndex) => draftFollowUp === plannedFollowUps[partIndex]);
}

function decideBufferDraft(toolName, toolInput, context, editedPostId = null) {
  const fields = asFieldMap(toolInput);
  if (fields.saveToDraft !== true) return denyWithReason(`${toolName} is allowed only as a Buffer draft (saveToDraft true), because the Buffer key can publish.`);
  if (fields.mode !== bufferDraftMode) return denyWithReason(`${toolName} draft must use mode ${bufferDraftMode} with dueAt at its planned slot.`);
  if (fields.draftId !== undefined || fields.ideaId !== undefined || fields.needsApproval !== undefined) return deny(toolName);
  const threadItems = fields.metadata === undefined ? undefined : readThreadItemsOrNull(fields.metadata);
  if (threadItems === null) return denyWithReason(`${toolName} draft metadata may carry only an X thread of text and assets.`);
  const assetGroups = [fields.assets, ...(threadItems ?? []).map((threadItem) => threadItem.assets)];
  if (!assetGroups.every((assets) => hasOnlyHostedAssets(assets, context.assetBaseUrl))) return denyWithReason(`${toolName} assets must come from Glissa's asset host.`);
  if (typeof context.readPlannedBufferPosts !== 'function') return denyWithReason(`${toolName} draft needs the content plan, which the guard cannot read.`);
  const plannedPosts = context.readPlannedBufferPosts();
  if (!Array.isArray(plannedPosts)) return denyWithReason(`${toolName} draft needs the content plan, which the guard cannot read.`);
  const dueAtMs = readDueAtMs(fields.dueAt);
  const draftText = typeof fields.text === 'string' ? collapseWhitespace(fields.text) : null;
  const matchingPlannedPosts = draftText === null ? [] : plannedPosts.filter((plannedPost) => matchesPlannedPost(plannedPost, dueAtMs, draftText, threadItems));
  if (matchingPlannedPosts.length === 0) return denyWithReason(`${toolName} draft must match a planned post at its slot: dueAt its scheduled time and text its copy or fallback.`);
  if (editedPostId !== null && !matchingPlannedPosts.some((plannedPost) => plannedPost.bufferPostId === editedPostId)) return denyWithReason(`${toolName} may change only the Buffer draft the plan records for that same post.`);
  if (editedPostId === null && matchingPlannedPosts.every((plannedPost) => typeof plannedPost.bufferPostId === 'string' && plannedPost.bufferPostId.length > 0)) return denyWithReason(`${toolName} would duplicate the Buffer draft the plan already records; edit that draft instead.`);
  return { allow: true };
}

function decideBufferDraftCreate(toolName, toolInput, context) {
  const draftDecision = decideBufferDraft(toolName, toolInput, context);
  if (!draftDecision.allow) return draftDecision;
  const { channelId, dueAt } = asFieldMap(toolInput);
  const recordedPostIds = typeof context.listRecordedBufferDraftsAtSlot === 'function' ? context.listRecordedBufferDraftsAtSlot(channelId, readDueAtMs(dueAt)) : [];
  for (const recordedPostId of recordedPostIds) {
    const livePostState = typeof context.readLiveBufferPostState === 'function' ? context.readLiveBufferPostState(recordedPostId) : null;
    if (!isPlainObject(livePostState)) return denyWithReason(`${toolName} needs the live state of draft ${recordedPostId} Glissa saved at this slot, which the guard could not read.`);
    if (livePostState.missing === true || livePostState.status === 'sent') continue;
    return denyWithReason(`${toolName} would duplicate draft ${recordedPostId} Glissa already saved at this slot; run set <id> bufferPostId=${recordedPostId} instead.`);
  }
  return { allow: true };
}

function decideBufferDraftEdit(toolName, toolInput, context) {
  const { postId } = asFieldMap(toolInput);
  if (typeof postId !== 'string' || postId.length === 0) return deny(toolName);
  const draftDecision = decideBufferDraft(toolName, toolInput, context, postId);
  if (!draftDecision.allow) return draftDecision;
  const livePostState = typeof context.readLiveBufferPostState === 'function' ? context.readLiveBufferPostState(postId) : null;
  if (!isPlainObject(livePostState)) return denyWithReason(`${toolName} needs the post's live state from Buffer, which the guard could not read.`);
  if (livePostState.missing === true) return denyWithReason(`${toolName} target is gone from Buffer; clear its bufferPostId and create a new draft.`);
  const recordedDraft = typeof context.readRecordedBufferDraft === 'function' ? context.readRecordedBufferDraft(postId) : null;
  if (!isPlainObject(recordedDraft)) return denyWithReason(`${toolName} may change only a Buffer draft Glissa saved itself.`);
  if (livePostState.status !== 'draft') return denyWithReason(`${toolName} target is ${livePostState.status} in Buffer, so John has taken it over; leave it and name it in the reply.`);
  if (livePostState.updatedAt !== recordedDraft.updatedAt) return denyWithReason(`${toolName} target was changed in Buffer since Glissa saved it, so John has edited it; leave it and name it in the reply.`);
  return { allow: true };
}

function decideBufferTool(actionName, toolName, toolInput, context = {}) {
  if (actionName === bufferDraftToolName) return decideBufferDraftCreate(toolName, toolInput, context);
  if (actionName === bufferDraftEditToolName) return decideBufferDraftEdit(toolName, toolInput, context);
  const allowedToolDecision = decideAllowedTool(bufferAllowedTools, actionName, toolName);
  if (!allowedToolDecision.allow || actionName !== bufferQueryToolName) return allowedToolDecision;
  const isMutationShaped = collectStringValues(toolInput).some((inputText) => graphQlMutationPattern.test(inputText));
  if (isMutationShaped) return deny(toolName);
  return allowedToolDecision;
}

function isListedBrowseHost(browseHosts, hostname) {
  const hostnameLabels = hostname.toLowerCase().split('.');
  return hostnameLabels.some((label, labelIndex) => browseHosts.has(hostnameLabels.slice(labelIndex).join('.')));
}

function parseUrlOrNull(urlText) {
  try {
    return new URL(urlText);
  } catch {
    return null;
  }
}

function collectDroppedDataTexts(droppedData) {
  if (!droppedData || typeof droppedData !== 'object') return [];
  return Object.entries(droppedData).flat();
}

function collectBrowseActionTexts(toolInput) {
  const actionFields = asFieldMap(toolInput);
  const formFieldTexts = Array.isArray(actionFields.fields)
    ? actionFields.fields.flatMap((field) => [field?.name, field?.value, field?.element, field?.target, field?.type])
    : [];
  return [
    actionFields.element,
    actionFields.target,
    actionFields.startElement,
    actionFields.startTarget,
    actionFields.endElement,
    actionFields.endTarget,
    actionFields.text,
    actionFields.key,
    actionFields.promptText,
    actionFields.filename,
    actionFields.url,
    ...(Array.isArray(actionFields.values) ? actionFields.values : []),
    ...collectDroppedDataTexts(actionFields.data),
    ...formFieldTexts
  ].filter((entry) => typeof entry === 'string' && entry.length > 0);
}

function isSubmitKeyValue(keyValue) {
  const loweredKeyValue = String(keyValue ?? '').toLowerCase();
  if (loweredKeyValue.includes(enterKeyFragment)) return true;
  return submitKeyNames.has(loweredKeyValue);
}

function isBrowseSubmitAction(actionName, toolInput, actionTexts) {
  if (actionTexts.length === 0) return true;
  const actionFields = asFieldMap(toolInput);
  if (actionName === 'browser_type' && actionFields.submit === true) return true;
  if (actionName === 'browser_press_key' && isSubmitKeyValue(actionFields.key)) return true;
  if (actionName === 'browser_handle_dialog' && actionFields.accept === true) return true;
  return actionTexts.some((actionText) => submitWordPattern.test(actionText));
}

function decodeEscapeTextOrNull(escapeText) {
  try {
    return decodeURIComponent(escapeText);
  } catch {
    return null;
  }
}

function readEscapeTokensAt(urlText, startIndex) {
  const escapeTokens = [];
  while (escapeTokens.length < longestUtf8SequenceInBytes) {
    const tokenStart = startIndex + escapeTokens.length * percentEscapeTokenLength;
    const escapeToken = urlText.slice(tokenStart, tokenStart + percentEscapeTokenLength);
    if (!percentEscapeTokenPattern.test(escapeToken)) return escapeTokens;
    escapeTokens.push(escapeToken);
  }
  return escapeTokens;
}

function decodeShortestEscapeSequenceOrNull(escapeTokens) {
  for (let tokenCount = 1; tokenCount <= escapeTokens.length; tokenCount += 1) {
    const decodedText = decodeEscapeTextOrNull(escapeTokens.slice(0, tokenCount).join(''));
    if (decodedText !== null) return { decodedText, tokenCount };
  }
  return null;
}

function decodeUrlTextEscapeByEscape(urlText) {
  let decodedUrlText = '';
  let scanIndex = 0;
  while (scanIndex < urlText.length) {
    const escapeTokens = readEscapeTokensAt(urlText, scanIndex);
    if (escapeTokens.length === 0) {
      decodedUrlText += urlText[scanIndex];
      scanIndex += 1;
      continue;
    }
    const decodedSequence = decodeShortestEscapeSequenceOrNull(escapeTokens);
    if (decodedSequence === null) {
      decodedUrlText += escapeTokens[0];
      scanIndex += percentEscapeTokenLength;
      continue;
    }
    decodedUrlText += decodedSequence.decodedText;
    scanIndex += decodedSequence.tokenCount * percentEscapeTokenLength;
  }
  return decodedUrlText;
}

function hasTransactionWordBelowHost(destination) {
  let urlBelowHost = `${destination.pathname}${destination.search}${destination.hash}`;
  if (transactionWordInUrlPattern.test(urlBelowHost)) return true;
  for (let passNumber = 1; passNumber <= maximumUrlDecodingPasses; passNumber += 1) {
    const decodedUrlBelowHost = decodeUrlTextEscapeByEscape(urlBelowHost);
    if (decodedUrlBelowHost === urlBelowHost) return false;
    if (transactionWordInUrlPattern.test(decodedUrlBelowHost)) return true;
    urlBelowHost = decodedUrlBelowHost;
  }
  return true;
}

function decideBrowseUrl(toolName, urlText, browseHosts) {
  if (typeof urlText !== 'string' || urlText.length === 0) {
    return denyWithReason(`Browse policy denies ${toolName}: the url is missing.`);
  }
  const destination = parseUrlOrNull(urlText);
  if (!destination) return denyWithReason(`Browse policy denies ${toolName}: the url does not parse.`);
  if (!browseSchemes.has(destination.protocol)) {
    return denyWithReason(`Browse policy denies ${toolName}: scheme ${destination.protocol} is not http or https.`);
  }
  if (hasTransactionWordBelowHost(destination)) {
    return denyWithReason(`Browse policy denies ${toolName}: ${destination.hostname} url looks like checkout, and Glissa buys nothing.`);
  }
  if (!isListedBrowseHost(browseHosts, destination.hostname)) {
    return denyWithReason(`Browse policy denies ${toolName}: host ${destination.hostname} is not in browse-domains.json.`);
  }
  return { allow: true };
}

function decideBrowseTurnOrigin(toolName, context) {
  return decideOperatorStartedTurn(
    context,
    `Browse policy denies ${toolName}: the guard cannot tell who started this turn.`,
    `Browse policy denies ${toolName}: only a turn John started acts on a page.`
  );
}

function decideRecordedPageOrigin(toolName, context, browseHosts) {
  if (typeof context.readRecordedPageHost !== 'function') {
    return denyWithReason(`Browse policy denies ${toolName}: the guard cannot tell which page is open.`);
  }
  const recordedPageHost = context.readRecordedPageHost();
  if (typeof recordedPageHost !== 'string' || recordedPageHost.length === 0) {
    return denyWithReason(`Browse policy denies ${toolName}: no fresh page origin is recorded.`);
  }
  if (!isListedBrowseHost(browseHosts, recordedPageHost)) {
    return denyWithReason(`Browse policy denies ${toolName}: the open page host is not in browse-domains.json.`);
  }
  return { allow: true };
}

function decideBrowseSubmit(toolName, actionTexts, context) {
  if (typeof context.judge !== 'function') {
    return denyWithReason(`Browse policy denies ${toolName}: the alignment check is unavailable.`);
  }
  const judgement = context.judge({
    toolName,
    actionText: actionTexts.join(' | '),
    transcriptPath: context.transcriptPath
  });
  if (judgement?.allow === true) return { allow: true };
  return denyWithReason(`Browse policy denies ${toolName}: ${judgement?.reason || 'the alignment check returned no verdict'}.`);
}

function decideBrowseAction(actionName, toolName, toolInput, context, browseHosts) {
  const actionTexts = collectBrowseActionTexts(toolInput);
  if (actionTexts.some((actionText) => purchaseWordInActTextPattern.test(actionText))) {
    return denyWithReason(`Browse policy denies ${toolName}: the target reads as a purchase, and Glissa buys nothing.`);
  }
  const urlText = asFieldMap(toolInput).url;
  if (isFieldPopulated(urlText)) {
    const urlDecision = decideBrowseUrl(toolName, urlText, browseHosts);
    if (!urlDecision.allow) return urlDecision;
  }
  const turnOriginDecision = decideBrowseTurnOrigin(toolName, context);
  if (!turnOriginDecision.allow) return turnOriginDecision;
  const pageOriginDecision = decideRecordedPageOrigin(toolName, context, browseHosts);
  if (!pageOriginDecision.allow) return pageOriginDecision;
  if (!isBrowseSubmitAction(actionName, toolInput, actionTexts)) return { allow: true };
  return decideBrowseSubmit(toolName, actionTexts, context);
}

function decideBrowser(actionName, toolName, toolInput, context = {}) {
  const browseFields = asFieldMap(toolInput);
  if (isFieldPopulated(browseFields.paths)) {
    return denyWithReason(`Browse policy denies ${toolName}: paths uploads a local file.`);
  }
  if (actionName === 'browser_take_screenshot' && isFieldPopulated(browseFields.filename)) {
    return denyWithReason(`Browse policy denies ${toolName}: filename writes into the repository working directory.`);
  }
  if (browseReadTools.has(actionName)) return { allow: true };
  const browseHosts = context.browseHosts instanceof Set ? context.browseHosts : new Set();
  if (actionName === 'browser_navigate') {
    return decideBrowseUrl(toolName, browseFields.url, browseHosts);
  }
  if (actionName === 'browser_tabs') {
    if (browseFields.action !== 'new' || !isFieldPopulated(browseFields.url)) return { allow: true };
    return decideBrowseUrl(toolName, browseFields.url, browseHosts);
  }
  if (!browseActTools.has(actionName)) return deny(toolName);
  return decideBrowseAction(actionName, toolName, toolInput, context, browseHosts);
}

function createShellWordEntry(word, bareText, expandableText, carriesQuoting) {
  return { word, bareText, expandableText, carriesQuoting };
}

function scanShellQuoting(commandText, visitor) {
  let openQuoteCharacter = '';
  for (let characterIndex = 0; characterIndex < commandText.length; characterIndex += 1) {
    const character = commandText[characterIndex];
    if (openQuoteCharacter === "'") {
      if (character === "'") {
        openQuoteCharacter = '';
        continue;
      }
      visitor.onQuotedCharacter(character, false, characterIndex);
      continue;
    }
    if (openQuoteCharacter === '"') {
      if (character === '"') {
        openQuoteCharacter = '';
        continue;
      }
      if (character === '\\' && characterIndex + 1 < commandText.length) {
        characterIndex += 1;
        visitor.onQuotedCharacter(commandText[characterIndex], false, characterIndex);
        continue;
      }
      visitor.onQuotedCharacter(character, true, characterIndex);
      continue;
    }
    if (character === "'" || character === '"') {
      openQuoteCharacter = character;
      visitor.onQuoteOpened();
      continue;
    }
    if (character === '\\' && characterIndex + 1 < commandText.length) {
      characterIndex += 1;
      visitor.onEscapedCharacter(commandText[characterIndex]);
      continue;
    }
    characterIndex += visitor.onUnquotedCharacter(character, characterIndex);
  }
  return openQuoteCharacter === '';
}

function splitShellWordEntries(commandText) {
  const shellWordEntries = [];
  let currentWord = '';
  let currentBareText = '';
  let currentExpandableText = '';
  let currentWordCarriesQuoting = false;
  let isInsideWord = false;
  const finishWord = () => {
    if (isInsideWord) {
      shellWordEntries.push(createShellWordEntry(currentWord, currentBareText, currentExpandableText, currentWordCarriesQuoting));
    }
    currentWord = '';
    currentBareText = '';
    currentExpandableText = '';
    currentWordCarriesQuoting = false;
    isInsideWord = false;
  };
  const closesEveryQuote = scanShellQuoting(commandText, {
    onQuotedCharacter(character, isExpandable) {
      currentWord += character;
      if (isExpandable) currentExpandableText += character;
    },
    onQuoteOpened() {
      isInsideWord = true;
      currentWordCarriesQuoting = true;
    },
    onEscapedCharacter(character) {
      currentWord += character;
      isInsideWord = true;
      currentWordCarriesQuoting = true;
    },
    onUnquotedCharacter(character) {
      if (/\s/.test(character)) {
        finishWord();
        return 0;
      }
      currentWord += character;
      currentBareText += character;
      currentExpandableText += character;
      isInsideWord = true;
      return 0;
    }
  });
  if (!closesEveryQuote) return null;
  finishWord();
  return shellWordEntries;
}

function readCommandBasename(shellWord) {
  const lastPathSeparatorIndex = shellWord.lastIndexOf('/');
  if (lastPathSeparatorIndex === -1) return shellWord;
  return shellWord.slice(lastPathSeparatorIndex + 1);
}

function recordGogFlagValue(flagValuesByName, flagName, flagValue) {
  const recordedValues = flagValuesByName.get(flagName) || [];
  recordedValues.push(flagValue);
  flagValuesByName.set(flagName, recordedValues);
}

function parseGogCommandWords(shellWords) {
  const flagValuesByName = new Map();
  const positionalWords = [];
  let wordIndex = 1;
  while (wordIndex < shellWords.length) {
    const shellWord = shellWords[wordIndex];
    wordIndex += 1;
    if (!shellWord.startsWith('-')) {
      positionalWords.push(shellWord);
      continue;
    }
    if (shellWord.startsWith('--') && shellWord.includes('=')) {
      const valueSeparatorIndex = shellWord.indexOf('=');
      const attachedFlagName = shellWord.slice(2, valueSeparatorIndex);
      const isKnownAttachedFlag =
        gogBooleanFlagNames.has(attachedFlagName) || gogValuedFlagNames.has(attachedFlagName);
      if (!isKnownAttachedFlag) return { unreadableWord: shellWord };
      recordGogFlagValue(flagValuesByName, attachedFlagName, shellWord.slice(valueSeparatorIndex + 1));
      continue;
    }
    if (shellWord.startsWith('--')) {
      const flagName = shellWord.slice(2);
      if (gogBooleanFlagNames.has(flagName)) {
        recordGogFlagValue(flagValuesByName, flagName, true);
        continue;
      }
      if (!gogValuedFlagNames.has(flagName)) return { unreadableWord: shellWord };
      recordGogFlagValue(flagValuesByName, flagName, shellWords[wordIndex] ?? '');
      wordIndex += 1;
      continue;
    }
    const shortFlagLetter = shellWord.slice(1);
    const valuedShortFlagName = gogValuedShortFlagNamesByLetter.get(shortFlagLetter);
    if (valuedShortFlagName !== undefined) {
      recordGogFlagValue(flagValuesByName, valuedShortFlagName, shellWords[wordIndex] ?? '');
      wordIndex += 1;
      continue;
    }
    if (!gogShortBooleanFlagNames.has(shortFlagLetter)) return { unreadableWord: shellWord };
    recordGogFlagValue(
      flagValuesByName,
      gogBooleanShortFlagNamesByLetter.get(shortFlagLetter) ?? shortFlagLetter,
      true
    );
  }
  return { flagValuesByName, positionalWords };
}

function readGogFlagValues(flagValuesByName, flagName) {
  return flagValuesByName.get(flagName) || [];
}

function decideGogStoredAccount(toolName, flagValuesByName) {
  const escapingFlagName = [...flagValuesByName.keys()].find(
    (flagName) => gogFlagNamesLeavingTheStoredAccount.has(flagName)
  );
  if (escapingFlagName === undefined) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: --${escapingFlagName} moves the command off the accounts John authorized.`
  );
}

function decideGogAccountAlias(toolName, flagValuesByName) {
  const accountAliases = readGogFlagValues(flagValuesByName, gogAccountFlagName);
  if (accountAliases.length > 1) {
    return denyWithReason(
      `Write policy denies ${toolName}: ${gogAccountFlagWord} is written ${accountAliases.length} times, and the guard reads one account while gog acts on another.`
    );
  }
  const unknownAlias = accountAliases.find((accountAlias) => !gogAccountAliases.has(accountAlias));
  if (unknownAlias === undefined) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: gog account ${unknownAlias} is not one of John's three accounts.`
  );
}

const gogSilentOnlyReason = `--${gogSendUpdatesFlagName} must be ${gogSilentSendUpdatesValue} so the change mails nobody`;

function denyGogInviteMail(toolName) {
  return denyWithReason(`Write policy denies ${toolName}: ${gogSilentOnlyReason}.`);
}

function decideGogSendUpdates(toolName, flagValuesByName, decideGogInviteMail = () => denyGogInviteMail(toolName)) {
  const sendUpdatesValues = readGogFlagValues(flagValuesByName, gogSendUpdatesFlagName);
  if (sendUpdatesValues.length === 0) {
    return denyWithReason(
      `Write policy denies ${toolName}: --${gogSendUpdatesFlagName} ${gogSilentSendUpdatesValue} must be written out, because the default mails the guests on the event.`
    );
  }
  const loweredSendUpdatesValues = sendUpdatesValues.map((sendUpdatesValue) => String(sendUpdatesValue).toLowerCase());
  if (loweredSendUpdatesValues.every((sendUpdatesValue) => sendUpdatesValue === gogSilentSendUpdatesValue)) {
    return { allow: true };
  }
  if (loweredSendUpdatesValues.every((sendUpdatesValue) => sendUpdatesValue === gogEveryGuestSendUpdatesValue)) {
    return decideGogInviteMail();
  }
  return denyGogInviteMail(toolName);
}

function readGogAttendeeAddresses(flagValuesByName) {
  return gogAttendeeFlagNames
    .flatMap((flagName) => readGogFlagValues(flagValuesByName, flagName))
    .flatMap((flagValue) => String(flagValue).split(','));
}

function readLiveAttendeeAddresses(context, flagValuesByName, targetWords) {
  if (typeof context.readCalendarEventAttendees !== 'function') return null;
  const accountAlias = readGogFlagValues(flagValuesByName, gogAccountFlagName)[0];
  try {
    const liveAttendeeAddresses = context.readCalendarEventAttendees(accountAlias, targetWords[0], targetWords[1]);
    if (!isArrayOfStrings(liveAttendeeAddresses)) return null;
    return liveAttendeeAddresses;
  } catch {
    return null;
  }
}

function createGogInviteMailDecider(toolName, calendarActionName, targetWords, flagValuesByName, context) {
  const readAttendeesAlreadyOnTheEvent = calendarActionName === gogCalendarCreateAction
    ? noAttendeesBeforeACreate
    : () => readLiveAttendeeAddresses(context, flagValuesByName, targetWords);
  let inviteMailDecision;
  return () => {
    if (inviteMailDecision !== undefined) return inviteMailDecision;
    inviteMailDecision = decideInviteMail(
      toolName,
      gogSilentOnlyReason,
      readGogAttendeeAddresses(flagValuesByName),
      readAttendeesAlreadyOnTheEvent,
      context
    );
    return inviteMailDecision;
  };
}

function decideGogAttendeeChange(toolName, calendarActionName, flagValuesByName, decideGogInviteMail, context) {
  const acceptedFlagName = gogAttendeeFlagNamesByAction.get(calendarActionName);
  const forbiddenFlagName = gogAttendeeFlagNames.find(
    (flagName) => flagName !== acceptedFlagName && flagValuesByName.has(flagName)
  );
  if (forbiddenFlagName !== undefined) {
    return denyWithReason(
      `Write policy denies ${toolName}: --${forbiddenFlagName} is not an additive guest flag on calendar ${calendarActionName}.`
    );
  }
  const attendeeEmails = readGogFlagValues(flagValuesByName, acceptedFlagName).flatMap(
    (flagValue) => flagValue.split(',')
  );
  const unreadableAddress = attendeeEmails.find((attendeeEmail) => !gogPlainEmailPattern.test(attendeeEmail));
  if (unreadableAddress !== undefined) {
    return denyWithReason(
      `Write policy denies ${toolName}: --${acceptedFlagName} address ${JSON.stringify(unreadableAddress)} must be one plain email address.`
    );
  }
  const unrestrictedPermissionFlagName = gogGuestPermissionFlagNames.find((flagName) => {
    const permissionValues = readGogFlagValues(flagValuesByName, flagName);
    return permissionValues.length === 0 || permissionValues.some((permissionValue) => permissionValue !== 'false');
  });
  if (unrestrictedPermissionFlagName !== undefined) {
    return denyWithReason(
      `Write policy denies ${toolName}: --${acceptedFlagName} adds a guest, so --${unrestrictedPermissionFlagName}=false must be written out and never turned on.`
    );
  }
  const sendUpdatesDecision = decideGogSendUpdates(toolName, flagValuesByName, decideGogInviteMail);
  if (!sendUpdatesDecision.allow) return sendUpdatesDecision;
  const attendeeFieldName = `--${acceptedFlagName}`;
  return decideAttendeeChange(toolName, [attendeeFieldName], {
    [attendeeFieldName]: attendeeEmails,
    notificationLevel: silentNotificationLevel,
    guestPermissions: Object.fromEntries(restrictiveGuestPermissionNames.map((permissionName) => [permissionName, false]))
  }, context);
}

function decideGogCalendarEventWrite(toolName, calendarActionName, targetWords, flagValuesByName, context) {
  const targetDecision = decideCalendarIdAllowed(toolName, targetWords[0], readAllowedCalendarIds(context));
  if (!targetDecision.allow) return targetDecision;
  if (flagValuesByName.has(gogForceFlagName)) {
    return denyWithReason(
      `Write policy denies ${toolName}: --${gogForceFlagName} is a flag only the delete action carries.`
    );
  }
  const decideGogInviteMail = createGogInviteMailDecider(
    toolName,
    calendarActionName,
    targetWords,
    flagValuesByName,
    context
  );
  const attendeeFlagName = gogAttendeeFlagNames.find((flagName) => flagValuesByName.has(flagName));
  if (attendeeFlagName !== undefined) {
    const attendeeDecision = decideGogAttendeeChange(
      toolName,
      calendarActionName,
      flagValuesByName,
      decideGogInviteMail,
      context
    );
    if (!attendeeDecision.allow) return attendeeDecision;
  }
  const guestPermissionFlagName = gogGuestPermissionFlagNames.find((flagName) => flagValuesByName.has(flagName));
  if (attendeeFlagName === undefined && guestPermissionFlagName !== undefined) {
    return denyWithReason(
      `Write policy denies ${toolName}: --${guestPermissionFlagName} hands the guests already on the event more than read access.`
    );
  }
  const foreignEventType = readGogFlagValues(flagValuesByName, gogEventTypeFlagName).find(
    (eventTypeValue) => String(eventTypeValue).toLowerCase() !== gogOrdinaryEventTypeValue
  );
  if (foreignEventType !== undefined) {
    return denyWithReason(
      `Write policy denies ${toolName}: --${gogEventTypeFlagName} ${foreignEventType} is not the ordinary hold the write policy allows, and Google answers invitations for some of them.`
    );
  }
  const sendUpdatesDecision = decideGogSendUpdates(toolName, flagValuesByName, decideGogInviteMail);
  if (!sendUpdatesDecision.allow) return sendUpdatesDecision;
  const publicVisibility = readGogFlagValues(flagValuesByName, gogVisibilityFlagName).find(
    (visibilityValue) => String(visibilityValue).toLowerCase() === forbiddenEventVisibility
  );
  if (publicVisibility !== undefined) {
    return denyWithReason(`Write policy denies ${toolName}: visibility ${forbiddenEventVisibility} exposes the hold.`);
  }
  const oversizedFlagName = gogEventTextFlagNames.find((flagName) =>
    readGogFlagValues(flagValuesByName, flagName).some(
      (textValue) => String(textValue).length > maxEventTextLength
    )
  );
  if (oversizedFlagName === undefined) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: --${oversizedFlagName} is longer than ${maxEventTextLength} characters.`
  );
}

function readEventRecurrence(context, flagValuesByName, targetWords) {
  if (typeof context.readCalendarEventRecurrence !== 'function') return unreadableEventRecurrence;
  const accountAlias = readGogFlagValues(flagValuesByName, gogAccountFlagName)[0];
  try {
    const eventRecurrence = context.readCalendarEventRecurrence(accountAlias, targetWords[0], targetWords[1]);
    if (readableEventRecurrences.has(eventRecurrence)) return eventRecurrence;
    return unreadableEventRecurrence;
  } catch {
    return unreadableEventRecurrence;
  }
}

function readTargetEventSummary(context, flagValuesByName, targetWords) {
  if (typeof context.readCalendarEventSummary !== 'function') return null;
  const accountAlias = readGogFlagValues(flagValuesByName, gogAccountFlagName)[0];
  try {
    const eventSummary = context.readCalendarEventSummary(accountAlias, targetWords[0], targetWords[1]);
    if (typeof eventSummary !== 'string') return null;
    const trimmedEventSummary = eventSummary.trim();
    if (trimmedEventSummary.length === 0) return null;
    return trimmedEventSummary;
  } catch {
    return null;
  }
}

function readSeriesWordStandingInTheNewestMessage(context) {
  return readSeriesWordStanding(
    readOperatorTextOrEmpty(context.readNewestOperatorMessageText, context.transcriptPath)
  );
}

function describeTheMissingSeriesWord(seriesWordStanding) {
  if (seriesWordStanding === intentWordNegated) {
    return `every ${recurringSeriesWords.join(', ')} in John's newest message is negated by one of ${negationWords.concat(wordsKeepingTheSeriesBeforeIt).join(', ')}`;
  }
  return `John's newest message names none of ${recurringSeriesWords.join(', ')}`;
}

function decidePlainEventScope(toolName, scopeValues) {
  if (scopeValues.length === 0) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: --${gogScopeFlagName} ${scopeValues[0]} names part of a repeating event, and this event does not repeat.`
  );
}

function decideSingleInstanceScope(toolName, flagValuesByName) {
  if (flagValuesByName.has(gogOriginalStartFlagName)) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: --${gogScopeFlagName} ${gogSingleInstanceScopeValue} must name the instance it removes with --${gogOriginalStartFlagName}.`
  );
}

function decideSeriesWideScope(toolName, seriesWideScopeValue, context) {
  const seriesWordStanding = readSeriesWordStandingInTheNewestMessage(context);
  if (seriesWordStanding === intentWordAsked) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: --${gogScopeFlagName} ${seriesWideScopeValue} removes more than the one event, and ${describeTheMissingSeriesWord(seriesWordStanding)}.`
  );
}

function decideSeriesMasterWithNoScope(toolName, context) {
  const seriesWordStanding = readSeriesWordStandingInTheNewestMessage(context);
  if (seriesWordStanding === intentWordAsked) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: the delete names the master of a repeating event, so it removes every occurrence, and ${describeTheMissingSeriesWord(seriesWordStanding)}.`
  );
}

function decideGogCalendarDeleteScope(toolName, targetWords, flagValuesByName, context) {
  const eventRecurrence = readEventRecurrence(context, flagValuesByName, targetWords);
  if (eventRecurrence === unreadableEventRecurrence) {
    return denyWithReason(
      `Write policy denies ${toolName}: the delete removes an event, and reading whether that event repeats failed, so the guard cannot tell one occurrence from a whole series.`
    );
  }
  const scopeValues = readGogFlagValues(flagValuesByName, gogScopeFlagName).map(
    (scopeValue) => String(scopeValue).toLowerCase()
  );
  if (eventRecurrence === plainEventRecurrence) return decidePlainEventScope(toolName, scopeValues);
  const namesOneInstance = scopeValues.includes(gogSingleInstanceScopeValue);
  if (namesOneInstance) {
    const singleInstanceDecision = decideSingleInstanceScope(toolName, flagValuesByName);
    if (!singleInstanceDecision.allow) return singleInstanceDecision;
  }
  const seriesWideScopeValue = scopeValues.find((scopeValue) => scopeValue !== gogSingleInstanceScopeValue);
  if (seriesWideScopeValue !== undefined) return decideSeriesWideScope(toolName, seriesWideScopeValue, context);
  if (namesOneInstance) return { allow: true };
  if (eventRecurrence === seriesOccurrenceEventRecurrence) return { allow: true };
  return decideSeriesMasterWithNoScope(toolName, context);
}

function decideGogCalendarDelete(toolName, targetWords, flagValuesByName, context) {
  const targetDecision = decideCalendarIdAllowed(toolName, targetWords[0], readAllowedCalendarIds(context));
  if (!targetDecision.allow) return targetDecision;
  const sendUpdatesDecision = decideGogSendUpdates(toolName, flagValuesByName);
  if (!sendUpdatesDecision.allow) return sendUpdatesDecision;
  const operatorTurnDecision = decideOperatorStartedTurn(
    context,
    `Write policy denies ${toolName}: the delete removes an event and the guard cannot tell who started this turn.`,
    `Write policy denies ${toolName}: the delete removes an event, and only a turn John started removes one.`
  );
  if (!operatorTurnDecision.allow) return operatorTurnDecision;
  const deleteAskedDecision = decideCalendarDeleteAsked(toolName, context, () =>
    readTargetEventSummary(context, flagValuesByName, targetWords)
  );
  if (!deleteAskedDecision.allow) return deleteAskedDecision;
  return decideGogCalendarDeleteScope(toolName, targetWords, flagValuesByName, context);
}

function decideGogCalendarEventsReadWindow(toolName, flagValuesByName) {
  const hasExactBounds = calendarWindowBoundNames.every((boundName) => {
    const boundValues = readGogFlagValues(flagValuesByName, boundName);
    return boundValues.length === 1 && isCalendarWindowBound(boundValues[0]);
  });
  if (!hasExactBounds) return denyCalendarWindow(toolName);
  if (calendarRelativeWindowFieldNames.some((flagName) => flagValuesByName.has(flagName))) return denyCalendarWindow(toolName);
  return { allow: true };
}

function decideGogCalendarAction(toolName, calendarActionName, targetWords, flagValuesByName, context) {
  if (gogCalendarEventListActions.has(calendarActionName)) return decideGogCalendarEventsReadWindow(toolName, flagValuesByName);
  if (gogCalendarReadActions.has(calendarActionName)) return { allow: true };
  const expectedTargetCount = gogCalendarTargetCountsByAction.get(calendarActionName);
  if (targetWords.length !== expectedTargetCount) {
    return denyWithReason(
      `Write policy denies ${toolName}: gog calendar ${calendarActionName} names ${targetWords.length} targets instead of ${expectedTargetCount}.`
    );
  }
  if (calendarActionName === gogCalendarDeleteAction) {
    return decideGogCalendarDelete(toolName, targetWords, flagValuesByName, context);
  }
  return decideGogCalendarEventWrite(toolName, calendarActionName, targetWords, flagValuesByName, context);
}

function decideGogFlagsBeforeTheCalendarWord(toolName, shellWords) {
  const wordAfterTheWrapper = shellWords[1];
  if (wordAfterTheWrapper === undefined) return { allow: true };
  if (!wordAfterTheWrapper.startsWith('-')) return { allow: true };
  if (wordAfterTheWrapper === gogAccountFlagWord && shellWords[3] === gogCalendarSubcommandName) {
    return { allow: true };
  }
  return denyWithReason(
    `Write policy denies ${toolName}: ${wordAfterTheWrapper} runs before the ${gogCalendarSubcommandName} word, where the only flag the wrapper reads is the account written as ${gogAccountFlagWord} followed by the alias.`
  );
}

function decideGogCommandWords(toolName, shellWords, context) {
  const { unreadableWord, flagValuesByName, positionalWords } = parseGogCommandWords(shellWords);
  if (unreadableWord !== undefined) {
    return denyWithReason(`Write policy denies ${toolName}: gog flag ${unreadableWord} is not one the guard reads.`);
  }
  const storedAccountDecision = decideGogStoredAccount(toolName, flagValuesByName);
  if (!storedAccountDecision.allow) return storedAccountDecision;
  const accountAliasDecision = decideGogAccountAlias(toolName, flagValuesByName);
  if (!accountAliasDecision.allow) return accountAliasDecision;
  const leadingFlagDecision = decideGogFlagsBeforeTheCalendarWord(toolName, shellWords);
  if (!leadingFlagDecision.allow) return leadingFlagDecision;
  const [subcommandName, calendarActionName, ...targetWords] = positionalWords;
  if (subcommandName !== gogCalendarSubcommandName) {
    return denyWithReason(`Write policy denies ${toolName}: gog ${subcommandName || 'with no subcommand'} is not the calendar command.`);
  }
  if (!gogCalendarReadActions.has(calendarActionName) && !gogCalendarTargetCountsByAction.has(calendarActionName)) {
    return denyWithReason(
      `Write policy denies ${toolName}: gog calendar ${calendarActionName || 'with no action'} is not a read, a create, an update, or a delete.`
    );
  }
  return decideGogCalendarAction(toolName, calendarActionName, targetWords, flagValuesByName, context);
}

function splitOnWhitespaceRuns(commandText) {
  return commandText.split(/\s+/).filter((rawWord) => rawWord.length > 0);
}

function readWordListToScan(commandText, shellWordEntries) {
  if (shellWordEntries === null) return splitOnWhitespaceRuns(commandText);
  return shellWordEntries.map((shellWordEntry) => shellWordEntry.word);
}


function findFirstCommandNameIndex(wordList) {
  let wordIndex = 0;
  while (wordIndex < wordList.length && leadingAssignmentWordPattern.test(wordList[wordIndex])) {
    wordIndex += 1;
  }
  return wordIndex;
}

function findIndexesAfterWrappers(wordList) {
  return wordList
    .map((word, wordIndex) => ({ word, nextWordIndex: wordIndex + 1 }))
    .filter(({ word, nextWordIndex }) =>
      nextWordIndex < wordList.length && wrapperCommandBasenames.has(readCommandBasename(word))
    )
    .map(({ nextWordIndex }) => nextWordIndex);
}

function findCommandNameIndexes(wordList, includesWordsAfterWrappers) {
  if (!includesWordsAfterWrappers) return [findFirstCommandNameIndex(wordList)];
  return [findFirstCommandNameIndex(wordList), ...findIndexesAfterWrappers(wordList)];
}

function findCommandNameWords(wordList, includesWordsAfterWrappers) {
  return findCommandNameIndexes(wordList, includesWordsAfterWrappers)
    .map((wordIndex) => wordList[wordIndex])
    .filter((commandNameWord) => commandNameWord !== undefined);
}

function readTextOutsideGuardedScriptNames(text) {
  return guardedScriptBasenames.reduce(
    (remainingText, scriptName) => remainingText.replaceAll(scriptName, ' '),
    text
  );
}

function findIndexesRunByWrapperAt(wordList, wrapperIndex) {
  const indexesRunByWrapper = [];
  let wordIndex = wrapperIndex + 1;
  while (wordIndex < wordList.length && indexesRunByWrapper.length < maxWordsRunByAWrapper) {
    if (!wordList[wordIndex].startsWith('-')) indexesRunByWrapper.push(wordIndex);
    wordIndex += 1;
  }
  return indexesRunByWrapper;
}

function findIndexesAProgramCouldRun(wordList) {
  return [
    findFirstCommandNameIndex(wordList),
    ...wordList.flatMap((word, wordIndex) =>
      wrapperCommandBasenames.has(readCommandBasename(word)) ? findIndexesRunByWrapperAt(wordList, wordIndex) : []
    )
  ];
}

function decideGuardedScriptName(toolName, commandText, shellWordEntries) {
  const wordList = readWordListToScan(commandText, shellWordEntries);
  const guardedScriptName = findIndexesAProgramCouldRun(wordList)
    .map((wordIndex) => wordList[wordIndex])
    .filter((runnableWord) => runnableWord !== undefined)
    .map((runnableWord) => readCommandBasename(runnableWord))
    .find((wordBasename) => guardedScriptBasenames.includes(wordBasename));
  if (guardedScriptName === undefined) return { allow: true };
  const denyReason = guardedScriptDenyReasonByBasename[guardedScriptName] ?? 'rewrites the stored account setup and never runs from a session';
  return denyWithReason(`Write policy denies ${toolName}: ${guardedScriptName} ${denyReason}.`);
}

function denyBufferDraftLedgerWrite(toolName) {
  return denyWithReason(`Write policy denies ${toolName}: the guard alone keeps the record of Buffer drafts Glissa saved, because that record is what lets an edit through.`);
}

function decideCommandAvoidsBufferKey(toolName, commandText) {
  const lowercaseCommandText = commandText.toLowerCase();
  const bufferKeyMarker = bufferKeyMarkers.find((marker) => lowercaseCommandText.includes(marker));
  if (lowercaseCommandText.includes(bufferDraftLedgerMarker)) return denyBufferDraftLedgerWrite(toolName);
  if (bufferKeyMarker === undefined) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: the command names ${bufferKeyMarker}, and the Buffer key it reaches can publish, so only the guarded Buffer MCP read tools use it.`
  );
}

function doesCommandNameGog(commandText) {
  return readTextOutsideGuardedScriptNames(commandText.toLowerCase()).includes(gogCommandBasename);
}

function decideCommandNameIsNotExpanded(toolName, commandText, shellWordEntries, commandNamesGog) {
  const expandedCommandName = findCommandNameWords(readWordListToScan(commandText, shellWordEntries), commandNamesGog)
    .find((commandNameWord) =>
      commandNameForbiddenCharacters.some((forbiddenCharacter) => commandNameWord.includes(forbiddenCharacter))
    );
  if (expandedCommandName === undefined) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: the command name ${expandedCommandName} expands to something the guard cannot read.`
  );
}

function decideCommandNameIsNotQuoted(toolName, shellWordEntries, commandNamesGog) {
  if (shellWordEntries === null) return { allow: true };
  const shellWords = shellWordEntries.map((shellWordEntry) => shellWordEntry.word);
  const quotedCommandName = findCommandNameIndexes(shellWords, commandNamesGog)
    .map((wordIndex) => shellWordEntries[wordIndex])
    .filter((shellWordEntry) => shellWordEntry !== undefined)
    .find((shellWordEntry) => shellWordEntry.carriesQuoting);
  if (quotedCommandName === undefined) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: the command name ${quotedCommandName.word} is written with quotes or backslashes, which only hides what runs.`
  );
}

function decideGogRunUnderAnotherProgram(toolName, shellWords) {
  const wrapperWord = findCommandNameWords(shellWords, true).find((commandNameWord) =>
    wrapperCommandBasenames.has(readCommandBasename(commandNameWord))
  );
  if (wrapperWord === undefined) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: ${wrapperWord} runs gog out of the guard's sight.`
  );
}

function findExpansionMarkerOutsideSingleQuotes(commandText, shellWordEntries) {
  if (shellWordEntries === null) return shellExpansionMarkers.find((marker) => commandText.includes(marker));
  return shellExpansionMarkers.find((marker) =>
    shellWordEntries.some((shellWordEntry) => shellWordEntry.expandableText.includes(marker))
  );
}

function findCompositionMarkerOutsideQuotes(commandText, shellWordEntries) {
  if (shellWordEntries === null) return shellCompositionMarkers.find((marker) => commandText.includes(marker));
  return shellCompositionMarkers.find((marker) =>
    shellWordEntries.some((shellWordEntry) => shellWordEntry.bareText.includes(marker))
  );
}

function findLineBreakMarkerInRawText(commandText) {
  return shellLineBreakMarkers.find((marker) => commandText.includes(marker));
}

function findRedirectionMarkerOutsideQuotes(shellWordEntries) {
  return shellRedirectionMarkers.find((marker) =>
    shellWordEntries.some((shellWordEntry) => shellWordEntry.bareText.includes(marker))
  );
}

function findMarkerOpeningAnUnquotedWord(shellWordEntries) {
  return shellWordOpeningExpansionMarkers.find((marker) =>
    shellWordEntries.some(
      (shellWordEntry) => shellWordEntry.bareText.startsWith(marker) && shellWordEntry.word.startsWith(marker)
    )
  );
}

function decideGogCommandFreeOfExpansion(toolName, commandText, shellWordEntries) {
  const expansionMarker = findExpansionMarkerOutsideSingleQuotes(commandText, shellWordEntries);
  if (expansionMarker !== undefined) {
    return denyWithReason(
      `Write policy denies ${toolName}: ${expansionMarker} expands before gog runs, so the guard cannot read the real command.`
    );
  }
  const globMarker = shellGlobMarkers.find((marker) =>
    shellWordEntries.some((shellWordEntry) => shellWordEntry.bareText.includes(marker))
  );
  if (globMarker !== undefined) {
    return denyWithReason(
      `Write policy denies ${toolName}: ${globMarker} expands before gog runs, so the guard cannot read the real command.`
    );
  }
  const wordOpeningMarker = findMarkerOpeningAnUnquotedWord(shellWordEntries);
  if (wordOpeningMarker === undefined) return { allow: true };
  return denyWithReason(
    `Write policy denies ${toolName}: ${wordOpeningMarker} expands before gog runs, so the guard cannot read the real command.`
  );
}

function isCalendarWrapperCommandName(commandNameWord) {
  if (commandNameWord === gogCalendarWrapperPath) return true;
  if (!commandNameWord.startsWith('/')) return false;
  return readCommandBasename(commandNameWord) === gogCalendarWrapperBasename;
}

function decideCommandNamingGog(toolName, commandText, shellWordEntries, context) {
  if (shellWordEntries === null) {
    return denyWithReason(`Write policy denies ${toolName}: the command naming gog does not split into shell words.`);
  }
  const shellWords = shellWordEntries.map((shellWordEntry) => shellWordEntry.word);
  const wrapperDecision = decideGogRunUnderAnotherProgram(toolName, shellWords);
  if (!wrapperDecision.allow) return wrapperDecision;
  const expansionDecision = decideGogCommandFreeOfExpansion(toolName, commandText, shellWordEntries);
  if (!expansionDecision.allow) return expansionDecision;
  if (findLineBreakMarkerInRawText(commandText) !== undefined) {
    return denyWithReason(
      `Write policy denies ${toolName}: a line break carries a second command the guard never read, so gog runs as one line or not at all.`
    );
  }
  if (findCompositionMarkerOutsideQuotes(commandText, shellWordEntries) !== undefined) {
    return denyWithReason(`Write policy denies ${toolName}: gog runs as one simple command, never joined to another.`);
  }
  const redirectionMarker = findRedirectionMarkerOutsideQuotes(shellWordEntries);
  if (redirectionMarker !== undefined) {
    return denyWithReason(
      `Write policy denies ${toolName}: ${redirectionMarker} redirects a file around the guard, which can overwrite ${gogCalendarWrapperPath} itself.`
    );
  }
  if (isCalendarWrapperCommandName(shellWords[0])) return decideGogCommandWords(toolName, shellWords, context);
  if (readCommandBasename(shellWords[0]) === gogCommandBasename) {
    return denyWithReason(
      `Write policy denies ${toolName}: calendar commands run through ${gogCalendarWrapperPath}, because the bare gog binary has no keyring password in this session.`
    );
  }
  return denyWithReason(`Write policy denies ${toolName}: gog must be the command itself, not a word inside another one.`);
}

const memoryDirectoryBasename = 'memory';
const memoryPathMentionPattern = /(?:^|[^A-Za-z0-9_.-])memory\//;
const shellCommandSeparators = ['&&', '||', ';;', '|&', ';', '|', '&', '\n', '\r', '(', ')'];
const shellSubstitutionMarkers = ['$(', '`', '<(', '>('];
const shellRedirectionStartCharacters = new Set(['<', '>']);
const fileDescriptorPattern = /^[0-9]+$/;
const shellReservedWords = new Set(['{', '}', '!', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', 'time']);
const outputRedirectionKind = 'output';
const inputRedirectionKind = 'input';
const memoryReachInside = 'inside';
const memoryReachAncestor = 'ancestor';
const memoryReachNone = 'none';
const anyArgumentMemoryWriterBasenames = new Set(['tee', 'truncate', 'touch', 'mkdir', 'rmdir', 'shred', 'mkfifo', 'mknod', 'split', 'csplit', 'ln', 'ed', 'ex', 'vi', 'vim', 'nvim', 'nano', 'emacs']);
const ancestorReachingMemoryWriterBasenames = new Set(['rm', 'chmod', 'chown', 'chgrp']);
const destinationMemoryWriterBasenames = new Set(['install']);
const inPlaceCompressorBasenames = new Set(['gzip', 'gunzip', 'bzip2', 'xz', 'zstd']);
const inPlaceAwkBasenames = new Set(['awk', 'gawk']);
const outputFlagsByWriterBasename = new Map([
  ['curl', ['-o', '--output', '--output-dir']],
  ['wget', ['-O', '--output-document', '-P', '--directory-prefix']],
  ['sort', ['-o', '--output']]
]);
const commandPrefixValueFlagsByBasename = new Map([
  ['nice', new Set(['-n', '--adjustment'])],
  ['nohup', new Set()],
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
  ['stdbuf', new Set(['-i', '-o', '-e', '--input', '--output', '--error'])],
  ['command', new Set()],
  ['exec', new Set(['-a'])],
  ['sudo', new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type', '--other-user', '--close-from', '--command-timeout'])],
  ['busybox', new Set()],
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])]
]);
const positionalWordsBeforeTheCommandByPrefix = new Map([['timeout', 1]]);
const envDirectoryFlags = ['-C', '--chdir'];
const standardOutputFlagPattern = /^-[A-Za-z]*c[A-Za-z]*$|^--(?:stdout|to-stdout)$/;
const recursiveCopyFlagPattern = /^-[A-Za-z]*[rRa][A-Za-z]*$|^--(?:recursive|archive)$/;
const rsyncDeletingFlagPattern = /^--(?:delete|remove-source-files)/;
const zipMoveFlagPattern = /^-[A-Za-z]*m[A-Za-z]*$|^--move$/;
const gitStashIgnoredFilesFlagPattern = /^-[A-Za-z]*a[A-Za-z]*$|^--all$/;
const unzipReadOnlyFlags = new Set(['-l', '-t', '-p', '-v', '-Z', '-c']);
const unzipDirectoryFlags = ['-d'];
const workingDirectoryOperand = '.';
const knownShellCommandSubstitutionPattern = /\$\(\s*pwd\s*\)|`\s*pwd\s*`/g;
const shellVariableReferencePattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const leadingHomeTildePattern = /^~(?=\/|$)/;
const inPlaceEditorBasenames = new Set(['sed', 'perl']);
const inlineCodeInterpreterBasenames = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish', 'python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php']);
const shellStringRunnerBasenames = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
const shellEvaluatingBasenames = new Set(['eval', 'source', '.']);
const directoryChangingBasenames = new Set(['cd', 'pushd']);
const unknownDirectoryTarget = '$OLDPWD';
const homeDirectoryTarget = '~';
const workingDirectoryVariableName = 'PWD';
const maxTrackedWorkingDirectories = 32;
const gitMemoryWritingSubcommands = new Set(['checkout', 'restore', 'rm', 'mv', 'apply', 'clean', 'stash']);
const gitValuedGlobalFlags = new Set(['-C', '-c', '--git-dir', '--work-tree']);
const gitCleanIgnoredFilesFlagPattern = /^-[A-Za-z]*[xX]/;
const findWritingActions = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);
const findExecActions = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const findExecTerminators = new Set([';', '+']);
const findFoundPathPlaceholder = '{}';
const targetDirectoryFlags = ['-t', '--target-directory'];
const tarDirectoryFlags = ['-C', '--directory'];
const tarExtractLongFlags = new Set(['--extract', '--get']);
const tarCreateLongFlags = new Set(['--create', '--append', '--update', '--catenate', '--concatenate']);
const tarCreateModeLetters = ['c', 'r', 'u', 'A'];
const tarArchiveFileBundlePattern = /^-?[A-Za-z]*f[A-Za-z]*$/;
const tarArchiveFileLongFlag = '--file';
const ddOutputFilePrefix = 'of=';
const inPlaceFlagPattern = /^-[A-Za-z]*i|^--in-place(?:=|$)/;
const inlineCodeFlagPattern = /^-[A-Za-z]*[ceE][A-Za-z]*$|^-p$|^--(?:eval|print|command)(?:=|$)/;
const shellStringFlagPattern = /^-[A-Za-z]*c[A-Za-z]*$/;
const standardInputOperand = '-';
const attachedShortFlagValuePattern = /^-[A-Za-z]./;
const useWriteOrEditForMemory = 'use Write or Edit for memory, because the guard checks memory rules only on those tools';
function createSimpleShellCommand() {
  return { words: [], outputRedirectionTargets: [] };
}

function findMarkerAt(commandText, characterIndex, markers) {
  return markers.find((marker) => commandText.startsWith(marker, characterIndex));
}

function readRedirectionAt(commandText, characterIndex) {
  const redirectionMarker = findMarkerAt(commandText, characterIndex, shellRedirectionMarkers);
  if (redirectionMarker === undefined) return null;
  const followingCharacter = commandText[characterIndex + redirectionMarker.length];
  const extendsTheMarker = (redirectionMarker === '&>' && followingCharacter === '>')
    || (redirectionMarker === '>' && followingCharacter === '&')
    || (redirectionMarker === '<' && followingCharacter === '>');
  const markerLength = redirectionMarker.length + (extendsTheMarker ? 1 : 0);
  const markerText = commandText.slice(characterIndex, characterIndex + markerLength);
  const redirectionKind = markerText.includes('>') ? outputRedirectionKind : inputRedirectionKind;
  return { redirectionKind, markerLength };
}

function startsARedirection(commandText, characterIndex) {
  const character = commandText[characterIndex];
  if (shellRedirectionStartCharacters.has(character)) return true;
  return character === '&' && commandText[characterIndex + 1] === '>';
}

function splitSimpleShellCommands(commandText) {
  const simpleCommands = [createSimpleShellCommand()];
  let hasSubstitution = false;
  let currentWord = '';
  let isInsideWord = false;
  let isCurrentWordQuoted = false;
  let pendingRedirectionKind = null;
  const finishWord = () => {
    if (!isInsideWord) return;
    const currentCommand = simpleCommands[simpleCommands.length - 1];
    if (pendingRedirectionKind === outputRedirectionKind) currentCommand.outputRedirectionTargets.push(currentWord);
    if (pendingRedirectionKind === null) currentCommand.words.push(currentWord);
    pendingRedirectionKind = null;
    currentWord = '';
    isInsideWord = false;
    isCurrentWordQuoted = false;
  };
  const noteSubstitutionAt = (characterIndex) => {
    if (findMarkerAt(commandText, characterIndex, shellSubstitutionMarkers) !== undefined) hasSubstitution = true;
  };
  const closesEveryQuote = scanShellQuoting(commandText, {
    onQuotedCharacter(character, isExpandable, characterIndex) {
      if (isExpandable) noteSubstitutionAt(characterIndex);
      currentWord += character;
    },
    onQuoteOpened() {
      isInsideWord = true;
      isCurrentWordQuoted = true;
    },
    onEscapedCharacter(character) {
      currentWord += character;
      isInsideWord = true;
      isCurrentWordQuoted = true;
    },
    onUnquotedCharacter(character, characterIndex) {
      noteSubstitutionAt(characterIndex);
      if (startsARedirection(commandText, characterIndex)) {
        const namesAFileDescriptor = isInsideWord && !isCurrentWordQuoted && fileDescriptorPattern.test(currentWord);
        if (namesAFileDescriptor) {
          currentWord = '';
          isInsideWord = false;
        }
        finishWord();
        const { redirectionKind, markerLength } = readRedirectionAt(commandText, characterIndex);
        pendingRedirectionKind = redirectionKind;
        return markerLength - 1;
      }
      const commandSeparator = findMarkerAt(commandText, characterIndex, shellCommandSeparators);
      if (commandSeparator !== undefined) {
        finishWord();
        pendingRedirectionKind = null;
        simpleCommands.push(createSimpleShellCommand());
        return commandSeparator.length - 1;
      }
      if (/\s/.test(character)) {
        finishWord();
        return 0;
      }
      currentWord += character;
      isInsideWord = true;
      return 0;
    }
  });
  if (!closesEveryQuote) return null;
  finishWord();
  return { simpleCommands, hasSubstitution };
}

function convertGlobComponentToPattern(pathComponent) {
  const bracketPlaceholder = '\u0000';
  const bracePlaceholder = '\u0001';
  const patternSource = pathComponent
    .replace(/\[[^\]]*\]/g, bracketPlaceholder)
    .replace(/\{[^}]*\}/g, bracePlaceholder)
    .replace(regularExpressionSpecialCharacterPattern, '\\$&')
    .replaceAll('\\*', '[^/]*')
    .replaceAll('\\?', '.')
    .replaceAll(bracketPlaceholder, '.')
    .replaceAll(bracePlaceholder, '.*');
  return new RegExp(`^${patternSource}$`);
}

function doesPathComponentMatch(candidateComponent, memoryRootComponent) {
  const isGlobComponent = shellGlobMarkers.some((marker) => candidateComponent.includes(marker));
  if (!isGlobComponent) return candidateComponent === memoryRootComponent;
  return convertGlobComponentToPattern(candidateComponent).test(memoryRootComponent);
}

function splitAbsolutePathComponents(absolutePath) {
  return absolutePath.split(path.sep).filter((pathComponent) => pathComponent.length > 0);
}

function readReachOfMemoryRoot(candidatePath, memoryRoot, workingDirectory) {
  const resolvedCandidatePath = path.resolve(workingDirectory, candidatePath);
  if (isLexicallyInsideMemory(memoryRoot, resolvedCandidatePath)) return memoryReachInside;
  const candidateComponents = splitAbsolutePathComponents(resolvedCandidatePath);
  const memoryRootComponents = splitAbsolutePathComponents(path.resolve(memoryRoot));
  const comparedLength = Math.min(candidateComponents.length, memoryRootComponents.length);
  const isOnTheMemoryRootPath = candidateComponents
    .slice(0, comparedLength)
    .every((candidateComponent, componentIndex) => doesPathComponentMatch(candidateComponent, memoryRootComponents[componentIndex]));
  if (!isOnTheMemoryRootPath) return memoryReachNone;
  if (candidateComponents.length >= memoryRootComponents.length) return memoryReachInside;
  return memoryReachAncestor;
}

function readPathCandidates(shellWord) {
  const pathCandidates = [shellWord];
  if (shellWord.includes('=')) pathCandidates.push(shellWord.slice(shellWord.indexOf('=') + 1));
  if (attachedShortFlagValuePattern.test(shellWord)) pathCandidates.push(shellWord.slice(2));
  return pathCandidates.filter((pathCandidate) => pathCandidate.length > 0);
}

function expandShellVariables(shellText, variableValuesByName) {
  return shellText.replace(shellVariableReferencePattern, (referenceText, bracedName, bareName) => {
    const variableValue = variableValuesByName.get(bracedName ?? bareName);
    return variableValue ?? referenceText;
  });
}

function expandKnownPathParts(pathCandidate, memoryScope) {
  const homeExpandedCandidate = pathCandidate.replace(leadingHomeTildePattern, memoryScope.homeDirectory);
  return expandShellVariables(homeExpandedCandidate, memoryScope.variableValuesByName);
}

function isUnresolvablePath(expandedPath) {
  return expandedPath.startsWith('~') || expandedPath.includes('$');
}

function namesMemoryPathComponent(expandedCandidate, memoryScope) {
  if (memoryPathMentionPattern.test(expandedCandidate)) return true;
  const memoryBasename = path.basename(memoryScope.memoryRoot);
  return expandedCandidate.split('/').some((pathComponent) => pathComponent === memoryBasename);
}

function readCandidateReach(pathCandidate, memoryScope) {
  const expandedCandidate = expandKnownPathParts(pathCandidate, memoryScope);
  const reachesMemoryWhenUnknown = namesMemoryPathComponent(expandedCandidate, memoryScope) ? memoryReachInside : memoryReachNone;
  if (isUnresolvablePath(expandedCandidate)) return reachesMemoryWhenUnknown;
  if (path.isAbsolute(expandedCandidate)) return readReachOfMemoryRoot(expandedCandidate, memoryScope.memoryRoot, path.sep);
  if (memoryScope.hasUnknownWorkingDirectory && reachesMemoryWhenUnknown === memoryReachInside) return memoryReachInside;
  const reachesFromEachDirectory = memoryScope.possibleWorkingDirectories.map((workingDirectory) =>
    readReachOfMemoryRoot(expandedCandidate, memoryScope.memoryRoot, workingDirectory)
  );
  if (reachesFromEachDirectory.includes(memoryReachInside)) return memoryReachInside;
  if (reachesFromEachDirectory.includes(memoryReachAncestor)) return memoryReachAncestor;
  return memoryReachNone;
}

function reachesMemory(shellWord, memoryScope, countsAncestors) {
  return readPathCandidates(shellWord).some((pathCandidate) => {
    const candidateReach = readCandidateReach(pathCandidate, memoryScope);
    if (candidateReach === memoryReachInside) return true;
    return countsAncestors && candidateReach === memoryReachAncestor;
  });
}

function isPathInsideMemory(shellWord, memoryScope) {
  return readCandidateReach(shellWord, memoryScope) === memoryReachInside;
}

function readFlagValues(argumentWords, flagWords) {
  return argumentWords.flatMap((argumentWord, argumentIndex) => {
    if (flagWords.includes(argumentWord)) return argumentWords.slice(argumentIndex + 1, argumentIndex + 2);
    const attachedFlag = flagWords.find((flagWord) => argumentWord.startsWith(flagWord.startsWith('--') ? `${flagWord}=` : flagWord));
    if (attachedFlag === undefined) return [];
    return [argumentWord.slice(attachedFlag.length).replace(/^=/, '')];
  });
}

function writesMemoryThroughAnyArgument(argumentWords, memoryScope) {
  return argumentWords.some((argumentWord) => reachesMemory(argumentWord, memoryScope, false));
}

function writesMemoryOrAnAncestor(argumentWords, memoryScope) {
  return argumentWords.some((argumentWord) => reachesMemory(argumentWord, memoryScope, true));
}

function readOperandWords(argumentWords) {
  return argumentWords.filter((argumentWord) => !argumentWord.startsWith('-'));
}

function readDestinationWords(argumentWords) {
  const targetDirectories = readFlagValues(argumentWords, targetDirectoryFlags);
  if (targetDirectories.length > 0) return targetDirectories;
  const operandWords = readOperandWords(argumentWords);
  if (operandWords.length < 2) return [];
  return [operandWords[operandWords.length - 1]];
}

function readSourceWords(argumentWords) {
  const targetDirectories = readFlagValues(argumentWords, targetDirectoryFlags);
  const operandWords = readOperandWords(argumentWords);
  if (targetDirectories.length > 0) return operandWords.filter((operandWord) => !targetDirectories.includes(operandWord));
  return operandWords.slice(0, -1);
}

function writesMemoryAtTheDestination(argumentWords, memoryScope) {
  return readDestinationWords(argumentWords).some((destinationWord) => isPathInsideMemory(destinationWord, memoryScope));
}

function writesMemoryThroughCp(argumentWords, memoryScope) {
  if (writesMemoryAtTheDestination(argumentWords, memoryScope)) return true;
  if (!argumentWords.some((argumentWord) => recursiveCopyFlagPattern.test(argumentWord))) return false;
  return writesMemoryOrAnAncestor(readDestinationWords(argumentWords), memoryScope);
}

function writesMemoryThroughMv(argumentWords, memoryScope) {
  if (writesMemoryThroughAnyArgument(argumentWords, memoryScope)) return true;
  return writesMemoryOrAnAncestor(readSourceWords(argumentWords), memoryScope);
}

function writesMemoryThroughRsync(argumentWords, memoryScope) {
  if (writesMemoryThroughAnyArgument(argumentWords, memoryScope)) return true;
  if (writesMemoryOrAnAncestor(readDestinationWords(argumentWords), memoryScope)) return true;
  if (!argumentWords.some((argumentWord) => rsyncDeletingFlagPattern.test(argumentWord))) return false;
  return writesMemoryOrAnAncestor(readOperandWords(argumentWords), memoryScope);
}

function writesMemoryThroughUnzip(argumentWords, memoryScope) {
  if (writesMemoryThroughAnyArgument(argumentWords, memoryScope)) return true;
  if (argumentWords.some((argumentWord) => unzipReadOnlyFlags.has(argumentWord))) return false;
  const extractionDirectories = readFlagValues(argumentWords, unzipDirectoryFlags);
  const destinationWords = extractionDirectories.length > 0 ? extractionDirectories : [workingDirectoryOperand];
  return writesMemoryOrAnAncestor(destinationWords, memoryScope);
}

function writesMemoryThroughCompressor(argumentWords, memoryScope) {
  if (argumentWords.some((argumentWord) => standardOutputFlagPattern.test(argumentWord))) return false;
  return writesMemoryThroughAnyArgument(argumentWords, memoryScope);
}

function writesMemoryThroughAwk(argumentWords, memoryScope) {
  if (!argumentWords.some((argumentWord) => argumentWord.endsWith('inplace'))) return false;
  return writesMemoryThroughAnyArgument(argumentWords, memoryScope);
}

function writesMemoryThroughZip(argumentWords, memoryScope) {
  if (!argumentWords.some((argumentWord) => zipMoveFlagPattern.test(argumentWord))) return false;
  return writesMemoryThroughAnyArgument(argumentWords, memoryScope);
}

function createOutputFlagWriter(outputFlags) {
  return (argumentWords, memoryScope) =>
    readFlagValues(argumentWords, outputFlags).some((outputPath) => isPathInsideMemory(outputPath, memoryScope));
}

function writesMemoryThroughDd(argumentWords, memoryScope) {
  return argumentWords
    .filter((argumentWord) => argumentWord.startsWith(ddOutputFilePrefix))
    .some((argumentWord) => isPathInsideMemory(argumentWord.slice(ddOutputFilePrefix.length), memoryScope));
}

function writesMemoryInPlace(argumentWords, memoryScope) {
  if (!argumentWords.some((argumentWord) => inPlaceFlagPattern.test(argumentWord))) return false;
  return writesMemoryThroughAnyArgument(argumentWords, memoryScope);
}

function readTarModeLetters(argumentWords) {
  const oldStyleModeWord = argumentWords.length > 0 && !argumentWords[0].startsWith('-') ? argumentWords[0] : '';
  const shortFlagBundles = argumentWords.filter((argumentWord) => /^-[A-Za-z]+$/.test(argumentWord));
  return [oldStyleModeWord, ...shortFlagBundles].join('');
}

function readTarArchiveFiles(argumentWords) {
  const longFlagFiles = readFlagValues(argumentWords, [tarArchiveFileLongFlag]);
  const bundledFiles = argumentWords.flatMap((argumentWord, argumentIndex) => {
    const isFlagBundle = argumentWord.startsWith('-') && !argumentWord.startsWith('--');
    const isOldStyleModeWord = argumentIndex === 0 && !argumentWord.startsWith('-');
    if (!(isFlagBundle || isOldStyleModeWord) || !tarArchiveFileBundlePattern.test(argumentWord)) return [];
    return argumentWords.slice(argumentIndex + 1, argumentIndex + 2);
  });
  return [...longFlagFiles, ...bundledFiles];
}

function writesMemoryThroughTar(argumentWords, memoryScope) {
  const extractionDirectories = readFlagValues(argumentWords, tarDirectoryFlags);
  if (extractionDirectories.some((extractionDirectory) => isPathInsideMemory(extractionDirectory, memoryScope))) return true;
  const modeLetters = readTarModeLetters(argumentWords);
  const extracts = modeLetters.includes('x') || argumentWords.some((argumentWord) => tarExtractLongFlags.has(argumentWord));
  if (extracts && writesMemoryThroughAnyArgument(argumentWords, memoryScope)) return true;
  const extractionDestinations = extractionDirectories.length > 0 ? extractionDirectories : [workingDirectoryOperand];
  if (extracts && writesMemoryOrAnAncestor(extractionDestinations, memoryScope)) return true;
  const createsAnArchive = tarCreateModeLetters.some((modeLetter) => modeLetters.includes(modeLetter))
    || argumentWords.some((argumentWord) => tarCreateLongFlags.has(argumentWord));
  if (!createsAnArchive) return false;
  return readTarArchiveFiles(argumentWords).some((archiveFile) => isPathInsideMemory(archiveFile, memoryScope));
}

function findGitSubcommandIndex(argumentWords) {
  let argumentIndex = 0;
  while (argumentIndex < argumentWords.length && argumentWords[argumentIndex].startsWith('-')) {
    argumentIndex += gitValuedGlobalFlags.has(argumentWords[argumentIndex]) ? 2 : 1;
  }
  return argumentIndex;
}

function writesMemoryThroughGit(argumentWords, memoryScope) {
  const subcommandIndex = findGitSubcommandIndex(argumentWords);
  const subcommandName = argumentWords[subcommandIndex];
  if (!gitMemoryWritingSubcommands.has(subcommandName)) return false;
  const subcommandArguments = argumentWords.slice(subcommandIndex + 1);
  const cleansIgnoredFiles = subcommandName === 'clean' && subcommandArguments.some((argumentWord) => gitCleanIgnoredFilesFlagPattern.test(argumentWord));
  if (cleansIgnoredFiles) return true;
  const stashesIgnoredFiles = subcommandName === 'stash' && subcommandArguments.some((argumentWord) => gitStashIgnoredFilesFlagPattern.test(argumentWord));
  if (stashesIgnoredFiles) return true;
  return writesMemoryThroughAnyArgument(subcommandArguments, memoryScope);
}

function readFindRoots(argumentWords) {
  const firstExpressionIndex = argumentWords.findIndex((argumentWord) => argumentWord.startsWith('-') || argumentWord === '(' || argumentWord === '!');
  const findRoots = firstExpressionIndex === -1 ? argumentWords : argumentWords.slice(0, firstExpressionIndex);
  if (findRoots.length === 0) return [workingDirectoryOperand];
  return findRoots;
}

function readFindExecCommands(argumentWords) {
  return argumentWords.flatMap((argumentWord, argumentIndex) => {
    if (!findExecActions.has(argumentWord)) return [];
    const remainingWords = argumentWords.slice(argumentIndex + 1);
    const terminatorIndex = remainingWords.findIndex((remainingWord) => findExecTerminators.has(remainingWord));
    return [terminatorIndex === -1 ? remainingWords : remainingWords.slice(0, terminatorIndex)];
  });
}

function representAPathFoundUnder(findRoot) {
  return path.join(findRoot, memoryDirectoryBasename);
}

function writesMemoryThroughFind(argumentWords, memoryScope) {
  if (!argumentWords.some((argumentWord) => findWritingActions.has(argumentWord))) return false;
  const findRoots = readFindRoots(argumentWords);
  const execCommands = readFindExecCommands(argumentWords);
  const deletesOrPrintsUnderMemory = argumentWords.some((argumentWord) => findWritingActions.has(argumentWord) && !findExecActions.has(argumentWord));
  if (deletesOrPrintsUnderMemory && (writesMemoryOrAnAncestor(findRoots, memoryScope) || writesMemoryThroughAnyArgument(argumentWords, memoryScope))) return true;
  return execCommands.some((execWords) => {
    const execWordsOverEachRoot = findRoots.flatMap((findRoot) =>
      execWords.map((execWord) => (execWord === findFoundPathPlaceholder ? representAPathFoundUnder(findRoot) : execWord))
    );
    return findMemoryWriterInCommandWords(execWordsOverEachRoot, memoryScope, []) !== null;
  });
}

const memoryWriterDecidersByBasename = new Map([
  ...[...anyArgumentMemoryWriterBasenames].map((basename) => [basename, writesMemoryThroughAnyArgument]),
  ...[...ancestorReachingMemoryWriterBasenames].map((basename) => [basename, writesMemoryOrAnAncestor]),
  ...[...destinationMemoryWriterBasenames].map((basename) => [basename, writesMemoryAtTheDestination]),
  ...[...inPlaceEditorBasenames].map((basename) => [basename, writesMemoryInPlace]),
  ...[...inPlaceCompressorBasenames].map((basename) => [basename, writesMemoryThroughCompressor]),
  ...[...inPlaceAwkBasenames].map((basename) => [basename, writesMemoryThroughAwk]),
  ...[...outputFlagsByWriterBasename].map(([basename, outputFlags]) => [basename, createOutputFlagWriter(outputFlags)]),
  ['cp', writesMemoryThroughCp],
  ['mv', writesMemoryThroughMv],
  ['rsync', writesMemoryThroughRsync],
  ['unzip', writesMemoryThroughUnzip],
  ['zip', writesMemoryThroughZip],
  ['dd', writesMemoryThroughDd],
  ['tar', writesMemoryThroughTar],
  ['git', writesMemoryThroughGit],
  ['find', writesMemoryThroughFind]
]);

function dropLeadingReservedWords(shellWords) {
  const firstCommandWordIndex = shellWords.findIndex((shellWord) => !shellReservedWords.has(shellWord));
  if (firstCommandWordIndex === -1) return [];
  return shellWords.slice(firstCommandWordIndex);
}

function findCommandIndexAfterPrefix(commandWords, prefixIndex) {
  const prefixBasename = readCommandBasename(commandWords[prefixIndex]);
  const valueFlags = commandPrefixValueFlagsByBasename.get(prefixBasename);
  let remainingPositionalWords = positionalWordsBeforeTheCommandByPrefix.get(prefixBasename) ?? 0;
  let wordIndex = prefixIndex + 1;
  while (wordIndex < commandWords.length) {
    const commandWord = commandWords[wordIndex];
    if (valueFlags.has(commandWord)) {
      wordIndex += 2;
      continue;
    }
    if (commandWord.startsWith('-') || leadingAssignmentWordPattern.test(commandWord)) {
      wordIndex += 1;
      continue;
    }
    if (remainingPositionalWords === 0) return wordIndex;
    remainingPositionalWords -= 1;
    wordIndex += 1;
  }
  return wordIndex;
}

function findIndexesRunUnderCommandPrefixes(commandWords) {
  const innerCommandIndexes = [];
  let commandIndex = findFirstCommandNameIndex(commandWords);
  while (commandIndex < commandWords.length && commandPrefixValueFlagsByBasename.has(readCommandBasename(commandWords[commandIndex]))) {
    commandIndex = findCommandIndexAfterPrefix(commandWords, commandIndex);
    innerCommandIndexes.push(commandIndex);
  }
  return innerCommandIndexes;
}

function findIndexesACommandCouldRun(commandWords) {
  return [...new Set([...findIndexesAProgramCouldRun(commandWords), ...findIndexesRunUnderCommandPrefixes(commandWords)])];
}

function findMemoryWriterInCommandWords(commandWords, memoryScope, wordsOfTheWholeCommandLine) {
  const runsUnderXargs = commandWords.some((commandWord) => readCommandBasename(commandWord) === 'xargs');
  const writerIndex = findIndexesACommandCouldRun(commandWords).find((runIndex) => {
    const decideMemoryWrite = memoryWriterDecidersByBasename.get(readCommandBasename(commandWords[runIndex] || ''));
    if (decideMemoryWrite === undefined) return false;
    const ownArguments = commandWords.slice(runIndex + 1);
    const argumentWords = runsUnderXargs ? [...ownArguments, ...wordsOfTheWholeCommandLine] : ownArguments;
    return decideMemoryWrite(argumentWords, memoryScope);
  });
  if (writerIndex === undefined) return null;
  return readCommandBasename(commandWords[writerIndex]);
}

function readRunBasenamesWithArguments(commandWords) {
  return findIndexesACommandCouldRun(commandWords)
    .filter((runIndex) => commandWords[runIndex] !== undefined)
    .map((runIndex) => ({ basename: readCommandBasename(commandWords[runIndex]), argumentWords: commandWords.slice(runIndex + 1) }));
}

function readShellStringArguments(argumentWords) {
  return argumentWords.flatMap((argumentWord, argumentIndex) =>
    shellStringFlagPattern.test(argumentWord) ? argumentWords.slice(argumentIndex + 1, argumentIndex + 2) : []
  );
}

function evaluatesUnreadableCode({ basename, argumentWords }) {
  if (shellEvaluatingBasenames.has(basename)) return true;
  if (!inlineCodeInterpreterBasenames.has(basename)) return false;
  if (argumentWords.some((argumentWord) => inlineCodeFlagPattern.test(argumentWord))) return true;
  const operandWords = argumentWords.filter((argumentWord) => !argumentWord.startsWith('-') || argumentWord === standardInputOperand);
  return operandWords.length === 0 || operandWords[0] === standardInputOperand;
}

function mentionsMemory(commandText, memoryScope) {
  if (memoryPathMentionPattern.test(commandText)) return true;
  return commandText.includes(memoryScope.memoryRoot);
}

function denyBashMemoryWrite(toolName, writeDescription) {
  return denyWithReason(`Write policy denies ${toolName}: ${writeDescription} writes under memory/ out of the guard's sight; ${useWriteOrEditForMemory}.`);
}

function decideShellStringsLeaveMemoryAlone(toolName, runBasenamesWithArguments, memoryScope) {
  const shellStrings = runBasenamesWithArguments
    .filter(({ basename }) => shellStringRunnerBasenames.has(basename))
    .flatMap(({ argumentWords }) => readShellStringArguments(argumentWords));
  const memoryWritingShellString = shellStrings.find((shellString) => !decideBashLeavesMemoryAlone(toolName, shellString, memoryScope).allow);
  if (memoryWritingShellString === undefined) return { allow: true };
  return decideBashLeavesMemoryAlone(toolName, memoryWritingShellString, memoryScope);
}

function readAssignedVariableValues(shellWords, enclosingValuesByName) {
  const variableValuesByName = new Map(enclosingValuesByName);
  shellWords
    .filter((shellWord) => leadingAssignmentWordPattern.test(shellWord))
    .forEach((assignmentWord) => {
      const separatorIndex = assignmentWord.indexOf('=');
      const assignedValue = expandShellVariables(assignmentWord.slice(separatorIndex + 1), variableValuesByName);
      variableValuesByName.set(assignmentWord.slice(0, separatorIndex), assignedValue);
    });
  return variableValuesByName;
}

function readCommandLineScope(enclosingScope, wordsOfTheWholeCommandLine) {
  return {
    ...enclosingScope,
    variableValuesByName: readAssignedVariableValues(wordsOfTheWholeCommandLine, enclosingScope.variableValuesByName)
  };
}

function readDirectoriesEntered({ basename, argumentWords }) {
  if (directoryChangingBasenames.has(basename)) return readOperandWords(argumentWords);
  if (basename === 'env') return readFlagValues(argumentWords, envDirectoryFlags);
  return [];
}

function readDirectoryChangeTargets({ basename, argumentWords }) {
  const enteredDirectories = readDirectoriesEntered({ basename, argumentWords });
  const returnsToAStackedDirectory = basename === 'popd' || (basename === 'pushd' && enteredDirectories.length === 0);
  if (returnsToAStackedDirectory || (basename === 'cd' && argumentWords.includes(standardInputOperand))) return [unknownDirectoryTarget];
  if (basename === 'cd' && enteredDirectories.length === 0) return [homeDirectoryTarget];
  return enteredDirectories;
}

function enterDirectories(memoryScope, runBasenamesWithArguments) {
  const directoryTargets = runBasenamesWithArguments.flatMap(readDirectoryChangeTargets);
  if (directoryTargets.length === 0) return memoryScope;
  const expandedTargets = directoryTargets.map((directoryTarget) => expandKnownPathParts(directoryTarget, memoryScope));
  const resolvableTargets = expandedTargets.filter((expandedTarget) => !isUnresolvablePath(expandedTarget));
  const enteredWorkingDirectories = resolvableTargets.flatMap((resolvableTarget) =>
    memoryScope.possibleWorkingDirectories.map((workingDirectory) => path.resolve(workingDirectory, resolvableTarget))
  );
  const possibleWorkingDirectories = [...new Set([...memoryScope.possibleWorkingDirectories, ...enteredWorkingDirectories])];
  const exceedsTrackedDirectoryLimit = possibleWorkingDirectories.length > maxTrackedWorkingDirectories;
  const variableValuesByName = new Map(memoryScope.variableValuesByName);
  variableValuesByName.delete(workingDirectoryVariableName);
  return {
    ...memoryScope,
    variableValuesByName,
    possibleWorkingDirectories: possibleWorkingDirectories.slice(0, maxTrackedWorkingDirectories),
    hasUnknownWorkingDirectory: memoryScope.hasUnknownWorkingDirectory || exceedsTrackedDirectoryLimit || resolvableTargets.length < expandedTargets.length
  };
}

function denyEnteringMemory(toolName) {
  return denyWithReason(`Write policy denies ${toolName}: changing into memory/ lets later commands write there out of the guard's sight; ${useWriteOrEditForMemory}.`);
}

function readScopedSimpleCommands(simpleCommands, commandLineScope) {
  let memoryScope = commandLineScope;
  return simpleCommands.map((simpleCommand) => {
    const commandWords = dropLeadingReservedWords(simpleCommand.words);
    const runBasenamesWithArguments = readRunBasenamesWithArguments(commandWords);
    memoryScope = enterDirectories(memoryScope, runBasenamesWithArguments);
    return { simpleCommand, commandWords, runBasenamesWithArguments, memoryScope };
  });
}

function decideBashLeavesMemoryAlone(toolName, rawCommandText, enclosingScope) {
  const commandText = rawCommandText.replace(knownShellCommandSubstitutionPattern, '$PWD');
  const parsedCommandLine = splitSimpleShellCommands(commandText);
  if (parsedCommandLine === null) {
    if (!mentionsMemory(commandText, enclosingScope)) return { allow: true };
    return denyBashMemoryWrite(toolName, 'a command whose quoting does not close');
  }
  const { simpleCommands, hasSubstitution } = parsedCommandLine;
  const wordsOfTheWholeCommandLine = simpleCommands.flatMap((simpleCommand) => simpleCommand.words);
  const commandLineScope = readCommandLineScope(enclosingScope, wordsOfTheWholeCommandLine);
  const scopedSimpleCommands = readScopedSimpleCommands(simpleCommands, commandLineScope);
  const [redirectedMemoryTarget] = scopedSimpleCommands
    .flatMap(({ simpleCommand, memoryScope }) => simpleCommand.outputRedirectionTargets.filter((redirectionTarget) => reachesMemory(redirectionTarget, memoryScope, false)));
  if (redirectedMemoryTarget !== undefined) return denyBashMemoryWrite(toolName, `a redirection to ${redirectedMemoryTarget}`);
  const memoryWriterBasename = scopedSimpleCommands
    .map(({ commandWords, memoryScope }) => findMemoryWriterInCommandWords(commandWords, memoryScope, wordsOfTheWholeCommandLine))
    .find((writerBasename) => writerBasename !== null);
  if (memoryWriterBasename !== undefined) return denyBashMemoryWrite(toolName, memoryWriterBasename);
  const entersMemory = scopedSimpleCommands.some(({ runBasenamesWithArguments, memoryScope }) =>
    runBasenamesWithArguments.some((runBasenameWithArguments) => writesMemoryThroughAnyArgument(readDirectoriesEntered(runBasenameWithArguments), memoryScope))
  );
  if (entersMemory) return denyEnteringMemory(toolName);
  const shellStringDecision = scopedSimpleCommands
    .map(({ runBasenamesWithArguments, memoryScope }) => decideShellStringsLeaveMemoryAlone(toolName, runBasenamesWithArguments, memoryScope))
    .find((decision) => !decision.allow);
  if (shellStringDecision !== undefined) return shellStringDecision;
  const isUnreadable = hasSubstitution || scopedSimpleCommands.some(({ runBasenamesWithArguments }) => runBasenamesWithArguments.some(evaluatesUnreadableCode));
  if (!isUnreadable || !mentionsMemory(commandText, commandLineScope)) return { allow: true };
  return denyBashMemoryWrite(toolName, 'a command the guard cannot read before it runs');
}

function readMemoryScope(context) {
  const { memoryDirectory, repositoryRoot, homeDirectory, workingDirectory } = context;
  if (typeof memoryDirectory !== 'string' || typeof repositoryRoot !== 'string') return null;
  const resolvedHomeDirectory = typeof homeDirectory === 'string' ? homeDirectory : os.homedir();
  const toolWorkingDirectory = typeof workingDirectory === 'string' && path.isAbsolute(workingDirectory) ? workingDirectory : repositoryRoot;
  return {
    memoryRoot: path.resolve(memoryDirectory),
    repositoryRoot,
    homeDirectory: resolvedHomeDirectory,
    possibleWorkingDirectories: [path.resolve(toolWorkingDirectory)],
    hasUnknownWorkingDirectory: false,
    variableValuesByName: new Map([['HOME', resolvedHomeDirectory], [workingDirectoryVariableName, toolWorkingDirectory]])
  };
}

function decideBashMemoryWrite(toolName, commandText, context) {
  const memoryScope = readMemoryScope(context);
  if (memoryScope !== null) return decideBashLeavesMemoryAlone(toolName, commandText, memoryScope);
  if (!memoryPathMentionPattern.test(commandText)) return { allow: true };
  return denyWithReason(`Write policy denies ${toolName}: the guard could not check this command against the memory directory; ${useWriteOrEditForMemory}.`);
}

function decideBashCommand(toolName, toolInput, context) {
  const commandText = asFieldMap(toolInput)[bashCommandFieldName];
  if (typeof commandText !== 'string' || commandText.length === 0) return { allow: true };
  const shellWordEntries = splitShellWordEntries(commandText);
  const guardedScriptDecision = decideGuardedScriptName(toolName, commandText, shellWordEntries);
  if (!guardedScriptDecision.allow) return guardedScriptDecision;
  const bufferKeyDecision = decideCommandAvoidsBufferKey(toolName, commandText);
  if (!bufferKeyDecision.allow) return bufferKeyDecision;
  const commandNamesGog = doesCommandNameGog(commandText);
  const commandNameDecision = decideCommandNameIsNotExpanded(toolName, commandText, shellWordEntries, commandNamesGog);
  if (!commandNameDecision.allow) return commandNameDecision;
  const quotedNameDecision = decideCommandNameIsNotQuoted(toolName, shellWordEntries, commandNamesGog);
  if (!quotedNameDecision.allow) return quotedNameDecision;
  const memoryWriteDecision = decideBashMemoryWrite(toolName, commandText, context);
  if (!memoryWriteDecision.allow) return memoryWriteDecision;
  if (!commandNamesGog) return { allow: true };
  return decideCommandNamingGog(toolName, commandText, shellWordEntries, context);
}

const writeToolName = 'Write';
const editToolName = 'Edit';
const multiEditToolName = 'MultiEdit';
const fileWriteToolNames = new Set([writeToolName, editToolName, multiEditToolName]);

function countOccurrences(text, searchText) {
  let occurrenceCount = 0;
  for (let matchIndex = text.indexOf(searchText); matchIndex !== -1; matchIndex = text.indexOf(searchText, matchIndex + searchText.length)) {
    occurrenceCount += 1;
  }
  return occurrenceCount;
}

function applyStringEdit(currentText, edit) {
  const { old_string: oldString, new_string: newString, replace_all: shouldReplaceAll } = asFieldMap(edit);
  if (typeof oldString !== 'string' || typeof newString !== 'string') return null;
  if (oldString === '') return currentText === null || currentText === '' ? newString : null;
  if (currentText === null) return null;
  const occurrenceCount = countOccurrences(currentText, oldString);
  if (occurrenceCount === 0) return null;
  if (shouldReplaceAll === true) return currentText.split(oldString).join(newString);
  if (occurrenceCount > 1) return null;
  const matchIndex = currentText.indexOf(oldString);
  return `${currentText.slice(0, matchIndex)}${newString}${currentText.slice(matchIndex + oldString.length)}`;
}

function applyStringEdits(currentText, edits) {
  if (!Array.isArray(edits) || edits.length === 0) return null;
  let editedText = currentText;
  for (const edit of edits) {
    editedText = applyStringEdit(editedText, edit);
    if (editedText === null) return null;
  }
  return editedText;
}

function proposeFileText(toolName, fields, currentText) {
  if (toolName === writeToolName) return typeof fields.content === 'string' ? fields.content : null;
  if (toolName === editToolName) return applyStringEdit(currentText, fields);
  return applyStringEdits(currentText, fields.edits);
}

function denyMemoryViolations(toolName, violations) {
  return denyWithReason(`Write policy denies ${toolName}: ${violations.map(formatViolation).join('; ')}.`);
}

function decideResolvedMemoryFileWrite(toolName, fields, memoryWriteInspector, absoluteFilePath) {
  const memoryTarget = memoryWriteInspector.resolveTarget(absoluteFilePath);
  if (!memoryTarget.isMemoryPath) return { allow: true };
  const memoryFilePath = `memory/${memoryTarget.relativePath}`;
  if (memoryTarget.resolvesOutsideMemory) {
    return denyWithReason(`Write policy denies ${toolName}: ${memoryFilePath} resolves outside the memory directory through a symlink.`);
  }
  const { violations: targetViolations, currentText } = memoryWriteInspector.inspectTarget(memoryTarget.relativePath);
  if (targetViolations.length > 0) return denyMemoryViolations(toolName, targetViolations);
  const proposedText = proposeFileText(toolName, fields, currentText);
  if (proposedText === null) {
    return denyWithReason(
      `Write policy denies ${toolName}: the guard cannot tell what ${memoryFilePath} would hold, because an edit does not match the file exactly once; read the file and retry with an exact match.`
    );
  }
  const violations = memoryWriteInspector.findViolations({ relativePath: memoryTarget.relativePath, currentText, proposedText });
  if (violations.length === 0) return { allow: true };
  return denyMemoryViolations(toolName, violations);
}

function hasMemoryWriteInspector(memoryWriteInspector) {
  if (memoryWriteInspector === null || typeof memoryWriteInspector !== 'object') return false;
  return ['resolveTarget', 'inspectTarget', 'findViolations'].every((methodName) => typeof memoryWriteInspector[methodName] === 'function');
}

function denyUncheckableFileWrite(toolName, filePath) {
  return denyWithReason(`Write policy denies ${toolName}: the guard could not check ${filePath} against the memory rules.`);
}

function decideFileWrite(toolName, toolInput, context) {
  const fields = asFieldMap(toolInput);
  const filePath = fields.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) return { allow: true };
  if (filePath.toLowerCase().includes(bufferDraftLedgerMarker)) return denyBufferDraftLedgerWrite(toolName);
  const { memoryDirectory, repositoryRoot, memoryWriteInspector } = context;
  if (typeof memoryDirectory !== 'string' || typeof repositoryRoot !== 'string') return denyUncheckableFileWrite(toolName, filePath);
  const absoluteFilePath = path.resolve(repositoryRoot, filePath);
  const isLexicalMemoryPath = isLexicallyInsideMemory(memoryDirectory, absoluteFilePath);
  if (!hasMemoryWriteInspector(memoryWriteInspector)) {
    if (!isLexicalMemoryPath) return { allow: true };
    return denyUncheckableFileWrite(toolName, filePath);
  }
  try {
    return decideResolvedMemoryFileWrite(toolName, fields, memoryWriteInspector, absoluteFilePath);
  } catch {
    if (!isLexicalMemoryPath) return { allow: true };
    return denyUncheckableFileWrite(toolName, filePath);
  }
}

const decidersByConnector = {
  gog_personal_1: decideGogTool,
  gog_personal_2: decideGogTool,
  gog_personal_3: decideGogTool,
  claude_ai_Gmail: decideGmail,
  claude_ai_Google_Calendar: decideCalendar,
  claude_ai_Slack: decideSlackTool,
  claude_ai_Notion: decideNotionTool,
  buffer: decideBufferTool,
  plugin_telegram_telegram: decideTelegramChannel,
  browser: decideBrowser
};

export function decideToolPermission(toolName, toolInput, context = {}) {
  if (typeof toolName !== 'string' || toolName.length === 0) return denyWithReason(unreadablePayloadReason);
  if (toolName === bashToolName) return decideBashCommand(toolName, toolInput, context);
  if (fileWriteToolNames.has(toolName)) return decideFileWrite(toolName, toolInput, context);
  if (!toolName.startsWith(mcpToolPrefix)) return { allow: true };
  const { serverName, actionName } = splitToolName(toolName);
  const decide = decidersByConnector[serverName];
  if (!decide) return deny(toolName);
  return decide(actionName, toolName, toolInput, context);
}
