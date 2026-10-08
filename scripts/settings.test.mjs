import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readJsonFileSync } from './json-file.mjs';

const settingsFilePath = fileURLToPath(new URL('../.claude/settings.json', import.meta.url));
const agentsFilePath = fileURLToPath(new URL('../AGENTS.md', import.meta.url));
const mcpFilePath = fileURLToPath(new URL('../.mcp.json', import.meta.url));
const glissaSettingsFilePath = fileURLToPath(new URL('../systemd/glissa-settings.json', import.meta.url));

test('the project settings allow reading the Telegram inbox', () => {
  const projectSettings = readJsonFileSync(settingsFilePath);
  const telegramInboxReadRule = 'Read(~/.claude/channels/telegram/inbox/**)';

  assert.ok(projectSettings.permissions.allow.includes(telegramInboxReadRule));
});

test('the delivery doctrine names both inbound image shapes', () => {
  const agentsText = fs.readFileSync(agentsFilePath, 'utf8');
  const deliveryDoctrine = agentsText.split('## Delivery')[1];

  assert.match(deliveryDoctrine, /image_path/);
  assert.match(deliveryDoctrine, /attachment_file_id/);
  assert.match(deliveryDoctrine, /download_attachment/);
  assert.match(deliveryDoctrine, /\(photo\)/);
  assert.match(deliveryDoctrine, /attachment_mime/);
  assert.match(deliveryDoctrine, /attachment_name/);
});

test('the browser server is enabled and defined', () => {
  const projectSettings = readJsonFileSync(settingsFilePath);
  const mcpServers = readJsonFileSync(mcpFilePath).mcpServers;

  assert.ok(projectSettings.enabledMcpjsonServers.includes('browser'));
  assert.equal(mcpServers.browser.command, 'scripts/browser-mcp.sh');
});

test('the Buffer server is enabled through its key-file launcher, which the session cannot run itself', () => {
  const projectSettings = readJsonFileSync(settingsFilePath);
  const mcpServers = readJsonFileSync(mcpFilePath).mcpServers;

  assert.ok(projectSettings.enabledMcpjsonServers.includes('buffer'));
  assert.equal(mcpServers.buffer.command, 'scripts/buffer-mcp.sh');
  assert.ok(projectSettings.permissions.deny.includes('Bash(scripts/buffer-mcp.sh:*)'));
});

test('the live unit PATH reaches the npm globals the MCP launchers run', () => {
  const unitText = fs.readFileSync(fileURLToPath(new URL('../systemd/glissa.service', import.meta.url)), 'utf8');

  assert.match(unitText, /^Environment=PATH=.*%h\/\.npm-global\/bin/m);
});

test('both browser tool outcomes record the browse page origin the guard reads', () => {
  const projectSettings = readJsonFileSync(settingsFilePath);

  for (const hookEventName of ['PostToolUse', 'PostToolUseFailure']) {
    const originHook = projectSettings.hooks[hookEventName].find((entry) => entry.matcher === 'mcp__browser__.*');

    assert.match(originHook.hooks[0].command, /hooks\/browse-page-origin\.mjs/, hookEventName);
  }
});

test('the write policy names the browse allowlist and refuses buying', () => {
  const agentsText = fs.readFileSync(agentsFilePath, 'utf8');
  const writePolicy = agentsText.split('## Write policy')[1].split('## Memory')[0];

  assert.match(writePolicy, /browse-domains\.json/);
  assert.match(writePolicy, /buys nothing/);
});

test('the live session keeps auto permission mode without user settings', () => {
  const glissaSettings = readJsonFileSync(glissaSettingsFilePath);

  assert.equal(glissaSettings.permissions.defaultMode, 'auto');
  assert.equal(glissaSettings.enabledPlugins['telegram@claude-plugins-official'], true);
});

test('the live session keeps the credential, force-push, and mail-send denies without user settings', () => {
  const glissaDenyRules = readJsonFileSync(glissaSettingsFilePath).permissions.deny;

  for (const requiredDenyRule of [
    'Read(~/.ssh/**)',
    'Read(~/.claude/.credentials.json)',
    'Bash(gh auth token*)',
    'Bash(git *push* --force *)',
    'mcp__claude_ai_Gmail__send_message',
  ]) {
    assert.ok(glissaDenyRules.includes(requiredDenyRule), requiredDenyRule);
  }
});

test('the live session runs calendar wrapper calls past the auto mode classifier, leaving guest and delete rules to the write guard', () => {
  const glissaAllowRules = readJsonFileSync(glissaSettingsFilePath).permissions.allow;

  assert.ok(glissaAllowRules.includes('Bash(scripts/gog-calendar.sh *)'));
});

test('the live session runs its task ledger past the auto mode classifier', () => {
  const glissaAllowRules = readJsonFileSync(glissaSettingsFilePath).permissions.allow;

  assert.ok(glissaAllowRules.includes('Bash(node scripts/tasks.mjs *)'));
  assert.ok(glissaAllowRules.includes('Bash(node scripts/content.mjs *)'));
  for (const fileReadingScriptName of ['reply-format.mjs', 'serve-results.mjs']) {
    assert.ok(
      !glissaAllowRules.some((allowRule) => allowRule.includes(fileReadingScriptName)),
      fileReadingScriptName,
    );
  }
});

test('the live session judging untrusted mail keeps high effort and thinking without user settings', () => {
  const glissaSettings = readJsonFileSync(glissaSettingsFilePath);

  assert.equal(glissaSettings.effortLevel, 'high');
  assert.equal(glissaSettings.alwaysThinkingEnabled, true);
});

test('drafts under John\'s name use Glissa\'s own draft-as-john skill', () => {
  const draftAsJohnSkillPath = fileURLToPath(new URL('../.claude/skills/draft-as-john/SKILL.md', import.meta.url));

  assert.match(fs.readFileSync(draftAsJohnSkillPath, 'utf8'), /^name: draft-as-john$/m);
  assert.match(fs.readFileSync(agentsFilePath, 'utf8'), /draft-as-john/);
});
