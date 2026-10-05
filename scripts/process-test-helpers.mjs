import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)

export function executeTestCommand(command, commandArguments, options, standardInputText) {
  const executionPromise = executeFile(command, commandArguments, options)
  if (standardInputText !== undefined) executionPromise.child.stdin.end(standardInputText)
  return executionPromise
}

export async function captureTestCommand(command, commandArguments, options, standardInputText) {
  try {
    return { ...(await executeTestCommand(command, commandArguments, options, standardInputText)), exitCode: 0 }
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code }
  }
}

function spawnTestProcess(command, commandArguments, options, standardInputText) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, commandArguments, options)
    let stdoutText = ''
    let stderrText = ''
    childProcess.stdout.on('data', (chunk) => { stdoutText += chunk })
    childProcess.stderr.on('data', (chunk) => { stderrText += chunk })
    childProcess.on('error', reject)
    childProcess.on('close', (exitCode) => resolve({ exitCode, stdoutText, stderrText }))
    if (standardInputText !== undefined) childProcess.stdin.end(standardInputText)
  })
}

export function spawnLoggedNodeProcess(scriptPath, commandArguments, logFilePath, standardInputText) {
  return spawnTestProcess(process.execPath, [scriptPath, ...commandArguments], {
    cwd: '/',
    env: { ...process.env, GLISSA_LOG_FILE: logFilePath }
  }, standardInputText)
}
