import fs from 'node:fs';
import path from 'node:path';
import { isMainModule } from './command-line.mjs';
import { resolveRepositoryPath } from './repository-path.mjs';

const defaultLogFile = resolveRepositoryPath('logs', 'glissa.jsonl');
const rotationThresholdBytes = 8 * 1024 * 1024;
const staleRotationLockAgeMs = 60 * 1000;

function getLogFilePath() {
  return process.env.GLISSA_LOG_FILE || defaultLogFile;
}

function openExclusiveRotationLock(rotationLockPath) {
  try {
    return fs.openSync(rotationLockPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return null;
  }
}

function isRotationLockStale(rotationLockPath) {
  try {
    return Date.now() - fs.statSync(rotationLockPath).mtimeMs > staleRotationLockAgeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function claimStaleRotationLock(rotationLockPath) {
  const claimedStaleLockPath = `${rotationLockPath}.${process.pid}.stale`;
  try {
    fs.renameSync(rotationLockPath, claimedStaleLockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  fs.rmSync(claimedStaleLockPath, { force: true });
  return true;
}

function acquireRotationLock(rotationLockPath) {
  const rotationLockDescriptor = openExclusiveRotationLock(rotationLockPath);
  if (rotationLockDescriptor !== null) return rotationLockDescriptor;
  if (!isRotationLockStale(rotationLockPath)) return null;
  if (!claimStaleRotationLock(rotationLockPath)) return null;
  return openExclusiveRotationLock(rotationLockPath);
}

function isLogFileAtRotationThreshold(logFilePath) {
  try {
    return fs.statSync(logFilePath).size >= rotationThresholdBytes;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function rotateLogFileWhenLarge(logFilePath) {
  if (!isLogFileAtRotationThreshold(logFilePath)) return;

  const rotationLockPath = `${logFilePath}.rotate`;
  const rotationLockDescriptor = acquireRotationLock(rotationLockPath);
  if (rotationLockDescriptor === null) return;
  try {
    if (!isLogFileAtRotationThreshold(logFilePath)) return;
    fs.renameSync(logFilePath, `${logFilePath}.1`);
  } finally {
    fs.closeSync(rotationLockDescriptor);
    fs.rmSync(rotationLockPath, { force: true });
  }
}

export function logEvent(component, event, fields = {}) {
  const logFilePath = getLogFilePath();

  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    rotateLogFileWhenLarge(logFilePath);
    fs.appendFileSync(logFilePath, `${JSON.stringify({
      ts: new Date().toISOString(),
      component,
      event,
      ...fields
    })}\n`);
  } catch (error) {
    process.stderr.write(`log: could not write ${logFilePath}: ${error.message}\n`);
  }
}

function parseField(argument) {
  const separatorIndex = argument.indexOf('=');
  if (separatorIndex === -1) return [argument, true];
  const key = argument.slice(0, separatorIndex);
  const value = argument.slice(separatorIndex + 1);

  if (/^-?\d+$/.test(value)) return [key, Number(value)];
  if (value === 'true') return [key, true];
  if (value === 'false') return [key, false];
  return [key, value];
}

function runLogCli() {
  const [component, event, ...fieldArguments] = process.argv.slice(2);
  if (!component || !event) {
    process.stderr.write('usage: node scripts/log.mjs <component> <event> [key=value ...]\n');
    process.exitCode = 2;
    return;
  }

  const fields = Object.fromEntries(fieldArguments.map(parseField));
  logEvent(component, event, fields);
}

if (isMainModule(import.meta.url)) runLogCli();
