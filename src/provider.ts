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
// asks once per window session; if the user cancels, the server starts
// anyway and uses the token saved in the Mac Keychain, if there is one.
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

export interface ServerLaunch {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

/** How to start the bundled connector. No token: callers that may add one do so themselves. */
export function serverLaunch({ execPath, serverPath, port, allowClaudeSetup }: Launch): ServerLaunch {
  return {
    command: execPath,
    args: [serverPath, ...(allowClaudeSetup ? [ALLOW_CLAUDE_SETUP_FLAG] : [])],
    env: { ELECTRON_RUN_AS_NODE: '1', WISPLY_MCP_PORT: String(port) },
  };
}

/**
 * The definition's version. It changes with the token's scope and the
 * setup_claude opt-in, so the editor refreshes the tool list when either
 * changes.
 */
export function definitionVersion(extVersion: string, scope: UsableScope | null, allowClaudeSetup: boolean): string {
  return `${extVersion}+${scope ?? 'none'}${allowClaudeSetup ? '.claude-setup' : ''}`;
}

export interface DefinitionOptions extends Launch {
  readonly extVersion: string;
  readonly scope: UsableScope | null;
}

/** The token-free definition. */
export function buildDefinition(api: Pick<McpApi, 'McpStdioServerDefinition'>, options: DefinitionOptions): McpStdioServerDefinition {
  const launch = serverLaunch(options);
  return new api.McpStdioServerDefinition(SERVER_LABEL, launch.command, launch.args, launch.env,
    definitionVersion(options.extVersion, options.scope, options.allowClaudeSetup));
}

export interface ProviderDeps {
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
  /** Tells the editor the definition changed (token or settings). */
  refresh(): void;
  dispose(): void;
}

/** A copy of `definition` with `extraEnv` added; the original is never changed. */
function withEnv(api: Pick<McpApi, 'McpStdioServerDefinition'>, definition: McpStdioServerDefinition,
  extraEnv: Record<string, string>): McpStdioServerDefinition {
  const copy = new api.McpStdioServerDefinition(definition.label, definition.command, [...definition.args],
    { ...definition.env, ...extraEnv }, definition.version);
  if (definition.cwd !== undefined) copy.cwd = definition.cwd;
  return copy;
}

export function createProvider(api: Pick<McpApi, 'McpStdioServerDefinition'>, deps: ProviderDeps): WisplyProvider {
  const emitter = deps.createEmitter();
  let askedThisSession = false;

  const provider: McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: emitter.event,

    async provideMcpServerDefinitions() {
      const stored = await deps.getToken();
      return [buildDefinition(api, { ...deps.getLaunch(), scope: stored?.scope ?? null })];
    },

    async resolveMcpServerDefinition(definition, cancellation) {
      if (definition.label !== SERVER_LABEL) return definition;
      let stored = await deps.getToken();
      if (!stored && !askedThisSession) {
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
      return withEnv(api, definition, stored ? { WISPLY_MCP_TOKEN: stored.token } : {});
    },
  };

  return {
    provider,
    refresh: () => emitter.fire(),
    dispose: () => emitter.dispose(),
  };
}
