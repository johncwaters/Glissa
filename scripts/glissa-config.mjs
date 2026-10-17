import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { addUsageExitCode, isMainModule, runCommandLine } from './command-line.mjs'
import { isPlainObject } from './object-fields.mjs'
import { isValidTimeZone } from './operator-time-zone.mjs'

export const knownModuleNames = ['content', 'changelog', 'digest']

const accountAliasPattern = /^[a-z0-9][a-z0-9-]*$/
const emailAddressPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function resolveGlissaConfigDirectory(environment = process.env) {
  if (environment.GLISSA_CONFIG_DIR) return environment.GLISSA_CONFIG_DIR
  return join(environment.XDG_CONFIG_HOME || join(homedir(), '.config'), 'glissa')
}

export function resolveGlissaConfigFilePath(environment = process.env) {
  return join(resolveGlissaConfigDirectory(environment), 'config.json')
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function findOperatorProblems(operator) {
  if (!isPlainObject(operator)) return ['operator must be an object']
  const problems = []
  if (!isNonEmptyString(operator.name)) problems.push('operator.name must be a non-empty string')
  if (!isNonEmptyString(operator.pronouns)) problems.push('operator.pronouns must be a non-empty string')
  if (operator.formOfAddress !== undefined && !isNonEmptyString(operator.formOfAddress)) problems.push('operator.formOfAddress must be a non-empty string when set')
  return problems
}

function findAccountProblems(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) return ['accounts must be a non-empty array']
  const problems = []
  const seenAliases = new Set()
  accounts.forEach((account, accountIndex) => {
    const fieldPrefix = `accounts[${accountIndex}]`
    if (!isPlainObject(account)) {
      problems.push(`${fieldPrefix} must be an object`)
      return
    }
    if (typeof account.alias !== 'string' || !accountAliasPattern.test(account.alias)) problems.push(`${fieldPrefix}.alias must be lowercase letters, digits, and hyphens`)
    if (seenAliases.has(account.alias)) problems.push(`${fieldPrefix}.alias repeats ${account.alias}`)
    seenAliases.add(account.alias)
    if (typeof account.email !== 'string' || !emailAddressPattern.test(account.email)) problems.push(`${fieldPrefix}.email must be an email address`)
  })
  return problems
}

function findModuleProblems(modules) {
  if (modules === undefined) return []
  if (!Array.isArray(modules)) return ['modules must be an array']
  return modules
    .filter((moduleName) => !knownModuleNames.includes(moduleName))
    .map((moduleName) => `modules names unknown module ${JSON.stringify(moduleName)}; known: ${knownModuleNames.join(', ')}`)
}

function findHomeTimeZoneProblems(homeTimeZone) {
  if (homeTimeZone === undefined) return []
  if (isValidTimeZone(homeTimeZone)) return []
  return [`homeTimeZone ${JSON.stringify(homeTimeZone)} is not a valid IANA zone`]
}

export function findConfigProblems(config) {
  if (!isPlainObject(config)) return ['config must be a JSON object']
  return [
    ...findOperatorProblems(config.operator),
    ...findAccountProblems(config.accounts),
    ...findModuleProblems(config.modules),
    ...findHomeTimeZoneProblems(config.homeTimeZone),
  ]
}

function readConfigText(configFilePath) {
  try {
    return readFileSync(configFilePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`No Glissa config at ${configFilePath}; run glissa init`)
    throw new Error(`Glissa config at ${configFilePath} could not be read: ${error?.code ?? error?.message}`)
  }
}

function parseConfigText(configText, configFilePath) {
  try {
    return JSON.parse(configText)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Glissa config at ${configFilePath} is not valid JSON`)
    throw error
  }
}

export function readGlissaConfig(configFilePath = resolveGlissaConfigFilePath()) {
  const config = parseConfigText(readConfigText(configFilePath), configFilePath)
  const configProblems = findConfigProblems(config)
  if (configProblems.length > 0) throw new Error(`Glissa config at ${configFilePath} is invalid: ${configProblems.join('; ')}`)
  return { ...config, modules: config.modules ?? [] }
}

export function isModuleEnabled(config, moduleName) {
  return config.modules.includes(moduleName)
}

async function runConfigCommand(commandArguments, { writeOutput = console.log, writeError = console.error } = {}) {
  const [commandName, configFilePath, ...extraArguments] = commandArguments
  if (commandName !== 'check' || extraArguments.length > 0) {
    writeError('usage: glissa-config.mjs check [config.json]')
    return addUsageExitCode
  }
  readGlissaConfig(configFilePath ?? resolveGlissaConfigFilePath())
  writeOutput('config ok')
  return 0
}

if (isMainModule(import.meta.url)) runCommandLine(runConfigCommand)
