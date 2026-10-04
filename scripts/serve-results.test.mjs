import assert from 'node:assert/strict'
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { setTestEnvironment, withTemporaryDirectory, withTestEnvironment } from './fixture-test-helpers.mjs'
import { captureTestCommand } from './process-test-helpers.mjs'
import { createResultServer, findServedFilePath, readLiveInterfaceAddresses, resultUrl } from './serve-results.mjs'
import { pageStyleHash } from './render-markdown.mjs'
import { closeServer } from './serve-test-helpers.mjs'

const resultServerScriptPath = fileURLToPath(new URL('./serve-results.mjs', import.meta.url))

const expectedTailnetLogin = 'operator@github'
const ownTailnetAddressList = '100.100.0.1,fd7a:115c:a1e0::1'
const phoneTailnetAddress = '100.100.0.2'
const resultLinkHost = 'results.example.ts.net'
const resultLinkPort = '8444'
const researchFilePath = '/research/2027-03-01-sample-topic.md'
const researchFileText = '---\nquestion: Which fare?\n---\n\n## Answer\nThe flexible fare.\n'

async function withResultFixture(testFunction, environmentOverrides = {}) {
  return withTemporaryDirectory('assistant-results-', async (servedRootDirectory) => {
    await Promise.all([
      mkdir(join(servedRootDirectory, 'research')),
      mkdir(join(servedRootDirectory, 'briefs')),
      mkdir(join(servedRootDirectory, 'travel')),
      mkdir(join(servedRootDirectory, 'memory', 'profile'), { recursive: true }),
      mkdir(join(servedRootDirectory, 'outside')),
    ])
    await Promise.all([
      writeFile(join(servedRootDirectory, 'research', '2027-03-01-sample-topic.md'), researchFileText),
      writeFile(join(servedRootDirectory, 'research', 'notes.txt'), 'plain text\n'),
      writeFile(join(servedRootDirectory, 'briefs', '2026-09-18.md'), 'morning brief\n'),
      writeFile(join(servedRootDirectory, 'memory', 'profile', 'work.md'), 'employer\n'),
      writeFile(join(servedRootDirectory, 'tasks.json'), '{"tasks":[]}\n'),
      writeFile(join(servedRootDirectory, 'outside', 'secret.md'), 'outside the served directories\n'),
    ])
    await symlink(join(servedRootDirectory, 'outside', 'secret.md'), join(servedRootDirectory, 'research', 'escape.md'))
    const restoreEnvironment = setTestEnvironment({
      ASSISTANT_RESULT_ROOT: servedRootDirectory,
      ASSISTANT_RESULT_LOGIN: expectedTailnetLogin,
      ASSISTANT_RESULT_SELF_ADDRESSES: ownTailnetAddressList,
      ASSISTANT_LOG_FILE: join(servedRootDirectory, 'assistant.jsonl'),
      ...environmentOverrides,
    })
    try {
      await testFunction(await realpath(servedRootDirectory))
    } finally {
      restoreEnvironment()
    }
  })
}

const requestCases = [
  { name: 'serves a research file to the expected tailnet login', method: 'GET', requestPath: researchFilePath, tailnetLogin: expectedTailnetLogin, forwardedForHeader: phoneTailnetAddress, isServed: true },
  { name: 'serves a brief to a HEAD request', method: 'HEAD', requestPath: '/briefs/2026-09-18.md', tailnetLogin: expectedTailnetLogin, forwardedForHeader: phoneTailnetAddress, isServed: true },
  { name: 'serves a forwarded chain that ends at another tailnet member', method: 'GET', requestPath: researchFilePath, tailnetLogin: expectedTailnetLogin, forwardedForHeader: `100.100.0.1, ${phoneTailnetAddress}`, isServed: true },
  { name: 'refuses another tailnet member', method: 'GET', requestPath: researchFilePath, tailnetLogin: 'someone@example.com', forwardedForHeader: phoneTailnetAddress, isServed: false },
  { name: 'refuses a request carrying no tailnet login header', method: 'GET', requestPath: researchFilePath, tailnetLogin: undefined, forwardedForHeader: phoneTailnetAddress, isServed: false },
  { name: 'refuses a request originating on this machine over IPv4', method: 'GET', requestPath: researchFilePath, tailnetLogin: expectedTailnetLogin, forwardedForHeader: '100.100.0.1', isServed: false },
  { name: 'refuses a request originating on this machine over IPv6 written in upper case', method: 'GET', requestPath: researchFilePath, tailnetLogin: expectedTailnetLogin, forwardedForHeader: 'FD7A:115C:A1E0::1', isServed: false },
  { name: 'refuses a request carrying no forwarded-for header', method: 'GET', requestPath: researchFilePath, tailnetLogin: expectedTailnetLogin, forwardedForHeader: undefined, isServed: false },
  { name: 'refuses a forwarded chain that ends at this machine', method: 'GET', requestPath: researchFilePath, tailnetLogin: expectedTailnetLogin, forwardedForHeader: `${phoneTailnetAddress}, 100.100.0.1`, isServed: false },
  { name: 'refuses a POST to a served file', method: 'POST', requestPath: researchFilePath, tailnetLogin: expectedTailnetLogin, forwardedForHeader: phoneTailnetAddress, isServed: false },
  { name: 'refuses a traversal path', method: 'GET', requestPath: '/research/../tasks.json', tailnetLogin: expectedTailnetLogin, forwardedForHeader: phoneTailnetAddress, isServed: false },
  { name: 'refuses a dotfile', method: 'GET', requestPath: '/research/.env.md', tailnetLogin: expectedTailnetLogin, forwardedForHeader: phoneTailnetAddress, isServed: false },
  { name: 'refuses a memory path', method: 'GET', requestPath: '/memory/profile/work.md', tailnetLogin: expectedTailnetLogin, forwardedForHeader: phoneTailnetAddress, isServed: false },
  { name: 'refuses the task ledger', method: 'GET', requestPath: '/tasks.json', tailnetLogin: expectedTailnetLogin, forwardedForHeader: phoneTailnetAddress, isServed: false },
  { name: 'refuses a file that is not Markdown', method: 'GET', requestPath: '/research/notes.txt', tailnetLogin: expectedTailnetLogin, forwardedForHeader: phoneTailnetAddress, isServed: false },
  { name: 'refuses a symlink escaping the served directory', method: 'GET', requestPath: '/research/escape.md', tailnetLogin: expectedTailnetLogin, forwardedForHeader: phoneTailnetAddress, isServed: false },
  { name: 'refuses a result file that does not exist', method: 'GET', requestPath: '/research/2026-01-01-absent.md', tailnetLogin: expectedTailnetLogin, forwardedForHeader: phoneTailnetAddress, isServed: false },
]

for (const requestCase of requestCases) {
  test(requestCase.name, async () => {
    await withResultFixture(async (servedRootDirectory) => {
      const servedFilePath = await findServedFilePath({
        requestMethod: requestCase.method,
        requestPath: requestCase.requestPath,
        tailnetLogin: requestCase.tailnetLogin,
        forwardedForHeader: requestCase.forwardedForHeader,
      })
      const expectedFilePath = requestCase.isServed ? join(servedRootDirectory, requestCase.requestPath.slice(1)) : null
      assert.equal(servedFilePath, expectedFilePath)
    })
  })
}

test('refuses every request while the expected login is unconfigured', async () => {
  await withResultFixture(async () => {
    assert.equal(await findServedFilePath({ requestMethod: 'GET', requestPath: researchFilePath, tailnetLogin: expectedTailnetLogin, forwardedForHeader: phoneTailnetAddress }), null)
    assert.equal(await findServedFilePath({ requestMethod: 'GET', requestPath: researchFilePath, tailnetLogin: undefined, forwardedForHeader: phoneTailnetAddress }), null)
  }, { ASSISTANT_RESULT_LOGIN: undefined })
})

test('refuses every request while this machine has no configured addresses', async () => {
  await withResultFixture(async () => {
    assert.equal(await findServedFilePath({ requestMethod: 'GET', requestPath: researchFilePath, tailnetLogin: expectedTailnetLogin, forwardedForHeader: phoneTailnetAddress }), null)
    assert.equal(await findServedFilePath({ requestMethod: 'HEAD', requestPath: '/briefs/2026-09-18.md', tailnetLogin: expectedTailnetLogin, forwardedForHeader: phoneTailnetAddress }), null)
  }, { ASSISTANT_RESULT_SELF_ADDRESSES: undefined })
})

test('refuses an address live on this machine but absent from the configured list', async () => {
  const loopbackAddress = '127.0.0.1'
  assert.ok(readLiveInterfaceAddresses().includes(loopbackAddress))
  assert.ok(!ownTailnetAddressList.split(',').includes(loopbackAddress))
  await withResultFixture(async () => {
    assert.equal(await findServedFilePath({ requestMethod: 'GET', requestPath: researchFilePath, tailnetLogin: expectedTailnetLogin, forwardedForHeader: loopbackAddress }), null)
    assert.equal(await findServedFilePath({ requestMethod: 'GET', requestPath: researchFilePath, tailnetLogin: expectedTailnetLogin, forwardedForHeader: `${phoneTailnetAddress}, ${loopbackAddress}` }), null)
  })
})

test('the served request cases originate off this machine', () => {
  assert.ok(!readLiveInterfaceAddresses().includes(phoneTailnetAddress))
})

const resultHostEnvironment = { ASSISTANT_RESULT_HOST: resultLinkHost, ASSISTANT_RESULT_PORT: resultLinkPort }

function urlCommandEnvironment(overrides) {
  return { ...process.env, ASSISTANT_RESULT_HOST: '', ASSISTANT_RESULT_PORT: '', ...overrides }
}

test('result URL points at the configured tailnet host and port', () => {
  withTestEnvironment(resultHostEnvironment, () => {
    assert.equal(resultUrl('research/2027-03-01-sample-topic.md'), 'https://results.example.ts.net:8444/research/2027-03-01-sample-topic.md')
  })
})

test('result URL omits the port when none is configured', () => {
  withTestEnvironment({ ASSISTANT_RESULT_HOST: resultLinkHost, ASSISTANT_RESULT_PORT: undefined }, () => {
    assert.equal(resultUrl('research/2027-03-01-sample-topic.md'), 'https://results.example.ts.net/research/2027-03-01-sample-topic.md')
  })
})

test('result URL refuses to invent a host when none is configured', () => {
  withTestEnvironment({ ASSISTANT_RESULT_HOST: undefined }, () => {
    assert.throws(() => resultUrl('research/2027-03-01-sample-topic.md'), /ASSISTANT_RESULT_HOST is not set/)
  })
})

test('the url command prints the link for a served path', async () => {
  const urlResult = await captureTestCommand(process.execPath, [resultServerScriptPath, 'url', 'research/2027-03-01-sample-topic.md'], { env: urlCommandEnvironment(resultHostEnvironment) })
  assert.equal(urlResult.exitCode, 0)
  assert.equal(urlResult.stdout, 'https://results.example.ts.net:8444/research/2027-03-01-sample-topic.md\n')
})

test('the url command fails without a configured host', async () => {
  const urlResult = await captureTestCommand(process.execPath, [resultServerScriptPath, 'url', 'research/2027-03-01-sample-topic.md'], { env: urlCommandEnvironment({}) })
  assert.equal(urlResult.exitCode, 1)
  assert.match(urlResult.stderr, /ASSISTANT_RESULT_HOST is not set/)
  assert.equal(urlResult.stdout, '')
})

test('the url command refuses a path outside the served directories', async () => {
  const urlResult = await captureTestCommand(process.execPath, [resultServerScriptPath, 'url', 'memory/profile/work.md'])
  assert.equal(urlResult.exitCode, 2)
  assert.equal(urlResult.stderr, 'Not a served result path: memory/profile/work.md\n')
  assert.equal(urlResult.stdout, '')
})

test('the url command refuses a missing path argument', async () => {
  const urlResult = await captureTestCommand(process.execPath, [resultServerScriptPath, 'url'])
  assert.equal(urlResult.exitCode, 2)
  assert.equal(urlResult.stderr, 'usage: serve-results.mjs [url <repository-relative-path>]\n')
})

test('a served response carries the rendered page and the hardening headers', async () => {
  await withResultFixture(async () => {
    const server = createResultServer()
    await new Promise((listening) => server.listen(0, '127.0.0.1', listening))
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${researchFilePath}`, {
        headers: { 'tailscale-user-login': expectedTailnetLogin, 'x-forwarded-for': phoneTailnetAddress },
      })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
      assert.equal(response.headers.get('content-security-policy'), `default-src 'none'; style-src 'sha256-${pageStyleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      const pageHtml = await response.text()
      assert.match(pageHtml, /<h2>Answer<\/h2>\n<p>The flexible fare\.<\/p>/)
      assert.match(pageHtml, /<strong>question:<\/strong> Which fare\?/)
      assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(pageHtml))
    } finally {
      await closeServer(server)
    }
  })
})

test('a refused response stays plain text', async () => {
  await withResultFixture(async () => {
    const server = createResultServer()
    await new Promise((listening) => server.listen(0, '127.0.0.1', listening))
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${researchFilePath}`)
      assert.equal(response.status, 404)
      assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
      assert.equal(await response.text(), 'not found\n')
    } finally {
      await closeServer(server)
    }
  })
})
