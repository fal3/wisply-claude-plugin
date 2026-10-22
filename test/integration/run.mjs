#!/usr/bin/env node
// npm run test:integration: the smoke test in a real VS Code.
//
// Runs test/integration/suite.cjs inside an Extension Development Host with
// @vscode/test-electron. It needs a desktop and a VS Code download from
// update.code.visualstudio.com (into .vscode-test/, which git ignores), so it
// is for a Mac (QA V1-V9) or the repository's public CI, never the agent
// container, and `npm run check` doesn't run it.
//
//   npm run test:integration                       latest stable VS Code
//   VSCODE_VERSION=1.101.0 npm run test:integration   a given version
//   VSCODE_PATH=/Applications/Visual\ Studio\ Code.app/Contents/MacOS/Code npm run test:integration
//
// Off macOS it stops unless WISPLY_INTEGRATION_ANY_OS=1 (Linux CI under xvfb).
//
// The host runs with a fresh profile: no other extensions, and user settings
// that turn the status item off, point the extension at an unused port and
// keep VS Code from starting MCP servers on its own. So the smoke test never
// talks to a Wisply running on this Mac and never reads the Keychain item.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SUITE = join(ROOT, 'test/integration/suite.cjs');
export const MAC_ONLY =
  'The Wisply integration test runs on macOS (QA V1-V9). Set WISPLY_INTEGRATION_ANY_OS=1 to run it elsewhere, ' +
  'for example in CI under xvfb.\n';

/** A port nothing listens on: bound, read, released. */
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve) => { server.close(resolve); });
  return port;
}

/** The profile's user settings. */
export function userSettings(port) {
  return {
    'wisply.statusBar.enabled': false,
    'wisply.port': port,
    'chat.mcp.autostart': 'never',
    'security.workspace.trust.enabled': false,
    'update.mode': 'none',
    'telemetry.telemetryLevel': 'off',
  };
}

async function main() {
  if (process.platform !== 'darwin' && process.env.WISPLY_INTEGRATION_ANY_OS !== '1') {
    process.stderr.write(MAC_ONLY);
    process.exitCode = 2;
    return;
  }
  const [{ runTests }, esbuild, { extensionOptions }] = await Promise.all([
    import('@vscode/test-electron'), import('esbuild'), import('../../esbuild.mjs'),
  ]);
  await esbuild.build(extensionOptions());

  const profile = mkdtempSync(join(tmpdir(), 'wisply-vscode-it-'));
  try {
    const userDataDir = join(profile, 'user-data');
    const extensionsDir = join(profile, 'extensions');
    mkdirSync(join(userDataDir, 'User'), { recursive: true });
    mkdirSync(extensionsDir, { recursive: true });
    const port = await unusedPort();
    writeFileSync(join(userDataDir, 'User', 'settings.json'), `${JSON.stringify(userSettings(port), null, 2)}\n`);
    await runTests({
      ...(process.env.VSCODE_PATH ? { vscodeExecutablePath: process.env.VSCODE_PATH } : { version: process.env.VSCODE_VERSION ?? 'stable' }),
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: SUITE,
      extensionTestsEnv: { WISPLY_INTEGRATION_PORT: String(port) },
      launchArgs: ['--disable-extensions', `--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`, '--skip-welcome',
        '--skip-release-notes'],
    });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
