import { readFile, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { basename, resolve, sep } from 'node:path'
import { addUsageExitCode, isMainModule, runCommandLine } from './command-line.mjs'
import { logEvent } from './log.mjs'
import { pageStyleHash, renderMarkdownPage } from './render-markdown.mjs'
import { resolveRepositoryPath } from './repository-path.mjs'

const listenHost = '127.0.0.1'
const listenPort = 3010
const servedPathPattern = /^\/(research|briefs|travel)\/[a-z0-9-]+\.md$/
const readMethodNames = new Set(['GET', 'HEAD'])
const tailnetLoginHeaderName = 'tailscale-user-login'
const forwardedForHeaderName = 'x-forwarded-for'
const missingFileErrorCodes = new Set(['EACCES', 'ELOOP', 'ENAMETOOLONG', 'ENOENT', 'ENOTDIR'])
const notFoundBody = 'not found\n'
const hardeningHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}
const notFoundResponseHeaders = {
  ...hardeningHeaders,
  'content-type': 'text/plain; charset=utf-8',
  'content-security-policy': "default-src 'none'",
}
const resultPageResponseHeaders = {
  ...hardeningHeaders,
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': `default-src 'none'; style-src 'sha256-${pageStyleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
}

function resolveServedPath(repositoryRelativePath) {
  const servedRootOverride = process.env.ASSISTANT_RESULT_ROOT
  if (servedRootOverride) return resolve(servedRootOverride, repositoryRelativePath)
  return resolveRepositoryPath(repositoryRelativePath)
}

async function findRealPath(candidatePath) {
  try {
    return await realpath(candidatePath)
  } catch (error) {
    if (missingFileErrorCodes.has(error.code)) return null
    throw error
  }
}

export function isPathInsideDirectory(directoryRealPath, candidateRealPath) {
  return candidateRealPath.startsWith(`${directoryRealPath}${sep}`)
}

async function findFileInsideServedDirectory(requestPath) {
  const [servedDirectoryName, resultFileName] = requestPath.slice(1).split('/')
  const servedDirectoryPath = await findRealPath(resolveServedPath(servedDirectoryName))
  if (servedDirectoryPath === null) return null
  const resultFilePath = await findRealPath(resolve(servedDirectoryPath, resultFileName))
  if (resultFilePath === null) return null
  if (!isPathInsideDirectory(servedDirectoryPath, resultFilePath)) return null
  if (!(await stat(resultFilePath)).isFile()) return null
  return resultFilePath
}

function readOwnTailnetAddresses() {
  const configuredOwnAddresses = process.env.ASSISTANT_RESULT_SELF_ADDRESSES
  if (!configuredOwnAddresses) return null
  const ownAddresses = configuredOwnAddresses
    .split(',')
    .map((ownAddress) => ownAddress.trim().toLowerCase())
    .filter((ownAddress) => ownAddress.length > 0)
  if (ownAddresses.length === 0) return null
  return new Set(ownAddresses)
}

export function readLiveInterfaceAddresses() {
  return Object.values(networkInterfaces())
    .flatMap((interfaceAddresses) => interfaceAddresses ?? [])
    .map((interfaceAddress) => interfaceAddress.address.split('%')[0].trim().toLowerCase())
    .filter((interfaceAddress) => interfaceAddress.length > 0)
}

function readAddressesRefusedAsSelf() {
  const configuredOwnAddresses = readOwnTailnetAddresses()
  if (configuredOwnAddresses === null) return null
  return new Set([...configuredOwnAddresses, ...readLiveInterfaceAddresses()])
}

function readOriginatingAddress(forwardedForHeader) {
  if (typeof forwardedForHeader !== 'string') return null
  const forwardedAddresses = forwardedForHeader.split(',')
  const originatingAddress = forwardedAddresses[forwardedAddresses.length - 1].trim().toLowerCase()
  if (originatingAddress.length === 0) return null
  return originatingAddress
}

export async function findServedFilePath({ requestMethod, requestPath, tailnetLogin, forwardedForHeader }) {
  const expectedTailnetLogin = process.env.ASSISTANT_RESULT_LOGIN
  if (!expectedTailnetLogin) return null
  if (tailnetLogin !== expectedTailnetLogin) return null
  const addressesRefusedAsSelf = readAddressesRefusedAsSelf()
  if (addressesRefusedAsSelf === null) return null
  const originatingAddress = readOriginatingAddress(forwardedForHeader)
  if (originatingAddress === null) return null
  if (addressesRefusedAsSelf.has(originatingAddress)) return null
  if (!readMethodNames.has(requestMethod)) return null
  if (!servedPathPattern.test(requestPath)) return null
  return findFileInsideServedDirectory(requestPath)
}

export function resultUrl(repositoryRelativePath) {
  const resultLinkHost = process.env.ASSISTANT_RESULT_HOST
  if (!resultLinkHost) throw new Error('ASSISTANT_RESULT_HOST is not set; add it to ~/.config/assistant/local.env')
  const resultLinkPort = process.env.ASSISTANT_RESULT_PORT
  const resultLinkOrigin = resultLinkPort ? `${resultLinkHost}:${resultLinkPort}` : resultLinkHost
  return `https://${resultLinkOrigin}/${repositoryRelativePath}`
}

function sendNotFound(response) {
  response.writeHead(404, notFoundResponseHeaders)
  response.end(notFoundBody)
}

function readRequestPath(requestUrl) {
  return new URL(requestUrl, `http://${listenHost}`).pathname
}

async function respondToResultRequest(request, response) {
  const requestPath = readRequestPath(request.url)
  const servedFilePath = await findServedFilePath({
    requestMethod: request.method,
    requestPath,
    tailnetLogin: request.headers[tailnetLoginHeaderName],
    forwardedForHeader: request.headers[forwardedForHeaderName],
  })
  if (servedFilePath === null) {
    logEvent('results', 'refused', { method: request.method })
    sendNotFound(response)
    return
  }

  const resultPageBytes = Buffer.from(renderMarkdownPage(await readFile(servedFilePath, 'utf8'), basename(servedFilePath, '.md')))
  logEvent('results', 'served', { file: requestPath.slice(1) })
  response.writeHead(200, { ...resultPageResponseHeaders, 'content-length': resultPageBytes.byteLength })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  response.end(resultPageBytes)
}

export function createResultServer() {
  return createServer((request, response) => {
    respondToResultRequest(request, response).catch((error) => {
      logEvent('results', 'failed', { code: error.code ?? 'unknown' })
      if (response.headersSent) {
        response.end()
        return
      }
      sendNotFound(response)
    })
  })
}

function startResultServer() {
  const server = createResultServer()
  server.listen(listenPort, listenHost, () => {
    logEvent('results', 'listening', {
      port: listenPort,
      loginConfigured: Boolean(process.env.ASSISTANT_RESULT_LOGIN),
      ownAddressesConfigured: readOwnTailnetAddresses() !== null,
    })
  })
  return server
}

function runResultCommand(commandArguments, { writeOutput = console.log, writeError = console.error } = {}) {
  if (commandArguments.length === 0) {
    startResultServer()
    return 0
  }
  if (commandArguments[0] !== 'url' || commandArguments.length !== 2) {
    writeError('usage: serve-results.mjs [url <repository-relative-path>]')
    return addUsageExitCode
  }
  const repositoryRelativePath = commandArguments[1]
  if (!servedPathPattern.test(`/${repositoryRelativePath}`)) {
    writeError(`Not a served result path: ${repositoryRelativePath}`)
    return addUsageExitCode
  }
  writeOutput(resultUrl(repositoryRelativePath))
  return 0
}

if (isMainModule(import.meta.url)) runCommandLine(runResultCommand)
