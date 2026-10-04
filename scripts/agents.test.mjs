import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { readFrontmatter } from './frontmatter.mjs'

const inboundTriageAgentPath = new URL('../.claude/agents/inbound-triage.md', import.meta.url)
const researchLaneAgentPath = new URL('../.claude/agents/research-lane.md', import.meta.url)

test('inbound triage agent pins its model, read-only tools, and output contract', async () => {
  const agentText = await readFile(inboundTriageAgentPath, 'utf8')
  const { fields, bodyText } = readFrontmatter(agentText)

  assert.equal(fields.model, 'sonnet')
  assert.equal(fields.omitClaudeMd, 'true')
  assert.equal(fields.tools, 'Read')
  assert.match(bodyText, /^TRIAGE:$/m)
  assert.match(bodyText, /^kind: [^\n]*\bresolves\b[^\n]*$/m)
})

test('research lane agent pins its model and reaches no tool beyond reading the web', async () => {
  const agentText = await readFile(researchLaneAgentPath, 'utf8')
  const { fields, bodyText } = readFrontmatter(agentText)

  assert.equal(fields.model, 'opus')
  assert.equal(fields.omitClaudeMd, 'true')
  const laneToolNames = fields.tools.split(',').map((toolName) => toolName.trim())
  assert.deepEqual(laneToolNames, ['WebSearch', 'WebFetch'])
  assert.ok(laneToolNames.every((toolName) => !toolName.startsWith('mcp__')))
  assert.match(bodyText, /read: full\|summary\|blocked/)
})

test('inbound triage agent requires an until date, redaction, and a reply for unreadable media', async () => {
  const agentText = await readFile(inboundTriageAgentPath, 'utf8')
  const { bodyText } = readFrontmatter(agentText)

  assert.match(bodyText, /Whenever `digest` is not `none`[^.]*`until` is required and never `none`/)
  assert.match(bodyText, /Neither `digest` nor `profile_fields` ever carries a credential[^.]*`redacted`/)
  assert.match(bodyText, /`kind: needs-resend`[\s\S]*?`kind: media-unreadable`[^.]*`response: reply` even at `tier: none`/)
})

test('inbound triage agent requires a digest for every tier other than none', async () => {
  const agentText = await readFile(inboundTriageAgentPath, 'utf8')
  const { bodyText } = readFrontmatter(agentText)

  assert.match(bodyText, /Every tier other than `none` requires a `digest`/)
  assert.match(bodyText, /^digest: <[^>]*required for every tier other than none[^>]*>$/m)
  assert.match(bodyText, /`tier: task`[^.]*set `deadline` and still provide `digest` and `until`/)
  assert.match(bodyText, /`tier: profile-fact`[^.]*carries `digest` and `until`/)
})
