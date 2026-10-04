import { readHookPayload } from './hook-payload.mjs';
import { logEvent } from '../scripts/log.mjs';

const maximumErrorKindLength = 40;

function toSnakeCase(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
}

function addPresentField(fields, payload, fieldName) {
  if (Object.hasOwn(payload, fieldName)) fields[fieldName] = payload[fieldName];
}

function getPostToolUseFields(payload) {
  const fields = {};
  addPresentField(fields, payload, 'tool_name');
  addPresentField(fields, payload, 'tool_use_id');
  const toolResponse = payload.tool_response;
  fields.is_error = Boolean(toolResponse && typeof toolResponse === 'object' && (toolResponse.isError === true || toolResponse.is_error === true));
  return fields;
}

function getErrorKind(errorText) {
  const [firstLine] = errorText.split('\n');
  const errorKindMatch = /^([A-Za-z_ ]+):/.exec(firstLine);
  if (!errorKindMatch) return '';
  return errorKindMatch[1].trim().slice(0, maximumErrorKindLength);
}

function getPostToolUseFailureFields(payload) {
  const fields = {};
  addPresentField(fields, payload, 'tool_name');
  addPresentField(fields, payload, 'tool_use_id');
  if (!Object.hasOwn(payload, 'error')) return fields;
  const errorText = String(payload.error);
  fields.error_length = errorText.length;
  const errorKind = getErrorKind(errorText);
  if (errorKind.length > 0) fields.error_kind = errorKind;
  return fields;
}

function getSessionStartFields(payload) {
  const fields = {};
  for (const fieldName of ['source', 'model', 'transcript_path', 'cwd']) addPresentField(fields, payload, fieldName);
  return fields;
}

function getSessionEndFields(payload) {
  const fields = {};
  addPresentField(fields, payload, 'reason');
  return fields;
}

function getNotificationFields(payload) {
  const fields = {};
  addPresentField(fields, payload, 'notification_type');
  return fields;
}

const fieldExtractorsByHookEventName = {
  PostToolUse: getPostToolUseFields,
  PostToolUseFailure: getPostToolUseFailureFields,
  SessionStart: getSessionStartFields,
  SessionEnd: getSessionEndFields,
  Notification: getNotificationFields
};

function getEventFields(payload, hookEventName) {
  const fields = {};
  addPresentField(fields, payload, 'session_id');
  addPresentField(fields, payload, 'agent_type');
  if (!Object.hasOwn(fieldExtractorsByHookEventName, hookEventName)) return fields;
  return { ...fields, ...fieldExtractorsByHookEventName[hookEventName](payload) };
}

async function run() {
  try {
    const payload = await readHookPayload();
    const hookEventName = payload.hook_event_name;
    logEvent('hook', toSnakeCase(hookEventName), getEventFields(payload, hookEventName));
  } catch {
    logEvent('hook', 'unreadable_payload');
  }
}

await run();
