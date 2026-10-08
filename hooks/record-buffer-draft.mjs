import { readHookPayload } from './hook-payload.mjs';
import { readSavedBufferDraft, recordBufferDraft } from './buffer-draft-ledger.mjs';
import { logEvent } from '../scripts/log.mjs';

const recordedBufferToolNames = new Set(['mcp__buffer__create_post', 'mcp__buffer__edit_post']);

async function run() {
  let payload;
  try {
    payload = await readHookPayload();
  } catch {
    logEvent('buffer-draft', 'unreadable_payload');
    return;
  }
  if (!recordedBufferToolNames.has(payload?.tool_name)) return;
  const savedDraft = readSavedBufferDraft(payload.tool_response);
  if (savedDraft === null) {
    logEvent('buffer-draft', 'unrecorded', { tool_name: payload.tool_name, tool_use_id: payload.tool_use_id });
    return;
  }
  await recordBufferDraft(savedDraft);
  logEvent('buffer-draft', 'recorded', { tool_name: payload.tool_name, post_id: savedDraft.id });
}

await run();
