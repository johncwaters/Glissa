import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listRecordedBufferDraftsAtSlot, readRecordedBufferDraft, readSavedBufferDraft, recordBufferDraft } from './buffer-draft-ledger.mjs';
import { readPostState } from './buffer-post-state.mjs';

const savedPostId = '6ac801bc74384ca756daac34';
const savedPostText = `{"id":"${savedPostId}","status":"draft","text":"A setup guide {braces}","updatedAt":"2026-10-08T20:49:00.045Z","channelId":"6ac4d52b6a5c39ccb62e6cc6","dueAt":"2026-10-12T23:30:00.000Z","author":{"id":"6ac3f455c07392068ad7bd06"}}{"rateLimit":[{"remaining":99}]}`;

function createLedgerEnvironment() {
  const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-drafts-'));
  return { GLISSA_BUFFER_DRAFT_LEDGER: path.join(scratchDirectory, 'nested', 'drafts.json') };
}

test('reads the saved draft from a Buffer MCP response in every content shape', () => {
  const expectedDraft = { id: savedPostId, updatedAt: '2026-10-08T20:49:00.045Z', dueAt: '2026-10-12T23:30:00.000Z', channelId: '6ac4d52b6a5c39ccb62e6cc6' };
  assert.deepEqual(readSavedBufferDraft(savedPostText), expectedDraft);
  assert.deepEqual(readSavedBufferDraft([{ type: 'text', text: savedPostText }]), expectedDraft);
  assert.deepEqual(readSavedBufferDraft({ content: [{ type: 'text', text: savedPostText }] }), expectedDraft);
  assert.deepEqual(readSavedBufferDraft({ post: JSON.parse(savedPostText.split('}{"rateLimit"')[0] + '}') }), expectedDraft);
});

test('records nothing for a response that is not a saved draft', () => {
  assert.equal(readSavedBufferDraft(savedPostText.replace('"status":"draft"', '"status":"scheduled"')), null);
  assert.equal(readSavedBufferDraft('{"error":"GraphQL error"}'), null);
  assert.equal(readSavedBufferDraft('not json'), null);
  assert.equal(readSavedBufferDraft(undefined), null);
});

test('recorded drafts read back by post id and keep earlier records', async () => {
  const environment = createLedgerEnvironment();
  assert.equal(readRecordedBufferDraft(savedPostId, environment), null);
  await recordBufferDraft({ id: savedPostId, updatedAt: 'first' }, environment);
  await recordBufferDraft({ id: 'a'.repeat(24), updatedAt: 'other' }, environment);
  await recordBufferDraft({ id: savedPostId, updatedAt: 'second' }, environment);
  assert.deepEqual(readRecordedBufferDraft(savedPostId, environment), { updatedAt: 'second' });
  assert.deepEqual(readRecordedBufferDraft('a'.repeat(24), environment), { updatedAt: 'other' });
  assert.equal(readRecordedBufferDraft('__proto__', environment), null);
});

test('recorded drafts list by channel and slot instant', async () => {
  const environment = createLedgerEnvironment();
  await recordBufferDraft({ id: savedPostId, updatedAt: 'u', dueAt: '2026-10-12T23:30:00.000Z', channelId: 'x-channel' }, environment);
  await recordBufferDraft({ id: 'a'.repeat(24), updatedAt: 'u', dueAt: '2026-10-12T23:30:00.000Z', channelId: 'linkedin-channel' }, environment);
  assert.deepEqual(listRecordedBufferDraftsAtSlot('x-channel', Date.parse('2026-10-12T17:30:00-06:00'), environment), [savedPostId]);
  assert.deepEqual(listRecordedBufferDraftsAtSlot('x-channel', Date.parse('2026-10-13T23:30:00.000Z'), environment), []);
  assert.deepEqual(listRecordedBufferDraftsAtSlot('x-channel', Date.parse('2026-10-12T23:30:00.000Z'), createLedgerEnvironment()), []);
});

function answerWith(responseBody, status = 200) {
  return async () => ({ ok: status === 200, status, json: async () => responseBody });
}

test('the live state reader maps Buffer answers to draft state, missing, or an error', async () => {
  const readAuthorization = () => 'Bearer test';
  const liveDraft = { data: { post: { id: savedPostId, status: 'draft', updatedAt: 'u1' } } };
  assert.deepEqual(await readPostState(savedPostId, { fetchPost: answerWith(liveDraft), readAuthorization }), { status: 'draft', updatedAt: 'u1' });
  const notFound = { data: null, errors: [{ message: `Post not found for id: ${savedPostId}` }] };
  assert.deepEqual(await readPostState(savedPostId, { fetchPost: answerWith(notFound), readAuthorization }), { missing: true });
  await assert.rejects(readPostState(savedPostId, { fetchPost: answerWith({ errors: [{ message: 'Unauthorized' }] }), readAuthorization }));
  await assert.rejects(readPostState(savedPostId, { fetchPost: answerWith({}, 500), readAuthorization }));
});

test('the live state reader sends the post id as a query variable with the bearer header', async () => {
  let sentRequest;
  const fetchPost = async (url, request) => {
    sentRequest = { url, ...request };
    return { ok: true, status: 200, json: async () => ({ data: { post: { status: 'draft', updatedAt: 'u' } } }) };
  };
  await readPostState(savedPostId, { fetchPost, readAuthorization: () => 'Bearer test' });
  assert.equal(sentRequest.headers.Authorization, 'Bearer test');
  assert.deepEqual(JSON.parse(sentRequest.body).variables, { id: savedPostId });
});

test('the PostToolUse hook records a saved draft from an MCP tool payload', () => {
  const environment = createLedgerEnvironment();
  const payload = { tool_name: 'mcp__buffer__create_post', tool_use_id: 't1', tool_response: [{ type: 'text', text: savedPostText }] };
  const hookRun = spawnSync(process.execPath, [new URL('./record-buffer-draft.mjs', import.meta.url).pathname], { input: JSON.stringify(payload), env: { ...process.env, ...environment } });
  assert.equal(hookRun.status, 0);
  assert.deepEqual(readRecordedBufferDraft(savedPostId, environment), { updatedAt: '2026-10-08T20:49:00.045Z' });
  assert.deepEqual(listRecordedBufferDraftsAtSlot('6ac4d52b6a5c39ccb62e6cc6', Date.parse('2026-10-12T23:30:00.000Z'), environment), [savedPostId]);
});
