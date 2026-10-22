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

/** How to start the bundled connector. No token: callers that may add one do so themselves. */
export function serverLaunch({ execPath, serverPath, port, allowClaudeSetup }: Launch): ServerLaunch {
  return {
    command: execPath,
    args: [serverPath, ...(allowClaudeSetup ? [ALLOW_CLAUDE_SETUP_FLAG] : [])],
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
 * setup_claude opt-in and every token change in this window (tokenChanges,
 * counted by the provider), so the editor tells the user the tools changed
 * and offers to restart a running server, which still holds the old token in
 * its environment. A count, never anything derived from the token.
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

/** The token-free definition. */
export function buildDefinition(api: Pick<McpApi, 'McpStdioServerDefinition'>, options: DefinitionOptions): McpStdioServerDefinition {
  const launch = serverLaunch(options);
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
  /** The stored token changed (set, replaced or forgotten): a new version, then refresh(). */
  tokenChanged(): void;
  dispose(): void;
}

/** A copy of `definition` with `extraEnv` added; the original is never changed. */
function withEnv(api: Pick<McpApi, 'McpStdioServerDefinition'>, definition: McpStdioServerDefinition,
  extraEnv: ServerEnv): McpStdioServerDefinition {
  const copy = new api.McpStdioServerDefinition(definition.label, definition.command, [...definition.args],
    { ...definition.env, ...extraEnv }, definition.version);
  if (definition.cwd !== undefined) copy.cwd = definition.cwd;
  return copy;
}

export function createProvider(api: Pick<McpApi, 'McpStdioServerDefinition'>, deps: ProviderDeps): WisplyProvider {
  const emitter = deps.createEmitter();
  let askedThisSession = false;
  let tokenChanges = 0;

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
          await deps.storeToken(entered);
          stored = entered;
        }
      }
      if (cancellation?.isCancellationRequested) return undefined;
      // The removed variables again, in case the editor handed back a copy
      // without them, then the stored token (if any) on top.
      return withEnv(api, definition, { ...REMOVED_ENV, ...(stored ? { WISPLY_MCP_TOKEN: stored.token } : {}) });
    },
  };

  return {
    provider,
    refresh: () => emitter.fire(),
    tokenChanged: () => {
      tokenChanges += 1;
      emitter.fire();
    },
    dispose: () => emitter.dispose(),
  };
}
