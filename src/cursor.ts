// Cursor's own MCP extension API, for editors without VS Code's.
//
// Cursor (and forks on a VS Code base older than 1.101) lack
// vscode.lm.registerMcpServerDefinitionProvider. Cursor offers
// `vscode.cursor.mcp.registerServer(config)` and `unregisterServer(name)`
// instead (cursor.com/docs/context/mcp-extension-api): a stdio config is
// `{name, server: {command, args, env}}`.
//
// That API has no step that runs when the server starts, so a token given to
// it would sit in Cursor's server list. The extension passes none: the
// bundled connector reads the token saved in the Mac Keychain
// (Wisply: Store Token in the Mac Keychain…). The extension registers it
// without asking and never learns that token's scope, so the connector runs
// with --read-only: Cursor's agent (auto-run included) gets only the
// read-only memo tools, even if another app's `setup --full-access` left a
// full-access token in the Keychain. The variables the connector must not
// inherit are passed empty (stringEnv), which it treats as unset: the API
// takes strings only.
import type * as vscode from 'vscode';
import { serverLaunch, stringEnv } from './provider';
import type { Launch } from './provider';

export const CURSOR_SERVER_NAME = 'wisply';

export interface CursorStdioServerConfig {
  readonly name: string;
  readonly server: {
    readonly command: string;
    readonly args: string[];
    readonly env: Record<string, string>;
  };
}

export interface CursorMcpApi {
  registerServer(config: CursorStdioServerConfig): void;
  unregisterServer?(serverName: string): void;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

/** `vscode.cursor.mcp` when it has registerServer, else null. */
export function getCursorMcp(vscodeModule: unknown): CursorMcpApi | null {
  if (!isObject(vscodeModule) || !isObject(vscodeModule.cursor)) return null;
  const mcp = vscodeModule.cursor.mcp;
  if (!isObject(mcp) || typeof mcp.registerServer !== 'function') return null;
  return mcp as unknown as CursorMcpApi;
}

/** The config given to Cursor: the bundled connector, no token, read-only (the Keychain item's token). */
export function cursorServerConfig(launch: Launch): CursorStdioServerConfig {
  const { command, args, env } = serverLaunch(launch, 'keychain');
  return { name: CURSOR_SERVER_NAME, server: { command, args, env: stringEnv(env) } };
}

/**
 * Registers the bundled connector with Cursor. The returned disposable
 * unregisters it; after a settings change the extension disposes the old
 * registration and registers again.
 */
export function registerWithCursor(mcp: CursorMcpApi, launch: Launch): vscode.Disposable {
  mcp.registerServer(cursorServerConfig(launch));
  let registered = true;
  return {
    dispose() {
      if (!registered) return;
      registered = false;
      try { mcp.unregisterServer?.(CURSOR_SERVER_NAME); } catch { /* already gone */ }
    },
  };
}
