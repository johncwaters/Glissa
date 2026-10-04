import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

export function readOptionalText(filePath) {
  return readFile(filePath, 'utf8').catch(() => '')
}

export async function readOptionalLines(filePath) {
  return splitNonEmptyLines(await readOptionalText(filePath))
}

export async function readLoggedEvents(filePath) {
  return (await readOptionalLines(filePath)).map((line) => JSON.parse(line))
}

export function readJsonLinesSync(filePath) {
  return splitNonEmptyLines(readFileSync(filePath, 'utf8')).map((line) => JSON.parse(line))
}

function splitNonEmptyLines(text) {
  return text.split('\n').filter(Boolean)
}
