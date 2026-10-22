// Wisply: Store Token in the Mac Keychain…
//
// Opens an integrated terminal that runs the bundled connector's `setup`
// (the editor's own Node: `process.execPath` with ELECTRON_RUN_AS_NODE=1).
// /usr/bin/security asks for the token in that terminal and stores it in the
// login keychain as "Wisply MCP token", so the token never passes through
// the extension. Other apps on this Mac use that item, and so does the
// connector Cursor starts (src/cursor.ts).
//
// The terminal gets a complete environment of its own (strictEnv): nothing
// from the window, terminal.integrated.env.* or another extension's
// environment collection, so nothing such as NODE_OPTIONS=--require (which
// debuggers' auto-attach sets in terminals) can load code into the process
// that handles the token. Only the variables below reach it.
import type * as vscode from 'vscode';
import { notMac } from './editor-messages.mjs';

export const SETUP_TERMINAL_NAME = 'Wisply setup';
/** The system folders only: setup runs /usr/bin/security by its full path and needs nothing else. */
export const SETUP_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/** What setup takes from the editor's environment: who the user is, the home folder and the locale. */
export const SETUP_PASSED_ENV = Object.freeze(['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const);

export interface KeychainLaunch {
  readonly execPath: string;
  readonly serverPath: string;
  readonly port: number;
  /** Where the passed variables come from (process.env). */
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
}

/** The setup terminal's whole environment. */
export function setupTerminalEnv(hostEnv: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1', PATH: SETUP_PATH, TERM: 'xterm-256color' };
  for (const name of SETUP_PASSED_ENV) {
    const value = hostEnv[name];
    if (typeof value === 'string' && value !== '') env[name] = value;
  }
  return env;
}

/** The terminal: the connector's `setup` for the configured port, nothing else. */
export function setupTerminalOptions({ execPath, serverPath, port, hostEnv }: KeychainLaunch): vscode.TerminalOptions {
  return {
    name: SETUP_TERMINAL_NAME,
    shellPath: execPath,
    shellArgs: [serverPath, 'setup', '--port', String(port)],
    env: setupTerminalEnv(hostEnv),
    strictEnv: true,
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
