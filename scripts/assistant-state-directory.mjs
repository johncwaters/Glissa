import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveAssistantStateDirectory(environment = process.env) {
  if (environment.ASSISTANT_STATE_DIR) return environment.ASSISTANT_STATE_DIR
  return join(environment.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'assistant')
}
