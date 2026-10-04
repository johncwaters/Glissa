import { readHookPayload } from './hook-payload.mjs'
import { appendChatRecords, formatRecall, parseTelegramChannelBlocks, readChatRecords } from '../scripts/chat-log.mjs'

const telegramToolKindByName = {
  mcp__plugin_telegram_telegram__reply: 'reply',
  mcp__plugin_telegram_telegram__edit_message: 'edit',
  mcp__plugin_telegram_telegram__react: 'react',
}

function toolResponseIsError(toolResponse) {
  return Boolean(toolResponse && typeof toolResponse === 'object' && (toolResponse.isError === true || toolResponse.is_error === true))
}

function addPresentField(record, toolInput, fieldName) {
  if (Object.hasOwn(toolInput, fieldName)) record[fieldName] = toolInput[fieldName]
}

function createOutboundRecord(payload) {
  if (toolResponseIsError(payload.tool_response)) return null
  const outboundMessageKind = telegramToolKindByName[payload.tool_name]
  if (!outboundMessageKind) return null
  const toolInput = payload.tool_input || {}
  const outboundRecord = { direction: 'out', kind: outboundMessageKind, ts: new Date().toISOString() }
  addPresentField(outboundRecord, toolInput, 'chat_id')
  addPresentField(outboundRecord, toolInput, 'message_id')
  addPresentField(outboundRecord, toolInput, 'reply_to')
  addPresentField(outboundRecord, toolInput, 'text')
  addPresentField(outboundRecord, toolInput, 'emoji')
  return outboundRecord
}

function recordUserPrompt(payload) {
  const inboundChatRecords = parseTelegramChannelBlocks(payload.prompt || '')
  appendChatRecords(inboundChatRecords)
}

function recordToolUse(payload) {
  const outboundChatRecord = createOutboundRecord(payload)
  if (!outboundChatRecord) return
  appendChatRecords([outboundChatRecord])
}

function provideRecentChat() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const recentChatRecords = readChatRecords({ since, limit: 40 })
  if (recentChatRecords.length === 0) return
  const additionalContext = formatRecall(recentChatRecords, { maxBytes: 12288 })
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })}\n`)
}

function dispatchHook(payload) {
  const handlersByEventName = {
    UserPromptSubmit: recordUserPrompt,
    PostToolUse: recordToolUse,
    SessionStart: provideRecentChat,
  }
  const handler = handlersByEventName[payload.hook_event_name]
  if (!handler) return
  handler(payload)
}

async function run() {
  try {
    dispatchHook(await readHookPayload())
  } catch (error) {
    const firstErrorLine = String(error?.message || error).split('\n')[0]
    process.stderr.write(`chat-log: ${firstErrorLine}\n`)
  }
}

await run()
