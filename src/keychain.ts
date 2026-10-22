// Wisply: Store Token in the Mac Keychain…
//
// Opens an integrated terminal that runs the bundled connector's `setup`
// (the editor's own Node: `process.execPath` with ELECTRON_RUN_AS_NODE=1).
// /usr/bin/security asks for the token in that terminal and stores it in the
// login keychain as "Wisply MCP token", so the token never passes through
// the extension. Other apps on this Mac use that item, and so does the
// connector Cursor starts (src/cursor.ts).
import type * as vscode from 'vscode';
import { notMac } from '../vendor/wisply-mcp/lib/messages.mjs';

export const SETUP_TERMINAL_NAME = 'Wisply setup';

export interface KeychainLaunch {
  readonly execPath: string;
  readonly serverPath: string;
  readonly port: number;
}

/** The terminal: the connector's `setup` for the configured port, nothing else. */
export function setupTerminalOptions({ execPath, serverPath, port }: KeychainLaunch): vscode.TerminalOptions {
  return {
    name: SETUP_TERMINAL_NAME,
    shellPath: execPath,
    shellArgs: [serverPath, 'setup', '--port', String(port)],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

type KeychainWindow = Pick<typeof vscode.window, 'createTerminal' | 'showWarningMessage'>;

/** Opens the setup terminal on macOS; elsewhere, says why there's nothing to set up. */
export function storeTokenInKeychain(window: KeychainWindow, launch: KeychainLaunch,
  platform: string = process.platform): vscode.Terminal | null {
  if (platform !== 'darwin') {
    void window.showWarningMessage(notMac(platform));
    return null;
  }
  const terminal = window.createTerminal(setupTerminalOptions(launch));
  terminal.show();
  return terminal;
}
