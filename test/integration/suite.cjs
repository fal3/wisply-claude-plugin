// The integration smoke test, run inside the Extension Development Host by
// test/integration/run.mjs (the host require()s this file and awaits run()).
// It checks what unit tests can't: the real editor loads the package,
// activates it, registers every command and the MCP provider, and reads the
// settings the manifest declares. Mac QA V1-V9 covers the rest by hand.
//
// No mocha: a dozen lines of runner, so the test needs nothing beyond
// @vscode/test-electron.
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'wisply.wisply';
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function extension() {
  const found = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(found, `${EXTENSION_ID} is installed in the host`);
  return found;
}

test('the extension activates', async () => {
  const wisply = extension();
  await wisply.activate();
  assert.equal(wisply.isActive, true);
  assert.equal(wisply.extensionKind, vscode.ExtensionKind.UI);
});

test('every contributed command is registered, the status menu included', async () => {
  const registered = new Set(await vscode.commands.getCommands(true));
  const contributed = extension().packageJSON.contributes.commands.map((command) => command.command);
  assert.ok(contributed.includes('wisply.insertQuote'));
  assert.ok(contributed.includes('wisply.statusMenu'));
  for (const command of contributed) assert.ok(registered.has(command), command);
});

test('the MCP server provider is registered where VS Code has the API', () => {
  const { activeMode } = require(join(extension().extensionPath, 'dist', 'extension.js'));
  const hasApi = typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function' &&
    typeof vscode.McpStdioServerDefinition === 'function';
  assert.notEqual(activeMode(), null, 'activeMode() is null: the host loaded dist/extension.js apart from this require()');
  assert.equal(activeMode(), hasApi ? 'provider' : 'manual');
});

test('the packaged skill and the bundled connector are in the extension folder', () => {
  const root = extension().extensionPath;
  assert.deepEqual(extension().packageJSON.contributes.chatSkills, [{ path: './skills/wisply-memos/SKILL.md' }]);
  assert.ok(existsSync(join(root, 'skills', 'wisply-memos', 'SKILL.md')));
  assert.ok(existsSync(join(root, 'server', 'wisply-mcp.mjs')));
});

test('the settings come from the profile\'s user settings, and the editor sees them as application settings', () => {
  const properties = extension().packageJSON.contributes.configuration.properties;
  for (const [id, property] of Object.entries(properties)) assert.equal(property.scope, 'application', id);
  assert.equal(properties['wisply.port'].ignoreSync, true);
  assert.equal(properties['wisply.mcp.allowClaudeSetup'].ignoreSync, true);
  const config = vscode.workspace.getConfiguration('wisply');
  assert.equal(config.inspect('statusBar.enabled').defaultValue, true);
  assert.equal(config.inspect('statusBar.enabled').globalValue, false);
  assert.equal(config.inspect('port').globalValue, Number(process.env.WISPLY_INTEGRATION_PORT));
  assert.equal(config.inspect('quote.words').defaultValue, 80);
  assert.equal(config.inspect('quote.format').defaultValue, 'markdown');
});

test('Insert Transcript Quote without an open editor only says so', async () => {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('wisply.insertQuote');
});

async function run() {
  const failures = [];
  for (const [index, { name, fn }] of tests.entries()) {
    try {
      await fn();
      console.log(`ok ${index + 1} - ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`not ok ${index + 1} - ${name}\n${error?.stack ?? error}`);
    }
  }
  console.log(`1..${tests.length}`);
  if (failures.length > 0) throw new Error(`${failures.length} integration test(s) failed: ${failures.join('; ')}`);
}

module.exports = { run, tests };
