import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { logEvent } from './log.mjs';
import { createLogFilePath, createTemporaryDirectory, withTestEnvironment } from './fixture-test-helpers.mjs';
import { spawnLoggedNodeProcess } from './process-test-helpers.mjs';
import { readJsonFileSync } from './json-file.mjs';

const logScriptPath = fileURLToPath(new URL('./log.mjs', import.meta.url));

function runLogCommand(argumentsList, logFilePath) {
  return spawnLoggedNodeProcess(logScriptPath, argumentsList, logFilePath);
}

test('logEvent writes a parseable structured JSON line', () => {
  const logFilePath = createLogFilePath('glissa-log-');
  withTestEnvironment({ GLISSA_LOG_FILE: logFilePath }, () => logEvent('test', 'written', { attempt: 3, state: 'ready' }));

  const logEntry = readJsonFileSync(logFilePath);
  assert.match(logEntry.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(logEntry.component, 'test');
  assert.equal(logEntry.event, 'written');
  assert.equal(logEntry.attempt, 3);
  assert.equal(logEntry.state, 'ready');
});

test('rotates the log file once it reaches the size threshold', () => {
  const logFilePath = createLogFilePath('glissa-log-');
  const logContentsAtThreshold = 'a'.repeat(8 * 1024 * 1024);
  fs.writeFileSync(logFilePath, logContentsAtThreshold);

  withTestEnvironment({ GLISSA_LOG_FILE: logFilePath }, () => logEvent('test', 'rotated'));

  assert.equal(fs.readFileSync(`${logFilePath}.1`, 'utf8'), logContentsAtThreshold);
  assert.equal(readJsonFileSync(logFilePath).event, 'rotated');
});

test('rotation replaces an existing rotated sibling', () => {
  const logFilePath = createLogFilePath('glissa-log-');
  const logContentsAtThreshold = 'a'.repeat(8 * 1024 * 1024);
  fs.writeFileSync(logFilePath, logContentsAtThreshold);
  fs.writeFileSync(`${logFilePath}.1`, 'older log contents');

  withTestEnvironment({ GLISSA_LOG_FILE: logFilePath }, () => logEvent('test', 'rotated'));

  assert.equal(fs.readFileSync(`${logFilePath}.1`, 'utf8'), logContentsAtThreshold);
});

test('skips rotation while a fresh rotate lock is held and still appends the event', () => {
  const logFilePath = createLogFilePath('glissa-log-');
  const logContentsAtThreshold = 'a'.repeat(8 * 1024 * 1024);
  fs.writeFileSync(logFilePath, logContentsAtThreshold);
  fs.writeFileSync(`${logFilePath}.rotate`, '');

  withTestEnvironment({ GLISSA_LOG_FILE: logFilePath }, () => logEvent('test', 'appended'));

  assert.equal(fs.existsSync(`${logFilePath}.1`), false);
  assert.equal(fs.existsSync(`${logFilePath}.rotate`), true);
  const logContents = fs.readFileSync(logFilePath, 'utf8');
  assert.equal(JSON.parse(logContents.slice(logContentsAtThreshold.length)).event, 'appended');
});

test('rotates once the rotate lock is older than the stale age and removes it', () => {
  const logFilePath = createLogFilePath('glissa-log-');
  const logContentsAtThreshold = 'a'.repeat(8 * 1024 * 1024);
  fs.writeFileSync(logFilePath, logContentsAtThreshold);
  const rotationLockPath = `${logFilePath}.rotate`;
  fs.writeFileSync(rotationLockPath, '');
  const staleLockTime = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(rotationLockPath, staleLockTime, staleLockTime);

  withTestEnvironment({ GLISSA_LOG_FILE: logFilePath }, () => logEvent('test', 'rotated'));

  assert.equal(fs.readFileSync(`${logFilePath}.1`, 'utf8'), logContentsAtThreshold);
  assert.equal(fs.existsSync(rotationLockPath), false);
  assert.deepEqual(fs.readdirSync(path.dirname(logFilePath)).filter((fileName) => fileName.endsWith('.stale')), []);
  assert.equal(readJsonFileSync(logFilePath).event, 'rotated');
});

test('skips rotation when the log file shrank below the threshold before the lock was held', () => {
  const logFilePath = createLogFilePath('glissa-log-');
  fs.writeFileSync(logFilePath, 'a'.repeat(8 * 1024 * 1024));
  const rotationLockPath = `${logFilePath}.rotate`;
  const originalOpenSync = fs.openSync;
  fs.openSync = (targetPath, flags, mode) => {
    if (targetPath === rotationLockPath) fs.truncateSync(logFilePath, 0);
    return originalOpenSync(targetPath, flags, mode);
  };

  try {
    withTestEnvironment({ GLISSA_LOG_FILE: logFilePath }, () => logEvent('test', 'appended'));
  } finally {
    fs.openSync = originalOpenSync;
  }

  assert.equal(fs.existsSync(`${logFilePath}.1`), false);
  assert.equal(fs.existsSync(rotationLockPath), false);
  assert.equal(readJsonFileSync(logFilePath).event, 'appended');
});

test('leaves a log file under the threshold in place', () => {
  const logFilePath = createLogFilePath('glissa-log-');
  const initialLogContents = 'a'.repeat(8 * 1024 * 1024 - 1);
  fs.writeFileSync(logFilePath, initialLogContents);

  withTestEnvironment({ GLISSA_LOG_FILE: logFilePath }, () => logEvent('test', 'appended'));

  assert.equal(fs.existsSync(`${logFilePath}.1`), false);
  const logContents = fs.readFileSync(logFilePath, 'utf8');
  assert.equal(logContents.startsWith(initialLogContents), true);
  assert.equal(JSON.parse(logContents.slice(initialLogContents.length)).event, 'appended');
});

test('the CLI parses key-value fields, numbers, and booleans', async () => {
  const logFilePath = createLogFilePath('glissa-log-');
  const { exitCode } = await runLogCommand(['run', 'exit', 'exit_code=-2', 'healthy=true'], logFilePath);
  const logEntry = readJsonFileSync(logFilePath);

  assert.equal(exitCode, 0);
  assert.equal(logEntry.exit_code, -2);
  assert.equal(logEntry.healthy, true);
});

test('the CLI parses false into a boolean', async () => {
  const logFilePath = createLogFilePath('glissa-log-');
  await runLogCommand(['run', 'exit', 'healthy=false'], logFilePath);
  const logEntry = readJsonFileSync(logFilePath);

  assert.equal(logEntry.healthy, false);
});

test('the CLI exits 2 when component or event is missing', async () => {
  const { exitCode, stderrText } = await runLogCommand([], createLogFilePath('glissa-log-'));

  assert.equal(exitCode, 2);
  assert.match(stderrText, /usage:/);
});

test('logEvent reports an unwritable log path without throwing', () => {
  const { temporaryDirectoryPath, removeTemporaryDirectory } = createTemporaryDirectory('glissa-log-');
  const originalStderrWrite = process.stderr.write;
  let stderrText = '';
  process.stderr.write = (text) => {
    stderrText += text;
    return true;
  };

  try {
    withTestEnvironment({ GLISSA_LOG_FILE: temporaryDirectoryPath }, () => assert.doesNotThrow(() => logEvent('test', 'unwritable')));
  } finally {
    process.stderr.write = originalStderrWrite;
    removeTemporaryDirectory();
  }

  assert.match(stderrText, /^log: could not write /);
});
