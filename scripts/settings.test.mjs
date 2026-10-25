import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readJsonFileSync } from './json-file.mjs';
import { renderMcpServers } from './serve.mjs';

const settingsFilePath = fileURLToPath(new URL('../.claude/settings.json', import.meta.url));
const runtimeFilePath = fileURLToPath(new URL('../prompts/runtime.md', import.meta.url));
const pluginMcpFilePath = fileURLToPath(new URL('../.mcp.json', import.meta.url));
const glissaSettingsFilePath = fileURLToPath(new URL('../systemd/glissa-settings.json', import.meta.url));

test('the project and runtime settings allow reading the Telegram inbox', () => {
  const telegramInboxReadRule = 'Read(~/.claude/channels/telegram/inbox/**)';

  for (const filePath of [settingsFilePath, glissaSettingsFilePath]) {
    assert.ok(readJsonFileSync(filePath).permissions.allow.includes(telegramInboxReadRule));
  }
});

function keepRuntimeHooks(hooksByEvent) {
  const runtimeHooksByEvent = {};
  for (const [eventName, hookGroups] of Object.entries(hooksByEvent)) {
    const runtimeHookGroups = hookGroups
      .map((hookGroup) => ({ ...hookGroup, hooks: hookGroup.hooks.filter((hook) => hook.command.includes('$CLAUDE_PROJECT_DIR/hooks/')) }))
      .filter((hookGroup) => hookGroup.hooks.length > 0);
    if (runtimeHookGroups.length > 0) runtimeHooksByEvent[eventName] = runtimeHookGroups;
  }
  return runtimeHooksByEvent;
}

test('plugin hooks match the checkout runtime hooks after substituting the plugin root', () => {
  const projectHooks = keepRuntimeHooks(readJsonFileSync(settingsFilePath).hooks);
  const pluginHooksPath = fileURLToPath(new URL('../hooks/hooks.json', import.meta.url));
  const pluginHooks = readJsonFileSync(pluginHooksPath).hooks;

  assert.deepEqual(pluginHooks, JSON.parse(JSON.stringify(projectHooks).replaceAll('$CLAUDE_PROJECT_DIR', '${CLAUDE_PLUGIN_ROOT}')));
});

test('the delivery doctrine names both inbound image shapes', () => {
  const runtimeText = fs.readFileSync(runtimeFilePath, 'utf8');
  const deliveryDoctrine = runtimeText.split('## Delivery')[1];

  assert.match(deliveryDoctrine, /image_path/);
  assert.match(deliveryDoctrine, /attachment_file_id/);
  assert.match(deliveryDoctrine, /download_attachment/);
  assert.match(deliveryDoctrine, /\(photo\)/);
  assert.match(deliveryDoctrine, /attachment_mime/);
  assert.match(deliveryDoctrine, /attachment_name/);
});

test('the browser server comes only from the rendered launch config, never a plugin .mcp.json the guard cannot match', () => {
  const mcpServers = renderMcpServers({ accounts: [], modules: [] }, '/package');

  assert.equal(mcpServers.browser.command, '/package/scripts/browser-mcp.sh');
  assert.equal(fs.existsSync(pluginMcpFilePath), false);
});

test('the Buffer server launches through its key-file launcher only when the content module is on', () => {
  const runtimeSettings = readJsonFileSync(glissaSettingsFilePath);

  assert.equal(renderMcpServers({ accounts: [], modules: [] }, '/package').buffer, undefined);
  assert.equal(renderMcpServers({ accounts: [], modules: ['content'] }, '/package').buffer.command, '/package/scripts/buffer-mcp.sh');
  assert.ok(runtimeSettings.permissions.deny.includes('Bash(scripts/buffer-mcp.sh:*)'));
});

test('the live unit PATH reaches the npm globals the MCP launchers run', () => {
  const unitText = fs.readFileSync(fileURLToPath(new URL('../systemd/glissa.service', import.meta.url)), 'utf8');

  assert.match(unitText, /^Environment=PATH=.*%h\/\.npm-global\/bin/m);
});

test('the live unit keeps Claude Code auto memory off, so Glissa writes only its guarded memory directory', () => {
  const unitText = fs.readFileSync(fileURLToPath(new URL('../systemd/glissa.service', import.meta.url)), 'utf8');

  assert.match(unitText, /^Environment=CLAUDE_CODE_DISABLE_AUTO_MEMORY=1$/m);
});

test('both browser tool outcomes record the browse page origin the guard reads', () => {
  const projectSettings = readJsonFileSync(settingsFilePath);

  for (const hookEventName of ['PostToolUse', 'PostToolUseFailure']) {
    const originHook = projectSettings.hooks[hookEventName].find((entry) => entry.matcher === 'mcp__browser__.*');

    assert.match(originHook.hooks[0].command, /hooks\/browse-page-origin\.mjs/, hookEventName);
  }
});

test('saved Buffer drafts are recorded for the edit gate', () => {
  const projectSettings = readJsonFileSync(settingsFilePath);
  const draftRecordHook = projectSettings.hooks.PostToolUse.find((entry) => entry.matcher === 'mcp__buffer__(create_post|edit_post)');

  assert.match(draftRecordHook.hooks[0].command, /hooks\/record-buffer-draft\.mjs/);
});

test('the write policy names the browse allowlist and refuses buying', () => {
  const runtimeText = fs.readFileSync(runtimeFilePath, 'utf8');
  const writePolicy = runtimeText.split('## Write policy')[1].split('## Memory')[0];

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
  const projectDenyRules = readJsonFileSync(settingsFilePath).permissions.deny;
  for (const requiredDenyRule of [
    'mcp__posthog__*',
    'Bash(scripts/gog-mcp.sh:*)',
    'Bash(scripts/setup-mail-watch.sh:*)',
    'Bash(scripts/buffer-mcp.sh:*)',
    'Read(~/.config/glissa/**)',
  ]) {
    assert.ok(projectDenyRules.includes(requiredDenyRule), requiredDenyRule);
    assert.ok(glissaDenyRules.includes(requiredDenyRule), requiredDenyRule);
  }
});

test('the live session runs calendar wrapper calls and Buffer edits past the auto mode classifier, leaving their gates to the write guard', () => {
  const glissaAllowRules = readJsonFileSync(glissaSettingsFilePath).permissions.allow;

  assert.ok(glissaAllowRules.includes('Bash(scripts/gog-calendar.sh *)'));
  assert.ok(glissaAllowRules.includes('mcp__buffer__edit_post'));
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

test('drafts under the operator\'s name use Glissa\'s own draft-as-operator skill', () => {
  const draftAsOperatorSkillPath = fileURLToPath(new URL('../.claude/skills/draft-as-operator/SKILL.md', import.meta.url));

  assert.match(fs.readFileSync(draftAsOperatorSkillPath, 'utf8'), /^name: draft-as-operator$/m);
  assert.match(fs.readFileSync(runtimeFilePath, 'utf8'), /draft-as-operator/);
});
