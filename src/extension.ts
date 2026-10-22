// Wisply for VS Code (and Open VSX editors): activation.
//
// - Where the editor has VS Code's MCP API (1.101+), the bundled connector is
//   registered as the MCP server "Wisply (this Mac)" (src/provider.ts).
// - Else, where Cursor's API exists, it is registered with Cursor, with no
//   token: it reads the Mac Keychain item (src/cursor.ts).
// - Else a one-time notice offers the token-free config to paste: the
//   bundled connector, like the other two, never an npm package.
//
// Commands: Set Token…, Forget Token, Check Connection, Store Token in the Mac
// Keychain…, Open Setup Guide. The token lives in SecretStorage
// (src/token.ts); the extension's own reads go through the read-only sidecar
// (src/sidecar.ts), so extension-host code never sends the token.
//
// Only activate() touches the real `vscode` module; activateExtension() takes
// it as an argument, so tests drive it with a fake.
import type * as vscode from 'vscode';
import { KEYCHAIN_LABEL, SERVER_KEY } from '../vendor/wisply-mcp/lib/constants.mjs';
import { getCursorMcp, registerWithCursor } from './cursor';
import type { CursorMcpApi } from './cursor';
import { storeTokenInKeychain } from './keychain';
import { getMcpApi } from './mcp-api';
import { PROVIDER_ID, createProvider, serverLaunch, stringEnv } from './provider';
import type { Launch, WisplyProvider } from './provider';
import { affectsWisply, readSettings, sameSettings } from './settings';
import { CHECK_ARGUMENTS, CHECK_TIMEOUT_MS, CHECK_TOOL, createSidecar, describeConnection } from './sidecar';
import type { ConnectionReport, SidecarDeps } from './sidecar';
import { createTokenStore, promptForToken, scopeTitle } from './token';
import type { UsableScope } from './token';

export const SERVER_FILE = 'server/wisply-mcp.mjs';
export const SETUP_GUIDE_URL = 'https://www.wisply.ai/docs/mcp/install#vscode';

export const COMMANDS = Object.freeze({
  setToken: 'wisply.setToken',
  forgetToken: 'wisply.forgetToken',
  checkConnection: 'wisply.checkConnection',
  storeTokenInKeychain: 'wisply.storeTokenInKeychain',
  openSetupGuide: 'wisply.openSetupGuide',
});

/** globalState keys for the one-time notices. */
export const STATE_KEYS = Object.freeze({
  welcomed: 'wisply.welcomeShown',
  manualNotice: 'wisply.manualSetupNoticeShown',
});

export const BUTTONS = Object.freeze({
  setToken: 'Set Token…',
  notNow: 'Not Now',
  copyConfig: 'Copy Config',
  openSetupGuide: 'Open Setup Guide',
  storeInKeychain: 'Store Token in the Mac Keychain…',
});

export const TEXT = Object.freeze({
  welcome: "Wisply can connect VS Code's AI chat to the Wisply app on this Mac. Set a token to start.",
  welcomeCursor: (app: string) => `Wisply added its connector to ${app}'s MCP servers. The connector uses the ` +
    'token saved in the Mac Keychain, so store the token there to start.',
  manual: "Add Wisply to this editor's MCP settings.",
  copied: "Copied Wisply's MCP entry. It runs the connector inside this extension and contains no token: run " +
    "Wisply: Store Token in the Mac Keychain… once, then paste the entry into this editor's MCP settings. The " +
    "extension's folder changes when it updates, so copy the entry again after an update.",
  saved: (scope: UsableScope) => `Saved the ${scopeTitle(scope).toLowerCase()} token in this editor's secret storage.`,
  keychainHint: "This editor's AI chat uses the token saved in the Mac Keychain, so store it there too.",
  forgotten: (mode: Mode) => "Removed the Wisply token from this editor's secret storage. " +
    (mode === 'provider'
      ? 'A Wisply MCP server that is already running keeps using it until it restarts: restart it from ' +
        'MCP: List Servers. '
      : '') +
    `A token saved in the Mac Keychain stays there: delete "${KEYCHAIN_LABEL}" in Keychain Access. To revoke the ` +
    'token everywhere, regenerate it in Wisply > Settings > Integrations > MCP Server.',
  nothingToForget: "No Wisply token is stored in this editor's secret storage.",
  checking: 'Checking Wisply…',
});

/**
 * The token-free entry that Copy Config puts on the clipboard: the connector
 * bundled in this extension, on the editor's own Node, as Cursor's API
 * starts it. Never an npm package: the extension needs no npx, and the
 * package name isn't Wisply's yet. WISPLY_MCP_TOKEN is left out, so the
 * entry doesn't invite a pasted token; the connector reads the Keychain,
 * with --read-only like every Keychain connector the extension sets up.
 */
export function manualConfig(launch: Launch): string {
  const { command, args, env } = serverLaunch(launch, 'keychain');
  const { WISPLY_MCP_TOKEN: _token, ...kept } = stringEnv(env);
  return `${JSON.stringify({ mcpServers: { [SERVER_KEY]: { command, args, env: kept } } }, null, 2)}\n`;
}

export type Mode = 'provider' | 'cursor' | 'manual';

export interface Activation extends vscode.Disposable {
  readonly mode: Mode;
}

export interface ActivationDeps {
  readonly execPath?: string;
  readonly platform?: string;
  readonly hostEnv?: SidecarDeps['hostEnv'];
  readonly spawn?: SidecarDeps['spawn'];
}

type VscodeModule = typeof vscode;

export function activateExtension(vs: VscodeModule, context: vscode.ExtensionContext, deps: ActivationDeps = {}): Activation {
  const execPath = deps.execPath ?? process.execPath;
  const platform = deps.platform ?? process.platform;
  const hostEnv = deps.hostEnv ?? process.env;
  const serverPath = context.asAbsolutePath(SERVER_FILE);
  const extVersion = String(context.extension?.packageJSON?.version ?? '0.0.0');
  const tokens = createTokenStore(context.secrets);
  const subscriptions: vscode.Disposable[] = [];
  let settings = readSettings(vs);
  const launch = (): Launch => ({ execPath, serverPath, port: settings.port, allowClaudeSetup: settings.allowClaudeSetup });

  const sidecar = createSidecar({
    execPath,
    serverPath,
    getPort: () => settings.port,
    getToken: async () => (await tokens.get())?.token ?? null,
    hostEnv,
    ...(deps.spawn ? { spawn: deps.spawn } : {}),
    clientVersion: extVersion,
  });
  subscriptions.push({ dispose: () => sidecar.dispose() });

  // --- MCP registration ---
  let mode: Mode = 'manual';
  let provider: WisplyProvider | null = null;
  let cursorMcp: CursorMcpApi | null = null;
  let cursorRegistration: vscode.Disposable | null = null;
  const api = getMcpApi(vs);
  if (api) {
    provider = createProvider(api, {
      platform,
      getLaunch: () => ({ ...launch(), extVersion }),
      getToken: () => tokens.get(),
      promptForToken: () => promptForToken(vs.window),
      storeToken: (token) => tokens.set(token),
      createEmitter: () => new vs.EventEmitter<void>(),
    });
    subscriptions.push(provider, api.registerMcpServerDefinitionProvider(PROVIDER_ID, provider.provider));
    mode = 'provider';
  } else {
    cursorMcp = getCursorMcp(vs);
    if (cursorMcp) {
      try {
        cursorRegistration = registerWithCursor(cursorMcp, launch());
        mode = 'cursor';
      } catch {
        cursorMcp = null;
      }
    }
  }

  // --- Commands ---
  const window = vs.window;
  const openSetupGuide = () => vs.env.openExternal(vs.Uri.parse(SETUP_GUIDE_URL));
  const keychainLaunch = () => ({ execPath, serverPath, port: settings.port, hostEnv });
  const storeInKeychain = () => storeTokenInKeychain(window, keychainLaunch(), platform);

  async function show({ report, stored }: Checked, prefix?: string) {
    const text = prefix ? `${prefix} ${report.text}` : report.text;
    if (report.kind === 'ok') {
      // Outside VS Code's MCP API the editor's own MCP server reads the
      // Keychain item, not the token checked here.
      if (mode !== 'provider' && stored && platform === 'darwin') {
        const choice = await window.showInformationMessage(`${text} ${TEXT.keychainHint}`, BUTTONS.storeInKeychain);
        if (choice === BUTTONS.storeInKeychain) storeInKeychain();
      } else {
        await window.showInformationMessage(text);
      }
      return;
    }
    if (report.kind === 'setup') {
      const choice = await window.showWarningMessage(text, BUTTONS.setToken, BUTTONS.openSetupGuide);
      if (choice === BUTTONS.setToken) await setToken();
      else if (choice === BUTTONS.openSetupGuide) await openSetupGuide();
      return;
    }
    const choice = await window.showErrorMessage(text, BUTTONS.openSetupGuide);
    if (choice === BUTTONS.openSetupGuide) await openSetupGuide();
  }

  interface Checked {
    readonly report: ConnectionReport;
    readonly stored: UsableScope | null;
  }

  async function check(): Promise<Checked> {
    const stored = (await tokens.get())?.scope ?? null;
    const ask = () => sidecar.call(CHECK_TOOL, { ...CHECK_ARGUMENTS }, CHECK_TIMEOUT_MS);
    const answer = typeof window.withProgress === 'function'
      ? await window.withProgress({ location: vs.ProgressLocation.Notification, title: TEXT.checking }, ask)
      : await ask();
    return {
      report: describeConnection(answer, { port: settings.port, stored, allowClaudeSetup: settings.allowClaudeSetup }),
      stored,
    };
  }

  async function checkConnection() {
    await show(await check());
  }

  async function setToken() {
    const entered = await promptForToken(window);
    if (!entered) return;
    await tokens.set(entered);
    // Check with the new token. The change event that follows finds the
    // sidecar already on it and leaves the check running.
    await sidecar.sync();
    await show(await check(), TEXT.saved(entered.scope));
  }

  async function forgetToken() {
    const had = await tokens.get();
    await tokens.forget();
    await window.showInformationMessage(had ? TEXT.forgotten(mode) : TEXT.nothingToForget);
  }

  const register = (id: string, run: () => unknown) => {
    subscriptions.push(vs.commands.registerCommand(id, run));
  };
  register(COMMANDS.setToken, setToken);
  register(COMMANDS.forgetToken, forgetToken);
  register(COMMANDS.checkConnection, checkConnection);
  register(COMMANDS.storeTokenInKeychain, storeInKeychain);
  register(COMMANDS.openSetupGuide, openSetupGuide);

  // --- Changes ---
  // Every token change (here or in another window) gives the definition a
  // new version, so the editor offers to restart a running server, which
  // still has the old token in its environment.
  subscriptions.push(tokens.onDidChange(() => {
    void sidecar.sync();
    void provider?.tokenChanged();
  }));
  subscriptions.push(vs.workspace.onDidChangeConfiguration((event) => {
    if (!affectsWisply(event)) return;
    const next = readSettings(vs);
    if (sameSettings(next, settings)) return;
    settings = next;
    void sidecar.sync();
    provider?.refresh();
    if (cursorMcp && cursorRegistration) {
      cursorRegistration.dispose();
      try {
        cursorRegistration = registerWithCursor(cursorMcp, launch());
      } catch {
        cursorRegistration = null;
      }
    }
  }));

  // --- One-time notices (macOS only: elsewhere there's no Wisply to connect to) ---
  async function notices() {
    if (platform !== 'darwin') return;
    const state = context.globalState;
    if (mode === 'manual') {
      if (state.get(STATE_KEYS.manualNotice) === true) return;
      await state.update(STATE_KEYS.manualNotice, true);
      const choice = await window.showInformationMessage(TEXT.manual, BUTTONS.copyConfig, BUTTONS.openSetupGuide);
      if (choice === BUTTONS.copyConfig) {
        await vs.env.clipboard.writeText(manualConfig(launch()));
        await window.showInformationMessage(TEXT.copied);
      } else if (choice === BUTTONS.openSetupGuide) {
        await openSetupGuide();
      }
      return;
    }
    if (state.get(STATE_KEYS.welcomed) === true || (await tokens.get())) return;
    await state.update(STATE_KEYS.welcomed, true);
    if (mode === 'provider') {
      const choice = await window.showInformationMessage(TEXT.welcome, BUTTONS.setToken, BUTTONS.notNow);
      if (choice === BUTTONS.setToken) await setToken();
    } else {
      const choice = await window.showInformationMessage(TEXT.welcomeCursor(vs.env.appName || 'Cursor'),
        BUTTONS.storeInKeychain, BUTTONS.notNow);
      if (choice === BUTTONS.storeInKeychain) storeInKeychain();
    }
  }
  const noticesDone = notices().catch(() => { /* a notice never breaks activation */ });

  let disposed = false;
  return {
    mode,
    /** Settles when the one-time notices are done (for tests). */
    noticesDone,
    dispose() {
      if (disposed) return;
      disposed = true;
      cursorRegistration?.dispose();
      for (const subscription of subscriptions.reverse()) {
        try { subscription.dispose(); } catch { /* keep disposing the rest */ }
      }
    },
  } as Activation & { readonly noticesDone: Promise<void> };
}

let current: Activation | null = null;

export function activate(context: vscode.ExtensionContext): void {
  // The only place the real module is loaded (see the header).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vs = require('vscode') as VscodeModule;
  current = activateExtension(vs, context);
  context.subscriptions.push(current);
}

export function deactivate(): void {
  current?.dispose();
  current = null;
}
