import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { withTemporaryDirectory } from './fixture-test-helpers.mjs'
import { buildManifest, main } from './glissa-migrate.mjs'

const serviceStateDirectory = await mkdtemp(join(tmpdir(), 'glissa-migrate-systemctl-'))
test.after(() => rm(serviceStateDirectory, { recursive: true, force: true }))

async function writeServiceStateCommand(commandName, reportedState, exitCode) {
  const commandPath = join(serviceStateDirectory, commandName)
  await writeFile(commandPath, `#!/bin/sh\n[ "$*" = "--user is-active glissa.service" ] || exit 9\necho ${reportedState}\nexit ${exitCode}\n`)
  await chmod(commandPath, 0o700)
  return commandPath
}

const stoppedServiceCommand = await writeServiceStateCommand('stopped-systemctl', 'inactive', 3)
const activeServiceCommand = await writeServiceStateCommand('active-systemctl', 'active', 0)

async function createCheckout(temporaryDirectory) {
  const checkoutDirectory = join(temporaryDirectory, 'checkout')
  await mkdir(join(checkoutDirectory, 'memory', 'empty'), { recursive: true })
  await mkdir(join(checkoutDirectory, 'context', 'chat'), { recursive: true })
  await writeFile(join(checkoutDirectory, 'memory', 'note.md'), 'original memory\n', { mode: 0o640 })
  await utimes(join(checkoutDirectory, 'memory', 'note.md'), 1_700_000_000, 1_700_000_000)
  await writeFile(join(checkoutDirectory, 'context', 'chat', 'x.jsonl'), '{"text":"hello"}\n')
  await symlink('../context/chat/x.jsonl', join(checkoutDirectory, 'memory', 'chat'))
  await symlink('missing', join(checkoutDirectory, 'memory', 'dangling'))
  await writeFile(join(checkoutDirectory, 'tasks.json'), '{"tasks":[]}\n')
  return checkoutDirectory
}

async function runMigration(argumentsList, environment = {}) {
  const output = []
  const errors = []
  const exitCode = await main({
    argumentsList,
    environment: { ...process.env, GLISSA_SYSTEMCTL: stoppedServiceCommand, ...environment },
    writeOutput: (line) => output.push(line),
    writeError: (line) => errors.push(line)
  })
  return { exitCode, output, errors }
}

test('migration copies and verifies files, empty directories and symlinks without changing originals', async () => {
  await withTemporaryDirectory('glissa-migrate-', async (temporaryDirectory) => {
    const checkoutDirectory = await createCheckout(temporaryDirectory)
    const destinationDirectory = join(temporaryDirectory, 'destination')
    await mkdir(destinationDirectory)
    const originalManifest = await buildManifest(checkoutDirectory)
    const migration = await runMigration(['--from', checkoutDirectory, '--to', destinationDirectory])
    assert.equal(migration.exitCode, 0, migration.errors.join('\n'))
    assert.deepEqual(migration.errors, [])
    assert.deepEqual(migration.output.filter((line) => line.endsWith(', match')), [
      'memory: 1 files, 2 links, match', 'context: 1 files, 0 links, match', 'tasks.json: 1 files, 0 links, match'
    ])
    for (const absentPath of ['briefs', 'research', 'travel', 'content', 'logs', 'calendar-allow.json', 'browse-domains.json']) {
      assert.ok(migration.output.includes(`${absentPath}: absent, skipped`))
    }
    assert.deepEqual(await buildManifest(destinationDirectory), originalManifest)
    assert.deepEqual(await buildManifest(checkoutDirectory), originalManifest)
    assert.equal(await readlink(join(destinationDirectory, 'memory', 'chat')), '../context/chat/x.jsonl')
    assert.equal(await readlink(join(destinationDirectory, 'memory', 'dangling')), 'missing')
    const copiedStats = await lstat(join(destinationDirectory, 'memory', 'note.md'))
    assert.equal(copiedStats.mode & 0o777, 0o640)
    assert.equal(copiedStats.mtimeMs, 1_700_000_000_000)
    assert.match(migration.output.at(-1), /Originals stay in place.*rollback is reinstalling the old units/)
    const verification = await runMigration(['--from', checkoutDirectory, '--to', destinationDirectory, '--verify'])
    assert.equal(verification.exitCode, 0, verification.errors.join('\n'))
    assert.deepEqual(verification.output.filter((line) => line.endsWith(', match')), [
      'memory: 1 files, 2 links, match', 'context: 1 files, 0 links, match', 'tasks.json: 1 files, 0 links, match'
    ])
    await writeFile(join(destinationDirectory, 'tasks.json'), '{"tasks":["changed"]}\n')
    const divergedVerification = await runMigration(['--from', checkoutDirectory, '--to', destinationDirectory, '--verify'])
    assert.equal(divergedVerification.exitCode, 1)
    assert.deepEqual(divergedVerification.errors, ['tasks.json: mismatch at .'])
  })
})

test('refusals leave existing paths and the entire fixture unchanged, including during dry runs', async () => {
  await withTemporaryDirectory('glissa-migrate-refusals-', async (temporaryDirectory) => {
    const checkoutDirectory = await createCheckout(temporaryDirectory)
    const existingDestination = join(temporaryDirectory, 'existing')
    await mkdir(existingDestination)
    await symlink('missing', join(existingDestination, 'tasks.json'))
    const checkoutAlias = join(temporaryDirectory, 'checkout-alias')
    await symlink(checkoutDirectory, checkoutAlias)
    const outsideLinkCheckout = join(temporaryDirectory, 'outside-link-checkout')
    await mkdir(join(outsideLinkCheckout, 'memory'), { recursive: true })
    await symlink('../.glissa/note.md', join(outsideLinkCheckout, 'memory', 'note.md'))
    const linkedPathCheckout = join(temporaryDirectory, 'linked-path-checkout')
    await mkdir(join(linkedPathCheckout, 'memory'), { recursive: true })
    await symlink(join(checkoutDirectory, 'context'), join(linkedPathCheckout, 'logs'))
    const originalManifest = await buildManifest(temporaryDirectory)
    const refusalCases = [
      { argumentsList: ['--from', outsideLinkCheckout, '--to', join(temporaryDirectory, 'outside-link-destination')], message: /memory\/note\.md -> \.\.\/\.glissa\/note\.md/ },
      { argumentsList: ['--from', linkedPathCheckout, '--to', join(temporaryDirectory, 'linked-path-destination')], message: /logs is itself a symlink/ },
      { argumentsList: ['--from', checkoutDirectory, '--to', existingDestination], message: /already exists; move it aside/ },
      { argumentsList: ['--from', checkoutDirectory, '--to', join(temporaryDirectory, 'active-destination')], environment: { GLISSA_SYSTEMCTL: activeServiceCommand }, message: /glissa.service is active/ },
      { argumentsList: ['--from', checkoutDirectory, '--to', existingDestination, '--verify'], modeArgumentsList: [[]], environment: { GLISSA_SYSTEMCTL: activeServiceCommand }, message: /glissa.service is active; verify compares the copy against the originals/ },
      { argumentsList: ['--from', checkoutDirectory, '--to', join(temporaryDirectory, 'unreachable-destination')], environment: { GLISSA_SYSTEMCTL: '/bin/false' }, message: /Could not confirm glissa.service is stopped/ },
      { argumentsList: ['--from', checkoutDirectory, '--to', join(checkoutDirectory, 'nested')], message: /neither may contain the other/ },
      { argumentsList: ['--from', checkoutDirectory, '--to', join(checkoutAlias, 'nested')], message: /neither may contain the other/ },
      { argumentsList: ['--from', checkoutDirectory, '--to', checkoutAlias], message: /neither may contain the other/ },
      { argumentsList: ['--from', checkoutDirectory, '--to', temporaryDirectory], message: /neither may contain the other/ },
      { argumentsList: ['--to', join(temporaryDirectory, 'missing-from')], message: /usage:/ },
      { argumentsList: ['--from', existingDestination, '--to', join(temporaryDirectory, 'no-memory')], message: /memory\/ directory/ }
    ]
    for (const refusalCase of refusalCases) {
      for (const modeArguments of refusalCase.modeArgumentsList ?? [[], ['--dry-run']]) {
        const migration = await runMigration([...refusalCase.argumentsList, ...modeArguments], refusalCase.environment)
        assert.equal(migration.exitCode, 1)
        assert.match(migration.errors.join('\n'), refusalCase.message)
        assert.deepEqual(await buildManifest(temporaryDirectory), originalManifest)
      }
    }
  })
})

test('a destination path created by a concurrent writer during the copy is never overwritten', async () => {
  await withTemporaryDirectory('glissa-migrate-concurrent-', async (temporaryDirectory) => {
    const checkoutDirectory = await createCheckout(temporaryDirectory)
    const destinationDirectory = join(temporaryDirectory, 'destination')
    const commandDirectory = join(temporaryDirectory, 'commands')
    await mkdir(commandDirectory)
    await writeFile(join(commandDirectory, 'cp'), `#!/bin/sh\n[ -e "${destinationDirectory}/tasks.json" ] || echo concurrent > "${destinationDirectory}/tasks.json"\nexec /bin/cp "$@"\n`)
    await chmod(join(commandDirectory, 'cp'), 0o700)
    const migration = await runMigration(['--from', checkoutDirectory, '--to', destinationDirectory], { PATH: `${commandDirectory}:${process.env.PATH}` })
    assert.equal(migration.exitCode, 1)
    assert.match(migration.errors.join('\n'), /tasks\.json appeared during the migration; nothing was overwritten/)
    assert.equal(await readFile(join(destinationDirectory, 'tasks.json'), 'utf8'), 'concurrent\n')
  })
})

test('dry runs write nothing and installed defaults honor GLISSA_DATA_DIR then XDG_DATA_HOME', async () => {
  await withTemporaryDirectory('glissa-migrate-defaults-', async (temporaryDirectory) => {
    const checkoutDirectory = await createCheckout(temporaryDirectory)
    const installedDirectory = join(temporaryDirectory, 'installed')
    const dataHome = join(temporaryDirectory, 'data-home')
    const originalManifest = await buildManifest(temporaryDirectory)
    const dryRun = await runMigration(['--from', checkoutDirectory, '--dry-run'], { GLISSA_DATA_DIR: installedDirectory, XDG_DATA_HOME: dataHome })
    assert.equal(dryRun.exitCode, 0, dryRun.errors.join('\n'))
    assert.ok(dryRun.output.includes(`memory: would copy to ${join(installedDirectory, 'memory')}`))
    assert.deepEqual(await buildManifest(temporaryDirectory), originalManifest)
    const migration = await runMigration(['--from', checkoutDirectory], { GLISSA_DATA_DIR: '', XDG_DATA_HOME: dataHome })
    assert.equal(migration.exitCode, 0, migration.errors.join('\n'))
    assert.deepEqual(await readdir(join(dataHome, 'glissa')), ['context', 'memory', 'tasks.json'])
    assert.equal(await readFile(join(dataHome, 'glissa', 'tasks.json'), 'utf8'), '{"tasks":[]}\n')
  })
})
