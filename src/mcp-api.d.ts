// The editor's MCP server API, declared locally.
//
// The extension's engine floor is ^1.93.0 (so it installs in VS Code forks on
// an older base), and the @types/vscode 1.93.0 typings don't have this API:
// it is stable since VS Code 1.101. These declarations are copied from
// @types/vscode 1.101.0 index.d.ts (McpStdioServerDefinition,
// McpHttpServerDefinition, McpServerDefinitionProvider and
// lm.registerMcpServerDefinitionProvider; unchanged in 1.140.0), with the
// classes split into an instance interface and a constructor interface, under
// a namespace of our own so they can't be mistaken for the 1.93 typings.
// src/mcp-api.ts checks at runtime that the editor really has them.
//
// @types/vscode is MIT licensed:
//   Copyright (c) Microsoft Corporation. All rights reserved.
//   Licensed under the MIT License.
//
// This file is a global declaration script (no imports or exports), loaded by
// the triple-slash reference in src/mcp-api.ts.

declare namespace WisplyVscodeMcp {
  /**
   * McpStdioServerDefinition represents an MCP server available by running
   * a local process and operating on its stdin and stdout streams. The process
   * will be spawned as a child process of the extension host and by default
   * will not run in a shell environment.
   */
  interface McpStdioServerDefinition {
    /** The human-readable name of the server. */
    readonly label: string;
    /** The working directory used to start the server. */
    cwd?: import('vscode').Uri;
    /**
     * The command used to start the server. Node.js-based servers may use
     * `process.execPath` to use the editor's version of Node.js to run the script.
     */
    command: string;
    /** Additional command-line arguments passed to the server. */
    args: string[];
    /**
     * Optional additional environment information for the server. Variables
     * in this environment will overwrite or remove (if null) the default
     * environment variables of the editor's extension host.
     */
    env: Record<string, string | number | null>;
    /**
     * Optional version identification for the server. If this changes, the
     * editor will indicate that tools have changed and prompt to refresh them.
     */
    version?: string;
  }

  interface McpStdioServerDefinitionConstructor {
    /**
     * @param label The human-readable name of the server.
     * @param command The command used to start the server.
     * @param args Additional command-line arguments passed to the server.
     * @param env Optional additional environment information for the server.
     * @param version Optional version identification for the server.
     */
    new (label: string, command: string, args?: string[], env?: Record<string, string | number | null>,
      version?: string): McpStdioServerDefinition;
  }

  /**
   * McpHttpServerDefinition represents an MCP server available using the
   * Streamable HTTP transport. (Declared for completeness; Wisply never
   * provides one: the editor would send the token to the port itself.)
   */
  interface McpHttpServerDefinition {
    readonly label: string;
    uri: import('vscode').Uri;
    headers: Record<string, string>;
    version?: string;
  }

  /**
   * Definitions that describe different types of Model Context Protocol servers,
   * which can be returned from the {@link McpServerDefinitionProvider}.
   */
  type McpServerDefinition = McpStdioServerDefinition | McpHttpServerDefinition;

  /**
   * A type that can provide Model Context Protocol server definitions. This
   * should be registered using lm.registerMcpServerDefinitionProvider
   * during extension activation.
   */
  interface McpServerDefinitionProvider<T extends McpServerDefinition = McpServerDefinition> {
    /** Optional event fired to signal that the set of available servers has changed. */
    readonly onDidChangeMcpServerDefinitions?: import('vscode').Event<void>;

    /**
     * Provides available MCP servers. The editor will call this method eagerly
     * to ensure the availability of servers for the language model, and so
     * extensions should not take actions which would require user
     * interaction, such as authentication.
     */
    provideMcpServerDefinitions(token: import('vscode').CancellationToken): import('vscode').ProviderResult<T[]>;

    /**
     * This function will be called when the editor needs to start a MCP server.
     * At this point, the extension may take any actions which may require user
     * interaction, such as authentication. Any non-`readonly` property of the
     * server may be modified, and the extension should return the resolved server.
     *
     * The extension may return undefined to indicate that the server
     * should not be started, or throw an error.
     */
    resolveMcpServerDefinition?(server: T, token: import('vscode').CancellationToken): import('vscode').ProviderResult<T>;
  }

  /** The two pieces of the API the extension uses, as src/mcp-api.ts returns them. */
  interface Api {
    readonly McpStdioServerDefinition: McpStdioServerDefinitionConstructor;
    /** `vscode.lm.registerMcpServerDefinitionProvider(id, provider)`. */
    registerMcpServerDefinitionProvider(id: string, provider: McpServerDefinitionProvider): import('vscode').Disposable;
  }
}
