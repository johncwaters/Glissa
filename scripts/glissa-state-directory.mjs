import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveGlissaStateDirectory(environment = process.env) {
  if (environment.GLISSA_STATE_DIR) return environment.GLISSA_STATE_DIR
  return join(environment.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'glissa')
}
