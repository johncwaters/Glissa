import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const showcaseDirectory = dirname(fileURLToPath(import.meta.url))
const browserRoot = join(homedir(), '.cache/ms-playwright')

const mockScreens = [
  { name: 'telegram-brief', width: 760, height: 960 },
  { name: 'injection-denied', width: 1280, height: 720 },
  { name: 'guard-tests', width: 1280, height: 640 },
  { name: 'architecture', width: 1280, height: 520 },
]

const installHint = 'run: npx playwright install chromium'

function findHeadlessBrowser() {
  if (!existsSync(browserRoot)) throw new Error(`no ${browserRoot}; ${installHint}`)
  const shellDirectory = readdirSync(browserRoot).find((entry) => entry.startsWith('chromium_headless_shell-'))
  if (!shellDirectory) throw new Error(`no chromium_headless_shell under ${browserRoot}; ${installHint}`)
  const shellPath = join(browserRoot, shellDirectory)
  const platformDirectory = readdirSync(shellPath).find((entry) => entry.startsWith('chrome-headless-shell-linux'))
  if (!platformDirectory) throw new Error(`no chrome-headless-shell-linux build under ${shellPath}; ${installHint}`)
  return join(shellPath, platformDirectory, 'chrome-headless-shell')
}

const browserPath = findHeadlessBrowser()
for (const { name, width, height } of mockScreens) {
  execFileSync(browserPath, [
    '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=2',
    `--window-size=${width},${height}`,
    `--screenshot=${join(showcaseDirectory, 'img', `${name}.png`)}`,
    pathToFileURL(join(showcaseDirectory, 'mocks', `${name}.html`)).href,
  ], { stdio: 'ignore' })
  console.log(`rendered img/${name}.png`)
}
