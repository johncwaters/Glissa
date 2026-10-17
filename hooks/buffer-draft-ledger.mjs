import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getContentFilePath, getScheduledAt, hasChatShorthand } from '../scripts/content.mjs';
import { readJsonFileSync, withJsonFileLock, writeJsonFileAtomically } from '../scripts/json-file.mjs';
import { isPlainObject } from '../scripts/object-fields.mjs';

export const bufferDraftLedgerMarker = 'buffer-drafts';
const bufferDraftLedgerEnvironmentVariable = 'GLISSA_BUFFER_DRAFT_LEDGER';
const bufferPostIdPattern = /^[a-f\d]{24}$/;
const bufferDraftStatus = 'draft';

export function resolveBufferDraftLedgerPath(environment = process.env) {
  if (environment[bufferDraftLedgerEnvironmentVariable]) return environment[bufferDraftLedgerEnvironmentVariable];
  const stateDirectory = environment.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(stateDirectory, 'glissa', `${bufferDraftLedgerMarker}.json`);
}

function readRecordedDrafts(environment) {
  try {
    const recordedDrafts = readJsonFileSync(resolveBufferDraftLedgerPath(environment));
    return isPlainObject(recordedDrafts) ? recordedDrafts : {};
  } catch {
    return {};
  }
}

export function readRecordedBufferDraft(postId, environment = process.env) {
  const recordedDrafts = readRecordedDrafts(environment);
  const recordedDraft = Object.hasOwn(recordedDrafts, postId) ? recordedDrafts[postId] : null;
  if (!isPlainObject(recordedDraft) || typeof recordedDraft.updatedAt !== 'string') return null;
  return { updatedAt: recordedDraft.updatedAt };
}

export function listRecordedBufferDraftsAtSlot(channelId, dueAtMs, environment = process.env) {
  return Object.entries(readRecordedDrafts(environment))
    .filter(([, recordedDraft]) => isPlainObject(recordedDraft) && recordedDraft.channelId === channelId && Date.parse(recordedDraft.dueAt) === dueAtMs)
    .map(([postId]) => postId);
}

function toPlannedBufferPosts(post, timeZone) {
  try {
    const scheduledAtMs = Date.parse(getScheduledAt(post, timeZone));
    if ([post.copy, post.threadFollowUps].some(hasChatShorthand)) return [{ scheduledAtMs, copy: null, fallback: null, threadFollowUps: null, bufferPostId: post.bufferPostId }];
    return [{ scheduledAtMs, copy: post.copy, fallback: hasChatShorthand(post.fallback) ? null : post.fallback, threadFollowUps: post.threadFollowUps, bufferPostId: post.bufferPostId }];
  } catch {
    return [];
  }
}

export function readPlannedBufferPosts(environment = process.env) {
  try {
    const contentPlan = readJsonFileSync(getContentFilePath(environment));
    if (!Array.isArray(contentPlan?.posts)) return null;
    return contentPlan.posts.flatMap((post) => toPlannedBufferPosts(post, contentPlan.timeZone));
  } catch {
    return null;
  }
}

async function updateRecordedDrafts(environment, readUpdatedDrafts) {
  const ledgerPath = resolveBufferDraftLedgerPath(environment);
  await mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  await withJsonFileLock(ledgerPath, async () => {
    const updatedDrafts = readUpdatedDrafts(readRecordedDrafts(environment));
    if (updatedDrafts !== null) await writeJsonFileAtomically(ledgerPath, updatedDrafts);
  });
}

export async function recordBufferDraft({ id, updatedAt, dueAt = null, channelId = null }, environment = process.env) {
  await updateRecordedDrafts(environment, (recordedDrafts) => ({ ...recordedDrafts, [id]: { updatedAt, dueAt, channelId } }));
}

export async function markUntouchedBufferDraftEdit(postId, toolUseId, environment = process.env) {
  await updateRecordedDrafts(environment, (recordedDrafts) => {
    const recordedDraft = Object.hasOwn(recordedDrafts, postId) ? recordedDrafts[postId] : null;
    if (!isPlainObject(recordedDraft)) return null;
    return { ...recordedDrafts, [postId]: { ...recordedDraft, pendingEditToolUseId: toolUseId } };
  });
}

export function isPendingUntouchedBufferDraftEdit(postId, toolUseId, environment = process.env) {
  if (typeof toolUseId !== 'string' || toolUseId.length === 0) return false;
  const recordedDrafts = readRecordedDrafts(environment);
  const recordedDraft = Object.hasOwn(recordedDrafts, postId) ? recordedDrafts[postId] : null;
  return isPlainObject(recordedDraft) && recordedDraft.pendingEditToolUseId === toolUseId;
}

function collectResponseTexts(toolResponse) {
  if (typeof toolResponse === 'string') return [toolResponse];
  if (Array.isArray(toolResponse)) return toolResponse.flatMap(collectResponseTexts);
  if (!isPlainObject(toolResponse)) return [];
  if (typeof toolResponse.text === 'string') return [toolResponse.text];
  if (Object.hasOwn(toolResponse, 'content')) return collectResponseTexts(toolResponse.content);
  return [JSON.stringify(toolResponse)];
}

function parseLeadingJsonObject(responseText) {
  const trimmedText = responseText.trim();
  for (let closingIndex = trimmedText.indexOf('}'); closingIndex !== -1; closingIndex = trimmedText.indexOf('}', closingIndex + 1)) {
    try {
      return JSON.parse(trimmedText.slice(0, closingIndex + 1));
    } catch {}
  }
  return null;
}

function readOptionalText(value) {
  return typeof value === 'string' ? value : null;
}

export function readSavedBufferDraft(toolResponse) {
  for (const responseText of collectResponseTexts(toolResponse)) {
    const parsedResponse = parseLeadingJsonObject(responseText);
    const savedPost = isPlainObject(parsedResponse?.post) ? parsedResponse.post : parsedResponse;
    if (!isPlainObject(savedPost) || typeof savedPost.id !== 'string' || !bufferPostIdPattern.test(savedPost.id)) continue;
    if (savedPost.status !== bufferDraftStatus || typeof savedPost.updatedAt !== 'string') return null;
    return { id: savedPost.id, updatedAt: savedPost.updatedAt, dueAt: readOptionalText(savedPost.dueAt), channelId: readOptionalText(savedPost.channelId) };
  }
  return null;
}
