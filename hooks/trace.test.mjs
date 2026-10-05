import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLogFilePath } from '../scripts/fixture-test-helpers.mjs';
import { readJsonFileSync } from '../scripts/json-file.mjs';
import { spawnLoggedNodeProcess } from '../scripts/process-test-helpers.mjs';

const traceHookPath = fileURLToPath(new URL('./trace.mjs', import.meta.url));

function createTraceLogFilePath() {
  return createLogFilePath('glissa-trace-');
}

function runTraceHook(stdinText, logFilePath) {
  return spawnLoggedNodeProcess(traceHookPath, [], logFilePath, stdinText);
}

test('post tool use logs metadata without tool inputs or responses', async () => {
  const logFilePath = createTraceLogFilePath();
  const secretInputValue = 'operator-mail-value';
  const secretResponseText = 'connector-response-text';
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: 'session-1',
    tool_name: 'mcp__claude_ai_Gmail__search_messages',
    tool_use_id: 'tool-1',
    tool_input: { query: secretInputValue },
    tool_response: { isError: true, text: secretResponseText }
  });
  const { exitCode, stdoutText } = await runTraceHook(payload, logFilePath);
  const logLine = fs.readFileSync(logFilePath, 'utf8');
  const logEntry = JSON.parse(logLine);

  assert.equal(exitCode, 0);
  assert.equal(stdoutText, '');
  assert.equal(logEntry.event, 'post_tool_use');
  assert.equal(logEntry.tool_name, 'mcp__claude_ai_Gmail__search_messages');
  assert.equal(logEntry.is_error, true);
  assert.doesNotMatch(logLine, new RegExp(secretInputValue));
  assert.doesNotMatch(logLine, new RegExp(secretResponseText));
});

test('post tool use from a subagent logs the agent type without tool inputs', async () => {
  const logFilePath = createTraceLogFilePath();
  const secretInputValue = 'operator-question-text';
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: 'session-3',
    agent_type: 'research-lane',
    tool_name: 'mcp__browser__browser_navigate',
    tool_use_id: 'tool-3',
    tool_input: { url: `https://airline.example/?question=${secretInputValue}` }
  });
  await runTraceHook(payload, logFilePath);
  const logLine = fs.readFileSync(logFilePath, 'utf8');
  const logEntry = JSON.parse(logLine);

  assert.equal(logEntry.agent_type, 'research-lane');
  assert.equal(logEntry.tool_name, 'mcp__browser__browser_navigate');
  assert.doesNotMatch(logLine, new RegExp(secretInputValue));
});

test('session start logs the transcript path', async () => {
  const logFilePath = createTraceLogFilePath();
  const transcriptPath = '/tmp/glissa-session.jsonl';
  const payload = JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: 'session-2',
    transcript_path: transcriptPath
  });
  await runTraceHook(payload, logFilePath);
  const logEntry = readJsonFileSync(logFilePath);

  assert.equal(logEntry.event, 'session_start');
  assert.equal(logEntry.transcript_path, transcriptPath);
});

test('unreadable payload logs an event and exits successfully', async () => {
  const logFilePath = createTraceLogFilePath();
  const { exitCode, stdoutText } = await runTraceHook('not json', logFilePath);
  const logEntry = readJsonFileSync(logFilePath);

  assert.equal(exitCode, 0);
  assert.equal(stdoutText, '');
  assert.equal(logEntry.event, 'unreadable_payload');
});

test('post tool use failure logs the error shape without the error text', async () => {
  const logFilePath = createTraceLogFilePath();
  const secretMarker = 'operator-secret-token';
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUseFailure',
    session_id: 'session-4',
    tool_name: 'Bash',
    tool_use_id: 'tool-4',
    error: `Command failed: exit 1 ${secretMarker}`
  });
  await runTraceHook(payload, logFilePath);
  const logLine = fs.readFileSync(logFilePath, 'utf8');
  const logEntry = JSON.parse(logLine);

  assert.equal(logEntry.event, 'post_tool_use_failure');
  assert.equal(logEntry.error_kind, 'Command failed');
  assert.equal(logEntry.error_length, `Command failed: exit 1 ${secretMarker}`.length);
  assert.equal(logEntry.error, undefined);
  assert.doesNotMatch(logLine, new RegExp(secretMarker));
});

test('post tool use failure without a colon logs the error length and no error kind', async () => {
  const logFilePath = createTraceLogFilePath();
  const errorText = 'Meeting with Jane Doe at Acme Corp was not found';
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUseFailure',
    session_id: 'session-5',
    tool_name: 'mcp__claude_ai_Google_Calendar__list_events',
    tool_use_id: 'tool-5',
    error: errorText
  });
  await runTraceHook(payload, logFilePath);
  const logLine = fs.readFileSync(logFilePath, 'utf8');
  const logEntry = JSON.parse(logLine);

  assert.equal(logEntry.event, 'post_tool_use_failure');
  assert.equal(logEntry.error_length, errorText.length);
  assert.equal(logEntry.error_kind, undefined);
  for (const errorWord of errorText.split(' ')) {
    assert.doesNotMatch(logLine, new RegExp(`\\b${errorWord}\\b`, 'i'));
  }
});
