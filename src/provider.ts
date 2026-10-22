// The MCP server definition the extension gives the editor: "Wisply (this Mac)".
//
// The editor starts the bundled connector (server/wisply-mcp.mjs) on its own
// Node: `process.execPath` with ELECTRON_RUN_AS_NODE=1. No npx and no network
// at startup. The connector checks Wisply's identity before it uses the token,
// talks only to 127.0.0.1, and answers tools/list from its contract.
//
// The definitions provideMcpServerDefinitions returns never hold the token:
// the editor calls it eagerly and may keep or show what it gets.
// resolveMcpServerDefinition, which runs only when the server starts, returns
// a copy with WISPLY_MCP_TOKEN from SecretStorage. With no token stored it
// asks once per window session (on macOS only: elsewhere there is no Wisply
// to connect to); if the user cancels, the server starts anyway and uses the
// token saved in the Mac Keychain, if there is one.
//
// A token from the Mac Keychain only ever gets the read-only memo tools
// (--read-only), here and in Cursor's registration and the pasted entry: the
// extension never confirmed it, and another app's `setup --full-access` may
// have put a full-access token there. Recording control, follow-ups and
// setup_claude need a token set with Wisply: Set Token, which asks the user
// to confirm a full-access token.
//
// The editor starts the server with the extension host's environment plus
// the definition's env, so the definition pins every variable the connector
// reads: an exported WISPLY_MCP_ALLOW_CLAUDE_SETUP, WISPLY_MCP_TOKEN,
// WISPLY_MCP_DEBUG or NODE_OPTIONS in the user's shell never reaches it.
// Only the user settings, SecretStorage and the Keychain item decide.
import type * as vscode from 'vscode';
import type { McpApi, McpServerDefinitionProvider, McpStdioServerDefinition } from './mcp-api';
import type { StoredToken, UsableScope } from './token';

export const PROVIDER_ID = 'wisply.local';
export const SERVER_LABEL = 'Wisply (this Mac)';
export const ALLOW_CLAUDE_SETUP_FLAG = '--allow-claude-setup';
export const READ_ONLY_FLAG = '--read-only';

/**
 * Where the server's token comes from: the editor's secret storage (Wisply:
 * Set Token, which confirms a full-access token) or the Mac Keychain item
 * (no token of the extension's own: Cursor, a pasted entry, or VS Code with
 * none set).
 */
export type TokenSource = 'secret-storage' | 'keychain';

export interface Launch {
  /** The editor's own executable (process.execPath). */
  readonly execPath: string;
  /** Absolute path of server/wisply-mcp.mjs. */
  readonly serverPath: string;
  readonly port: number;
  readonly allowClaudeSetup: boolean;
}

/** null removes the variable from what the server inherits (VS Code's McpStdioServerDefinition.env). */
export type ServerEnv = Record<string, string | null>;

export interface ServerLaunch {
  readonly command: string;
  readonly args: string[];
  readonly env: ServerEnv;
}

/**
 * Variables of the extension host the connector must not inherit. The
 * setup_claude opt-in is the --allow-claude-setup flag (the user setting),
 * the token comes only from SecretStorage or the Keychain, and nothing loads
 * code into the server's Node.
 */
export const REMOVED_ENV = Object.freeze({
  WISPLY_MCP_TOKEN: null,
  WISPLY_MCP_ALLOW_CLAUDE_SETUP: null,
  WISPLY_MCP_DEBUG: null,
  NODE_OPTIONS: null,
} as const satisfies ServerEnv);

/**
 * How to start the bundled connector. No token: callers that may add one do
 * so themselves. With the Keychain as the token source the connector offers
 * only the read-only memo tools, so --allow-claude-setup would do nothing and
 * is left out.
 */
export function serverLaunch({ execPath, serverPath, port, allowClaudeSetup }: Launch, source: TokenSource): ServerLaunch {
  const flags = source === 'keychain' ? [READ_ONLY_FLAG] : allowClaudeSetup ? [ALLOW_CLAUDE_SETUP_FLAG] : [];
  return {
    command: execPath,
    args: [serverPath, ...flags],
    env: { ELECTRON_RUN_AS_NODE: '1', WISPLY_MCP_PORT: String(port), ...REMOVED_ENV },
  };
}

/**
 * The same environment for an API or a config file that takes strings only
 * (Cursor's registerServer, a pasted entry): a removed variable becomes an
 * empty value, which the connector treats as unset and Node ignores.
 */
export function stringEnv(env: ServerEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value ?? '']));
}

/**
 * The definition's version. It changes with the token's scope, the
 * setup_claude opt-in and every token change (tokenChanges, counted by the
 * provider), so the editor restarts a running server, or offers to: that
 * server still holds the old token in its environment. The one change not
 * counted is the token resolve stores for the server it is starting. A
 * count, never anything derived from the token.
 */
export function definitionVersion(extVersion: string, scope: UsableScope | null, allowClaudeSetup: boolean,
  tokenChanges = 0): string {
  return `${extVersion}+${scope ?? 'none'}${allowClaudeSetup ? '.claude-setup' : ''}` +
    `${tokenChanges > 0 ? `.token${tokenChanges}` : ''}`;
}

export interface DefinitionOptions extends Launch {
  readonly extVersion: string;
  readonly scope: UsableScope | null;
  readonly tokenChanges?: number;
}

/** The token-free definition. With no token stored, the server will use the Keychain item: read-only. */
export function buildDefinition(api: Pick<McpApi, 'McpStdioServerDefinition'>, options: DefinitionOptions): McpStdioServerDefinition {
  const launch = serverLaunch(options, options.scope ? 'secret-storage' : 'keychain');
  return new api.McpStdioServerDefinition(SERVER_LABEL, launch.command, launch.args, { ...launch.env },
    definitionVersion(options.extVersion, options.scope, options.allowClaudeSetup, options.tokenChanges));
}

export interface ProviderDeps {
  /** process.platform: the Set Token prompt appears only on macOS. */
  readonly platform: string;
  /** The launch options as of now (settings are re-read on change). */
  getLaunch(): Launch & { readonly extVersion: string };
  getToken(): Promise<StoredToken | null>;
  /** The Set Token prompt; undefined when the user cancels. */
  promptForToken(): Promise<StoredToken | undefined>;
  storeToken(token: StoredToken): Promise<void>;
  /** Builds the change event (vscode.EventEmitter, injected for tests). */
  createEmitter(): { readonly event: vscode.Event<void>; fire(): void; dispose(): void };
}

export interface WisplyProvider {
  readonly provider: McpServerDefinitionProvider;
  /** Tells the editor the definition changed (settings). */
  refresh(): void;
  /**
   * The stored token changed (set, replaced or forgotten): a new version, then
   * refresh(). Not for the token resolveMcpServerDefinition itself just
   * stored: the server it was starting already has that one. Settles when
   * the event has been handled (for tests).
   */
  tokenChanged(): Promise<void>;
  dispose(): void;
}

/**
 * The definition the server starts with: what the provider would list now
 * for this token source, with the token (if any) in its env. The editor's
 * copy is never changed; its label, version and working directory are kept.
 */
function startDefinition(api: Pick<McpApi, 'McpStdioServerDefinition'>, definition: McpStdioServerDefinition,
  launchOptions: Launch, stored: StoredToken | null): McpStdioServerDefinition {
  const launch = serverLaunch(launchOptions, stored ? 'secret-storage' : 'keychain');
  const copy = new api.McpStdioServerDefinition(definition.label, launch.command, launch.args,
    { ...launch.env, ...(stored ? { WISPLY_MCP_TOKEN: stored.token } : {}) }, definition.version);
  if (definition.cwd !== undefined) copy.cwd = definition.cwd;
  return copy;
}

export function createProvider(api: Pick<McpApi, 'McpStdioServerDefinition'>, deps: ProviderDeps): WisplyProvider {
  const emitter = deps.createEmitter();
  let askedThisSession = false;
  let tokenChanges = 0;
  /**
   * The token resolve stored after asking for it, until its change event
   * arrives. The server being started gets that token at once, so the event
   * must not give the definition a new version: VS Code stops a running
   * server whose definition changed, which would cut off the very tool call
   * that started it.
   */
  let storedByResolve: string | null = null;

  const bump = () => {
    tokenChanges += 1;
    emitter.fire();
  };

  const provider: McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: emitter.event,

    async provideMcpServerDefinitions() {
      const stored = await deps.getToken();
      return [buildDefinition(api, { ...deps.getLaunch(), scope: stored?.scope ?? null, tokenChanges })];
    },

    async resolveMcpServerDefinition(definition, cancellation) {
      if (definition.label !== SERVER_LABEL) return definition;
      let stored = await deps.getToken();
      if (!stored && !askedThisSession && deps.platform === 'darwin') {
        // Asked once per session: someone who relies on the Keychain item
        // and cancels isn't asked again at every start.
        askedThisSession = true;
        const entered = await deps.promptForToken();
        if (entered) {
          storedByResolve = entered.token;
          try {
            await deps.storeToken(entered);
          } catch {
            // Not saved (so no change event follows): this start still uses it.
            storedByResolve = null;
          }
          stored = entered;
        }
      }
      if (cancellation?.isCancellationRequested) return undefined;
      // Rebuilt for the token source: the removed variables again (in case
      // the editor handed back a copy without them), --read-only when the
      // server will use the Keychain item, and the stored token on top.
      return startDefinition(api, definition, deps.getLaunch(), stored);
    },
  };

  return {
    provider,
    refresh: () => emitter.fire(),
    tokenChanged: () => {
      if (storedByResolve === null) {
        bump();
        return Promise.resolve();
      }
      const expected = storedByResolve;
      storedByResolve = null;
      return deps.getToken().then(
        (now) => { if (now?.token !== expected) bump(); },
        () => bump(),
      );
    },
    dispose: () => emitter.dispose(),
  };
}
